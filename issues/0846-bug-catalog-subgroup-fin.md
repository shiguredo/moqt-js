# catalog の Subgroup ストリームを Object 送信後に FIN しないため、相手側で DATA_STREAM_TIMEOUT (0x12) になる

- Created: 2026-10-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-subgroup-fin
- Polished: 2026-10-13

## 目的

moqt-js の publisher が配信する catalog を moqt-rs の `moq-sub` で受信すると、catalog を受信した約 30 秒後に `Session closed: 0x12 data stream timeout expired` でセッションが閉じる。映像はその直前まで届いており、切断の原因は開いたままの catalog の Subgroup ストリームである。配信と受信は Ctrl+C まで続ける想定であり、この終了は起きてはならない。

draft-ietf-moq-transport-22 §11.3.2 (Closing Subgroup Streams) は "If a sender has delivered all objects in a Subgroup to the QUIC stream, except any Objects with Locations smaller than the subscription's Start Location, it MUST close the stream with a FIN." と定める。catalog の Subgroup は 1 Group に 1 Object だけなので、その Object を書き終えた時点で FIN が MUST になる。moqt-js はこれを送っていない。

## 現状

### 再現

moqt-js 側の publisher と moqt-rs 側の subscriber を、同じ MOQT relay に接続する。relay は別途用意する。

```bash
# subscriber (moqt-rs)
cargo run -p moq-sub -- --url moqt://127.0.0.1:4443 --namespace moq-example

# publisher (moqt-js)。devtools の Publish を押すか、examples の高レベル API を起動する
pnpm dev            # http://localhost:5173 で devtools を開き、同じ relay と namespace で Publish
pnpm dev:examples   # examples/high-level-api/main.ts (createMediaPublisher)
```

`moq-pub` (moqt-rs の publisher) では再現しない。`examples/moq-pub/src/catalog.rs` の `publish_catalog_object` は `SubgroupWriter::finish` を呼び、catalog object の直後に FIN を送るためである。publisher 側を moqt-js にする必要がある。

症状は、映像が流れている最中に subscriber が自分からセッションを閉じることである。moqt-rs は `set_data_stream_timeout_ms(Some(30000))` を `examples/moq-sub/src/pipeline.rs` で設定しており、`src/session/goaway.rs` の `Session::tick` が `data_stream_last_activity_ms` の全エントリを走査して、1 本でも期限を超えたら `Session::fail` で `SESSION_DATA_STREAM_TIMEOUT` (0x12) を積む。

### 受信側 (moqt-rs) の挙動

- activity を更新するのは Data Stream 種別 / SubgroupHeader / Object header / fetch header / fetch の Object entry の受信であり、payload の受信では更新しない。`examples/moq-sub/src/pipeline.rs` の `read_catalog_objects` は、次の Object が無ければ `receive_registered_stream_data` の `stream.receive_chunk()` で止まる。この待ちに期限は無い。
- stream は FIN / RESET (`recv_data_stream_closed`) または `send_data_stream_stop_sending` で `data_stream_last_activity_ms` から外れ、timeout の対象外になる。つまり FIN が届けばこの問題は起きない。
- `examples/moq-sub/src/pipeline.rs` の `read_catalog_objects` は、読み取りに失敗したときにだけ `data_plane.send_data_stream_stop_sending` を呼ぶ。正常に次の Object を待っている状態では呼ばれない。

### 送信側 (moqt-js) の挙動

