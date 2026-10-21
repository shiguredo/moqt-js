# devtools の catch-up 表示が判定に使う decodeLag ではなく lag を出しているのを直す

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/add-devtools-audio-playout-instruments
- Polished: {YYYY-MM-DD}

## 目的

受信側の追いつき (catch-up) の表示と判定が食い違っており、`lagMs` が上限を超えているのに
`catchingUp` が false のままに見える。ユーザーが「判定が効いていない」と誤読するため、
判定に使う値を表示に出す。

## 現状

- `src/playout/audioReceiveCatchUp.ts` の `AudioReceiveCatchUpSnapshot` は `lagMs` と
  `decodeLagMs` の両方を持つ。判定は
  `decodeLagMs = lagMs - inputLagMs - intentionalDelayMs` で行う
- devtools の `audio.playoutCatchUp` (`devtools/src/signals/statsSnapshot.ts`) は `lagMs` を
  表示しており、`decodeLagMs` と `limitMs` の比較は画面から読めない
- `devtools/src/components/statsHelp.ts` の説明は「lag が limit を 100 ms 超え続けたら
  始まる」と書いているが、実装は床 + 100 ms を超えたら確認を待たずに始める

## 設計方針

- devtools の音声統計に `decodeLagMs` を追加し、表示は `decodeLagMs` と `limitMs` の比較を
  主にする。`lagMs` は参考値として残す
- `statsHelp.ts` の説明を実装 (判定に使う値、開始条件、確認を待たない条件) に合わせる
- E2E / コンポーネントテストで、表示されている `decodeLagMs` が判定に使う値であることを
  固定する

## 完了条件

- 画面と Copy for LLM の JSON から `decodeLagMs` と `limitMs` が読める
- `statsHelp.ts` の記述が実装と一致している
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

受信側の追いつきの表示を、判定に使う `decodeLagMs` と `limitMs` が主になるように変えた。`lagMs` は
入力の遅れと意図した遅延を含む生の値として参考表示に残した。`devtools/src/signals/statsSnapshot.ts` は
両方の値を JSON に出し、`statsHelp.ts` の説明を実装 (判定は `decodeLagMs`、開始条件は床 + 100 ms 超、
確認を待たずに始まる場合がある) に合わせた。

検証: `statsSnapshot` の単体テストで `decodeLagMs` と `limitMs` が JSON に出ること、既存の値が変わらない
ことを固定した。`vp check` / `tsc --noEmit` / `vp test run` が通る。
