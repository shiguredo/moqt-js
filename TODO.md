# moqt-js TODO

RFC draft-ietf-moq-transport-17、draft-ietf-moq-loc-02、draft-ietf-moq-msf-00 準拠の実装計画。

## MOQT (draft-ietf-moq-transport-17)

### 完了済み

#### メッセージ

- [x] SETUP (Section 9.4)
- [x] SUBSCRIBE / SUBSCRIBE_OK (Section 9.8, 9.9)
- [x] REQUEST_UPDATE 送信 (Section 9.10)
- [x] PUBLISH / PUBLISH_OK / PUBLISH_DONE (Section 9.11, 9.12, 9.13)
- [x] REQUEST_OK / REQUEST_ERROR (Section 9.6, 9.7)
- [x] GOAWAY 送受信 (Section 9.5)
- [x] FETCH / FETCH_OK (Section 9.14, 9.15)
- [x] TRACK_STATUS (Section 9.16)
- [x] PUBLISH_NAMESPACE (Section 9.17)
- [x] SUBSCRIBE_NAMESPACE (Section 9.20)
- [x] PUBLISH_BLOCKED (Section 9.21)

#### データストリーム

- [x] Subgroup Header (Section 10.4.2)
- [x] Object Fields (Properties/Status 対応) (Section 10.2.1)
- [x] Object Datagram (encode/decode) (Section 10.3.1)
- [x] Fetch Header/Object (encode/decode) (Section 10.4.4)
- [x] Datagram 送受信 (Session, Publisher, Subscriber)
- [x] 同一トラックで Datagram と Stream の混在

#### draft-17 対応済み

破壊的変更:

- [x] 新しい可変長整数エンコーディング (Section 1.4.1)
- [x] 制御ストリームを双方向から単方向ペアに変更 (Section 3.3)
- [x] CLIENT_SETUP / SERVER_SETUP を単一 SETUP に統合 (Section 9.4)
- [x] リクエスト (SUBSCRIBE/PUBLISH/FETCH 等) を双方向ストリームに移動 (Section 3.3)
- [x] キャンセルメッセージ削除 (STOP_SENDING/RESET_STREAM で代替)
- [x] MAX_REQUEST_ID / REQUESTS_BLOCKED 削除 (Section 9.1)
- [x] Message Parameters を Type-Value ペアに変更 (Section 9.3)
- [x] Required Request ID Delta 追加 (Section 9.2)
- [x] REQUEST_OK / REQUEST_ERROR から Request ID 削除 (Section 9.6, 9.7)

新機能:

- [x] GOAWAY に Timeout フィールド追加 (Section 9.5)
- [x] PUBLISH_BLOCKED メッセージ (Section 9.21)
- [x] RENDEZVOUS_TIMEOUT パラメータ (Section 9.3.4)
- [x] GREASE 対応 (Section 13)
- [x] Joining FETCH で PUBLISH/REQUEST_UPDATE の forward=1 対応 (Section 9.14.2)
- [x] 新エラーコード追加 (Section 3.5, 14.5)

名称変更:

- [x] Extension Headers → Properties (Section 11)
- [x] Setup Parameters → Setup Options (Section 9.4.1)

その他:

- [x] DELIVERY_TIMEOUT=0 を許可 (タイムアウトなし) (Section 9.3.3)
- [x] EndGroup Filter をデルタに変更 (Section 9.3.7)
- [x] REQUEST_UPDATE から TRACK_STATUS 削除 (Section 9.10)
- [x] Property Type 範囲予約 (Section 11)
- [x] ゼロ要素ネームスペース許可 (Section 2.4.1)
- [x] Track Namespace/Name エンコーディング制約 (Section 1.5.1)
- [x] DELIVERY_TIMEOUT 最小要件をプロパティにコピー (Section 11.1)

### 未実装

#### SUBSCRIBE_NAMESPACE (機能未完成)

API は存在するが、実際にはトラック発見が動作しない。

- [x] Session.subscribeNamespace() メソッド
- [x] Session.publishNamespace() メソッド
- [x] SUBSCRIBE_NAMESPACE 送信 (Section 9.20)
- [x] REQUEST_OK/REQUEST_ERROR 受信 (Section 9.6, 9.7)
- [ ] NAMESPACE 受信処理 (Section 9.18)
- [ ] NAMESPACE_DONE 受信処理 (Section 9.19)

#### REQUEST_UPDATE 受信

- [ ] Publisher が Relay から REQUEST_UPDATE を受信したときの処理 (Section 9.10)
- [ ] FORWARD パラメータ変更時の forwardState 更新 (Section 9.3.10)

### Message Parameters (Section 9.3)

完全実装（encode + receive 処理）:

- [x] SUBSCRIPTION_FILTER (0x21) - SUBSCRIBE でのフィルタ指定 (Section 9.3.7)
- [x] LARGEST_OBJECT (0x09) - SUBSCRIBE_OK から受信して Joining Fetch で使用 (Section 9.3.9)
- [x] FORWARD (0x10) - encode + PUBLISH_OK での forwardState 更新 (Section 9.3.10)

