# AAC の AudioSpecificConfig を運べるようにする

- Created: 2026-09-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-codec-config-description
- Polished: {YYYY-MM-DD}

## 目的

`AudioCodecType` は `"opus" | "aac"` を公開し `getAudioEncoderConfig` は `aac` を `mp4a.40.2` に対応させているが、AAC の復号に必須の AudioSpecificConfig (WebCodecs の `AudioDecoderConfig.description`) を運ぶ経路が無い。AAC を選択・受信すると復号できないため、経路を用意する。

## 現状

- `AudioEncoderWrapper` の output コールバックは `EncodedAudioChunk` のみを受け取り (`src/codec/AudioEncoder.ts` の `configureDirect` と `src/codec/workers/audioEncoder.worker.ts`)、`EncodedAudioChunkMetadata` を捨てている。映像側 (`VideoEncoderWrapper`) は `metadata.decoderConfig.description` を `EncodedChunkData.description` として運ぶ。
- `AudioEncodedChunkData` (`src/codec/types.ts`) に `description` フィールドが無い。
- `AudioDecoderWrapper.configure(codec, sampleRate?, channels?)` (`src/codec/AudioDecoder.ts`) は `description` を受け取らない。`VideoDecoderWrapper.configure` は `description` を受け取る。
- 実ブラウザ (Playwright Chromium) で `AudioEncoder.isConfigSupported({ codec: "mp4a.40.2" })` は true を返すが、実際の `encode()` は非同期で `EncodingError` になる。`isConfigSupported` だけでは AAC の可否を判定できない。
- `src/createMediaPublisher.ts` の音声経路は `AudioEncodedChunkData` をそのまま送るため、description を送る余地が無い。

## 設計方針

1. `AudioEncodedChunkData` に `description?: Uint8Array` を追加し、`AudioEncoderWrapper` (直接 / Worker 両モード) が `EncodedAudioChunkMetadata.decoderConfig.description` を運ぶ。
2. `AudioDecoderWrapper.configure` に `description?: Uint8Array` を追加し、`AudioDecoderConfig.description` へ渡す。Worker モードの `init` メッセージにも載せる。
3. `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` の音声経路で description を素通しする (受信側は Track Property の `AUDIO_CONFIG` 等、既存の映像経路と同じ扱いにする)。
4. AAC の可否判定は `isConfigSupported` だけに頼らず、実際の encode 失敗 (error コールバック) も扱う。
5. 実ブラウザでの検証は `tests/e2e/codec-wrappers.spec.ts` の音声テストに追加する。

## 完了条件

- AAC で encode した chunk の description が送信側から受信側の decoder 設定まで届くこと。
- opus の既存挙動が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` / e2e が通ること。

## 関連

- `src/codec/AudioEncoder.ts` / `src/codec/AudioDecoder.ts` / `src/codec/workers/audioEncoder.worker.ts` / `src/codec/workers/audioDecoder.worker.ts` / `src/codec/types.ts`
- `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts`
- `tests/e2e/codec-wrappers.spec.ts` (0495 で追加した実ブラウザテスト)
