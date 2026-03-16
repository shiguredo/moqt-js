# SUBSCRIBE に RENDEZVOUS_TIMEOUT パラメータ追加

## 概要

SUBSCRIBE メッセージに RENDEZVOUS_TIMEOUT パラメータを追加する。

## 参照

- draft-ietf-moq-transport-17 Section 9.8.1
- https://github.com/moq-wg/moq-transport/pull/1447

## 変更内容

- draft-17 で新規追加されたパラメータ
- RENDEZVOUS_TIMEOUT パラメータ (Parameter Type 0x04) は SUBSCRIBE メッセージに含められる
- リレーが Publisher を待つ時間をミリ秒単位で指定する
- RENDEZVOUS_TIMEOUT が存在する場合、リレーは指定時間だけ Publisher の到着を待つ
- 不在の場合、デフォルト値は 0 (待たない)

## 影響範囲

- `src/message/parameter.ts`
- `src/message/subscribe.ts`
- `src/subscriber.ts`

## 実装方針

1. draft-17 Section 9.8.1 の RENDEZVOUS_TIMEOUT 仕様を確認する
2. `src/message/parameter.ts` に RENDEZVOUS_TIMEOUT パラメータタイプを追加する
3. SUBSCRIBE メッセージのエンコード・デコードで RENDEZVOUS_TIMEOUT を処理する
4. テストを追加する

## 解決方法

- `MessageParameterType` に `RENDEZVOUS_TIMEOUT: 0x04` を追加
- `SubscribeOptions` に `rendezvousTimeout?: bigint` を追加
- `session.ts` の subscribe メソッドで RENDEZVOUS_TIMEOUT パラメータを送信するロジックを追加
