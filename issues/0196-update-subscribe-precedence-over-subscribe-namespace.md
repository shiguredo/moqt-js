# Relay で SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先させる

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で relay は同一 track への SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先するよう
明示された。
moqt-js は relay 役ではないが、Subscriber 側で SUBSCRIBE_NAMESPACE / SUBSCRIBE を
混在させた場合の期待挙動を仕様に合わせる必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §6.1 Subscribing to Namespaces
- moq-wg/moq-transport#1533

## 影響範囲

- Subscriber 側の重複購読時の挙動
- 関連テストの期待値
