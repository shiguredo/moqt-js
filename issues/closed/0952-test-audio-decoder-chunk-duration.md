# 音声の直接復号経路が chunk に duration を載せないことを単体テストで固定する

- Created: 2026-11-10
- Completed: 2026-11-10
- Branch: feature/test-audio-decoder-chunk-duration
- Polished: 2026-11-10

## 目的

`AudioDecoderWrapper` は復号へ渡す `EncodedAudioChunk` に `duration` を載せない。しかし `AudioData.duration` は chunk の `duration` を使わず復号結果のフレーム数とサンプルレートから求まる (W3C WebCodecs 9.2.3 Attributes) ため、e2e の `AudioData.duration` の検査では chunk への再混入を検出できない。Wrapper の境界を置き換えた単体テストで、chunk の `duration` が `null` であることを直接固定する。

## 現状

- `src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode` は直接モードで `new EncodedAudioChunk({ type, timestamp: timestamp ?? 0, data })` を作り、`duration` を載せない。Worker モードは `AudioDecoderWorkerDecodeRequest` から `duration` が消えており、Worker 側の `new EncodedAudioChunk(...)` も載せない
- `src/codec/AudioDecoder.test.ts` は存在しない。`src/codec/VideoDecoder.test.ts` は `withVideoDecoder` で `globalThis.VideoDecoder` を置き換え、生成・configure・close を記録している
- Node には WebCodecs が無い。`globalThis.EncodedAudioChunk` も `globalThis.AudioDecoder` も存在しないため、`AudioDecoderWrapper.decode` の `new EncodedAudioChunk(...)` はテスト環境では `ReferenceError` になる。置き換える境界は `AudioDecoder` だけでは足りない
- `src/testSupport/helpers.ts` の `withGlobalValue` が受け付ける名前は `"VideoDecoder" | "AudioEncoder" | "AudioData"` の閉じた union であり、`AudioDecoder` / `EncodedAudioChunk` を置き換える手段が無い
- `src/codec/codecLifecycle.ts` の `isCodecConfigured` は `codec.state === "configured"` を要求する。置き換える `AudioDecoder` に `state` が無いと `decode()` まで到達しない
- `EncodedAudioChunkInit.duration` は省略可能なため、Wrapper 内部に `duration: 0` を書き戻しても型では止まらない
- e2e の `expectAudioDecoderContract` は `AudioData.duration` と timestamp を検査するが、chunk の `duration` は見ていない
- Worker モードの chunk は `AudioDecoderWorkerDecodeRequest` が守るのは Wrapper → Worker のメッセージだけで、Worker 内の `new EncodedAudioChunk(...)` に `duration: 0` を足しても型では止まらない。Worker 経路の chunk はどのテストでも固定されていない

## 設計方針

- `src/testSupport/helpers.ts` の `withGlobalValue` の名前 union (`name` と `Record` のキー) に `"AudioDecoder"` と `"EncodedAudioChunk"` を足し、`withAudioDecoder` と `withEncodedAudioChunk` を `withVideoDecoder` と同じ形で追加する
- 置き換える `EncodedAudioChunk` は、W3C WebCodecs 8.1.2 Constructors の「`init.duration` があればそれを、無ければ `null` を `[[duration]]` に入れる」を実装する (`duration: init.duration ?? null`)。`0` を `null` に変換しないため、`duration: 0` を書き戻した実装を検出できる。`timestamp` と `type` も保持し、受け取った `init` を記録する
- 置き換える `AudioDecoder` は `state = "configured"` を持ち、`configure()` / `decode(chunk)` (受け取った chunk を記録) / `close()` を持つ。`src/codec/VideoDecoder.test.ts` の fake と同じ形にする
- `src/codec/AudioDecoder.test.ts` を新設し、`withEncodedAudioChunk` と `withAudioDecoder` を入れ子にして `AudioDecoderWrapper` の直接モードを構成し、`decode()` に渡した chunk の `duration` が `null` であることを固定する。`timestamp` が渡した値になり、`type` が `"key"` になることも併せて確かめる
- 直接モード (useWorker が false) だけを対象にする。Worker モードは Wrapper → Worker のメッセージに `duration` が無いことを型が守るが、Worker 内の chunk への再混入は型でもテストでも守られていない。この issue では固定せず、その事実を残す (必要なら別 issue)

