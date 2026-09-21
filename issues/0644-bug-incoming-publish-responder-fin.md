# 受信 PUBLISH の応答方向を FIN で閉じない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-responder-fin
- Polished: 2026-09-21

## 目的

draft-ietf-moq-transport-21 §6.4.2.2 は「An endpoint SHOULD send a FIN promptly after a message when it has nothing further to send on that direction and will not need to respond to a future REQUEST_UPDATE.」と定め、応答側の FIN が要求側のストリーム終端条件になる。受信 PUBLISH の応答方向が開いたまま残ると、要求側は request が完了したと判定できない。

## 現状

- `src/session/incomingPublish.ts` の `incomingPublishCleanupIncomingPublish` は、`requestStreams` / `subscribers` / `subscribersByAlias` / `receivedRequestUpdateCounts` の削除、fill 関連付けの掃除、`onRequestDrained` を行うが、ストリームに対しては `subReader.releaseLock()` と `subWriter.releaseLock()` だけで close しない。この後始末は `incomingPublishHandleBidirectionalStream` の finally から呼ばれ、正常終了だけでなくピア RESET_STREAM / PROTOCOL_VIOLATION / セッション終了 / unsubscribe でも走る
- ピアの PUBLISH_DONE は `src/session/bidi.ts` の `bidiHandlePublishDone` が処理する。この関数は publish / subscribe / fetch の 3 ロール共用で、購読への終了通知 (エラー status では error 通知も) を行うだけで、応答方向の FIN は送らない。受信 PUBLISH 側の分岐は `incomingPublishRunStreamSubLoop` にあり、共用ハンドラを呼ぶだけである
- 送信方向を閉じているのは GOAWAY 経路だけで、`incomingPublishRunStreamSubLoop` から `bidi.closeRequestStreamWriter` を呼んでいる
- そのため PUBLISH_DONE を受信してピアが FIN を送った後も、応答方向は開いたまま残る

## 設計方針

- `incomingPublishRunStreamSubLoop` の PUBLISH_DONE の分岐の中で、`bidiHandlePublishDone` の直後・`continue` の前に `bidi.closeRequestStreamWriter(session, publishRequestId)` を呼ぶ。PUBLISH_DONE の処理で購読が closed になりループは done 分岐に入らずに抜けるため、分岐の外に置くと実行されない。ピア FIN (読み取りループの done) の分岐でも同じく FIN を呼ぶ。PUBLISH_DONE の分岐では `session.requestStreams` のエントリが残っている。ピア FIN の分岐は unsubscribe 経由 (エントリ削除後に `reader.cancel`) でも到達し得るが、その場合 `closeRequestStreamWriter` は no-op になる (writer は unsubscribe が既に abort している)。ピア FIN の分岐では `rejectPendingRequestUpdates` / `notifySubscriberFailure` より先に FIN を呼び、アプリのコールバック例外で FIN が飛ばない窓を作らない
- FIN は `bidiHandlePublishDone` が正常に戻った後に呼ぶ。この関数が throw した場合 (PUBLISH_DONE のデコード・検証違反、購読終了通知のアプリコールバック例外) は FIN を送らない。デコード・検証違反は現行どおり PROTOCOL_VIOLATION でセッションを閉じる。アプリコールバック例外では購読が `handleEnd` の中で closed になり、`incomingPublishRunStreamSubLoop` の catch は active のときだけ失敗通知するため、通知も FIN も行われない。例外の種類で分岐せず、throw したら FIN を送らない方針にする
- PUBLISH_DONE を受信した後は §9.9 により publisher の方向の最終メッセージであり、将来の REQUEST_UPDATE への応答は不要なので §6.4.2.2 の SHOULD の条件を満たす。PUBLISH_DONE を受信していなくても、ピアが FIN で方向を閉じた後は将来の REQUEST_UPDATE が到着し得ないため同じ条件を満たす。それ以外の経路 (§9.5 の応答 MUST が生きている間) では FIN しない。GOAWAY 経路は既存どおり FIN する
- 呼び出しは await しない。Safari 系の WebTransport では `writer.close()` が解決しない場合があり、待つと後始末 (finally の `incomingPublishCleanupIncomingPublish`) が止まるため (GOAWAY 経路は await しているが、そことは扱いを変える。docs/LOW_LEVEL_API.md で `Publisher.done()` が 5 秒の timeout で FIN 完了待ちを打ち切っているのと同趣旨)
- 後始末 (`incomingPublishCleanupIncomingPublish`) には FIN を置かない。finally から全 exit 経路で走るため、置くとピア RESET_STREAM / PROTOCOL_VIOLATION / セッション終了 / unsubscribe でも FIN が飛ぶ。また後始末の先頭で `requestStreams` を削除するため、削除後では `closeRequestStreamWriter` が no-op になる
- `bidiHandlePublishDone` は 3 ロール共用なので変更しない。変更するのは受信 PUBLISH の経路 (`incomingPublishRunStreamSubLoop`) だけ
- `src/session.test.ts` の `createIncomingPublishStream` は第 4 引数に `writable` を既に受け取れるため、close / abort を記録する `WritableStream` を渡す (ヘルパーの変更は不要)

## 完了条件

- PUBLISH_DONE を受信したとき、応答方向が FIN (close) で閉じられる (RESET (abort) ではない)
- ピア FIN を受信したときも応答方向が FIN で閉じられる
- ピア RESET_STREAM / PROTOCOL_VIOLATION / セッション終了 / unsubscribe の経路では FIN を送らない (unsubscribe は writer を abort し、PROTOCOL_VIOLATION とセッション終了はセッションを閉じる経路が writer を abort する。ピア RESET_STREAM は finally の後始末が releaseLock だけを行う)
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §6.4.2.2 (送るものが無く将来の REQUEST_UPDATE に応答する必要も無い場合は FIN を速やかに送る SHOULD。応答側の FIN が request 完了の合図になる)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE への応答 MUST)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE は publisher がストリームを閉じる前の最終メッセージ)

## 解決方法

{未着手}
