# DELIVERY_TIMEOUT を SUBGROUP_DELIVERY_TIMEOUT と OBJECT_DELIVERY_TIMEOUT に分割する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で DELIVERY_TIMEOUT が以下の 2 パラメータに分割された。

- SUBGROUP_DELIVERY_TIMEOUT (Parameter Type 0x06): Subgroup 単位のタイムアウト
- OBJECT_DELIVERY_TIMEOUT (Parameter Type 0x02): Object 単位のタイムアウト

パラメータ ID とエンコーディングが変わるため、後方互換性がない。

## RFC 参照

draft-ietf-moq-transport-18 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter):

> The SUBGROUP_DELIVERY_TIMEOUT parameter (Parameter Type 0x06) is a
> varint. It MAY appear in a PUBLISH_OK, SUBSCRIBE, or REQUEST_UPDATE
> message.

draft-ietf-moq-transport-18 §10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter):

> The OBJECT_DELIVERY_TIMEOUT parameter (Parameter Type 0x02) is a
> varint. It MAY appear in a PUBLISH_OK, SUBSCRIBE, or REQUEST_UPDATE
> message.

draft-ietf-moq-transport-18 A.1: (この分割は §8 から §10.2.3 / §10.2.4 への再編成に含まれる)

## 変更内容

1. `src/message/parameter.ts` のパラメータ定数から `DELIVERY_TIMEOUT` を削除し、`SUBGROUP_DELIVERY_TIMEOUT` (0x06) と `OBJECT_DELIVERY_TIMEOUT` (0x02) を追加する
2. `src/message/parameter.ts` のパラメータエンコード/デコードに両パラメータの処理を追加する (varint 値)
3. `src/session/params.ts` の `buildSubscribeParameters` / `buildPublishParameters` から `deliveryTimeout` を削除し、`subgroupDeliveryTimeout` / `objectDeliveryTimeout` を追加する
4. `src/session.ts` の `SubscribeOptions` / `PublishOptions` インターフェースの `deliveryTimeout` を削除し、`subgroupDeliveryTimeout` / `objectDeliveryTimeout` を追加する
5. `src/index.ts` の公開 API から `deliveryTimeout` を削除し、新パラメータを追加する

## 該当ファイル

| ファイル                   | 行番号  | 変更内容                                                                                                                      |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/message/parameter.ts` | (全般)  | `MessageParameterType.DELIVERY_TIMEOUT` を削除、`SUBGROUP_DELIVERY_TIMEOUT` (0x06) と `OBJECT_DELIVERY_TIMEOUT` (0x02) を追加 |
| `src/session/params.ts`    | (全般)  | `buildSubscribeParameters` / `buildPublishParameters` から `deliveryTimeout` を削除し分割する                                 |
| `src/session.ts`           | 221-226 | `PublishOptions.deliveryTimeout` を削除し `subgroupDeliveryTimeout` / `objectDeliveryTimeout` に置き換える                    |
| `src/session.ts`           | 365-372 | `SubscribeOptions.deliveryTimeout` を削除し `subgroupDeliveryTimeout` / `objectDeliveryTimeout` に置き換える                  |
| `src/index.ts`             | (全般)  | 公開 API を更新する                                                                                                           |

## 期待される動作

1. SUBSCRIBE / PUBLISH / REQUEST_UPDATE に SUBGROUP_DELIVERY_TIMEOUT (0x06) と OBJECT_DELIVERY_TIMEOUT (0x02) を varint 値として送受信できる
2. 従来の DELIVERY_TIMEOUT パラメータは送受信されない
3. Publisher は両方のタイムアウトを Track Property としても通知できる (§12.1, §12.2)
4. Subscriber は `Subscriber.trackProperties` 経由で両方の値を参照できる

## テスト方針

- `src/message/parameter.test.ts` に SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT のエンコード/デコードテストを追加する
- `src/message/parameter.prop.ts` のラウンドトリップ PBT に新パラメータを追加する
- `src/session.prop.ts` の `buildSubscribeParameters` PBT を更新する
- `src/subscriber.test.ts` の deliveryTimeout 参照を削除/更新する

## 影響範囲

- 実装変更あり
- 後方互換性なし (API の `deliveryTimeout` オプションが削除される)
- devtools の表示更新が必要
- `CHANGES.md` に [CHANGE] エントリを追加する
