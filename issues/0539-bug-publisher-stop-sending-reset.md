# Publisher が STOP_SENDING / RESET_STREAM 受信時に購読のデータストリームを reset する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-stop-sending-reset
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §5.1.1 は「The Publisher can remove subscription state as soon as it has received STOP_SENDING. It MUST reset any open streams associated with the SUBSCRIBE.」と定める。現状は publish ロールで peer の STOP_SENDING / RESET_STREAM を検出しても、開いている Subgroup ストリームを reset しない。

## 現状

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の catch は、peer 起因の stream error 処理を `role === "subscribe"` に限定している。
- publish ロールでは `publisherStreams` / `publisherSendQueues` / `closedSubgroups` を閉じる処理が呼ばれず、開いたままのデータストリームが残る。
- `requestStreams` の削除は finally で行われるが、データストリームの後始末は行われない。

## 設計方針

1. publish ロールの受信ループで peer 起因の stream error（STOP_SENDING / RESET_STREAM）を検出したら、当該 requestId に紐づくデータストリームを reset する。
2. 既存の `publishClosePublisherStream` 相当の後始末を再利用し、writer の abort とマップの削除を一貫させる。
3. 二重 reset や既に閉じたストリームへの操作で例外にならないようにする。
4. STOP_SENDING / RESET_STREAM 受信でデータストリームが reset されるテストを追加する。

## 完了条件

- publish ロールで peer の STOP_SENDING / RESET_STREAM を検出したとき、当該購読の Subgroup ストリームが reset されること。
- `publisherStreams` などの state が残留しないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.1 / §3.3.3 / §11.4.3
- `bidiReadRequestStreamMessages`
- `publishClosePublisherStream`
- `publisherStreams` / `publisherSendQueues` / `closedSubgroups`
