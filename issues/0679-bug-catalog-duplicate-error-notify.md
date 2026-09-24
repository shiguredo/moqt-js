# publishCatalog の await 経路で送信 reject が二重に通知される

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-duplicate-error-notify
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` の `publishCatalog` は `await this.catalogPublisher.sendObject(...)` する。`Publisher` の `sendObject` は fail-fast の事前検証違反で「error 通知 + 返値の reject」になる契約なので、reject すると `start()` の catch にも届き、同じ失敗が `onError` に 2 回通知される構造になっている。「1 reject = 1 通知」という不変条件が崩れる。現行の catalog 送信は reject しないため未到達だが、`publishCatalog` が事前検証で reject するようになった時点で顕在化する。0657 はこの await 経路を対象外としている。

## 現状

- `src/createMediaPublisher.ts` の `start()` は `connectToServer` → `createPublishers` → `setupEncoders` → `startProcessingLoops` → `setState` を 1 つの try で囲み、catch で `disposeAllResources` の後に `this.callbacks.onError?.(error)` を呼んで再 throw する
- `publishCatalog` は `createPublishers` の最後 (映像 publisher の作成後) に await される。`start()` の最後ではない
- `publishCatalog` は `catalogPublisher.state === "active"` を確認してから `sendObject({ groupId: 0, objectId: 0, priority: PRIORITY_CATALOG })` を await する (`PRIORITY_CATALOG` は 0)。catalog だけ await するのは、fire-and-forget にすると start 直後に join した subscriber が catalog を参照できない race を踏むためである
- catalog publisher は `{ error: (error) => this.callbacks.onError?.(error) }` 付きで publish される。publisher 側の `handleError` は高レベル API の `onError` に直結している
- `src/publisher.ts` の `sendObject` が返値の reject を伴うのは fail-fast の事前検証違反だけである (`guardSend` の END_OF_TRACK 送信後 / END_OF_GROUP 送信済み Group、`validateSendStatusPayload` の違反)。いずれも `handleError` で通知してから `Promise.reject` する。書き込み失敗などの委譲先の失敗は `src/session/publish.ts` の catch が `handleError` を呼んで resolve する (reject しない)
- `guardSend` の拒否のうち END_OF_TRACK 送信後の判定は値に依存せず、END_OF_GROUP 送信済みの判定は `groupId` の一致だけを条件とする。どちらも catalog 送信 (`groupId` 0) に掛かる条件である。ただし catalog publisher は private (`catalogPublisher`) で、その instance への `sendObject` は `publishCatalog` の catalog 送信 (status を渡さない) だけであり、END_OF_TRACK / END_OF_GROUP は同じ instance への `sendObject` でしか記録されない。現行コードではこの状態を作れないため二重通知はまだ到達しない (0657 も「現行この経路は reject し得ない」としている)。`publishCatalog` が事前検証で reject するようになった時点で顕在化する
- `publisherState === "closed"` のときの `guardSend` は通知せずに同期的に throw する。この経路は `start()` の catch だけが通知するため 1 回で、二重通知にはならない (本 issue の対象外とする)
- 0657 は高レベル API の `void` 送信 2 箇所 (`handleAudioEncodedChunk` / `handleVideoEncodedChunk`) と `audioContext.resume()` / `videoDecoder.reset()` / `reconfigureAudioDecoder` / `reconfigureVideoDecoder` の reject の扱いを定め、`publishCatalog` の await 経路は「通知を重複させない仕組み (reject の由来の分類) は別の設計変更になる」として対象外にしている
- 高レベル API の `void` 送信 2 箇所の通知回数を固定するテストは現存しない。0657 の完了条件で追加される
- `src/publisher.test.ts` は事前検証 reject の型が `ProtocolViolationError` であることと `errors.length === 1` とを同時に固定している。`src/createMediaPublisher.test.ts` は Node に WebTransport が無いため connect 失敗で `start()` の catch を通し、通知 1 回・巻き戻し・再 throw を固定している

## 設計方針

- 0657 の完了後に実装する
- 通知の担い手は publisher 側に固定する (0657 の方針)。高レベル API は「通知済みの error では通知しない」catch にする
- 通知済みかどうかは `src/publisher.ts` の内部に持つ。`handleError` が通知した error を非公開のコレクション (`WeakSet<object>`) に登録し、`src/publisher.ts` が内部向けに判定関数を export する。`start()` の catch は判定関数が真なら `onError` を呼ばずに再 throw する
  - この方式なら `sendObject` の reject 型 (`ProtocolViolationError`) も公開 API (`src/index.ts`) も変えず、既存の期待 (型が `ProtocolViolationError`、事前検証で通知 1 回、start 失敗で通知 1 回) がそのまま通る
  - 印は「publisher 層がこの失敗の通知責任を果たした」ことを示す。高レベル API が作る publisher には必ず `error` コールバック (`this.callbacks.onError` 直結) が配線されるため、印付きは利用者への通知済みでもある。error コールバックを持たない publisher でも印は付くが、高レベル API の経路では使われない
  - `src/session/publish.ts` の ID / priority 検証の reject も `publisher.handleError` を通るため、同じ印が付く。由来の層ごとに型を分ける必要がない
  - closed の同期 throw は印が付かないため `start()` の catch が 1 回通知する (現行どおり)
- 「catalog の送信だけ `start()` の try の外へ出す」案は取れない。await を外すと catalog の書き込み完了を待つ保証が消えて race が戻り、reject も未処理になり、`disposeAllResources` による巻き戻しも走らない
- `start()` の catch は通知の抑止以外の挙動 (巻き戻し、再 throw) を変えない
- `handleError` の通知回数は変えない。印を付けるだけで通知を増減させない
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- fail-fast の事前検証で reject した catalog 送信の `onError` 通知が 1 回になる。現行コードでは catalog 送信を reject させる状態を作れないため、この経路は判定関数と通知回数の Node テストと、`start()` の catch の抑止配線のレビューで確認する
- `handleError` が通知した error は判定関数で真になり、通知していない error は偽になる。判定関数と印のコレクションは `src/publisher.ts` の内部契約に留まり、`src/index.ts` の公開 API に出ない
- `ProtocolViolationError` の公開契約が変わらない (`src/publisher.test.ts` の型と通知 1 回の期待がそのまま通る)
- `start()` 失敗時の通知 1 回と巻き戻しと再 throw が変わらない (`src/createMediaPublisher.test.ts` の既存テストがそのまま通る)
- 高レベル API の `void` 送信 2 箇所 (`handleAudioEncodedChunk` / `handleVideoEncodedChunk`) の通知が変わらない。0657 が追加するテストで確認する
- 検証手段: 判定関数の真偽と通知回数を `src/publisher.test.ts` の Node テストで固定する。catalog 経路の配線 (`publishCatalog` の reject → `start()` の catch の抑止) は、Node に WebTransport が無く `start()` を catalog 送信まで進められないためレビューで確認する (`src/codec/workerConfigure.test.ts` と同じ扱い)
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0657 (高レベル API の送信 reject の伝搬。0657 の完了後に着手する。`void` 送信と resume / reset / reconfigure の通知方針の出所)
- 0677 (Node で駆動できない配線をレビューで確認する前例)
- `src/createMediaPublisher.ts` の `start` / `createPublishers` / `publishCatalog`、`src/publisher.ts` の `sendObject` / `guardSend` / `handleError`、`src/session/publish.ts` の ID / priority 検証

## 解決方法

{未着手}