- `src/createMediaPublisher.ts` の `sendCatalogObject` は `Publisher.sendObject({ groupId, objectId: 0, payload, priority })` を呼ぶだけである。catalog の更新は Group の先頭 Object 1 つだけであり (draft-ietf-moq-msf-01 §5 が、独立した更新を新しい Group の先頭に置く MUST と、同じ Group の Object ID 1 以降を delta とする MUST を定める。moqt-js は delta を送らないため 1 Group = 1 Object になる)、この時点でその Subgroup に載せる Object は無くなっている。
- Subgroup の FIN は `src/session/publish.ts` の `publishCloseSubgroupStream` が出す。契機は 3 つある。別 Group の最初の Object を送ったとき (`closeSubgroupStreamWithoutWaiting`)、`ObjectStatus.END_OF_GROUP` の Object を書いたとき、`done()` の `publishClosePublisherStreamInternal` である。セッション終了時の後始末 (`src/session/lifecycle.ts`) でも閉じる。catalog の送信はこのどれも使わないため、次の Group の送信か `done()` までストリームは開いたままになる。
- catalog で次の Group を送る契機は 2 つある。`src/createMediaPublisher.ts` の `scheduleCatalogRepublish` による `catalogRepublishIntervalMs` の経過と、`republishCatalog` を呼ぶ `onForwardStateChange` (FORWARD が 0 から 1 になったとき) である。`CATALOG_MAX_CACHE_DURATION_MS` (1 時間) に対する `catalogRepublishIntervalMs` の実効値は上限の `CATALOG_REPUBLISH_MAX_INTERVAL_MS` (30 秒) であり、FORWARD が 1 のままの通常の配信では 30 秒が FIN の時刻になる。
- 相手側の期限も 30 秒なので、これは競合であって余裕ではない。timer の遅れや relay の転送遅延で timeout が先に成立する。実測ではこの順で負けている (「実測で 1200 フレームまで描画」はフィードバックの報告値であり、この issue では再現していない)。
- `src/session/publish.ts` の `publishSendObjectInternal` は、Object を書き終えた時点で「その Subgroup に続く Object が無い」ことを知る手段を持たない。呼び出し側から通知されない限り閉じられない。`Publisher` インタフェース (`src/publisher.ts`、`src/index.ts` から再エクスポートされる公開型) にも、開いている Subgroup を閉じる手段が無い。
- 映像の Subgroup は既定 2 秒 (`DEFAULT_KEYFRAME_INTERVAL_SECONDS`) のキーフレーム間隔で、音声は 1 フレームごとに Group を進める (`allocateAudioObject` は「音声 chunk 1 つ = Object 1 つ = Group 1 つ」)。どちらも次の Object が 30 秒以内に来るため、この待ちは発生しない。30 秒間隔でしか更新されない catalog だけがこの条件に当たる。
- `devtools/src/hooks/usePublisher.ts` は catalog を 3 経路で送る。初回 (`startPublishing`)、送り直し (`sendCatalogUpdate`)、停止時の complete catalog (`PublishStopPlan` の `sendCompleteCatalog`) である。前の 2 つは `sendObject({ groupId, objectId: 0, payload })` のみで、同じ 30 秒の穴が開いている。停止時は直後の `done()` が FIN を出すため対象外である。
- 購読側の `src/createMediaSubscriber.ts` の `handleCatalogObject` は status を見ずに payload を復号するため、status 専用の Object を catalog track に足す案は購読側の変更を伴う (設計方針を参照)。

## 設計方針

