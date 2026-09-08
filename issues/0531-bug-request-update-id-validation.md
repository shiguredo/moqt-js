# 受信 REQUEST_UPDATE の Request ID が無検証である

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-request-update-id-validation
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §10.1 は Request ID のパリティ・重複違反で `INVALID_REQUEST_ID` によるセッション終了を MUST とし、REQUEST_UPDATE を ID 消費対象に含める。受信 REQUEST_UPDATE でも検証する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate`（受信 PUBLISH ストリーム上の更新）と `bidiReadRequestStreamMessages` 内の `REQUEST_UPDATE` ケース（送信 PUBLISH ストリーム上のピア更新受信）はいずれもペイロードをデコードするが、デコード結果の Request ID を参照せず、ストリームに紐付く Request ID のみで処理する。パリティ検証・重複検証・両者の照合のいずれも行わない。
- 送信側は更新ごとに新規 Request ID を消費するため、受信側の無検証は仕様の MUST との乖離である。
- 未対応リクエスト 6 種の先頭メッセージと受信 PUBLISH では同一検証関数によるパリティ・重複検証が適用済みであり、REQUEST_UPDATE の 2 経路のみが残存する。

## 設計方針

1. 受信 REQUEST_UPDATE の 2 経路とも、デコード結果の Request ID に `validateIncomingRequestId` 相当のパリティ・重複検証を適用し `receivedRequestIds` に登録する。更新は新規 ID を消費するため（§10.1）、ストリーム紐付け ID との一致照合は行わない。
2. 検証失敗は `INVALID_REQUEST_ID` で閉じる。§10.9 の想定外更新の `PROTOCOL_VIOLATION` より ID 検証（§10.1 MUST）を先に行う。確立済みストリーム上の更新という文脈でも ID 検証の義務は変わらない。

## 完了条件

- 受信 REQUEST_UPDATE の 2 経路でデコード結果の Request ID のパリティ・重複検証が行われ、違反時は `INVALID_REQUEST_ID` で閉じること（偶数 ID 受信時、重複 ID 受信時の振る舞いで確認する）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.1 / §10.9
