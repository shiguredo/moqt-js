# 実装状況

moqt-js が対応している仕様と、機能ごとの実装状況をまとめる。
API の契約は [高レベル API](HIGH_LEVEL_API.md)、[低レベル API](LOW_LEVEL_API.md)、
[MOQT Streaming Format](MSF.md) を正とする。

## Media over QUIC Transport

[draft-ietf-moq-transport-23](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-23) の機能実装状況である。

draft-23 対応の実リレーとの相互接続は未検証であり、単体テストの成功を実リレーでの成功として扱っていない。

### MOQT URI

- `moqt://` スキーム
- Fragment Identifier

### Track Namespace

- 予約 namespace の送信拒否
  - 先頭フィールドが `.` で始まる Track Namespace (`.session` 含む) は publish / subscribe / fetch / trackStatus / subscribeNamespace / subscribeTracks / publishNamespace で送信前に拒否される
  - `.session` namespace と空 Track Name の組み合わせは DOES_NOT_EXIST 相当で拒否される
- 接続の前に送信できる Track Namespace かを検証する `validateTrackNamespaceForSend` を公開する (draft-ietf-moq-transport-23 §8.7 の 32 フィールド上限、各フィールド 1 バイト以上、4,096 バイト上限と、§2.4.3 / §6.5 の予約 namespace)
  - Full Track Name (Track Namespace と Track Name の合計) の 4,096 バイト上限は Track Name を含めて決まるため、Request の送信時に検証する

### Publisher

- PUBLISH メッセージ
- PUBLISH_DONE メッセージ (Stream Count 対応)
- PUBLISH_STATE_NOTIFY メッセージ (購読状態の変化の通知)
- Object Stream 送信 (Subgroup Header)
- Object Datagram 送信
- Datagram と Subgroup の混在送信
- Publisher Priority
- PAUSED パラメータ (購読の pause / resume)
- Track Properties
  - OBJECT_DELIVERY_TIMEOUT
  - SUBGROUP_DELIVERY_TIMEOUT
  - MAX_CACHE_DURATION
  - DEFAULT_PUBLISHER_PRIORITY
  - DEFAULT_PUBLISHER_GROUP_ORDER
  - DYNAMIC_GROUPS
- EXPIRES パラメータ

### Subscriber

- SUBSCRIBE メッセージ
- SUBSCRIBE_OK メッセージ
- REQUEST_UPDATE メッセージ
- サブスクリプションのキャンセル (双方向ストリームのクローズ)
- PUBLISH_DONE メッセージ (Status Code、Stream Count、Reason Phrase を `SubscribeCallbacks.end` で通知する)
- Object Stream 受信 (Subgroup Header)
- Object Datagram 受信
- Pending Subgroup Buffer
- FETCH メッセージ
- FETCH 成功応答 (REQUEST_OK。FETCH_OK は draft-ietf-moq-transport-23 §1.5 の別名。旧 Type 0x18 は予約値であり、受信すると未知型としてセッションを閉じる)
- Fetch Group Order (Ascending / Descending)
- Location Filter (0x00 None / 0x01 Relative Start / 0x02 Absolute Start / 0x03 Absolute Start, Group End / 0x04 Absolute Range / 0x05 Next Object。fetch() は 0x01 / 0x05 を送信前に拒否する)
- Range Filters (subscribe() / subscribeTracks() / fetch() / update() で送信可能。publisher は受信した Range Filter を送信 Object に適用する)
  - Subgroup Filter
  - Object ID Filter
  - Priority Filter
  - Object Property Filter
  - Track Property Filter (subscribeTracks() のみ)
- Subscriber Priority
- Group Order (Ascending / Descending)
- OBJECT_DELIVERY_TIMEOUT パラメータ
- SUBGROUP_DELIVERY_TIMEOUT パラメータ
- RENDEZVOUS_TIMEOUT パラメータ
- FILL_TIMEOUT パラメータ (Fetch)
- NEW_GROUP_REQUEST パラメータ
- LARGEST_OBJECT パラメータ (0x09。`Subscriber.largestLocation` として公開し、相対 Location Filter と Next Object の基準にする)
- FILL_PARAMETERS パラメータ (subscribe() の `fill` で live 手前の範囲を fill fetch する)
- INCLUDE_PROPERTIES パラメータ (subscribe() / subscribeTracks() / fetch() / trackStatus() で、応答の OK メッセージと SUBSCRIBE_TRACKS が生む PUBLISH に Track Properties を含めるかを指定する)
- TRACK_NAMESPACE_PREFIX パラメータ (namespace 系の REQUEST_UPDATE で購読する prefix を更新する)
- SUBSCRIBE_TRACKS_ID パラメータ (SUBSCRIBE_TRACKS の REQUEST_UPDATE で対象の SUBSCRIBE_TRACKS を指定する)

