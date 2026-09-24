# moqt-devtools の dummy の映像が設定より速い周期で描かれ、約 3.3 秒ごとに 1 フレーム抜けて受信側で止まる

- Created: 2026-09-25
- Completed: 2026-09-25
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

## 解決方法

- `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` に `nextDummyFrame` を足した。フレーム n を描く時刻を「最初のフレームを描いた時刻 + n × 1000 / framerate」とし、次に描くフレームの番号と待つ時間を返す。1 周期未満の遅れは待たずに描いて追いつき、1 周期以上遅れたら過ぎたフレームを飛ばして、まだ来ていない最初のフレームを次に描く
- `createDummyVideoStream` は `setInterval` をやめ、`nextDummyFrame` で決めた時間だけ `setTimeout` で待って描く。取り出しは `canvas.captureStream(0)` で自動の取り出しを止め、描くたびに `CanvasCaptureMediaStreamTrack.requestFrame()` で 1 枚取り出す。トラックが `requestFrame` を持たなければ例外にする。`stop` は予約した描画を取り消し、発火済みのタイマーからも次を予約しない
- テスト
  - `dummyVideo.test.ts`: 時刻どおり、遅れを積み上げないこと、1 周期未満の遅れで追いつくこと、1 周期以上の遅れで飛ばすこと、開始の時刻からの経過で決めること
  - `dummyVideo.prop.ts`: 1 から 120 fps で、タイマーの遅れがフレーム間隔未満ならフレームを飛ばさず、フレーム n を描く時刻が「開始 + n × 間隔」から遅れの上限までに収まること (ずれが積み上がらない)。遅れが任意の大きさでも、番号は増え、待つ時間は負にならず、次のフレームの時刻が 1 周期より前にならないこと
- `vp check`、全テスト (137 ファイル / 2736 件) が通った

### ブラウザでの確認

publisher の encoder の出力の TIMESTAMP の間隔と、受信側の止まりの原因 (配備 relay、1280x720 / 2 Mbps、jitter buffer 有効):

| 版            | fps / 時間      | encoder の出力の間隔が中央値の 1.5 倍を超えた回数           | 受信側の止まり                         |
| ------------- | --------------- | ----------------------------------------------------------- | -------------------------------------- |
| 修正前 (配備) | 30 fps / 60 秒  | 約 65 ms の飛びが 99 から 100 フレームごと (前の計測の記録) | 25 回 (source 18、arrival 6、render 1) |
| 修正後 (手元) | 30 fps / 60 秒  | 1,831 フレームで 0 回 (中央値 33.29 ms)                     | 8 回 (arrival 4、render 4)             |
| 修正後 (配備) | 30 fps / 60 秒  | 1,841 フレームで 0 回 (中央値 33.30 ms)                     | 8 回 (arrival 6、render 2)             |
| 修正前 (配備) | 120 fps / 30 秒 | 3,025 フレームで 899 回                                     | 661 回 (source 655)                    |
| 修正後 (手元) | 120 fps / 30 秒 | 3,704 フレームで 32 回 (12.6 から 20.3 ms、タイマーの揺れ)  | 24 回 (render 18、source 5、loss 1)    |

30 fps では抜けが無くなり、止まりの原因の `source` は 0 になった。120 fps で残る 1.5 倍を超える間隔は、フレームの抜けではなく main thread のタイマーの揺れ (同じブラウザで publisher と subscriber の 2 ページを動かしている) による。
