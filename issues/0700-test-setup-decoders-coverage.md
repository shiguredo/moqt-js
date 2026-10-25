# setupDecoders の解決ロジックが純粋関数でなく単体テストで固定されていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-setup-decoders-coverage
- Polished: 2026-10-26

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` のテストは private フィールドへ記録用の decoder を注入して機構 (保留キュー / 初期 configure / config 同一判定) を検証した。`setupDecoders` 自体は close 時の中断を固定する 2 件のテストで直接呼ばれるが、Catalog と options からの解決ロジックは固定されていない。

`setupDecoders` は Catalog と options から codec / 解像度 / サンプルレート / チャンネル数を解決し、解決できない場合は throw する。購読の成否を決める解決ロジックであるにもかかわらず、解決の優先順位 (options 優先)、既定値 (640x480 / 48000Hz / 2ch)、throw 条件のどれも回帰検出できない。

## 現状

- `src/createMediaSubscriber.ts` の `setupDecoders` は `useWorker` を `options.useWorker ?? true` で解決し、`audioTrackInfo` がある場合に `AudioDecoderWrapper` を生成する。音声の codec は `options.audio.codec` → `parseAudioCodec(this.audioTrackInfo.codec)` の順で解決し、どちらも無ければ `Error` を throw する。`sampleRate` は `audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE`、channels は `resolveAudioChannelCount(audioTrackInfo.channelConfig)` で、`configure` の後に `audioDecoderConfigured = true` にする。
- 映像は `VideoDecoderWrapper` を生成し、codec を `options.video.codec` → `parseVideoCodec(this.videoTrackInfo.codec)` の順で解決し、無ければ throw する。解像度は `width ?? 640` / `height ?? 480` で、`configure` の後に `videoDecoderConfigured = true` にする。
- `parseAudioCodec` / `parseVideoCodec` は `src/createMediaSubscriber.ts` のモジュール内非公開関数で、未知の codec 文字列は throw する。`reconfigureAudioDecoder` / `reconfigureVideoDecoder` からも呼ばれるため、この 2 つは `handleVideoObject` / `handleAudioObject` のテストで間接的に通るが、`setupDecoders` の「options を優先する」順序は通らない。
- `setupDecoders` は wrapper の `configure()` を await する。直接実行モードでは `VideoDecoderWrapper.configureDirect` の `new VideoDecoder(...)` / `AudioDecoderWrapper.configureDirect` の `new AudioDecoder(...)` が、Worker モードでは `configureWorker` の `import("./workers/videoDecoder.worker?worker")` / `import("./workers/audioDecoder.worker?worker")` と `configureWrapperWorker` の `new WorkerModule.default()` が必要で、いずれも Node のテスト環境に無い。
- `src/testSupport/mediaSubscriberTestSupport.ts` の `SubscriberInitialConfigControl` は private フィールド (`videoDecoder` / `audioDecoder` / `*DecoderConfigured` / `videoTrackInfo` / `audioTrackInfo` など) を `as unknown as ...` で注入する制御口である。`src/createMediaSubscriber.lifecycle.test.ts` の 2 件 (`setupDecoders: デコーダの configure の await 中に close したら中止する` / `setupDecoders: 映像デコーダの configure の await 中に close したら中止する`) は `setupDecoders` を直接呼ぶが、codec と中断だけを固定し、解像度 / サンプルレート / チャンネル数、解決の優先順位、既定値、throw は固定していない。`start()` は WebTransport / AudioContext / MediaStreamTrackGenerator を要するため Node では完了しない。
- `src/codec/config.ts` の純粋部分 (`getVideoDecoderConfig` / `getAudioDecoderConfig` / `resolveAudioChannelCount` / `requiresAudioSpecificConfig`) は `src/codec/config.test.ts` で固定されている。同ファイルは各関数の単体テストだけで、解決値をデコーダ設定へ渡す合成は固定していない。`setupDecoders` の配線は codec だけが close 中断のテストで固定され、解像度 / サンプルレート / チャンネル数は固定されていない。
- `devtools/src/utils/DecoderWrapper.test.ts` は devtools 側の wrapper を対象とし、高レベル API の購読経路は対象外である。

## 設計方針

- 解決ロジックを純粋関数へ切り出す。`src/createMedia/settings.ts` の `resolveAudioPublishSettings` / `resolveVideoPublishSettings` が publisher 側で既に同じ分離をしているため、購読側も同じ形に揃える
  - 案: `src/createMedia/settings.ts` に `resolveAudioDecoderSettings(audioOptions, trackInfo)` / `resolveVideoDecoderSettings(videoOptions, trackInfo)` を追加し、codec / sampleRate / channels / width / height と throw 条件を 1 箇所に集約する (`audioOptions` / `videoOptions` は `AudioSubscribeOptions` / `VideoSubscribeOptions`、`trackInfo` は `CatalogTrack`)
  - `parseAudioCodec` / `parseVideoCodec` も同じモジュールへ移し、codec 文字列の受理範囲 (vp8 / vp09 / vp9 / avc1 / avc3 / hvc1 / hev1 / av01 と opus / mp4a) と throw を固定対象にする
- `setupDecoders` は解決結果を wrapper の `configure` に渡すだけにし、既定値のリテラル (640 / 480) と throw の分岐を `src/createMediaSubscriber.ts` から消す
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` も同じ解決関数を使い、`src/createMediaSubscriber.ts` から codec / sampleRate / channels / width / height の解決の重複を消す。codec 未解決時は `setupDecoders` が先に throw するため通常は到達しないが、reconfigure の契約 (reject しない / `onError` に 1 回) は維持する
- テストは純粋関数の単体テスト (`src/createMedia/settings.test.ts`) に置く。既定値 (`DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` / 640 / 480)、options 優先、Catalog フォールバック、codec 未解決の throw、未知 codec の throw、不正 `channelConfig` の throw を固定する
- wrapper の生成と `configure` の呼び出し配線 (WebCodecs 依存) は e2e かレビューで確認する。実リレーを起動する e2e harness は現状無いため (0703 が扱う)、本 issue の完了条件には入れない
- 対象は `src/createMediaSubscriber.ts` / `src/createMedia/settings.ts` / `src/createMedia/settings.test.ts` / 既存の `src/createMediaSubscriber.*.test.ts` とする。公開 API と、到達し得る経路の挙動は変わらないため `CHANGES.md` は触らない
- 対象外: 実リレーを起動する相互運用 harness (0703)、devtools 側の decoder 設定 (devtools は高レベル API を使わない独自実装)

