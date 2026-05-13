# GOAWAY メッセージに Request ID を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で GOAWAY メッセージに Request ID フィールドが追加された。
これは個別リクエスト単位のマイグレーション (#1617) を実現するための前提となるフィールドであり、
ワイヤーフォーマットの後方互換性がない。
moqt-js の GOAWAY エンコーダ / デコーダを更新する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.4 GOAWAY
- moq-wg/moq-transport#1559

## 影響範囲

- GOAWAY メッセージ構造体 / encoder / decoder
- セッションレベル / リクエストレベルの判別処理
- 関連テスト
