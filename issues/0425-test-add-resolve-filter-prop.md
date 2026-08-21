# resolveFilter の解決結果を Property-Based Testing で検証する

- Created: 2026-08-22
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-resolve-filter-prop
- Polished: {YYYY-MM-DD}

## 目的

`resolveFilter()`（`src/filter.ts`）の解決ロジックを fast-check の PBT で検証する。`resolveFilter()` は入力集合（LocationFilter 種別 × LARGEST_OBJECT の有無 × Location 値）が有限の離散パターンで、かつ純粋関数のため、プロパティ（不変条件）ベースの検証が可能である。現在は固定値の単体テストのみで、Location の任意の組み合わせを横断的に検証できない。

## 現状

- `resolveFilter()` のテストは `src/filter.test.ts` の固定値単体テストのみ（LargestObject / NextGroupStart / AbsoluteStart / AbsoluteRange の代表値）。
- `src/filter.ts` に対応する `*.prop.ts` は存在しない（既存の `src/dataStream.prop.ts` / `src/session.prop.ts` / `src/loc.prop.ts` 等の PBT 群があるにも関わらず）。
- 未配信時は一覧の {0, 0} が返るか、配信済み時は「Start Location が LARGEST_OBJECT の直後（同 Group の次 Object、または次 Group）」であるかといった不変条件は、任意の Location で検証できていない。フォールバック値への +1 適用（未配信時 {0, 1}）のような退行を PBT で捕捉できる余地があった。

## 設計方針

- `src/filter.prop.ts` を新設し、`@fast-check/vitest` の `fc.prop` で検証する（既存の `src/session.prop.ts` の構成・流儀を踏襲する）。
- プロパティの例: LargestObject に対する解決値の Start Location が LARGEST_OBJECT の直後であること / NextGroupStart の Start が「LARGEST_OBJECT の次の Group の {0, 0}」であること / `largestLocation` が null なら {0, 0} であること / Filter 種別ごとの End Group 総体（AbsoluteRange の End Group = Start.Group + EndGroupDelta）。
- 単体テスト（`src/filter.test.ts`）は PBT では検証できない意図的なエラーパス・境界値・仕様文面の確認に絞る（PBT でカバーできたものは単体側から削除する）。

## 完了条件

- `src/filter.prop.ts` が追加され、`resolveFilter()` のすべての Filter 種別に対してプロパティ検証が実行されること。
- プロパティ違反の退行（未配信時の {0, 1}、LargestObject の +1 漏れ、NextGroupStart の {0, 0} 漏れ）を PBT が検出できること。
- PBT でカバーされた固定値単体テストがある場合は単体側から削除されていること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

未着手。
