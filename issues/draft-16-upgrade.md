# draft-ietf-moq-transport-16 対応

## 概要

moqt-js を draft-ietf-moq-transport-15 から draft-ietf-moq-transport-16 にアップグレードする。

- 仕様: https://github.com/moq-wg/moq-transport

## 変更点一覧

### 優先度: 高 (ワイヤフォーマット変更)

- [x] パラメータのデルタエンコーディング対応
  - https://github.com/moq-wg/moq-transport/pull/1315
  - 影響: `parameter.ts`, 全メッセージの encode/decode
  - 他の全変更の基盤となるため最初に対応が必要

- [x] REQUEST_ERROR に Retry Interval 追加
  - https://github.com/moq-wg/moq-transport/pull/1339
  - 影響: `session.ts`, `error.ts`

- [x] SUBSCRIBE_UPDATE を REQUEST_UPDATE に変更
  - https://github.com/moq-wg/moq-transport/pull/1332
  - 影響: `types.ts`, `subscribe.ts`, `session.ts`
  - 更新対象を拡張 (SUBSCRIBE 以外も更新可能に)

- [x] PUBLISH_NAMESPACE_DONE/CANCEL に Request ID 追加
  - https://github.com/moq-wg/moq-transport/pull/1329
  - 影響: `namespace.ts`

- [x] PUBLISH, SUBSCRIBE_OK, FETCH_OK に Extension Headers 追加
  - https://github.com/moq-wg/moq-transport/pull/1374
  - 影響: `publish.ts`, `subscribe.ts`, `fetch.ts`

- [x] Object Status の処理方法変更
  - https://github.com/moq-wg/moq-transport/pull/1342
  - 影響: `types.ts`, `dataStream.ts`
  - 欠落オブジェクトの扱いを変更

### 優先度: 中 (機能変更)

- [ ] SUBSCRIBE_NAMESPACE の完全実装
  - https://github.com/moq-wg/moq-transport/pull/1344
  - 影響: `session.ts`
  - 状態: **機能未完成**（API は存在するが動作しない）
    - `subscribeNamespace()` メソッド: 定義済み
    - SUBSCRIBE_NAMESPACE 送信: 実装済み
    - REQUEST_OK 受信: 実装済み
    - NAMESPACE 受信: **未実装**
    - NAMESPACE_DONE 受信: **未実装**
    - 使用箇所: なし（devtools、examples で未使用）
  - draft-16 対応: コントロールストリームから専用ストリームへ移動

- [x] 同一トラックで Datagram と Stream の混在許可
  - https://github.com/moq-wg/moq-transport/pull/1350
  - 影響: `dataStream.ts`, `session.ts`

- [x] トラックプロパティを拡張に移動
  - https://github.com/moq-wg/moq-transport/pull/1390
  - 影響: `types.ts`, `parameter.ts`, `extensions.ts`
  - パラメータのスコープを明確化

- [x] TRACK_STATUS から配信関連パラメータ削除
  - https://github.com/moq-wg/moq-transport/pull/1325
  - 影響: `trackstatus.ts`
  - Subscriber 向けの簡素化

- [x] TRACK_STATUS に LARGEST_OBJECT パラメータ追加
  - https://github.com/moq-wg/moq-transport/pull/1367
  - 影響: `trackstatus.ts`

- [x] SUBSCRIBE_NAMESPACE で空/ワイルドカード namespace 許可
  - https://github.com/moq-wg/moq-transport/pull/1393
  - 影響: `namespace.ts`, `session.ts`

- [x] FETCH レスポンスで不明な範囲を許可
  - https://github.com/moq-wg/moq-transport/pull/1331
  - 影響: `fetch.ts`, `fetcher.ts`

- [x] DELIVERY_TIMEOUT=0 を禁止
  - https://github.com/moq-wg/moq-transport/pull/1330
  - 影響: `parameter.ts`, `session.ts`

- [x] SUBSCRIBE_UPDATE で Start Location 減少許可
  - https://github.com/moq-wg/moq-transport/pull/1323
  - 影響: `subscribe.ts`, `session.ts`

### 優先度: 低 (動作明確化・マイナー変更)

- [x] NAMESPACE_DONE 前に NAMESPACE を要求
  - https://github.com/moq-wg/moq-transport/pull/1392
  - 影響: `session.ts`
  - 状態: API 設計で既に強制されている（done() は publishNamespace() からのみ呼び出せる）

