# devtools の Audio Playback に穴・段差・押し直し・drain の計器を表示する

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/add-devtools-audio-playout-instruments
- Polished: {YYYY-MM-DD}

## 目的

音声の playout に追加した計器が Copy for LLM の JSON にしか出ておらず、画面から
「プチプチ」「遅い」の原因を切り分けられない。Wi-Fi のデモで品質を確認するには、無音の穴と
境界の段差、押し直し、停止時の drain をその場で読める必要がある。

## 現状

- `src/playout/audioPlayoutTimingStats.ts` の `AudioPlayoutTimingSnapshot` には
  `gapCount` / `gapMs` / `gapMaxMs` / `unrecoverableGapCount` / `unrecoverableGapMs` /
  `lateStartCount` / `lateStartMaxMs` / `pushStartCount` / `pushStartMaxMs` /
  `boundaryStepCount` / `boundaryStepMax` / `lastDrain` がある
- `devtools/src/signals/statsSnapshot.ts` は `audio.playoutTiming` として snapshot 全体を
  JSON に出しているが、`devtools/src/components/SubscriberPanel.tsx` の Audio Playback
  Timing セクションは一部しか表示していない
- `audio.receiveDelayMs` / `maxReceiveDelayMs` と、`audioDelayFeedback` の
  `appliedCeilingMs` / `compressionMsPerSecond` も非表示である
- `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` の「devtools の Audio Playback Timing から
  読める」という記述は実装と合っていない

## 設計方針

- Audio Playback Timing セクションに `StatList` / `TimingTable` を追加し、上記の値を表示
  する。単位 (ms / count) と tone (warn) は既存の表示規則に合わせる
- `receiveDelayMs` / `maxReceiveDelayMs` は Audio セクションにも表示する
- `appliedCeilingMs` / `compressionMsPerSecond` は `audioDelayFeedback` の snapshot から
  devtools の統計へ写して表示する。null のときは `-` を出す
- 表示の追加に合わせて `devtools/src/components/statsHelp.ts` の用語説明を追加する

## 完了条件

- 画面に上記の全項目が出る。新しい `testId` をコンポーネントテストまたは E2E で固定する
- Copy for LLM の JSON と画面の値が一致する
- `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` の記述を実装に合わせる
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

Audio Playback Timing と Audio の節に、未表示だった計器を追加した。穴 (`gapCount` / `gapMs` /
`gapMaxMs` / `unrecoverableGapCount` / `unrecoverableGapMs`)、境界の段差 (`boundaryStepCount` /
`boundaryStepMax`)、押し直し (`lateStartCount` / `lateStartMaxMs` / `pushStartCount` / `pushStartMaxMs`)、
drain (`playedMs` / `cutMs` / `waitedMs` / `requestedMs`)、到着の遅れ (`receiveDelayMs` /
`maxReceiveDelayMs`)、目標遅延の上限と圧縮 (`appliedCeilingMs` / `compressionMsPerSecond`) を表示し、
`statsSnapshot` の JSON と同じ値にした。`statsHelp.ts` に用語説明を足し、
`docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` の「devtools の Audio Playback Timing から読める」という記述を
実装に合わせた。

検証: `statsSnapshot` の単体テストで JSON の値を固定し、軽量な Playwright で新しい `testId` の表示を
確認した。`vp check` / `tsc --noEmit` / `vp test run` が通る。
