# 低レベル API 実装

## 概要

`moqt-js` の低レベル API は、MOQT の制御メッセージ、データストリーム、データグラムをアプリケーションから直接扱うための層である。高レベル API のような `MediaStream` / `WebCodecs` の抽象化は行わず、`MoqtObject` の `payload` と `properties` をそのまま受け渡す。

公開 API の入口は `connect()` で、返された `Session` から `publish()` / `subscribe()` / `fetch()` / `trackStatus()` / `subscribeNamespace()` / `subscribeTracks()` / `publishNamespace()` を呼び出す。バイナリの encode / decode は `src/message/*`、`src/controlStream.ts`、`src/dataStream.ts` に分離され、`SessionImpl` がそれらを束ねている。

## 関連する API

MediaStream を配信、視聴する場合は [高レベル API](HIGH_LEVEL_API.md)、
各層の責務とモジュールの対応は [内部構成](ARCHITECTURE.md) を参照すること。

---

## 公開 API の入口

### `connect()`

```typescript
import { connect } from "moqt-js"

const session = await connect(url, callbacks?, options?)
```

#### `ConnectCallbacks`

| 名前     | 説明                                            |
| -------- | ----------------------------------------------- |
| `close`  | `WebTransport.closed` の結果を受け取る          |
| `error`  | セッションレベルのエラーを受け取る              |
| `debug`  | 送受信した MOQT メッセージの raw 情報を受け取る |
| `goaway` | `GOAWAY` 受信時に新しい Session URI を受け取る  |

#### `ConnectOptions`

