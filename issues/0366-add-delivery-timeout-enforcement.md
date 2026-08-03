# Delivery Timeout の強制を実装する

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-delivery-timeout-enforcement
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §8 の MUST 要件（OBJECT_DELIVERY_TIMEOUT 超過時のストリームリセット / データグラム破棄、SUBGROUP_DELIVERY_TIMEOUT タイマー）を実装する。現在は値の抽出・伝搬のみで強制が一切ない。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects()` は subgroup 先頭オブジェクトの Object Property から delivery timeout 値を抽出し `MoqtObject.objectDeliveryTimeout` / `subgroupDeliveryTimeout` に保持するだけ。
- `src/session/publish.ts` の `publishSendObjectInternal()` は `mergeDeliveryTimeoutObjectProperties()` で Object Property として送信するだけ。
- タイマー・ストリームリセット・データグラム破棄の実装が存在しない。§8 の「If the OBJECT_DELIVERY_TIMEOUT is not zero ... it MUST reset the underlying transport stream with the reset stream code DELIVERY_TIMEOUT」「For datagrams, the implementation MUST drop the datagrams」「it MUST start a timer of SUBGROUP_DELIVERY_TIMEOUT duration once it becomes aware that all of the objects on the subgroup have been published」のいずれも未実装。
- 送信側の値と受信側（subscriber パラメータ）の値の小さい方を採用する計算（§8「If both the publisher's value and the subscriber's value are non-zero, the smaller of the two is used」）もない。
- `DataStreamErrorCode.DELIVERY_TIMEOUT`（0x2）は定義されているが使用箇所がない。

## 設計方針

- Publisher 側（`src/session/publish.ts` とその呼び出し元）に送信時のタイムアウト強制を実装する:
  - OBJECT_DELIVERY_TIMEOUT: オブジェクトの最初のペイロードバイト受信（またはアプリ提供）時からの経過時間を記録し、超過時は subgroup ストリームを `DELIVERY_TIMEOUT` でリセット、データグラムは破棄する。
  - SUBGROUP_DELIVERY_TIMEOUT: subgroup の全オブジェクト送信完了（FIN 相当）時からタイマーを開始し、未達ならストリームをリセットする。
  - publisher 値と subscriber 値（`SUBSCRIBE` の `OBJECT_DELIVERY_TIMEOUT` / `SUBGROUP_DELIVERY_TIMEOUT` パラメータ）の小さい方を採用する。
- Subscriber 側は受信値の保持（現状のまま）でよいか、受信側でもタイムアウトを適用するかを仕様の記述に照らして判断する。
- タイマー実装は WebTransport のストリーム API の制約（RESET_STREAM 相当の API 有無）を確認したうえで設計する。

## 完了条件

- OBJECT_DELIVERY_TIMEOUT 超過時に subgroup ストリームが `DELIVERY_TIMEOUT` コードでリセットされる。
- OBJECT_DELIVERY_TIMEOUT 超過時にデータグラムが破棄される。
- SUBGROUP_DELIVERY_TIMEOUT タイマーが発火し、未達の subgroup ストリームがリセットされる。
- publisher 値と subscriber 値の小さい方が採用される。
- 各タイムアウトの動作を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §8 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-19 §10.2.3 / §10.2.4 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-19 §12.1 / §12.2 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Property)

## 解決方法

未着手。
