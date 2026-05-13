# Fetch 応答で Object ID と Group ID を delta encode する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で FETCH ストリーム内の object header の Object ID および Group ID が
delta encoding に変更された。
従来は絶対値で送られていたが、差分エンコードによりサイズが削減される。
ワイヤーフォーマットの後方互換性がない。

## draft-18 参照

- draft-ietf-moq-transport-18 §11.4.4 Fetch Header
- draft-ietf-moq-transport-18 §11.4.4.1 Flags
- moq-wg/moq-transport#1586

## 影響範囲

- FETCH stream の object header エンコード / デコード
- 1 つ前の (group, object) ID を保持するパーサ状態
- delta 累積によるラップアラウンド検出 (#1560 と関連)
