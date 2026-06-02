# Grease 例を 0x7f 倍数に揃える

- Priority: High

Created: 2026-05-13
Model: Opus 4.7

- Branch: feature/draft-18
- Polished: 2026-06-02

## 概要

draft-18 で Grease 値のパターンが 0x7f \* N + 0x9D であることが再確認され、
例示される Grease 値がこのパターンに揃えられた。

moqt-js の `src/grease.ts` は既にこのパターン (`0x7f * N + 0x9D`) で
`isGreaseValue` / `generateGreaseValue` を実装済みである。
コードの変更は不要。コメントの draft 番号と例示値の更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §14 (Grease):

> Grease values follow the pattern 0x7f \* N + 0x9D for non-negative
> integer values of N (that is, 0x9D, 0x11C, ..., 0x3fffffffffffffde).

draft-ietf-moq-transport-18 A.1: "Fix Grease examples to match 0x7F multiplier (#1569)"

## 変更内容

1. `src/grease.ts` の draft 番号を 17 から 18 に更新する
2. `src/grease.ts` の JSDoc に例示値の上限 `0x3fffffffffffffde` を追記する
3. `src/grease.test.ts` のコメントを draft-18 に更新する

## 該当ファイル

| ファイル             | 行番号 | 変更内容                                         |
| -------------------- | ------ | ------------------------------------------------ |
| `src/grease.ts`      | 1-20   | draft 番号を 18 に更新し、例示値に上限を追記する |
| `src/grease.ts`      | 22-31  | 定数値は変更不要 (0x7f, 0x9d は正しい)           |
| `src/grease.test.ts` | (全般) | draft 番号を 18 に更新する                       |

## 期待される動作

1. `isGreaseValue(value)` は 0x7f \* N + 0x9D のパターンに一致する値を Grease と判定する (既存通り)
2. `generateGreaseValue(n)` は 0x7f \* n + 0x9D の値を生成する (既存通り)
3. 実装に変更はない

## テスト方針

- `src/grease.test.ts` の既存テストはそのままで、draft 参照番号のみ更新する

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
