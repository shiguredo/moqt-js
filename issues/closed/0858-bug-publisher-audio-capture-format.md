# 高レベル API がマイクの形式と違う設定で音声を符号化して配信が止まる

- Created: 2026-10-14
- Completed: 2026-10-14
- Branch: feature/fix-publisher-audio-capture-format
- Polished: 2026-10-14

## 目的

`examples/high-level-api` で Publisher の配信を始めると、ブラウザのログに `Input audio buffer is incompatible with codec parameters` が出て、音声が配信されない。マイクが 1 チャンネルだったり、サンプルレートが 48000 Hz 以外だったりすると、`createMediaPublisher` が既定の 48000 Hz ・ 2 ch のまま `AudioEncoder` を構成し、Chromium が変換せずに渡す `AudioData` と食い違う。取れた形式で符号化し、Catalog にも同じ値を載せる。

## 現状

- `examples/high-level-api/main.ts` の `startPublishing` は、`getUserMedia` の audio に `deviceId` だけを付ける (未選択のときは `true`)。`sampleRate` と `channelCount` は付けない。`createMediaPublisher` の `audio` にも `codec` と `bitrate` しか渡さない
- `src/createMedia/settings.ts` の `resolveAudioPublishSettings` は、省略された `sampleRate` を `DEFAULT_AUDIO_SAMPLE_RATE` (48000)、`channels` を `DEFAULT_AUDIO_CHANNELS` (2) にする。引数はオプションだけで、音声トラックは受け取らない。映像の `resolveVideoPublishSettings` はトラックの `getSettings()` を既定値に使う
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` は、接続の前に `resolveAudioPublishSettings` の結果を `resolvedAudio` に置く。`createPublishers` が `publishCatalog` を呼び、`createCatalogTracks` はその `sampleRate` と `channels` を catalog の `samplerate` と `channelConfig` に載せる。その後の `setupEncoders` が同じ値で `AudioEncoderWrapper.configure` する
- `setupEncoders` は configure の後に `createAudioFrameSource` を呼ぶ。返った `AudioFrameSource.sampleRate` と `channels` は読まない。`processAudioFrames` は棄却の境目でフェード用の `AudioData` を作り直すことがある。そのときも `sampleRate` と `numberOfChannels` は元の `AudioData` のまま `encode` する
- `src/audioSource.ts` の `createAudioFrameSource` は、`MediaStreamTrackProcessor` があるブラウザ (Chromium 系) ではトラックの `AudioData` を変換せずに流す。`sampleRate` と `channels` は `getSettings()` の値で、無い項目だけ要求値になる。コメントは、Catalog と `AudioEncoder` にはこの値を使う、と定めている。`MediaStreamTrackProcessor` が無いブラウザは Web Audio 経路で、要求したチャンネル数と `AudioContext` のサンプルレートの `AudioData` を組み立てる
- Chromium の `AudioEncoder` は、`AudioData` の `sampleRate` または `numberOfChannels` が configure の値と違うとリサンプルもチャンネル変換もせず、`Input audio buffer is incompatible with codec parameters` でエラーにする。WebCodecs ではこのエラーでエンコーダーが `closed` になる。高レベル API の既定は `useWorker: true` で、`AudioEncoderWrapper.state` は `codecStateLabel` により configure 完了後は `"configured"` のままである。`processAudioFrames` の `encoder.state === "configured"` は外れない。後続が符号化されないのは、`src/codec/workers/audioEncoder.worker.ts` の `encode` が内側の `AudioEncoder` を `isCodecConfigured` で見て、`closed` のあと `encode` しないためである。`useWorker: false` ではラッパーの `state` がコーデックの `"closed"` になり、ループ条件を外れる
- 利用者の報告 (2026-10-14): `examples/high-level-api` で配信を始めると、ブラウザのログに上記のエラーが出て音声が配信されなかった。`getUserMedia` を `sampleRate: { exact: 48000 }`、`channelCount: { exact: 2 }` にし、`echoCancellation` / `noiseSuppression` / `autoGainControl` を false にするとエラーは出なくなった。この観測はこのリポジトリのテストでは再実行していない。サンプルの `startPublishing` には、その `exact` 制約は残していない
- `tests/e2e/main.ts` の `startPublisher` は、同じエラーを避けるために `getSettings()` の `sampleRate` と `channelCount` を `createMediaPublisher` へ渡している。devtools の `prepareAudioForPublishing` は、Catalog を送る前に `createAudioFrameSource` の `sampleRate` と `channels` を Catalog と `AudioEncoder` に使っている。高レベル API はこの追従をしていない
- 呼び出し側が `sampleRate` と `channels` を指定しても、Chromium の取り出し経路は `AudioData` をその形式へ変換しない。指定値で configure すると、マイクの形式と違うときに同じエラーになる

## 設計方針

- 音声トラックがあるとき、`publishCatalog` より前に `createAudioFrameSource` を 1 度だけ作る。返った `sampleRate` と `channels` を、Catalog の `samplerate` / `channelConfig` と `AudioEncoder` の `sampleRate` / `numberOfChannels` の両方に使う。`setupEncoders` で取り出し経路を作り直さない。符号化はこの同じ `AudioFrameSource` を読む。`src/audioSource.ts` が呼び出し側に求めている値であり、devtools の `prepareAudioForPublishing` と同じである
- オプションの `sampleRate` と `channels` は、取り出し経路への要求として `createAudioFrameSource` に渡す。Catalog とエンコーダーには、経路が返した値を使う。指定した値そのもので `configure` しない。Chromium の `MediaStreamTrackProcessor` 経路では `getSettings()` (無い項目は要求値)、Web Audio 経路では要求したチャンネル数と `AudioContext.sampleRate` になる
- 返った形式を `AudioEncoder.isConfigSupported` で確認する。確認は `publishCatalog` より前に行う。`supported` が true でなければ `configure` せず、catalog も送らず、`start()` を失敗させる。エラーメッセージには codec、sampleRate、channels を含める。`configure` は未対応の設定でも同期の例外を投げず、非同期のエラーになる
- 対象外
  - マイクの `AudioData` を、呼び出し側が指定したサンプルレートやチャンネル数へリサンプル・チャンネル変換すること。コーデックが受け取れる形式は、取り出した形式がそのまま対応している場合に限る
  - `examples/high-level-api` の `getUserMedia` を 48000 Hz ・ 2 ch の `exact` に固定すること
  - `CHANGES.md` の更新。`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」が、ドラフト中は `CHANGES.md` を更新しないと定めている