| 名前                            | 説明                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serverCertificateHashes`       | 自己署名証明書用の `WebTransportOptions.serverCertificateHashes`                                                                                                                                 |
| `authorizationToken`            | `SETUP` Option `0x03` として送る認証トークン。省略時は MOQT URI の msf fragment の `c4m` を使う                                                                                                  |
| `maxControlMessageSize`         | `SETUP` Option `0x09` として広告する受信上限 (バイト、Message Length)。65535 以上 Number.MAX_SAFE_INTEGER 以下の整数。省略時は Option を送らず 65535。送信はピアの広告値 (受信前は 65535) に従う |
| `pendingSubgroup`               | `PendingSubgroupBuffer` のオプション (上限バイト数 / タイムアウト)                                                                                                                               |
| `moqtImplementation`            | `SETUP` Option `0x07` (MOQT_IMPLEMENTATION) として送る実装名                                                                                                                                     |
| `grease`                        | 送受信に GREASE 拡張を注入するか                                                                                                                                                                 |
| `dataStreamMaxBufferBytes`      | 受信データストリーム 1 本が保持してよいバッファの上限。超過時はそのストリームを打ち切り (セッションは閉じない)、0 以下で上限なし (既定 32 MiB)                                                   |
| `dataStreamMaxTotalBufferBytes` | 受信データストリーム全体が保持してよいバッファの合計上限。超過時は超過の原因になったストリームを打ち切り (セッションは閉じない)、0 以下で上限なし (既定 64 MiB)                                  |

#### MSF URI Fragment の `c4m`

MOQT URI が `msf` fragment を持ち、その parameter に `c4m` がある場合、`connect()` は
`c4m` の値を復号して `SETUP` の `AUTHORIZATION TOKEN` Setup Option (`0x03`) として送る。

- `c4m` は Base64 でエンコードされた C4M トークンである。標準 Base64 (RFC 4648 Section 4) と
  base64url (Section 5)、パディングの有無の両方を受け入れる
- 復号は `WebTransport` を生成する前に済ませる。復号できない場合は `Error` を throw する
  (認可トークンの値はエラーメッセージに含めない)
- Token Type は `0x01` (CAT)、Alias Type は Alias を持たない `USE_VALUE` (`0x3`) を使う。
  `SETUP` で `DELETE` (`0x0`) / `USE_ALIAS` (`0x2`) を送ってはならない
- `options.authorizationToken` を指定した場合はそちらを優先し、URI の `c4m` は使わない
- fragment はサーバーへ送信されないため、`c4m` がそのまま URL として送られることはない

根拠は draft-ietf-moq-msf-01 §11.1.1 / §11.4.2 / §11.4.3、draft-ietf-moq-c4m-02 §2 / §8.2 Table 4 /
§8.2.1、draft-ietf-moq-transport-23 §6.1.1 / §9.1.4 / §8.9。いずれも draft 版であり、
将来の改版で変わる可能性がある。

#### SETUP に載せたトークンの制御メッセージへの付与

`SETUP` に載せたトークン (`ConnectOptions.authorizationToken`、または MOQT URI の `c4m` から
解決したもの) は `Session.setupAuthorizationToken` から参照できる。

draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
`AUTHORIZATION TOKEN` パラメータを受け付けるすべての制御メッセージへ MUST 付与する
(`SETUP` に載せていても免除されない)。高レベル API はこれを使って次を送る。

- `createMediaSubscriber` は catalog の `SUBSCRIBE` と `FETCH` にこのトークンを付与する
  (catalog 自身の `authInfo` は catalog を受信するまで分からないため、常に付与する)
- `createMediaSubscriber` は catalog が `authInfo` を持つと示したトラックの `SUBSCRIBE` に
  このトークンを付与する。`MediaSubscriberOptions.getAuthorizationToken` を指定した場合は
  そちらが優先される
- `REQUEST_UPDATE` は `SUBSCRIBE` と同じトークンを `Subscriber` が保持して送る
- `subscribeNamespace` / `subscribeTracks` に渡したトークンは、それぞれの購読の
  `update()` が送る `REQUEST_UPDATE` にも同じ値で付与する (`REGISTER` は初回要求で
  送信済みのため `USE_ALIAS` に変換する)。更新時にトークンを差し替える手段は無い
- `createMediaPublisher` は catalog / 音声 / 映像の `PUBLISH` と、`announceNamespace` を
  有効にしたときの `PUBLISH_NAMESPACE` にこのトークンを付与する
  (`PublishOptions.authorizationToken` / `PublishNamespaceOptions.authorizationToken`)

低レベル API では、`Session.subscribe(options.authorizationToken)` /
`Session.fetch(options.authorizationToken)` / `Session.publish(options.authorizationToken)` などに
`Session.setupAuthorizationToken` をそのまま渡せば同じ挙動になる。

### `Session`

| API                                                        | 役割                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `state`                                                    | `"connected"` / `"closed"`                                                              |
| `goawayReceived`                                           | peer から `GOAWAY` を受信済みかどうか                                                   |
| `fragment`                                                 | 接続時に渡した `moqt` URI の Fragment Identifier (`MoqtFragment` または `null`)         |
| `setupAuthorizationToken`                                  | `SETUP` Option `0x03` として送った Authorization Token (送っていない場合は `undefined`) |
| `publish(namespace, trackName, callbacks?, options?)`      | 新しい双方向ストリームで `PUBLISH` を送る                                               |
| `subscribe(namespace, trackName, callbacks, options?)`     | 新しい双方向ストリームで `SUBSCRIBE` を送る                                             |
| `fetch(namespace, trackName, options, callbacks)`          | 新しい双方向ストリームで `FETCH` を送る                                                 |
| `trackStatus(namespace, trackName)`                        | `TRACK_STATUS` を送り `REQUEST_OK` を待つ                                               |
| `subscribeNamespace(namespacePrefix, callbacks, options?)` | 専用双方向ストリームで Namespace 発見を行う                                             |
| `subscribeTracks(namespacePrefix, callbacks, options?)`    | 専用双方向ストリームで `SUBSCRIBE_TRACKS` を送る                                        |
| `publishNamespace(namespace, callbacks?, options?)`        | 専用双方向ストリームで `PUBLISH_NAMESPACE` を送る                                       |
| `goaway(newSessionUri?, timeout?)`                         | 制御ストリームで `GOAWAY` を送る                                                        |
| `close()`                                                  | セッション内部状態と保留中 Promise をクリーンアップする                                 |
| `getStatistics()`                                          | セッション統計を取得する                                                                |

`fragment` は draft-ietf-moq-transport-23 §6.1.1 の Fragment Identifier である。

> Fragment identifiers MAY be used with moqt URIs. The fragment is not
> transmitted to the server; it is processed locally by the client
> after establishing the MOQT session.

サーバーへは送信されず、`connect()` に渡した URI から `{ type, value }` として
クライアント側でのみ解釈する。指定が無ければ `null`。

### `Publisher`

| プロパティ / メソッド         | 説明                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `state`                       | `"active"` / `"closed"`                                                                                                             |
| `paused`                      | `PUBLISH` 送信時の `options.paused`、`REQUEST_UPDATE`、`notifyStateChange` で更新された paused 状態 (true = 一時停止)               |
| `sendObject(params)`          | Subgroup stream に Object を送る                                                                                                    |
| `sendDatagram(params)`        | Datagram として Object を送る。返値の Promise は datagram の write の完了で resolve する（失敗は `onError` へ通知し reject しない） |
| `notifyStateChange(options?)` | 購読状態の変化を `PUBLISH_STATE_NOTIFY` で購読者へ通知する                                                                          |
| `closeSubgroup()`             | 開いている Subgroup を Object を送らずに閉じる                                                                                      |
| `done()`                      | 現在のデータストリームを閉じて `PUBLISH_DONE` を送る                                                                                |

`sendObject()` / `sendDatagram()` の送信パラメータは `number` ベースだが、受信した `MoqtObject` は `bigint` ベースで返る。

`sendObject()` の `endOfSubgroup` に `true` を渡すと、その Object の書き込み完了後に Subgroup を `FIN` で閉じる (draft-ietf-moq-transport-23 §11.3.2)。Subgroup に載せる Object が残っていないことを送信側が知っている場合に使う (catalog は 1 Group に 1 Object だけを載せるため常にこれに当たる)。

- 送信が見送られた場合 (`paused` が `true`、または購読の `LOCATION_FILTER` の範囲外) は閉じない。その Group の Subgroup が既に開いていれば省略として記録され、後の Group 切り替えで `RESET` になる
- 閉じた Group への後続の `sendObject()` は error 通知になる (返値の Promise は解決する)。`paused` が `true` の場合は送信前に見送られるため通知も出ない。`FIN` の完了がタイムアウトして `RESET` に切り替わった場合は、同じ Group へ再び送信できる
- `SubgroupHeader` の `END_OF_GROUP` ビット (§11.3.1) は立てない。`FIN` の受信で相手側の `DATA_STREAM_TIMEOUT` は解除できるため、同ビットの「FIN から Group の最終 Object を推論する」経路は使わない
- `sendDatagram()` の `endOfGroup` とは別のものである。あちらは Datagram の wire で Group の最後を示すビット (§11.2.1) を立てる。同じパラメータオブジェクトを使い回さないこと

`closeSubgroup()` は、送信を止める時点で「その Subgroup に続く Object は無い」と分かったときに、Object を送らずに開いている Subgroup を閉じる (draft-ietf-moq-transport-23 §11.3.2)。`sendObject()` の `endOfSubgroup` は「送信する Object が Subgroup の最後である」ことを示す経路であり、送る Object が無い場合は使えない。

- 開いている Subgroup が無い場合と、Publisher が既に `"closed"` の場合は何もしない (例外も投げない)
- `FIN` と `RESET` は §11.3.2 の判定に従う。見送った Object がある Subgroup は `RESET` になる
- 送信キューに載せ、キュー済みの送信が終わってから閉じる。`FIN` の完了は待たず、`done()` が完了を待つ
- `writer.close()` が失敗・タイムアウトした場合は `RESET` に切り替わる (これは通知しない)
- 返値の Promise は解決する。内部コールバックの失敗は error 通知になる
- 閉じた後に同じ Group へ `sendObject()` すると error 通知になる。`FIN` の完了がタイムアウトして `RESET` に切り替わった場合は、`endOfSubgroup` と同じく同じ Group へ再び送信できる

`notifyStateChange()` が通知に載せるパラメータは `LARGEST_OBJECT` / `PAUSED` / `LOCATION_FILTER` のみである。

- `LARGEST_OBJECT` は送信済み Object があり値が既知なら、現在値から変化していなくても必ず載る (§9.19.17 の MUST)
- `PAUSED` / `LOCATION_FILTER` は現在値から変化した場合だけ載る
- `PAUSED` と `LOCATION_FILTER` のどちらも変化していなければ、`LARGEST_OBJECT` を載せられる場合でも送信しない

送信できた変更だけを publisher の状態 (`paused` / Location Filter) に反映する。

### `Subscriber`

| プロパティ / メソッド     | 説明                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                   | `"active"` / `"closed"`                                                                                                                                         |
| `largestLocation`         | `SUBSCRIBE_OK` / `PUBLISH` / `REQUEST_UPDATE_OK` / `PUBLISH_STATE_NOTIFY` で更新される `LARGEST_OBJECT`                                                         |
| `largestReceivedLocation` | 購読で受信した Object の最大 Location (Subgroup / Datagram / fill fetch。§3.1.4)                                                                                |
| `trackProperties`         | `SUBSCRIBE_OK` で受信した Track Properties                                                                                                                      |
| `paused`                  | `SUBSCRIBE` 送信時の `options.paused`、受信 `PUBLISH`、`REQUEST_UPDATE` の `REQUEST_OK` 受信、`PUBLISH_STATE_NOTIFY` で更新される paused 状態 (true = 一時停止) |
| `update(options?)`        | 同じ双方向ストリームで `REQUEST_UPDATE` を送る                                                                                                                  |
| `unsubscribe()`           | 双方向ストリームを close して購読を終了する                                                                                                                     |

#### 購読の終了通知

`SubscribeCallbacks.end` は、publisher が PUBLISH_DONE を送って購読を終えたときに呼ばれる (draft-ietf-moq-transport-23 §3.1 / §9.9)。引数の `PublishDoneInfo` が終了の理由を運ぶ。

```typescript
import type { PublishDoneInfo } from "moqt-js";
import { PublishDoneStatusCode, isPublishDoneErrorStatus } from "moqt-js";

