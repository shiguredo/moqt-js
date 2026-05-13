# REQUEST_UPDATE の coalescing 処理を許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で連続して送られた REQUEST_UPDATE を受信側が coalesce (集約) して処理することが
明示的に許可された。
古い update を中間状態に展開せず、最新の状態だけを反映できる。
moqt-js は Subscriber / Publisher 側で REQUEST_UPDATE の coalesce 仕様に沿うよう
内部キューを見直す必要がある。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.9 REQUEST_UPDATE
- draft-ietf-moq-transport-18 §10.9.1 Updating Subscriptions
- draft-ietf-moq-transport-18 §10.9.2 Updating Namespace Subscriptions
- moq-wg/moq-transport#1540

## 影響範囲

- REQUEST_UPDATE の送受信処理
- Subscriber 側の filter / forward 状態管理
