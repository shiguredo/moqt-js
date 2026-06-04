# review-diff-code で検出された不足テストを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4 Pro
- Branch: feature/add-missing-goaway-and-error-tests
- Polished: 2026-06-05

## 目的

draft-18 移行で追加された GOAWAY バリデーションのうち、次の 2 つの判定ロジックが `handleGoaway` / `bidiReadRequestStreamMessages` 内にインラインで書かれており pure function 化されていないため、単体テストでカバーできていない。

1. 制御ストリーム上の GOAWAY Request ID パリティ判定（#0273/#0286 で修正）
2. リクエストストリーム上の重複 GOAWAY 検出（#0259 で追加）

この 2 ロジックを pure function に抽出し、抽出した関数に対する単体テストを追加する。本 issue は GOAWAY 群（#0289 / #0291 / #0298）の一括見直しで「GOAWAY 判定ロジックの pure function 化の基盤」と位置づけられ、ここで抽出する `validateNoDuplicateGoawayOnRequestStream` は #0291 が namespace ループでも再利用する。

当初は 4 項目を計画していたが、事前調査の結果、残り 2 項目（decode 層の検証）は既存テストでカバー済みと判明したため対象外とした（「対象外」セクション参照）。

## 優先度根拠

- GOAWAY バリデーションはプロトコル違反検出のセキュリティ上重要なロジックだが、パリティ判定（#0273）と重複検出（#0259）に対するリグレッションテストが未実装
- decode 層（`decodeGoawayPayload` の Request ID null 判定、`decodeRequestErrorPayload` の Redirect デコード）は既存 PBT でカバー済みだが、セッション側の判定ロジックが pure function 化されておらず未テスト
- 本 issue が抽出する重複検出関数は #0291（namespace ループ共通化）の基盤となるため、#0291 より先に処理する

## 設計方針

- テスト可能化のため、`handleGoaway`（`src/session.ts`）と `bidiReadRequestStreamMessages`（`src/session/bidi.ts`）内にインラインで書かれた判定ロジックを pure function に抽出する。既存の `validateGoawayOnRequestStream`（`src/session/bidi.ts:142`、`(requestId, closeSession) => boolean` 形式）が同種の抽出の先例
- 抽出後も呼び出し元の挙動（`INVALID_REQUEST_ID` / `PROTOCOL_VIOLATION` でセッションを閉じる）は一切変えない
- 本 issue の主目的は欠落テストの追加であり、pure function 抽出はそのための手段である。よってブランチ prefix は `feature/add-` を維持する（リファクタ単体が目的ではない）
- テストメッセージは全て日本語
- テストは既存ファイルにならい `import { test, assert } from "vite-plus/test";` を用いる（Vitest をラップした Chai API）
- モックやスタブは利用しない。抽出した pure function を本物の値（`Set`、コールバック関数）でテストする
- 既存の `src/session/bidi.test.ts` には `as unknown as BidiSessionInternal` を使ったスタブ的パターンが存在するが、これは CLAUDE.md の「モックやスタブは絶対に利用しないこと」に反する技術的負債であり、本 issue では踏襲しない（別途是正すべき）
- `handleGoaway` / `bidiReadRequestStreamMessages` 本体は WebTransport ストリーム依存の非同期処理であり、モック禁止下では直接テストできない。抽出した pure function 単体をテストする

## テスト項目

### 1. GOAWAY Request ID パリティ判定（#0273/#0286 のリグレッション）

draft-ietf-moq-transport-18 Section 10.4 (GOAWAY) の Request ID フィールド:

> "If the parity of the Request ID does not match the receiver's parity, the endpoint MUST close the session with INVALID_REQUEST_ID."

draft-ietf-moq-transport-18 Section 10.1 (Request ID):

> "The client generates even numbered Request IDs, starting at 0, and the server generates odd numbered Request IDs, starting at 1."

moqt-js はクライアント専用のため、受信する制御ストリーム上の GOAWAY の Request ID は受信側（クライアント）のパリティ、すなわち even でなければならない。odd の場合は `INVALID_REQUEST_ID` でセッションを閉じる。

- 抽出: `src/session.ts` の `handleGoaway` 内のパリティチェック `msg.requestId % 2n !== 0n` を pure function に抽出する
  - 関数: `export function isValidGoawayRequestIdParity(requestId: bigint): boolean`（even なら true、odd なら false）
  - 配置: `src/message/session.ts`（`closeSession` コールバックに依存しない純粋な判定関数とし、テスト追加先 `src/message/session.prop.ts` と同層に揃える）
  - `src/session.ts` は `decodeGoawayPayload` 等をバレル `"./message"`（`src/message/index.ts`）経由で import している。したがって `src/message/index.ts` の Session メッセージ再エクスポートブロックに `isValidGoawayRequestIdParity` を追加すること（これを忘れると `session.ts` から import できない）
  - `handleGoaway` を `if (!isValidGoawayRequestIdParity(msg.requestId)) { ... INVALID_REQUEST_ID で閉じる ... }` の形に置換し、挙動を変えない
- テスト: `src/message/session.prop.ts` に PBT を追加
  - even（`n * 2n`）→ true、odd（`n * 2n + 1n`）→ false を fast-check で検証
  - boolean を返す純粋関数のため error 検証は不要

### 2. リクエストストリーム上の重複 GOAWAY 検出（#0259 のリグレッション、#0291 の基盤）

draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):

> "The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 3.5) if it receives more than one GOAWAY on the control stream or on a single request stream."

- 抽出: `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の GOAWAY ケース内にある重複検出を pure function に抽出する
  - 対象行: `src/session/bidi.ts:670`（`if (session.goawayReceivedOnRequestStreams.has(requestId))`）から `679`（`session.goawayReceivedOnRequestStreams.add(requestId)`）まで。`680` 以降の `decodeGoawayPayload` / `validateGoawayOnRequestStream` / コールバック呼び出しはそのまま残す
  - 関数: `export function validateNoDuplicateGoawayOnRequestStream(requestId: bigint, seenSet: Set<bigint>, closeSession: (error: SessionError) => void): boolean`
    - 重複なし（`seenSet` に未登録）→ `seenSet.add(requestId)` して true を返す
    - 重複あり → `closeSession` を `PROTOCOL_VIOLATION` の `SessionError`（メッセージ `"received duplicate goaway on request stream"`）で呼び false を返す
  - `validateGoawayOnRequestStream`（`src/session/bidi.ts:142`、null チェック = #0258）と同形式。ただし両者は別ロジック（null チェック vs 重複検出）であり、混同しないこと
  - 配置: `src/session/bidi.ts`（`validateGoawayOnRequestStream` と同じバリデーション群に置き export する。#0291 が namespace ループからも再利用する）
  - 挙動不変の制約: 現行は「重複チェック → `add` → （`decodeGoawayPayload` 後に）null チェック」の順で、`add` は null チェックより前に実行される。抽出関数は重複でない場合に即座に `seenSet.add` してから true を返すことでこの順序を保つ。置換後もこの順序を変えないこと
- テスト: `src/session/bidi.test.ts` に追加
  - 本物の `Set<bigint>` と本物のコールバック関数を使う（`as unknown as BidiSessionInternal` スタブは使わない）
  - 初回 → true かつ `seenSet` に追加・`closeSession` 呼ばれない
  - 2 回目（重複）→ false かつ `closeSession` に渡る `SessionError` の `code` が `SessionErrorCode.PROTOCOL_VIOLATION`、`message` が `"received duplicate goaway on request stream"` を含むことを検証
- 関連 issue:
  - #0291（namespace ループ共通化）は本関数 `validateNoDuplicateGoawayOnRequestStream` を `handleGoawayOnNamespaceStream` 内で再利用する。重複検出ロジックを二重実装しないため、本 issue を先に処理する
  - #0298（`bidiReadRequestStreamMessages` の catch 修正）は同じ関数の末尾 catch を変更する。本項目の抽出箇所（GOAWAY ケースの 670-679）と #0298 の修正箇所（catch）は別であり競合しない。#0298 のテストも pure function 単体テスト（スタブ不使用）で揃えるため、本 issue の方針と整合する。両者をまたぐ場合は片方マージ後にリベースする

## 対象外

### decodeGoawayPayload の Request ID null 判定（当初項目 1）

`src/message/session.prop.ts` の「Goaway のエンコード・デコードがラウンドトリップする」テストが `fc.option(..., { nil: null })` で Request ID なしのケースを既に網羅しており、decode 結果の `requestId` が null になることはカバー済み。`handleGoaway` の `requestId === null` 分岐（`PROTOCOL_VIOLATION`）は WebTransport 依存で E2E の対象。

### REQUEST_ERROR with Redirect のデコード（当初項目 4）

`src/message/session.prop.ts` の「REQUEST_ERROR with Redirect のエンコード・デコードがラウンドトリップする」テストが `decodeRequestErrorPayload` の Redirect 付きデコードをカバー済み。decode 結果から `RequestError` 例外クラス（`src/error.ts`）への変換（`trackNamespace.tuple` 取り出し等）のテストは `error.test.ts` の責務であり、本 issue では扱わない（必要なら別 issue で対応）。

### closedSubgroups 再送信拒否

WebTransport 依存のフローテストでありモック禁止下で単体テスト不可。`ClosedSubgroupError` の型テストは `error.test.ts` に既存。E2E で対応する。

### publisher/subscriber closed 状態での GOAWAY コールバック

`bidiReadRequestStreamMessages` の GOAWAY ケースで state チェックなしに goawayCallback を呼ぶ是非は設計判断が必要。本 issue のスコープ外であり、別 issue 化の要否は triage で扱う（本 issue のクローズ条件には含めない）。

## 完了条件

- `isValidGoawayRequestIdParity`（`src/message/session.ts`、export）が抽出され、`src/message/index.ts` で再エクスポートされ、`handleGoaway` がそれを使い、`src/message/session.prop.ts` に PBT が追加されている
- `validateNoDuplicateGoawayOnRequestStream`（`src/session/bidi.ts`、export）が抽出され、`bidiReadRequestStreamMessages` がそれを使い、`src/session/bidi.test.ts` にテストが追加されている
- 抽出前後で `handleGoaway` / `bidiReadRequestStreamMessages` の挙動が変わらない（`add` のタイミングを含む）
- 全テストが PASS する
- pure function 抽出（テスト可能化のためのリファクタ、外部挙動は不変）を伴うため、`CHANGES.md` の `### misc` に `[UPDATE]` エントリ（次行に担当者 `- @<ユーザー名>`）を追記する
