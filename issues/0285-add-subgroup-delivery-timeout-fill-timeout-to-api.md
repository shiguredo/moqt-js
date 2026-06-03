# SUBGROUP_DELIVERY_TIMEOUT と FILL_TIMEOUT を PublishOptions/FetchOptions に追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

SUBGROUP_DELIVERY_TIMEOUT (0x06) と FILL_TIMEOUT (0x0a) が `MessageParameterType` 定数としては定義されているが、`PublishOptions` / `SubscribeOptions` / `FetchOptions` のインターフェースには含まれておらず、実際の API から利用できない。

## 優先度根拠

draft-18 で導入された主要なパラメータが API から利用できない。`DELIVERY_TIMEOUT` の分割対応が不完全。

## 現状

- `src/message/types.ts`: `MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT = 0x06`, `FILL_TIMEOUT = 0x0a` は定義済み
- `src/session.ts:1255-1262` (`buildPublishParameters`): OBJECT_DELIVERY_TIMEOUT のみ対応
- `src/session.ts:1335-1358` (`buildSubscribeParameters`): OBJECT_DELIVERY_TIMEOUT のみ対応
- `src/session.ts:1437-1452` (`buildFetchParameters`): FILL_TIMEOUT 未対応

draft-ietf-moq-transport-18:
- §10.2.3: SUBGROUP_DELIVERY_TIMEOUT は PUBLISH と SUBSCRIBE で送信可能
- §10.2.5: FILL_TIMEOUT は FETCH で使用

## 設計方針

- `PublishOptions` に `subgroupDeliveryTimeout?: number` を追加し `buildPublishParameters` でエンコードする
- `SubscribeOptions` に `subgroupDeliveryTimeout?: number` を追加し `buildSubscribeParameters` でエンコードする
- `FetchOptions` に `fillTimeout?: number` を追加し `buildFetchParameters` でエンコードする

## 完了条件

- SUBGROUP_DELIVERY_TIMEOUT が publish/subscribe API から設定可能
- FILL_TIMEOUT が fetch API から設定可能
- テストが追加されている
