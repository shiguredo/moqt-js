# done() と拒否経路の並行で PUBLISH_DONE が二重送信されるレースを解消する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-done-double-send
- Polished: {YYYY-MM-DD}

## 目的

`PublisherImpl.done()` と REQUEST_UPDATE 拒否経路（`bidiTerminatePublishSubscriptionWithUpdateFailed`）が並行すると、`publishSendPublishDone` が二重に走り、PUBLISH_DONE の二重送信や close 失敗による PROTOCOL_VIOLATION 昇格が起こり得る。

## 現状

- `src/session/bidi.ts` の `bidiTerminatePublishSubscriptionWithUpdateFailed` は `publishSendPublishDone` を直接呼び、`PublisherImpl.done()` の `donePromise` を経由しない。
- `PublisherImpl.markClosed()` は以降に呼ばれる `done()` を早期 return させるが、既に `doneInternal` に入っている in-flight の `done()` は中断できない。
- `src/session/publish.ts` の `publishSendPublishDoneCore` は write / close の await 後に `session.requestStreams` を削除するため、二重呼び出しの 2 回目が削除前に `streamInfo` を取得すると二重に write / close する。
- 2 回目の close は close 済み writer に対して source 無しの TypeError で reject し得て、`isPeerStreamError` が false かつセッションが connected のとき `PROTOCOL_VIOLATION` に昇格する。
- GOING_AWAY / INVALID_FILTER の拒否経路も同じヘルパーを共有するため、同様のレースを持つ。

## 設計方針

1. 拒否経路と `done()` で PUBLISH_DONE 送信を一本化する。例として、拒否経路も `PublisherImpl.done()` 相当の排他（`donePromise`）を使う、または `publishSendPublishDoneCore` に requestId 単位の送信済みガードを設ける。
2. 既存の GOING_AWAY / INVALID_FILTER 経路もまとめて保護する。
3. 並行 `done()` と拒否経路で PUBLISH_DONE が 1 回だけ送信されること、close 失敗で PROTOCOL_VIOLATION に昇格しないことを検証するテストを追加する。

## 完了条件

- 並行 `done()` と拒否経路で PUBLISH_DONE が 1 回だけ送信されること。
- close 失敗による PROTOCOL_VIOLATION 昇格が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §9.9 / §9.5.1
- `PublisherImpl.done` / `doneInternal` / `markClosed`（`src/publisher.ts`）
- `bidiTerminatePublishSubscriptionWithUpdateFailed`（`src/session/bidi.ts`）
- `publishSendPublishDone` / `publishSendPublishDoneCore`（`src/session/publish.ts`）
