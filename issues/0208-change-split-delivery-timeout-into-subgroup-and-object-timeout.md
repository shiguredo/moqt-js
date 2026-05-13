# DELIVERY_TIMEOUT を SUBGROUP_DELIVERY_TIMEOUT と OBJECT_DELIVERY_TIMEOUT に分割する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で DELIVERY_TIMEOUT が以下の 2 パラメータに分割された。

- SUBGROUP_DELIVERY_TIMEOUT: Subgroup 単位のタイムアウト
- OBJECT_DELIVERY_TIMEOUT: Object 単位のタイムアウト

タイムアウトの粒度を選択できるようになり、relay の挙動も粒度ごとに変わる。
パラメータ ID とエンコーディングが変わるため、ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.2.3 SUBGROUP_DELIVERY_TIMEOUT Parameter
- draft-ietf-moq-transport-18 §10.2.4 OBJECT_DELIVERY_TIMEOUT Parameter
- draft-ietf-moq-transport-18 §8 Delivery Timeouts and Data Reliability
- draft-ietf-moq-transport-18 §12.1 / §12.2 (IANA 登録)
- moq-wg/moq-transport#1605

## 影響範囲

- DELIVERY_TIMEOUT パラメータ定数 / エンコード
- 既存の delivery timeout 関連 API (0013 などで実装済み)
- devtools の表示
