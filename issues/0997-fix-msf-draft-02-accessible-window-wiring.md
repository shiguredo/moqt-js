# accessibleWindowTime を取得開始位置の決定に配線する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-25 を実装する。§7 は media timeline に基づく取得の前に Accessible Window Time を適用する MUST を定める。

## 現状

- `filterMediaTimelineByAccessibleWindow` は実装済みだが呼び出し元がテストだけ

## 設計方針

- `src/msf/timeline.ts` に `resolveAccessibleStart(entries, track, nowWallclockMs)` を追加し、窓の適用と最初の Group の選択を 1 つにする
- 高レベル購読は media timeline を扱わないため helper の提供までとする

## 完了条件

- 窓の外を落として最初の Group を返す。単体テストで固定する
- `accessibleWindowTime` が無ければ全件を使う。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/timeline.ts` に `resolveAccessibleStart` を追加した。窓の適用と取得開始位置 (media time と Location) の決定を 1 つにまとめた
- 窓内にエントリが無ければ undefined を返す。高レベル購読は media timeline を扱わないため helper の提供までとした