送信のみ実装（リレー側で処理）:

- [x] DELIVERY_TIMEOUT (0x02) - リレーがタイムアウト管理 (Section 9.3.3)
- [x] MAX_CACHE_DURATION (0x04) - リレーがキャッシュ管理
- [x] PUBLISHER_PRIORITY (0x0E) - リレーが優先度制御
- [x] SUBSCRIBER_PRIORITY (0x20) - リレーが優先度制御 (Section 9.3.5)
- [x] GROUP_ORDER (0x22) - リレーが順序制御 (Section 9.3.6)
- [x] EXPIRES (0x08) - リレーが有効期限管理 (Section 9.3.8)
- [x] RENDEZVOUS_TIMEOUT (0x04) - リレーが待機管理 (Section 9.3.4)

Publisher 側での受信処理が必要:

- [x] DYNAMIC_GROUPS (0x30) - encode のみ
  - [ ] Publisher が REQUEST_UPDATE で NEW_GROUP_REQUEST を受信する処理
- [x] NEW_GROUP_REQUEST (0x32) - encode のみ (Section 9.3.11)
  - [ ] Publisher が受信して新グループを生成する処理

未実装:

- [ ] AUTHORIZATION_TOKEN (0x03) - Section 9.3.2
  - [ ] Token 構造の encode/decode
  - [ ] Alias Type (DELETE, REGISTER, USE_ALIAS, USE_VALUE)
  - [ ] Token Alias の管理
  - [ ] エラー処理 (DUPLICATE_AUTH_TOKEN_ALIAS, UNKNOWN_AUTH_TOKEN_ALIAS, MALFORMED_AUTH_TOKEN, EXPIRED_AUTH_TOKEN)

### Setup Options (Section 9.4.1)

- [ ] MAX_AUTH_TOKEN_CACHE_SIZE (0x04) - Section 9.4.1
- [x] MOQT_IMPLEMENTATION (0x07) - Section 9.4.1

### Properties (Section 11)

encode/decode のみ実装（Session での送受信処理は未実装）:

- [x] Prior Group ID Gap (0x3C) - encode/decode のみ (Section 11.7)
  - [ ] Subscriber での受信処理（スキップされたグループの検知）
- [x] Prior Object ID Gap (0x3E) - encode/decode のみ (Section 11.8)
  - [ ] Subscriber での受信処理（スキップされたオブジェクトの検知）
- [x] Immutable Properties (0x0B) - encode/decode のみ (Section 11.6)
  - [ ] Publisher での送信処理
  - [ ] Subscriber での受信処理

## LOC (draft-ietf-moq-loc-02)

### 完了済み

createMediaPublisher / createMediaSubscriber で使用:

- [x] Timestamp (ID: 0x06) - draft-01 の Capture Timestamp (ID: 2) から変更
- [x] Video Frame Marking (ID: 4)

encode/decode のみ（高レベル API で未使用）:

- [x] Timescale (ID: 0x08) - draft-02 で新規追加
- [x] Video Config (ID: 13)
- [x] Audio Level (ID: 6) - 注意: TIMESTAMP (0x06) と ID 衝突 (draft バグ、IANA 割り当て待ち)

### 用語変更 (draft-02)

- [x] "Header Extensions" → "Properties" に変更 (draft-17 の Properties に合わせて)
- [x] `captureTimestamp` → `timestamp` に変更
- [x] `LOCHeaderExtensionId` → `LOCPropertyId` に変更
- [x] `encodeVideoHeaderExtensions` → `encodeVideoProperties` に変更
- [x] `decodeVideoHeaderExtensions` → `decodeVideoProperties` に変更
- [x] `encodeAudioHeaderExtensions` → `encodeAudioProperties` に変更
- [x] `decodeAudioHeaderExtensions` → `decodeAudioProperties` に変更
- [x] `VideoHeaderExtensions` → `VideoProperties` に変更
- [x] `AudioHeaderExtensions` → `AudioProperties` に変更

## MSF (draft-ietf-moq-msf-00)

### 完了済み

createMediaPublisher / createMediaSubscriber で使用:

- [x] Catalog JSON フォーマットの型定義 (CatalogTrack, Catalog)
- [x] Catalog の encode/decode (encodeCatalog, decodeCatalog)
- [x] Delta 更新の処理 (applyCatalogDelta)
- [x] ヘルパー関数 (getVideoTracks, getAudioTracks, getTrackByName, etc.)
- [x] ABR トラック選択 (selectTrackByMaxBitrate, selectTrackByMaxResolution, etc.)
- [x] Group 番号付け (createInitialGroupId, nextGroupId)

encode/decode のみ（高レベル API で未使用）:

- [x] Media Timeline の型定義と encode/decode (MediaTimelineEntry)
- [x] Event Timeline の型定義と encode/decode (EventTimelineEntry)

### 未実装

- [ ] GZIP 圧縮/展開対応 (Media Timeline, Event Timeline)
