# REQUEST_OK/REQUEST_ERROR から Request ID 削除

## 概要

REQUEST_OK と REQUEST_ERROR メッセージから Request ID フィールドを削除する。

## 参照

- draft-ietf-moq-transport-17 Section 9.5, 9.6
- https://github.com/moq-wg/moq-transport/pull/1499

## 変更内容

- draft-16 では REQUEST_OK/REQUEST_ERROR は制御ストリーム上で送信され、Request ID でリクエストを特定していた
- draft-17 ではリクエストが双方向ストリームに移動したため、レスポンスストリーム上の最初のフレームとして送信される
- ストリーム自体がリクエストを特定するため、Request ID フィールドは不要になり削除

## 影響範囲

- `src/message/subscribe.ts`
- `src/message/publish.ts`
- `src/message/fetch.ts`
- `src/session.ts`

## 実装方針

1. REQUEST_OK/REQUEST_ERROR のメッセージフォーマットから Request ID を削除する
2. エンコード・デコード処理を更新する
3. レスポンス処理をストリームベースに変更する
4. テストを更新する

## 解決方法

`RequestOk` と `RequestError` インターフェースから `requestId` フィールドを削除。エンコード・デコード処理を更新。`session.ts` では REQUEST_OK/REQUEST_ERROR のルーティングを pending マップのイテレーションに変更（双方向ストリーム移行後に完全対応予定）。PBT テストも更新。
