# Peer-initiated request の受信デコードと SessionMachine 配線

Created: 2026-04-19
Completed: 2026-04-19
Model: Claude Opus 4.7

## 概要

現状の `Session` (I/O ラッパー、`src/session/session.ts`) は自らが送信した request (outgoing SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE / REQUEST_UPDATE) の応答処理しか実装していない。
peer から開始された双方向ストリームで届く request 系メッセージのデコードと、それを SessionMachine に流し込む経路が一切存在しない。

その結果、本ライブラリは pure subscriber / pure fetcher としては動作するが、publisher role で peer から SUBSCRIBE を受けて応答する、subscriber role で peer から PUBLISH を受けて応答する、といった双方向ユースケースに対応できない。

本 issue でこの欠落を埋める。

## 背景

- #0073 で導入した sans-I/O `SessionMachine` 側には `handleStreamMessage` / `validatePeerRequest` / `handlePeerSubscribe` 系の入力は実装済み
- #0077 で Session → SessionMachine への受信配線を整備したが、対象はあくまで outgoing request の応答のみ
- #0077 の close 時残課題として明示していた peer-initiated request 対応を、別 issue として切り出すのが本 issue

## 方針

1. **受信デコーダの実装**: `src/session/session.ts` の `handleIncomingBidirectionalStream` 相当で、peer から開かれた双方向ストリームの先頭メッセージをデコードし、SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE / REQUEST_UPDATE を識別する
2. **SessionMachine への feed**: デコード後すぐに `SessionMachine.handleStreamMessage(requestId, msg)` を呼び、`drainMachineEvents()` でイベントを消化する
3. **AUTHORIZATION_TOKEN 受信**: 各 request の parameters から `processIncomingAuthTokens` を呼び、peer 側キャッシュを更新する (#0076 で実装済み API を使う)
4. **User 向けコールバックの設計**: peer の request を受理して応答する API 層を新設する。既存の `callbacks.subscriber` 系に合わせた形にするか、publisher / subscriber それぞれのハンドラを分ける形にするかは実装時に決める
5. **応答経路**: 受理したらアプリ側から `respondSubscribe(requestId, trackAlias, ...)` のような関数で SUBSCRIBE_OK / REQUEST_ERROR を返せるようにする
6. **REQUEST_UPDATE**: 受信時は既存 SUBSCRIBE / FETCH の window 更新として処理する

### 受信対象メッセージ

draft-ietf-moq-transport-17 の §9.4 以降に定義された以下 7 種類。

| MessageType                | セクション | 用途                                      |
| -------------------------- | ---------- | ----------------------------------------- |
| SUBSCRIBE (0x03)           | §9.4       | peer が subscribe を開始                  |
| PUBLISH (0x1D)             | §9.8       | peer が publish を開始                    |
| FETCH (0x16)               | §9.12      | peer が fetch を開始                      |
| TRACK_STATUS (0x0D)        | §9.14      | peer が track の状態を問い合わせ          |
| SUBSCRIBE_NAMESPACE (0x11) | §9.18      | peer が namespace 購読を開始              |
| PUBLISH_NAMESPACE (0x1E)   | §9.16      | peer が namespace announce を開始         |
| REQUEST_UPDATE (0x02)      | §9.6       | peer が既存 subscription の window を更新 |

### 段階的な進め方

1. Phase 1: peer-initiated SUBSCRIBE / PUBLISH のデコード + SessionMachine への feed + user コールバック API 設計
2. Phase 2: peer-initiated FETCH / TRACK_STATUS
3. Phase 3: peer-initiated SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE
4. Phase 4: REQUEST_UPDATE の受信処理
5. Phase 5: 応答経路 (respond\* API) の仕上げと Playwright / examples での動作確認

各 Phase を 1 コミット、typecheck / test / build 緑を維持する。

## 影響範囲

- `src/session/session.ts` の `handleIncomingBidirectionalStream` 相当
- user 向け公開 API 追加 (`callbacks` への追加か、新規メソッド群か)
- `CHANGES.md` に `[ADD]` として記載

既存 outgoing request の挙動は変えない。`Session` の公開 API は追加のみ、破壊的変更なし。

## リスク

| ID  | リスク                                                                            | 緩和                                                                                           |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1  | User API の設計が既存 callbacks と一貫しない                                      | 実装前に API 草案を issue に追記してレビューする                                               |
| R2  | Decoder のエッジケース不足で peer から来た malformed request でセッションが落ちる | 各メッセージ decoder に対して fast-check ベースの PBT を追加する                               |
| R3  | REQUEST_UPDATE の window 更新処理が既存 subscription state を破壊する             | SessionMachine 側の `handlePeerRequestUpdate` 経由で状態変更し、Session 側の独自遷移は書かない |

## 進捗

### Phase 1 完了 (2026-04-19)

- `SessionMachine` に `handlePeerSubscribe` / `handlePeerPublish` を追加した
  - `validatePeerRequest` / `processIncomingAuthTokens` / track 重複 / Track Alias 重複を検証する
  - peer SUBSCRIBE は `initiator="subscriber", myRole="publisher"`、peer PUBLISH は `initiator="publisher", myRole="subscriber"` として `SubscriptionEntry` を登録する
  - Track Alias は自側 SUBSCRIBE_OK で確定する peer publisher 空間 (`_peerPublisherAliases`) を共有する
- `SessionEvent` に `peerSubscribeReceived` / `peerPublishReceived` を追加した
- `Session` に `startIncomingRequestStreamLoop` / `handleIncomingRequestStream` を追加し、`transport.incomingBidirectionalStreams` から peer が開いた bidi stream を受け付けて先頭メッセージを `MessageType` で振り分ける
  - Phase 1 スコープ外の MessageType は `PROTOCOL_VIOLATION` でセッションを閉じる
  - peer-initiated bidi stream は `peerInitiatedStreams` Map に保持し、Phase 5 で追加する respond API で同ストリームに SUBSCRIBE_OK / PUBLISH_OK を書き戻す予定
- `ConnectCallbacks` に `peerSubscribe` / `peerPublish` と `PeerSubscribeRequest` / `PeerPublishRequest` 型を追加した
- `src/session/peerRequest.prop.ts` に fast-check ベースの PBT を追加した

### Phase 2 完了 (2026-04-19)

- `SessionMachine` に `handlePeerFetch` / `handlePeerTrackStatus` を追加した
  - `FetchEntry` は `createFetchEntry(msg, "publisher")` で登録し、Joining FETCH の `joiningRequestId` 先の存在検証は respond API (Phase 5) に回す
  - `TrackStatusEntry` は `createTrackStatusEntry({ myRole: "publisher", ... })` で登録する
  - Request ID 重複は `validatePeerRequest` が `_peerRequestIds` で横断的に検出するため、Map 単位の重複チェックは省略する
- `SessionEvent` に `peerFetchReceived` / `peerTrackStatusReceived` を追加した
- `Session.handleIncomingRequestStream` の switch に `FETCH` / `TRACK_STATUS` ケースを追加した
- `ConnectCallbacks` に `peerFetch` / `peerTrackStatus` と `PeerFetchRequest` / `PeerTrackStatusRequest` 型を追加した
- `src/session/peerRequest.prop.ts` に Phase 2 用の PBT を追加した

### Phase 3 完了 (2026-04-19)

- `SessionMachine` に `handlePeerSubscribeNamespace` / `handlePeerPublishNamespace` を追加した
  - SUBSCRIBE_NAMESPACE は `NamespaceSubscriptionEntry` を `myRole="publisher"` で登録する
  - PUBLISH_NAMESPACE は `NamespacePublicationEntry` を `myRole="subscriber"` で登録する
- `SessionEvent` に `peerSubscribeNamespaceReceived` / `peerPublishNamespaceReceived` を追加した
- `Session.handleIncomingRequestStream` に `SUBSCRIBE_NAMESPACE` / `PUBLISH_NAMESPACE` 分岐を追加した
- `ConnectCallbacks` に `peerSubscribeNamespace` / `peerPublishNamespace` と対応する Request 型を追加した
- `src/session/peerRequest.prop.ts` に Phase 3 用の PBT を追加した

### Phase 4 完了 (2026-04-19)

- `Session.readPeerInitiatedStreamMessages` を追加し、peer-initiated bidi stream の先頭メッセージ受理後に continuously 読み取るようにした
  - `REQUEST_UPDATE` / `PUBLISH_DONE` を `forwardStreamMessageToMachine` 経由で SessionMachine に流す
  - SessionMachine 側は既存の `handlePeerRequestUpdate` / `handlePeerPublishDone` で処理し、`requestUpdateReceived` / `publishDoneReceived` イベントを出す
  - スコープ外の follow-up メッセージは `PROTOCOL_VIOLATION` でセッションを閉じる
  - ストリーム終了時に `peerInitiatedStreams` からエントリを除去する
- `peerRequest.prop.ts` に peer-initiated SUBSCRIBE 後の REQUEST_UPDATE、peer-initiated PUBLISH 後の PUBLISH_DONE を検証する PBT を追加した

### Phase 5 完了 (2026-04-19)

- `SessionMachine` に 6 種類の accept メソッドと統一 `rejectPeerRequest` を追加した
  - accept: `acceptPeerSubscribe` / `acceptPeerPublish` / `acceptPeerFetch` / `acceptPeerTrackStatus` / `acceptPeerSubscribeNamespace` / `acceptPeerPublishNamespace`
  - reject: `rejectPeerRequest` (SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE のいずれも対象)
  - accept 時は対応する OK メッセージを `sendOnStream` イベントで積み、エントリ状態を `established` / `completed` に遷移させる
  - SUBSCRIBE accept は `_myPublisherAliases` に `trackAlias` を登録し、重複時は `DUPLICATE_TRACK_ALIAS` で throw する
- `Session` の公開 API に `acceptPeerSubscribe` / `acceptPeerPublish` / `acceptPeerFetch` / `acceptPeerTrackStatus` / `acceptPeerSubscribeNamespace` / `acceptPeerPublishNamespace` / `rejectPeerRequest` を追加した
  - 各メソッドは `peerInitiatedStreams` から stream を取り出し、`ControlStreamWriter` でフレーミングして書き込む
  - `acceptPeerSubscribe` は `trackAlias` 省略時に `nextTrackAlias++` で自動採番する
- `peerRequest.prop.ts` に accept / reject の状態遷移・イベント発火・TrackAlias 重複検知などの PBT を追加した

## 完了

Phase 1-5 の全実装を完了した。Phase 5 の `Playwright / examples での動作確認` は対向サーバー・相互運用デモに依存するため別 issue で追跡する。

本 issue はここで close する。

## 参考

- draft-ietf-moq-transport-17 §9.4 SUBSCRIBE
- draft-ietf-moq-transport-17 §9.6 REQUEST_UPDATE
- draft-ietf-moq-transport-17 §9.8 PUBLISH
- draft-ietf-moq-transport-17 §9.12 FETCH
- draft-ietf-moq-transport-17 §9.14 TRACK_STATUS
- draft-ietf-moq-transport-17 §9.16 PUBLISH_NAMESPACE
- draft-ietf-moq-transport-17 §9.18 SUBSCRIBE_NAMESPACE
