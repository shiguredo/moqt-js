# 高レベル API がマイクの形式と違う設定で音声を符号化して配信が止まる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-audio-capture-format
- Polished: {YYYY-MM-DD}

## 目的

`examples/high-level-api` で Publisher の配信を始めると、ブラウザのログに `Input audio buffer is incompatible with codec parameters` が出て、音声が配信されない。マイクが 1 チャンネルだったり、サンプルレートが 48000 Hz 以外だったりすると、`createMediaPublisher` が既定の 48000 Hz ・ 2 ch のまま `AudioEncoder` を構成し、Chromium が変換せずに渡す `AudioData` と食い違う。取れた形式で符号化し、Catalog にも同じ値を載せる。

## 現状

- `examples/high-level-api/main.ts` の `startPublishing` は、`getUserMedia` の audio に `deviceId` だけを付ける (未選択のときは `true`)。`sampleRate` と `channelCount` は付けない。`createMediaPublisher` の `audio` にも `codec` と `bitrate` しか渡さない
- `src/createMedia/settings.ts` の `resolveAudioPublishSettings` は、省略された `sampleRate` を `DEFAULT_AUDIO_SAMPLE_RATE` (48000)、`channels` を `DEFAULT_AUDIO_CHANNELS` (2) にする。引数はオプションだけで、音声トラックは受け取らない。映像の `resolveVideoPublishSettings` はトラックの `getSettings()` を既定値に使う
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` は、接続の前に `resolveAudioPublishSettings` の結果を `resolvedAudio` に置く。`createPublishers` が `publishCatalog` を呼び、`createCatalogTracks` はその `sampleRate` と `channels` を catalog の `samplerate` と `channelConfig` に載せる。その後の `setupEncoders` が同じ値で `AudioEncoderWrapper.configure` する
- `setupEncoders` は configure の後に `createAudioFrameSource` を呼ぶ。返った `AudioFrameSource.sampleRate` と `channels` は読まない。`processAudioFrames` は読んだ `AudioData` をそのまま `encode` する
- `src/audioSource.ts` の `createAudioFrameSource` は、`MediaStreamTrackProcessor` があるブラウザ (Chromium 系) ではトラックの `AudioData` を変換せずに流す。`sampleRate` と `channels` は `getSettings()` の値で、無い項目だけ要求値になる。コメントは、Catalog と `AudioEncoder` にはこの値を使う、と定めている。`MediaStreamTrackProcessor` が無いブラウザは Web Audio 経路で、要求したチャンネル数と `AudioContext` のサンプルレートの `AudioData` を組み立てる
- Chromium の `AudioEncoder` は、`AudioData` の `sampleRate` または `numberOfChannels` が configure の値と違うとリサンプルもチャンネル変換もせず、`Input audio buffer is incompatible with codec parameters` でエラーにする。エラーのあとエンコーダーは `closed` になり、`processAudioFrames` の `encoder.state === "configured"` を外れるため、以降の音声は符号化されない
- 再現: `examples/high-level-api` で配信を始めると、上記のエラーがブラウザのログに出て音声が配信されなかった。`getUserMedia` を `sampleRate: { exact: 48000 }`、`channelCount: { exact: 2 }` にし、`echoCancellation` / `noiseSuppression` / `autoGainControl` を false にするとエラーは出なくなった。Chrome はこれらの音声処理が有効だと処理後のトラックを 1 チャンネルにすることがあり、既定の 2 ch とずれる。この制約は 1 チャンネルや 48000 Hz 以外を送れないため、サンプルには残していない
- `tests/e2e/main.ts` の `startPublisher` は、同じエラーを避けるために `getSettings()` の `sampleRate` と `channelCount` を `createMediaPublisher` へ渡している。devtools の `prepareAudioForPublishing` は、Catalog を送る前に `createAudioFrameSource` の `sampleRate` と `channels` を Catalog と `AudioEncoder` に使っている。高レベル API はこの追従をしていない
- 呼び出し側が `sampleRate` と `channels` を指定しても、Chromium の取り出し経路は `AudioData` をその形式へ変換しない。指定値で configure すると、マイクの形式と違うときに同じエラーになる

## 設計方針

- Catalog の `samplerate` / `channelConfig` と `AudioEncoder` の `sampleRate` / `numberOfChannels` は、`createAudioFrameSource` が返す `sampleRate` と `channels` にする。`src/audioSource.ts` が呼び出し側に求めている値であり、devtools の `prepareAudioForPublishing` と同じである
- 音声の取り出しは `publishCatalog` より前に行う。`createPublishers` は今、`setupEncoders` より前に catalog を送る。誤った `samplerate` と `channelConfig` を一度送らない
- オプションの `sampleRate` と `channels` は、取り出し経路への要求として `createAudioFrameSource` に渡す。Catalog とエンコーダーには、経路が実際に返す値を使う。Chromium ではデバイスの形式になり、Web Audio 経路では要求したチャンネル数と `AudioContext.sampleRate` になる
- 取れた形式を `AudioEncoder.isConfigSupported` で確認し、対応していなければ `configure` せずに `start()` を失敗させる。エラーには codec、sampleRate、channels を含める。`configure` は未対応の設定でも例外を投げず、非同期のエラーになる
- 対象外
  - マイクの `AudioData` を、呼び出し側が指定したサンプルレートやチャンネル数へリサンプル・チャンネル変換すること。コーデックが受け取れる形式は、取り出した形式がそのまま対応している場合に限る
  - `examples/high-level-api` の `getUserMedia` を 48000 Hz ・ 2 ch の `exact` に固定すること

## 完了条件

- `sampleRate` と `channels` を省略して `createMediaPublisher` を始めたとき、Catalog と `AudioEncoder` のサンプルレートとチャンネル数が、`createAudioFrameSource` が返す値と一致すること
- 1 チャンネル、または 48000 Hz 以外でコーデックが受け取れるサンプルレートのマイクから配信しても、`Input audio buffer is incompatible with codec parameters` が出ず、音声の frame が送られること
- コーデックが受け取らない形式では、`encode` のエラーではなく `start()` が codec、sampleRate、channels を含むエラーで失敗すること
- 取り出した形式を Catalog とエンコーダーの設定へ写す処理を純関数にして、単体テストで固定すること
- `docs/HIGH_LEVEL_API.md` の `sampleRate` / `channels` の説明が、省略時も指定時も、Catalog とエンコーダーには取り出した形式を使う、と一致すること
- `CHANGES.md` の `## develop` に `[FIX]` で載ること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 参照

- `examples/high-level-api/main.ts` の `startPublishing`
- `src/createMedia/settings.ts` の `resolveAudioPublishSettings` / `resolveVideoPublishSettings`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `publishCatalog` / `createCatalogTracks` / `setupEncoders` / `processAudioFrames`
- `src/audioSource.ts` の `createAudioFrameSource` / `createProcessorAudioFrameSource` / `createWebAudioFrameSource`
- `src/codec/config.ts` の `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` / `getAudioEncoderConfig`
- `devtools/src/hooks/usePublisher.ts` の `prepareAudioForPublishing`
- `tests/e2e/main.ts` の `startPublisher`
