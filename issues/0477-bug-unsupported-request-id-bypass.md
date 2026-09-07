# 未対応リクエストで Request ID 検証を素通りする

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-unsupported-request-id-check
- Polished: 2026-09-06

## 目的

draft-ietf-moq-transport-20 §10.1 は Request ID のパリティ・重複違反で `INVALID_REQUEST_ID` close を MUST とし、メッセージ種別による例外を設けていない。未対応リクエストの先頭メッセージでも検証する必要がある。

## 現状

- `src/session/incoming.ts` の `incomingHandleFirstBidiMessage` は `unsupported-request` 分類でペイロードをデコードせず `NOT_SUPPORTED` 応答するため、§10.1 検証が適用されない (コード内で残余リスクと自認済み)。
- 未対応が絡む重複 (未対応→未対応、未対応→PUBLISH、PUBLISH→未対応) を検出できない。PUBLISH 同士の重複は検出済みである。
- 共有検証関数 `incomingValidateRequestId` はあるが、未対応経路からの配線 (`receivedRequestIds` は `SessionImpl` の private) がない。

## 設計方針

1. 分類後・`NOT_SUPPORTED` 応答前に、先頭 varint を Request ID として抽出し、PUBLISH 経路と同一の `incomingValidateRequestId` で検証する (検証→応答の順。`NOT_SUPPORTED` 応答でも ID を消費して記録する)。未対応 6 種の先頭は Request ID であり、分類 3 (Request ID を持たない型あり) より前に抽出は行わない。
2. 検証失敗は `INVALID_REQUEST_ID` で閉じる。
3. 空・切詰めで先頭 varint が取れない場合はペイロード破損として `PROTOCOL_VIOLATION` で閉じる。
4. 後続 `REQUEST_UPDATE` の扱いは本 issue の対象外とする (先頭メッセージ分類のみ)。

## 完了条件

- 未対応リクエスト (例: 先頭 varint に偶数 Request ID を持つ SUBSCRIBE) で `INVALID_REQUEST_ID` によりセッションが閉じること。
- PUBLISH で消費済みの Request ID を持つ未対応リクエストで重複検出して閉じること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- 未対応 6 種の先頭メッセージでも同一検証関数でパリティ・重複検証し、NOT_SUPPORTED 応答でも ID を消費して記録する。空・切詰めは PROTOCOL_VIOLATION で閉じる
- 検証等のテスト 7 件を追加した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-transport-20 §10.1
