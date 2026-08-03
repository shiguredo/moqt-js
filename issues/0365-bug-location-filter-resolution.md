# Location Filter の解決が仕様と不一致

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-location-filter-resolution
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.2 に基づき、Location Filter の解決ロジックを仕様どおりに修正する。Largest Object フィルタの Start Location に Object + 1 が適用されておらず、Next Group Start フィルタがコンテンツ未配信時に {0, 0} ではなく {1, 0} を返す。

## 現状

- `src/filter.ts` の `resolveFilter()` は Largest Object（0x2）で `{ start: resolved }` を返し、仕様の「{Largest Object.Group, Largest Object.Object + 1}」の +1 を適用していない。Largest Object と同一 Location のオブジェクト（再送・並び替え）がフィルタを通過してアプリに重複配信される。
- Next Group Start（0x1）は `{ resolved.group + 1n, 0n }` を常に返す。仕様は「If no content has been delivered yet, the filter Start Location is {0, 0}」であり、`largestLocation` が null の場合は {0, 0} になるべき。現在は {1, 0} になり、コンテンツ未配信のライブ配信に subscribe すると Group 0 のオブジェクトが全て落ちる。
- `src/filter.test.ts` が誤った挙動を固定している（NextGroupStart 未配信時 Group 1、LargestObject の Location をそのまま start にする）。

## 設計方針

- `resolveFilter()` を修正し、仕様どおりにする:
  - Largest Object: `{ group: resolved.group, object: resolved.object + 1n }`
  - Next Group Start: `largestLocation` が null なら `{ group: 0n, object: 0n }`、非 null なら `{ group: resolved.group + 1n, object: 0n }`
- `src/filter.test.ts` の期待値を仕様どおりに更新し、未配信時・配信済み時の境界ケースを追加する。

## 完了条件

- Largest Object フィルタの Start Location が {Largest Object.Group, Largest Object.Object + 1} になる。
- Next Group Start フィルタが未配信時に {0, 0}、配信済み時に {Largest Object.Group + 1, 0} になる。
- 修正後の挙動を検証するテストがあり、`src/filter.test.ts` の誤った期待値が更新されていること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

未着手。
