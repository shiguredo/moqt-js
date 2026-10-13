# catalog の Subgroup ストリームを Object 送信後に FIN しないため、相手側で DATA_STREAM_TIMEOUT (0x12) になる

- Created: 2026-10-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-subgroup-fin

## 目的

moqt-js の publisher が配信する catalog を、moqt-rs の `moq-sub` で受信すると、catalog を 1 つ受信した約 30 秒後に `Session closed: 0x12 data stream timeout expired` でセッションが閉じる。映像はその直前まで届いており (実測で 1200 フレームまで描画)、切断の原因は開いたままの catalog の Subgroup ストリームである。配信と受信は Ctrl+C まで続ける想定であり、この終了は起きてはならない。

draft-ietf-moq-transport-22 §11.3.2 (Closing Subgroup Streams) は "If a sender has delivered all objects in a Subgroup to the QUIC stream ... it MUST close the stream with a FIN." と定める。catalog の Subgroup は 1 Group に 1 Object だけなので、その Object を書き終えた時点で MUST の対象になる。moqt-js は FIN を送っていない。

## 現状

再現手順は次のとおり。接続先の MOQT relay は別途用意する。

```bash
cargo run -p moq-pub -- --url moqt://127.0.0.1:4443 --namespace moq-example --fake-capture-device
cargo run -p moq-sub -- --url moqt://127.0.0.1:4443 --namespace moq-example
```

moqt-rs 側の実装で確認した流れは次のとおり。

- `examples/moq-sub/src/pipeline.rs` は `set_data_stream_timeout_ms(Some(30000))` を設定する。`src/session/goaway.rs` の `Session::tick` は `data_stream_last_activity_ms` の全エントリを走査し、1 本でも `data_stream_timeout_ms` を超えて activity が更新されていなければ `Session::fail` で `SESSION_DATA_STREAM_TIMEOUT` (0x12) を積む。activity を更新するのは stream header と object header の受信であり、FIN / RESET / STOP_SENDING で会計から外れた stream は対象から外れる。
- `examples/moq-sub/src/pipeline.rs` の `read_catalog_objects` は、次の Object が無ければ `receive_registered_stream_data` の `stream.receive_chunk()` で止まる。publisher が FIN を送らなければ 30 秒間 activity が更新されない。
- `examples/moq-pub/src/catalog.rs` の `publish_catalog_object` は `SubgroupWriter::finish` を呼び、catalog object の直後に FIN を送る。こちらは §11.3.2 の MUST を満たしており、同じ 30 秒の設定でも切れない。

moqt-js 側の流れは次のとおり。

- `src/createMediaPublisher.ts` の `sendCatalogObject` は `Publisher.sendObject({ groupId, objectId: 0, payload, priority })` を呼ぶだけである。catalog の更新は Group の先頭 Object 1 つだけであり (draft-ietf-moq-msf-01 §5 が、独立した更新を新しい Group の先頭に置く MUST と、同じ Group の Object ID 1 以降を delta とする MUST を定める。moqt-js は delta を送らないため 1 Group = 1 Object になる)、この時点でその Subgroup に載せる Object は無くなっている。
- FIN は `src/session/publish.ts` の `publishSendObjectInternal` が「別の Group の最初の Object を送るとき」に `closeSubgroupStreamWithoutWaiting` を呼ぶ副作用としてしか出ない。catalog で次の Group を送るのは `src/createMediaPublisher.ts` の `republishCatalog` であり、`scheduleCatalogRepublish` の予約による `catalogRepublishIntervalMs` 経過後である。
- `CATALOG_MAX_CACHE_DURATION_MS` (1 時間) に対する `catalogRepublishIntervalMs` の実効値は上限の `CATALOG_REPUBLISH_MAX_INTERVAL_MS` (30 秒) になる。つまり FIN は「相手の timeout と同じ 30 秒」にしか出ず、JavaScript 側の timer の遅れや relay の転送遅延で timeout が先に成立する。実測でもこの順で負けている。
- `src/session/publish.ts` の `publishSendObjectInternal` は、Object を書き終えた時点で「その Subgroup に続く Object が無い」ことを知る手段を持たない。`Publisher` の公開 API にも、開いている Subgroup を明示的に閉じる手段が無い。

`devtools/src/hooks/usePublisher.ts` の `sendCatalogUpdate` は同じ形 (`sendObject({ groupId, objectId: 0, payload })` のみ) で catalog を送り直しており、同じ 30 秒の穴が開いている。

## 設計方針

- catalog object の書き込み完了直後に、その Subgroup ストリームを FIN で閉じる。§11.3.2 の MUST を満たす最小の変更であり、相手側から見れば FIN が 30 秒より先に届く。
- 閉じる判定は Session 側に置く。FIN と RESET の判定 (`omittedObjects`) は `closeSubgroupStreamWithoutWaiting` が既に持つため、同じ判定を再利用する。
- 高レベル API (`src/createMediaPublisher.ts`) と devtools (`devtools/src/hooks/usePublisher.ts`) の両方から使える形にする。devtools は公開 API 経由で catalog を送っているため、低レベル API に閉じる手段が無いと devtools 側だけ直せない。
- Object Status の `END_OF_GROUP` (0x3) を追加で 1 つ送る案は採らない。payload を持てない status 専用の Object が catalog track に載ることになり、購読側 (`src/createMediaSubscriber.ts` の `handleCatalogObject`) が status を見ずに空 payload を catalog として復号しようとする。FIN だけで §11.3.2 の MUST は満たせる。
- 同じ Group に複数の Object を送る track (映像・音声) には影響させない。catalog のように「1 Group = 1 Object」の track だけが閉じる契機を持つ。

## 完了条件

- catalog object の送信完了直後に、その Subgroup ストリームが FIN で閉じられること (`src/session/publish.ts` と実 `WritableStream` を使う単体テストで固定する)。
- catalog の送り直しの間隔 (30 秒) を待たずに FIN が出ること。1 Group に 1 Object だけを送る track で、その Object の書き込み完了時点で FIN が出ることをテストで固定する。
- `devtools/src/hooks/usePublisher.ts` の catalog 送信経路でも同じ API を使い、同じ 30 秒の穴が残っていないこと。
- moqt-rs の `moq-sub` で受信したとき、catalog 受信の約 30 秒後に `0x12 data stream timeout expired` でセッションが閉じないこと (実 relay での確認)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 解決方法

{対応時に記入}
