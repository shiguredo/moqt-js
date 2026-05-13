# PUBLISH_OK メッセージタイプを廃止し REQUEST_OK の alias にする

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で PUBLISH_OK メッセージタイプが削除され、REQUEST_OK の textual alias に統合された。
PUBLISH リクエストへの成功応答も REQUEST_OK で表現する。
ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.5 REQUEST_OK
- draft-ietf-moq-transport-18 §10.10 PUBLISH
- moq-wg/moq-transport#1611

## 影響範囲

- PUBLISH_OK 専用処理パスの削除
- 応答メッセージのデコードを REQUEST_OK ベースに統一
- 関連定数 / 型 / テスト
