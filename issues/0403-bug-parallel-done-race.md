# 並行 done() 呼び出しで二重 PUBLISH_DONE 送信と PROTOCOL_VIOLATION 昇格が起きる

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-parallel-done-race
- Polished: 2026-08-16

## 目的

`PublisherImpl.done()` (src/publisher.ts) が並行して 2 回呼ばれた場合に、2 回目の `publishSendPublishDone` (src/session/publish.ts) が requestStreams のエントリを見つけて write / close を試行し、close 失敗が PROTOCOL_VIOLATION に昇格してセッション全体を閉じる経路を塞ぐ。並行 done() による二重 PUBLISH_DONE 送信は draft-ietf-moq-transport-19 §10.11 の「A publisher sends a PUBLISH_DONE message as the final message before closing the subscription's bidi stream」に反するため、アプリの誤用に対するライブラリ側の防御として修正する。

## 現状

- `PublisherImpl.done()` は `onDoneInternal` の await 完了後に `publisherState` を "closed" にするため、並行呼び出しでは両方とも `onDoneInternal` を実行する。`onDoneInternal` (src/session.ts) は `closePublisherStream` → `sendPublishDone` の 2 段階であり、2 回目の `closePublisherStream` は `publisherSendQueues` の Promise チェーンで直列化され no-op になるため、実害は `publishSendPublishDone` の二重実行のみ。
- 1 回目の write / close が完了する前に 2 回目の done() が入ると、2 回目の `publishSendPublishDone` は requestStreams から streamInfo を取得できる (requestStreams からの delete は関数末尾)。既に閉じられた writer への write は失敗して黙殺され、close は source なしのエラーで reject し、PROTOCOL_VIOLATION に昇格してセッションが閉じる (Node の実 WritableStream で実測済み)。
- 修正前はピア FIN 後に requestStreams が即削除されていたため、FIN 後の並行 done() は 2 回とも no-op だった。issue 0370 の「ピア FIN 後の requestStreams 保持」により発現面が拡大したが、FIN 前の並行 done() でも同経路は以前から存在する (pre-existing)。

## 設計方針

- `PublisherImpl.done()` に in-flight ガードを追加する。進行中の done() の Promise を保持し、再入時は同じ Promise を返す方式を採用する (done() の resolve が「PUBLISH_DONE 送信完了まで待つ」意味論を維持するため。no-op 即 resolve では 2 回目の done() が 1 回目の完了前に解決し、呼び出し側の後続処理が誤り得る)。
- `onDoneInternal` が reject した場合はガードをリセットし、以後の done() で再試行を許す (現状の「reject 後も `publisherState` が "active" のまま」の意味論を維持する)。
- `unsubscribe()` (src/subscriber.ts) と同様の state ガードでは並行呼び出しを防げないため、実行中フラグまたは Promise の保持が必要。
- 修正コストは 1 関数内の数行で済む。
- 変更対象ファイル: `src/publisher.ts` (`PublisherImpl.done()`)、`src/publisher.test.ts` / 該当テスト (テスト追加)、`CHANGES.md`。
- 関連: `issues/0404-bug-done-session-close-race.md` は `session.close()` と done() の並行レース (セッションが既に閉じている状態) を扱い、修正対象が隣接する (`publishSendPublishDone` の close 失敗昇格経路)。0403 は done() × done()、0404 は session.close() × done() であり、どちらを先に実装しても干渉しない。0404 の sessionState 再確認では本 issue のレース (セッションは "connected" のまま) は防げない。

## 完了条件

- 並行して done() を 2 回呼んでも、PUBLISH_DONE が二重に送信されないこと。
- 並行 done() で PROTOCOL_VIOLATION が発生せず、セッションが閉じないこと。
- テストがあること (`src/publisher.test.ts` で並行 done() 呼び出しによる `onDoneInternal` の 1 回実行を検証し、実ストリーム注入方式で並行 done() 呼び出しの `publishSendPublishDone` が 1 回だけ実行されることを統合テストで検証)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE)
- 関連: `issues/0404-bug-done-session-close-race.md`（セッション close と done() の並行。本 issue とはトリガーが異なる）
- 関連: `issues/closed/0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（ピア FIN 後の requestStreams 保持）

## 解決方法

未着手。
