# 並行 done() 呼び出しで二重 PUBLISH_DONE 送信と PROTOCOL_VIOLATION 昇格が起きる

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-parallel-done-race
- Polished: {YYYY-MM-DD}

## 目的

`PublisherImpl.done()` (src/publisher.ts) が並行して 2 回呼ばれた場合に、2 回目の `publishSendPublishDone` (src/session/publish.ts) が requestStreams のエントリを見つけて write / close を試行し、close 失敗が PROTOCOL_VIOLATION に昇格してセッション全体を閉じる経路を塞ぐ。

## 現状

- `PublisherImpl.done()` は `onDoneInternal` の await 完了後に `publisherState` を "closed" にするため、並行呼び出しでは両方とも `onDoneInternal` (publishSendPublishDone) を実行する。
- 1 回目の write / close が完了する前に 2 回目の done() が入ると、2 回目の `publishSendPublishDone` は requestStreams から streamInfo を取得できる。既に閉じられた writer への write は失敗して黙殺され、close は source なしのエラーで reject し、PROTOCOL_VIOLATION に昇格してセッションが閉じる (Node の実 WritableStream で実測済み)。
- 修正前はピア FIN 後に requestStreams が即削除されていたため、FIN 後の並行 done() は 2 回とも no-op だった。issue 0370 の「ピア FIN 後の requestStreams 保持」により発現面が拡大したが、FIN 前の並行 done() でも同経路は以前から存在する (pre-existing)。

## 設計方針

- `PublisherImpl.done()` に in-flight ガードを追加する。進行中の done() の Promise を保持し、再入時は同じ Promise を返す (または no-op) 方式が最小変更。`unsubscribe()` (src/subscriber.ts) と同様の state ガードでは並行呼び出しを防げないため、実行中フラグまたは Promise の保持が必要。
- 修正コストは 1 関数内の数行で済む。

## 完了条件

- 並行して done() を 2 回呼んでも、PUBLISH_DONE が二重に送信されないこと。
- 並行 done() で PROTOCOL_VIOLATION が発生せず、セッションが閉じないこと。
- テストがあること (並行 done() 呼び出しで publishSendPublishDone が 1 回だけ実行されることを検証)。

## 解決方法

未着手。
