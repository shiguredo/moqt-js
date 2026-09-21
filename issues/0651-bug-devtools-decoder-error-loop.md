# devtools で非対応 codec を選ぶと Worker の再生成が繰り返される

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-decoder-error-loop
- Polished: {YYYY-MM-DD}

## 目的

devtools の購読側には codec の対応確認が無く、非対応 codec (codec 選択に h265 がある) を選ぶと Worker の生成と破棄が繰り返される。`VideoDecoder.configure` は非対応設定でも同期 throw せず非同期の error を返すため、configure 成功の通知が先に届くことが原因である。ループを止め、利用者にエラーを表示する。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `DecoderWrapper` 生成時の `error` コールバックは `instance.decodeErrors.value` を増やして `decoderInstance.reset()` を呼ぶ
- `devtools/src/utils/DecoderWrapper.ts` の `reset` は `teardown()` で `worker.terminate()` したうえで `configure(this.lastConfig)` を呼び、`configureWorker` が `new DecoderWorker()` で新しい Worker を作る
- `devtools/src/webcodecs-devtools/workers/decoder.worker.ts` の `init` ハンドラは `decoder.configure(message.config)` の直後に `configured` を返す。非同期の error はその後に `error` として届く
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` は Catalog の codec から config を作るだけで `VideoDecoder.isConfigSupported` を呼ばない。devtools で `isConfigSupported` を使うのは `devtools/src/hooks/usePublisher.ts` と `devtools/src/webcodecs-devtools/signals.ts` だけである
- `devtools/src/components/ConnectionSettings.tsx` の codec 選択に h265 がある

## 設計方針

- `configure` の前に `VideoDecoder.isConfigSupported` で対応を確認し、非対応なら Worker を作らずにエラーを利用者へ伝える
- error の再入で `reset()` を繰り返さないよう、再試行回数の上限か同一 config での再試行禁止を入れる
- 利用者に見える形でエラーを出す。`instance.statusMessage` など既存の表示経路を使い、`decodeErrors` のカウントだけにしない
- Worker 側で `configure` の非同期 error を待ってから `configured` を返せるかも併せて検討する

## 完了条件

- 非対応 codec で Worker の再生成ループが止まる
- 非対応であることが利用者に表示される
- `devtools/src/utils/DecoderWrapper.test.ts` などで固定される
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
