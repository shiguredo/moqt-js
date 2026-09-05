# close が割り込むと送信側が宣言 payload を欠落させた FIN を送出し得る

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-partial-object-fin
- Polished: 2026-09-05

## 目的

draft-ietf-moq-transport-20 §11.4.3 (Closing Subgroup Streams) の MUST「If a sender closes the stream before delivering all such objects to the QUIC stream, it MUST reset the stream.」のうち、1 オブジェクト内の Object Fields と payload の分割送信に起因する宣言 `payloadLength` 未達の FIN を送信側で排除する。現状の `publishSendObjectInternal` 経路 (`SessionImpl.sendObject` からの委譲先) は Object Fields と payload を別々の `write()` で送信するため、2 つの write の間にセッション close (FIN) が割り込むと、受信側には「宣言 payloadLength を持つ Object の途中バイト + FIN」というワイヤが届く。0427 で受信側に導入した §11.4 判定の観点では、他端を PROTOCOL_VIOLATION で閉じ得る違反ワイヤを自らが送出する状態であり、相互運用上のリスクを排除する。`publisherSendQueues` に残った未送信オブジェクト群を抱えたまま FIN する残キュー経路は本 issue の対象外とし、必要なら別途 issue 化する。

## 現状

- `src/session/publish.ts` の `publishSendObjectInternal` は `streamState.writer.write(data)` (Object Fields) と `streamState.writer.write(params.payload)` を separate な 2 回の await で行う。2 回目の write 前に `SessionImpl.close()` 内のローカル `closeWriterSafely` (`src/session.ts` 定義、呼び出しは publisherStreams に対してのみ) が writer を FIN で閉じる (fire-and-forget で `publisherSendQueues` の drain なし。他ストリームは `abortWriterSafely` で RESET) と、1 回目の write まで成功していれば FIN が payload より先に出る。
- 実測 (0427 レビュー時のプローブ): fields write 成功 → payload write が write 失敗 (実測: TypeError。Node.js では `TypeError [ERR_INVALID_STATE]`) で失敗、ワイヤは `[data:fields, FIN]` となる。エラーは `publishSendObjectInternal` の catch で `closedSubgroups.add` + 再 throw され、外側 `publishSendObject` の catch で `publisher.handleError` に渡されるが、すでに送信済みの partial ワイヤは取り消せない。
- `session.close()` は `publisherSendQueues` の残キューを待たず送信ストリームを閉じるため、delivery timeout や明示的 done() 以外でもこの窓が成立する。
- 対向実装が §11.4 の SHOULD を実装している場合、自側のセッション終了処理だけで対向との会話を壊すことはない (自側は既に閉じている) が、リレー経由の第三者配信や将来の再接続後の挙動解析を混乱させる。

## 設計方針

- Object Fields と payload を 1 回の `write()` で送信する (Uint8Array を連結して単一 write にする)。QUIC/WebTransport のストリーム write はセグメント境界を保証しないため連結は仕様上自由で、2 write 間に close が割り込む窓を構造的に無くす。
- writer が既に閉じている場合 (`write` 失敗) は従来どおり `closedSubgroups.add` + 元エラーの再 throw とする (FIN 済み streams への再送禁止の既存方針と整合)。
- `close()` 時の残キュー破棄順序 (FIN 送出前に完了しているべき送信があるか) は変更しない。本 issue は write 原子性のみにフォーカスする。

## 完了条件

- `sendObject` の Object Fields + payload が単一 write で送信されること (ソース上の 1 write 化と、ワイヤバイト列が従来の 2 write と同一であることを示すテストで検証する。空 payload 時は従来から単一 write のため対象外)。
- 1 回目の `write()` 成功後に `close()` が割り込む interleaving を実 W3C ストリーム注入で確定的に駆動し（deferred writer 等で 2 write 間に close を割り込ませる、モック不使用）、partial ワイヤが生成されないこと。writer が close 済みの状態で `sendObject` を呼ぶだけの事前 close では再現にならないため完了条件としない。失敗時は `publishSendObject` の catch 経路（`closedSubgroups.add` 後に `publisher.handleError` へ渡し、`sendObject` の返却 Promise は reject せず `error` コールバックで通知）で処理されることを確認する。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §11.4.3 (Closing Subgroup Streams / 配信途中での終了は reset MUST)
- draft-ietf-moq-transport-20 §11.4 (Streams / FIN 時の未完成 Object は PROTOCOL_VIOLATION SHOULD)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（受信側判定の導入。解決方法の「残課題」項で発掘を記録）

## 解決方法

未着手。
