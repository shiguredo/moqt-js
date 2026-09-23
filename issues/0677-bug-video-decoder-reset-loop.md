# ライブラリ側の映像デコーダが恒久エラーで Worker を再生成し続ける

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-decoder-reset-loop
- Polished: {YYYY-MM-DD}

## 目的

`src/codec/VideoDecoder.ts` の `reset()` は上限なく `lastConfig` で再 configure する。`src/createMediaSubscriber.ts` は映像デコーダの error コールバックから `reset()` を呼ぶため、恒久的に復号できない codec やストリームでは error → reset → configure → error が止まらず、Worker の生成と破棄が繰り返される。devtools 側は 0651 で非対応 codec の事前確認と復帰予算を入れるが、ライブラリ側には同等の上限が無い。

## 現状

- `src/codec/VideoDecoder.ts` の `reset()` は `lastConfig` を確認したうえで世代を無効化し、Worker または `VideoDecoder` を作り直して `configureWorker` / `configureDirect` を無条件に呼び、`configured = true` にする。試行回数の上限も、復号フレームの出力で予算を戻す仕組みも無い
- `src/createMediaSubscriber.ts` の `setupDecoders` が `VideoDecoderWrapper` を組み立てる error コールバックは `this.callbacks.onError?.(error)` の後に `void this.videoDecoder?.reset()` を呼ぶ
- `src/codec/VideoDecoder.ts` の `reset()` は失敗を `callbacks.error` に流さず reject する。呼び出しは `void` のため、reject が未処理になる。この扱いは 0657 が対象とする
- `devtools/src/utils/DecoderWrapper.ts` は 0651 で `VideoDecoder.isConfigSupported` の事前確認と復帰予算を入れる。ライブラリ側の `src/codec/VideoDecoder.ts` には事前確認も予算も無い
- 恒久エラーの実測は 0651 に記録がある (ヘッドレス Chromium で 3 秒間に 890 回前後の再生成)。`createMediaSubscriber` は同じ `VideoDecoderWrapper` を使うため同じ経路を通る

## 設計方針

- 0651 と同じ 2 段の対策をライブラリ側にも入れる
  - configure の前に `VideoDecoder.isConfigSupported(config)` を確認し、false と throw の両方を非対応として扱う
  - 復帰の上限を入れる。復号フレームを 1 枚も出力しないまま連続 3 回まで再初期化し、1 枚でも出力したら回数を 0 に戻す
- 上限の管理は 0651 と同じく純粋クラスとして切り出し、Node の単体テストで固定する (`src/codec/workerConfigure.ts` の `ConfigureGenerationTracker` と同じ方針)
- `reset()` は上限到達時に Worker もデコーダーも作り直さず、理由を `callbacks.error` へ流す。利用者が `onError` から判別できるようにする
- 事前確認で非対応と判明した場合は configure 自体を行わず、`configured = false` のままエラーにする
- 0657 が扱う reject の伝搬は本 issue の対象外とし、再生成の停止だけを扱う
- devtools 側の 0651 と同じ閾値・同じ復帰条件に揃える

## 完了条件

- 非対応 codec (`isConfigSupported` が false を返す、または throw する codec 文字列) では Worker も `VideoDecoder` も作らず、明示的なエラーになる
- 復号フレームを得ないまま再初期化が続く場合、3 回で打ち切られて Worker の再生成が止まる
- 一時的な decode エラーからの復帰 (再初期化 1 回で復号が再開する場合) の挙動が変わらない
- 上限と復帰のカウンタの挙動が Node の単体テストで固定される
- `src/createMediaSubscriber.test.ts` に、恒久エラーで再生成が打ち切られ `onError` が通知されることが固定される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0651 (devtools 側の同型欠陥。ライブラリ側が本 issue)
- 0657 (高レベル API の送信 reject の伝搬。本 issue は再生成の停止のみを扱う)
- `src/codec/VideoDecoder.ts` の `reset` / `src/createMediaSubscriber.ts` の `setupDecoders` / `src/codec/workerConfigure.ts`

## 解決方法

{未着手}
