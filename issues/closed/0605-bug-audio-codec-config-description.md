# AAC の AudioSpecificConfig を運べるようにする

- Created: 2026-09-14
- Completed: 2026-09-14
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

## 解決方法

AAC の AudioSpecificConfig をエンコーダーの metadata から取り出し、`AUDIO_CONFIG` (draft-ietf-moq-loc-04 §2.3.3.1) として送り、受信側で `AudioDecoderConfig.description` に渡す経路を通した。

### 送信側

- `AudioEncodedChunkData` に `description?: Uint8Array` を追加した
- `AudioEncoderWrapper` (直接 / Worker 両モード) が `EncodedAudioChunkMetadata.decoderConfig.description` を取り出して運ぶ。Worker の応答型 (`AudioEncoderWorkerEncodedResponse`) にも `description?: ArrayBuffer` を追加し、transfer list に載せる
- `createMediaPublisher.handleAudioEncodedChunk` が `AUDIO_CONFIG` として送る。映像の `VIDEO_CONFIG` と同じく、同じ値は再送しない (`isSameAudioConfig`)

### 受信側

- `getAudioDecoderConfig` に description を追加し、AAC のときだけ `AudioDecoderConfig.description` に載せる
- `AudioDecoderWrapper.configure(codec, sampleRate?, channels?, description?)` に追加 (Worker モードの init メッセージにも載る)
- `createMediaSubscriber` が Track Property (`SUBSCRIBE_OK`) の `AUDIO_CONFIG` を初期設定として渡し、Object Property の `AUDIO_CONFIG` が変化したら映像経路と同じ手順 (`isSameAppliedAudioConfig` / `reconfigureAudioDecoder`) で再構成する。再構成中は decode に渡さない

### opus の扱い (issue には無かった判断)

Chromium の opus encoder は 19 バイトの OpusHead 相当を `description` として返す。実ブラウザで確認したところ、これをデコーダーへ渡すと **復号 timestamp が変わる** (codec delay / pre-skip の適用により 2 件目以降の timestamp が投入値と一致しなくなる) ため、opus では description を運ばない判断にした (`requiresAudioSpecificConfig`)。issue の完了条件「opus の既存挙動が変わらないこと」を満たすための措置であり、e2e テストで「opus の chunk は description を持たない」ことを pin している。受信側も、仮にピアが opus の `AUDIO_CONFIG` を送ってきても無視する。

### 検証

- `vp test run`: 98 ファイル / 2,185 テスト全通過 (追加 8 件: `getAudioDecoderConfig` の description 3 件、`handleAudioEncodedChunk` の `AUDIO_CONFIG` 4 件、`requiresAudioSpecificConfig` 1 件)
- `npx playwright test`: 16 件全通過。opus の chunk が description を運ばないことと、音声の encode / decode が従来どおり動くことを実 Chromium で確認した
- `vp check` / `tsc --noEmit` 通過、devtools の型エラーは既存の 11 件のまま
- AAC の実エンコードは CI の Chromium に AAC エンコーダーが無いため e2e では検証できない (実測で `isConfigSupported` は true を返すが `encode()` は `EncodingError` になる)。送受信の経路は `config` / `createMediaPublisher` の単体テストで検証している
- `CHANGES.md` の `## develop` に `[FIX]` を追加した
