# publisher が Group の切り替えごとに前の Subgroup の stream の close 完了を待ち、新しい Group の先頭の送信が 1 RTT 遅れる

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-publisher-group-switch-waits-close
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の publisher で、Group の先頭 (キーフレーム) の送信が毎回 1 RTT 遅れる。受信側では Group の先頭の Object の到着が遅れ、後続の Object もそれに引きずられるため、Group ごとに表示が止まる。

実測 (2026-09-25、手元 relay + 片道 18 ms の遅延 proxy + 配備 devtools の publisher、1280x720 / 30 fps / 2 Mbps、Chrome の NetLog):

- キーフレームの encoder の出力から、publisher の QUIC 接続が新しい uni stream の offset 0 の STREAM フレームを送るまでが、12 Group すべてで 35.8 から 38.7 ms (中央値 36.6 ms、1 RTT = 36 ms)
- encoder の出力の遅れはキーフレームで 1.7 ms、delta で 0.8 ms であり、符号化は原因ではない
- 受信側の到着の遅れの中央値は Group の先頭の Object で約 42 ms、次の Object で約 13 ms、それ以降は約 2 ms

draft-ietf-moq-transport-21 に、Group (Subgroup) を切り替えるときに前の stream の完了を待つ要件は無い。Section 11.3.2 は Subgroup の全 Object を渡した stream を FIN で閉じる (渡し切っていなければ RESET) ことを求め、Section 9.9 は「A sender MUST NOT send PUBLISH_DONE until it has closed all streams it will ever open」とする。前の stream の close の完了を待つ必要があるのは PUBLISH_DONE の前だけである。

## 現状

- `src/session/publish.ts` の `publishSendObjectInternal` は、Group が変わると `await publishCloseSubgroupStream(session, trackAlias)` で前の Subgroup の stream の `writer.close()` の完了を待ってから `createUnidirectionalStream()` で新しい stream を開く
- Chrome の WebTransport の `WritableStreamDefaultWriter.close()` は FIN が ACK されるまで解決しないため、Group の切り替えごとに 1 RTT 送れない
- `publishSendObject` は `publisherSendQueues` で同じトラックの送信を直列化しているため、後続の Object も待たされる
- END_OF_GROUP の Object を送った後の close も同じく完了を待つ
- `publishCloseSubgroupStream` は close のタイムアウト (既定 5 秒) で RESET に切り替え、FIN で閉じられた Subgroup だけを `closedSubgroups` へ登録する

## 設計方針

- 前の stream を FIN と RESET のどちらで閉じるか (Section 11.3.2 の `omittedObjects` の判定) は同期的に決め、FIN の close は完了を待たずに始めて、すぐに新しい stream を開く
- FIN で閉じる Subgroup はその時点で `closedSubgroups` へ登録する。close が失敗またはタイムアウトして RESET に切り替えたときは登録を外す (RESET で閉じた Subgroup への再送を拒否しない従来の扱いを保つ)
- 完了を待たない close はトラックごとに記録し、失敗を黙殺して未処理の reject を出さない
- 購読の終了 (`publishClosePublisherStream`、PUBLISH_DONE の前) は、従来どおり開いている stream の close に加えて、完了を待っていない close もすべて待つ (Section 9.9)
- END_OF_GROUP の後の close も同じく完了を待たない

## 完了条件

- 実ストリームのテストで、前の Subgroup の stream の close が完了する前に、次の Group の stream が開かれて最初の Object が書かれることを固定する
- close が失敗・タイムアウトしたとき RESET に切り替わり、`closedSubgroups` の登録が外れることをテストで固定する
- `publishClosePublisherStream` が完了を待っていない close の完了まで解決しないことをテストで固定する
- `vp check` と全テストが通る
- 配備した devtools で、Group の先頭の Object の到着の遅れが後続の Object と同程度になることを確かめる

## 解決方法

- `src/session/publish.ts` に `closeSubgroupStreamWithoutWaiting` を足した。開いている Subgroup ストリームを FIN と RESET のどちらで閉じるか (§11.3.2 の省略の有無) をその時点で決め、`publishCloseSubgroupStream` を完了を待たずに呼ぶ (publisherStreams からは最初の await の前に削除される)。FIN で閉じる Subgroup はその時点で `closedSubgroups` へ追加し、close が失敗・タイムアウトして RESET に切り替わったら追加を取り消す。`publishCloseSubgroupStream` は reject しないため未処理の reject は出ない
- `publishSendObjectInternal` の Group の切り替えと END_OF_GROUP の後の close をこの関数に置き換えた。新しい Group の stream は前の stream の close の完了を待たずに開く
- 完了を待たない close をトラックごとに `publisherPendingCloses` (BidiSessionInternal / SessionImpl) に記録し、`publishClosePublisherStreamInternal` (購読の終了、PUBLISH_DONE の前) で開いている stream の close に加えてすべての完了を待つ (§9.9)。peer キャンセル (`publishResetPublisherStream`) では記録を捨てる
- テスト (`src/session/publishGroupSwitch.test.ts`、close の完了を呼び出し側が決める実 WritableStream の sink): close の完了前に次の Group の stream が開かれて Subgroup Header と Object が書かれること、END_OF_GROUP の後も同じであること、`publisher.done()` (publishClosePublisherStream) が完了を待たずに始めた close の完了まで解決しないこと、close が失敗したら `closedSubgroups` の登録が外れアプリへ通知しないこと。修正前の `publish.ts` では 4 件とも失敗することを確かめた
- `vp check` と全テスト (132 ファイル / 2674 件) が通った

配備した devtools と配備 relay で、subscriber の main thread で到着 (EncodedVideoChunk の生成) の壁時計と LOC TIMESTAMP の差を遅れとし、Group の中の位置ごとに測った (2026-09-25、同じマシンの publisher と subscriber、1280x720 / 30 fps / 2 Mbps / keyframeInterval 60、1 回 40 秒 約 20 Group、値は測定中の最小の遅れからの差の中央値)。

|               | 先頭 (キーフレーム) | 2 番目  | 3 番目以降 |
| ------------- | ------------------- | ------- | ---------- |
| 修正前 1 回目 | 40.4 ms             | 49.9 ms | 10.6 ms    |
| 修正前 2 回目 | 43.7 ms             | 39.2 ms | 10.8 ms    |
| 修正後 1 回目 | 21.6 ms             | 29.2 ms | 12.7 ms    |
| 修正後 2 回目 | 16.3 ms             | 26.1 ms | 10.1 ms    |

Group の先頭の遅れは約 20 から 25 ms 減った。残る差 (先頭で約 6 から 11 ms、2 番目で約 15 ms) はキーフレームの大きさ (後続の delta の数倍) の送信時間であり、2 番目の Object はキーフレームの送信の後に並ぶ。測定中は relay のホストで CI が動いていた。
