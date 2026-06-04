# namespace ループの GOAWAY ハンドリング重複を解消する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4 Pro
- Branch: feature/refactor-deduplicate-namespace-goaway
- Polished: 2026-06-04

## 目的

`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` の 3 つの namespace 系ループに GOAWAY ハンドリングが約 38 行ずつほぼ同一のコードで重複している。これを共通関数に抽出する。

## 優先度根拠

- 3 箇所に同一パターンが重複しており、1 箇所を修正した場合に他の 2 箇所の同期漏れリスクがある
- 優先度は Low（直近のバグ修正や機能追加が先）

## 現状

### 重複コード（3 箇所とも同一パターン）

`src/session.ts` の以下 3 箇所:

- **line 1908-1946**: `startNamespaceStreamLoop`
- **line 2120-2155**: `startTracksStreamLoop`
- **line 2393-2430**: `startNamespacePublicationStreamLoop`

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

| 箇所                                | 差異                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| startNamespaceStreamLoop            | コメントあり、`callbacks.error?.()`                                                                             |
| startTracksStreamLoop               | コメントなし、`callbacks.error?.()`                                                                             |
| startNamespacePublicationStreamLoop | `callbacks?.goaway?.()` (optional chaining 深さが異なる)、`publication.state`、`if (!resolved) { reject(...) }` |

### 関連: validateGoawayOnRequestStream の未使用

bidi.ts の GOAWAY ハンドラは `validateGoawayOnRequestStream` を使用しているが、session.ts の 3 つの namespace ループは Request ID チェックをインラインで行っている。#0282 の「全 5 箇所」は bidi.ts のみを対象としていたため、session.ts の 3 箇所は未対応。

## 解決済みの項目（本 issue から除外）

- **GOAWAY Request ID チェックの重複**: #0282 で `validateGoawayOnRequestStream` に統一済み（bidi.ts の 5 箇所）
- **Pending 型の二重定義**: 既に解消済み。`PendingPublish`/`PendingSubscribe`/`PendingFetch` は `bidi.ts` のみに定義されている

## 設計方針

### 共通関数の抽出

GOAWAY ハンドリングの共通部分を抽出した関数を `src/session.ts` 内のプライベートメソッドとして作成する。

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
  // 重複 GOAWAY チェック
  if (this.goawayReceivedOnRequestStreams.has(requestId)) {
    this.closeWithError(...);
    return false;
  }
  this.goawayReceivedOnRequestStreams.add(requestId);
  // validateGoawayOnRequestStream で Request ID チェック
  const decodedMsg = decodeGoawayPayload(messagePayload);
  if (!validateGoawayOnRequestStream(decodedMsg.requestId, (e) => this.closeWithError(e))) {
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

### validateGoawayOnRequestStream の活用

session.ts の namespace ループでも `validateGoawayOnRequestStream`（bidi.ts からエクスポート済み）を使用し、Request ID チェックのインライン実装を廃止する。

## 変更対象ファイル

- `src/session.ts`: 共通メソッド `handleGoawayOnNamespaceStream` を追加、3 箇所の GOAWAY case を書き換え
- `CHANGES.md`: `### misc` に `[UPDATE]` エントリを追記

## テスト方針

- 挙動が変わらないリファクタリングのため、新規テスト追加は不要
- 既存の全テストが PASS することを確認する

## 完了条件

- 3 箇所の namespace ループ GOAWAY ハンドリングが共通メソッド呼び出しに置き換えられている
- Request ID チェックに `validateGoawayOnRequestStream` を使用している
- 全テストが PASS する
- `CHANGES.md` に `[UPDATE]` エントリを追記する
