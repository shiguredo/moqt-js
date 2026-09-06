# Request Keyframe の固定値送信で新規 Group が開始されない

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-keyframe-value
- Polished: YYYY-MM-DD

## 目的

キーフレーム要求ボタンが実質無機能である。現行 Group 体系で有効な値を送る必要がある。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `requestKeyframe` は `NEW_GROUP_REQUEST` の値を `1` 固定で送信する。
- ライブラリ正規経路 (`src/createMediaSubscriber.ts` の `requestKeyframe`) も `0x32`=`0x01` 固定のため、devtools 固有でなく共通の問題である。
- §10.2.19 では値は subscriber が知る最大 Group ID + 1 (情報なし時は `0`) であり、`0` または現行 Group 超の値でのみ publisher が新規 Group を開始する。時刻起点の巨大 Group ID に対して `1` では新規 Group が開始されない (relay は upstream へ転送するのみで無視しない)。
- 保持済みの `largestLocation` が未使用である。

## 設計方針

1. `0` (情報なし) または `largestLocation` の Group ID + 1 を送る (保持値を活用)。
2. ライブラリ正規経路と devtools を合わせて修正する。

## 完了条件

- ボタン操作でキーフレーム要求が有効になること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.19
