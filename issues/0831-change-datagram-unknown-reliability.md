# reliability が不明なセッションでは datagram 指定を許す

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/change-datagram-unknown-reliability
- Polished: 2026-10-26
- Reporter: @voluntas

## 目的

音声の送り方に `delivery: "datagram"` を指定したとき、`reliability` が `"reliable-only"` なら `start()` がエラーになる (`src/createMediaPublisher.ts` の `assertAudioDeliverySupported`)。`reliability` が undefined のときは素通りする。undefined はブラウザが `WebTransport.reliability` を実装していない場合に発生し、現行の「datagram を送れる」とみなす挙動には理由が実装にも docs にも無い。現行の挙動を維持することを決め、理由を実装のコメントと docs に書き、単体テストで固定する。

## 現状

- `src/session.ts` の `reliability` は `transport.reliability` をそのまま返し、属性が無いブラウザでは undefined になる。W3C WebTransport は `reliability` を必須の属性として定義しているが、ブラウザが実装していない場合は属性自体が無い
- ライブラリは undefined を「datagram を送れる」とみなす。実リレーの E2E (`tests/e2e/relay/audio-delivery.spec.ts`) は Chromium で datagram の往復が通っている (送信 502 件 / 受信 501 件、`docs/AV_SYNC_DECISIONS.md` §11)
- devtools の `shouldSendAudioAsDatagram` も undefined を許す
- 単体テストは `"reliable-only"` の 1 ケースだけで、undefined の分岐は固定していない
- 安定版の Chromium (Chrome 155) と Playwright の Chromium 156 は `reliability` を公開していない。Firefox 114 以降と Safari 26.4 は公開している (MDN Browser Compat Data)。undefined はブラウザの実装状況によって発生する

## 設計方針

1. undefined は datagram を送れるものとして許す (現行の挙動を維持する)。理由は次のとおり。

- 属性を実装していないブラウザ (Chromium の安定版や Playwright の Chromium 156 など) があり、拒否するとそれらのブラウザで `delivery: "datagram"` を使えない
- 実リレーの E2E で、Chromium の undefined 経路の datagram 往復が成立している (送信 502 件 / 受信 501 件)
- devtools の `shouldSendAudioAsDatagram` も undefined を許しており、ライブラリだけ拒否すると devtools の datagram が動かない

2. `src/createMediaPublisher.ts` の `assertAudioDeliverySupported` のコメントに、undefined を許す理由と、`"reliable-only"` のときだけ拒否することを書く
3. `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `start()` の失敗条件に、undefined のときは拒否せず datagram で送ることを書く
4. `src/createMediaPublisher.test.ts` に、`reliability` が undefined で `delivery: "datagram"` のときに `start()` が成功する単体テストを追加する。既存の `createStartConnectHarness` を使って、`reliability` を省略したケースを明示的に固定する

## 完了条件

- `reliability` が undefined で `delivery: "datagram"` のときに `start()` が成功することが単体テストで固定されていること
- `assertAudioDeliverySupported` のコメントと `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` / `start()` の失敗条件に、undefined を許す理由が書かれていること
- `vp check` / `vp test run` が通ること

## 参照

- `src/session.ts` の `reliability` / `src/createMediaPublisher.ts` の `assertAudioDeliverySupported` / `src/createMediaPublisher.test.ts` の reliable-only のテスト
- `devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram`
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `start()` の失敗条件
- `docs/AV_SYNC_DECISIONS.md` §11 (音声の配送の E2E の判定) の Datagram の実測 (送信 502 件 / 受信 501 件)
- W3C WebTransport の `reliability` (https://www.w3.org/TR/webtransport/#dom-webtransport-reliability)
- MDN Browser Compat Data の `WebTransport.reliability` (https://github.com/mdn/browser-compat-data/blob/main/api/WebTransport.json)