interface PublishDoneInfo {
  statusCode: PublishDoneStatusCode;
  streamCount: bigint;
  reasonPhrase: string;
}
```

- `statusCode` は §12.4 (Publish Done Codes) の値で、`TRACK_ENDED` / `GOING_AWAY` / `EXPIRED` / `TOO_FAR_BEHIND` / `INTERNAL_ERROR` などを区別する。未知の値は §13 (Grease) により `INTERNAL_ERROR` に正規化して渡す
- `streamCount` は publisher がこの購読のために開いたデータストリーム数である (§9.9)。空の Subgroup を含むデータストリームと fill fetch ストリームを数える。受信済みのストリーム数と比較して、同じ数まで処理した時点で購読状態を破棄できる。`2^64-1` は publisher が正確な値を設定できなかったことを表すため、受信済みストリーム数との比較には使えず、タイムアウトなどの別の手段で購読状態を破棄する
- エラーを示すかどうかは `isPublishDoneErrorStatus(statusCode)` で判定する。`INTERNAL_ERROR` / `UNAUTHORIZED` / `TOO_FAR_BEHIND` / `EXPIRED_AUTH_TOKEN` / `UPDATE_FAILED` / `EXCESSIVE_LOAD` / `MALFORMED_TRACK` がエラーである
- エラーを示す Status Code の PUBLISH_DONE でも `end` だけを 1 回呼び、`error` は呼ばない。エラーかどうかは Status Code で判定する
- `error` は次の 2 つの場合に呼ばれる。購読が PUBLISH_DONE を伴わない失敗で終わった場合 (§6.4.2.2 の PUBLISH_DONE を伴わない FIN、RESET_STREAM、§12.1 の Malformed Track) と、アプリのコールバック (`object` / `datagram` / `subgroupEnd`) が throw した場合である。後者では購読は終わらない (state は `"active"` のまま) ため、受信を続けるアプリは状態を破棄しないこと
- セッションの終了 (§6.6 Termination) では `end` を呼ばない。セッションの終了は `ConnectCallbacks.close` が通知する
- `error` だけを登録していたアプリは、PUBLISH_DONE による終了 (エラーを示す Status Code を含む) を一切受け取れなくなる。終了は `end` で受け取る

### `Fetcher`

| プロパティ / メソッド | 説明                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `state`               | `"active"` / `"closed"`                                                                           |
| `endOfTrack`          | Track 終端を確認済みか。FETCH 応答受理時は `false`、End of Track indicator (0x81) の受理で `true` |
| `endLocation`         | FETCH 応答がカバーする範囲の inclusive な上限                                                     |
| `trackProperties`     | FETCH 応答で受信した Track Properties                                                             |
| `cancel()`            | 双方向ストリームを close して Fetch を中断する                                                    |

### `MoqtObject`

```typescript
interface MoqtObject {
  groupId: bigint;
  subgroupId?: bigint;
  objectId: bigint;
  publisherPriority?: number;
  status: ObjectStatus;
  properties?: Uint8Array;
  payload: Uint8Array;
}
```

- `payload` は生のバイト列で、LOC やアプリケーション独自フォーマットの解釈は呼び出し側が行う
- `properties` も raw のまま返るため、必要なら `properties.ts` や `LOC` helper と組み合わせる

## C4M の claim label

`C4M` 名前空間の CAT コーデックは、`moqt` / `moqt-reval` クレームの claim key を
`C4mClaimLabels` (`{ readonly moqt: number; readonly moqtReval: number }`) として
呼び出し側から受け取る。

- draft-ietf-moq-c4m-02 §8 は両クレームの claim key を TBD_MOQT / TBD_MOQT_REVAL の
  ままとし、IANA の CWT Claims レジストリに登録していない。そのため暗黙の既定値は無い
- `decodeCatClaims` / `encodeCatClaims` / `CatToken.decode` / `CatToken.decodeCompact` /
  `CatToken.decodeCose` / `CatToken.decodeMoqtAuthToken` の各入口と
  `CatTokenBuilderOptions` では `claimLabels` が必須である
- 付録 A の検証用ベクタが使う Private Use (RFC 8392 Section 9.1.1 の -65536 未満) の
  値は `C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS` (`-65537` / `-65538`) として公開している。
  テストと devtools はこの preset を明示して使う。実運用では peer と事前に合意した
  暫定値を渡す
- 設定は安全な整数に限る。`moqt` と `moqtReval` が同じ値である場合、IANA の
  CWT Claims レジストリに登録済みの claim key との重複、未指定、不正型、範囲外は
  `CatError` (`invalidClaimLabels`) として処理開始時に拒否する。IANA が
  `moqt` / `moqt-reval` に公式値を割り当てた場合は、その値だけを label として
  許可する
- claim key 0 は RFC 8392 Section 9.1.2 が RESERVED として予約しており、label に
  指定できない。claim set に key 0 を持つトークンも `invalidClaimKey` で拒否する。
  draft-ietf-moq-c4m-02 付録 A.6 の複合クレームのベクタは未割当の key を 0 に
  しているため、CAT としては受理しない
- 複合クレーム (`or` / `and` / `nor`) の評価は未実装である。そのため key 0 の
  プレースホルダを持つ付録 A.6 のベクタは fail-closed で拒否し、複合クレームを
  含むトークンを認可に使わない
- Token / builder は設定をコピーして保持する。呼び出し元が設定元のオブジェクトを
  後から変更しても解釈は変わらない。`CatToken.verify` はデコード時に同じ設定で
  解釈した claims を検証し、別の label 設定で再解釈しない
- 旧 draft の 327 / 328 は preset では解釈しない。`claimLabels` に明示した場合だけ
  その値を使う

MSF fragment の `c4m` を扱う `src/msf/c4mAuthorization.ts` はトークンを復号せず
Base64 を復号して運ぶだけであり、claim label の設定を必要としない。

## C4M のクレーム検証

`validateCatClaims(claims, options)` は、デコード済みのクレームに対して `exp` /
`nbf` / `iss` / `aud` を検証する。署名または MAC の検証は `CatToken.verify` が
別途行う。

- `options.referenceTimeSeconds` は検証に使う現在時刻 (UNIX 秒) である。
  **省略すると 0 (1970-01-01T00:00:00Z) 基準になる。** `exp` だけを持つトークンは
  1970 年時点では期限切れでないため、省略すると期限切れトークンを通してしまう。
  呼び出し側で現在時刻を明示して渡すこと
- `options.clockToleranceSeconds` は `exp` / `nbf` に許容するずれ (秒) である
- `options.expectedIssuers` は期待する `iss`、`options.expectedAudiences` は
  期待する `aud` の一覧であり、空の場合は検証しない

## C4M の confirmation

`C4M` 名前空間の `Confirmation` は `cnf` の confirmation method を保持する。

- `ckt` は confirmation key 5 の COSE Key Thumbprint (RFC 9679) である。
  draft-ietf-moq-c4m-02 §4.1 は DPoP の鍵束縛に `ckt` を推奨し、relay は MUST
  support とする
- `jkt` は confirmation key 323 の JWK SHA-256 Thumbprint (RFC 7638) である。
  §4.1 が既存の CAT issuer との互換用に定義し、relay は SHOULD support とする
- IANA の CWT Confirmation Methods レジストリで 3 は `kid` (RFC 8747 §3.4) で
  ある。C4M 02 の `jkt` ではないため、key 3 は `raw` に保持し、
  `confirmationJkt` は key 323 の値だけを返す。key 3 をサムプリントとして
  読み替えない
- `decodeConfirmation` は `ckt` / `jkt` だけを型付きで解釈する。それ以外の
  key は意味を捏造せず `raw` に保持する。同じ confirmation key が重複した
  マップは CBOR のマップとして不正であるため拒否する
- ckt の算出は行わない。COSE Key Thumbprint は JWK サムプリントと異なる計算で
  あり、`jwkThumbprintSha256` を流用してはならない。算出を公開する場合は
  RFC 9679 の一次資料と固定ベクタで別途検証する
- このライブラリは DPoP proof の作成・送信・検証を行わない。`cnf` を持つ
  トークンを受理しても、proof を検証して鍵の束縛を確認するまで DPoP の
  認証・検証が完了したとは扱わない

---

## モジュール分割

ソースの役割分担は [内部構成の低レベルセッション](ARCHITECTURE.md#低レベルセッション) を参照すること。
以下は接続確立と各操作の処理手順を説明する。

---

## セッション確立

### 1. `connect()` の入口

`src/index.ts` の `connect()` は以下を行う。

1. MOQT URI を `https` URL と fragment に分解する
2. fragment を検証する (`connection` の transport 指定と `c4m` の復号)
3. `new WebTransport(url, transportOptions)` を生成する
4. `transport.ready` を待つ
5. `SessionImpl` を作る
6. `session.initialize()` を呼ぶ

`serverCertificateHashes` はそのまま `WebTransport` に渡し、`authorizationToken` (URI の `c4m` から
解決したものを含む) は `initialize()` 内で `SETUP` Option に変換される。

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

開始される背景ループは 4 つある。

- `startControlMessageLoop()`
- `startIncomingStreamLoop()`
- `startIncomingBidirectionalStreamLoop()` (受信 PUBLISH 等の双方向ストリーム処理)
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
4. `bidiReadResponseFromBidiStream()` で最初のレスポンスを待つ

最初のレスポンスは request ごとに専用メソッドで処理する。

- `bidiReadPublishResponse()`
- `bidiReadSubscribeResponse()`
- `bidiReadFetchResponse()`
- `bidiReadTrackStatusResponse()`

`PUBLISH_OK` / `SUBSCRIBE_OK` の後は、同じ双方向ストリームを `bidiReadRequestStreamMessages()` が監視し続ける。ここで `PUBLISH_DONE` や `REQUEST_UPDATE` の応答を受け取る。

### Namespace 系の扱い

- `publishNamespace()` は専用双方向ストリームで `PUBLISH_NAMESPACE` を送り、専用ループで `REQUEST_OK` / `REQUEST_ERROR` を待つ
- `subscribeNamespace()` は専用双方向ストリームを別実装で開き、`REQUEST_OK` の後も `NAMESPACE` / `NAMESPACE_DONE` を受け続ける
- `subscribeTracks()` も専用双方向ストリームを別実装で開き、`REQUEST_OK` の後は prefix に一致する `PUBLISH` / `PUBLISH_SKIPPED` を受け続ける
- `PUBLISH_NAMESPACE` の終了を通知する専用メッセージは draft-23 に存在しない。公開の終了は request のキャンセル (`RESET_STREAM` と `STOP_SENDING`、§4.1 / §6.4.2.3) で行う。`NamespacePublication.done()` がこの撤回を行う。Session の終了時は、送信待ち (ストリーム作成 / write の await) の間を含めて、未確立の `publishNamespace()` の Promise を reject してアプリを待たせ続けない
- `publishNamespace()` の `NamespacePublicationCallbacks.error` は、ライブラリが `closeWithError` でセッションを閉じる原因 (`SessionError` / `ProtocolViolationError` / `IncompleteDataError`) では呼ばず、`ConnectCallbacks.error` だけが通知する。それ以外の `REQUEST_ERROR` と読み取り失敗では呼ぶ (要求ストリームの GOAWAY 後と、対象の publication が既に closed のとき (セッション終了処理が先に閉じた場合や `done()` の後) は呼ばない)。詳しい条件は `NamespacePublicationCallbacks.error` の JSDoc を正本とする。確立前の未解決の返値の Promise は失敗で settle する
- 接続の前に `validateTrackNamespaceForSend(namespace, trackName?)` で送信できる Track Namespace かを検証できる。§8.7 の構造の制約 (33 フィールド以上、空のフィールド、4,096 バイト超) と、§2.4.3 の予約 namespace (先頭フィールドが `.` で始まる値、`.` 単体)、§6.5 の `.session` (Application は publish できない) と `.session` と空 Track Name の組み合わせ (DOES_NOT_EXIST) を拒否する
  - Request の送信時にも同じ検証が走り、失敗は同期の `Error` になる (アプリケーションの入力ミスとして扱い、セッションは閉じない)。Full Track Name (Track Namespace と Track Name の合計) の 4,096 バイト上限は Track Name を含めて判定するため、送信時に検証する

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
7. `PAUSED` は `PUBLISH` 送信時の `options.paused` (省略時は `false` = 一時停止していない、つまり Object を送る) で初期化し、以後は `REQUEST_UPDATE` と `notifyStateChange` で更新する

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
8. `endOfSubgroup` が `true` のとき、その Subgroup を `FIN` で閉じる (省略がある場合は `RESET`)

#### 現在の送信モデル

- `1 Group = 1 Subgroup = 1 Stream`
- `publisherPriority` のデフォルトは `128`
- `Stream Count` は実際に開いたデータストリーム数を `PUBLISH_DONE` に反映する
- `FIN` を出す契機は、Group の切り替え、`endOfSubgroup` を付けた Object の送信、`ObjectStatus.END_OF_GROUP` の送信、`closeSubgroup()`、`done()`、セッション終了時の後始末である

#### `FIRST_OBJ_EXT` を固定で使う理由

Subgroup Header の `Properties Present` ビットはストリーム全体に効く。Object ごとに `properties` の有無が変わり得るため、実装では常に `FIRST_OBJ_EXT` を使い、`properties` がない Object には `Properties Length = 0` を書く。

### `sendDatagram()` の内部実装

`sendDatagram()` は以下の 3 つから `DatagramType` を決める。

- `priority` の有無
- `properties` の有無
- `endOfGroup` の有無

その後 `encodeObjectDatagram()` でバイト列にして datagram 送信用の `WritableStream` へ送る。送信経路は実装が持つ API に合わせ、現行仕様の `datagrams.createWritable()` を優先し、無ければ旧仕様の `datagrams.writable` を使う (Chrome は後者だけを持つ)。同一トラックで Stream と Datagram の混在を許可している。

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

1. `SubscriberImpl` を仮の `trackAlias = 0n` で作る
2. `SUBSCRIBE` を双方向ストリームで送る
3. `SUBSCRIBE_OK` を待つ
4. `trackAlias` / `largestLocation` / `trackProperties` を反映する
5. `subscribers` と `subscribersByAlias` に登録する

#### `RENDEZVOUS_TIMEOUT`

`SubscribeOptions.rendezvousTimeout` (ミリ秒、`bigint`) を指定すると、`SUBSCRIBE` に
`RENDEZVOUS_TIMEOUT` (draft-ietf-moq-transport-23 §9.19.6) を載せる。省略した場合の既定は
0 であり、0 または未指定 (既定 0) の場合は publisher が居なければ relay は即
`REQUEST_ERROR` (`DOES_NOT_EXIST`) を返す MUST。0 より大きい場合は relay は期限まで
publisher を待つ SHOULD であり、期限切れでは `TIMEOUT` を返す SHOULD (relay は要求より
短い時間で `TIMEOUT` を返し得る MAY)。0 を指定した場合も 0 のパラメータを載せる。この値は
`SUBSCRIBE` のみに意味を持ち、catalog 取得の `FETCH` には載せない。`REQUEST_ERROR` は
`RequestError` で reject され、`code` と Retry Interval (§9.4.1) の生値である
`retryInterval` (「ミリ秒 + 1」、0 は「そのままでは再試行しない」) を読める。

#### `REQUEST_UPDATE`

`Subscriber.update()` は新しい `Request ID` を採番するが、メッセージ自体は元の subscription と同じ双方向ストリームに送る。成功時の `REQUEST_OK` は `bidiHandleRequestUpdateOk()` が処理し、`LARGEST_OBJECT` が含まれていれば `Subscriber.largestLocation` も更新する。

#### `unsubscribe()`

`UNSUBSCRIBE` メッセージは使わず、双方向ストリームの close で購読終了を表す。`cancelSubscription()` が `requestStreams` から該当ストリームを取り出して閉じ、Map から購読状態を削除する。

#### fill 失敗の通知

`SubscribeOptions.fill` で fill を要求した購読では、publisher が開いた fill fetch ストリームを購読に紐付けて受信する。fill fetch ストリームには `REQUEST_ERROR` が無く、publisher は reset で fill の失敗を伝える (§3.4.1)。reset / cancel は購読に波及しない (§3.4.1) ため、購読の `error` コールバックではなく `SubscribeCallbacks.fillError` で通知する。

- FIN による fill の正常完了では通知しない
- Malformed Track の検出時は購読自体を cancel するため、購読の `error` コールバックで通知する (`fillError` は呼ばない)
- セッション終了起源の失敗はセッション単位の `error` コールバックで通知する (`fillError` は呼ばない)
- `fillError` コールバックの throw は握り潰し、`FILL_ERROR_CALLBACK_ERROR` として debug コールバックに記録する

#### paused 中の fill

draft-ietf-moq-transport-23 §3.4.1 (Opening and Closing Fill Fetch Streams):
「FILL_PARAMETERS carried while the subscription is paused opens no fill fetch stream.
Resuming the subscription without re-sending FILL_PARAMETERS does not open one either.」

そのため `paused: true` と `fill` は同時に指定できるが、paused 中の購読では publisher は
fill fetch ストリームを開かない。`FILL_PARAMETERS` を載せたまま paused を解除しても、
`FILL_PARAMETERS` を再送しない限り fill fetch ストリームは開かれない。fill が必要な場合は、
paused を解除する `REQUEST_UPDATE` に `FILL_PARAMETERS` を載せる。

### `fetch()` の流れ

`Session.fetch()` は `FETCH` を新しい双方向ストリームで送り、成功応答 (`REQUEST_OK`) を待つ。取得範囲は `FetchOptions.filter` の Location Filter として `LOCATION_FILTER` パラメータで送る。省略時はフィルタなし ({0, 0} から Largest Object まで) を要求する。省略は仕様上は有効だが、実リレーでは応答が返らないことがあるため、catalog の取得では `catalogFetchFilter` が返す絶対開始の Location Filter を常に載せる。

相対指定 (Type 0x01) は §3.2 が FETCH での相対 Location Filter を `INVALID_RANGE` と定める。Next Object (Type 0x05) も Largest Object + 1 を指して既存 Object の範囲にならない。どちらも送信前に `InvalidFilterError` で拒否する。同一 Group で End Object が Start Object より小さい空範囲も拒否する。この制約は SUBSCRIBE や fill の Location Filter には適用しない。

応答受理時には、要求範囲と応答の `LARGEST_OBJECT` から範囲の終端を確定する。

- `LARGEST_OBJECT` が要求範囲内なら、その位置が `endLocation` になる
- 要求 End Location より後なら要求 End Location が `endLocation` になる
- 開端の要求 (フィルタなし / Type 0x00 / Type 0x02) は `LARGEST_OBJECT` が必須であり、欠く成功応答は `MALFORMED_MESSAGE` になる
- `LARGEST_OBJECT` が要求 Start より前にある応答は、開端・閉端のどちらでも `INVALID_FIELD` になる
- 閉端の要求 (Type 0x03 / 0x04) で `LARGEST_OBJECT` を欠く成功応答は、要求 End Location で終わる
- Type 0x03 で `LARGEST_OBJECT` による終端が得られない場合は `{ StartGroup + EndGroupDelta, 2^64-1 }` に正規化する。この Object ID は Group 全体を含む境界値であり、実在する最後の Object ID ではない

成功時は `FetcherImpl` に `endLocation` と `trackProperties` を保存する。`endOfTrack` は FETCH 応答では変更せず `false` のままとする。FETCH データストリームの End of Track indicator (0x81) を受信したときだけ `true` になり、単なる FIN では変わらない。`Fetcher.cancel()` も subscription と同様に双方向ストリームを close して終了する。

Joining FETCH は draft-20 で削除された (draft-ietf-moq-transport-23 §A.4)。draft-23 では `FILL_PARAMETERS` (§9.19.15) を持つ SUBSCRIBE が fill fetch stream (§3.4) を開かせる形が正式な置換であり、MSF の catalog 取得 (draft-ietf-moq-msf-01 §5 の Joining FETCH (offset = 0)) も draft-23 前提ではこの fill fetch として解釈する。現状の実装は `subscribe()` (Next Object (`{ nextObject: true }`、Location Filter Type 0x05) の Location Filter) + `fetch()` (絶対開始の Location Filter) の 2 リクエストで代替しており (`createMediaSubscriber` の catalog 取得が該当し、要求範囲は `catalogFetchFilter` が決める)、catalog の fill fetch 化は未実装である。

成功応答 (`REQUEST_OK`。`FETCH_OK` は別名) が返る前にデータストリームが先着する可能性があるため、受信側は `waitForFetcher()` で待機する。

---

## データ受信実装

### 背景ループ

- `startIncomingStreamLoop()` が単方向ストリームを受け取り `handleIncomingStream()` に渡す
- `startDatagramLoop()` が Datagram を受け取り `handleIncomingDatagram()` に渡す

### `handleIncomingStream()`

`handleIncomingStream()` は chunk 単位でバッファを伸ばしながら、先頭 varint でストリーム種別を判定する。

- `FetchHeaderType` なら Fetch data stream
- `0x10-0x1F` / `0x30-0x3F` / `0x50-0x5F` / `0x70-0x7F` なら Subgroup stream (FIRST_OBJECT bit の有無を含む)
  - ただし SUBGROUP_ID_MODE = 0b11 の予約値 (`0x16` / `0x17` / `0x1E` / `0x1F` / `0x36` / `0x37` / `0x3E` / `0x3F`) は `INVALID_STREAM_HEADER`
- `0x132b3e28` なら PADDING stream (データをすべて読み捨てる)
- それ以外は `INVALID_STREAM_HEADER`

#### 先行到着への対応

MOQT / QUIC ではレスポンスとデータストリームの順序が保証されないため、以下を待ち合わせる。

- Subgroup stream: `PendingSubgroupBuffer` にバッファし、対応する `SUBSCRIBE_OK` が来てから処理する (pending mode)
- Fetch data stream: `waitForFetcher(requestId)`

`waitForFetcher()` は最大 `5 秒` 待ち、対応する `REQUEST_OK` が来なければそのストリームは処理しない。

#### Graceful 終了 (FIN) と未完成 Object

FIN (ピアの graceful 終了) 検出時点で残バッファが非空、つまりシリアライズされた Object の途中なら、draft-ietf-moq-transport-23 §11.3 に従い `TRUNCATED_OBJECT` でセッションを閉じる。
失効範囲は Object 1 個ではなくセッション全体 (全 Track・全 Fetch) であり、アプリは再接続が必要になる。
早期終了が RESET_STREAM で行われた場合は read が reject されるだけで本判定には該当しない (§11.3.2 は配信途中での終了を reset と規定している)。

- Subgroup stream: `dataStreamHandleSubgroupStream()` の subscriber mode ループで FIN 検出後に残バッファを検査する。pending mode (subscribers 未登録) は payload を decode していないため対象外
- Fetch data stream: `handleIncomingStream()` の終了処理で残バッファが非空なら `fetcher.handleEnd()` を呼ばずにセッションを閉じる
- sessionState が既に closed の経路 (transport.closed ハンドラ経由など) で検出した違反は黙殺し、通知しない (終了済みセッションへの通知は spurious になるため)

残バッファが空の FIN は正常終了であり、セッションは閉じない (Subgroup は §11.3.2 が全 Object 配信後の FIN を MUST とし、Fetch data stream は §3.2.1 が Object 0 件の FETCH_HEADER + FIN を含めて正常終了を規定する)。

### `processSubgroupObjects()`

Subgroup stream の各 Object について以下を行う。

1. `decodeObjectFields()` で `objectIdDelta` と `payloadLength` を読む
2. 前回の `objectId` から絶対 `objectId` を復元する
3. `FIRST_OBJ` モードなら最初の `objectId` を `subgroupId` とみなす
4. `payload` を切り出す
5. `MoqtObject` を組み立てて `subscriber.handleObject()` を呼ぶ

統計は `objectsReceivedViaSubscribe` と `bytesReceivedViaSubscribe` に加算する。

### `processFetchObjects()`

Fetch stream は `decodeFetchObjectFields()` が前回の context を使いながら復元する。Fetch Object Fields には `Object Status` が存在しないため、現在の実装では常に `ObjectStatus.NORMAL` として `Fetcher` に渡す。

End of Range / End of Group / End of Track の indicator は Object ではないため、`Fetcher` へ配送せず Object 数・ペイロードバイト数の統計にも加算しない。End of Group (0x80) と End of Track (0x81) は、直前の実 Object の位置を Group / Track の終端として Track 単位の追跡に記録する。End of Track を受理したときは `Fetcher.endOfTrack` が `true` になり、単なる FIN では変わらない。

統計は受信したストリームの種別で分ける。通常 FETCH のデータストリームは `objectsReceivedViaFetch` / `bytesReceivedViaFetch`、fill fetch ストリームは `objectsReceivedViaFill` / `bytesReceivedViaFill` に加算し、購読側へは合算しない。fill 範囲と購読の Location Filter が重なる Object は publisher が両経路で送るため、受信したストリームの種別どおりに 1 回ずつ計上する。

ストリーム末尾 (ピアの FIN) まで読んで残バッファが空なら `fetcher.handleEnd()` を呼び、`fetchers` から外す。
未完成 Object の途中バイトが残る場合は `fetcher.handleEnd()` を呼ばず、§11.3 に従い `TRUNCATED_OBJECT` でセッションを閉じる。

### `handleIncomingDatagram()`

Datagram 受信時は `decodeObjectDatagram()` で decode し、`trackAlias` から `Subscriber` を引く。

- `datagram` callback がある場合は `subscriber.handleDatagram()`
- ない場合は通常の `subscriber.handleObject()`

このフォールバックにより、アプリが Datagram 専用 callback を用意しなくても受信を継続できる。

---

## 制御メッセージ処理

### 制御ストリーム

`startControlMessageLoop()` はセッション期間中ずっと制御ストリームを読み続ける。制御ストリームが途中で閉じた場合は `CLOSED_CONTROL_STREAM` とする。

制御メッセージの `Message Length` が自 endpoint の受信上限 (`maxControlMessageSize`、既定 65535) を超えた場合は `FIELD_LENGTH_EXCEEDED` (0x401) でセッションを閉じる (draft-ietf-moq-transport-23 §9)。

制御ストリームで処理するメッセージは `GOAWAY` のみである (SETUP の後、制御ストリームで送られるメッセージは `GOAWAY` だけ。draft-ietf-moq-transport-23 §9 のメッセージ表 / §9.2)。リクエスト / レスポンスは双方向ストリームで送る (§6.3 / §6.4.2)。

- `PUBLISH_DONE` を制御ストリームで受け取った場合は仕様違反としてセッションを閉じる。`PUBLISH_DONE` は request 双方向ストリーム側でのみ処理する。
- `PUBLISH_NAMESPACE` / `REQUEST_OK` / `REQUEST_ERROR` は制御ストリーム上で受け取った場合も仕様違反としてセッションを閉じる。これらは専用の双方向ストリームで送受信される。

### `GOAWAY`

`Session.goaway()` は制御ストリームで `GOAWAY` を送る。`moqt-js` はクライアント実装なので、送信時の `newSessionUri` は空文字列しか許可しない。timeout を指定した場合は、期限までにセッションが閉じなければ `GOAWAY_TIMEOUT` で close する。

`GOAWAY` 受信時は以下を行う。

1. `goawayReceived = true` にする
2. `callbacks.goaway` を呼ぶ
3. timeout が指定されていればローカルタイマーを張る
4. timeout 経過後も接続中なら graceful shutdown を試みる

`GOAWAY` を複数回受信した場合は `UNEXPECTED_MESSAGE` とする。`goawayReceived` が立った後は新しい `publish()` / `subscribe()` / `fetch()` / `trackStatus()` / Namespace 系 request を拒否する。

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
  - `objectsReceivedViaFetch` (通常 FETCH のデータストリーム経由。fill 経由は含まない)
  - `objectsReceivedViaFill` (fill fetch ストリーム経由)
  - `objectsReceivedViaSubscribe`
  - `bytesReceivedViaFetch` (通常 FETCH のデータストリーム経由。fill 経由は含まない)
  - `bytesReceivedViaFill` (fill fetch ストリーム経由)
  - `bytesReceivedViaSubscribe`
- Pending Subgroup バッファ
  - `pendingSubgroupStreamsCount`
  - `pendingSubgroupStreamsBytes`
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
- `Closed Subgroup Tracking` は `closedSubgroups` Set で実装されており、`STOP_SENDING` 等で閉じた Subgroup への送信は `ClosedSubgroupError` で拒否される (送信時・write 失敗時・done 時・セッション close 時に登録・クリアされる)
- `close()` は主にローカル状態と pending Promise の cleanup を担当し、protocol error 時の `transport.close()` は `closeWithError()` 側で行う

低レベル API はあくまで「MOQT のワイヤ表現をほぼそのまま扱う層」であり、LOC / MSF / WebCodecs を組み合わせるかどうかは利用側の責務になる。
