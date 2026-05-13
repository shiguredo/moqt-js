# FILL_TIMEOUT パラメータを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で新しいパラメータ FILL_TIMEOUT が追加された。
relay が欠損 object の fill 待機に費やす最大時間を制御し、
delivery timeout とは異なる粒度の動作制御が可能になる。
moqt-js は FILL_TIMEOUT を送受信できるようパラメータ ID とエンコードを追加する。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.2.5 FILL TIMEOUT Parameter
- draft-ietf-moq-transport-18 §8 Delivery Timeouts and Data Reliability
- moq-wg/moq-transport#1490

## 影響範囲

- パラメータ定数 / エンコーダ / デコーダ
- Subscribe / Publish 時のパラメータ指定 API
- devtools の表示
