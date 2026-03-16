# PUBLISH_BLOCKED メッセージ追加

## 概要

SUBSCRIBE_NAMESPACE のフロー制御のために PUBLISH_BLOCKED メッセージを追加する。

## 参照

- draft-ietf-moq-transport-17 Section 9.21
- https://github.com/moq-wg/moq-transport/pull/1452

## 変更内容

- draft-17 で新規追加されたメッセージ
- Publisher が新しい Request ID を割り当てられない場合に PUBLISH_BLOCKED を送信する
- SUBSCRIBE_NAMESPACE によるフロー制御の一環として機能する
- Subscriber はこのメッセージを受信したら、不要なリクエストを閉じて Request ID を解放する

## 影響範囲

- `src/message/types.ts`
- `src/message/session.ts` または新規ファイル
- `src/session.ts`

## 実装方針

1. draft-17 Section 9.21 の PUBLISH_BLOCKED 仕様を確認する
2. `src/message/types.ts` に PUBLISH_BLOCKED メッセージタイプを追加する
3. PUBLISH_BLOCKED のエンコード・デコード処理を実装する
4. セッション側で PUBLISH_BLOCKED の送受信処理を実装する
5. テストを追加する

## 解決方法

`MessageType.PUBLISH_BLOCKED` (0x0F) を追加。`PublishBlocked` インターフェースと `encodePublishBlockedPayload`/`decodePublishBlockedPayload` を `namespace.ts` に実装。セッション側の送受信処理は SUBSCRIBE_NAMESPACE の完全実装時に対応する。
