# 未対応リクエストで Request ID 検証を素通りする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-unsupported-request-id-check
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.1 は Request ID のパリティ・重複違反で `INVALID_REQUEST_ID` close を MUST とし、分類の例外を設けていない。未対応リクエスト経路でも検証する必要がある。

## 現状

- `src/session/incoming.ts` の `incomingHandleFirstBidiMessage` は `unsupported-request` 分類でペイロードをデコードせず `NOT_SUPPORTED` 応答するため、§10.1 検証が適用されない (コード内で残余リスクと自認済み)。
- 同一 Request ID の連打を検出できない。

## 設計方針

1. 分類前に Request ID のパリティ・重複検証を行う (受信 PUBLISH 経路と同一)。
2. 検証失敗は `INVALID_REQUEST_ID` で閉じる。

## 完了条件

- 未対応リクエストでも不正 Request ID を検出して閉じること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.1
