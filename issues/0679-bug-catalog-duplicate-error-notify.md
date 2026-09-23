# publishCatalog の await 経路で送信 reject が二重に通知される

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-duplicate-error-notify
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の `publishCatalog` は `await this.catalogPublisher.sendObject(...)` を `start()` の try の中から呼ぶ。`PublisherImpl.sendObject` は失敗時に通知してから reject する契約なので、reject は `start()` の catch にも届き、同じ失敗が `onError` に 2 回通知される。「1 reject = 1 通知」という不変条件が崩れ、利用者の `onError` が重複して呼ばれる。0657 はこの経路を対象外としている。

## 現状

- `src/createMediaPublisher.ts` の `start()` は最後に `await this.publishCatalog()` を呼び、start 全体を try で囲んで catch で `onError` を通知する
- `src/createMediaPublisher.ts` の `publishCatalog` は `this.catalogPublisher.sendObject({ groupId: 0, objectId: 0, payload, priority: 255 })` を await する。送信失敗は reject として `start()` まで伝わる
- `src/publisher.ts` の `sendObject` は、事前検証で `handleError` を呼んでから reject し、委譲先の失敗も catch が `handleError` を呼ぶ。reject 経路は必ず通知を伴う
- 現行の catalog 送信は `groupId` 0 / `objectId` 0 / `priority` 255 固定で事前検証に掛からず、委譲先の送信失敗は catch が通知するため、この経路は現行では reject し得ない。将来 reject するようになった時点で二重通知になる
- 0657 は `start()` の送信 2 箇所 (音声 / 映像) と `resume()` / `reset()` / `reconfigure*` の reject の扱いを定め、`publishCatalog` の await 経路は「通知を重複させない仕組み (reject の由来の分類) は別の設計変更になる」として対象外にしている

## 設計方針

- reject の由来を分類し、通知済みの reject を `start()` の catch が再通知しないようにする。方式は「`PublisherImpl.sendObject` が通知済みであることを示す専用の型で reject し、高レベル API の catch はその型では通知しない」に確定する
- 「catalog の送信だけ catch の対象から外す」案は、将来 `publishCatalog` が事前検証で reject するようになったときに通知が 0 回になるため取れない
- 0645 の `RequestError` は REQUEST_ERROR メッセージの表現なので、その意味を変えないよう専用の型を別に設ける
- 0657 の「通知の担い手は publisher 側に固定する」方針を維持する。高レベル API は通知しない catch で受ける
- `start()` の送信 2 箇所 (音声 / 映像) の「1 reject = 1 通知」が変わらないことを、既存のテストで確認する
- `src/createMediaPublisher.test.ts` に、catalog の送信が reject する publisher を注入して `onError` が 1 回だけ通知されることを固定するテストを追加する
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- catalog の送信が reject しても `onError` は 1 回だけ通知される
- 送信 2 箇所 (音声 / 映像) の「1 reject = 1 通知」が変わらない
- `sendObject` の事前検証による reject は従来どおり通知される
- 専用の型が `src/index.ts` の公開 API に漏れない (`src/publisher.ts` の内部契約に留める)
- `src/createMediaPublisher.test.ts` に、reject する catalog publisher を注入したテストが追加される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0657 (高レベル API の送信 reject の伝搬。`publishCatalog` の await 経路は対象外とされている)
- 0645 (REQUEST_ERROR の retryInterval と redirect。`RequestError` の意味を変えない対象)
- `src/createMediaPublisher.ts` の `start` / `publishCatalog` / `src/publisher.ts` の `sendObject` / `handleError`

## 解決方法

{未着手}
