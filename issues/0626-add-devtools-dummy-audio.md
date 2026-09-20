# devtools にダミー音声の配信と購読を追加する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-dummy-audio
- Polished: 2026-09-20

## 目的

devtools は映像しか扱わない。ダミー映像 (`videoSource: "dummy"`) があるためカメラ無しで
配信と購読を確認できるが、音声には対応する経路が無い。音声トラックを含む相互運用を
測ろうとすると、マイクを繋いだ実機でしか確認できない。

音声を含む publisher / subscriber との相互運用 (音声 object の到達、catalog の
`role: "audio"` の解釈、LOC の音声 properties の往復) を、マイク無しで再現できるように
する。

受信した音声は既定では音声出力デバイスへ再生しない。相互運用の実測で毎回音が出ると
邪魔になるため、UI のトグルを明示的に有効にしたときだけ再生する。受信した音声の可視化は
`devtools で受信した音声を可視化する` で扱う。

## 現状

### publisher が音声を扱わない

- `devtools/src/hooks/usePublisher.ts` の `getVideoStream` はカメラ経路で
  `getUserMedia({ video: videoConstraints, audio: false })` を呼ぶ。ダミー経路は
  `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` の `createDummyVideoStream` を使う
- `createDummyVideoStream` は `DummyVideoGenerator` (`stream` / `canvas` / `stop`) を返し、
  利用側は `stop()` を `cleanupPublisher` で呼んで canvas の更新と track を止める
- `buildPublisherCatalog()` は `createCatalog` へ `role: "video"` のトラック 1 件だけを渡す。
  `role: "audio"` のトラックを作る経路が無い
- AudioEncoder を組み立てる箇所が無い (`devtools/src/hooks/usePublisher.ts` に
  `AudioEncoderWrapper` の import が無い)
- devtools の publisher は `pub.publisher` の 1 本だけで、Group ID / Object ID /
  優先度も `pub.pubCurrentGroup` / `pub.pubCurrentObjectId` の単一系統で採番している
  (`devtools/src/signals/publisher.ts`、`devtools/src/hooks/usePublisher.ts` の
  `buildObjectSendPlan`)。音声トラックを足すには 2 本目の publisher と独立した採番が要る
- `devtools/src/hooks/usePublisher.test.ts` は「映像トラック 1 件だけを持つ full catalog に
  なる」を固定しており、音声を足すとこの前提が変わる

### subscriber が音声を購読しない

- `devtools/src/hooks/useSubscriber.ts` は catalog から `getVideoTracks(catalog)` で先頭の
  映像トラックだけを取り出して SUBSCRIBE し、`VideoDecoderWrapper` で復号して canvas に
  描く。音声トラックの購読・復号の配線が無い
- 同ファイルに `audio` の記述が 1 つも無い
- devtools に `AudioContext` も `<audio>` 要素も無く、音声出力の経路が存在しない

### ライブラリ側には音声の実装がある

- `src/msf/tracks.ts` の `getAudioTracks(catalog)` は実装済みで `src/index.ts` から公開
  されている
- `src/createMediaPublisher.ts` は映像と音声で **別々の** `session.publish` を確立し
  (`audioPublisher` / `videoPublisher`)、Group 採番も優先度も別系統に持つ
  (`audioGroupId` / `videoGroupId`、`PRIORITY_AUDIO` = 192)。catalog には `samplerate` と
  `channelConfig` を載せる
- `src/createMediaSubscriber.ts` は `AudioDecoderWrapper` で復号し、
  `MediaStreamAudioDestinationNode` のトラックを `outputStream` に載せる。
  **`audioContext.destination` には繋がないため、ライブラリを使うだけでは音は出ない**
- `src/codec/config.ts` に `getAudioEncoderConfig` / `getAudioDecoderConfig` /
  `requiresAudioSpecificConfig` / `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS`
  がある。`AudioEncoderWrapper` / `AudioDecoderWrapper` / `getAudioEncoderConfig` /
  `allocateAudioObject` は **`src/index.ts` の公開 API に含まれない**
- devtools の Vite 設定は `moqt-js` を `../src/index.ts` に alias している
  (`devtools/vite.config.ts`)。ライブラリ内部を使う前例は codec-test ページの
  deep import (`devtools/src/codec-test/audio.ts` の `../../../src/codec/AudioDecoder.ts`)
  だけである
