# Immutable Track Properties の定義を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Immutable Track Properties の不変性に関する記述が明確化された。
mutable / immutable の境界、変更が起きた場合の relay / subscriber の挙動が
仕様レベルで詰められた。moqt-js は既に Immutable Properties (Type 0x0B) の
取り扱いを実装済み (0117, 0119 で MUST 検証済み) であり、コメントを更新するのみ。

## RFC 参照

draft-ietf-moq-transport-18 §2.5 (Properties):

> Immutable Properties (Section 12.7) MUST NOT be altered by relays.

draft-ietf-moq-transport-18 §2.5.1 (Mandatory Track Properties):

> Each Track MUST have exactly one set of Immutable Properties.

draft-ietf-moq-transport-18 A.1: "Clarify Immutable Track Properties (#1535)"

## 変更内容

1. `src/properties.ts` の Immutable Properties 関連の JSDoc を draft-18 に更新する
2. `src/properties.ts` の Mandatory Track Properties の説明を draft-18 の文言に合わせる

## 該当ファイル

| ファイル            | 行番号                      | 変更内容                                                  |
| ------------------- | --------------------------- | --------------------------------------------------------- |
| `src/properties.ts` | 1-10                        | draft 番号を 18 に更新する                                |
| `src/properties.ts` | 21-37                       | `MOQTPropertyId.IMMUTABLE_PROPERTIES` の JSDoc を更新する |
| `src/properties.ts` | (decodeImmutableProperties) | 検証ロジックのコメントを draft-18 に更新する              |

## 期待される動作

1. Immutable Properties は relay によって変更されてはならない
2. 各 Track は正確に 1 セットの Immutable Properties を持つ
3. moqt-js の既存の `MalformedTrackError` 検出 (再帰禁止、重複禁止) は継続して有効

## テスト方針

- 既存テストの変更は不要 (既に MUST 検証済み)
- コメント更新のみのためテスト対象外

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
