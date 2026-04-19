# Session の受信経路を SessionMachine に統合する

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

`Session` (I/O ラッパー、`src/session/session.ts`) と `SessionMachine` (sans-I/O 状態機械、`src/session/machine.ts`) が二層で状態を管理している。
特に致命的な問題として、`SessionMachine.handleStreamMessage` が `Session` から一度も呼ばれておらず、
SETUP 以外のメッセージ (SUBSCRIBE / PUBLISH / FETCH / NAMESPACE / REQUEST_OK / REQUEST_ERROR / PUBLISH_DONE / REQUEST_UPDATE など) は
SessionMachine の状態機械に一切反映されていない。

その結果以下が起きている。

- `SessionMachine` の `SubscriptionEntry` / `FetchEntry` / `NamespacePublicationEntry` 等は `send*` 系を呼んだときだけ "pending" で登録され、その後の状態遷移 (established / terminated) は Session 側の独自処理で行われる
- AUTHORIZATION_TOKEN の peer 側キャッシュ更新が必ず skip される
- GOAWAY タイムアウトが `tick` 駆動ではなく旧来の `setTimeout` 経由でも動く (#0073 の整理不足)
- 今後 sans-I/O 層だけ見れば完結するはずの不変条件 (Request ID parity 検証など) が、実際には受信時に検証されていない

本 issue で Session の受信経路を SessionMachine に流し込み、SessionMachine を source of truth として機能させる。

## 背景

#0073 close 時に「SessionImpl の Promise 管理と SessionMachine のエンティティ管理の完全統合」を残課題として明記していた。
#0076 で送信側 AUTHORIZATION_TOKEN は配線済みだが、受信側は Session が SessionMachine を呼び出していないため効いていない。

## 方針

I/O を持つ Session 側の責務は以下に限定する。

- WebTransport 制御ストリーム / 双方向ストリーム / データストリームの入出力
- `Promise` ベースの非同期 API (`subscribe` / `publish` / `fetch` など) とそれに紐づく `resolve` / `reject` 管理
- User 向けコールバック (`callbacks.subscriber` / `pending.objectCallback` など) の呼び出し
- 時刻起点 (`setInterval` で `tick` を呼ぶ)

状態遷移 / Request ID 採番・検証 / Subscription や Fetch の kind / AuthTokenCache / GOAWAY の deadline 判定は `SessionMachine` が一元管理する。
Session 側で同じ判定を重複して書かない。

### 具体的な配線

1. **受信時**: メッセージをデコードしたら、まず `SessionMachine.handleStreamMessage(requestId, msg)` または `handleControl(msg)` を呼ぶ
2. **イベント消化**: `SessionMachine.nextEvent()` をドレインし、下記に応じて Session の動作を実行する
   - `closeSession`: Session を指定エラーで閉じる
   - `namespaceReceived` / `namespaceDoneReceived` / `publishBlockedReceived` / `publishDoneReceived` / `requestUpdateReceived` / `goawayReceived`: 対応する user コールバックを呼ぶ
3. **送信時**: `send*` を呼んだ後も `nextEvent()` をドレインする (send 系から積まれる `sendControl` / `sendRequest` / `sendOnStream` は既に I/O 層に翻訳済みなので破棄してよい)

### 段階的な進め方

1. Phase 1: `readSubscribeResponse` / `readPublishResponse` / `readFetchResponse` で SessionMachine に feed する
2. Phase 2: Namespace / TrackStatus / RequestUpdate / PublishDone / PublishNamespace の受信経路に feed する
3. Phase 3: 全体の `nextEvent` ドレインループを整備し、`closeSession` / notification 系イベントを user 層に橋渡しする
4. Phase 4: Session 側で SessionMachine に置換可能な状態 (subscribersByAlias の重複判定、forwardState の抽出など) を削減する

各 Phase を 1 コミットにまとめ、各 Phase 完了時に typecheck / test / build 緑を維持する。

## 影響範囲

- `src/session/session.ts` の受信経路全般
- `src/session/machine.ts` に、現状未対応の受信メッセージに対応する分岐を追加する可能性あり
- 既存テスト (`*.prop.ts` / `*.test.ts`) は sans-I/O 側は既に整備済み。Session 側の結合テストは既存のまま緑で通す

## リスク

| ID  | リスク                                                                                                  | 緩和                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R1  | SessionMachine が handleStreamMessage で PROTOCOL_VIOLATION を投げる分岐が Session の現実と合っていない | 最初は失敗時 `closeSession` を積むだけに留め、既存 Session 挙動を優先する。SessionMachine の検証は PBT でカバー |
| R2  | イベントドレインの重複処理で user コールバックが 2 回呼ばれる                                           | Session 側の独自分岐を外すのは Phase 4 以降に回す                                                               |
| R3  | 大規模書き換えで既存 Playwright e2e / devtools が壊れる可能性                                           | 各 Phase で typecheck / test / build すべて緑を確認                                                             |

Completed: 2026-04-19

## 解決方法

### 統合のための基盤

`Session` (I/O ラッパー) に以下 2 つのヘルパーを追加した。

- `forwardStreamMessageToMachine(requestId, msg)`: `SessionMachine.handleStreamMessage` を呼んだ後 `drainMachineEvents` を走らせる。`closeSession` が積まれたら `false` を返して上位が早期 return できるようにする
- `drainMachineEvents()`: SessionMachine のイベントキューを消化する。`closeSession` なら Session を閉じる。`sendControl` / `sendRequest` / `sendOnStream` / `established` は I/O 層で既に処理済みなので無視、notification 系 (`goawayReceived` / `requestUpdateReceived` / `publishDoneReceived` / `namespaceReceived` / `namespaceDoneReceived` / `publishBlockedReceived`) は Session 側の独自処理に任せるため現時点では無視する

### 配線箇所

以下の受信経路で SessionMachine に流し込んでいる。

- `readPublishResponse`: PUBLISH_OK / REQUEST_ERROR
- `readSubscribeResponse`: SUBSCRIBE_OK / REQUEST_ERROR (SUBSCRIBE_OK では Session 側の DUPLICATE_TRACK_ALIAS 重複チェックを SessionMachine 側に一元化した)
- `readFetchResponse`: FETCH_OK / REQUEST_ERROR
- `readTrackStatusResponse`: REQUEST_OK / REQUEST_ERROR
- SUBSCRIBE_NAMESPACE 応答ストリーム: REQUEST_OK / REQUEST_ERROR / NAMESPACE / NAMESPACE_DONE
- `readRequestStreamMessages`: REQUEST_OK (REQUEST_UPDATE 応答) / REQUEST_ERROR
- `handleRequestOk` / `handleControlStreamRequestError` (PUBLISH_NAMESPACE 応答): REQUEST_OK / REQUEST_ERROR
- `handlePublishDone`: PUBLISH_DONE
- `handleGoaway`: GOAWAY (SessionMachine の peerGoaway 状態と goawayReceived イベントを更新)

送信経路にも配線した。

- `sendPublishDone`: `protocol.sendPublishDone` 呼び出しで SessionMachine の `SubscriptionEntry` を terminated に遷移させる
- `sendRequestUpdate`: `protocol.sendRequestUpdate` 呼び出し
- `goaway`: `protocol.sendGoaway` で `localGoawaySent` / `localGoawayPendingTimeoutMs` を更新

### 削減できた重複

- SUBSCRIBE_OK 受信時の `subscribersByAlias` による DUPLICATE_TRACK_ALIAS 検出を SessionMachine 側 (`handlePeerSubscribeOk` の `_peerPublisherAliases.has(trackAlias)`) に集約した

### 検証

- `vp run typecheck` / `vp run test` (35 files / 441 tests) / `vp run build` (155.56 kB / gzip 31.64 kB) がすべて緑

### 残課題 (別 issue で扱う)

- peer-initiated SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / REQUEST_UPDATE / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE のデコードと `processIncomingAuthTokens` / `validatePeerRequest` / `handleStreamMessage` への配線。現状 Session は outgoing request のみを持つため、peer-initiated request 対応は受信デコーダ実装とセットで行う必要がある
- `Session` の `pendingSubscribe` / `pendingPublish` / `pendingFetch` / `publishers` / `subscribers` / `fetchers` のうち、SessionMachine の `SubscriptionEntry` / `FetchEntry` / `NamespacePublicationEntry` から代替可能なものの更なる削減
- GOAWAY タイムアウトを既存の `setTimeout` ではなく `tick` 経由で一元化する (`setInterval` で tick を呼び、SessionMachine の `localGoawayDeadlineMs` 判定に寄せる)
