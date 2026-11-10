# 音声の復号経路が chunk に duration を載せないことを単体テストで固定する

- Created: 2026-11-10
- Completed: {YYYY-MM-DD}
- Branch: feature/test-audio-decoder-chunk-duration
- Polished: {YYYY-MM-DD}

## 目的

`AudioDecoderWrapper` は復号へ渡す `EncodedAudioChunk` に `duration` を載せない。しかし `AudioData.duration` は chunk の `duration` を使わず復号結果のフレーム数とサンプルレートから求まる (W3C WebCodecs 9.2.3 Attributes) ため、e2e の `AudioData.duration` の検査では chunk への再混入を検出できない。Wrapper の境界を置き換えた単体テストで、chunk の `duration` が `null` であることを直接固定する。

## 現状

- `src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode` は直接モードで `new EncodedAudioChunk({ type, timestamp, data })` を作り、`duration` を載せない。Worker モードは `WorkerDecodeRequest` から `duration` が消えており、Worker 側も載せない
- `src/codec/AudioDecoder.test.ts` は存在しない。`src/codec/VideoDecoder.test.ts` は `withVideoDecoder` で `globalThis.VideoDecoder` を置き換え、生成・configure・close を記録している
- `EncodedAudioChunkInit.duration` は省略可能なため、Wrapper 内部に `duration: 0` を書き戻しても型では止まらない
- e2e の `expectAudioDecoderContract` は `AudioData.duration` を検査するが、この値は chunk の duration に依存しないため、再混入を検出できない

## 設計方針

- `src/testSupport/helpers.ts` に `withAudioDecoder` を足す (`withVideoDecoder` と同じ `withGlobalValue` の薄いラッパー)
- `src/codec/AudioDecoder.test.ts` を新設し、置き換えた `AudioDecoder` が `decode()` で受け取った `EncodedAudioChunk` の `duration` が `null` であることを固定する。`timestamp` が載ることと `type` が渡した値になることも併せて確かめる
- 直接モード (useWorker が false) だけを対象にする。Worker モードの chunk は `WorkerDecodeRequest` の型で守られており、Worker 側の実装は e2e の実ブラウザ経路で動く
- 置き換える `AudioDecoder` は `decode()` を呼ばれた時点で `EncodedAudioChunk` を受け取り、その `duration` / `timestamp` / `type` を記録する。`configure()` と `close()` は何もしない

### 対象外

- `AudioDecoderWrapper` の reset 予算の挙動 (既存の e2e と実装が担う)
- Worker 側 (`src/codec/workers/audioDecoder.worker.ts`) の chunk を単体で固定すること

## 完了条件

- `src/codec/AudioDecoder.test.ts` に、`AudioDecoderWrapper` の直接モードが復号へ渡す `EncodedAudioChunk.duration` が `null` であることを固定するテストがあること。`duration: 0` を書き戻すと失敗すること
- `src/testSupport/helpers.ts` に `withAudioDecoder` があり、テストの終了時に `globalThis.AudioDecoder` が元に戻ること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- W3C WebCodecs (Working Draft 2026-11-09) の 8.1.2 Constructors、9.2.3 Attributes、3.6 Algorithms
- `src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode`
- `src/codec/VideoDecoder.test.ts` と `src/testSupport/helpers.ts` の `withVideoDecoder`
