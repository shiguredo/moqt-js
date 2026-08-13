# Range Filter の評価 (マッチング) ロジックを実装する

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/add-moqt-draft-19-range-filter-evaluation-logic
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §5.1.3 / §5.1.4 で定義される Range Filter の評価 (マッチング) ロジックを実装する。現在は Range Filter のワイヤエンコード / デコードのみが存在し、オブジェクトがフィルタ条件を満たすかの判定 (SetID ごとの AND / OR 結合) が実装されていない。

## 優先度根拠

§5.1 は「Because subscriptions can share a Track Alias, the subscriber re-applies each subscription's filter to determine which subscription a received Object belongs to.」と定め、subscriber 側でのフィルタ再適用を前提とする。closed issue 0334 は Location Filter の再適用を `SubscriberImpl.handleObject` / `handleDatagram` に実装済みであり、closed issue 0341 のスコープ外に「同一 Track Alias 上の複数 subscription に対する subscriber 側 Range Filter 再適用 (再適用は 0334 完了後の別作業)」として予定されていた。本 issue はその引き継ぎである。フィルタ再適用がないと、同一 Track への複数 subscription でフィルタが異なる場合に、受信オブジェクトがどの subscription に属するかを判定できない。Medium。

## 現状

- `encodeRangeFilter` / `decodeRangeFilter` (`src/message/parameter.ts`) に Range Filter のワイヤエンコード / デコードがある。`decodeRangeFilter` は production の受信経路で未使用 (0362 の修正後の value 形式 (Length 込み) を前提とする)。
- フィルタ評価 (オブジェクトの Subgroup ID / Object ID / Priority / Property 値が Range に含まれるか、SetID ごとの AND / OR 結合) はリポジトリ内に一切存在しない。
- `src/filter.ts` は Location Filter の評価 (`resolveFilter` / `objectMatchesFilter`) のみ。Location Filter の再適用は `SubscriberImpl.handleObject` / `handleDatagram` (`src/subscriber.ts`) 内で行われ、`src/session/stream.ts` / `src/session/incoming.ts` は「同一 alias の全 subscription に配送 (filter 再適用は各 handleObject 内)」と配送に徹している。
- `src/session/params.ts` には送信側の `validateRangeFilterLimits` / `buildRangeFilterParameters` があり、`getSetupMaxFilterRanges` は `src/message/setup.ts` に定義されている。
- `Publish` 型 (`src/message/publish.ts`) は `trackProperties: Property[]` を持ち、受信 PUBLISH の Track Properties を参照できる。
- 変更対象ファイル: `src/filter.ts` (評価関数の追加)、`src/subscriber.ts` (オブジェクト受信経路への適用とフィルタ状態の管理)、`src/session.ts` (受信 PUBLISH 処理での TRACK_PROPERTY_FILTER 評価、tracksSubscriptions への rangeFilters 保持)、`src/session/bidi.ts` (REQUEST_UPDATE 成功時のフィルタ反映)、`src/properties.ts` (寛容デコード関数の export または共有ヘルパ化。OBJECT_PROPERTY_FILTER の評価で使用)、`src/filter.test.ts` / `src/subscriber.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- **評価関数**: §5.1.3 に従い、同一 SetID のフィルタは AND、異なる SetID の結果は OR で結合する評価関数を `src/filter.ts` に追加する (Location Filter と並置)。入力はデコード済みの `RangeFilterSpec[]` (`decodeRangeFilter` の出力。0362 の修正後の value 形式を前提とする)。Range の包含判定は両端含む (inclusive。§5.1.3「Each Range Filter is a sequence of Start/End (vi64) inclusive Range pairs」)。終端省略 (End なし) は open-ended (上限なし)。
  - 評価対象: Subgroup ID (SUBGROUP_FILTER) / Object ID (OBJECTID_FILTER) / Publisher Priority (PRIORITY_FILTER) / Object Property 値 (OBJECT_PROPERTY_FILTER)。TRACK_PROPERTY_FILTER は track 単位の評価 (下記)。
  - 評価値がオブジェクトに明示されていない場合は**不通過**とする (フィルタは「値が Range 内」を要求するため、値がなければ満たせない。Location Filter の「フィルタなし = 全通過」とは異なる点に注意)。具体的には: subgroup ヘッダで Priority Present のない `publisherPriority: undefined` は不通過、datagram 経路の `subgroupId: undefined` は不通過。**PRIORITY_FILTER の評価でも、Priority が明示されていないオブジェクト (subgroup / datagram とも) は不通過とする**。datagram の `decodeObjectDatagram` は Priority Present なしのとき `publisherPriority = 0` を設定するが、これは実装上のはけ口であり、§11.3.1 / §12.4 の「継承」(Default Publisher Priority、省略時 128) とは無関係。0 を評価値として使うと PRIORITY_FILTER 0-0 等を誤通過させ、経路間 (subgroup は不通過 / datagram は 0 評価) で結果が変わるため、明示値のみで評価し継承値の解決は行わない (防御的再適用の範囲を明示値のみに限定する。継承値の解決が必要になった場合は別 issue の対応とする)。
  - OBJECT_PROPERTY_FILTER の評価には**寛容デコード**を使用する (`readDeliveryTimeoutObjectProperties` と同じ `decodeObjectPropertiesTolerant` 経路。Track 向けの厳密な `decodeProperties` は使わない。Object バイト列に適用すると未知の Mandatory Track Property 等で誤って MalformedTrackError になり得るため)。部分デコード (complete=false) で対象 Property ID が読めた場合は、`readDeliveryTimeoutObjectProperties` と同じく読めた分を使用する。デコード不能・対象 Property ID 不在の場合は不通過とみなす。対象 Property の検索は §12.7「When looking for the value of a property, processors MUST search both the mutable properties and the contents of Immutable Properties.」に従い、IMMUTABLE_PROPERTIES ネスト内も含める (`supportsDynamicGroups` の先例参照)。TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の trackProperties に対する検索) でも同じ §12.7 の規則に従い、IMMUTABLE_PROPERTIES ネスト内も検索する。
  - 評価入力の `RangeFilterSpec[]` が空 (フィルタなし) の場合は**全通過**とする (Location Filter の「フィルタなし = 全通過」と同じ)。`RangeFilterSpec[]` に Length=0 の remove エントリ (`RangeFilterRemove`) が含まれる場合は評価対象から除外する (remove は REQUEST_UPDATE の更新操作であり、評価時には意味を持たない)。
- **オブジェクト受信経路への適用**: SUBGROUP / OBJECTID / PRIORITY / OBJECT_PROPERTY の評価は `SubscriberImpl.handleObject` / `handleDatagram` 内で行う (Location Filter の再適用と同じ位置。同一 alias の複数 subscription は per-subscription で評価するため、`src/session/stream.ts` / `src/session/incoming.ts` には置かない)。不通過のオブジェクトは Location Filter と同じく黙って破棄する (アプリへ渡さない)。
- **TRACK_PROPERTY_FILTER の評価**: §5.1.3「The Track Property Filter can be used in SUBSCRIBE_TRACKS to filter PUBLISH messages with required Track Property types and values. PUBLISH messages which pass the filter will be forwarded」に従い、受信 PUBLISH 処理 (`handleIncomingBidirectionalStream`) で `onPublish` 呼び出しより前に評価する。通過しない PUBLISH は `onPublish` を呼ばず、§10.10 の SHOULD に従い REQUEST_ERROR (UNINTERESTED) で応答してストリームの読み取りを放棄する (既存の `matchPublishToSubscription` 失敗時の処理と同じパターン)。オブジェクト受信経路では評価しない (MoqtObject に Track Properties はない)。
- **フィルタ状態の管理**: フィルタ状態は送信元ごとに 2 系統で保持する。
  - SUBSCRIBE 由来: `SubscriberImpl` に Range Filter の保持フィールドと setter (`setLocationFilter` 相当の `setRangeFilters`) を追加し、SUBSCRIBE 送信時 (options.rangeFilters) と REQUEST_UPDATE 成功時 (`bidiHandleRequestUpdateOk`) に設定する。REQUEST_UPDATE のセマンティクス (§5.1.3「In REQUEST_UPDATE, Length can be 0 to remove a filter parameter or non-zero to replace that entire filter parameter …」) に従い、削除 / 置換 / 不変を反映する。REQUEST_UPDATE 成功時に送信した rangeFilters を参照するため、`pendingRequestUpdate` のエントリに送信時の options (rangeFilters) を保持し、`bidiHandleRequestUpdateOk` で反映する (0377 の forward 反映と同じ方式)。
  - SUBSCRIBE_TRACKS 由来: `tracksSubscriptions` のエントリに rangeFilters を保持する (現在は保持していない。更新 API は 0393 が別途扱うため、本 issue では SUBSCRIBE_TRACKS 送信時のみの設定とする)。受信 PUBLISH 処理では、マッチした tracks subscription の rangeFilters から TRACK_PROPERTY_FILTER を抽出して評価し、SUBGROUP / OBJECTID / PRIORITY / OBJECT_PROPERTY は `onPublish` 経由で生成される SubscriberImpl に渡して `handleObject` / `handleDatagram` で評価する。
- **スコープ外の明記**: FETCH 経路 (FetcherImpl には Location Filter の再適用もない既存設計のため、再適用しない)、client-as-publisher での送信抑止 (§5.1.4 の publisher MUST。0341 が別 issue とした。後続 issue は未起票)。

## 完了条件

- 各 Range Filter 種別 (SUBGROUP / OBJECTID / PRIORITY / OBJECT_PROPERTY) の評価関数があり、SetID ごとの AND / OR 結合が正しく動作すること (同一 SetID は AND、異 SetID は OR。フィルタなしは全通過)。
- 包含判定が両端含む (inclusive) で動作し、終端省略 (End なし) が open-ended として動作すること。§5.1.3 の例 (ranges 3-5 / 10-15。objectId 4 は通過、objectId 7 は不通過) を再現するテストがあること。
- 評価値が明示されていないオブジェクト (subgroup の priority undefined / datagram の subgroupId undefined / Priority Present なしの datagram) は不通過になること (datagram の `publisherPriority = 0` を評価値として使わないこと)。
- 評価結果がオブジェクト受信経路 (`SubscriberImpl.handleObject` / `handleDatagram`) で適用され、不通過のオブジェクトがアプリに渡されないこと。
- 受信 PUBLISH 処理で TRACK_PROPERTY_FILTER が評価され、不通過の PUBLISH は `onPublish` が呼ばれず REQUEST_ERROR (UNINTERESTED) で応答されること。
- フィルタ状態が SUBSCRIBE 送信時 (SubscriberImpl) と SUBSCRIBE_TRACKS 送信時 (tracksSubscriptions) および REQUEST_UPDATE 成功時に更新されること。
- OBJECT_PROPERTY_FILTER の評価が寛容デコードで行われ、デコード不能・対象 Property ID 不在の場合は不通過になること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1 (Subscriptions / subscriber 側のフィルタ再適用)
- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / SetID の AND / OR 結合 / inclusive Range / open-ended / REQUEST_UPDATE の削除・置換・不変 / TRACK_PROPERTY_FILTER は PUBLISH メッセージをフィルタ)
- draft-ietf-moq-transport-19 §5.1.4 (Combining Filters / Pass = Forward AND Location Filters AND Range Filters)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（Range Filters 導入元。subscriber 側再適用をスコープ外として本 issue に委譲。未達の純関数ヘルパ完了条件の引き継ぎ）
- 関連: `issues/closed/0334-draft-19-multiple-subscriptions-per-track.md`（Location Filter の再適用を実装した先例）
- 関連: `0362-bug-range-filter-length-encoding.md`（value 形式の修正。実装順は先に 0362。本 issue は 0362 修正後の value 形式を前提とする）
- 関連: `0380-moqt-draft-19-range-filter-value-validation.md`（受信検証。検証後の value 形式を共有）
- 関連: `0393-add-range-filters-fetch.md`（送信ガード。実装順は先に 0393 の SUBSCRIBE での 0x29 throw ガードを確認してから本 issue の TRACK_PROPERTY_FILTER 適用を実装する。SUBSCRIBE_TRACKS の更新 API は 0393 実装時に別 issue の対応と確定済み）

## 解決方法

未着手。
