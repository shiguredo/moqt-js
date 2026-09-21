# worker モードで映像エンコーダのバックプレッシャが無効になっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-encoder-backpressure
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の映像処理ループは `encoder.encodeQueueSize <= 2` のときだけ `encode` する。worker モードでは `encodeQueueSize` が常に 0 を返すため、この判定が常に真になり待ちが入らない。映像 1080p の `VideoFrame` 1 枚は NV12 で約 3.1 MB 相当であり、エンコード能力を超えた入力が続くと Worker 側のキューが無制限に伸びる。

## 現状

- `src/codec/VideoEncoder.ts` の `encodeQueueSize` getter は worker モードで「Worker モードでは直接取得できない」として 0 を返す
- `src/codec/VideoEncoder.ts` の `encode` は worker モードで `frame` を transfer して `postMessage` するだけである
- `src/codec/workers/videoEncoder.worker.ts` の `encode` ハンドラは `videoEncoder.encode()` を呼ぶだけで、キュー長を main 側へ返す経路が無い
- `src/codec/workerMessages.ts` の `VideoEncoderWorkerResponse` にキュー長を伝える応答型が無い
- `src/createMediaPublisher.ts` の `useWorker` の既定値は true のため、既定経路がこの状態になる
- `devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` も worker モードで 0 を返し、`devtools/src/hooks/usePublisher.ts` が同じ判定を使う

## 設計方針

- Worker からキュー長を受け取る仕組みを `src/codec/workerMessages.ts` に足すか、main 側で送信中のフレーム数を数えて上限を設ける
- 前者は Worker 内の `VideoEncoder.encodeQueueSize` を `encoded` 応答に載せる、または別の応答型で返し、`VideoEncoderWrapper.encodeQueueSize` を worker モードでも実値にする
- 後者は `encode` で送信数を増やし `encoded` 応答で減らす。Worker 内の実キュー長そのものではないため、上限は安全側に倒す
- 上限を超えたフレームの扱い (待つ / 落とす) を決め、統計で観測できるようにする
- 対象は `src/` 側とする。devtools 側は同じ欠陥を持つため、必要なら別 issue にする

## 完了条件

- worker モードで `encodeQueueSize` が実キュー長を返す、または送信中のフレーム数が上限を超えたら待つ (もしくは落とす)
- 上限を超えたときの挙動がテストで固定される
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
