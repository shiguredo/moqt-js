# REQUEST_UPDATE 経由の LOCATION_FILTER が Subscriber のフィルタ状態に反映されない

- Created: 2026-08-22
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-location-filter
- Polished: {YYYY-MM-DD}

## 目的

`SubscriberImpl` の `update()` で REQUEST_UPDATE の LOCATION_FILTER (0x21) パラメータを送信し、ピアが REQUEST_OK で受理した場合でも、Subscriber 側の Location Filter の再適用状態（`locationFilter` / `resolvedFilterCache`）が古いままになる。FORWARD と Range Filters は REQUEST_OK 受信時に反映されるのに、LOCATION_FILTER だけ反映されない非対称を解消する。

## 現状

- `RequestUpdateOptions.parameters`（`src/subscriber.ts`）の JSDoc は「LOCATION_FILTER, SUBSCRIBER_PRIORITY など」と宣言し、`sendRequestUpdate`（`src/session/bidi.ts`）は `options.parameters` をそのまま REQUEST_UPDATE のパラメータ列に載せて送信する。
- REQUEST_OK 受信処理（`bidiHandleRequestUpdateOk`、`src/session/bidi.ts`）は LARGEST_OBJECT・`pendingRequestUpdate` の `forward` / `rangeFilters` のみ反映し、LOCATION_FILTER を `SubscriberImpl.setLocationFilter()` へ反映する経路が無い。
- `PendingRequestUpdate`（`src/session/bidi.ts`）にも送信時の LOCATION_FILTER 値を保持するフィールドが無い（`forward` / `rangeFilters` のみ保持）。
- そのため、ピアが REQUEST_OK で受理した後も `handleObject` / `handleDatagram` の Location Filter 再適用（§5.1.2）が旧 Start Location で動作し続ける。フィルタを変更したつもりでも配信結果が変わらない。
- 注: 受信側（role = publish）が文脈限定パラメータ（LOCATION_FILTER を含む）の REQUEST_UPDATE を NOT_SUPPORTED で応答する既存挙動は本 issue では触らない。本 issue は送信側（subscriber role）の反映漏れのみを対象とする。

## 設計方針

- `PendingRequestUpdate` に送信時の LOCATION_FILTER 値（型 `LocationFilter`、省略時 undefined）を保持し、`bidiHandleRequestUpdateOk` の REQUEST_OK 受信時に `subscriber.setLocationFilter()` で反映する。
- 反映は `forward` / `rangeFilters` と同じタイミング・同じセマンティクスにする。省略時 (undefined) はフィルタを変更しない（「If a parameter is omitted from REQUEST_UPDATE, the value for the subscription remains unchanged.」の精神に従う）。
- 送信時の LOCATION_FILTER は `options.parameters` 内の `MessageParameterType.LOCATION_FILTER` パラメータから抽出する。

## 完了条件

- REQUEST_OK 受信時に、送信時の LOCATION_FILTER が `SubscriberImpl.locationFilter` と `resolvedFilterCache` に反映されること（結合テストで検証する）。
- 反映後の `handleObject` / `handleDatagram` が新しい Start Location で再適用されること。
- LOCATION_FILTER を送らなかった `update()` ではフィルタが不変であること。
- REQUEST_ERROR / セッション終了時には反映されないこと。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.9 (SUBSCRIPTION FILTER Parameter)
- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

未着手。
