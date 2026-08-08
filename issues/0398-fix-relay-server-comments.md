# リレーサーバー実装用コメントの不正確な記述を修正する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-relay-server-comments
- Polished: {YYYY-MM-DD}

## 目的

「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない」と記載された関数が実際にはランタイムで使用されており、不正確なコメントを実態に合わせて修正する。

## 現状

- `src/message/session.ts` の `encodeRequestOkPayload` / `encodeRequestErrorPayload` のコメントに「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない」とあるが、`encodeRequestOkPayload` は受信 PUBLISH 受理時の PUBLISH_OK 送信（`src/session.ts` の `handleIncomingBidirectionalStream` 内）で、`encodeRequestErrorPayload` は `sendRequestErrorAndCancel` から使用されており、いずれもランタイム使用中。
- 同種の誤記が他のファイルにも存在する（`src/message/fetch.ts` / `src/message/subscribe.ts` / `src/dataStream.ts` 等）。

## 設計方針

- ランタイムで使用されている関数のコメントを実態に合わせて修正する。
- 対象箇所は grep で使用状況を確認したうえで一括修正する（部分修正にしない）。

## 完了条件

- 「リレーサーバー実装用。ランタイムでは使用しない」という不正確なコメントが、実際にランタイムで使用されている関数について修正されていること。
- 修正後も `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 関連: `0371-moqt-draft-19-incoming-request-not-supported-response.md`（本 issue はそこから分離されたコメント修正）

## 解決方法

未着手。
