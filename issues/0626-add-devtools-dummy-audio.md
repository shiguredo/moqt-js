# devtools にダミー音声の配信と視聴を追加する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-dummy-audio
- Polished: {YYYY-MM-DD}

## 目的

devtools は映像しか扱わない。ダミー映像 (`videoSource: "dummy"`) があるためカメラ無しで
配信と視聴を確認できるが、音声には対応する経路が無い。相互運用の実測で音声トラックを
含む配信を測ろうとすると、マイクを繋いだ実機でしか確認できない。

音声を含む publisher との相互運用 (音声 object の到達、catalog の `role: "audio"` の
解釈、LOC の音声 properties の往復) を、マイク無しで再現できるようにする。

## 現状

### publisher が音声を扱わない

- `devtools/src/hooks/usePublisher.ts` の `getVideoStream` はカメラ経路で
  `getUserMedia({ video: videoConstraints, audio: false })` を呼ぶ。ダミー経路は
  `devtools/src/webcodecs-devtools/utils/dummyVideo.ts` の `createDummyVideoStream` を使う
- `buildPublisherCatalog()` は `createCatalog` へ `role: "video"` のトラック 1 件だけを渡す。
  `role: "audio"` のトラックを作る経路が無い
- AudioEncoder を組み立てる箇所が無い (`devtools/src/hooks/usePublisher.ts` に
  `AudioEncoderWrapper` の import が無い)
- `devtools/src/hooks/usePublisher.test.ts` は「映像トラック 1 件だけを持つ full catalog に
  なる」を固定しており、音声を足すとこの前提が変わる

### subscriber が音声を購読しない

- `devtools/src/hooks/useSubscriber.ts` は catalog から `getVideoTracks(catalog)` で先頭の
  映像トラックだけを取り出して SUBSCRIBE し、`VideoDecoderWrapper` で復号して canvas に
  描く。音声トラックの購読・復号・再生の配線が無い
- 同ファイルに `audio` の記述が 1 つも無い

### ライブラリ側には音声の実装がある

- `src/msf/tracks.ts` の `getAudioTracks(catalog)` は実装済み
- `src/createMediaPublisher.ts` は `mediaStream.getAudioTracks()[0]` から
  `AudioEncoderWrapper` と `MediaStreamTrackProcessor<AudioData>` を組み立て、
  `LOC.encodeAudioProperties` で properties を作る経路を持つ
- `src/createMediaSubscriber.ts` は `AudioDecoderWrapper` と `AudioContext` /
  `MediaStreamAudioDestinationNode` で音声を再生する経路を持つ
- `src/codec/config.ts` に `getAudioEncoderConfig` / `getAudioDecoderConfig` /
  `requiresAudioSpecificConfig` / `DEFAULT_AUDIO_SAMPLE_RATE` / `DEFAULT_AUDIO_CHANNELS`
  がある
- devtools 内では `devtools/src/codec-test/support.ts` の `createSilentAudioData` が
  codec-test ページ用に無音の `AudioData` を作る。無音は「復号結果が無音でも気付けない」
  ため、media 経路のダミーには向かない

## 設計方針

### ダミー音声の生成

- `devtools/src/webcodecs-devtools/utils/dummyAudio.ts` に `createDummyAudioStream` を置き、
  `createDummyVideoStream` と同じく `MediaStream` を返す。カメラ経路 (`getUserMedia`) と
  差し替え可能にする
- 無音ではなく可聴のトーン (例: 440 Hz のサイン波、`AudioContext` +
  `MediaStreamAudioDestinationNode` または `AudioWorklet` で生成) にする。経路が通ったかを
  耳と波形の両方で確認できるようにする
- 設定 (`devtools/src/signals/connectionSettings.ts`) に `audioSource: "none" | "dummy" |
  "microphone"` と、コーデック・ビットレート・サンプルレート・チャンネル数を足す。
  URL クエリからの復元も `initFromUrl` に足す (E2E が URL で指定できるようにするため)
- 既定は `"none"` にする。音声を足すと catalog のトラック数が変わるため、既存の
  相互運用の実測をそのまま保つ

### publisher

- catalog に `role: "audio"` のトラックを足す (`buildPublisherCatalog` を音声の有無で
  切り替える)。codec 文字列は `getAudioEncoderConfig` と一致させる
- AudioEncoder は映像と同じ Worker 設定 (`useDedicatedWorker`) で組み立て、
  `encodeAudioProperties` で properties を作る。Group / Object ID の採番は
  draft-ietf-moq-loc-04 §4.1 の「符号化された audio chunk 1 つが 1 Object になり、
  1 Group に 1 Object、GroupID は chunk ごとに +1、ObjectID は 0」に従う
  (ライブラリの `allocateAudioObject` と同じ規則)

### subscriber

- `getAudioTracks(catalog)` で音声トラックを取り出して SUBSCRIBE し、
  `AudioDecoderWrapper` で復号して `AudioContext` で再生する。Catalog に音声が無い
  場合 (他実装の publisher) は警告ログを出して映像だけ継続する
- LOC の音声 properties は `LOC.encodeAudioProperties` / 対応する decode で扱う
- 統計に音声の受信数とデコード数を足す (`window.moqtDevTools` から読めるようにする)

### テスト

- `buildPublisherCatalog` が音声の有無でトラックを切り替えることを単体テストで固定する
- 生成したトーンの形式 (sampleRate / channels / numberOfFrames) を単体テストで固定する。
  実際の音声出力はブラウザ API 依存のため、E2E で
  `window.moqtDevTools` の音声受信数を観測する
- 相互運用 harness (`e2e-test/browser/relay_interop/`) の devtools 経路に、音声トラックを
  含む catalog を購読して音声 object が届くことを要求するテストを足す

## 完了条件

- devtools の publisher が `audioSource: "dummy"` で音声トラックを配信し、耳で聞こえる
- devtools の subscriber がその音声トラックを購読して再生する
- 音声を持たない catalog を返す publisher (Erlang / moqt-rs など) に対しても、警告を
  出して映像の視聴を継続する
- 上記を検証する単体テストと E2E がある
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.6 (Track role) / §5.2.18 (Codec) / §5.2.29 (Channel configuration)
- draft-ietf-moq-loc-04 §2.3.3 (Audio Properties) / §2.3.3.1 (Audio Config) /
  §4.1 (Application with one audio track)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions) / §3.4 (Fill Semantics)

## 解決方法

{未着手}
