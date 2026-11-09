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
  - [Media over QUIC Transport](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-23)
  - `draft-23` 対応 (接続時のプロトコル識別子は `moqt-23`)
- Low Overhead Media Container (LOC) 対応
  - [Low Overhead Media Container](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-05)
  - `draft-05` 対応
- MOQT Streaming Format (MSF) 対応
  - [MOQT Streaming Format](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
  - `draft-01` 対応
  - Catalog / Timeline
- C4M (CAT-4-MOQT) 対応
  - [C4M](https://datatracker.ietf.org/doc/html/draft-ietf-moq-c4m-02)
  - `draft-02` 対応
  - MOQT の認可に使う CAT (Common Access Token) 形式のトークンのデコード / 検証 / 発行
  - CBOR / COSE のコーデック (署名 / 検証は Web Crypto API を使う)
  - MSF URI Fragment の `c4m` を `SETUP` の Authorization Token として送出
- 外部依存なし

## 再生 (playout)

受信した音声と映像の再生、到着の揺らぎへの対応、A/V 同期をライブラリが扱います。
`createMediaSubscriber` は受信と復号も含めて組み立てます。復号を自分で扱う場合は、
`createMediaPlayout` に AudioData / VideoFrame を渡します。

現在の経路、遅延の予算、欠落の補間と既知の制約は [音声と映像の再生](docs/PLAYOUT.md)、
呼び出し手順と型は [再生 API](docs/MEDIA_PLAYOUT.md) を参照してください。
数秒の意図した遅延を指定する場合は [購読側の再生遅延](docs/PLAYOUT_DELAY.md) を使います。

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

音声の配送は既定で datagram です。datagram は再送されないため、損失に備えるには
`audio.redundancy` に 2 または 3 を指定してください (1〜3 の整数)。`reliability` が `"reliable-only"` の
セッションでは、音声トラックを渡している場合に `start()` がエラーになるため、Subgroup で
送る場合は `audio.delivery` に `"subgroup"` を指定してください (subgroup では
`redundancy` に 2 または 3 を指定できません)。

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
  // PUBLISH_DONE による購読の終了。statusCode が終了の理由 (draft-ietf-moq-transport-23 §12.4)
  end: (publishDone) => console.log(`track ended: 0x${publishDone.statusCode.toString(16)}`),
  error: (e) => console.error(e),
});

// データ受信待機

await subscriber.unsubscribe();
```

## ドキュメント

[ドキュメント一覧](docs/README.md) から、利用、診断、開発の目的に応じて選べます。

- [高レベル API](docs/HIGH_LEVEL_API.md): MediaStream の配信と視聴
- [再生 API](docs/MEDIA_PLAYOUT.md): AudioData / VideoFrame の再生とライフサイクル
- [低レベル API](docs/LOW_LEVEL_API.md): MOQT Object の送受信
- [MOQT Streaming Format](docs/MSF.md): Catalog、Timeline、認可の入口
- [実装状況](docs/IMPLEMENTATION_STATUS.md): 対応仕様と未対応の機能
- [音声と映像の再生](docs/PLAYOUT.md): 現在の予算、補間、A/V 同期と制約
- [開発と検証](docs/DEVELOPMENT.md): ビルド、単体テスト、E2E、実リレーの設定
- [調査記録](docs/archive/README.md): 測定時点の実装、比較と監査
- [検討中の設計](docs/proposals/README.md): FEC、欠落回復の案、namespace 告知の設計記録

## 動作環境

以下のブラウザで動作確認済みです。

- Google Chrome 最新版
- Microsoft Edge 最新版
- Mozilla Firefox 最新版
- Apple Safari 27.2

> [!NOTE]
> Safari 26.4 の WebTransport には単方向ストリームへの `write()` がフラッシュされない WebKit のバグがありましたが、Safari 27.2 では解消していることを確認しています (配信と購読の両方が動作します)。
> Safari は datagram の送信に現行仕様の `datagrams.createWritable()` だけを実装しており、旧仕様の `datagrams.writable` を持ちません。moqt-js は `createWritable()` を優先し、持たないブラウザでは `writable` へフォールバックするため、Safari でも datagram 配送の音声を配信できます。

> [!NOTE]
> Safari と Firefox は `MediaStreamTrackProcessor` をメインスレッドに公開していないため、音声の取り出しに Web Audio の `AudioWorklet` を使います。2 つの経路の役割は [内部構成](docs/ARCHITECTURE.md#mediapublisher-内部構成) にあります。

> [!NOTE]
> `AudioWorklet` の経路は Safari 相当の WebKit でも動作を確認しています (`vp exec playwright test --project=webkit`)。

## サンプル

[examples/](examples) ディレクトリにサンプルコードがあります。

```bash
vp run dev:examples
```

### high-level-api

高レベル API を使用した Publisher / Subscriber のサンプルです。1 ページで配信と受信を体験できます。

## DevTools

[devtools/](devtools) ディレクトリに開発ツールがあります。画面の文言は英語です。

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
- 共有リンクの MOQT URI の `#msf:` fragment を URI Fragment 欄へ映して表示し、namespace の固定と c4m の track name の反映を行う
- MOQT URI の候補の登録 (MOQT URI 欄をクリックして開くモーダルで複数登録し、チェックした候補から Publisher と各 Subscriber が接続のたびに 1 つを自動で選ぶ。パネルごとに自動 / 固定を選べ、固定した選択は Copy URL でも共有する。選んだ URI はそれぞれのパネルに表示する。候補は OPFS に保存する)
- Namespace の指定 (draft-ietf-moq-transport-23 §8.8 の namespace-name 文字列。フィールドを `-` で並べ、literal で書けない byte は `.hh`。読めない値、予約 namespace、32 フィールド超では理由を出して配信 / 購読を拒否する)
- c4m のトークンのデコード結果 (クレームと moqt スコープ) を Authorization Token の欄に表示する
- c4m の取り込みを解除したときは、moqt-js が SETUP に載せる MOQT URI の c4m も取り除く
- WebCodecs Dedicated Worker 対応 (音声 / 映像、エンコーダー / デコーダー)
- 音声レベルメーター (peak / RMS / 波形)
- 音声と映像の同期再生
- 映像の拡大表示 (ライトボックス: 通常表示の 2 倍の幅 / 全画面)
- Jitter Buffer の有効 / 無効の選択 (LOC の TIMESTAMP に合わせて映像を表示する)
- 再生遅延 (Playback Delay) の動的設定 (Off / 500 / 1,000 / 2,000 / 3,000 / 5,000 / 10,000 ms。接続中も変更できる)
- 音声の再生先の選択
- event timeline のメッセージ送受信
- デバッグパネル (MOQT プロトコルメッセージのログ表示)
- 統計情報の表示 (音声 / 映像 / メッセージ / A/V 同期 / セッション)
  - 遅延の内訳 (到着 / 復号 / 表示の待ち)、音声の再生タイミング、追いつき、損失
  - 音声出力の状態と遅延 (AudioContext の state / サンプルレート / baseLatency / outputLatency)
