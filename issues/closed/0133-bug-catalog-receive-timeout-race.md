# Catalog 配送 race で subscriber が catalog receive timeout になる

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`tests/e2e/pubsub.spec.ts` が `Error: catalog receive timeout` で flaky に失敗する (run 25618809325)。`createMediaSubscriber` が catalog 受信を 5 秒待っても受信できないケース。

`createMediaPublisher` 側で catalog object が relay にまだ届いていないタイミングで subscriber が `subscribe + joiningFetch` を発行すると、joining fetch は INVALID_RANGE で失敗し (subscriber 側の onError で握り潰される)、live subscribe では catalog がもう publish 済なので forward されず、永遠に届かない。

## 再現手順

1. `tests/e2e/pubsub.spec.ts` を CI 環境で実行する。
2. publisher 起動後 500 ms で subscriber 起動する設定だが、relay/network のタイミング次第で catalog object が relay にまだ届いていない瞬間に subscriber が join するケースが発生する。
3. 5 秒待っても catalog が届かず `catalog receive timeout` で fail する。

## RFC 根拠

draft-ietf-moq-transport-17 §9.14.2 (Joining Fetches):

> "If no Objects have been published for the track the publisher MUST respond with a REQUEST_ERROR with error code INVALID_RANGE."

draft-ietf-moq-msf-00 §5 (Catalog):

> "A catalog object SHOULD be published only when the availability of tracks changes."
> "Each catalog update MUST be mapped to an MOQT Object."

→ 仕様は「catalog は変更時のみ publish」(SHOULD)、「joining fetch は object がなければ INVALID_RANGE」(MUST)。
仕様が前提とする設計は **catalog を 1 回 publish + relay の `MAX_CACHE_DURATION` でキャッシュさせて後続 subscriber に joining fetch で配る**。
moqt-js は `maxCacheDuration: 3600000n` (1 時間) を設定しているため仕様準拠は取れている。

しかし現状の `Publisher.sendObject(): void` は fire-and-forget で、`createMediaPublisher.publishCatalog()` が `sendObject` を呼んだ瞬間に return する。そのため `publisher.start()` が return しても catalog object はまだ WebTransport stream に書き込まれていない可能性があり、relay に届く前に subscriber が join すると上記 race を踏む。

## 修正方針

仕様準拠の方向で publisher 側を直す:

1. `Publisher.sendObject` の戻り値を `void` から `Promise<void>` に変更する。内部 (`session.ts:sendObject`) は既に `Promise<void>` を返しており、publisher.ts で握り潰しているだけなので、`Publisher` インターフェースにそのまま透過させる。
2. `createMediaPublisher.publishCatalog()` で `await this.catalogPublisher.sendObject(...)` する。
3. `createMediaPublisher.start()` は既に `await this.publishCatalog()` するため、自動的に「catalog object が WebTransport に書き込み完了」してから return するようになる。

これにより publisher.start() の return 時点で catalog 1 オブジェクト分が relay に向けて flush 済になり、現状の race window がほぼ消える (relay への到達は QUIC flow control 次第なので 100% ではないが大幅改善)。

audio/video frame の sendObject は引き続き fire-and-forget で良いが、`typescript/no-floating-promises` ルールが ON のため `void` キーワードを付けて明示する必要がある。

## 影響範囲

- `src/publisher.ts` の `Publisher.sendObject` インターフェース
- `src/publisher.ts` の `PublisherImpl.sendObject` 実装
- `src/createMediaPublisher.ts` の catalog publish と audio/video frame publish 箇所
- 追従が必要な可能性: `devtools/main.ts`, `devtools/src/hooks/usePublisher.ts`, `src/publisher.test.ts`, `src/publisher.prop.ts`

定期再送 (msf §5 SHOULD に違反) は採用しない。subscriber retry は今回は採用せず、将来 publisher 起動より前に subscriber が来るケースを robust にしたい場合に追加検討する。

## 解決方法

修正方針 1-3 をそのまま実装した。

1. `Publisher.sendObject` の戻り値型を `void` から `Promise<void>` に変更した (`src/publisher.ts`)。`PublisherImpl.onSendObject` の型も `(params) => Promise<void>` に変更。session 側の配線 (`src/session.ts`) は内部で既に `Promise<void>` を返していた `sendObject` をそのまま透過させる形にした。
2. `createMediaPublisher.publishCatalog()` で `await this.catalogPublisher.sendObject(...)` するようにした (`src/createMediaPublisher.ts`)。これにより `publisher.start()` の return 時点で catalog 1 オブジェクト分が WebTransport stream への書き込みを完了している。
3. 音声・映像フレームの `sendObject` 呼び出しは引き続き fire-and-forget なので、`typescript/no-floating-promises` を満たすため `void` 演算子で戻り値を明示的に破棄する (`src/createMediaPublisher.ts` の `handleAudioEncodedChunk` / `handleVideoEncodedChunk`)。
4. `src/publisher.prop.ts` の PBT も同様に `void` を付与した。

最終状態: lint 0/0、build / test 全通過。