- [x] PUBLISH は PUBLISH_NAMESPACE を暗示しない
  - https://github.com/moq-wg/moq-transport/pull/1364
  - 影響: `session.ts`
  - 状態: publish() と publishNamespace() は既に独立した操作

- [x] Datagram と Subgroup の明確化
  - https://github.com/moq-wg/moq-transport/pull/1382
  - 影響: `dataStream.ts`
  - 状態: ドキュメント変更のみ、混在は既にサポート

- [x] 未知の拡張の処理明確化
  - https://github.com/moq-wg/moq-transport/pull/1395
  - 影響: `extensions.ts`
  - 状態: リレー向けの変更、クライアントには影響なし

- [ ] Subgroup 再オープン禁止
  - https://github.com/moq-wg/moq-transport/pull/1396
  - 影響: `session.ts`
  - delivery timeout または STOP_SENDING 後
  - TODO: 閉じた Subgroup の追跡・再利用禁止の実装

- [x] 同一 Subgroup の複数 Priority 検出
  - https://github.com/moq-wg/moq-transport/pull/1317
  - 影響: `dataStream.ts`
  - FETCH オブジェクトの同一 Subgroup 内で異なる Priority を検出した場合に MALFORMED_TRACK エラー

- [x] Datagram の Delivery Timeout 明確化
  - https://github.com/moq-wg/moq-transport/pull/1406
  - 影響: `dataStream.ts`
  - 状態: ドキュメント変更のみ、タイムアウトはサーバー側で処理

- [x] GOAWAY 送信後のリクエスト送信明確化
  - https://github.com/moq-wg/moq-transport/pull/1398
  - 影響: `session.ts`
  - 状態: receivedGoaway チェックで既に実装済み

- [x] 重複サブスクリプション処理
  - https://github.com/moq-wg/moq-transport/pull/1341
  - 影響: `error.ts`
  - DUPLICATE_SUBSCRIPTION (0x31) を RequestErrorCode に追加

- [x] Track Name/Namespace エッジケース対応
  - https://github.com/moq-wg/moq-transport/pull/1399
  - 影響: `parameter.ts`, `session.ts`

### Editorial (コード変更最小限)

- [x] Version Specific Parameters を Message Parameters にリネーム
  - https://github.com/moq-wg/moq-transport/pull/1411
  - 影響: `types.ts`

- [ ] Relays match SUBSCRIBE to both Tracks and Namespaces
  - https://github.com/moq-wg/moq-transport/pull/1397
  - クライアントライブラリでは直接影響なし

- [ ] Subscribers can migrate networks too
  - https://github.com/moq-wg/moq-transport/pull/1410

- [ ] Clarify valid joining fetch subscription states
  - https://github.com/moq-wg/moq-transport/pull/1363

- [ ] Formatting names for logs
  - https://github.com/moq-wg/moq-transport/pull/1355

- [ ] A Publisher might not use the congestion window
  - https://github.com/moq-wg/moq-transport/pull/1408

## 実装順序

1. パラメータのデルタエンコーディング (基盤)
2. メッセージフォーマット変更 (REQUEST_ERROR, PUBLISH_NAMESPACE, Extension Headers, Object Status)
3. コントロールプレーン変更 (REQUEST_UPDATE, SUBSCRIBE_NAMESPACE, TRACK_STATUS)
4. データプレーン変更 (Datagram/Stream 混在, FETCH, DELIVERY_TIMEOUT)
5. その他の変更
6. Editorial

## 詳細: SUBSCRIBE_NAMESPACE の完全実装

### 概要

SUBSCRIBE_NAMESPACE は現在 **機能未完成** の状態。API は存在するが、実際にはトラック発見が動作しない。

- PR: https://github.com/moq-wg/moq-transport/pull/1344
- 仕様: draft-ietf-moq-transport-16 Section 6.1, 9.25

### 現在の実装状況

| 項目                            | 状態                                   |
| ------------------------------- | -------------------------------------- |
| `subscribeNamespace()` メソッド | API として定義済み                     |
| SUBSCRIBE_NAMESPACE 送信        | 実装済み（コントロールストリーム経由） |
| REQUEST_OK/REQUEST_ERROR 受信   | 実装済み                               |
| **NAMESPACE 受信**              | **未実装**                             |
| **NAMESPACE_DONE 受信**         | **未実装**                             |
| 使用箇所                        | なし（devtools、examples で未使用）    |

