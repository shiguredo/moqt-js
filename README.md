# moqt-js

[![npm version](https://badge.fury.io/js/moqt-js.svg)](https://badge.fury.io/js/moqt-js)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?logo=discord&logoColor=white)](https://discord.gg/shiguredo)
[![Tested with fast-check](https://img.shields.io/badge/tested%20with-fast%E2%80%91check%20%F0%9F%90%92-%23282ea9?flat&logoSize=auto&labelColor=%231b1b1d)](https://fast-check.dev/)

> [!WARNING]
> このライブラリは開発中であり、仕様が積極的に変更される場合があります。

> [!WARNING]
> このライブラリは時雨堂が開発している Sora MoQ とのみ疎通確認を行っています。
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
  - 音声と映像の同期再生
  - 受信側の再生 (playout) の実装 (jitter buffer、時間圧縮 / 時間伸長、補間、追いつき)
  - 音声の配送経路の選択 (Subgroup / Datagram)
- Media over QUIC Transport (MOQT) 対応
  - [Media over QUIC Transport](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22)
  - `draft-22` 対応 (接続時のプロトコル識別子は `moqt-22`。Sora MoQ との疎通は実リレーへ接続する E2E テストで確認している)
- Low Overhead Media Container (LOC) 対応
  - [Low Overhead Media Container](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-04)
  - `draft-04` 対応
- MOQT Streaming Format (MSF) 対応
  - [MOQT Streaming Format](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
  - `draft-01` 対応
  - Catalog / Timeline
- C4M (CAT-4-MOQT) 対応
  - [C4M](https://datatracker.ietf.org/doc/html/draft-ietf-moq-c4m-01)
  - `draft-01` 対応
  - CAT (Common Access Token) のトークンのデコード / 検証 / 発行
  - CBOR / COSE のコーデック (署名 / 検証は Web Crypto API を使う)
  - MSF URI Fragment の `c4m` を `SETUP` の Authorization Token として送出
- 外部依存なし

## 実装状況

### Media over QUIC Transport

[draft-ietf-moq-transport-22](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22) の機能実装状況です。

#### MOQT URI

- `moqt://` スキーム
- Fragment Identifier

#### Track Namespace

- 予約 namespace の送信拒否
  - 先頭フィールドが `.` で始まる Track Namespace (`.session` 含む) は publish / subscribe / fetch / trackStatus / subscribeNamespace / subscribeTracks / publishNamespace で送信前に拒否される
  - `.session` namespace と空 Track Name の組み合わせは DOES_NOT_EXIST 相当で拒否される
- 接続の前に送信できる Track Namespace かを検証する `validateTrackNamespaceForSend` を公開する (draft-ietf-moq-transport-22 §8.7 の 32 フィールド上限、各フィールド 1 バイト以上、4,096 バイト上限と、§2.4.3 / §6.5 の予約 namespace)
  - Full Track Name (Track Namespace と Track Name の合計) の 4,096 バイト上限は Track Name を含めて決まるため、Request の送信時に検証する

#### Publisher

- PUBLISH メッセージ
- PUBLISH_DONE メッセージ (Stream Count 対応)
- PUBLISH_STATE_NOTIFY メッセージ (購読状態の変化の通知)
- Object Stream 送信 (Subgroup Header)
- Object Datagram 送信
- Datagram と Subgroup の混在送信
- Publisher Priority
- FORWARD パラメータ (購読の pause / resume)
- Track Properties
  - OBJECT_DELIVERY_TIMEOUT
  - SUBGROUP_DELIVERY_TIMEOUT
  - MAX_CACHE_DURATION
  - DEFAULT_PUBLISHER_PRIORITY
  - DEFAULT_PUBLISHER_GROUP_ORDER
  - DYNAMIC_GROUPS
- EXPIRES パラメータ

#### Subscriber

- SUBSCRIBE メッセージ
- SUBSCRIBE_OK メッセージ
- REQUEST_UPDATE メッセージ
- サブスクリプションのキャンセル (双方向ストリームのクローズ)
- PUBLISH_DONE メッセージ (Status Code と Reason Phrase を `SubscribeCallbacks.end` で通知する)
- Object Stream 受信 (Subgroup Header)
- Object Datagram 受信
- Pending Subgroup Buffer
- FETCH メッセージ
- FETCH_OK メッセージ
- Fetch Group Order (Ascending / Descending)
- Location Filter (0x05 Next Object / 0x01 相対 startGroup / 0x02 絶対開始 / 0x03・0x04 絶対範囲 / 0x00 除去)
- Range Filters (subscribe() / subscribeTracks() / fetch() / update() で送信可能)
  - Subgroup Filter
  - Object ID Filter
  - Priority Filter
  - Object Property Filter
  - Track Property Filter (subscribeTracks() のみ)
- Subscriber Priority
- Group Order (Ascending / Descending)
- OBJECT_DELIVERY_TIMEOUT パラメータ
- SUBGROUP_DELIVERY_TIMEOUT パラメータ
- RENDEZVOUS_TIMEOUT パラメータ
- FILL_TIMEOUT パラメータ (Fetch)
- NEW_GROUP_REQUEST パラメータ
- LARGEST_OBJECT パラメータ (0x09。`Subscriber.largestLocation` として公開し、相対 Location Filter と Next Object の基準にする)
- FILL_PARAMETERS パラメータ (subscribe() の `fill` で live 手前の範囲を fill fetch する)
- INCLUDE_PROPERTIES パラメータ (subscribe() / subscribeTracks() / fetch() / trackStatus() で、応答の OK メッセージと SUBSCRIBE_TRACKS が生む PUBLISH に Track Properties を含めるかを指定する)
- TRACK_NAMESPACE_PREFIX パラメータ (namespace 系の REQUEST_UPDATE で購読する prefix を更新する)

#### コントロールメッセージ

- SETUP
  - AUTHORIZATION_TOKEN Setup Option (REGISTER / USE_VALUE)
  - MAX_AUTH_TOKEN_CACHE_SIZE Setup Option
  - MOQT_IMPLEMENTATION Setup Option
  - MAX_FILTER_RANGES Setup Option
  - MAX_REQUEST_UPDATES Setup Option
  - WebTransport 利用時の AUTHORITY Setup Option / PATH Setup Option の受信拒否 (INVALID_AUTHORITY / INVALID_PATH)
- GOAWAY
  - Timeout 対応
  - リクエストストリーム上での受信
- REQUEST_OK (Track Properties 対応)
- REQUEST_ERROR
  - Retry Interval
  - Redirect Structure
  - REDIRECT / UNSUPPORTED_EXTENSION エラーコード
- PUBLISH_NAMESPACE
- NAMESPACE
- NAMESPACE_DONE
- PUBLISH_SKIPPED
- SUBSCRIBE_NAMESPACE (Namespace 発見)
- SUBSCRIBE_TRACKS (Track 購読)
- TRACK_STATUS
- Parameter Scope 検証 (draft-ietf-moq-transport-22 §9.20.1 の許可パラメータ集合に無い Message Parameter を PROTOCOL_VIOLATION で拒否する)

#### データストリーム

- Subgroup Header (FIRST_OBJECT bit 対応)
- Fetch Header
- Object Datagram
- PADDING Stream / Datagram (受信時破棄)
- Object Status (Normal / End of Group / End of Track)
- Object Properties
  - Prior Group ID Gap / Prior Object ID Gap / Immutable Properties
  - OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT
  - Key-Value-Pairs (Figure 3) の delta encoding
- GREASE

### Low Overhead Media Container

[draft-ietf-moq-loc-04](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-04) の機能実装状況です。

#### LOC Properties

- Timestamp
- Timescale
- Video Config
- Video Frame Marking
- Audio Config
- Audio Level

#### LOC の公開 API

- `LOC` 名前空間として Properties と Object payload の encode / decode を公開する
  - `LOCPropertyId` と各 Property の encode / decode (`encodeVideoProperties` / `decodeAudioProperties` など)
  - Object payload の encode / decode (`encodeLocObjectPayload` / `decodeLocObjectPayload`)
  - Timescale / Video Config / Audio Config は `PublishOptions` で Track Property としても広告できる (draft-ietf-moq-loc-04 Table 1 の Scope: Track, Object)

### MOQT Streaming Format

[draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01) の機能実装状況です。

#### Catalog

- Root
  - version (`draft-01`) / generatedAt / isComplete / tracks
  - publishTracks / initDataList
- Delta Update
  - deltaUpdate (operation 配列形式)
  - add / remove / clone
- Track
  - namespace / name / packaging / isLive
  - packaging: loc / mediatimeline / eventtimeline / moqlog / moqmetrics
  - role / label / lang / eventType
  - targetLatency / buffers / trackDuration
  - initRef / template
  - parentName / parentNamespace
- Track Grouping
  - renderGroup / altGroup / depends
  - temporalId / spatialId
- Codec / Media
  - codec / mimeType
  - width / height / displayWidth / displayHeight
  - framerate / timescale / bitrate / avgBitrate
  - maxGopDuration / maxGroupDuration
  - samplerate / channelConfig
- Encryption / Auth
  - encryptionScheme / cipherSuite / keyId / trackBaseKey
  - authInfo / accessibility
- Publish Track
  - connectionUri / token

#### Timeline

- Media Timeline
- Event Timeline
- Timeline の payload は無圧縮 JSON のみ (MSF_COMPRESSION による圧縮は未実装)

#### MOQ Log / MOQ Metrics

- `MOQLOG` 名前空間として Log track の payload を公開する ([draft-jennings-moq-log-03](https://datatracker.ietf.org/doc/html/draft-jennings-moq-log-03) / draft-ietf-moq-msf-01 §9)
  - エントリのエンコード / デコード (`encodeLogEntry` / `decodeLogEntry`) と、Group ID / Object ID / namespace / track name の算出
- `MOQMETRICS` 名前空間として Metrics track の payload を公開する ([draft-jennings-moq-metrics-02](https://datatracker.ietf.org/doc/html/draft-jennings-moq-metrics-02) / draft-ietf-moq-msf-01 §10)
  - Capture Object と Metric Object のエンコード / デコードと、Group ID / Object ID / namespace / track name の算出

#### C4M

[draft-ietf-moq-c4m-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-c4m-01) の CAT (Common Access Token) の実装状況です。

- `C4M` 名前空間として CBOR (RFC 8949) / COSE (RFC 9052) / CAT / JWK (RFC 7517) のコーデックを公開する
- トークンのデコード (`CatToken.decode` / `decodeCompact` / `decodeCose`) と検証 (`CatToken.verify`)、発行 (`CatTokenBuilder`)
- `moqt` / `moqt-reval` / `catdpop` クレームと、アクション / namespace / track の認可の判定 (`authorizeCatClaims`)
- JWK のデコード / エンコードと、サムプリント (RFC 7638) の算出
- 署名 / 検証は Web Crypto API だけで行い、外部依存を持たない

#### URI / 認可

- MOQT URI の msf fragment の `c4m` (Base64 でエンコードされた C4M トークン) を復号し、`SETUP` の `AUTHORIZATION TOKEN` (Token Type `0x01` = CAT、Alias Type `USE_VALUE`) として送る
  - `options.authorizationToken` を指定した場合はそちらを優先する
- MOQT URI の msf fragment の track-identifier を解析し、Track Namespace、Track Name、parameter を取り出す `parseMsfFragmentValue` と `MsfFragmentValue` を公開する (draft-ietf-moq-msf-01 §11.1)
  - `Session.fragment` が `type === "msf"` のときの `value` (`msf:` を除いた値) を渡す。解析できない値では `Error` を投げる
- `SETUP` に載せたトークンを、catalog の `SUBSCRIBE` / `FETCH` と、catalog の `authInfo` を持つトラックの `SUBSCRIBE` / `REQUEST_UPDATE` にも付与する (draft-ietf-moq-msf-01 §11.4.3)
- `SETUP` に載せたトークンを `PUBLISH` / `PUBLISH_NAMESPACE` にも付与する (draft-ietf-moq-msf-01 §11.4.3)

## 再生 (playout)

MSF は表示の遅れの宣言 (`targetLatency`) を定めますが、実際にどの時刻に鳴らすかを決めるのは購読する側の仕事です。`moqt-js` は受信側の再生 (playout) をライブラリに持ちます。経路の揺らぎで音が途切れる、音声と映像がずれる、といった品質を、アプリケーションごとの実装に任せません。

### 仕組み

- 表示時刻を決める
  - LOC の TIMESTAMP と、トラックごとの「復号の出力の時刻 − TIMESTAMP」の直近 10 秒の最小値から、音声と映像の表示時刻を同じ式で決める (`src/playout/timeline.ts`)
- 音声の jitter buffer の目標遅延を、到着の遅れの分布から決める
  - libwebrtc の NetEq (`delay_manager.cc` / `histogram.cc`) を移植し、到着の遅れの 0.95 分位から目標を求める (`src/playout/audioDelayEstimator.ts`)
  - 実際に鳴った結果 (予定をどれだけ過ぎて鳴ったか、並べすぎで捨てた量) でも目標を補正する (`src/playout/audioDelayFeedback.ts`)
- 間に合わない音を捨てずに詰める
  - 波形の周期性を使った時間圧縮 / 時間伸長 (NetEq の `time_stretch.cc` / `accelerate.cc` / `preemptive_expand.cc` の移植) と、欠けた分の波形の繰り返しによる補間 (`src/playout/audioTimeStretch.ts`)
- 映像は表示時刻を過ぎた最新のフレームを描く
  - 表示待ちのキューが、時間軸の決めた表示時刻に合わせてフレームを選ぶ (`src/playout/buffer.ts` / `src/playout/videoPlayoutSession.ts`)
- 映像を音声に合わせる
  - 「表示時刻 − TIMESTAMP」の差を不感帯 5 ms で制御し、先行する側 (多くの場合 映像) を最大 100 ms まで待たせる
- live から遅れたら復号器を作り直す
  - 復号器に溜まった音は、鳴らす音を捨てても減らない。遅れが続いたら復号器を作り直して live へ戻す (`src/playout/audioReceiveCatchUp.ts`)
- パケロスを配信側の冗長化で吸収する
  - 同じ音声 Object を最大 3 回送り、受信側は同じ識別子 (`groupId` と `objectId`) の 2 回目以降を捨てる。同じ音が重なって鳴ることはない

高レベル API (`createMediaSubscriber`) はこの再生を内部で組み立てるため、アプリケーション側で実装する必要はありません。再生の部品は公開 API (`PlayoutTimeline` / `AudioPlayoutSession` / `VideoPlayoutSession`) としても使えます。詳細は [高レベル API](docs/HIGH_LEVEL_API.md) にあります。

実測の条件と生の表は [音声の再生遅延の実測](docs/AUDIO_PLAYOUT_LATENCY.md)、到達点のまとめと既知の限界は [音声再生の到達点](docs/AUDIO_PLAYOUT_RESULT.md) にまとめています。

## インストール

```bash
pnpm add -E moqt-js
```

## 使い方

### 高レベル API (推奨)

MediaStream を使用した配信 / 受信 API です。WebCodecs API を内部で使用し、エンコード / デコードを自動的に行います。

#### Publisher

```typescript
import { createMediaPublisher } from "moqt-js";

const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });

const publisher = await createMediaPublisher(
  "moqt://example.com/moqt",
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
  "moqt://example.com/moqt",
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

const session = await connect("moqt://example.com/moqt", {
  close: () => console.log("disconnected"),
  error: (e) => console.error(e),
});

const publisher = await session.publish(["live"], "video", { error: (e) => console.error(e) });

await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1, 2, 3]) });
await publisher.done();
```

#### Subscriber

```typescript
import { connect } from "moqt-js";

const session = await connect("moqt://example.com/moqt", {
  close: () => console.log("disconnected"),
  error: (e) => console.error(e),
});

const subscriber = await session.subscribe(["live"], "video", {
  object: (obj) => console.log(obj),
  // PUBLISH_DONE による購読の終了。statusCode が終了の理由 (draft-ietf-moq-transport-22 §12.4)
  end: (publishDone) => console.log(`track ended: 0x${publishDone.statusCode.toString(16)}`),
  error: (e) => console.error(e),
});

// データ受信待機

await subscriber.unsubscribe();
```

## ドキュメント

- [高レベル API](docs/HIGH_LEVEL_API.md): `createMediaPublisher` / `createMediaSubscriber` と、A/V 同期と再生の共有実装の仕様
- [低レベル API](docs/LOW_LEVEL_API.md): `connect()` と `Session` / `Publisher` / `Subscriber` / `Fetcher` の仕様
- [MOQT Streaming Format](docs/MSF.md): Catalog / Timeline の公開 API
- [A/V 同期と再生の決定の記録](docs/AV_SYNC_DECISIONS.md): A/V 同期と再生の閾値の根拠と再考の条件 (開発者向け)
- [音声再生の到達点](docs/AUDIO_PLAYOUT_RESULT.md): 実リレーで測った音声の遅れ、A/V のずれ、パケロス対策と、既知の限界

## 動作環境

以下のブラウザで動作確認済みです。

- Google Chrome 最新版
- Microsoft Edge 最新版
- Mozilla Firefox 最新版

> [!NOTE]
> Apple Safari 26.4 での動作確認を行っています。Safari 26.4 の WebTransport には単方向ストリームへの `write()` がフラッシュされない WebKit のバグがあり、Safari からの配信は動作しません (購読は動作します)。

> [!NOTE]
> 音声の取り出しは、`MediaStreamTrackProcessor` が無いブラウザでは Web Audio の `AudioWorklet` で行います。Safari はこの API を DedicatedWorker にしか公開しておらず (Worker へ `MediaStreamTrack` も渡せません)、WebKit の実装は映像トラック専用です。Firefox は実装していません。この経路は Safari 相当の WebKit でも動作を確認しています (`vp exec playwright test --project=webkit`)。

## ビルド

Node.js 22.22.2 以降が必要です (package.json の `engines`。CI では 22 / 24 / 26 で検証しています)。ビルドとテストには [Vite+](https://github.com/voidzero-dev/vite-plus) の `vp` コマンドを使います。

```bash
vp install
```

`vp install` は `prepare` スクリプト経由で `vp pack` を実行し、`dist/` に `index.js` と `index.d.ts` を生成します。ソースを変更した後にビルドし直す場合は `vp run build` を実行します。

```bash
vp run build
```

### git 依存として取り込む場合

`github:shiguredo/moqt-js#develop` のように git 依存として取り込む場合、git から取得したツリーには `dist/` が含まれないため、消費側で `prepare` の実行を許可する設定が必要です。

- pnpm は `allowBuilds` に許可を与えないと `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` で失敗します。pnpm 11.19.0 以降はリポジトリ URL 形式 (`moqt-js@git+https://github.com/shiguredo/moqt-js.git`) で指定すると、commit が進んでもキーを書き換えずに済みます
- npm 12 は git 依存のスクリプト実行が既定で無効のため、`--allow-git=root` などを指定します

## テスト

```bash
vp test
```

### E2E テスト

Playwright による E2E テストは、実リレーを必要としないもの、実リレーへ接続するもの、
利用側の production ビルドを検証するものに分かれています。

```bash
# 実リレーを必要としないテスト (moqt-devtools / c4m-devtools / webtransport-devtools の UI、codec wrapper)
vp run e2e-test

# 実リレーへ接続するテスト (SETUP の交換、publish / subscribe、FETCH、音声の往復、カタログ)
vp run e2e-test:relay

# 利用側 Vite の production ビルドで worker が起動するかの検証
vp run e2e-test:production
```

`vp run e2e-test:production` は `moqt-js` を `dist` 経由で消費する最小アプリを
production ビルドし、`new Worker` へ渡る参照先が自己完結していることと、実 Chromium の
実 Worker として起動して初期化へ応答することを検証します。`vp run e2e-test:relay` は
実リレーへ接続する production ビルドの検証も含みます。

初回は Chromium をインストールしてください。

```bash
vp exec playwright install --with-deps chromium
```

Safari 相当 (WebKit) の確認は macOS の開発機で実行します。Safari は
`MediaStreamTrackProcessor` をメインスレッドに公開しておらず、音声は Web Audio 経由で
取り出すため (`src/audioSource.ts`)、その経路を実機と同じ WebKit で確かめます。実リレーへ
接続するテストは `TEST_MOQT_URI` が設定されている場合だけ実行します。

```bash
vp exec playwright install webkit
vp exec playwright test --project=webkit
```

Playwright の設定は `.env` があれば読み込みます。実リレーへ接続するテストは、接続先の
`TEST_MOQT_URI` (`moqt://...`) が設定されていない場合は skip します。設定方法は
[.env.example](.env.example) を参照してください。CI では `secrets.TEST_MOQT_URI`
を環境変数として渡し、push と pull request で実行します。

## サンプル

[examples/](examples/) ディレクトリにサンプルコードがあります。

```bash
vp run dev:examples
```

### high-level-api

高レベル API を使用した Publisher / Subscriber のサンプルです。1 ページで配信と受信を体験できます。

## DevTools

[devtools/](devtools/) ディレクトリに開発ツールがあります。画面の文言は英語です。

```bash
# 開発サーバーを起動する (http://localhost:5173/)
vp run dev

# デプロイする成果物をビルドする (devtools/dist/)
vp run build:devtools
```

### オンライン版

<https://moqt-devtools.shiguredo.app/> から利用できます。

- <https://moqt-devtools.shiguredo.app/>: moqt-devtools
- <https://moqt-devtools.shiguredo.app/c4m-devtools.html>: c4m-devtools
- <https://moqt-devtools.shiguredo.app/webcodecs-devtools.html>: webcodecs-devtools
- <https://moqt-devtools.shiguredo.app/webtransport-devtools.html>: webtransport-devtools

### 使用技術

- [TypeScript](https://github.com/microsoft/TypeScript)
- [Preact](https://github.com/preactjs/preact)
  - [@preact/signals](https://github.com/preactjs/signals)
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)
- [Vite+](https://github.com/voidzero-dev/vite-plus)
  - [Vite](https://github.com/vitejs/vite)
  - [Rolldown](https://github.com/rolldown/rolldown)
  - [Vitest](https://github.com/vitest-dev/vitest)
  - [Oxc](https://github.com/oxc-project/oxc)
- [Playwright](https://github.com/microsoft/playwright)
- [fast-check](https://github.com/dubzzz/fast-check)
- moqt-js (devtools は `src/index.ts` を直接参照する)

### moqt-devtools

moqt-js を利用した MOQT の動作確認ツールです。

- Publisher / Subscriber 両方の動作確認
- 表示モード (Publisher のみ / Subscriber のみ)
  - URL クエリ `mode` (`both` / `publisher` / `subscriber`) で切り替える
  - ヘッダーの副題のリンクから、他のモードのページを今の接続設定を載せた URL で新しいタブに開ける
- 複数 Subscriber の同時接続
- 音声の入力元の選択 (ダミー音声 / マイク / 音声なし) とマイクのデバイス選択
- 音声の配送経路の選択 (Subgroup / Datagram)
- 映像の入力元の選択 (ダミー映像 / カメラ映像 / 映像なし) とカメラのデバイス選択
- コーデック選択 (音声: Opus / AAC、映像: VP8 / VP9 / AV1 / H.264 / H.265)
- 解像度 / フレームレート / ビットレート / キーフレーム間隔の設定
- 音声のビットレート / サンプルレート / チャンネル数の設定
- MAX_CACHE_DURATION / targetLatency / renderGroup の設定
- 自己署名証明書のハッシュ指定
- Authorization Token の指定 (Token Type / Alias Type / Token Alias、MSF URL の c4m パラメータ対応)
- MOQT URI の `#msf:` fragment を URI Fragment 欄へ映して表示し、namespace の固定と c4m の track name の反映を行う
- MOQT URI の保存 (Save) と破棄 (Forget)
- Namespace の指定 (draft-ietf-moq-transport-22 §8.8 の namespace-name 文字列。フィールドを `-` で並べ、literal で書けない byte は `.hh`。読めない値、予約 namespace、32 フィールド超では理由を出して配信 / 購読を拒否する)
- c4m のトークンのデコード結果 (クレームと moqt スコープ) を Authorization Token の欄に表示する
- c4m の取り込みを解除したときは、moqt-js が SETUP に載せる MOQT URI の c4m も取り除く
- WebCodecs Dedicated Worker 対応 (音声 / 映像、エンコーダー / デコーダー)
- 音声レベルメーター (peak / RMS / 波形)
- 音声と映像の同期再生
- Jitter Buffer の有効 / 無効の選択 (LOC TIMESTAMP に合わせて映像を表示する)
- 音声の再生先の選択
- event timeline のメッセージ送受信
- デバッグパネル (MOQT プロトコルメッセージのログ表示)
- 統計情報の表示 (音声 / 映像 / メッセージ / A/V 同期 / セッション)
  - 遅延の内訳 (到着 / 復号 / 表示の待ち)、音声の再生タイミング、追いつき、損失
- 統計情報とデバッグログを LLM へ渡すためのコピー (Copy for LLM)
- 前提から外れた状態の警告の表示 (A/V 同期と再生)
- カタログ情報の表示
- HTTP/2 / HTTP/3 接続判別表示
- FORWARD パラメータ (paused 状態) の表示
- キーフレームリクエスト (NEW_GROUP_REQUEST)
- 設定を URL クエリパラメータで共有

### c4m-devtools

moqt-js を利用した C4M (CAT-4-MOQT) の CAT (Common Access Token) のデコード / 検証 / 発行ツールです。

- トークンのデコード
  - compact / COSE Sign1 / COSE Mac0 / Base64 包みの入力に対応する
  - ヘッダ (format / alg / kid / typ) と、現在時刻に対する有効性を表示する
  - クレーム (iss / sub / aud / exp / nbf / iat / cti / moqt-reval / cnf.jkt / catdpop) と `moqt` スコープ (アクション、namespace、track) を表示する
- 署名の検証 (JWK または HMAC の対称鍵。期待する alg と typ を指定できる)
- 認可の判定 (アクション、namespace、track を指定して Allowed / Denied を表示する)
- 鍵の生成 (ES256 / ES384 / ES512 / EdDSA の鍵ペアと HMAC-SHA256 の対称鍵) と JWK / secret のコピー
- トークンの発行 (クレームと `moqt` スコープを指定し、compact / COSE 形式で出力する)
  - 発行したトークンはそのままデコーダへ読み込める
  - `cnf` の `jkt` は署名鍵のサムプリント (RFC 7638) から設定できる
- 鍵はブラウザのタブのメモリ上だけで扱い、保存も送信もしない (テスト専用の鍵であることを画面に明記する)

### webcodecs-devtools

WebCodecs API の動作確認ツールです。moqt-js とは独立しています。

- VideoEncoder / VideoDecoder の動作確認
- ダミー映像 / カメラ映像の選択とカメラデバイスの選択
- コーデック選択 (VP8 / VP9 / AV1 / H.264 / H.265)
- 解像度 / フレームレート / ビットレート / キーフレーム間隔の設定
- Dedicated Worker モード対応 (エンコーダー / デコーダーで独立に選択)
- 入力映像とデコード結果のプレビュー
- 統計情報の表示 (フレーム数、キーフレーム数、総バイト数、平均ビットレート)
- フレームログの表示

### webtransport-devtools

WebTransport API の動作確認ツールです。moqt-js とは独立しています。

- WebTransport API 対応状況の表示 (静的チェック)
- MDN Browser Compat Data に基づくブラウザ対応バージョンの表示
- WebTransport 接続 / 切断
- 自己署名証明書のハッシュ指定
- 接続オプションの指定 (allowPooling / requireUnreliable / congestionControl / headers / protocols / datagramsReadableType / anticipated streams)
- WebTransport の接続状態とプロパティの表示
  - ready / closed / draining の Promise 状態
  - closed が受け取った closeInfo (closeCode / reason) の表示 (切断後も保持)
  - reliability / congestionControl / supportsReliableOnly
  - protocol / responseHeaders
- HTTP/2 / HTTP/3 接続判別表示
- 双方向ストリームの作成と送受信
- 送信専用単方向ストリームの作成と送信
- 受信専用単方向ストリームの受信
- Datagram の送受信
- 接続後の設定 (datagram の max age / max buffered、close() の closeCode / reason)
- 設定を URL クエリパラメータで共有

## 第三者ライセンス

本プロジェクトは WebRTC のアルゴリズムを一部移植しています。ライセンスの全文は [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) を参照してください。

## ライセンス

Apache License 2.0

```text
Copyright 2025 Shiguredo Inc.

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
