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

- [ ] SUBSCRIBE_NAMESPACE をストリームに配置
  - https://github.com/moq-wg/moq-transport/pull/1344
  - 影響: `session.ts`
  - コントロールストリームから専用ストリームへ移動
  - 状態: TODO コメント追加済み（大規模なアーキテクチャ変更が必要）

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

## 参考

- refs/moq/draft-ietf-moq-transport-15.txt (現在の実装)
- draft-16 の RFC ドキュメントを refs/moq/ に追加する必要あり
