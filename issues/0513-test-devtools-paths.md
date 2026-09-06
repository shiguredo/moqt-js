# devtools の主要経路をテストする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-devtools-tests
- Polished: YYYY-MM-DD

## 目的

主要動作経路が無テストで、Catalog 誤記や固定 Keyframe を検出できない体制である。検証可能な範囲をテストする必要がある。

## 現状

- `usePublisher` / `EncoderWrapper` / `DecoderWrapper` / `codec.ts` にテストがない。
- 既存テストは helper のみで、LOC 復号・描画・購読開始・要求フローを扱わない。
- 一部テストが `as never` スタブで AGENTS.md に反する。

## 設計方針

1. 純粋部・契約部からテストを追加する (Catalog 生成、codec 解決、開始フローの純粋部)。
2. `as never` を規約適合の形に直す (fake 明示化または統合経路寄せ)。

## 完了条件

- 主要経路の退行がテストで検出できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
