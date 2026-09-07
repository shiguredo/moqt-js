# 受信 REQUEST_UPDATE の Request ID が無検証である

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-request-update-id-validation
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.1 は Request ID のパリティ・重複違反で `INVALID_REQUEST_ID` によるセッション終了を MUST とし、REQUEST_UPDATE を ID 消費対象に含める。受信 REQUEST_UPDATE でも検証する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` はペイロードをデコードするが、デコード結果の Request ID を参照せず、ストリームに紐付く Request ID のみで処理する。パリティ検証・重複検証・両者の照合のいずれも行わない。
- 送信側は更新ごとに新規 Request ID を消費するため、受信側の無検証は仕様の MUST との乖離である。
- 未対応リクエスト 6 種の先頭メッセージと受信 PUBLISH では同一検証関数によるパリティ・重複検証が適用済みであり、REQUEST_UPDATE のみが残存する。

## 設計方針

1. 受信 REQUEST_UPDATE のデコード結果の Request ID を検証対象に含める。パリティ・重複の扱いと、ストリーム紐付け ID との照合の要否を仕様に沿って整理する。
2. 検証失敗は `INVALID_REQUEST_ID` で閉じる方向で検討する。確立済みストリーム上の既存購読に対する更新という文脈との整合性を確認する。

## 完了条件

- 受信 REQUEST_UPDATE の Request ID が検証されること (パリティ・重複・紐付け照合の扱いが仕様に沿って定められること)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.1 / §10.9
