# Immutable Track Properties の定義を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Immutable Track Properties の不変性に関する記述が明確化された。
mutable / immutable の境界、変更が起きた場合の relay / subscriber の挙動が
仕様レベルで詰められた。
moqt-js は Immutable Properties (Type 0x0B) の取り扱いを再確認する。

## draft-18 参照

- draft-ietf-moq-transport-18 §2.5 Properties
- draft-ietf-moq-transport-18 §2.5.1 Mandatory Track Properties
- moq-wg/moq-transport#1535

## 影響範囲

- `src/properties.ts` の Immutable Properties 処理
- 既存実装 (0117, 0119 など) との整合性確認
- ドキュメント
