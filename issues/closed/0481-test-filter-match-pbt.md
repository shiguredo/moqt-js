# filter のマッチング解決を Property-Based Testing で検証する

- Created: 2026-09-06
- Completed: 2026-09-14
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

## 解決方法

0425 で新設した `src/filter.prop.ts` に、マッチング側のプロパティを追加した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §3.3.1 (Location Filters) / §3.3.2 (Range Filters) / §9.20.10 (LOCATION FILTER Parameter) に対応するため、コメントは draft-21 の節番号に合わせている。

### 追加したプロパティ (11 件)

`objectMatchesFilter` (7 件):

- filter 未指定は任意の Location を通過する
- Start ちょうどは通過し、Start より小さい Location (同 Group の 1 つ前の Object、または 1 つ前の Group) は不通過
- End Group より大きい Group、および End Group 内で End Object より大きい Object は不通過
- End Object は End Group 内でのみ上限になり、End Group より前の Group は Object の値に関わらず通過する
- 終端を持たないフィルタは Start 以降で単調 (通過した Location より大きい Location も通過する)
- Start Group より大きい Group は End Group まで通過する

`rangeFiltersMatch` (5 件):

- フィルタなし (空配列) と削除エントリのみは全通過
- 指定の並び順を変えても結果が変わらない (SetID ごとの AND / 異なる SetID 間の OR は可換)
- 削除エントリを加えても結果が変わらない
- 同一 SetID の指定を足しても通過が不通過に変わらない (AND の単調性)
- 新しい SetID の指定を足しても不通過が通過に変わらない (OR の単調性)

### 実装中に判明した点

- Range Filter の単調性は「評価対象の SetID が 1 つ以上ある」ことが前提である。削除エントリしかない場合は「評価対象なし = 全通過」になるため、実フィルタを足すと結果が変わり得る。OR 単調性のプロパティではこのケースを除外している
- 4 フィールドの Filter は `End Object < Start Object` の空範囲を作り得る。空範囲では Start 自身が不通過になるため、arbitrary に `endObject >= startObject` の制約を入れて「Start は通過する」不変条件を検証できるようにした

### 単体テストの削除

`objectMatchesFilter` の固定値単体テスト 8 件を `src/filter.test.ts` から削除した。`rangeFiltersMatch` の単体テストは Range の包含判定・open-ended・OBJECT_PROPERTY_FILTER の抽出とネスト・未指定値の不通過など「値評価」の検証であり、組み合わせ構造の PBT では代替できないため残している。`trackPropertyFiltersMatch` は本 issue の対象外である。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 71 ファイル / 2,139 テスト全通過 (objectMatchesFilter 単体 8 件削除 + PBT 11 件追加)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
