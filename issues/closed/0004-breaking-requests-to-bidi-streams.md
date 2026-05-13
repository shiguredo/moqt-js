# リクエストを双方向ストリームに移動、キャンセルメッセージ削除

## 概要

SUBSCRIBE/PUBLISH/FETCH などのリクエストを制御ストリームから双方向ストリームに移動する。これに伴いキャンセルメッセージを削除する。

## 参照

- draft-ietf-moq-transport-17 Section 5
- https://github.com/moq-wg/moq-transport/pull/1389

## 変更内容

- draft-16 ではリクエスト (SUBSCRIBE, PUBLISH, FETCH 等) は制御ストリーム上で送受信されていた
- draft-17 ではリクエストごとに双方向ストリームを開き、リクエストとレスポンスをやり取りする
- ストリームを閉じることでキャンセルを表現するため、SUBSCRIBE_CANCEL, FETCH_CANCEL, PUBLISH_CANCEL 等のキャンセルメッセージを削除
- REQUEST_OK/REQUEST_ERROR をレスポンスストリーム上の最初のフレームとして送信

## 影響範囲

- `src/session.ts`
- `src/message/subscribe.ts`
- `src/message/publish.ts`
- `src/message/fetch.ts`
- `src/message/types.ts`
- `src/subscriber.ts`
- `src/publisher.ts`
- `src/fetcher.ts`

## 実装方針

1. draft-17 Section 5 のリクエスト双方向ストリーム仕様を確認する
2. リクエスト送信時に双方向ストリームを開く処理を実装する
3. キャンセルメッセージ (SUBSCRIBE_CANCEL, FETCH_CANCEL 等) を削除する
4. REQUEST_OK/REQUEST_ERROR のレスポンス処理を更新する
5. ストリームクローズによるキャンセル処理を実装する

## 解決方法

SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS のリクエスト送信を双方向ストリーム経由に変更した。

- `sendRequestOnBidiStream()` ヘルパーメソッドを追加
- 各リクエスト (publish/subscribe/fetch/trackStatus) が個別の双方向ストリームを開く
- レスポンス (REQUEST_OK/REQUEST_ERROR) を同じストリームのレスポンス側から読み取る
- `readPublishResponse`/`readSubscribeResponse`/`readFetchResponse`/`readTrackStatusResponse` で各レスポンスをパース
- `readRequestStreamMessages` で確立後の継続メッセージ (PUBLISH_DONE 等) を読み取る
- `requestStreams` マップでリクエストごとのストリームを管理
- FETCH_CANCEL を削除 (ストリームクローズでキャンセル)
- REQUEST_OK/REQUEST_ERROR から Request ID を削除済み
- Required Request ID Delta フィールドを追加済み
- REQUEST_UPDATE, UNSUBSCRIBE は暫定的に制御ストリームのまま (TODO)
