# moqt-devtools の jitter buffer が配信 fps と表示周期が近いとき表示時刻を過ぎた 2 枚の古い方を捨て、表示が飛ぶ

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-jitter-buffer-drops-at-display-rate
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の subscriber の jitter buffer (`devtools/src/utils/playoutBuffer.ts`) は、requestAnimationFrame ごとに表示時刻を過ぎたフレームのうち最新を描き、それより古いものを捨てる。配信 fps と表示周期が近い (120 fps の配信を 120 Hz で表示するなど) と、表示時刻と requestAnimationFrame の位相のわずかな揺れで、ある周期に 2 枚が表示時刻を過ぎ、次の周期には 1 枚も無いことが繰り返される。そのたびに 1 枚を捨てて次の周期は何も描かないため、表示が飛ぶ。

実測 (2026-09-25、配備 devtools + 配備 relay、320x240 / 120 fps、headless Chromium の requestAnimationFrame は 120 Hz、25 秒):

- jitter buffer 有効: 表示間隔 p95 18.7 ms、止まり (フレーム間隔の 1.5 倍超) 394 回 / 8171 ms、間に合わずに捨てた数 368
- jitter buffer 無効: 表示間隔 p95 16.7 ms、止まり 184 回 / 3576 ms

## 現状

- `PlayoutBuffer.select` は先頭から表示時刻を過ぎたフレームの最後 (最新) を描き、それより前をすべて捨てる

## 設計方針

- 表示時刻を過ぎたフレームが 2 枚以上あるときは、最新の 1 枚を次の選択に残し、その 1 つ前を描き、それより古いものを捨てる。表示は最大 1 フレーム遅れるが、位相の揺れで 2 枚が重なった周期と空の周期が続いても、両方の周期で 1 枚ずつ描ける
- 遅れが 1 フレームを超えて溜まる (3 枚以上が表示時刻を過ぎる) ときは、従来どおり古いものを捨てて追いつく
- 30 fps を 120 Hz で表示する場合など、1 周期に 1 枚しか表示時刻を過ぎない場合の挙動は変えない

## 完了条件

- 配信 fps と表示周期が同じで位相が揺れる到着列で、フレームを捨てずに全周期で 1 枚ずつ描くことを単体テストで固定する
- 3 枚以上が表示時刻を過ぎたときは、最新を残してその 1 つ前を描き、それより古いものを捨てることを単体テストで固定する
- 既存の PBT (並べ替えない、表示時刻より前に描かない、表示間隔が TIMESTAMP の間隔どおり) が通る
- 配備した devtools で、120 fps の配信の止まりと捨てた数が jitter buffer 無効と同程度以下になることを確かめる
- `vp check` と全テストが通る