## 完了条件

- codec / 解像度 / サンプルレート / チャンネル数の解決が純粋関数になり、`setupDecoders` がその戻り値だけを `configure` に渡す
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` も同じ純粋関数を使う
- 純粋関数のテストで次が固定される
  - `options` の codec が Catalog より優先される (映像・音声)
  - Catalog のみでも codec が解決される
  - 既定値が `width 640` / `height 480` / `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` になる
  - codec が options にも Catalog にも無い場合に throw する
  - `parseAudioCodec` / `parseVideoCodec` が未知の codec 文字列で throw し、既知の接頭辞 (vp8 / vp09 / vp9 / avc1 / avc3 / hvc1 / hev1 / av01 / opus / mp4a) を受理する
  - `resolveAudioChannelCount` の throw (不正な `channelConfig`) が解決関数の throw として伝わる
- `src/createMediaSubscriber.ts` から既定値のリテラル (640 / 480) と codec 解決の分岐が消える
- 0649 で追加したテスト (保留キュー / 初期 configure / config 同一判定。現在は `src/createMediaSubscriber.catalog.test.ts` と `src/createMediaSubscriber.media.test.ts`) が変わらず通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)
- draft-ietf-moq-msf-01 §5.2.29 (channelConfig) と `src/codec/config.ts` の `resolveAudioChannelCount` (値語彙は仕様に無く製品判断でマッピングする)
- closed の `0649-bug-media-subscriber-track-property-config.md` (検証で private フィールドの注入を選び、当時は `setupDecoders` を未テストのまま残した)
- `src/createMedia/settings.ts` (publisher 側の解決関数。同じ形に揃える)
- `src/codec/config.ts` / `src/codec/config.test.ts` (純粋部分と既存のテスト)
- `src/testSupport/mediaSubscriberTestSupport.ts` の `SubscriberInitialConfigControl` と `src/createMediaSubscriber.lifecycle.test.ts` (setupDecoders を直接呼ぶテスト)
- 0703 (実リレーを起動する相互運用 harness)

## 解決方法

{未着手}