- 統計情報とデバッグログを LLM へ渡すためのコピー (Copy for LLM)
- 前提から外れた状態の警告の表示 (A/V 同期 / 音声出力 / 再生)
- カタログ情報の表示
- HTTP/2 / HTTP/3 接続判別表示
- PAUSED パラメータ (paused 状態) の表示
- キーフレームリクエスト (NEW_GROUP_REQUEST)
- 設定を URL クエリパラメータで共有

### c4m-devtools

moqt-js を利用した C4M (CAT-4-MOQT) の CAT (Common Access Token) のデコード / 検証 / 発行ツールです。

- トークンのデコード
  - COSE Sign1 / COSE Mac0 / Base64 包みの入力に対応する
  - ヘッダ (format / alg / kid / typ) と、現在時刻に対する有効性を表示する
  - クレーム (iss / sub / aud / exp / nbf / iat / cti / moqt-reval / cnf.ckt / cnf.jkt / catdpop) と `moqt` スコープ (アクション、namespace、track) を表示する
- 署名の検証 (JWK または HMAC の対称鍵。期待する alg と typ を指定できる)
- 認可の判定 (アクション、namespace、track を指定して Allowed / Denied を表示する)
- `cnf` 付きのトークンは DPoP proof を検証しないため、認可の判定は常に Denied になる
- 鍵の生成 (ES256 / ES384 / ES512 / EdDSA の鍵ペアと HMAC-SHA256 の対称鍵) と JWK / secret のコピー
- トークンの発行 (クレームと `moqt` スコープを指定し、COSE 形式で出力する)
  - 発行したトークンはそのままデコーダへ読み込める
  - `cnf` の `jkt` は署名鍵の JWK サムプリント (RFC 7638) から設定できる。`ckt` は COSE Key Thumbprint (RFC 9679) であり、このツールでは算出しない
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

- WebTransport API の存在チェック (静的、接続不要。WebTransportError のコンストラクタの既定値以外の動作は保証しない)
- MDN Browser Compat Data に基づくブラウザ対応バージョンの表示
- WebTransport 接続 / 切断
- 自己署名証明書のハッシュ指定
- 接続オプションの指定 (allowPooling / requireUnreliable / congestionControl / headers / protocols / datagramsReadableType / anticipated streams)
- WebTransport の接続状態とプロパティの表示
  - ready / closed / draining の Promise 状態
  - closed が受け取った closeInfo (closeCode / reason) の表示 (切断後も保持)
  - reliability / congestionControl (インスタンス) / supportsReliableOnly (静的プロパティ)
  - protocol / responseHeaders
- HTTP/2 / HTTP/3 接続判別表示 (reliability 未実装のブラウザは N/A と表示)
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
