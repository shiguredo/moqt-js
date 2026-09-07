# Length 宣言境界ガードの共通ヘルパー化

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/refactor-slice-boundary-guard
- Polished: YYYY-MM-DD

## 目的

同一形の境界ガードが 21 箇所に複製され、抜け落ちの再発温床になっている。共通ヘルパーに集約する必要がある。

## 現状

- `src/message` 配下と `src/properties.ts` の Length 宣言 slice 箇所に `offset + totalConsumed + Number(length) > data.length` 形の検査が文言だけ変えて複製されている。
- 形式が 3 系統に分かれ、各所で `Number()` を反復評価している。

## 設計方針

1. 残量検査を共通ヘルパーに集約する（メッセージと期待値・実際値を引数で受ける）。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10