- devtools 内では `devtools/src/codec-test/support.ts` の `createSilentAudioData` が
  codec-test ページ用に無音の `AudioData` を作る。無音は「復号結果が無音でも気付けない」
  ため、media 経路のダミーには向かない

### E2E の置き場

- 実リレーを起動して devtools を Playwright で駆動する相互運用 harness は moqt-js に無い
  (リレー実装側のリポジトリにある)
- その harness の publisher 役は映像トラックだけを広告する実装であり、音声を配信できない。
  音声の E2E を書くには harness 側に音声 publisher を足すか、devtools publisher と
  devtools subscriber を向かい合わせる必要がある
- moqt-js の E2E は `tests/e2e/` に 2 本 (`codec-wrappers.spec.ts` /
  `webtransport-devtools.spec.ts`) があり、`playwright.config.ts` は devtools の dev
  サーバーだけを起動する (リレーは起動しない)

## 設計方針

### ダミー音声の生成

- `devtools/src/webcodecs-devtools/utils/dummyAudio.ts` に `createDummyAudioStream` を置き、
  `DummyVideoGenerator` と同形の `DummyAudioGenerator { stream, stop }` を返す。
  `usePublisher` の `cleanupPublisher` / `stopPreview` で `stop()` を呼び、`AudioContext` と
  音源 (`AudioBufferSourceNode`) を止める
- 無音ではなく可聴のトーン (440 Hz のサイン波) にする。無音だと復号結果が無音でも
  気付けず、経路が通ったかを確認できない。振幅は一定にせずゆっくり変化させる
- 音源は `OscillatorNode` ではなく、**サンプル列を作る純関数 (`createToneSamples` を想定) の
  出力を `AudioBuffer` に載せ、`AudioBufferSourceNode` で鳴らす**。単体テストは Node 環境で
  動く (`vite.config.ts` の `test` 設定に `environment` が無く、jsdom / happy-dom も
  未導入) ため `AudioContext` / `MediaStream` / `AudioData` を観測できない。
  純関数を実際の信号経路そのものにすることで、単体テストが守る値と配信される音が一致する。
  `MediaStream` 化 (`AudioContext` + `AudioBufferSourceNode` +
  `MediaStreamAudioDestinationNode`) はブラウザ側の検証に回す
- 設定 (`devtools/src/signals/connectionSettings.ts`) に `audioSource: "none" | "dummy"`、
  音声コーデック・ビットレート・サンプルレート・チャンネル数を足す。マイクからの取得は
  本 issue では扱わない (`getUserMedia` は `audio: false` 固定であり、取得経路を作るには
  別の作業が要る)
- 追加した設定は `buildQueryString` と `initFromUrl` の **双方** に足す。`initFromUrl` は
  `videoSource` と同じ許可リスト検証を行う。`buildQueryString` を忘れると Copy URL で
  復元できなくなる
- `devtools/src/components/ConnectionSettings.tsx` に `videoSource` と同形の
  `audioSource` の select と音声設定の入力を足す。URL を知らない利用者が UI から
  有効化できないと意味が無い。E2E から駆動できるよう `data-testid` を付ける
  (`ConnectionSettings.tsx` の既存要素は `id` のみで `data-testid` を持たない)
- 既定は `"none"` にする。音声を足すと catalog のトラック数が変わるため、既存の
  相互運用の実測をそのまま保つ

### publisher

- 音声トラック用に **2 本目の `session.publish`** を作る。ライブラリの
  `createMediaPublisher` と同じく、Group ID と優先度は映像と独立に持つ
  (`devtools/src/signals/publisher.ts` に音声用の publisher / Group / 統計を足す)
- catalog に `role: "audio"` のトラックを足す (`buildPublisherCatalog` を音声の有無で
  切り替える)。載せるフィールドは `codec` (`getAudioEncoderConfig` と一致させる)、
  `samplerate`、`channelConfig`、`bitrate` とする。MSF §5.2.18 (codec) / §5.2.28
  (samplerate) / §5.2.29 (channelConfig) / §5.2.22 (bitrate) がいずれも audio codec を
  指定する track に MUST で要求する
