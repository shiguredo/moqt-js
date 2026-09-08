# 相対 Location Filter を LARGEST_OBJECT 更新で再解決しない

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-relative-location-filter-reresolve
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §5.1.2 の Location Filter は購読開始位置を購読確立時に確定させる。LARGEST_OBJECT の更新で開始位置が前進すると、publisher が正当に送った Object を subscriber 側の再適用で破棄してしまう。

## 現状

- `src/subscriber.ts` の `SubscriberImpl.setLargestLocation` が `subscriberLargestLocation` を更新したうえで `resolveFilter(this.locationFilter, this.subscriberLargestLocation)` を再実行し、`resolvedFilterCache` を上書きする。
- `setLargestLocation` は SUBSCRIBE_OK だけでなく、`bidiHandleRequestUpdateOk` と `bidiHandlePublishStateNotify`（`src/session/bidi.ts`）からも呼ばれる。
- `src/filter.ts` の `resolveFilter` は 1 フィールド相対フィルタ（`{ startGroup }`）と Next Object フィルタ（`{ startGroup: 0, startObject: 0 }`）で `largestLocation` を基準に `start` を計算する。
- その結果、`handleObject` / `handleDatagram` の `objectMatchesFilter` が、確定済みの開始位置以降の Object を「フィルタ外」として捨てる。高レベル API `createMediaSubscriber` が使う Next Object フィルタでも発生し得る。

## 設計方針

1. `setLargestLocation` は `subscriberLargestLocation` の更新のみを行い、`resolvedFilterCache` を再計算しない。
2. `resolvedFilterCache` の再計算は、フィルタ状態が変わったとき（`setLocationFilter`、および REQUEST_UPDATE_OK でフィルタを反映する経路）だけ行う。
3. 購読確立時に LARGEST_OBJECT を受けてからフィルタを解決する順序を保証する（SUBSCRIBE_OK 処理で LARGEST_OBJECT 設定後にフィルタを解決する）。
4. 相対フィルタで LARGEST_OBJECT が進んでも破棄されないことを検証するテストを追加する。

## 完了条件

- `setLargestLocation` の呼び出しで `resolvedFilterCache` の開始位置が変わらないこと。
- 相対 Location Filter / Next Object フィルタの購読で、LARGEST_OBJECT 更新後も受信 Object が配信されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.2 / §5.1 / §10.2.17
- `SubscriberImpl.setLargestLocation` / `SubscriberImpl.setLocationFilter`
- `resolveFilter` / `objectMatchesFilter`
- `bidiHandleRequestUpdateOk` / `bidiHandlePublishStateNotify`
