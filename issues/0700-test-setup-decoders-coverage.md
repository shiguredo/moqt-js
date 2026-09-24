# setupDecoders が Node の単体テストで駆動できず解決ロジックが未テストである

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-setup-decoders-coverage
- Polished: 2026-09-24

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` のテストは private フィールドへ記録用の decoder を注入して機構 (保留キュー / 初期 configure / config 同一判定) を検証した。WebCodecs の実体を必要とする `setupDecoders` 自体は未テストのままである。

`setupDecoders` は Catalog と options から codec / 解像度 / サンプルレート / チャンネル数を解決し、解決できない場合は throw する。購読の成否を決める解決ロジックであるにもかかわらず、Node の単体テストでは 1 度も実行されない。解決の優先順位 (options 優先)、既定値 (640x480 / 48000Hz / 2ch)、throw 条件のどれも回帰検出できない。

## 現状

- `src/createMediaSubscriber.ts` の `setupDecoders` (870 行目) は `useWorker` を `options.useWorker ?? true` で解決し (871 行目)、`audioTrackInfo` がある場合に `AudioDecoderWrapper` を生成する (875 行目)
- 音声の codec は `options.audio.codec` → `parseAudioCodec(this.audioTrackInfo.codec)` の順で解決し (882-888 行目)、どちらも無ければ `Error` を throw する (887 行目)。`sampleRate` は `audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE` (890 行目)、channels は `resolveAudioChannelCount(audioTrackInfo.channelConfig)` (893 行目) で、`configure` の後に `audioDecoderConfigured = true` にする (899-900 行目)
- 映像は `VideoDecoderWrapper` を生成し (905 行目)、codec を `options.video.codec` → `parseVideoCodec(this.videoTrackInfo.codec)` の順で解決し (915-922 行目)、無ければ throw する (921 行目)。解像度は `width ?? 640` / `height ?? 480` (924-925 行目) で、`configure` の後に `videoDecoderConfigured = true` にする (931-932 行目)
- `parseAudioCodec` (229 行目) / `parseVideoCodec` (242 行目) はモジュール内の非公開関数で、未知の codec 文字列は throw する (236 行目 / 258 行目)。`reconfigureAudioDecoder` (1205 行目) / `reconfigureVideoDecoder` (1237 行目) からも呼ばれるため、この 2 つは `handleVideoObject` / `handleAudioObject` のテストで間接的に通るが、`setupDecoders` の「options を優先する」順序は通らない
- `setupDecoders` は wrapper の `configure()` を await する。直接実行モードでは `new VideoDecoder(...)` (`src/codec/VideoDecoder.ts` 101 行目) / `new AudioDecoder(...)` (`src/codec/AudioDecoder.ts` 89 行目) が、Worker モードでは `import("./workers/videoDecoder.worker?worker")` (`src/codec/VideoDecoder.ts` 75 行目 / `src/codec/AudioDecoder.ts` 74 行目) と `new Worker(...)` (`src/codec/workerConfigure.ts` 291 行目) が必要で、いずれも Node のテスト環境に無い
- `src/createMediaSubscriber.test.ts` は private フィールド (`videoDecoder` / `audioDecoder` / `*DecoderConfigured` / `videoTrackInfo` / `audioTrackInfo`) を `as unknown as ...` で注入する制御口を持つ (`SubscriberInitialConfigControl`、288-320 行目)。`setupDecoders` を呼ぶテストは無く、`start()` も `createOutputStream` が `MediaStreamTrackGenerator` を要求するため (864 行目) Node では通らない
- `src/codec/config.ts` の純粋部分 (`getVideoDecoderConfig` 55 行目 / `getAudioDecoderConfig` 197 行目 / `resolveAudioChannelCount` 123 行目 / `requiresAudioSpecificConfig` 190 行目) は `src/codec/config.test.ts` で固定されている。同ファイル 283-290 行目に「解決値をデコーダ設定に渡す配線 (setupDecoders と同形) を pin する」テストがあるが、これは 1 つの合成例であり `setupDecoders` 自身の配線 (どの値がどの引数に渡るか) は固定されていない
- `devtools/src/utils/DecoderWrapper.test.ts` は devtools 側の wrapper を対象とし、高レベル API の購読経路は対象外である

## 設計方針

- 解決ロジックを純粋関数へ切り出す。`src/createMedia/settings.ts` の `resolveAudioPublishSettings` (60 行目) / `resolveVideoPublishSettings` (83 行目) が publisher 側で既に同じ分離をしているため、購読側も同じ形に揃える
  - 案: `src/createMedia/settings.ts` に `resolveAudioDecoderSettings(options, trackInfo)` / `resolveVideoDecoderSettings(options, trackInfo)` を追加し、codec / sampleRate / channels / width / height と throw 条件を 1 箇所に集約する
  - `parseAudioCodec` / `parseVideoCodec` も同じモジュールへ移し、codec 文字列の受理範囲 (vp8 / vp09 / vp9 / avc1 / avc3 / hvc1 / hev1 / av01 と opus / mp4a) と throw を固定対象にする
- `setupDecoders` は解決結果を wrapper の `configure` に渡すだけにし、既定値のリテラル (640 / 480) と throw の分岐を `src/createMediaSubscriber.ts` から消す
- テストは純粋関数の単体テスト (`src/createMedia/settings.test.ts` または `src/codec/config.test.ts` の隣) に置く。既定値 (`DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` / 640 / 480)、options 優先、Catalog フォールバック、codec 未解決の throw、未知 codec の throw、不正 `channelConfig` の throw を固定する
- wrapper の生成と `configure` の呼び出し配線 (WebCodecs 依存) は e2e かレビューで確認する。実リレーを起動する e2e harness は現状無いため (0703 が扱う)、本 issue の完了条件には入れない
- 対象は `src/createMediaSubscriber.ts` / `src/createMedia/settings.ts` / そのテスト / `src/createMediaSubscriber.test.ts` とする。公開 API と挙動は変わらないため `CHANGES.md` は触らない
- 対象外: 実リレーを起動する相互運用 harness (0703)、devtools 側の decoder 設定 (devtools は高レベル API を使わない独自実装)

## 完了条件

- codec / 解像度 / サンプルレート / チャンネル数の解決が純粋関数になり、`setupDecoders` がその戻り値だけを `configure` に渡す
- 純粋関数のテストで次が固定される
  - `options` の codec が Catalog より優先される (映像・音声)
  - Catalog のみでも codec が解決される
  - 既定値が `width 640` / `height 480` / `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` になる
  - codec が options にも Catalog にも無い場合に throw する
  - `parseAudioCodec` / `parseVideoCodec` が未知の codec 文字列で throw し、既知の接頭辞 (vp8 / vp09 / vp9 / avc1 / avc3 / hvc1 / hev1 / av01 / opus / mp4a) を受理する
  - `resolveAudioChannelCount` の throw (不正な `channelConfig`) が解決関数の throw として伝わる
- `src/createMediaSubscriber.ts` から既定値のリテラル (640 / 480) と codec 解決の分岐が消える
- 0649 で追加したテスト (保留キュー / 初期 configure / config 同一判定) が変わらず通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)
- draft-ietf-moq-msf-01 §5.2.29 (channelConfig) と `src/codec/config.ts` の `resolveAudioChannelCount` (値語彙は仕様に無く製品判断でマッピングする)
- closed の `0649-bug-media-subscriber-track-property-config.md` (検証で private フィールドの注入を選び、`setupDecoders` を未テストのまま残した)
- `src/createMedia/settings.ts` (publisher 側の解決関数。同じ形に揃える)
- `src/codec/config.ts` / `src/codec/config.test.ts` (純粋部分と既存の合成テスト)
- 0703 (実リレーを起動する相互運用 harness)

## 解決方法

{未着手}