### コントロールメッセージ

- SETUP
  - AUTHORIZATION_TOKEN Setup Option (REGISTER / USE_VALUE)
  - MAX_AUTH_TOKEN_CACHE_SIZE Setup Option
  - MOQT_IMPLEMENTATION Setup Option
  - MAX_FILTER_RANGES Setup Option
  - MAX_REQUEST_UPDATES Setup Option
  - MAX_CONTROL_MESSAGE_SIZE Setup Option
  - WebTransport 利用時の AUTHORITY Setup Option / PATH Setup Option の受信拒否 (INVALID_AUTHORITY / INVALID_PATH)
- GOAWAY
  - Timeout 対応
  - リクエストストリーム上での受信
- REQUEST_OK (Track Properties 対応)
- REQUEST_ERROR
  - Retry Interval
  - REDIRECT Error Detail
  - REDIRECT / UNSUPPORTED_EXTENSION エラーコード
- PUBLISH_NAMESPACE
- NAMESPACE
- NAMESPACE_DONE
- PUBLISH_SKIPPED
- SUBSCRIBE_NAMESPACE (Namespace 発見)
- SUBSCRIBE_TRACKS (Track 購読)
- TRACK_STATUS
- Parameter Scope 検証 (draft-ietf-moq-transport-23 §9.19.1 の許可パラメータ集合に無い Message Parameter を INVALID_PARAMETER で拒否する)

### データストリーム

- Subgroup Header (FIRST_OBJECT bit 対応)
- Fetch Header
- Object Datagram
- PADDING Stream / Datagram (受信時破棄)
- Object Status (Normal / End of Group / End of Track)
- Object Properties
  - Prior Group ID Gap / Prior Object ID Gap / Immutable Properties
  - OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT
  - Key-Value-Pairs (Figure 4) の delta encoding
- GREASE

## Low Overhead Media Container

[draft-ietf-moq-loc-05](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-05) の機能実装状況である。

### LOC Properties

- Timestamp
- Timescale
- Video Config
- Video Frame Marking
- Audio Config
- Audio Level
- Codec String

### LOC の公開 API

- `LOC` 名前空間として Properties と Object payload の encode / decode を公開する
  - `LOCPropertyId` と各 Property の encode / decode (`encodeVideoProperties` / `decodeAudioProperties` など)
  - Object payload の encode / decode (`encodeLocObjectPayload` / `decodeLocObjectPayload`)
  - Timescale / Video Config / Audio Config / Codec String は `PublishOptions` で Track Property としても広告できる (draft-ietf-moq-loc-05 §6.1 Table 1 の Scope: Track, Object)

