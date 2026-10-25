# devtools の音声の送り方の型と方針をライブラリへ寄せる

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-devtools-audio-delivery
- Polished: 2026-10-26
- Reporter: @voluntas

## 目的

同じ「音声の送り方」がライブラリと devtools で二重に定義され、方針も食い違っている。ライブラリは `AudioDelivery` を公開し、reliable-only のセッションでは `start()` がエラーになる (`src/createMediaPublisher.ts` の `assertAudioDeliverySupported`)。devtools は自前の型を持ち (`devtools/src/types.ts`)、reliable-only では UI にエラーを出さずに Subgroup へ戻す (`devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram`)。型を 1 つにし、方針をライブラリに合わせる。

## 現状

- `devtools/src/types.ts` の `AudioDelivery` は `moqt-js` の同名型と同じ定義である (`devtools/src/signals/connectionSettings.ts` は既に `moqt-js` から他の型を import しており、同じ形で `AudioDelivery` を import できる)
- reliable-only のときの挙動が違う。devtools は Subgroup へ戻して送り続ける (UI にはエラーを出さず、console.warn を 1 回だけ出す) が、ライブラリは接続の直後にエラーにする
- draft-ietf-moq-transport-22 §6.2 は HTTP/2 上の WebTransport の datagram を reliable and ordered としており、ライブラリの拒否は「送れないから」ではなく「datagram という経路の意味が transport で変わるから」である
- devtools の送り方の選択は URL パラメータ (`audioDelivery`) と `usePublisher` の `sendDatagram` の分岐で行っている

## 設計方針

1. `devtools/src/types.ts` の `AudioDelivery` を削り、`moqt-js` の型を使う
2. reliable-only の扱いをライブラリに合わせる。接続後、catalog を publish する前に `session.reliability` が `"reliable-only"` で `audioDelivery` が `"datagram"` なら、音声だけを飛ばして映像を続けるのではなく、`startPublishing` を失敗させる (ライブラリの `start()` と同じく、配信を始めない)。理由は Publisher パネルの既存のエラー表示 (`pubStatus` の `"error"` と `pubStatusMessage` の `"Failed: ..."`) に英語で出す。UI の設定 (URL パラメータと `audio-delivery` のセレクト) はそのまま残す
3. 送信経路に残る reliable-only のフォールバックを削除する。`shouldSendAudioAsDatagram` は `delivery === "datagram"` だけを見るようにし、`buildAudioSendCopyPlan` から `reliability` を外す。`usePublisher` の `loggedAudioDatagramFallback` と console.warn の分岐も削除する (start で拒否するため、送信時には reliability を見ない)
4. 変更に伴い devtools の単体テストと E2E (`tests/e2e/devtools-*.spec.ts`) を追従させる

## 完了条件

- `AudioDelivery` の二重定義が無いこと (devtools は `moqt-js` から import する)
- reliable-only のセッションで `audioDelivery` が `"datagram"` のとき、`startPublishing` が配信を始めず、`pubStatus` が `"error"`、`pubStatusMessage` が `"Failed: ..."` になり、`reliable-only` を含むこと。判定は純粋関数に切り出し、WebTransport の実接続なしで単体テストできること
- `vp check` / `vp test run` / `vp run e2e-test` が通ること

## 参照

- `devtools/src/types.ts` の `AudioDelivery` / `devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram` / `devtools/src/hooks/usePublisher.ts` の `sendDatagram` 分岐と `buildAudioSendCopyPlan` / `devtools/src/signals/connectionSettings.ts` の `audioDelivery` / `devtools/src/components/PublisherPanel.tsx` の `pubStatusMessage`
- `AudioDelivery` を定義・import している devtools のファイル: `devtools/src/types.ts` / `devtools/src/signals/connectionSettings.ts` / `devtools/src/signals/connectionSettingsSnapshot.ts` / `devtools/src/components/ConnectionSettings.tsx` / `devtools/src/hooks/usePublisher.ts` / `devtools/src/utils/audioDelivery.ts`
- `devtools/src/utils/audioDelivery.test.ts` / `devtools/src/hooks/usePublisher.test.ts` の reliable-only のテスト
- `src/codec/types.ts` の `AudioDelivery` / `src/createMediaPublisher.ts` の `assertAudioDeliverySupported`
- refs/moq/draft-ietf-moq-transport-22.txt §6.2 / §11.2
