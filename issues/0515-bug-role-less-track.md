# role なしトラックが購読対象から不可視になる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-role-less-track
- Polished: 2026-09-06

## 目的

`role` 省略のカタログ (`name` 指定あり) で要求したメディアの購読が警告なく行われない。カタログ全体からの名前一致フォールバックと、未解決時の通知が必要である。

## 現状

- `role` による絞り込み本体は `src/msf.ts` の `getVideoTracks` / `getAudioTracks` (完全一致 filter) であり、`src/createMediaSubscriber.ts` の `extractTrackInfo` はその結果に名前一致 + 先頭フォールバックを行う二段階構成である。`role` 省略トラックは前段で除外されるため後段の名前解決に到達せず、対象なし (`null`) になる。`null` 時は黙って skip し、通知も `throw` もない。
- `role` は MSF §5.2.6 の optional フィールドである。

## 設計方針

1. role 絞り込み結果が空の場合、カタログ全体から名前一致 (`getTrackByName`) で探す (`msf.ts` の helper は変えない)。`trackName` 未指定時はデフォルト名で探し、なければ `null` のままにする (先頭トラックの無条件採用はしない)。
2. 未解決時は `onError` で通知する (黙って skip しない)。`throw` はせず、利用可能な他方メディアの継続は保つ。
3. role 省略カタログの解決・通知をテストで pin する。

## 完了条件

- `role` 省略カタログで名前一致のトラックが購読対象に特定されること。
- 未解決時は `onError` が呼ばれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
