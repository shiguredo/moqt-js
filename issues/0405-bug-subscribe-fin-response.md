# subscribe ロールでピアの FIN 受信時に自方向の FIN を送信しない

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-fin-response
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §3.3.2 の SHOULD「A FIN sent by the responder after its response and any subsequent messages for the request signals that the request is complete; if it has not already done so, the requester SHOULD then send a FIN on its direction, gracefully closing the stream.」に適合するため、subscribe ロールでピアの FIN を検出したときに自方向の FIN (writer.close()) を送信する。

## 現状

- `bidiReadRequestStreamMessages` (src/session/bidi.ts) の subscribe ロールでピアの FIN (`reader.read()` が `{ done: true }`) を検出すると、finally で `requestStreams` から削除するのみであり、自方向の FIN (writer.close()) を送信しない。
- ピア (publisher) が PUBLISH_DONE 後に FIN を送った場合、requester である moqt-js は §3.3.2 の SHOULD に従い自方向を FIN で閉じるのが望ましいが、現状は閉じない。リソースの観点ではセッション終了時のクリーンアップで回収されるため、実害は限定的。
- 正常な PUBLISH_DONE 受信経路 (`bidiHandlePublishDone` → `SubscriberImpl.handleEnd`) に影響させないこと。

## 設計方針

- `bidiReadRequestStreamMessages` の subscribe ロールでピア FIN を検出したとき、`requestStreams` から取得した writer を `close()` で閉じる。エラーは黙殺する (既に閉じられている場合があるため)。
- publish ロール (0370 の保持経路) には影響させない。

## 完了条件

- subscribe ロールでピアが FIN を送った場合、自方向の FIN (writer.close()) が送信されること。
- publish ロールでは従来どおり done() に委ねること。
- 正常な PUBLISH_DONE → FIN 経路の挙動が変わらないこと。
- テストがあること。

## 解決方法

未着手。
