# 同一ファイル内でのみ使う AudioPlayoutOptions の export を外す

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-unexport-audio-playout-options
- Polished: 2026-10-01

## 目的

公開面を実際の利用範囲に合わせる。`src/audioPlayout.ts` の中でしか使っていない型が export されており、外部から使える API のように読める。未使用の export を除去する先例 (0390) と同じ整理をする。

## 現状

- `AudioPlayoutOptions` は `src/audioPlayout.ts` の定義と、同ファイルの `AudioPlayoutScheduler` のコンストラクタ引数でのみ使われている
- `src/index.ts` へは輸出されておらず、`devtools/` / `tests/` / `examples/` からの参照も無い
- 同じファイルの他の定数・関数は本体やテストから参照されている

## 設計方針

- `export` 修飾子を外す。挙動は変えない
- 同じファイルに同種の未使用 export が他に無いことを確認する
- 先例 (0390) に従い、CHANGES.md の `## develop` の `### misc` に [CHANGE] エントリを追記する (シンボルの公開を狭める変更のため)

## 完了条件

- `rg -w AudioPlayoutOptions src devtools tests` の一致が、`src/audioPlayout.ts` のインターフェース定義と `AudioPlayoutScheduler` のコンストラクタ引数の 2 件だけになること (外部からの参照が無いこと)
- `CHANGES.md` の `### misc` に [CHANGE] エントリがあること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