CODEC_STRING Property の送信契約は [`PublishOptions.locCodecString`](LOW_LEVEL_API.md#codec_string-loc) を参照。

## MOQT Streaming Format

[draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01) の機能実装状況である。

MSF-01 §5 は catalog の取得に Joining FETCH を MUST としているが、Joining FETCH は MOQT transport draft-20 で削除され draft-23 には存在しない。moqt-js は draft-23 を前提とするため、この要件は draft-23 §3.4 の fill fetch stream (`FILL_PARAMETERS`) として解釈する。現状は `subscribe()` + `fetch()` の 2 リクエストで代替している。

### Catalog

- Root
  - version (`draft-01`) / generatedAt / isComplete / tracks
  - publishTracks / initDataList
- Delta Update
  - deltaUpdate (operation 配列形式)
  - add / remove / clone
- Track
  - namespace / name / packaging / isLive
  - packaging: loc / mediatimeline / eventtimeline / moqlog / moqmetrics
  - role / label / lang / eventType
  - targetLatency / buffers / trackDuration
  - initRef / template
  - parentName / parentNamespace
- Track Grouping
  - renderGroup / altGroup / depends
  - temporalId / spatialId
- Codec / Media
  - codec / mimeType
  - width / height / displayWidth / displayHeight
  - framerate / timescale / bitrate / avgBitrate
  - maxGopDuration / maxGroupDuration
  - samplerate / channelConfig
- Encryption / Auth
  - encryptionScheme / cipherSuite / keyId / trackBaseKey
  - authInfo / accessibility
- Publish Track
  - connectionUri / token

### Timeline

- Media Timeline
- Event Timeline
- Timeline の payload は無圧縮 JSON のみ (MSF_COMPRESSION による圧縮は未実装)

### MOQ Log / MOQ Metrics

MSF-01 §9.2 / §10.2 は旧 log-03 / metrics-02 を参照しており、payload の §9.1 / §10.1 も旧版を参照している。Log は log-04 のバイナリ Log Record / 秒 Group、Metrics の catalog は metrics-03 §5.3、data Object は metrics-02 §3 の JSON である。

- `MOQLOG` 名前空間として Log track の payload を公開する
  - 名前は [draft-jennings-moq-log-04](https://datatracker.ietf.org/doc/html/draft-jennings-moq-log-04) §4 / §5.1、publishTracks template は §6
  - payload は log-04 §5.3 のバイナリ Log Record、Group は §5.2 の秒単位。MSF-01 §9.1 は旧 log-03 §4 の JSON を参照し、§9.3 は 62-bit マイクロ秒の旧契約を定義している
  - `LogRecord` / `LogAttribute` のエンコード / デコード (`encodeLogRecord` / `decodeLogRecord`) と、Group ID / Object ID / Prior Group ID Gap / 3 field の namespace / ASCII 数字の track name / publishTracks template の算出
- `MOQMETRICS` 名前空間として Metrics track の payload を公開する
  - 名前は [draft-jennings-moq-metrics-03](https://datatracker.ietf.org/doc/html/draft-jennings-moq-metrics-03) §4.1 / §5.1 / §5.2、publishTracks template は §6
  - catalog は metrics-03 §5.3 の Header / Metric Description、data Object は引き続き [draft-jennings-moq-metrics-02](https://datatracker.ietf.org/doc/html/draft-jennings-moq-metrics-02) §3 / draft-ietf-moq-msf-01 §10.1。catalog の Group ID は catalog version で、Header の format Version とは別
  - `MetricsCatalogHeader` / `MetricDescription` のエンコード / デコード、`metricsCatalogGroupId` / `metricObjectId` と、data の Capture Object / Metric Object / 3 field の namespace / ASCII 数字の track name / catalog Track Name / publishTracks template の算出
  - Metric Index は 1 つの catalog version 内で resource 全体に一意で、data track ごとに振り直さない。新しい version では再割当できるが、Object ID filter を保つため可能な限り維持する

### URI / 認可

- MSF URI Fragment の `c4m` を `SETUP` の Authorization Token として送出する
- `SETUP` に載せたトークンを catalog の `SUBSCRIBE` / `FETCH` と `authInfo` を持つトラックの購読に付与する
- `SETUP` に載せたトークンを `PUBLISH` / `PUBLISH_NAMESPACE` に付与する

Fragment の解析と認可の契約は [MOQT Streaming Format](MSF.md)、
C4M の claim と認可の契約は [低レベル API](LOW_LEVEL_API.md) を参照。

## C4M

[draft-ietf-moq-c4m-02](https://datatracker.ietf.org/doc/html/draft-ietf-moq-c4m-02) の CAT (Common Access Token) の実装状況である。
API の契約は [低レベル API](LOW_LEVEL_API.md) の C4M の節を参照。

### 対応済み

- `C4M` 名前空間の CBOR (RFC 8949) / COSE (RFC 9052) / CAT / JWK (RFC 7517) のコーデック
- CAT のデコード (`CatToken.decode` / `decodeCompact` / `decodeCose`) と検証 (`CatToken.verify`)、発行 (`CatTokenBuilder`)
- `moqt` / `moqt-reval` / `catdpop` クレームの解釈と、action / namespace / track の認可 (`authorizeCatClaims`)
- `cnf` の ckt (key 5) / jkt (key 323) の保持と取り出し
- JWK のデコード / エンコードと、サムプリント (RFC 7638) の算出
- MSF URI Fragment の `c4m` を `SETUP` の Authorization Token として送出

### 未対応

- DPoP proof の作成、送信、検証。`cnf` を持つトークンは、呼び出し側が DPoP proof を検証済みと明示した場合だけ認可する ([認可](LOW_LEVEL_API.md#未知の-raw-claim-と認可))
- 複合クレーム (`or` / `and` / `nor`、draft-ietf-moq-c4m-02 付録 A.6) の評価
- ckt (COSE Key Thumbprint、RFC 9679) の算出

### 制約

- `moqt` / `moqt-reval` の claim key は IANA 未割当のため、`C4mClaimLabels` で peer と事前に合意した値を明示する ([claim label](LOW_LEVEL_API.md#c4m-の-claim-label))
- Token Type 1 (CAT) の一次ワイヤ形式は COSE であり、compact 形式は旧 C4M 01 付録 A の汎用 helper に留まる ([ワイヤ形式](LOW_LEVEL_API.md#c4m-のワイヤ形式))
- C4M 01 の API (`CLAIM_MOQT` / `CLAIM_MOQT_REVAL` / `Confirmation.c4mDraftJwkThumbprint` など) は C4M 02 対応で削除または改名しており、後方互換の alias は無い
