# filter のマッチング解決を Property-Based Testing で検証する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-filter-match-pbt
- Polished: YYYY-MM-DD

## 目的

`objectMatchesFilter` / `rangeFiltersMatch` の組み合わせ爆発を例示テストで覆い切れていない。結合則・単調性は PBT に最適であり検証する必要がある。

## 現状

- `src/filter.ts` に対応する `*.prop.ts` がなく、`src/filter.test.ts` の例示のみである。
- `resolveFilter` 自体は `0425` で PBT 化が追跡中のため、本 issue の対象外とする。

## 設計方針

1. 0425 で新設される `src/filter.prop.ts` へ追記し、`objectMatchesFilter(resolveFilter(...))` の単調性、Range Filter の AND / OR 結合則、SetID 群の可換性を検証する (同一ファイルのため 0425 の新設後に着手する)。
2. PBT でカバーできた固定値テストは単体側から削除する。

## 完了条件

- `src/filter.prop.ts` が追加され結合則・単調性が検証されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0425` (`resolveFilter` の PBT。本 issue はマッチング側で分担する)
- draft-ietf-moq-transport-20 §5.1.2
