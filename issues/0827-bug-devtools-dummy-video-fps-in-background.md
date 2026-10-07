# moqt-devtools のダミー映像がタブを裏に回すと 1 fps になる

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-dummy-video-fps-in-background
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の publisher で映像入力をダミー映像にすると、タブを裏に回した瞬間に配信の fps が 1 になる。Chromium は hidden なページの main thread のタイマーを 1 秒間隔に絞り (Chrome 88 以降は 5 分以上 hidden で 1 分間隔)、`createDummyVideoStream` の「1 コールバック = 1 フレーム」がそのまま 1 fps になる。バックグラウンドで配信を続けられない。

## 現状

- `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` の `createDummyVideoStream` は canvas と `captureStream(0)` のトラックを作り、`scheduleNextFrame` が main thread の `window.setTimeout` で次の描画時刻を決める。1 回のコールバックで 1 枚描き、`requestFrame()` でトラックへ流す
- `nextDummyFrame` が「最初のフレームを描いた時刻 + n × フレーム間隔」で次に描くフレームを決めるため、タイマーが遅れても間隔は積み上がらない。ただし 1 コールバック 1 枚の関係は変わらない
- 同じ関数を moqt-devtools の publisher (`devtools/src/hooks/usePublisher.ts` の映像入力) と webcodecs-devtools (`devtools/src/webcodecs-devtools/signals.ts`) が使う
- 実測 (Chromium 153 / macOS / CDP の `Target.createTarget` に `background: true` を渡して作った hidden タブ / 30 fps 設定 / `canvas.captureStream(0)` + `requestFrame()` のフレームを `MediaStreamTrackProcessor` で数える)
  - 前面のタブ: 30.0 fps
  - 裏のタブ: 0.8 fps
  - hidden なタブの main thread の `setTimeout` / `setInterval`: 1.2 回/秒
  - hidden なタブの Dedicated Worker の `setTimeout`: 30.1 回/秒
  - hidden なタブの worker → main thread の `postMessage` 配送: 30.1 回/秒
  - hidden なタブの Dedicated Worker の `requestAnimationFrame`: 0 回/秒
- エンコード、送信、音声はタイマー駆動ではないため、この 1 fps はダミー映像のフレーム供給だけが原因である
- `issues/closed/0722-bug-devtools-dummy-video-frame-skip.md` は可視状態で main thread のタイマーが揺れる問題であり、今回の hidden での絞り込みとは別である

## 設計方針

- 時計だけを Dedicated Worker のタイマーへ移す。worker が次のフレームの時刻を決めて tick を `postMessage` し、main thread が今までどおり描いて `requestFrame()` する
- worker は `nextDummyFrame` の間隔計算 (開始時刻 + n × フレーム間隔、1 周期以上過ぎたら飛ばす) をそのまま使う。`setInterval` はコールバックの実行時間の分だけ間隔が伸びて累積するため使わない
- `OffscreenCanvas` と `transferControlToOffscreen` は使わない。worker の `requestAnimationFrame` は hidden で止まるため時計にならず、canvas を transfer すると main thread が描けなくなる (`captureStream` のトラックも作れない)。描画コストは main thread に残るが、hidden では main thread は空いている
- tick には予定した絶対時刻 (`performance.timeOrigin + performance.now()`) を載せる。`performance.timeOrigin` は window と worker で同じ値ではないため、worker の時刻は絶対時刻へ変換して渡す
- main thread は予定から 1 周期以上過ぎた tick を捨てる。main thread が塞がれたときに tick がまとめて届き、復帰後に `requestFrame()` が連続する (フレームがバーストする) のを防ぐ
- worker のモジュールは `devtools/src/webcodecs-devtools/workers/` の既存の配置と `new URL("./workers/x.worker.ts", import.meta.url)` の作り方に合わせる
- コードのコメントに根拠を残す。hidden では main thread のタイマーが 1 秒間隔に絞られること、Chromium の `BlinkSchedulerWorkerThrottling` が既定無効であるため worker のタイマーは絞られないこと、タブが freeze されると worker のタイマーも止まり (HTML の "worker is not suspended" 条件) 対象外であること
- `nextDummyFrame` は純関数のまま残し、worker は薄いラッパーにする (Node の vitest で検証できない面積を増やさない)

## 完了条件

- タブを裏に回しても、ダミー映像のフレーム供給が設定した framerate を維持する (hidden タブで 30 fps 設定のときに 30 fps 程度であることを実測で示す)
- 前面に戻したときも同じ framerate を維持する
- `stop()` で worker が停止し、フレーム供給が止まる
- main thread が塞がれたときにフレームがバーストしない (予定から 1 周期以上過ぎた tick を捨てる)
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る
- `CHANGES.md` の `## develop` に `[FIX]` として記載する

## 参照

- `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` の `createDummyVideoStream` / `nextDummyFrame` / `scheduleNextFrame`
- `devtools/src/webcodecs-devtools/utils/dummyVideo.test.ts` / `dummyVideo.prop.ts`
- `devtools/src/hooks/usePublisher.ts` / `devtools/src/webcodecs-devtools/signals.ts` の `createDummyVideoStream` 呼び出し
- Chromium の `third_party/blink/renderer/platform/scheduler/common/features.h` の `kDedicatedWorkerThrottling` (既定無効) と `third_party/blink/renderer/platform/scheduler/worker/worker_scheduler_impl.cc` の `SetUpThrottling` / `OnLifecycleStateChanged`
- HTML Standard の timers (`run steps after a timeout` の "worker is not suspended") と Chrome の throttling 解説 (https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- `issues/closed/0722-bug-devtools-dummy-video-frame-skip.md` (可視状態のタイマーの揺れ。今回とは別)

## 解決方法

{未着手}