## 完了条件

- `sampleRate` と `channels` を省略したときも、指定した値と取り出し経路の返り値が違うときも、Catalog と `AudioEncoder` のサンプルレートとチャンネル数が、`createAudioFrameSource` が返す値と一致すること。指定値そのものでは `configure` しない
- 1 チャンネル、または 48000 Hz 以外でコーデックが受け取れるサンプルレートのマイクから配信しても、`Input audio buffer is incompatible with codec parameters` が出ず、音声の frame が送られること
- コーデックが受け取らない形式では、catalog を送る前に `start()` が失敗すること。失敗は `encode` のエラーではなく、メッセージに codec、sampleRate、channels を含む
- 取り出した形式を Catalog とエンコーダーの設定へ写す処理を純関数にして、単体テストで固定すること
- `docs/HIGH_LEVEL_API.md` の `sampleRate` / `channels` の説明が、省略時も指定時も、Catalog とエンコーダーには取り出した形式を使う、と一致すること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 参照

- `examples/high-level-api/main.ts` の `startPublishing`
- `src/createMedia/settings.ts` の `resolveAudioPublishSettings` / `resolveVideoPublishSettings`
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `publishCatalog` / `createCatalogTracks` / `setupEncoders` / `processAudioFrames`
- `src/audioSource.ts` の `createAudioFrameSource` / `createProcessorAudioFrameSource` / `createWebAudioFrameSource`
- `src/codec/config.ts` の `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` / `getAudioEncoderConfig`
- `devtools/src/hooks/usePublisher.ts` の `prepareAudioForPublishing`
- `tests/e2e/main.ts` の `startPublisher`

