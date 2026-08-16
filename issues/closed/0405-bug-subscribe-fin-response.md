# subscribe ロールでピアの FIN 受信時に自方向の FIN を送信しない

- Created: 2026-08-10
- Completed: 2026-08-16
- Branch: feature/fix-subscribe-fin-response
- Polished: 2026-08-16
- Updated: 2026-08-15

## 目的

draft-ietf-moq-transport-19 §3.3.2 の SHOULD「A FIN sent by the responder after its response and any subsequent messages for the request signals that the request is complete; if it has not already done so, the requester SHOULD then send a FIN on its direction, gracefully closing the stream.」に適合するため、subscribe ロールでピア (publisher) の FIN を検出したときに自方向の FIN (writer.close()) を送信する。

## 現状

- `bidiReadRequestStreamMessages` (src/session/bidi.ts) の subscribe ロールでピアの FIN (`reader.read()` が `{ done: true }`) を検出すると、FIN 検出点で `notifySubscriberFin` (error 通知 + state closed。issue 0374 で追加済み) を実行し、finally で `requestStreams` から削除する。しかし、自方向の FIN (writer.close()) は送信しない。
- ピア (publisher) が PUBLISH_DONE 後に FIN を送った場合、requester である moqt-js は §3.3.2 の SHOULD に従い自方向を FIN で閉じるのが望ましいが、現状は閉じない。リソースの観点では WebTransport 接続終了時にストリームは破棄されるため、実害は限定的 (requestStreams エントリは finally で削除済みであり、セッション close 時の `abortWriterSafely` の対象にはならない)。
- 正常な PUBLISH_DONE 受信経路 (`bidiHandlePublishDone` → `SubscriberImpl.handleEnd`) に影響させないこと。
- なお、受信 PUBLISH 経路 (`src/session.ts` の `runPublishStreamSubLoop`) は moqt-js が responder (SUBSCRIBE_OK 送信側) であり、§3.3.2 の「requester SHOULD then send a FIN」の対象外 (requester はピア) のため、本 issue のスコープ外。

## 設計方針

- `bidiReadRequestStreamMessages` の subscribe ロールでピア FIN を検出したとき、`requestStreams` から取得した writer を `close()` で閉じる。エラーは黙殺する (GOAWAY 受信済みの subscribe ロールでは GOAWAY ハンドラが既に writer.close() 済みであり、再度 close() すると reject するため)。
- close() は FIN 検出点で `notifySubscriberFin` と並べて try/finally で包む配置とする。関数末尾の finally には置かない (0374 の設計判断どおり finally は全 exit 経路 (GOAWAY / PROTOCOL_VIOLATION / RESET_STREAM catch / セッション終了) で実行されるため、ピア FIN 以外の経路でも close() が発火して完了条件 #1 の対象外の挙動になる)。error コールバックが throw した場合でも close() が実行される (0374 のテストは error コールバックが throw するケースを固定している)。
- 正常経路 (PUBLISH_DONE → FIN) も含め、ピア FIN を検出したら無条件に close() する (state ガードは設けない)。ガードを設けると正常経路 (目的の主対象) で FIN が送信されず、完了条件 #1 の字義と相反するため。正常経路では通知挙動のみ既存のまま (end コールバックのみ呼ばれる)。
- 失敗ケース (PUBLISH_DONE なしの FIN) での FIN 送信は、§3.3.2 第 2 段落の SHOULD「An endpoint SHOULD send a FIN promptly after a message when it has nothing further to send on that direction and will not need to respond to a future REQUEST_UPDATE」および requester MAY「A requester, with the exception of the sender of PUBLISH, MAY FIN immediately after sending a message if it will not send a REQUEST_UPDATE」に基づく。
- publish ロール (0370 の保持経路) には影響させない。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の subscribe ロール)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- subscribe ロールでピアが FIN を送った場合、自方向の FIN (writer.close()) が送信されること。
- publish ロールでは従来どおり done() に委ねること。
- 正常な PUBLISH_DONE → FIN 経路の通知挙動 (end コールバックのみ呼ばれ error コールバックは呼ばれず state が closed になること) が変わらないこと。
- 上記を検証するテストがあること (0374 方式の実 W3C ストリーム注入で、sink の close 記録により自方向 FIN 送信を検証)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure)
- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md`（FIN 検出点の終了通知。本 issue はそこから分離された自方向 FIN 応答）
- 関連: `issues/0410-bug-subscribe-error-end-not-notified.md`（subscribe ロールのエラー終了経路。本 issue と同じ `bidiReadRequestStreamMessages` を対象とするため、実装順序・干渉に注意）
- 関連: `issues/closed/0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（publish ロールの requestStreams 保持）

## 解決方法

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の subscribe ロールでピア (publisher) の FIN を検出したとき、`notifySubscriberFin` と並べて try/finally で包み、`requestStreams` から取得した writer を `close()` で閉じて自方向の FIN を送信する (draft-19 §3.3.2 の SHOULD「the requester SHOULD then send a FIN on its direction」)。
- 正常経路 (PUBLISH_DONE → FIN) も失敗ケース (PUBLISH_DONE なしの FIN) も無条件に close() する。error コールバックが throw しても close() が実行されるよう finally で包み、close() 失敗 (GOAWAY 受信済みで既に close 済みの場合の reject) は黙殺する。
- publish ロールには影響させない (role === "subscribe" の中に閉じている)。publish ロールでは従来どおり done() に委ねる。
- テスト: `src/session/bidi.test.ts` に 3 本追加 (subscribe ロールの FIN で自方向 FIN が送信され error 通知される / publish ロールでは自方向 FIN を送信しない / 正常な PUBLISH_DONE → FIN で自方向 FIN が送信され通知挙動が変わらない)。既存テスト 3 本 (error コールバック throw 時の close() 実行 / GOAWAY 後の FIN での二重 close 黙殺 / エラー statusCode の PUBLISH_DONE → FIN での close() 送信) に events 検証を追加した。
