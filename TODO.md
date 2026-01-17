# moqt-js TODO

RFC draft-ietf-moq-transport-16、draft-ietf-moq-loc-01、draft-ietf-moq-msf-latest 準拠の実装計画。

## MOQT (draft-ietf-moq-transport-16)

### 完了済み

#### メッセージ

- [x] CLIENT_SETUP / SERVER_SETUP
- [x] SUBSCRIBE / SUBSCRIBE_OK / UNSUBSCRIBE
- [x] REQUEST_UPDATE 送信 (旧 SUBSCRIBE_UPDATE)
- [x] PUBLISH / PUBLISH_OK / PUBLISH_DONE
- [x] REQUEST_OK / REQUEST_ERROR (Retry Interval 対応)
- [x] GOAWAY 送受信
- [x] MAX_REQUEST_ID 受信
- [x] REQUESTS_BLOCKED 受信
- [x] FETCH / FETCH_OK
- [x] TRACK_STATUS
- [x] PUBLISH_NAMESPACE / PUBLISH_NAMESPACE_CANCEL

#### データストリーム

- [x] Subgroup Header (全 24 タイプ)
- [x] Object Fields (Extensions/Status 対応)
- [x] Object Datagram (encode/decode)
- [x] Fetch Header/Object (encode/decode)
- [x] Datagram 送受信 (Session, Publisher, Subscriber)
- [x] 同一トラックで Datagram と Stream の混在

#### draft-16 対応済み

ワイヤフォーマット変更:

- [x] パラメータのデルタエンコーディング (Section 9.2)
  - Type 値を差分としてエンコード（例: Type 0x02, 0x04 → Delta 2, 2）
  - パラメータは Type の昇順でなければならない
- [x] REQUEST_ERROR に Retry Interval 追加
- [x] PUBLISH_NAMESPACE_DONE/CANCEL に Request ID 追加
- [x] PUBLISH, SUBSCRIBE_OK, FETCH_OK に Extension Headers 追加
- [x] Object Status の処理方法変更

機能変更:

- [x] SUBSCRIBE_UPDATE を REQUEST_UPDATE に変更 (Section 9.11)
- [x] TRACK_STATUS から配信関連パラメータ削除
- [x] TRACK_STATUS に LARGEST_OBJECT パラメータ追加
- [x] SUBSCRIBE_NAMESPACE で空/ワイルドカード namespace 許可
- [x] FETCH レスポンスで不明な範囲を許可
- [x] DELIVERY_TIMEOUT=0 を禁止
- [x] REQUEST_UPDATE で Start Location 減少許可

draft-16 未対応:

- [ ] SUBSCRIBE_NAMESPACE を専用の双方向ストリームで送受信 (Section 6.1)
- [ ] Subgroup 再オープン禁止

### 未実装

#### SUBSCRIBE_NAMESPACE (機能未完成)

API は存在するが、実際にはトラック発見が動作しない。

- [x] Session.subscribeNamespace() メソッド
- [x] Session.publishNamespace() メソッド
- [x] SUBSCRIBE_NAMESPACE 送信
- [x] REQUEST_OK/REQUEST_ERROR 受信
- [ ] NAMESPACE 受信処理
- [ ] NAMESPACE_DONE 受信処理
- [ ] PUBLISH_NAMESPACE_DONE 受信処理

#### セッション制御

- [ ] MAX_REQUEST_ID 送信メソッド
- [ ] REQUESTS_BLOCKED 送信メソッド
- [ ] REQUESTS_BLOCKED 受信時に MAX_REQUEST_ID を送信するロジック

#### REQUEST_UPDATE 受信

- [ ] Publisher が Relay から REQUEST_UPDATE を受信したときの処理
- [ ] FORWARD パラメータ変更時の forwardState 更新

### Message Parameters (Section 9.2.2)

完全実装（encode + receive 処理）:

- [x] SUBSCRIPTION_FILTER (0x21) - SUBSCRIBE でのフィルタ指定
- [x] LARGEST_OBJECT (0x09) - SUBSCRIBE_OK から受信して Joining Fetch で使用
- [x] FORWARD (0x10) - encode + PUBLISH_OK での forwardState 更新

送信のみ実装（リレー側で処理）:

- [x] DELIVERY_TIMEOUT (0x02) - リレーがタイムアウト管理
- [x] MAX_CACHE_DURATION (0x04) - リレーがキャッシュ管理
- [x] PUBLISHER_PRIORITY (0x0E) - リレーが優先度制御
- [x] SUBSCRIBER_PRIORITY (0x20) - リレーが優先度制御
- [x] GROUP_ORDER (0x22) - リレーが順序制御
- [x] EXPIRES (0x08) - リレーが有効期限管理

Publisher 側での受信処理が必要:

- [x] DYNAMIC_GROUPS (0x30) - encode のみ
  - [ ] Publisher が REQUEST_UPDATE で NEW_GROUP_REQUEST を受信する処理
- [x] NEW_GROUP_REQUEST (0x32) - encode のみ
  - [ ] Publisher が受信して新グループを生成する処理

未実装:

- [ ] AUTHORIZATION_TOKEN (0x03) - Section 9.2.2.1
  - [ ] Token 構造の encode/decode
  - [ ] Alias Type (DELETE, REGISTER, USE_ALIAS, USE_VALUE)
  - [ ] Token Alias の管理
  - [ ] エラー処理 (DUPLICATE_AUTH_TOKEN_ALIAS, UNKNOWN_AUTH_TOKEN_ALIAS, MALFORMED_AUTH_TOKEN, EXPIRED_AUTH_TOKEN)

### Setup Parameters (Section 9.3.1)

- [ ] MAX_AUTH_TOKEN_CACHE_SIZE (0x04) - Section 9.3.1.4
- [x] MOQT_IMPLEMENTATION (0x07) - Section 9.3.1.6

### Extension Headers (Section 11)

encode/decode のみ実装（Session での送受信処理は未実装）:

- [x] Prior Group ID Gap (0x3C) - encode/decode のみ
  - [ ] Subscriber での受信処理（スキップされたグループの検知）
- [x] Prior Object ID Gap (0x3E) - encode/decode のみ
  - [ ] Subscriber での受信処理（スキップされたオブジェクトの検知）
- [x] Immutable Extensions (0x0B) - encode/decode のみ
  - [ ] Publisher での送信処理
  - [ ] Subscriber での受信処理

## LOC (draft-ietf-moq-loc-01)

### 完了済み

createMediaPublisher / createMediaSubscriber で使用:

- [x] Capture Timestamp (ID: 2)
- [x] Video Frame Marking (ID: 4)

encode/decode のみ（高レベル API で未使用）:

- [x] Video Config (ID: 13)
- [x] Audio Level (ID: 6)

## MSF (draft-ietf-moq-msf-latest)

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
