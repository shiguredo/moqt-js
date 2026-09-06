# role なしトラックが購読対象から不可視になる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-role-less-track
- Polished: YYYY-MM-DD

## 目的

`role` 省略の最小カタログで要求したメディアの購読が警告なく行われない。名前一致へのフォールバックまたは明示的警告が必要である。

## 現状

- `src/createMediaSubscriber.ts` の `extractTrackInfo` は `role` 完全一致のみで探索し、`role` 省略時は対象なしになる。
- `role` は MSF Table 3 の optional フィールドである。

## 設計方針

1. 名前一致へのフォールバックまたは不存在の明示的警告を追加する。
2. テストで pin する。

## 完了条件

- `role` 省略カタログで購読対象が特定できるか、理由が通知されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