- エンコードは `AudioEncoderWrapper` を使い、映像と同じ Worker 設定
  (`useDedicatedWorker`) で組み立てる。`LOC.encodeAudioProperties` で properties を作る。
  ダミー音声の `MediaStream` からは `MediaStreamTrackProcessor<AudioData>` で `AudioData`
  を取り出して渡す (ライブラリの `createMediaPublisher` と同じ経路)
- Group / Object ID の採番は draft-ietf-moq-loc-04 §4.1 の「符号化された audio chunk 1 つが
  1 Object になり、1 Group に 1 Object、GroupID は chunk ごとに +1、ObjectID は 0」に従う
  (ライブラリの `allocateAudioObject` と同じ規則。初回は割当済みの初期 Group を使う)
- 音声を有効にしたときは LOC の Audio Level も載せる (受信側の表示は
  `devtools で受信した音声を可視化する` が担う)。RFC 6464 §3 と同じく、chunk が符号化
  するサンプル列の RMS から -dBov (0〜127) を求める。voiceActivity の判定は RFC 6464 §3
  により実装依存であるため、ダミー音声では振幅の閾値で決める。算出は `createToneSamples`
  が返すサンプル列を使う純関数にして単体テストで固定する
- ライブラリ内部のシンボル (`AudioEncoderWrapper` / `getAudioEncoderConfig` /
  `allocateAudioObject`) は codec-test と同じ deep import
  (`../../../src/codec/AudioEncoder.ts` など) で使う。`src/index.ts` の公開 API には
  追加しない (devtools 専用の都合であり、外部利用者に必要になった時点で別 issue とする)

### subscriber

- `getAudioTracks(catalog)` で音声トラックを取り出して SUBSCRIBE し、
  `AudioDecoderWrapper` で復号する。`AudioDecoderWrapper.configure` に渡す sampleRate と
  channels は catalog の `samplerate` / `channelConfig` から取る (`channelConfig` は
  文字列のため、`src/codec/config.ts` の `resolveAudioChannelCount` を deep import して
  数値化する。欠落時は `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS` へ
  フォールバックする)
- 受信 object の LOC properties は `LOC.resolveAudioProperties` に `trackProperties` /
  `objectProperties` を渡して解決する。TIMESTAMP を `decode` の timestamp に渡し、
  AAC (`requiresAudioSpecificConfig` が真) のときだけ Audio Config を decoder の
  description に載せる
- 復号した `AudioData` の所有者は decode ハンドラ (`AudioDecoderWrapper` の `output`
  コールバック) であり、読み出しを終えた後に `finally` で 1 回だけ `close()` する
  (ライブラリの `handleAudioDecodedData` と同じ)。可視化が同じ出力を読む場合も
  `close()` の前に済ませる
- 直近に受信した音声 object の LOC Audio Level は signal
  `audioLastLevel: Signal<LOC.AudioLevel | null>` に保持する (`null` はその object に
  Audio Level が載っていないことを表し、前の object の値を持ち越さない)。描画と
  `window.moqtDevTools` への公開は `devtools で受信した音声を可視化する` が行う
- Catalog に音声が無い場合 (harness の publisher、`--no-audio` を付けた moqt-rs の
  publisher) は警告ログを出して映像だけ継続する。moqt-rs の publisher は既定で音声を
  配信するため、音声なしの相手として使う場合は `--no-audio` を明示する
- **既定では音声出力デバイスへ再生しない**。トグルを明示的に有効にしたときだけ、
  devtools 側で `AudioContext` と `MediaStreamAudioDestinationNode` を組み立てて
  `MediaStreamAudioDestinationNode.stream` を `<audio>` の `srcObject` に設定し、`play()`
  する (ライブラリの `createMediaSubscriber` と同じ構成。`audioContext.destination` には
  繋がない)。トグルのクリックがユーザー操作になるため、`AudioContext` の `resume()` も
  その中で行う
- トグルは `SubscriberInstance` の signal として持ち (統計 signal と同じ置き場)、既定は
  無効。`devtools/src/components/SubscriberPanel.tsx` に置き、`data-testid` を付ける
