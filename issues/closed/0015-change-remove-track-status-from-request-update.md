# REQUEST_UPDATE から TRACK_STATUS 削除

## 概要

REQUEST_UPDATE メッセージから TRACK_STATUS フィールドを削除する。

## 参照

- draft-ietf-moq-transport-17 Section 9.7
- https://github.com/moq-wg/moq-transport/pull/1436

## 変更内容

- draft-16 では REQUEST_UPDATE メッセージに TRACK_STATUS フィールドが含まれていた
- draft-17 では REQUEST_UPDATE から TRACK_STATUS を削除

## 影響範囲

- `src/message/subscribe.ts` または対応するメッセージファイル
- `src/session.ts`

## 実装方針

1. REQUEST_UPDATE のメッセージフォーマットから TRACK_STATUS フィールドを削除する
2. エンコード・デコード処理を更新する
3. テストを更新する

## 解決方法

現在の `RequestUpdate` インターフェース (`subscribe.ts`) には TRACK_STATUS フィールドが含まれていない（requestId, existingRequestId, parameters のみ）。draft-16 実装時点で既に TRACK_STATUS フィールドなしで実装されていた。コード変更不要。
