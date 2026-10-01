# moqt-devtools の補間の予約に単体テストを追加する

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-concealment-test
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の音声の補間は `devtools/src/hooks/useSubscriber.ts` の `scheduleConcealment` で `AudioBufferSourceNode` として予約されるが、自動テストが無い。引数が `gapStartSeconds` / `gapSeconds` の 2 つとも `number` であるため、取り違えても型では検出できない。ライブラリ側は `src/createMediaSubscriber.test.ts` が予約時刻とバッファ長を固定しており、devtools 側にも同じ網を張る。

## 現状

- `scheduleConcealment` は非 export で、`handleAudioDecoded` からのみ呼ばれる
- `devtools/src/hooks/useSubscriber.test.ts` は export された純関数しか駆動しておらず、`handleAudioDecoded` の予約は検証していない
- `tests/e2e/devtools-audio.spec.ts` は音声要素の状態を見るだけで、補間の予約は見ていない
- ライブラリ側は `control.audioPlayout` を駆動し、補間の開始時刻と長さをテストで固定している

## 設計方針

- テストから駆動できるよう `scheduleConcealment` を export する (テスト専用の別関数を作らない)
- `AudioPlayback` の最小オブジェクト (`createBuffer` / `createBufferSource` / `start` を記録する実物) を渡し、開始時刻・バッファ長・戻り値 (補間した秒数) を固定する。モックフレームワークは使わない
- `previousChannels` が null のときと、相関が足りない音で 0 を返すことを固定する
- 引数を入れ替えたときにテストが失敗することを確かめる

## 完了条件

- 補間の開始時刻と長さ、補間できなかったときの 0 をテストで固定すること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
