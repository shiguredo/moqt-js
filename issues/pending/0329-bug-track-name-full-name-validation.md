# Track Name / Full Track Name の最大長検証がデコード・送信パスで呼ばれていない

- Priority: Medium
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-track-name-full-name-validation
- Polished:

## 目的

draft-18 §2.4.1 に基づき、Track Name および Full Track Name（Namespace 全フィールド長 + Track Name 長）の最大 4096 バイト制限を、デコードパスと送信パスで正しく検証する。

## 優先度根拠

- draft-18 準拠の MUST NOT 要件。
- `validateFullTrackName()` と `validateTrackNameSize()` は定義されているが、実際のメッセージ処理パスから呼ばれていない。
- 過去 issue #0323 で対応済みとされているが、現在のコードでは関数が定義されているのみで統合されていない。

## 現状

`src/message/parameter.ts` には以下が定義されている:

- `MAX_TRACK_NAME_SIZE = 4096`
- `MAX_FULL_TRACK_NAME_SIZE = 4096`
- `validateFullTrackName(namespace, trackName)`
- `validateTrackNameSize(trackNameBytes)`

しかし、これらはテストからしか呼ばれていない。

`src/message/subscribe.ts:decodeSubscribePayload()` / `src/message/publish.ts:decodePublishPayload()` / `src/message/fetch.ts:decodeFetchPayload()` / `src/message/trackstatus.ts:decodeTrackStatusPayload()` 等では、Track Name 長の読み取り後に `validateTrackNameSize()` が呼ばれていない。

また、`src/session.ts` の `subscribe()` / `publish()` / `fetch()` / `trackStatus()` 等でも、`validateFullTrackName()` が呼ばれていない。

## 設計方針

- デコード側: Track Name 長を読み取った直後に `validateTrackNameSize()` を呼ぶ。
- 送信側: Track Namespace と Track Name の両方が確定した時点で `validateFullTrackName()` を呼ぶ。
- エラーは `ProtocolViolationError` とし、上位ループで `PROTOCOL_VIOLATION` セッション終了となるようにする。

## 完了条件

- Track Name 長が 4096 バイトを超えるメッセージを受信した場合、`PROTOCOL_VIOLATION` でセッションを閉じる。
- Full Track Name（Namespace 全フィールド長 + Track Name 長）が 4096 バイトを超える送信を防止する。
- 既存の全テストが PASS する。

## 解決方法

1. `src/message/subscribe.ts`, `src/message/publish.ts`, `src/message/fetch.ts`, `src/message/trackstatus.ts` のデコード関数に `validateTrackNameSize()` を追加する。
2. `src/session.ts` の `subscribe()` / `publish()` / `fetch()` / `trackStatus()` に `validateFullTrackName()` を追加する。
3. テストを追加する。

## 該当箇所一覧

| ファイル | 変更内容 |
| --- | --- |
| `src/message/subscribe.ts` | Track Name デコード時の長検証追加 |
| `src/message/publish.ts` | Track Name デコード時の長検証追加 |
| `src/message/fetch.ts` | Track Name デコード時の長検証追加 |
| `src/message/trackstatus.ts` | Track Name デコード時の長検証追加 |
| `src/session.ts` | 送信時の Full Track Name 長検証追加 |
