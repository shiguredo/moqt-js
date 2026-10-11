# reliability が不明なセッションでの datagram 指定の扱いを決める

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/change-datagram-unknown-reliability
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

音声の送り方に `delivery: "datagram"` を指定したとき、`reliability` が `"reliable-only"` なら `start()` がエラーになる (`src/createMediaPublisher.ts` の `assertAudioDeliverySupported`)。しかし `reliability` が undefined のときは素通りする。Chromium は `WebTransport.reliability` を公開しないため、実質すべての環境がこの経路になる (`src/session.ts` は属性が無ければ undefined を返す)。素通りでよいのか、不明なら拒否するのかを決めて固定する。

## 現状

- `src/session.ts` の `reliability` は `transport.reliability` をそのまま返し、属性が無いブラウザでは undefined になる (W3C WebTransport の `reliability` はオプション)
- ライブラリは undefined を「datagram を送れる」とみなす。実リレーの E2E (`tests/e2e/relay/audio-delivery.spec.ts`) は Chromium で datagram の往復が通っている (送信 502 件 / 受信 501 件)
- devtools の `shouldSendAudioAsDatagram` も undefined を許す
- 単体テストは `"reliable-only"` の 1 ケースだけで、undefined の分岐は固定していない

## 設計方針

1. undefined を許す場合: その理由 (属性を公開しないブラウザが多く、実測で datagram の往復が成立している) を実装のコメントと `docs/HIGH_LEVEL_API.md` に書く
2. 拒否する場合: `reliability` を公開しないブラウザでは `delivery: "datagram"` が常にエラーになる影響を `docs/HIGH_LEVEL_API.md` に書き、`start()` の失敗条件にも足す
3. どちらに決めても、undefined のときの分岐を単体テストで固定する (`src/createMediaPublisher.test.ts`)

## 完了条件

- undefined のときの扱いが決まり、理由が実装のコメントと docs に書かれていること
- undefined の分岐が単体テストで固定されていること
- `vp check` / `vp test run` が通ること

## 参照

- `src/session.ts` の `reliability` / `src/createMediaPublisher.ts` の `assertAudioDeliverySupported` / `src/createMediaPublisher.test.ts` の reliable-only のテスト
- `devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram`
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `start()` の失敗条件
- W3C WebTransport の `reliability` (https://www.w3.org/TR/webtransport/#dom-webtransport-reliability)