- 統計に **`audioObjectsReceived` と `audioChunksDecoded`** を足す。
  `devtools/src/signals/subscriber.ts` の `SubscriberInstance` に signal を足し、
  `devtools/src/testApi.ts` の `SubscriberStats` interface と `getSubscribers()` /
  `getSubscriber()` の 3 箇所から読めるようにする (`getPublisher()` は対象外)。音を
  出さなくても経路が通ったかを E2E が判定できるようにするため。最終レベルと最終 voice
  activity は `devtools で受信した音声を可視化する` が足す

### テスト

- `buildPublisherCatalog` が音声の有無でトラックを切り替え、`samplerate` /
  `channelConfig` / `bitrate` を載せることを単体テストで固定する
- `createToneSamples` が返すサンプル列の長さ・値域・周期性 (440 Hz) を単体テストで固定する
  (Node 環境で動く純関数に限る)。Audio Level の算出結果 (-dBov と voiceActivity) も
  同じく単体テストで固定する
- `audioSource` が URL クエリで復元・生成されること (`initFromUrl` と
  `buildQueryString` の往復) を `tests/e2e/webtransport-devtools.spec.ts` と同じ流儀の
  UI テストで固定する。メインの devtools ページを開く spec は無いため
  `tests/e2e/devtools-audio.spec.ts` を新規に作る (トグルの DOM 挙動も同じ spec で見る)
- トグル無効時は `<audio>` に `srcObject` が設定されず、有効時に設定されて
  `paused === false` になることを E2E で観測する。「実際に音が鳴る」ことはヘッドレス CI
  では判定できないため、DOM と統計で判定できる範囲に留める
- 音声トラックを持たない catalog を渡したときに音声の購読を開始しない分岐を単体テストで
  固定する (実リレーが要る「警告を出して映像の購読を継続する」動作は harness 側で確認する)
- 実リレー経由の音声 object の到達は相互運用 harness で検証する。harness の publisher 役は
  映像しか配信しないため、**devtools publisher (`audioSource=dummy`) と devtools
  subscriber を向かい合わせる**。harness 側には URL クエリで `audioSource` を渡す変更と
  音声統計の assert を足す。この作業は相互運用 harness 側の issue として起票する

## 完了条件

moqt-js 側で確認する。

- devtools の publisher が `audioSource: "dummy"` で音声トラックを配信し、catalog に
  `role: "audio"` / `codec` / `samplerate` / `channelConfig` / `bitrate` が載る
- トグルが無効なときは `<audio>` の `srcObject` が未設定で、有効にすると設定され
  `paused === false` になる。実際に音が鳴ることは手元で確認する (CI では判定しない)
- 音声トラックを持たない catalog では音声の購読を開始しない (単体テストで固定する)
- 上記を検証する単体テストと `tests/e2e/` のテストがある (リレーは起動しない)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

相互運用 harness 側の音声対応 issue で確認する (本 issue では harness を変更しない)。

- 実リレー経由で devtools の subscriber に音声 object が到達し、その音声トラックを購読して
  復号できる (`window.moqtDevTools` の `audioObjectsReceived` と `audioChunksDecoded` が
  増える)
- 受信した LOC Audio Level が signal `audioLastLevel` に保持される (Audio Level が
  載っていない object を受けたときは `null` になる)
- 音声を持たない catalog の publisher (harness の publisher、`--no-audio` 付きの moqt-rs の
  publisher) に対しても、警告を出して映像の購読を継続する

## 参照

- draft-ietf-moq-msf-01 §5.2.6 (Track role) / §5.2.18 (Codec) / §5.2.22 (Maximum Bitrate) /
  §5.2.28 (Audio sample rate) / §5.2.29 (Channel configuration)
- draft-ietf-moq-loc-04 §2.3.3 (Audio Properties) / §2.3.3.1 (Audio Config) /
  §2.3.3.2 (Audio Level) / §4.1 (Application with one audio track)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions: 音声トラックの SUBSCRIBE と object の
  受信の根拠)
- RFC 6464 §3 (-dBov と voiceActivity の定義。LOC §2.3.3.2 が参照する)
- `devtools で受信した音声を可視化する` (受信 signal の描画と最終レベルの統計)

## 解決方法

{未着手}