## 解決方法

- `src/createMediaPublisher.ts` の `start()` の段階を「接続 → Publisher の作成 (`createPublishers`。音声・映像の PUBLISH の往復のみ) → 音声の取り出し経路の作成と形式の確定 (`prepareAudioFrameSource`) → catalog の送信 (`publishCatalog`) → エンコーダーの構成 (`setupEncoders`) → 処理ループの起動」に変えた。catalog の Object の送信は `createPublishers` から外し、`start()` が `publishCatalog()` を呼ぶ。取り出し経路は PUBLISH の往復より後に作る (先に作ると符号化が始まるまで `AudioData` が溜まり、追いつきの既定 "drop" が冒頭を捨てる)
- `prepareAudioFrameSource` が `createAudioFrameSource` を 1 度だけ作り、返った `sampleRate` と `channels` を `withCapturedAudioFormat` (`src/createMedia/settings.ts` の純関数) で `resolvedAudio` へ写す。`createCatalogTracks` と `setupEncoders` はこの値を使い、`setupEncoders` は経路を作り直さない (音声エンコーダーを作る条件は読み出しの reader の有無)
- 取り出した形式を `src/codec/configSupport.ts` の `isAudioEncoderConfigSupported` で確認し、非対応なら configure も catalog の送信もせずに `start()` を失敗させる (エラーに codec / codecString / sampleRate / channels を含む)。取り出し経路が無い場合も `createAudioFrameSource` のエラーで catalog の送信前に失敗する。初期 catalog の送信時に catalog の Publisher が `"active"` でなければ、catalog の Object より先に media の Object を送らない (draft-ietf-moq-msf-01 §11.2 の MUST) ため `start()` を失敗させる
- `sampleRate` と `channels` は取り出し経路への要求として `createAudioFrameSource` に渡すだけにした。`docs/HIGH_LEVEL_API.md` のオプション・本文・メソッド表と `src/codec/types.ts` の公開オプションをこれに合わせた
- 追加・更新したテスト
  - `src/createMedia/settings.test.ts`: `withCapturedAudioFormat` が取り出した形式を写し、他の項目を変えないこと
  - `src/codec/configSupport.test.ts`: `isAudioEncoderConfigSupported` の判定規則 (supported が false / 省略 / reject / `AudioEncoder` 不在)
  - `src/createMediaPublisher.test.ts`: 取り出した形式が catalog と configure の両方に使われること、経路が start ごとに 1 度だけ作られること、非対応形式では catalog を送る前に失敗して再試行できること、取り出し経路が無い場合、catalog の Publisher が active でない場合、FORWARD が 0 の初期送信の扱い
  - `tests/e2e/relay/audio-capture-format.spec.ts`: 実リレー経由で、音声の形式を省略したときも指定した形式がマイクと違うときも、偽のマイク (モノラル) の形式で符号化されて object が送られ、Catalog の宣言が配信に使ったトラックが報告した形式と一致すること。修正を一時退避すると 2 件とも失敗することを確認した
  - `tests/e2e/main.ts`: 音声の形式をトラックの設定から転送する回避策を外し、配信に使ったトラックが報告した形式を観測値 (`PublisherTrackAudioFormat`) として返すようにした
- `devtools/src/hooks/usePublisher.ts` の音声の対応確認を `src/codec/configSupport.ts` の共有関数に寄せた
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」により更新していない (この issue の設計方針でも対象外)

### 残した穴 (別 issue 候補)

- `audio` / `video` を指定しても `MediaStream` にそのトラックが無い場合、そのトラックは catalog に宣言されるが object は送られない (この修正の前後で同じ挙動)。`docs/HIGH_LEVEL_API.md` に契約として明記した
- `devtools/src/codec-test/support.ts` の音声コーデックの対応確認は、共有の `isAudioEncoderConfigSupported` を使わず truthy 判定のままである
- 送り直し系のテストの冠 (`createPublishers:`) が、catalog の送信・予約を主対象にするものと一致していない