`session.ts` のコントロールメッセージ処理で NAMESPACE メッセージの case が存在しない:

```typescript
// session.ts の handleControlMessage() で処理されているメッセージ:
// - SUBSCRIBE_OK, PUBLISH_OK, PUBLISH_DONE
// - REQUEST_ERROR, REQUEST_OK
// - GOAWAY, MAX_REQUEST_ID, REQUESTS_BLOCKED
// - FETCH_OK
// - PUBLISH_NAMESPACE, PUBLISH_NAMESPACE_CANCEL
//
// NAMESPACE, NAMESPACE_DONE は処理されていない
```

### draft-16 での変更

draft-16 では SUBSCRIBE_NAMESPACE の送受信方法が変更された:

| 項目           | draft-15                         | draft-16                              |
| -------------- | -------------------------------- | ------------------------------------- |
| 送信先         | コントロールストリーム           | 専用の双方向ストリーム                |
| レスポンス     | コントロールストリーム           | 同じ双方向ストリームのレスポンス側    |
| NAMESPACE 受信 | コントロールストリーム           | 同じ双方向ストリーム                  |
| キャンセル     | UNSUBSCRIBE_NAMESPACE メッセージ | ストリームを閉じる (FIN/RESET_STREAM) |

### 仕様からの引用

> The subscriber sends SUBSCRIBE_NAMESPACE on a new bidirectional stream and the publisher MUST send a single REQUEST_OK or REQUEST_ERROR as the first message on the bidirectional stream in response to a SUBSCRIBE_NAMESPACE.

> A SUBSCRIBE_NAMESPACE can be cancelled by closing the stream with either a FIN or RESET_STREAM.

### 実装タスク

#### Phase 1: 基本機能の完成（draft-15 互換）

1. **NAMESPACE 受信処理の実装**
   - `handleControlMessage()` に NAMESPACE の case を追加
   - `NamespaceSubscriptionCallbacks.onNamespace()` を呼び出す

2. **NAMESPACE_DONE 受信処理の実装**
   - `handleControlMessage()` に NAMESPACE_DONE の case を追加
   - `NamespaceSubscriptionCallbacks.onNamespaceDone()` を呼び出す

#### Phase 2: draft-16 対応

1. **subscribeNamespace() の変更**
   - `transport.createBidirectionalStream()` で新しい双方向ストリームを開く
   - そのストリームで SUBSCRIBE_NAMESPACE メッセージを送信
   - ストリームのレスポンス側で REQUEST_OK/REQUEST_ERROR を受信

2. **専用ストリームでの NAMESPACE/NAMESPACE_DONE 受信**
   - コントロールストリームではなく専用ストリームで受信
   - ストリームごとの受信ループを実装

3. **キャンセル処理の変更**
   - UNSUBSCRIBE_NAMESPACE メッセージの送信を削除
   - ストリームを閉じることでキャンセルを通知

4. **ストリーム管理**
   - 各 SUBSCRIBE_NAMESPACE に対応するストリームを追跡
   - ストリームが閉じられた場合のクリーンアップ処理

### アーキテクチャ上の課題

1. **双方向ストリームの受信ループ**
   - 現在、双方向ストリームはコントロールストリームのみを想定
   - SUBSCRIBE_NAMESPACE 用のストリーム受信ループを追加する必要がある

2. **メッセージルーティング**
   - ストリームの最初のメッセージでルーティングを決定
   - CLIENT_SETUP で始まるストリーム → コントロールストリーム
   - SUBSCRIBE_NAMESPACE で始まるストリーム → Namespace ストリーム

3. **サーバー側の考慮**
   - moqt-js はクライアント専用だが、リレーサーバーとして動作する場合は
     SUBSCRIBE_NAMESPACE を受信する側の実装も必要

### 影響範囲

- `session.ts`: subscribeNamespace() メソッド、ストリーム管理、NAMESPACE 受信処理
- `message/namespace.ts`: NAMESPACE/NAMESPACE_DONE のエンコード/デコード（既存）

## 参考

- refs/moq/draft-ietf-moq-transport-15.txt (現在の実装)
- refs/moq/draft-ietf-moq-transport-16.txt (draft-16 仕様)
