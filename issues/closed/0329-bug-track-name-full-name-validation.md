# Track Name / Full Track Name の最大長検証がデコード・送信パスで呼ばれていない

- Priority: Medium
- Created: 2026-06-30
- Completed: 2026-07-23
- Model: Kimi Code CLI
- Branch: feature/fix-track-name-full-name-validation
- Polished: 2026-07-23

## 目的

draft-18 §2.4.1 に基づき、Full Track Name（Namespace 全フィールド長 + Track Name 長の合計）の最大 4096 バイト制限を、デコードパスと送信パスで正しく検証する。

## 優先度根拠

- draft-18 §2.4.1: "The maximum total length of a Full Track Name is 4,096 bytes. The length of a Full Track Name is computed as the sum of the Track Namespace Field Length fields and the Track Name Length field. ... If an endpoint receives a Track Namespace or a Full Track Name exceeding 4,096 bytes, it MUST close the session with a PROTOCOL_VIOLATION." — 受信側に対する MUST 要件。
- `validateFullTrackName()` は定義されているが、実際のメッセージ処理パスから呼ばれていない。
- 送信パスでは `createTrackNamespace()` と `encodeTrackName()` が個別の上限（各 4096 バイト）を検証しているが、合計長の検証（`validateFullTrackName()`）が欠けている。

## 現状

### 仕様上の制約

§2.4.1 が定義する制限は 2 つ:

- Track Namespace（フィールド長の合計）≤ 4,096 バイト
- Full Track Name（Namespace フィールド長 + Track Name 長の合計）≤ 4,096 バイト

Track Name 単体の最大長制限は仕様に存在しない。コード上の `MAX_TRACK_NAME_SIZE = 4096` と `validateTrackNameSize()` は実装側の防御的制約であり、仕様の要件ではない。

### 検証関数の呼び出し状況

`src/message/parameter.ts` に以下が定義されている:

- `MAX_TRACK_NAME_SIZE = 4096`（実装側の防御的制約）
- `MAX_FULL_TRACK_NAME_SIZE = 4096`（仕様の要件）
- `validateFullTrackName(namespace, trackName)` — 合計長を検証
- `validateTrackNameSize(trackNameBytes)` — Track Name 単体の長さを検証（実装側の防御的制約）

`validateFullTrackName()` はテストからしか呼ばれておらず、本番のメッセージ処理パスから呼ばれていない。`validateTrackNameSize()` は `message/index.ts` からエクスポートされているが、こちらも本番コードからは呼ばれていない。

### デコード関数のランタイム使用状況

- `decodePublishPayload()`（`src/message/publish.ts`）: **ランタイムに使用**（`session.ts` 約 4020 行目で PUBLISH 受信時に呼び出し）
- `decodeSubscribePayload()`（`src/message/subscribe.ts`）: PBT テストでのみ使用（コードコメントに「リレーサーバー実装用。ランタイムでは使用しない」と明記）
- `decodeFetchPayload()`（`src/message/fetch.ts`）: PBT テストでのみ使用
- `decodeTrackStatusPayload()`（`src/message/trackstatus.ts`）: PBT テストでのみ使用

ランタイムに影響するデコードパスは `decodePublishPayload()` のみ。

### 送信パスの既存検証

`session.ts` の `publish()` / `subscribe()` / `fetch()` / `trackStatus()` は既に:

- `createTrackNamespace(namespace)` で Track Namespace ≤ 4096 を検証済み
- `encodeTrackName(trackName)` で Track Name ≤ 4096 を検証済み

欠けているのは `validateFullTrackName()`（合計 ≤ 4096）のみ。

### 過去 issue #0323 との関係

`validateFullTrackName` は 2026-06-03 の "draft-18 仕様対応 (#47)" コミット（7fd7555）で追加されている。issue #0323（2026-06-17 作成、2026-06-20 Completed）は「validateFullTrackName を parameter.ts に新設」と主張するが、この関数は #0323 作成の 2 週間前に既に存在していた。#0323 は関数の定義のみで呼び出し統合を行わずに close された可能性がある。

## 設計方針

- **受信側（デコードパス）**: `decodePublishPayload()` 内で Track Namespace と Track Name のデコード後に `validateFullTrackName()` を呼ぶ。エラーは `ProtocolViolationError` とし、上位ループで PROTOCOL_VIOLATION セッション終了となるようにする。
- **送信側**: `session.ts` の `subscribe()` / `publish()` / `fetch()` / `trackStatus()` で、Track Namespace と Track Name の両方が確定した時点で `validateFullTrackName()` を呼ぶ。
- `validateFullTrackName()` を `src/message/index.ts` からエクスポートする（現在は未エクスポート）。
- `validateTrackNameSize()` は仕様の要件ではないため、デコードパスへの追加は不要。既存の `encodeTrackName()` 内の検証で十分。
- `decodeSubscribePayload` / `decodeFetchPayload` / `decodeTrackStatusPayload` への検証追加はランタイム動作を変えないが、リレー実装時の防御として追加してもよい（任意）。

## 完了条件

- Full Track Name（Namespace 全フィールド長 + Track Name 長の合計）が 4096 バイトを超える PUBLISH を受信した場合、`PROTOCOL_VIOLATION` でセッションを閉じる。
- Full Track Name が 4096 バイトを超える送信を防止する。
- Track Namespace 単体が 4096 バイトを超える受信は既存の検証で PROTOCOL_VIOLATION となる（変更なし）。
- 既存の全テストが PASS する。

## 解決方法

1. `src/message/index.ts` に `validateFullTrackName` のエクスポートを追加する。
2. `src/message/publish.ts` の `decodePublishPayload()` に `validateFullTrackName()` を追加する（Track Namespace と Track Name のデコード後）。
3. `src/session.ts` の `subscribe()` / `publish()` / `fetch()` / `trackStatus()` に `validateFullTrackName()` を追加する（Track Namespace と Track Name の確定後）。
4. テストを追加する（Full Track Name 合計長超過の受信・送信）。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
