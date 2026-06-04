# namespace ループの GOAWAY ハンドリング重複を解消する

- Priority: Low
- Created: 2026-06-03
- Completed: 2026-06-05
- Model: deepseek-v4 Pro
- Branch: feature/refactor-deduplicate-namespace-goaway
- Polished: 2026-06-05

## 目的

`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` の 3 つの namespace 系ループに GOAWAY ハンドリングが約 38 行ずつほぼ同一のコードで重複している。これを共通メソッドに抽出する。重複検出ロジックは #0289 が pure function `validateNoDuplicateGoawayOnRequestStream` として抽出するため、本 issue はそれを再利用する（GOAWAY 群 #0289 / #0291 / #0298 一括見直しの一部）。

## 優先度根拠

- 3 箇所に同一パターンが重複しており、1 箇所を修正した場合に他の 2 箇所の同期漏れリスクがある
- 優先度は Low（直近のバグ修正や機能追加が先）

## 依存

- **#0289 完了後に着手する**。本 issue は #0289 が `src/session/bidi.ts` に抽出・export する `validateNoDuplicateGoawayOnRequestStream`（重複 GOAWAY 検出）を再利用するため。重複検出ロジックを二重実装しないこと

## 現状

### 重複コード（3 箇所とも同一パターン）

`src/session.ts` の以下 3 つのメソッド内の `case MessageType.GOAWAY:` ブロック:

- `startNamespaceStreamLoop`（GOAWAY ケースは line 1911-1949 付近）
- `startTracksStreamLoop`（GOAWAY ケースは line 2123-2157 付近）
- `startNamespacePublicationStreamLoop`（GOAWAY ケースは line 2396-2433 付近）

各ブロックの共通処理:

```typescript
case MessageType.GOAWAY: {
  // 1. 重複 GOAWAY チェック
  if (this.goawayReceivedOnRequestStreams.has(requestId)) {
    this.closeWithError(new SessionError(...));
    return;
  }
  this.goawayReceivedOnRequestStreams.add(requestId);
  // 2. Request ID 存在チェック（インラインで実装されている）
  const decodedMsg = decodeGoawayPayload(messagePayload);
  if (decodedMsg.requestId !== null) {
    this.closeWithError(new SessionError(...));
    return;
  }
  // 3. コールバック呼び出し + 状態変更 + リソース解放
  callbacks.goaway?.(decodedMsg.newSessionUri);
  subscription.state = "closed";
  callbacks.error?.(new Error(`request stream goaway: ...`));
  reject(new Error(`request stream goaway: ...`));
  void streamReader.cancel();
  return;
}
```

### 微差

| 箇所                                | 差異                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| startNamespaceStreamLoop            | コメントあり、`callbacks.goaway?.()` / `callbacks.error?.()`（callbacks 非 optional）                                                |
| startTracksStreamLoop               | コメントなし、`callbacks.goaway?.()` / `callbacks.error?.()`（callbacks 非 optional）                                                |
| startNamespacePublicationStreamLoop | `callbacks?.goaway?.()` / `callbacks?.error?.()`（callbacks 自体が optional）、`publication.state`、`if (!resolved) { reject(...) }` |

### 関連: 重複検出と Request ID チェックの pure function 化

bidi.ts の GOAWAY ハンドラは Request ID null チェックに `validateGoawayOnRequestStream`（#0282 で導入、bidi.ts の 5 箇所で使用）を使用しているが、session.ts の 3 つの namespace ループはインラインで行っている。さらに重複検出も session.ts ではインライン。#0289 が重複検出を `validateNoDuplicateGoawayOnRequestStream` に pure function 化するため、本 issue はその関数と `validateGoawayOnRequestStream` の両方を namespace ループでも使う。

## 解決済みの項目（本 issue から除外）

- **GOAWAY Request ID null チェックの重複**: #0282 で `validateGoawayOnRequestStream` に統一済み（bidi.ts の 5 箇所）。本 issue はこれを namespace ループ 3 箇所にも適用する
- **Pending 型の二重定義**: 既に解消済み。`PendingPublish`/`PendingSubscribe`/`PendingFetch` は `bidi.ts` のみに定義されている

## 設計方針

### 共通メソッドの抽出

GOAWAY ハンドリングの共通部分を抽出したメソッドを `src/session.ts` 内のプライベートメソッドとして作成する。重複検出は #0289 の `validateNoDuplicateGoawayOnRequestStream`、Request ID null チェックは `validateGoawayOnRequestStream`（いずれも `src/session/bidi.ts` から export）を使う。

`src/session.ts` は `import * as bidi from "./session/bidi"` の名前空間 import を使っているため、これらの関数は `bidi.validateNoDuplicateGoawayOnRequestStream(...)` / `bidi.validateGoawayOnRequestStream(...)` のように `bidi.` 接頭辞で呼ぶ（既存の `bidi.validateRequestOkNoTrackProperties(...)` 等と同じ呼び出し様式）。

