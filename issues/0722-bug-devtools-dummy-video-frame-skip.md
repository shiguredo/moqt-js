# moqt-devtools の dummy の映像が設定より速い周期で描かれ、約 3.3 秒ごとに 1 フレーム抜けて受信側で止まる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-dummy-video-frame-skip
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の既定の映像ソース (dummy) で配信すると、受信側の映像が約 3.3 秒ごとに一瞬止まる。止まりの原因の統計 (2026-09-25、配備した devtools と配備 relay、1280x720 / 30 fps / 2 Mbps、jitter buffer 有効、60 秒) では、止まり 25 回のうち 18 回が `source` (publisher の TIMESTAMP の飛び) であり、受信側で目に見えるかくつきの主な原因になっている。

publisher の encoder の出力 (2026-09-25 の計測の記録、30 fps で約 65 秒ずつ 2 回) では、TIMESTAMP の間隔の中央値が 33.2 ms で、約 65 ms の飛び (1 フレームの抜け) が 99 から 100 フレームごとに 19 回ずつあった。

## 現状

- `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` の `createDummyVideoStream` は、canvas を `setInterval(drawFrame, Math.floor(1000 / framerate))` で描き、`canvas.captureStream(framerate)` でフレームを取り出す
- 30 fps では描く周期が 33 ms (30.3 Hz) になり、取り出す周期 (30 fps) より速い。1 フレームあたり 0.33 ms のずれが 100 フレーム (3.3 秒) で 1 フレーム分に積み上がり、そのたびに 1 フレームが取り出されない。観測した飛びの周期 (99 から 100 フレーム) と一致する
- 60 fps では 16 ms (62.5 Hz)、120 fps では 8 ms (125 Hz) になり、抜けはそれぞれ約 0.27 秒ごと、0.2 秒ごとに起きる計算になる
- moqt-devtools の publisher (`devtools/src/hooks/usePublisher.ts` の `getVideoStream`) と webcodecs-devtools (`devtools/src/webcodecs-devtools/signals.ts`) が使う

## 設計方針

- 描く時刻を、開始からの経過 (開始 + フレームの番号 × 1000 / framerate) で決め、`setTimeout` で次の時刻まで待つ。タイマーの遅れを積み上げないため、平均の周期は設定どおりになる。1 周期を超えて遅れたとき (タブが裏に回ったなど) は、遅れた分のフレームをまとめて描かずに飛ばす
- 取り出しは `canvas.captureStream(0)` で自動の取り出しを止め、描くたびに `CanvasCaptureMediaStreamTrack.requestFrame()` で 1 枚取り出す。描く周期と取り出す周期のずれで抜けることが無くなる
- 次の描く時刻の計算はブラウザ API に依存しない関数に切り出し、単体テストで固定する

## 完了条件

- 次の描く時刻の計算 (平均の周期が設定どおりであること、遅れを積み上げないこと、大きく遅れたら飛ばすこと) を単体テストと PBT で固定する
- 手元の devtools で 30 fps の dummy を配信し、publisher の encoder の出力に 1 フレームの抜け (フレーム間隔の 1.5 倍を超える TIMESTAMP の差) が無いことを確かめる
- 配備した devtools と配備 relay で 60 秒購読し、止まりの原因の `source` が 0 になることを確かめる
- `vp check` と全テストが通る
