# リレーサーバー実装用コメントの不正確な記述を修正する

- Created: 2026-08-07
- Completed: 2026-08-28
- Branch: feature/fix-relay-server-comments
- Polished: 2026-08-20

## 目的

「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない」と記載された関数のうち、実際にランタイムで使用されているもの（`encodeRequestOkPayload` / `encodeRequestErrorPayload` / `decodeRequestUpdatePayload`）のコメントを実態に合わせて修正する。

## 現状

- `src/message/session.ts` の `encodeRequestOkPayload` / `encodeRequestErrorPayload` のコメントに「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない」とあるが、両方ともランタイム使用中:
  - `encodeRequestOkPayload`: `src/session.ts` の `handleIncomingBidirectionalStream`（受信 PUBLISH 受理時の PUBLISH_OK 送信）、`src/session/bidi.ts`（`bidiSendRequestOk` / REQUEST_UPDATE 応答）で使用
  - `encodeRequestErrorPayload`: `src/session/incoming.ts` の `incomingSendRequestErrorAndClose`、`src/session/bidi.ts`（`bidiSendRequestError` / REQUEST_UPDATE 応答）で使用
- `src/message/subscribe.ts` の `decodeRequestUpdatePayload` のコメントに「リレーサーバーおよび Publisher 実装用。moqt-js はクライアント専用のため、現在ランタイムでは使用しない」とあるが、`src/session/bidi.ts` の受信 REQUEST_UPDATE 処理で使用中。
- 一方、`src/message/fetch.ts`（`decodeFetchPayload` / `encodeFetchOkPayload`）、`src/message/subscribe.ts`（`decodeSubscribePayload` / `encodeSubscribeOkPayload`）、`src/dataStream.ts`（`encodeFetchHeader` / `encodeFetchObjectFields`）のコメントは正しい（いずれもランタイム未使用。テスト・PBT・re-export（dataStream の 2 関数はテスト・PBT のみ）で使用）。

## 設計方針

- ランタイムで使用されている関数（`encodeRequestOkPayload` / `encodeRequestErrorPayload` / `decodeRequestUpdatePayload`）のコメントを実態に合わせて修正する。
- 修正後のコメントは「リレーサーバー実装用」等の誤った前置きを外し、実際の使用箇所（受信 PUBLISH の PUBLISH_OK 送信、受信 REQUEST_UPDATE のデコード等。上記の使用箇所列挙を網羅する）を明記した内容にする。各関数の「PBT（Property-Based Testing）でのラウンドトリップテストで使用。」の行は事実であり残す。
- コメントが正しい関数（`decodeFetchPayload` / `encodeFetchOkPayload` / `decodeSubscribePayload` / `encodeSubscribeOkPayload` / `encodeFetchHeader` / `encodeFetchObjectFields`）は修正しない。

## 完了条件

- `encodeRequestOkPayload` / `encodeRequestErrorPayload`（`src/message/session.ts`）と `decodeRequestUpdatePayload`（`src/message/subscribe.ts`）のコメントが、実際にランタイムで使用されていることを反映した内容に修正されていること。
- コメントが正しい関数（`src/message/fetch.ts` / `src/message/subscribe.ts` / `src/dataStream.ts` の上記対象外関数）が誤って修正されていないこと。
- `CHANGES.md` の `## develop` に本修正の記載があること（doc コメント修正のため `### misc` サブセクションに記載する。`shiguredo-changelog` 参照）。
- 修正後も `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.5 (REQUEST_OK) / §10.6 (REQUEST_ERROR)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE)
- 関連: `issues/closed/0371-moqt-draft-19-incoming-request-not-supported-response.md`（`sendRequestErrorAndCancel` を `incomingSendRequestErrorAndClose` に移設した経緯）

## 解決方法

以下 3 関数の doc コメントを、実際にランタイムで使用されている呼び出し経路を明記した内容に修正した。

- `src/message/session.ts` の `encodeRequestOkPayload`: 受信 PUBLISH 受理時、受信 PUBLISH ストリーム上での REQUEST_UPDATE 応答 (bidiSendRequestOk 経由)、送信 PUBLISH の bidi ストリーム上での REQUEST_UPDATE 応答 (bidiReadRequestStreamMessages 内で直接エンコード) の 3 経路を明記。
- `src/message/session.ts` の `encodeRequestErrorPayload`: 受信リクエストの拒否 (incomingSendRequestErrorAndClose)、受信 PUBLISH ストリーム上での REQUEST_UPDATE エラー応答 (GOING_AWAY / NOT_SUPPORTED)、送信 PUBLISH の bidi ストリーム上での REQUEST_UPDATE エラー応答 (bidiSendRequestError 経由の GOING_AWAY / INVALID_FILTER および直接エンコードの INTERNAL_ERROR) を明記。
- `src/message/subscribe.ts` の `decodeRequestUpdatePayload`: 受信 PUBLISH ストリーム (bidiHandlePublishRequestUpdate) と送信 PUBLISH の bidi ストリーム (bidiReadRequestStreamMessages) の 2 経路を明記。
- コメントが正しい他関数 (`decodeFetchPayload` / `encodeFetchOkPayload` / `decodeSubscribePayload` / `encodeSubscribeOkPayload` / `encodeFetchHeader` / `encodeFetchObjectFields`) は変更していない。
- `CHANGES.md` の `## develop` セクション内の既存 `### misc` サブセクションに `[UPDATE]` エントリを追加した。
