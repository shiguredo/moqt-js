# 受信 PUBLISH の応答方向を FIN で閉じない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-responder-fin
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §6.4.2.2 は「An endpoint SHOULD send a FIN promptly after a message when it has nothing further to send on that direction and will not need to respond to a future REQUEST_UPDATE.」と定め、応答側の FIN が要求側のストリーム終端条件になる。受信 PUBLISH の応答方向が開いたまま残ると、要求側は request が完了したと判定できない。

## 現状

- `src/session/incomingPublish.ts` の `incomingPublishCleanupIncomingPublish` は `subReader.releaseLock()` と `subWriter.releaseLock()` だけを行う。`releaseLock` はストリームを閉じないため、応答方向は開いたままになる
- PUBLISH_DONE を受信したときの処理は `src/session/bidi.ts` の `bidiHandlePublishDone` が購読への end 通知だけを行い、応答方向の FIN は送らない
- 送信方向を閉じているのは GOAWAY 経路だけで、`incomingPublishRunStreamSubLoop` から `bidi.closeRequestStreamWriter` を呼んでいる
- そのため PUBLISH_DONE を受信してピアが FIN を送った後も、応答方向は開いたまま残る

## 設計方針

- PUBLISH_DONE 受信後とピア FIN 後の後始末で送信方向を FIN する。`bidi.closeRequestStreamWriter` を使い、`requestStreams` のエントリ削除より先に呼ぶ
- REQUEST_UPDATE に応答する可能性を残す設計にする場合は、その条件と FIN を送らない理由をコメントで明記する。§6.4.2.2 の SHOULD は将来の REQUEST_UPDATE に応答する必要が無い場合に限るためである
- `src/session.test.ts` の `createIncomingPublishStream` に close と abort を記録する `WritableStream` を渡し、正常終了で FIN (close) が送られ RESET (abort) ではないことを固定するテストを追加する

## 完了条件

- 正常終了で応答方向の FIN が送られる
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §6.4.2.2 (送るものが無く将来の REQUEST_UPDATE に応答する必要も無い場合は FIN を速やかに送る SHOULD。応答側の FIN が request 完了の合図になる)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)

## 解決方法

{未着手}
