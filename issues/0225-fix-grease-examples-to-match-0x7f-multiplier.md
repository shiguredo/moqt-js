# Grease 例を 0x7f 倍数に揃える

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で greasing (未知 type を意図的に挿入してパーサの堅牢性をテストする手法) の例が
0x7f 倍数のコードポイントに揃えられた。
moqt-js は greasing を能動的に送出しないが、受信時に未知 type を黙って破棄する経路が
仕様の grease 期待値と整合しているか確認する。

## draft-18 参照

- draft-ietf-moq-transport-18 §4 Extensibility
- moq-wg/moq-transport#1569

## 影響範囲

- 未知メッセージタイプ / パラメータ受信時のハンドリング
- 既存テストの grease 値
