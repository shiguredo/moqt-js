# URI fragment の range を media timeline に適用する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-36 を実装する。§11.1.1 の wallclock-range / mediatime-range / location-range は購読範囲を指定する。parser と union は実装済みだが適用経路が無い。

## 現状

- range の取得関数はあるが、media timeline を絞る関数が無い

## 設計方針

- `src/msf/timeline.ts` に `filterMediaTimelineByRanges(entries, ranges)` を追加する
- 複数 range は union (いずれかに含まれる) とする
- 空配列は指定なしとして全件を返す

## 完了条件

- 3 種類の range で絞れる。単体テストで固定する
- union と指定なしの挙動を単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
