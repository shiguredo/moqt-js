# moqt-js

[![npm version](https://badge.fury.io/js/moqt-js.svg)](https://badge.fury.io/js/moqt-js)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?logo=discord&logoColor=white)](https://discord.gg/shiguredo)
[![Tested with fast-check](https://img.shields.io/badge/tested%20with-fast%E2%80%91check%20%F0%9F%90%92-%23282ea9?flat&logoSize=auto&labelColor=%231b1b1d)](https://fast-check.dev/)

> [!WARNING]
> このライブラリは開発中であり、仕様が積極的に変更される場合があります。

> [!WARNING]
> このライブラリは時雨堂が開発している MOQT Relay サーバーとのみ疎通確認を行っています。
> 他の MOQT Relay サーバーとの疎通確認は行っておらず、今後も予定はありません。

## About Shiguredo's open source software

We will not respond to PRs or issues that have not been discussed on Discord. Also, Discord is only available in Japanese.

Please read <https://github.com/shiguredo/oss/blob/master/README.en.md> before use.

## 時雨堂のオープンソースソフトウェアについて

利用前に <https://github.com/shiguredo/oss> をお読みください。

## moqt-js について

`moqt-js` はブラウザ向けの Media over QUIC Transport (MOQT) クライアントライブラリです。

## 特徴

- ブラウザ向け MOQT クライアント
  - WebTransport API を利用
  - Publisher / Subscriber 対応
  - 高レベル API (WebCodecs / MediaStream 対応)
- Media over QUIC Transport (MOQT) 対応
  - [Media over QUIC Transport](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport)
  - `draft-07` と `draft-17` 対応
- Low Overhead Container 対応
  - [Media over QUIC - Low Overhead Container](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc)
  - `draft-02` 対応
- MOQT Streaming Format (MSF) 対応
  - [MOQT Streaming Format](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf)
  - `draft-00` 対応
  - Catalog (トラックメタデータ)
- 外部依存なし

## 実装状況

### Media over QUIC Transport

[draft-ietf-moq-transport-17](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-17) の機能実装状況です。

#### Publisher

- PUBLISH メッセージ
- PUBLISH_OK メッセージ
- PUBLISH_DONE メッセージ (Stream Count 対応)
- Object Stream 送信 (Subgroup Header)
- Object Datagram 送信
- Publisher Priority
- Forward State
- DELIVERY_TIMEOUT プロパティ
- MAX_CACHE_DURATION プロパティ

#### Subscriber

- SUBSCRIBE メッセージ
- SUBSCRIBE_OK メッセージ
- REQUEST_UPDATE メッセージ
- UNSUBSCRIBE メッセージ
- Object Stream 受信 (Subgroup Header)
- Object Datagram 受信
- FETCH メッセージ (Standalone)
- FETCH メッセージ (Joining Relative)
- FETCH メッセージ (Joining Absolute)
- FETCH_OK メッセージ
- Subscription Filter (Largest Object)
- Subscription Filter (Next Group Start)
- Subscription Filter (AbsoluteStart)
- Subscription Filter (AbsoluteRange)
- Subscriber Priority
- Group Order (Ascending / Descending)
- DELIVERY_TIMEOUT パラメータ
- RENDEZVOUS_TIMEOUT パラメータ

#### コントロールメッセージ

- SETUP
- GOAWAY (Timeout 対応)
- REQUEST_OK
- REQUEST_ERROR
- PUBLISH_NAMESPACE
- NAMESPACE
- NAMESPACE_DONE
- SUBSCRIBE_NAMESPACE
- TRACK_STATUS

#### データストリーム

- Subgroup Header
- Fetch Header
- Object Datagram
- Object Status (Normal / End of Group / End of Track)
- Object Properties
- Properties (Prior Group ID Gap / Prior Object ID Gap / Immutable Properties)
- GREASE

### Low Overhead Container

[draft-ietf-moq-loc-02](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-02) の機能実装状況です。

#### LOC Properties

- Timestamp
- Timescale
- Video Config
- Video Frame Marking
- Audio Level

### MOQT Streaming Format

[draft-ietf-moq-msf-00](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf) の機能実装状況です。

#### Catalog

- Root
  - version / generatedAt / isComplete / tracks
  - deltaUpdate / addTracks / removeTracks / cloneTracks
- Track
  - namespace / name / packaging / isLive
  - role / label / lang
  - targetLatency / trackDuration
- Track Grouping
  - renderGroup / altGroup / depends
  - temporalId / spatialId / parentName
- Codec
  - codec / mimeType / initData / eventType
- Video
  - width / height / displayWidth / displayHeight
  - framerate / timescale / bitrate
- Audio
  - samplerate / channelConfig / bitrate

#### Timeline

- Media Timeline
- Event Timeline

## インストール

```bash
pnpm add -E moqt-js
```

## 使い方

### 高レベル API (推奨)

MediaStream を使用した簡単な配信・受信 API です。WebCodecs API を内部で使用し、エンコード・デコードを自動的に行います。

#### Publisher

```typescript
import { createMediaPublisher } from "moqt-js";

const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });

const publisher = await createMediaPublisher(
  "https://example.com/moqt",
  {
    namespace: ["live"],
    audio: {
      trackName: "audio",
      codec: "opus",
      bitrate: 128_000,
    },
    video: {
      trackName: "video",
      codec: "h264",
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
    },
  },
  {
    onStateChange: (state) => console.log("state:", state),
    onError: (e) => console.error(e),
  },
);

await publisher.start(stream);

// 配信終了
await publisher.close();
```

#### Subscriber

```typescript
import { createMediaSubscriber } from "moqt-js";

const subscriber = await createMediaSubscriber(
  "https://example.com/moqt",
  {
    namespace: ["live"],
    audio: { trackName: "audio" },
    video: { trackName: "video" },
  },
  {
    onStateChange: (state) => console.log("state:", state),
    onError: (e) => console.error(e),
  },
);

await subscriber.start();

// MediaStream を video 要素に設定
videoElement.srcObject = subscriber.mediaStream;

// 受信終了
await subscriber.close();
```

### 低レベル API

プロトコルレベルの細かい制御が必要な場合に使用します。WebCodecs API や MediaStream API の処理は自前で実装する必要があります。

#### Publisher

```typescript
import { connect } from "moqt-js";

const session = await connect("https://example.com/moqt", {
  close: () => console.log("disconnected"),
  error: (e) => console.error(e),
});

const publisher = await session.publish(["live"], "video", { error: (e) => console.error(e) });

publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1, 2, 3]) });
await publisher.done();
```

#### Subscriber

```typescript
import { connect } from "moqt-js";

const session = await connect("https://example.com/moqt", {
  close: () => console.log("disconnected"),
  error: (e) => console.error(e),
});

const subscriber = await session.subscribe(["live"], "video", {
  object: (obj) => console.log(obj),
  end: () => console.log("track ended"),
  error: (e) => console.error(e),
});

// データ受信待機

await subscriber.unsubscribe();
```

## 動作環境

Chrome 最新版で `--enable-features=EnableWebTransportDraft07` フラグを有効にした状態でのみ動作確認しています。

> [!NOTE]
> Chrome は現時点で WebTransport draft-02 が実装されています。
> moqt-js は draft-07 を必要とするため、上記のフラグが必須です。

### macOS での実行例

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --enable-features=EnableWebTransportDraft07
```

## ビルド

```bash
vp install
vp run build
```

## テスト

```bash
vp test
```

## サンプル

[examples/](examples/) ディレクトリにサンプルコードがあります。

```bash
vp run dev:examples
```

### high-level-api

高レベル API を使用した Publisher / Subscriber のサンプルです。1 ページで配信と受信を体験できます。

## DevTools

[devtools/](devtools/) ディレクトリに開発ツールがあります。

```bash
vp run build
vp dev
```

### オンライン版

<https://moqt-devtools.shiguredo.app/> から利用できます。

### 使用技術

- [TypeScript](https://github.com/microsoft/TypeScript)
- [Preact](https://github.com/preactjs/preact)
  - [@preact/signals](https://github.com/preactjs/signals)
  - [preact-iso](https://github.com/preactjs/preact-iso)
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)
- [Vite+](https://github.com/voidzero-dev/vite-plus)
  - [Vite](https://github.com/vitejs/vite)
  - [Rolldown](https://github.com/rolldown/rolldown)
  - [Vitest](https://github.com/vitest-dev/vitest)
  - [Oxc](https://github.com/oxc-project/oxc)
- [Playwright](https://github.com/microsoft/playwright)
- [fast-check](https://github.com/dubzzz/fast-check)

### moqt-devtools

moqt-js を利用した MOQT の動作確認ツールです。

- Publisher / Subscriber 両方の動作確認
- 複数 Subscriber の同時接続
- ダミー映像 / カメラ映像の選択
- コーデック選択 (VP8 / VP9 / AV1 / H.264 / H.265)
- 解像度 / フレームレート / ビットレート / キーフレーム間隔の設定
- MAX_CACHE_DURATION の設定
- 自己署名証明書のハッシュ指定
- WebCodecs Dedicated Worker 対応
- デバッグパネル (MOQT プロトコルメッセージのログ表示)
- 統計情報の表示 (エンコード/デコードフレーム数、送受信バイト数など)
- カタログ情報の表示
- Forward State の表示
- Joining Fetch 対応
- キーフレームリクエスト (NEW_GROUP_REQUEST)
- 設定を URL クエリパラメータで共有

### webcodecs-devtools

WebCodecs API の動作確認ツールです。moqt-js とは独立しています。

- VideoEncoder / VideoDecoder の動作確認
- ダミー映像 / カメラ映像の選択
- コーデック選択 (VP8 / VP9 / AV1 / H.264 / H.265)
- 解像度 / フレームレート / ビットレート / キーフレーム間隔の設定
- Dedicated Worker モード対応
- 統計情報の表示 (フレーム数、キーフレーム数、総バイト数、平均ビットレート)
- フレームログの表示

### webtransport-devtools

WebTransport API の動作確認ツールです。moqt-js とは独立しています。

- WebTransport 接続 / 切断
- 自己署名証明書のハッシュ指定
- 双方向ストリームの作成と送受信
- 送信専用単方向ストリームの作成と送信
- 受信専用単方向ストリームの受信
- Datagram の送受信

## ライセンス

Apache License 2.0

```text
Copyright 2025-2026, Shiguredo Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
