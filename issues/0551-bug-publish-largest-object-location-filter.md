# 受信 PUBLISH の LARGEST_OBJECT を抽出して相対 Location Filter を解決する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/fix-publish-largest-object-location-filter
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.2.17 は LARGEST_OBJECT が PUBLISH に出現し得ると定める。現状は受信 PUBLISH の LOCATION_FILTER を反映する際に LARGEST_OBJECT を抽出しないため、相対 Location Filter が `{0, 0}` のまま固定される。データ欠落は起きないが、fill を併用したときに subscription と fill の範囲が重なり、同一 Object が重複配信され得る。

## 現状

- `src/session.ts` の `applyIncomingPublishParameters` は LOCATION_FILTER と FORWARD のみを反映し、LARGEST_OBJECT を抽出しない。
- 相対 Location Filter は LARGEST_OBJECT 未受信のとき `resolveFilter` で `{0, 0}` に解決される。
- `src/subscriber.ts` の `resolveLocationFilter` は「LARGEST_OBJECT の更新だけでは再解決しない」契約であり、受信 PUBLISH で largest を設定しても自動では再解決されない。
- §5.1.3 は「When the fill range overlaps the subscription's Location filter, an object can be both fill-delivered and subscription-delivered.」と定める。

## 設計方針

1. 受信 PUBLISH の LARGEST_OBJECT を抽出し、SubscriberImpl に設定してから Location Filter を解決する。
2. 既存の `resolveLocationFilter` の契約（LARGEST_OBJECT 更新だけでは再解決しない）と整合させ、フィルタ適用時に一度だけ解決する。
3. 受信 PUBLISH の相対 Location Filter が LARGEST_OBJECT 基準で解決されることを検証するテストを追加する。

## 完了条件

- 受信 PUBLISH の相対 Location Filter が LARGEST_OBJECT 基準で解決されること。
- データ欠落を起こさないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.2 / §5.1.3 / §10.2.17
- `applyIncomingPublishParameters` / `setLocationFilter` / `setLargestLocation` / `resolveLocationFilter`