### 対象外

- Worker 側 (`src/codec/workers/audioDecoder.worker.ts`) の chunk を単体で固定すること。メッセージ境界の型と Worker の実装は現行のままとする
- `AudioDecoderWrapper.reset()` (追いつきの作り直し)。reset 予算は `AudioDecoderWrapper` には無く、この issue では扱わない
- `globalThis.AudioDecoder` を手書きで置き換えている既存テスト (`src/createMediaSubscriber.playout.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts`) を新しい helper へ寄せること

## 完了条件

- `src/codec/AudioDecoder.test.ts` に、`AudioDecoderWrapper` の直接モードが復号へ渡す `EncodedAudioChunk` の `duration` が `null` であることを固定するテストがあること。`timestamp` と `type` も併せて固定すること
- 置き換えた `EncodedAudioChunk` が `duration: 0` を `null` に変換しないこと (この性質がないと、`duration: 0` を書き戻してもテストが通ってしまう)
- `src/testSupport/helpers.ts` に `withAudioDecoder` と `withEncodedAudioChunk` があり、テストの終了時に `globalThis.AudioDecoder` / `globalThis.EncodedAudioChunk` が元に戻ること
- 現行実装でテストが通り、`src/codec/AudioDecoder.ts` の直接モードの chunk 生成に `duration: 0` を手で書き戻すとテストが失敗することを確認すること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

`AudioDecoderWrapper` の直接モードが復号へ渡す `EncodedAudioChunk` の契約を、境界を置き換えた単体テストで固定した。

- `src/testSupport/helpers.ts` の `withGlobalValue` の名前 union に `"AudioDecoder"` と `"EncodedAudioChunk"` を足し、`withAudioDecoder` / `withEncodedAudioChunk` を追加した。Node には WebCodecs が無いため、`AudioDecoderWrapper.decode` の `new EncodedAudioChunk(...)` を置き換えないと復号器の呼び出しまで到達しない
- `src/codec/AudioDecoder.test.ts` を新設した。`EncodedAudioChunk` の代役は W3C WebCodecs 8.1.2 Constructors の「`init.duration` があればそれを、無ければ `null` を入れる」を実装し、`0` を `null` に変換しない。`AudioDecoder` の代役は `state = "configured"` を持ち、`decode()` で受け取った chunk の `type` / `timestamp` / `duration` を記録する
- テストは 2 件ある。`timestamp` が非 null のときと `null` のとき (chunk の timestamp が 0 になる既存の契約) に、`duration` が `null` であることを固定する
- `src/codec/AudioDecoder.ts` の直接モードの chunk 生成に `duration: 0` を手で書き戻すと、2 件とも `duration` が `0` になって失敗することを確認した
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` / `vp test run` (277 ファイル、5075 テスト) が通る

Worker モードは Wrapper → Worker のメッセージに `duration` が無いことを型が守るが、Worker 内の chunk への再混入は型でもテストでも守られていない。この issue では固定していない。

`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (`CODEBASE.md` の特別ルール)。

## 参照

- W3C WebCodecs (Working Draft 2026-11-09) の 8.1.2 Constructors、9.2.3 Attributes、3.6 Algorithms
- `src/codec/AudioDecoder.ts` の `AudioDecoderWrapper.decode`、`src/codec/codecLifecycle.ts` の `isCodecConfigured`
- `src/codec/workerMessages.ts` の `AudioDecoderWorkerDecodeRequest`、`src/codec/workers/audioDecoder.worker.ts`
- `src/codec/VideoDecoder.test.ts` と `src/testSupport/helpers.ts` の `withGlobalValue` / `withVideoDecoder`
- `tests/e2e/codec-wrappers.spec.ts` の `expectAudioDecoderContract`
