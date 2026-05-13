# PUBLISH/REQUEST_UPDATE の forward=1 で Joining FETCH 許可

## 概要

PUBLISH および REQUEST_UPDATE で forward=1 を指定した場合に Joining FETCH を許可する。

## 参照

- draft-ietf-moq-transport-17 Section 6.4
- https://github.com/moq-wg/moq-transport/pull/1335

## 変更内容

- draft-17 では PUBLISH および REQUEST_UPDATE で forward=1 (転送許可) を指定した場合、Joining FETCH が許可される
- Joining FETCH は、SUBSCRIBE で受信を開始する前のデータを FETCH で取得する機能
- forward=1 のときのみ、Subscriber は Joining FETCH を発行できる

## 影響範囲

- `src/session.ts`
- `src/fetcher.ts`
- `src/subscriber.ts`
- `src/publisher.ts`

## 実装方針

1. draft-17 Section 6.4 の Joining FETCH 仕様を確認する
2. PUBLISH/REQUEST_UPDATE の forward フィールド処理を追加する
3. forward=1 のときに Joining FETCH を発行できるロジックを実装する
4. テストを追加する

## 解決方法

SUBSCRIBE の `forward` パラメータ送信と Joining FETCH の発行は既に実装済み。PUBLISH/PUBLISH_OK の `forward` パラメータ処理も既存。forward=1 のときのみ Joining FETCH を許可するチェックはリレーサーバー側の責務。コード変更不要。
