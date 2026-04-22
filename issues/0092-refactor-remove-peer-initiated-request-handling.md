# peer-initiated request 受信機構を削除

Created: 2026-04-22
Model: Claude Opus 4.7

## 概要

peer (= server / relay) が新規 bidi stream で開始する request 系メッセージ
(SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE)
の受信・応答機構を全て削除する。

`Session.acceptPeer*` / `rejectPeerRequest` 公開 API、`ConnectCallbacks.peer*` コールバック、
`SessionMachine.handlePeer*` / `acceptPeer*` 内部 API、
peer-request 用 responder encoder (`encodeSubscribeOkPayload` / `encodePublishOkPayload` / `encodeFetchOkPayload`
/ `encodeRequestOkPayload` / `encodeRequestErrorPayload`) を削除する。

## 背景

AGENTS.md の moqt-js 方針:

> - クライアントとしてのみ動作
> - MOQT Publisher/Subscriber としてのみ動作

draft-ietf-moq-transport-17 における Publisher / Subscriber は仕様上 peer から開始される request を受ける役割も担うが、
moqt-js は以下のサブセットに限定する:

- Publisher: `session.publish()` で PUBLISH を送信する push 型のみ
- Subscriber: `session.subscribe()` で SUBSCRIBE を送信する pull 型のみ

このサブセットでは peer から request が開かれることは無い。
仕様上 relay が forward する SUBSCRIBE / PUBLISH を受ける必要があるのは、
`PUBLISH_NAMESPACE` で announce する pull 型 publisher、
`SUBSCRIBE_NAMESPACE` で discover する push 型 subscriber に限定されるが、
これらのパターンは別 issue (0093) で削除する。

### 現状の使用状況

- 高レベル API (`createMediaPublisher` / `createMediaSubscriber`) は `peer*` を一切使っていない
- devtools も使っていない
- 内部 (`session.ts` / `machine.ts` / `peerRequest.prop.ts`) のみで使われている dead 機能

## 設計判断

予期せぬ peer-initiated request を受信した場合の扱い:

- **採用**: PROTOCOL_VIOLATION でセッション切断
- **不採用**: draft §9.11 L3683 の `UNINTERESTED` reject (実装コストが嵩み、まともな relay では発生しない)

## 作業内容

### 公開 API 削除

1. `src/session/session.ts`:
   - `ConnectCallbacks` から以下のコールバックを削除:
     - `peerSubscribe` / `peerPublish` / `peerFetch` / `peerTrackStatus` / `peerSubscribeNamespace` / `peerPublishNamespace`
   - 以下の型定義を削除:
     - `PeerSubscribeRequest` / `PeerPublishRequest` / `PeerFetchRequest`
     - `PeerTrackStatusRequest` / `PeerSubscribeNamespaceRequest` / `PeerPublishNamespaceRequest`
   - 以下の API メソッドを削除:
     - `acceptPeerSubscribe` / `acceptPeerPublish` / `acceptPeerFetch`
     - `acceptPeerTrackStatus` / `acceptPeerSubscribeNamespace` / `acceptPeerPublishNamespace`
     - `rejectPeerRequest`
   - 内部実装の削除:
     - `peerInitiatedStreams` / `nextTrackAlias` フィールド
     - `writeOnPeerInitiatedStream` / `sendRequestOkOnPeerInitiatedStream` プライベートメソッド
     - `handleIncomingBidirectionalStream` の peer-request 受信デコード分岐
       (予期せぬ peer-initiated bidi stream 受信は PROTOCOL_VIOLATION で切断)

### SessionMachine 側削除

2. `src/session/machine.ts`:
   - `handlePeerSubscribe` / `handlePeerPublish` / `handlePeerFetch`
   - `handlePeerTrackStatus` / `handlePeerSubscribeNamespace` / `handlePeerPublishNamespace`
   - `acceptPeerSubscribe` / `acceptPeerPublish` / `acceptPeerFetch`
   - `acceptPeerTrackStatus` / `acceptPeerSubscribeNamespace` / `acceptPeerPublishNamespace`
   - `rejectPeerRequest`
   - `validatePeerRequest`
   - peer 側状態管理 (peer subscription map / peer track alias 等)
   - `handleStreamMessage` 等から peer-request 関連分岐を削除

3. `src/session/types.ts`:
   - peer-request 関連のイベント型 / 入力型削除

### responder encoder 削除

4. `src/message/session.ts`:
   - `encodeSubscribeOkPayload` (peer SUBSCRIBE への返答用)
   - `encodePublishOkPayload` (peer PUBLISH への返答用)
   - `encodeFetchOkPayload` (peer FETCH への返答用)
   - `encodeRequestOkPayload` (peer TRACK_STATUS / *_NAMESPACE への返答用)
   - `encodeRequestErrorPayload` (peer-request 拒否用)
   - 自側 request の応答受信用 decoder (`decodeSubscribeOkPayload` 等) は残す
     (自分が送った SUBSCRIBE / PUBLISH / FETCH への応答受信に必要)

### テスト削除

5. `src/session/peerRequest.prop.ts` 全削除 (787 行)
6. `src/session/goaway.prop.ts` 等で peer-request を絡めたケースは整理
7. `src/message/session.test.ts` 等で responder encoder のテストを削除

### index.ts re-export 整理

8. `src/index.ts` から peer-request 関連型の re-export 削除

## 検証

- `vp run typecheck` / `vp run test` / `vp run build` を全て通すこと
- `createMediaPublisher` / `createMediaSubscriber` の挙動が変わらないこと
- devtools のビルドが通ること

## 規模

削除行数の目安: 1500 - 2000 行

## 依存

- 0093 とセットで実施することで namespace API 半壊状態を回避する
- 0093 を後続で実施する前提
