# keyframeSpacing の宣言値と実際の Object 数の関係を整理する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-22 の残りを決着させる。§5.2.46 の `keyframeSpacing` は現行 publisher が自動計算していない。

## 現状

- 指定値の検証は実装済み。実際の Group の Object 数と一致する保証は無い

## 設計方針

- 自動計算は行わない (エンコーダのキーフレームは経過時間ベースで、フレーム数ベースへ変えると映像制御に影響する)
- 1 Group あたりの Object 数の実測を統計に追加し、利用者が宣言値と比較できるようにする
- JSDoc に責任範囲を明記する

## 完了条件

- 1 Group あたりの Object 数の実測が統計に出る。単体テストで固定する
- JSDoc と docs に責任範囲を明記する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