```typescript
/**
 * namespace 系ループ共通: リクエストストリーム上の GOAWAY を処理する
 */
private handleGoawayOnNamespaceStream(
  requestId: bigint,
  messagePayload: Uint8Array,
  callbacks: { goaway?: (uri: string) => void; error?: (err: Error) => void },
  streamReader: ReadableStreamDefaultReader<Uint8Array>,
): boolean {
  // 重複 GOAWAY チェック（#0289 が抽出した pure function を再利用）
  if (
    !bidi.validateNoDuplicateGoawayOnRequestStream(
      requestId,
      this.goawayReceivedOnRequestStreams,
      (e) => this.closeWithError(e),
    )
  ) {
    return false;
  }
  // Request ID null チェック
  const decodedMsg = decodeGoawayPayload(messagePayload);
  if (!bidi.validateGoawayOnRequestStream(decodedMsg.requestId, (e) => this.closeWithError(e))) {
    return false;
  }
  // コールバック呼び出し + リソース解放
  callbacks.goaway?.(decodedMsg.newSessionUri);
  callbacks.error?.(new Error(`request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`));
  void streamReader.cancel();
  return true; // 呼び出し元で state 変更と reject を行う
}
```

### 呼び出し元（例: startNamespaceStreamLoop）

```typescript
case MessageType.GOAWAY: {
  if (this.handleGoawayOnNamespaceStream(requestId, messagePayload, callbacks, streamReader)) {
    subscription.state = "closed";
    reject(new Error(`request stream goaway`));
  }
  return;
}
```

### 呼び出し元の差異吸収

3 ループの差異は「`handleGoawayOnNamespaceStream` が true を返した後に何をするか」に集約され、共通メソッドのシグネチャ（`requestId`, `messagePayload`, `callbacks`, `streamReader`）で吸収できる。

- `startNamespaceStreamLoop` / `startTracksStreamLoop`: `subscription.state = "closed"` と `reject(...)` を呼ぶ
- `startNamespacePublicationStreamLoop`: `publication.state = "closed"` と `if (!resolved) { reject(...) }` を呼ぶ。また、このループは `callbacks` 自体が optional（`callbacks?.goaway?.()`）であるため、`handleGoawayOnNamespaceStream` 呼び出し前に `callbacks ?? {}` で正規化するか、共通メソッドの引数を optional にして渡す

## 変更対象ファイル

- `src/session.ts`: 共通メソッド `handleGoawayOnNamespaceStream` を追加、3 箇所の GOAWAY case を書き換え。`validateNoDuplicateGoawayOnRequestStream` / `validateGoawayOnRequestStream` は既存の `import * as bidi from "./session/bidi"` 経由で `bidi.` 接頭辞で呼ぶ（新規 import 文は不要）
- `CHANGES.md`: `### misc` に `[UPDATE]` エントリを追記

## テスト方針

- 挙動が変わらないリファクタリングのため、新規テスト追加は不要
- 重複検出（`validateNoDuplicateGoawayOnRequestStream`）と null チェック（`validateGoawayOnRequestStream`）の pure function テストは #0289 / #0282 で追加済みのため、本 issue では追加しない
- 既存の全テストが PASS することを確認する

## 完了条件

- 3 箇所の namespace ループ GOAWAY ハンドリングが共通メソッド `handleGoawayOnNamespaceStream` 呼び出しに置き換えられている
- 重複検出に #0289 の `bidi.validateNoDuplicateGoawayOnRequestStream`、Request ID null チェックに `bidi.validateGoawayOnRequestStream` を使用している（インライン実装を廃止）
- 抽出前後で 3 ループの GOAWAY ハンドリング挙動が変わらない（特に publication ループの `publication.state` / `if (!resolved)` / callbacks optional の差異が保たれる）
- 全テストが PASS する
- `CHANGES.md` の `### misc` に `[UPDATE]` エントリ（次行に担当者 `- @<ユーザー名>`）を追記する

## 解決方法

3 つの namespace ループ（`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`）の GOAWAY ハンドリング重複を、共通 private メソッド `handleGoawayOnNamespaceStream` に抽出した。

- 重複検出は #0289 の `bidi.validateNoDuplicateGoawayOnRequestStream`、Request ID null チェックは `bidi.validateGoawayOnRequestStream` を再利用した（`import * as bidi` 経由で `bidi.` 接頭辞で呼ぶ）。3 ループのインライン実装を廃止した
- 共通メソッドは boolean ではなく newSessionUri（`string | null`）を返す。reject / error メッセージに newSessionUri を使うため、boolean だと呼び出し元で newSessionUri が失われ reject メッセージが変わる。`string | null` を返すことで挙動不変を保つ（`decodeGoawayPayload` の newSessionUri は常に string のため null と衝突しない）
- state 変更（`subscription.state` / `publication.state`）は `closeState` コールバックで共通メソッドに渡す。元の inline 実装と同じく `goaway` → `state="closed"` → `error` の順序を保ち、error コールバックから見える state を変えないため
- reject は呼び出し元で行う（startNamespace / Tracks は無条件、startNamespacePublicationStreamLoop は `if (!resolved)`）

挙動不変を `/review-diff-code` で確認した。error コールバックから観測される state の順序差を `closeState` で解消し、テスト 628 件が PASS することを確認した。

### 触ったファイル

- `src/session.ts`（`handleGoawayOnNamespaceStream` 追加、3 ループの GOAWAY ケース置換）
- `CHANGES.md`（`### misc` に `[UPDATE]`）
