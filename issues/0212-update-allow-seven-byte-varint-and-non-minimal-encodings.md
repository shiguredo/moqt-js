# 7 バイト varint と非最小エンコーディングを許可する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で MOQT varint に 7 バイト長が許可され、さらに非最小エンコーディング
(値の表現に必要な最小バイト数を超える長いエンコード) も許容されることが明示された。
moqt-js の varint デコーダは 7 バイト長を受理し、非最小エンコードでもエラーにせず受け入れる必要がある。
varint エンコーダは 7 バイト長を出力する経路を持つかどうか方針決めが必要。

## draft-18 参照

- draft-ietf-moq-transport-18 §1.4.1 Variable-Length Integers
- moq-wg/moq-transport#1595

## 影響範囲

- `src/varint.ts` のデコーダ (7 バイト長対応、非最小許容)
- `src/varint.test.ts` / `src/varint.prop.ts` の期待値
- 既存の varint 関連バリデーション (0001 などで実装済み)
