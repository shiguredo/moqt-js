# playout の押し直しで currentTime を読んだ後に再コピーして再追い越しするのを直す

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/fix-playout-audio-correctness
- Polished: {YYYY-MM-DD}

## 目的

`AudioPlayoutSession.startBuffer` は `currentTime` を読んで押し直しを決めた後に、フェード版の
全チャンネル再コピーを行ってから `source.start` する。この再コピー中に 3 ms を超える停止が
あると、押し直した時刻を再び追い越して即時開始になり、直前の音と重なってクリックになる。
docs は「押し直しで重なりは起きない」と断言しているが、その保証がない。

## 現状

- `src/playout/audioPlayoutSession.ts` の `startBuffer` の手順は、素のサンプルをコピー →
  `currentTime` を読む → 押し直しなら `fadeSpliceEdge` と再コピー → `start` である
- 再コピーは `currentTime` の読み取り後にあり、この区間の停止が考慮されていない
- 押し直しの計器 `pushStartCount` / `pushStartMaxMs` はこの 1 回の分岐で記録している

## 設計方針

- 押し直しの判定とフェードの準備を `currentTime` の取得より前に済ませ、取得した後は
  `start` だけにする
- やむを得ず取得後にコピーが必要な場合は、コピーの後にもう一度 `currentTime` を取り直し、
  必要なら開始時刻を再調整する (バッファのコピーはやり直さない)。計器の押し直し量は
  最終的な値で 1 回だけ記録する
- 単体テストで、`currentTime` の読み取りから `start` までの間に時計を進めても、開始時刻が
  過去にならないことを固定する

## 完了条件

- `startBuffer` が `currentTime` 取得後に重い処理を挟まないこと
- 単体テストで再追い越しが起きないこと、計器が二重計上しないことを固定する
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

`AudioPlayoutSession.startBuffer` の押し直しから、`currentTime` を読んだ後に重い処理を挟む競合を
取り除いた。押し直しが不要なときは素のコピー後に直ちに `start` する。押し直すときはフェード版の
コピー後にもう一度 `currentTime` を取り直し、開始時刻を「今 + 余裕」へ再調整してから `start` する
(バッファのコピーはやり直さない)。押し直しの計器は最終的な値で 1 回だけ記録する。

検証: `copyToChannel` 中に時計を 12 ms 進める注入で、再コピー中に停止しても開始時刻が過去にならず、
次のバッファと重ならず、`lateStart` / `pushStart` が二重計上しないことを単体テストで固定した
(旧実装では失敗することを確認済み)。property テストにもコピー中の時計前進を追加した。
`vp check` / `tsc --noEmit` / `vp test run` が通る。
