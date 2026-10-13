# PlaybackTimeline の同期の足し分が上限を超える

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playback-sync-delay-cap
- Polished: 2026-10-13

## 目的

`PlaybackTimeline` の同期の制御は、トラックごとに足す遅延を上限 `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) までに抑える契約である。しかし `alignSyncExtras` がこの上限を超える量を足すことがあり、`src/playbackTimeline.prop.ts` の「PlaybackTimeline: 120 秒の到着列でも同時刻の表示時刻の差は合わせない分に収まる」が失敗して develop の CI が落ちた。契約を守り、テストが安定するようにする。

## 現状

- 失敗した assert は `assert.isAtMost(breakdown.video.syncExtraDelayMs, PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS)`。実測値は 102.18213867187505 であり、浮動小数点の誤差 (1e-14 程度) ではなく実装が上限を超えている (develop の build (26)、seed 869714401)
- 原因は `src/playbackTimeline.ts` の `alignSyncExtras` にある。目標の差 (`desiredDifferenceMs`) は同期が足した分を含まない素の遅れから求めるのに、足す先の目標 (`targetMs`) は既に足した分を含む現在の値から求めるため、相手側が既に足している分を上乗せして 100 ms を超える量を足す
  - 実測例: 素の遅れは音声 1119 ms / 映像 1038 ms (差 81 ms) で、足し済みは音声 +56.74 ms / 映像 +87.74 ms。`desiredDifferenceMs` は 30 ms、`targetMs` は 1145.74 ms になり、映像へ 107.74 ms を足す
- 再現手順: `src/playbackTimeline.prop.ts` の当該テストの `fc.assert` に `{ numRuns: 1, seed: 869714401 }` を渡すと `expected 102.18213867187505 to be at most 100` で失敗する
- 失敗はまれではない。失敗を観測した seed の到着列では、`alignSyncExtras` が上限を超える場面が実行中に何度も現れる

## 設計方針

- `alignSyncExtras` が足す量を上限 `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` でクランプする。上限を超える分は足さず、相手側が既に足している分は相手側の戻し (`decaySyncExtras`) に任せ、足りない分は A/V のずれとして残す
- 上限そのものは緩めない。テストの比較に許容幅を足す形では直さない
- コメントに、なぜクランプが要るか (相手側の足し済み分を上乗せしない) を書く
- 対象外
  - テストの比較の許容幅 (`ALLOWANCE_MS` / `TOLERANCE_MS`) の変更
  - `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` の値の変更
  - `desiredDifferenceMs` の規則の変更

## 完了条件

- 音声と映像の `syncExtraDelayMs` が上限 `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` を超えない
- 失敗を観測した seed 869714401 の到着列で当該テストが通る
- 同じ property を多数の seed (75 以上) で実行して失敗しない
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `src/playbackTimeline.ts` の `alignSyncExtras` / `desiredDifferenceMs` / `decaySyncExtras` / `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS`
- `src/playbackTimeline.prop.ts` の「PlaybackTimeline: 120 秒の到着列でも同時刻の表示時刻の差は合わせない分に収まる」
- develop の CI 失敗: build (26)、seed 869714401 (`expected 102.18213867187505 to be at most 100`)

## 解決方法

{未着手}
