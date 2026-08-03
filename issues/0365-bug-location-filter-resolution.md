# Location Filter の解決が仕様と不一致

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-location-filter-resolution
- Polished: 2026-08-03

## 目的

draft-ietf-moq-transport-19 §5.1.2 に基づき、Location Filter の解決ロジックを仕様どおりに修正する。現在は Largest Object フィルタの Object + 1 未適用により通過すべきでないオブジェクトが配信され、Next Group Start フィルタの未配信時 {1, 0} により通過すべきオブジェクト（Group 0）が配信されない。

## 現状

- `src/filter.ts` の `resolveFilter()` は Largest Object（0x2）で `{ start: resolved }` を返し、仕様の「{Largest Object.Group, Largest Object.Object + 1}」の +1 を適用していない。Largest Object と同一 Location のオブジェクト（再送）がフィルタを通過してアプリに重複配信される（仕様の Note「Locations smaller than Largest Object ... do not pass the Largest Object filter」に言うより小さい Location は現状の実装でも既にブロックされており、通過しうるのは同一 Location のみ。より大きい Location は正しく通過する）。
- Next Group Start（0x1）は `{ resolved.group + 1n, 0n }` を常に返す。仕様は「If no content has been delivered yet, the filter Start Location is {0, 0}」であり、`largestLocation` が null の場合は {0, 0} になるべき。現在は `resolved = largestLocation ?? { group: 0n, object: 0n }` のフォールバックにより {1, 0} になり、コンテンツ未配信のライブ配信に subscribe すると Group 0 のオブジェクトが全て落ちる。
- `src/filter.test.ts` が誤った挙動を固定している（NextGroupStart 未配信時 Group 1、LargestObject の Location をそのまま start にする）。

## 設計方針

- `resolveFilter()` を修正し、仕様どおりにする:
  - Largest Object: `largestLocation` が null なら `{ group: 0n, object: 0n }`、非 null なら `{ group: resolved.group, object: resolved.object + 1n }`
  - Next Group Start: `largestLocation` が null なら `{ group: 0n, object: 0n }`、非 null なら `{ group: resolved.group + 1n, object: 0n }`
- `src/filter.test.ts` の期待値を仕様どおりに更新し、境界ケースを追加する。既存の「LargestObject で LARGEST_OBJECT 未受信時は {0, 0}」は仕様どおり正しいため更新しない。

## 完了条件

- Largest Object フィルタの Start Location が、未配信時 {0, 0}、配信済み時 {Largest Object.Group, Largest Object.Object + 1} になる。
- Next Group Start フィルタが未配信時に {0, 0}、配信済み時に {Largest Object.Group + 1, 0} になる。
- 修正後の挙動を検証するテストがあり、`src/filter.test.ts` の誤った期待値（NextGroupStart 未配信時 Group 1 と、LargestObject の Location をそのまま start にするテストの 2 本）が更新されていること（テスト名・コメントも更新する。維持するテストのうち NextGroupStart 配信済み時のコメントに含まれる「未受信時は {0, 0} から開始するため Group 1 になる」という誤った記述も修正する）。境界ケースのうち新規追加が必要なのは「Largest Object = {0, 0} 配信済み時 {0, 1}」のみで、Largest Object 未配信時 {0, 0} と Next Group Start 配信済み時 {Group + 1, 0} は既存テストでカバー済みのため維持する。
- `src/filter.ts` の仕様要約コメント（`resolveFilter()` の JSDoc の LargestObject / NextGroupStart の記述）が更新されていること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-19 §10.2.16 (LARGEST_OBJECT Parameter)

## 解決方法

未着手。
