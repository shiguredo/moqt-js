# Publisher が STOP_SENDING / RESET_STREAM 受信時に購読のデータストリームを reset する

- Created: 2026-09-08
- Completed: 2026-09-09
- Branch: feature/fix-publisher-stop-sending-reset
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-21 §3.1.1 は「The Publisher can remove subscription state as soon as it has received STOP_SENDING. It MUST reset any open streams associated with the SUBSCRIBE.」と定める。現状は publish ロールで peer の STOP_SENDING / RESET_STREAM を検出しても、開いている Subgroup ストリームを reset しない。

## 現状

- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` の catch は、peer 起因の stream error 処理を `role === "subscribe"` に限定している。publish ロールでは `publisherStreams` / `publisherSendQueues` / `closedSubgroups` を閉じる処理が呼ばれず、開いたままのデータストリームが残る。
- STOP_SENDING と RESET_STREAM は検出点が異なる。STOP_SENDING は peer が当方の送信方向へ送る信号であり、`reader.read()` は reject しない（`src/session/errors.ts` の `isPeerStreamError` の JSDoc、および closed の `issues/closed/0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md` / `issues/closed/0410-bug-subscribe-error-end-not-notified.md` で確定済み）。現状 STOP_SENDING を扱うのは bidi リクエストストリームの write / close 失敗ハンドリングのみで、データストリームの reset には接続していない。RESET_STREAM は `reader.read()` の reject として検出できる。
- `src/session/publish.ts` の `publishClosePublisherStreamInternal` は通常経路が `writer.close()`（FIN）であり、`writer.abort()`（reset 相当）は close の失敗・タイムアウト時のフォールバックに限られる。そのまま再利用すると FIN になり、§3.1.1 の reset MUST を満たさない。
- 後始末の対象は `publisherStreams` / `publisherSendQueues` / `closedSubgroups` に加え、`session.publishers` と `PublisherImpl` の state があるが、現状の reset 経路はこれらを一貫して閉じない。

## 設計方針

1. publish ロールで peer のキャンセルを 2 経路で検出する。
   - RESET_STREAM: `bidiReadRequestStreamMessages` の catch で `reader.read()` の reject を検出する。
   - STOP_SENDING: bidi リクエストストリームの送信方向の失敗（write / close の reject、または `writer.closed` の reject 監視）で検出する。STOP_SENDING は `reader.read()` では検出できないため、受信ループだけに依存しない。
2. 検出したら、当該 requestId に紐づく開いている Subgroup データストリームを `writer.abort()` で reset する。FIN ではなく reset にするため、`publishClosePublisherStreamInternal` の FIN 経路とは別に reset 専用の後始末を新設する（または abort モードを追加する）。
3. 後始末の対象を確定する。`publisherStreams` / `publisherSendQueues` / `closedSubgroups` を削除し、`session.publishers` からも削除して `PublisherImpl` を closed にする。アプリへの通知は既存の購読終了通知と二重にならないようにする。
4. 二重 reset や既に閉じたストリームへの操作で例外にならないようにする。
5. STOP_SENDING 単独（RESET_STREAM を伴わない）と RESET_STREAM の両方でデータストリームが reset されるテストを追加する。

## 完了条件

- publish ロールで peer の STOP_SENDING 単独 / RESET_STREAM を検出したとき、当該購読の Subgroup ストリームが `writer.abort()` で reset されること。
- `publisherStreams` / `publisherSendQueues` / `closedSubgroups` / `publishers` から state が削除され、`PublisherImpl` が closed になること。
- アプリ通知が二重にならないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.1.1 / §6.4.2.3 / §11.3.2
- `bidiReadRequestStreamMessages`（`src/session/bidi.ts`）
- `publishClosePublisherStreamInternal`（`src/session/publish.ts`）
- `publisherStreams` / `publisherSendQueues` / `closedSubgroups` / `publishers`
- `isPeerStreamError`（`src/session/errors.ts`）
- `issues/closed/0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md` / `issues/closed/0410-bug-subscribe-error-end-not-notified.md`（STOP_SENDING の検出点の先行判断）

## 解決方法

publish ロールで peer の STOP_SENDING / RESET_STREAM を検出したとき、開いている Subgroup データストリームを reset し、購読状態を削除するようにした。

- `src/session/publish.ts` に `publishResetPublisherStream` を追加し、`publisherStreams` の writer を `abort` で reset し、`publisherSendQueues` / `closedSubgroups` を掃除する（FIN 経路の `publishClosePublisherStream` とは別）
- `src/session/bidi.ts` の `bidiReadRequestStreamMessages` で、publish ロールのとき `writer.closed` の reject を監視し STOP_SENDING を検出する。RESET_STREAM は `handleRequestStreamReadError` の publish 分岐で検出する
- 検出後の後始末 `handlePublishPeerCancel` で、データストリームの reset、request stream の reset、`publisherStreams` / `publisherSendQueues` / `closedSubgroups` / `publishers` の削除、`PublisherImpl` の closed 化を行う（PUBLISH_DONE は送らない）
- peer キャンセル後にキュー済みの送信が新しい Subgroup ストリームを開かないよう、`publishSendObjectInternal` に closed ガードを追加する
- peer キャンセル済みの購読では `publishSendPublishDoneCore` の close 失敗を PROTOCOL_VIOLATION に昇格しない
- `src/session/bidi.test.ts` に STOP_SENDING 単独 / RESET_STREAM の reset 到達と state 掃除のテスト、`src/session/publish.test.ts` に closed publisher の送信抑止テストを追加する
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
