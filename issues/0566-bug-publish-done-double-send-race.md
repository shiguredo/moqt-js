# done() と拒否経路の並行で PUBLISH_DONE が二重送信されるレースを解消する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-done-double-send
- Polished: 2026-09-09

## 目的

`PublisherImpl.done()` と REQUEST_UPDATE 拒否経路（`bidiTerminatePublishSubscriptionWithUpdateFailed`）が並行すると、`publishSendPublishDone` が二重に走り、PUBLISH_DONE の二重送信や close 失敗による PROTOCOL_VIOLATION 昇格が起こり得る。

## 現状

- `src/session/bidi.ts` の `bidiTerminatePublishSubscriptionWithUpdateFailed` は `publisher.markClosed()` の後に `publishSendPublishDone` を直接呼び、`PublisherImpl.done()` の `donePromise` を経由しない。
- `PublisherImpl.markClosed()` は以降に呼ばれる `done()` を早期 return させるが、既に `doneInternal` に入っている in-flight の `done()` は中断できない。
- `src/session/publish.ts` の `publishSendPublishDoneCore` は write / close の await 後に `session.requestStreams` を削除するため、二重呼び出しの 2 回目が削除前に `streamInfo` を取得すると二重に write / close する。
- 2 回目の close は close 済み writer に対して source 無しの TypeError で reject し得て、`isPeerStreamError` が false かつセッションが connected のとき `PROTOCOL_VIOLATION` に昇格する。
- `done()` 経路は `TRACK_ENDED`、拒否経路は `UPDATE_FAILED` を送る。GOING_AWAY / INVALID_FILTER / NOT_SUPPORTED / publisher 不在の拒否経路も同じヘルパーを共有する。

## 設計方針

1. `PublisherImpl` に PUBLISH_DONE を status 付きで排他送信する内部経路を設け、`done()`（`TRACK_ENDED`）と拒否経路（`UPDATE_FAILED`）の双方が同じ `donePromise` 排他を通るようにする（`doneInternal` の一般化、または status 引数付きメソッドの追加）。
2. 排他を先に取得した側だけが PUBLISH_DONE を送る（先着優先）。後着は同じ Promise を await して何もしない。§9.9 の「PUBLISH_DONE は最終メッセージ」を守るため、後着が別 status を重ねて送ることはしない。
3. `done()` が先に完了した場合に §9.5.1 の `UPDATE_FAILED` が送られないのは、購読がアプリ起点で既に正常終了しているためである。この競合の許容根拠をコメントに明記する。
4. `bidiTerminatePublishSubscriptionWithUpdateFailed` は `markClosed()` を直接呼ばず、上記の排他経路に `UPDATE_FAILED` を渡す。`markClosed()` を先に呼ぶと `done()` が早期 return して PUBLISH_DONE が送られない競合を避ける。
5. 並行 `done()` と拒否経路の両順序で PUBLISH_DONE が 1 回だけ送られるテストを追加する。

## 完了条件

- 並行 `done()` と拒否経路で PUBLISH_DONE が 1 回だけ送信されること（両順序）。
- 拒否経路が先に開始した場合は PUBLISH_DONE (`UPDATE_FAILED`)、`done()` が先に開始した場合は PUBLISH_DONE (`TRACK_ENDED`) が送られること。
- close 失敗による PROTOCOL_VIOLATION 昇格が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §9.9 / §9.5.1 / §6.4.2.2
- `PublisherImpl.done` / `doneInternal` / `markClosed`（`src/publisher.ts`）
- `bidiTerminatePublishSubscriptionWithUpdateFailed`（`src/session/bidi.ts`）
- `publishSendPublishDone` / `publishSendPublishDoneCore`（`src/session/publish.ts`）
- `issues/closed/0403-bug-parallel-done-race.md`（done 同士の排他 `donePromise` 導入）
- `issues/closed/0541-bug-fill-parameters-no-fill-stream.md`（拒否経路の `markClosed` 追加元）
