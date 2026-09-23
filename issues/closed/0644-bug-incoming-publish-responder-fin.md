# 受信 PUBLISH の応答方向を FIN で閉じない

- Created: 2026-09-21
- Completed: 2026-09-24
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

- `src/session/incomingPublish.ts` の `processMessages` の PUBLISH_DONE 分岐で、`bidiHandlePublishDone` の直後に `bidi.closeRequestStreamWriter` を呼び、応答方向を FIN で閉じるようにした (§6.4.2.2 の SHOULD。§9.9 により PUBLISH_DONE は publisher 方向の最終メッセージであり、受信後は将来の REQUEST_UPDATE に応答する必要が無い)
- ピア FIN (読み取りループの done) の分岐でも同じく FIN を送る。`rejectPendingRequestUpdates` / `notifySubscriberFailure` より先に呼び、アプリのコールバックに FIN の発行を遅らせない
- `closeRequestStreamWriter` は await しない。Safari 系の WebTransport で `close()` が解決せず、待つと finally の後始末が止まるためである (`writer.close()` は await の前に発行されるため FIN 自体は送られる)。GOAWAY 分岐は読み取りの継続を優先して従来どおり await しており、扱いを意図的に変えている
- 後始末 (`incomingPublishCleanupIncomingPublish`) には FIN を置かない。finally から全 exit 経路で走るため、ピア RESET_STREAM / PROTOCOL_VIOLATION / セッション終了 / unsubscribe でも FIN が飛ぶことを避ける
- ピア RESET_STREAM / ピア起点のセッション終了 / PROTOCOL_VIOLATION / unsubscribe の経路では FIN を送らない (RESET_STREAM と PROTOCOL_VIOLATION とピア起点のセッション終了は catch の時点で購読が active、unsubscribe は writer を abort 済みで requestStreams から削除済み)
- `bidiHandlePublishDone` (3 ロール共用) は変更していない

### 設計方針からの逸脱と、その理由

- 設計方針は「例外の種類で分岐せず、throw したら FIN を送らない」としていたが、アプリのコールバック例外 (`end` / `error` が throw する場合) では購読が `handleEnd` の中で closed になる一方でセッションは開いたままになり、FIN も RESET も送られないため応答方向が半開きで残る (publisher は request の完了を判定できない)。この経路では catch 節が状態ベースの条件 (`impl.state !== "active"` かつ `session.sessionState === "connected"`) で FIN を送るようにした。GOAWAY 分岐がアプリのコールバック例外を黙殺して後始末を続けるのと同じ判断である
- 例外の種類では分岐しない。ピア RESET_STREAM / ピア起点のセッション終了 / PROTOCOL_VIOLATION は catch の時点で購読が active のため条件に入らない

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2546 tests) が通る
- テストは、PUBLISH_DONE で FIN / ピア FIN で FIN / ピア RESET_STREAM では送らない / PUBLISH_DONE が不正なときは送らない / セッション終了では送らない / unsubscribe では送らない / アプリの end・error コールバックが throw しても送る / `close()` が解決しない sink でも処理が完了する、の 8 件を追加し、既存の unsubscribe テストにも FIN が載らないことの assert を足した
- 変異テストで、FIN の削除 (3 経路) / FIN の await 化 / FIN を後始末へ移動 / 条件を常に真 / ガードの削除 / FIN を RESET に変更、のいずれでも対応するテストが失敗することを確認した

## 残した課題

- `session.sessionState === "connected"` ガードは防御であり、テストで直接は固定していない (transport.closed がストリームのエラーより先に処理される順序を想定)
- PUBLISH_DONE を受信した時点で保留中の REQUEST_UPDATE が reject されない (`update()` の Promise が未解決のまま残り得る)。本 issue の範囲外だが、同じ PUBLISH_DONE 分岐の話であり別途扱う
- ピア RESET_STREAM 後は応答方向を開いたまま残す (§6.4.2.3 は受信側の残りの方向を定めていないため)。セッションが長命だと half-open が残る
- 受信 PUBLISH ストリーム上の REQUEST_UPDATE_OK に未知の Mandatory Track Property が載った場合、共有ループの PROTOCOL_VIOLATION 変換を通らずセッションが閉じない (既存の穴)
- GOAWAY 分岐の `await closeRequestStreamWriter` は Safari 系で解決しない可能性がある (本差分の範囲外)
- `docs/LOW_LEVEL_API.md` は受信 PUBLISH の後続処理を `bidiReadRequestStreamMessages` と説明しており応答方向の FIN にも触れていない (本差分の範囲外)
