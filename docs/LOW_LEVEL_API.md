# 低レベル API 実装

## 概要

`moqt-js` の低レベル API は、MOQT の制御メッセージ、データストリーム、データグラムをアプリケーションから直接扱うための層である。高レベル API のような `MediaStream` / `WebCodecs` の抽象化は行わず、`MoqtObject` の `payload` と `properties` をそのまま受け渡す。

公開 API の入口は `connect()` で、返された `Session` から `publish()` / `subscribe()` / `fetch()` / `trackStatus()` / `subscribeNamespace()` / `publishNamespace()` を呼び出す。バイナリの encode / decode は `src/message/*`、`src/controlStream.ts`、`src/dataStream.ts` に分離され、`SessionImpl` がそれらを束ねている。

## API 階層

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 高レベル API (MediaStream / WebCodecs)                              │
│                                                                      │
│ createMediaPublisher() / createMediaSubscriber()                     │
│                                                                      │
│ 用途: メディア配信を簡単に扱う                                        │
├──────────────────────────────────────────────────────────────────────┤
│ 低レベル Session API                                                 │
│                                                                      │
│ connect() → Session.publish() / subscribe() / fetch()                │
│ Publisher.sendObject() / sendDatagram()                              │
│ Subscriber.object / datagram callback                                │
│                                                                      │
│ 用途: MOQT プロトコルを直接扱う                                       │
├──────────────────────────────────────────────────────────────────────┤
│ バイナリ codec / utility 層                                           │
│                                                                      │
│ controlStream.ts / dataStream.ts / message/* / properties.ts         │
│                                                                      │
│ 用途: フレーミング、varint、Properties、Object encode / decode        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 公開 API の入口

### `connect()`

```typescript
import { connect } from "moqt-js"

const session = await connect(url, callbacks?, options?)
```

#### `ConnectCallbacks`

| 名前 | 説明 |
| ---- | ---- |
| `close` | `WebTransport.closed` の結果を受け取る |
| `error` | セッションレベルのエラーを受け取る |
| `debug` | 送受信した MOQT メッセージの raw 情報を受け取る |
| `goaway` | `GOAWAY` 受信時に新しい Session URI を受け取る |

#### `ConnectOptions`

| 名前 | 説明 |
| ---- | ---- |
| `serverCertificateHashes` | 自己署名証明書用の `WebTransportOptions.serverCertificateHashes` |
| `authorizationToken` | `SETUP` Option `0x03` として送る認証トークン |

### `Session`

| API | 役割 |
| --- | --- |
| `state` | `"connected"` / `"closed"` |
| `goawayReceived` | peer から `GOAWAY` を受信済みかどうか |
| `publish(namespace, trackName, callbacks?, options?)` | 新しい双方向ストリームで `PUBLISH` を送る |
| `subscribe(namespace, trackName, callbacks, options?)` | 新しい双方向ストリームで `SUBSCRIBE` を送る |
| `fetch(namespace, trackName, options, callbacks)` | 新しい双方向ストリームで `FETCH` を送る |
| `trackStatus(namespace, trackName)` | `TRACK_STATUS` を送り `REQUEST_OK` を待つ |
| `subscribeNamespace(namespacePrefix, callbacks, mode?)` | 専用双方向ストリームで Namespace 発見を行う |
| `publishNamespace(namespace, callbacks?)` | 制御ストリームで `PUBLISH_NAMESPACE` を送る |
| `goaway(newSessionUri?, timeout?)` | 制御ストリームで `GOAWAY` を送る |
| `close()` | セッション内部状態と保留中 Promise をクリーンアップする |
| `getStatistics()` | セッション統計を取得する |

### `Publisher`

| プロパティ / メソッド | 説明 |
| --------------------- | ---- |
| `state` | `"active"` / `"closed"` |
| `forwardState` | `PUBLISH_OK` / `REQUEST_UPDATE` で更新された `FORWARD` 状態 |
| `sendObject(params)` | Subgroup stream に Object を送る |
| `sendDatagram(params)` | Datagram として Object を送る |
| `done()` | 現在のデータストリームを閉じて `PUBLISH_DONE` を送る |

`sendObject()` / `sendDatagram()` の送信パラメータは `number` ベースだが、受信した `MoqtObject` は `bigint` ベースで返る。

### `Subscriber`

| プロパティ / メソッド | 説明 |
| --------------------- | ---- |
| `state` | `"active"` / `"closed"` |
| `largestLocation` | `SUBSCRIBE_OK` または `REQUEST_OK` で更新される `LARGEST_OBJECT` |
| `trackProperties` | `SUBSCRIBE_OK` で受信した Track Properties |
| `update(options?)` | 同じ双方向ストリームで `REQUEST_UPDATE` を送る |
| `unsubscribe()` | 双方向ストリームを close して購読を終了する |

### `Fetcher`

| プロパティ / メソッド | 説明 |
| --------------------- | ---- |
| `state` | `"active"` / `"closed"` |
| `endOfTrack` | `FETCH_OK` の `End of Track` |
| `endLocation` | `FETCH_OK` の終了位置 |
| `trackProperties` | `FETCH_OK` で受信した Track Properties |
| `cancel()` | 双方向ストリームを close して Fetch を中断する |

### `MoqtObject`

```typescript
interface MoqtObject {
  groupId: bigint
  subgroupId?: bigint
  objectId: bigint
  publisherPriority?: number
  status: ObjectStatus
  properties?: Uint8Array
  payload: Uint8Array
}
```

- `payload` は生のバイト列で、LOC やアプリケーション独自フォーマットの解釈は呼び出し側が行う
- `properties` も raw のまま返るため、必要なら `properties.ts` や `LOC` helper と組み合わせる

---

## モジュール分割

| ファイル | 役割 |
| -------- | ---- |
| `src/index.ts` | 公開 API の export と `connect()` の入口 |
| `src/session.ts` | WebTransport / 制御ストリーム / request stream / data stream を束ねる中心実装 |
| `src/publisher.ts` | `Publisher` の状態と callback hook |
| `src/subscriber.ts` | `Subscriber` の状態、`largestLocation`、Track Properties の保持 |
| `src/fetcher.ts` | `Fetcher` の状態、`endLocation`、Track Properties の保持 |
| `src/controlStream.ts` | `Type (varint) + Length (16-bit) + Payload` のフレーミング |
| `src/dataStream.ts` | Subgroup Header、Fetch Header、Object Datagram の encode / decode |
| `src/message/*` | `SETUP` / `PUBLISH` / `SUBSCRIBE` / `FETCH` など各メッセージの payload codec |

`PublisherImpl` / `SubscriberImpl` / `FetcherImpl` は薄い状態オブジェクトで、実際のネットワーク I/O はすべて `SessionImpl` が担当する。各ハンドルは `SessionImpl` に callback hook を差し込まれて動く。

---

## セッション確立

### 1. `connect()` の入口

`src/index.ts` の `connect()` は以下を行う。

1. `new WebTransport(url, transportOptions)` を生成する
2. `transport.ready` を待つ
3. `SessionImpl` を作る
4. `session.initialize()` を呼ぶ

`serverCertificateHashes` はそのまま `WebTransport` に渡し、`authorizationToken` は `initialize()` 内で `SETUP` Option に変換される。

### 2. `SessionImpl.initialize()`

初期化時の流れは以下のとおり。

1. `ControlStreamReader` / `ControlStreamWriter` を生成する
2. クライアント側の送信用単方向ストリームを開く
3. ストリーム先頭に制御ストリーム型 `0x2F00` を書く
4. `SETUP` をエンコードして送る
5. サーバー側の受信用単方向ストリームを 1 本受け取る
6. 先頭 varint が `0x2F00` であることを検証する
7. 最初の `SETUP` をデコードする
8. 背景ループを開始する

開始される背景ループは 3 つある。

- `startControlMessageLoop()`
- `startIncomingStreamLoop()`
- `startDatagramLoop()`

`close` callback は `transport.closed` の監視結果から呼ばれる。

---

## リクエストとレスポンスの扱い

### Request ID と Track Alias

- クライアントは `0n, 2n, 4n, ...` の偶数 `Request ID` を使う
- `publish()` は送信前にローカルで `Track Alias` を採番する
- `subscribe()` は `SUBSCRIBE_OK` で返された `Track Alias` を採用する
- `SessionImpl` は以下の Map で状態を持つ
  - `publishers`
  - `subscribers`
  - `subscribersByAlias`
  - `fetchers`
  - `requestStreams`
  - `pending*`

### 通常の request stream

`PUBLISH` / `SUBSCRIBE` / `FETCH` / `TRACK_STATUS` は `sendRequestOnBidiStream()` を経由して送信する。

1. 新しい双方向ストリームを開く
2. `ControlStreamWriter` でメッセージをフレーミングする
3. `requestStreams` に `writer` と `ControlStreamReader` を登録する
4. `readResponseFromBidiStream()` で最初のレスポンスを待つ

最初のレスポンスは request ごとに専用メソッドで処理する。

- `readPublishResponse()`
- `readSubscribeResponse()`
- `readFetchResponse()`
- `readTrackStatusResponse()`

`PUBLISH_OK` / `SUBSCRIBE_OK` の後は、同じ双方向ストリームを `readRequestStreamMessages()` が監視し続ける。ここで `PUBLISH_DONE` や `REQUEST_UPDATE` の応答を受け取る。

### Namespace 系の扱い

- `publishNamespace()` は制御ストリームで `PUBLISH_NAMESPACE` を送り、制御ストリーム上の `REQUEST_OK` / `REQUEST_ERROR` を待つ
- `subscribeNamespace()` は専用双方向ストリームを別実装で開き、`REQUEST_OK` の後も `NAMESPACE` / `NAMESPACE_DONE` を受け続ける
- `PUBLISH_NAMESPACE_DONE` は draft-17 で削除されたため、公開終了はローカル状態の cleanup のみで表現している

---

## Publish 実装

### `publish()` の流れ

`Session.publish()` は以下を行う。

1. 新しい `Request ID` と `Track Alias` を採番する
2. `PublishOptions` から Message Parameters と Track Properties を構築する
3. `PublisherImpl` を作る
4. `PUBLISH` を双方向ストリームで送る
5. `PUBLISH_OK` を待つ
6. 成功時に `publishers` に登録する
7. `FORWARD` parameter があれば `forwardState` に反映する

`PublisherImpl` 自体は状態と callback の保持だけを行い、実際の送信は `onSendObject` / `onSendDatagram` / `onDoneInternal` を通じて `SessionImpl` に委譲する。

### `sendObject()` の内部実装

`sendObject()` は fire-and-forget で呼ばれる前提なので、`publisherSendQueues` でトラック単位に直列化している。これにより `createUnidirectionalStream()` の await 中に次の送信が割り込んで、同一トラックでストリームが二重作成されることを防ぐ。

送信の実際の流れは以下のとおり。

1. `trackAlias` ごとの現在ストリームを `publisherStreams` から探す
2. 最初の Object または `groupId` 変更時は前のストリームを `FIN` で閉じる
3. 新しい単方向ストリームを開く
4. `SubgroupHeaderType.FIRST_OBJ_EXT` で Subgroup Header を書く
5. `objectIdDelta` を計算する
6. Object fields と payload を書く
7. `previousObjectId` を更新する

#### 現在の送信モデル

- `1 Group = 1 Subgroup = 1 Stream`
- `publisherPriority` のデフォルトは `128`
- `Stream Count` は実際に開いたデータストリーム数を `PUBLISH_DONE` に反映する

#### `FIRST_OBJ_EXT` を固定で使う理由

Subgroup Header の `Properties Present` ビットはストリーム全体に効く。Object ごとに `properties` の有無が変わり得るため、実装では常に `FIRST_OBJ_EXT` を使い、`properties` がない Object には `Properties Length = 0` を書く。

### `sendDatagram()` の内部実装

`sendDatagram()` は以下の 3 つから `DatagramType` を決める。

- `priority` の有無
- `properties` の有無
- `endOfGroup` の有無

その後 `encodeObjectDatagram()` でバイト列にして `transport.datagrams.writable` へ送る。同一トラックで Stream と Datagram の混在を許可している。

### `done()` の内部実装

`Publisher.done()` は次の順で終了する。

1. 現在の Subgroup stream を閉じる
2. リクエスト双方向ストリーム上で `PUBLISH_DONE` を送る
3. `Publisher` を `closed` にする

Safari 系の `WebTransport` では `writer.close()` が resolve しない場合があるため、現在の実装は `5 秒` の timeout をかけて FIN 完了待ちを打ち切る。

---

## Subscribe / Fetch 実装

### `subscribe()` の流れ

`Session.subscribe()` は以下を行う。

1. `joiningFetch` がある場合に事前バリデーションする
   - `filter` は `LargestObject` である必要がある
   - `forward` は `false` にできない
2. `SubscriberImpl` を仮の `trackAlias = 0n` で作る
3. `SUBSCRIBE` を双方向ストリームで送る
4. `SUBSCRIBE_OK` を待つ
5. `trackAlias` / `largestLocation` / `trackProperties` を反映する
6. `subscribers` と `subscribersByAlias` に登録する
7. 必要なら `sendJoiningFetch()` を起動する

#### `REQUEST_UPDATE`

`Subscriber.update()` は新しい `Request ID` を採番するが、メッセージ自体は元の subscription と同じ双方向ストリームに送る。成功時の `REQUEST_OK` は `handleRequestUpdateOk()` が処理し、`LARGEST_OBJECT` が含まれていれば `Subscriber.largestLocation` も更新する。

#### `unsubscribe()`

`UNSUBSCRIBE` メッセージは使わず、双方向ストリームの close で購読終了を表す。`cancelSubscription()` が `requestStreams` から該当ストリームを取り出して閉じ、Map から購読状態を削除する。

### `fetch()` の流れ

`Session.fetch()` は standalone の `FETCH` を新しい双方向ストリームで送り、`FETCH_OK` を待つ。

`FETCH_OK` 受信時には `endLocation >= startLocation` を検証し、矛盾していれば `PROTOCOL_VIOLATION` でセッションを閉じる。成功時は `FetcherImpl` に以下を保存する。

- `endOfTrack`
- `endLocation`
- `trackProperties`

`Fetcher.cancel()` も subscription と同様に双方向ストリームを close して終了する。

### Joining Fetch

Joining Fetch は `subscribe()` 成功後に別の `FETCH` を追加で送る実装になっている。

- `Relative Joining` は `largestLocation.group - start` から開始する
- `Absolute Joining` は `start` をそのまま開始 `groupId` として扱う
- `FETCH_OK` が返る前にデータストリームが先着する可能性があるため、受信側は `waitForFetcher()` で待機する

---

## データ受信実装

### 背景ループ

- `startIncomingStreamLoop()` が単方向ストリームを受け取り `handleIncomingStream()` に渡す
- `startDatagramLoop()` が Datagram を受け取り `handleIncomingDatagram()` に渡す

### `handleIncomingStream()`

`handleIncomingStream()` は chunk 単位でバッファを伸ばしながら、先頭 varint でストリーム種別を判定する。

- `FetchHeaderType` なら Fetch data stream
- `0x10-0x1F` / `0x30-0x3F` なら Subgroup stream
- それ以外は `PROTOCOL_VIOLATION`

#### 先行到着への対応

MOQT / QUIC ではレスポンスとデータストリームの順序が保証されないため、以下を待ち合わせる。

- `waitForSubscriber(trackAlias)`
- `waitForFetcher(requestId)`

どちらも最大 `5 秒` 待ち、対応する `SUBSCRIBE_OK` / `FETCH_OK` が来なければそのストリームは処理しない。

### `processSubgroupObjects()`

Subgroup stream の各 Object について以下を行う。

1. `decodeObjectFields()` で `objectIdDelta` と `payloadLength` を読む
2. 前回の `objectId` から絶対 `objectId` を復元する
3. `FIRST_OBJ` モードなら最初の `objectId` を `subgroupId` とみなす
4. `payload` を切り出す
5. `MoqtObject` を組み立てて `subscriber.handleObject()` を呼ぶ

統計は `objectsReceivedViaSubscribe` と `bytesReceivedViaSubscribe` に加算する。

### `processFetchObjects()`

Fetch stream は `decodeFetchObjectFields()` が前回の context を使いながら復元する。draft-17 では Fetch Object に `Object Status` がないため、現在の実装では常に `ObjectStatus.NORMAL` として `Fetcher` に渡す。

ストリーム末尾まで読んだら `fetcher.handleEnd()` を呼び、`fetchers` から外す。

### `handleIncomingDatagram()`

Datagram 受信時は `decodeObjectDatagram()` で decode し、`trackAlias` から `Subscriber` を引く。

- `datagram` callback がある場合は `subscriber.handleDatagram()`
- ない場合は通常の `subscriber.handleObject()`

このフォールバックにより、アプリが Datagram 専用 callback を用意しなくても受信を継続できる。

---

## 制御メッセージ処理

### 制御ストリーム

`startControlMessageLoop()` はセッション期間中ずっと制御ストリームを読み続ける。制御ストリームが途中で閉じた場合は `PROTOCOL_VIOLATION` とする。

制御ストリームで処理する主なメッセージは以下。

- `REQUEST_OK` / `REQUEST_ERROR`
  - `PUBLISH_NAMESPACE` の応答
- `GOAWAY`
- `PUBLISH_NAMESPACE`

`PUBLISH_DONE` を制御ストリームで受け取った場合は仕様違反としてセッションを閉じる。`PUBLISH_DONE` は request 双方向ストリーム側でのみ処理する。

### `GOAWAY`

`Session.goaway()` は制御ストリームで `GOAWAY` を送る。`moqt-js` はクライアント実装なので、送信時の `newSessionUri` は空文字列しか許可しない。timeout を指定した場合は、期限までにセッションが閉じなければ `GOAWAY_TIMEOUT` で close する。

`GOAWAY` 受信時は以下を行う。

1. `goawayReceived = true` にする
2. `callbacks.goaway` を呼ぶ
3. timeout が指定されていればローカルタイマーを張る
4. timeout 経過後も接続中なら graceful shutdown を試みる

`GOAWAY` を複数回受信した場合は `PROTOCOL_VIOLATION` とする。`goawayReceived` が立った後は新しい `publish()` / `subscribe()` / `fetch()` / `trackStatus()` / Namespace 系 request を拒否する。

---

## デバッグと統計

### `ConnectCallbacks.debug`

`debug` callback には以下のような情報が送られる。

- `direction`: `send` / `recv`
- `type`
- `typeName`
- `payload`
- `decoded`
- `timestamp`

通常の MOQT メッセージに加えて、実装内部の補助イベントも流す。

- `STREAM_LOOP_ERROR`
- `DATAGRAM_LOOP_ERROR`
- `DATA_STREAM_ERROR`
- `DATAGRAM_DECODE_ERROR`

### `SessionStatistics`

`getStatistics()` は以下のカテゴリのカウンターを返す。

- 受信 Object 数 / 受信バイト数
  - `objectsReceivedViaFetch`
  - `objectsReceivedViaSubscribe`
  - `bytesReceivedViaFetch`
  - `bytesReceivedViaSubscribe`
- アクティブなハンドル数
  - `activePublishers`
  - `activeSubscribers`
  - `activeFetchers`
- ストリーム関連
  - `publisherStreamsOpen`
  - `subscriberStreamsActive`
  - `unidirectionalStreamsOpened`
  - `unidirectionalStreamsReceived`
- パーサ関連
  - `subgroupHeadersReceived`
  - `fetchHeadersReceived`
  - `controlMessagesSent`
  - `controlMessagesReceived`

---

## 実装上の注意

- `moqt-js` はクライアント専用実装であり、サーバー側の振る舞いは持たない
- 実装の中心は `SessionImpl` で、公開ハンドルは状態と callback の薄いラッパーである
- 現在の送信モデルは `1 Group = 1 Subgroup = 1 Stream` を前提にしている
- `Closed Subgroup Tracking` は TODO のままで、`STOP_SENDING` 後の厳密な再オープン防止までは実装していない
- `close()` は主にローカル状態と pending Promise の cleanup を担当し、protocol error 時の `transport.close()` は `closeWithError()` 側で行う

低レベル API はあくまで「MOQT のワイヤ表現をほぼそのまま扱う層」であり、LOC / MSF / WebCodecs を組み合わせるかどうかは利用側の責務になる。
