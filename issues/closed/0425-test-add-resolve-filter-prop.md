# resolveFilter の解決結果を Property-Based Testing で検証する

- Created: 2026-08-22
- Updated: 2026-09-05
- Completed: 2026-09-14
- Branch: feature/refactor-resolve-filter-prop
- Polished: {YYYY-MM-DD}

## 目的

`resolveFilter()`（`src/filter.ts`）の解決ロジックを fast-check の PBT で検証する。`resolveFilter()` は入力集合（LocationFilter 種別 × LARGEST_OBJECT の有無 × Location 値）が有限の離散パターンで、かつ純粋関数のため、プロパティ（不変条件）ベースの検証が可能である。現在は固定値の単体テストのみで、Location の任意の組み合わせを横断的に検証できない。

## 現状

- `resolveFilter()` のテストは `src/filter.test.ts` の固定値単体テストのみ (1 フィールド / 2 フィールド / 3 フィールド / 4 フィールド / reset の代表値)。
- `src/filter.ts` に対応する `*.prop.ts` は存在しない（既存の `src/dataStream.prop.ts` / `src/session.prop.ts` / `src/loc.prop.ts` 等の PBT 群があるにも関わらず）。
- 未配信時は一覧の {0, 0} が返るか、配信済み時は「Start Location が LARGEST_OBJECT の直後（同 Group の次 Object、または次 Group）」であるかといった不変条件は、任意の Location で検証できていない。フォールバック値への +1 適用（未配信時 {0, 1}）のような退行を PBT で捕捉できる余地があった。

## 設計方針

- `src/filter.prop.ts` を新設し、`fast-check` の `fc.assert(fc.property(...))` と `vite-plus/test` で検証する（既存の `src/session.prop.ts` の構成・流儀を踏襲する）。
- プロパティの例: 2 フィールド 0:0 の Start が `{Group, Object + 1}` であること / 1 フィールドの Start が `{Group + 1 - StartGroup, 0}` (負値は 0、上端は MAX_VARINT にクランプ) であること / 1 フィールドおよび 2 フィールド 0:0 で `largestLocation` が null なら {0, 0} であること (絶対系は `largestLocation` 非依存) / 3 フィールドの End Group = StartGroup + EndGroupDelta、4 フィールドは加えて EndObject を保持すること。
- 単体テスト（`src/filter.test.ts`）は PBT では検証できない意図的なエラーパス・境界値・仕様文面の確認に絞る（PBT でカバーできたものは単体側から削除する）。

## 完了条件

- `src/filter.prop.ts` が追加され、`resolveFilter()` のすべての Filter 種別に対してプロパティ検証が実行されること。
- プロパティ違反の退行（未配信時の {0, 1}、LargestObject の +1 漏れ、NextGroupStart の {0, 0} 漏れ）を PBT が検出できること。
- PBT でカバーされた固定値単体テストがある場合は単体側から削除されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters) / §10.2.9 (LOCATION FILTER Parameter)

## 解決方法

`src/filter.prop.ts` を新設し、`resolveFilter` の検証を PBT に移した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §3.3.1 (Location Filters) / §9.20.10 (LOCATION FILTER Parameter) に対応するため、コメントは draft-21 の節番号に合わせている。

### 追加したプロパティ (10 件)

- 未指定と reset は LARGEST_OBJECT に依存せず undefined になる
- 絶対系 (2 / 3 / 4 フィールド) は LARGEST_OBJECT に依存しない (未配信 / 配信済み / 別の Location で同じ結果)
- 2 フィールドは絶対 Location を start にし終端を持たない
- 3 フィールドの End Group は StartGroup + EndGroupDelta
- 4 フィールドは End Object を保持する
- 1 フィールドは Next Group 基準で Object 0 から開始し、負値は 0、2^64-1 超過は 2^64-1 にクランプされる
- 1 フィールドで未配信時は {0, 0} になる
- 2 フィールド 0:0 は LARGEST_OBJECT の次 Object から開始する
- 2 フィールド 0:0 で未配信時は {0, 0} になる
- 任意の Filter で解決結果の Start が 0〜2^64-1 に収まり、種別に対応する終端だけを持つ

### arbitrary の設計

一様乱数の `fc.bigInt({ min: 0n, max: MAX_VARINT })` では 2^64-1 がほぼ生成されず、クランプ分岐を通らない。また {0, 0} は「配信済み」の境界であり、未配信 (null) との判定を書き分ける必要がある。そのため `boundaryLocationArb` で {0, 0} / {0, MAX_VARINT} / {MAX_VARINT, 0} / {MAX_VARINT, MAX_VARINT} / {MAX_VARINT - 1, 0} を定数として混ぜている。

Filter 側は型を絞った arbitrary (`AbsoluteStartFilter` / `AbsoluteRangeFilter` / `AbsoluteRangeWithEndObjectFilter` / `RelativeGroupFilter`) を種別ごとに用意し、`filter.startGroup` などへのアクセスを型安全にした。

### 単体テストの削除

`resolveFilter` は例外を投げず (クランプで吸収する)、境界値も上記 arbitrary で到達するため、`src/filter.test.ts` の `resolveFilter` 固定値単体テスト 14 件を削除した。`objectMatchesFilter` / `rangeFiltersMatch` / `trackPropertyFiltersMatch` のテストは対象外として残している。

### 退行検出の裏付け

次の 3 退行を実際に注入し、PBT が検出することを実測した。注入は元に戻している。

- 1 フィールドで未配信時に {0, 1} を返す (未配信フォールバックへの +1 適用) → `1 フィールドで未配信時は {0, 0} になる` が失敗
- 2 フィールド 0:0 で Largest Object の +1 を落とす → `2 フィールド 0:0 は LARGEST_OBJECT の次 Object から開始する` が失敗
- 1 フィールドの未配信判定を削除する → `1 フィールドで未配信時は {0, 0} になる` が失敗

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 71 ファイル / 2,136 テスト全通過 (resolveFilter 単体 14 件削除 + PBT 10 件追加)
- `src/filter.prop.ts` 単体で `src/filter.ts` の `resolveFilter` が全行・全分岐カバーされることを確認した
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
