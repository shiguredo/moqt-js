# SUBSCRIBE_NAMESPACE 応答で自身の track を除外する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 では SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 応答に
購読者自身が publish している track を含めない仕様となった。
moqt-js は relay 役ではないが、SUBSCRIBE_NAMESPACE 応答の解釈および
publisher/subscriber を同居させた場合の自己 track ハンドリングを仕様に合わせる必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §6.1 Subscribing to Namespaces
- draft-ietf-moq-transport-18 §10.18 SUBSCRIBE_NAMESPACE
- moq-wg/moq-transport#1596

## 影響範囲

- SUBSCRIBE_NAMESPACE の受信処理
- 既存テストの期待値
