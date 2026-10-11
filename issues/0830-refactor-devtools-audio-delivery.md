# devtools の音声の送り方の型と方針をライブラリへ寄せる

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-devtools-audio-delivery
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

同じ「音声の送り方」がライブラリと devtools で二重に定義され、方針も食い違っている。ライブラリは `AudioDelivery` を公開し、reliable-only のセッションでは `start()` がエラーになる (`src/createMediaPublisher.ts` の `assertAudioDeliverySupported`)。devtools は自前の型を持ち (`devtools/src/types.ts`)、reliable-only では黙って Subgroup へ戻す (`devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram`)。型を 1 つにし、方針をライブラリに合わせる。

## 現状

- `devtools/src/types.ts` の `AudioDelivery` は `moqt-js` の同名型と同じ定義である (`devtools/src/signals/connectionSettings.ts` は既に `moqt-js` から型を import している)
- reliable-only のときの挙動が違う。devtools は Subgroup へ戻して送り続けるが、ライブラリは接続の直後にエラーにする
- draft-ietf-moq-transport-22 §6.2 は HTTP/2 上の WebTransport の datagram を reliable and ordered としており、ライブラリの拒否は「送れないから」ではなく「datagram という経路の意味が transport で変わるから」である
- devtools の送り方の選択は URL パラメータ (`audioDelivery`) と `usePublisher` の `sendDatagram` の分岐で行っている

## 設計方針

1. `devtools/src/types.ts` の `AudioDelivery` を削り、`moqt-js` の型を使う
2. reliable-only の扱いをライブラリに合わせる。指定されたら送らず、devtools のエラー表示 (既存の `errors`) に出す。UI の設定 (URL パラメータとトグル) はそのまま残す
3. 変更に伴い devtools の単体テストと E2E (`tests/e2e/devtools-*.spec.ts`) を追従させる

## 完了条件

- `AudioDelivery` の二重定義が無いこと (devtools は `moqt-js` から import する)
- reliable-only のセッションでの挙動がライブラリと同じであることが単体テストで固定されていること
- `vp check` / `vp test run` / `vp run e2e-test` が通ること

## 参照

- `devtools/src/types.ts` の `AudioDelivery` / `devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram` / `devtools/src/hooks/usePublisher.ts` の `sendDatagram` 分岐 / `devtools/src/signals/connectionSettings.ts` の `audioDelivery`
- `src/codec/types.ts` の `AudioDelivery` / `src/createMediaPublisher.ts` の `assertAudioDeliverySupported`
- refs/moq/draft-ietf-moq-transport-22.txt §6.2 / §11