- catalog object の書き込み完了直後に、その Subgroup ストリームを FIN で閉じる。§11.3.2 の MUST を catalog について満たす最小の変更であり、相手側から見れば FIN が 30 秒より先に届く。映像・音声には手を入れない (映像は 2 秒、音声は 1 フレームごとに Group が進むため、この待ちが発生しない)。
- 閉じる契機は呼び出し側から通知する。送信側は「この Object がこの Subgroup の最後である」ことを `sendObject` に伝える。`SendObjectParams` に `endOfGroup?: boolean` を足し、真のときは書き込み完了後に Subgroup を閉じる。`sendDatagram` の `SendDatagramParams.endOfGroup` と同じ意味のオプションであり、公開 API としては追加のみ (後方互換) である。送信が見送られた場合 (`forwardState` が 0、または購読の Location Filter の範囲外) は `publishSendObjectInternal` に入らず閉じない。その Subgroup は省略として記録され、後の Group 切り替えで RESET になる (§11.3.2)。`endOfGroup` は「送信された Object が Subgroup の最後である」ことを示す契約であり、「この Group はもう送らない」という宣言ではない。
- 閉じる処理は `publishSendObjectInternal` の中、書き込みの await の直後に行う。`sendObject` は `session.publisherSendQueues` でトラック単位に直列化されているため、この位置なら同じトラックの後続送信と競合しない。`publishCloseSubgroupStream` は最初の await の前に `session.publisherStreams` から削除するため、後続の Group の送信が待たされることもない。
- `closeSubgroupStreamWithoutWaiting` の判定 (`omittedObjects` による FIN / RESET の選択) をそのまま使う。省略がある Subgroup は RESET、無い Subgroup は FIN になる (§11.3.2)。
- 閉じた Group は `session.closedSubgroups` に登録され、同じ Group への後続 `sendObject` は `ClosedSubgroupError` になる。この経路は `publishSendObject` の catch が `publisher.handleError` に渡すため、返値の Promise は reject せず error 通知だけが届く (`status: END_OF_GROUP` 済み Group への送信が fail-fast の reject になるのとは扱いが異なる)。catalog は Group を進めるため実害は無い。
- FIN の完了は待たない (`closeSubgroupStreamWithoutWaiting` の既存の契約)。`sendCatalogObject` の await が解決する時点で FIN は送信済みだが、ACK は待たない。`done()` が `publishClosePublisherStreamInternal` で完了を待つ既存の形に乗せる。
- `ObjectStatus.END_OF_GROUP` の Object を追加で 1 つ送る案は採らない。draft-ietf-moq-transport-22 §11.1.1 は Normal 以外の status に payload を持たせないため、独立した Object ID をもう 1 つ使うことになる。加えて購読側の `handleCatalogObject` は status を見ずに空 payload を catalog として復号しようとし、`processCatalogPayload` が decode 失敗として `onError` に回す。読み手を増やさず FIN だけで §11.3.2 の MUST を満たせる。
- 高レベル API の `src/createMediaPublisher.ts` の `sendCatalogObject` で `endOfGroup: true` を渡す。devtools の `sendCatalogUpdate` と `startPublishing` の初期送信でも同じオプションを渡す (停止時の complete catalog は `done()` が閉じるため不要)。
- 閉じた後の wire 表現は、Group の最大 Object を載せた Subgroup を FIN で閉じた形になる。ただし SubgroupHeader の END_OF_GROUP ビットは立てない (header は最初の Object の書き込み前に送るため、最後の Object であることを知らない)。このビットを立てていない場合、draft-ietf-moq-transport-22 §11.3.1 が定める「FIN から Group の最終 Object を推論する」経路は使えない。相手側の DATA_STREAM_TIMEOUT の解除は FIN の受信で足りるため、本 issue の目的はこの形で達成できる。

## 完了条件

- `SendObjectParams.endOfGroup` が真のとき、`publishSendObjectInternal` が書き込み完了直後に Subgroup を閉じること。実 `WritableStream` の sink で close / abort を観測する `src/session/publishSubgroupClose.test.ts` と同じ形の単体テストで固定する。
- 省略 (`forwardState` が 0、または購読の Location Filter の範囲外) がある Subgroup を `endOfGroup: true` で閉じた場合に RESET になること (§11.3.2)。
- `endOfGroup: true` を付けた Group へ同じ Group の Object を続けて送ろうとすると、`ClosedSubgroupError` が error 通知として届くこと (返値の Promise は reject しない)。
- catalog の送信が `catalogRepublishIntervalMs` (30 秒) を待たずに FIN を出すこと。`src/createMediaPublisher.ts` の `sendCatalogObject` が `endOfGroup: true` を渡していることと、その送信で FIN が出ることをテストで固定する。
- `devtools/src/hooks/usePublisher.ts` の初回送信 (`startPublishing`) と送り直し (`sendCatalogUpdate`) でも `endOfGroup: true` を渡し、同じ 30 秒の穴が残っていないこと。
- `docs/LOW_LEVEL_API.md` の `Publisher` の表と `sendObject()` の内部実装の節に、新しいオプションを記載すること。
- 実 relay と moqt-rs の `moq-sub` を用意できる環境で、moqt-js の publisher から catalog を受信した約 30 秒後に `0x12 data stream timeout expired` でセッションが閉じないことを確認すること。この確認は moqt-rs を別リポジトリで起動する必要があり、moqt-js の CI と `tests/e2e/relay` (購読側が moqt-js のため 0x12 を検出できない) では自動化できない。手元での確認となり、実施できなかった場合はその旨を PR に記録する。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 解決方法

{対応時に記入}
