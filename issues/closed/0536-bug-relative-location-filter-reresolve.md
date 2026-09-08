# 相対 Location Filter を LARGEST_OBJECT 更新で再解決しない

- Created: 2026-09-08
- Completed: 2026-09-08
- Branch: feature/fix-relative-location-filter-reresolve
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §5.1.2 の Location Filter は購読開始位置を購読確立時に確定させる。LARGEST_OBJECT の更新で開始位置が前進すると、publisher が正当に送った Object を subscriber 側の再適用で破棄してしまう。

## 現状

- `src/subscriber.ts` の `SubscriberImpl.setLargestLocation` が `subscriberLargestLocation` を更新したうえで `resolveFilter(this.locationFilter, this.subscriberLargestLocation)` を再実行し、`resolvedFilterCache` を上書きする。
- `setLargestLocation` は SUBSCRIBE_OK（`src/session/bidi.ts`）だけでなく、`bidiHandleRequestUpdateOk` と `bidiHandlePublishStateNotify` からも呼ばれる。
- `src/filter.ts` の `resolveFilter` は 1 フィールド相対フィルタ（`{ startGroup }`）と Next Object フィルタ（`{ startGroup: 0, startObject: 0 }`）で `largestLocation` を基準に `start` を計算する。
- その結果、`handleObject` / `handleDatagram` の `objectMatchesFilter` が、確定済みの開始位置以降の Object を「フィルタ外」として捨てる。高レベル API `createMediaSubscriber` が使う Next Object フィルタでも発生し得る。
- 再現例: Next Object フィルタ（`{ startGroup: 0n, startObject: 0n }`）で SUBSCRIBE_OK の LARGEST_OBJECT が `{7, 2}` のとき、開始位置は `{7, 3}` に確定する。その後 PUBLISH_STATE_NOTIFY で LARGEST_OBJECT が `{9, 0}` に進むと、旧挙動は開始位置を `{9, 1}` に前進させ、`{7, 3}` から `{9, 0}` の Object を破棄する。1 フィールド相対フィルタ（`{ startGroup: 0n }` = Next Group）では開始位置が `{8, 0}` から `{10, 0}` に前進する。
- この再解決は複数同時サブスクリプション対応で導入された。closed の `issues/closed/0365-bug-location-filter-resolution.md` は `resolveFilter` の解決値修正と、現挙動を前提とするテストを追加した issue であり、本 issue はそのテストの期待を仕様に基づいて反転させる。

## 設計方針

1. `setLargestLocation` は `subscriberLargestLocation` の更新のみを行い、`resolvedFilterCache` を再計算しない。
2. `resolvedFilterCache` の再計算は、フィルタ状態が変わったとき（`setLocationFilter`、および REQUEST_UPDATE_OK でフィルタを反映する経路）と、購読開始時に LARGEST_OBJECT が初めて判明したとき（設計方針 3）に行う。
3. 購読開始時は SUBSCRIBE 送信時に `setLocationFilter` が largest 未受信で解決するため、SUBSCRIBE_OK で LARGEST_OBJECT を設定した直後に一度だけ再解決する必要がある。`SubscriberImpl` に保持済みの `locationFilter` と最新の `subscriberLargestLocation` で再解決するメソッド（例 `resolveLocationFilter()`）を追加し、SUBSCRIBE_OK ハンドラから呼ぶ。`locationFilter` は private のため、このメソッド経由で再解決する。`setLargestLocation` からは呼ばない。
4. 上記 3 経路のうち SUBSCRIBE_OK 以外（REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY）では再解決しない。REQUEST_UPDATE_OK でフィルタが変わる場合は `setLocationFilter` が再解決する。
5. `src/subscriber.test.ts` の現挙動を固定している 3 件（「setLargestLocation 後に LARGEST_OBJECT と同一 Location は配信しない」「startGroup=0 は LARGEST_OBJECT の次のグループから配信する」「handleFillObject: 同一 Location の fill 経由と subscription 経由を区別して受け取れる」）を新フローに合わせて修正する。`src/session.test.ts` の該当ケースはアサーションが購読側フィルタを固定しておらずコメントのみのため、コメントを新挙動に合わせて更新する。相対フィルタで LARGEST_OBJECT が進んでも破棄されないことを検証するテストを追加する。

## 完了条件

- `setLargestLocation` の呼び出しで `resolvedFilterCache` の開始位置が変わらないこと。
- SUBSCRIBE_OK 受信後に相対フィルタの開始位置が LARGEST_OBJECT 基準で一度だけ確定すること。
- 相対 Location Filter / Next Object フィルタの購読で、LARGEST_OBJECT 更新後も受信 Object が配信されること（再現例の `{7, 3}` 以降が配信される）。
- 上記の既存テスト（`src/subscriber.test.ts` / `src/session.test.ts`）を新フローに合わせて更新すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.2 / §5.1 / §10.2.17
- `SubscriberImpl.setLargestLocation` / `SubscriberImpl.setLocationFilter`
- `resolveFilter` / `objectMatchesFilter`
- `bidiHandleRequestUpdateOk` / `bidiHandlePublishStateNotify`（`src/session/bidi.ts`）
- `src/subscriber.test.ts` / `src/session.test.ts`
- `issues/closed/0365-bug-location-filter-resolution.md`（反転対象の先行テスト）

## 解決方法

- `src/subscriber.ts` の `setLargestLocation` から `resolvedFilterCache` の再計算を削除し、LARGEST_OBJECT の更新のみを行うようにした。
- 保持済みの `locationFilter` と最新の `subscriberLargestLocation` で再解決する `resolveLocationFilter()` を追加した。
- `src/session/bidi.ts` の SUBSCRIBE_OK で `setLargestLocation` の直後に `resolveLocationFilter()` を一度だけ呼ぶようにした。REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY の LARGEST_OBJECT 更新だけでは再解決しない (新規 LOCATION_FILTER は `setLocationFilter` がその時点の LARGEST_OBJECT で解決する)。
- `src/subscriber.test.ts` の現挙動を固定していたテストを新フローに更新し、setLargestLocation 単体では開始位置が前進しないこと、LARGEST_OBJECT 更新後も Object が配信されることを検証するテストを追加した。
- `src/session/bidi.test.ts` に SUBSCRIBE_OK / REQUEST_UPDATE_OK 経由の結合テストを追加し、配線の回帰を検出できるようにした。
- `src/session.test.ts` の該当ケースに subscription 経路のアサーションを追加した。
- 検証: `vp check` / `tsc --noEmit` / `vp test run`（1811 tests）が通る。
