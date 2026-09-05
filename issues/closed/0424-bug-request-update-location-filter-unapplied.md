# REQUEST_UPDATE 経由の LOCATION_FILTER が Subscriber のフィルタ状態に反映されない

- Created: 2026-08-22
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-request-update-location-filter
- Polished: 2026-09-05

## 目的

`SubscriberImpl` の `update()` で REQUEST_UPDATE の LOCATION_FILTER (0x21) パラメータを送信し、ピアが REQUEST_OK で受理した場合でも、Subscriber 側の Location Filter の再適用状態（`locationFilter` / `resolvedFilterCache`）が古いままになる。FORWARD と Range Filters は REQUEST_OK 受信時に反映されるのに、LOCATION_FILTER だけ反映されない非対称を解消する。

## 現状

- `RequestUpdateOptions.parameters`（`src/subscriber.ts`）の JSDoc は「LOCATION_FILTER, SUBSCRIBER_PRIORITY など」と宣言し、`bidiSendRequestUpdate`（`src/session/bidi.ts`）は `options.parameters` をそのまま REQUEST_UPDATE のパラメータ列に載せて送信する。
- REQUEST_OK 受信処理（`bidiHandleRequestUpdateOk`、`src/session/bidi.ts`）は LARGEST_OBJECT・`pendingRequestUpdate` の `forward` / `rangeFilters` のみ反映し、REQUEST_OK 受信時の LOCATION_FILTER を `SubscriberImpl.setLocationFilter()` へ反映する経路が無い。なお受信 PUBLISH / PUBLISH_STATE_NOTIFY 経路の `setLocationFilter` は存在し、本 issue は送信側 REQUEST_OK 経路のみを対象とする。
- `PendingRequestUpdate`（`src/session/bidi.ts`）にも送信時の LOCATION_FILTER 値を保持するフィールドが無い（`forward` / `rangeFilters` のみ保持）。
- そのため、ピアが REQUEST_OK で受理した後も `handleObject` / `handleDatagram` の Location Filter 再適用（§5.1.2）が旧 Start Location で動作し続ける。フィルタを変更したつもりでも配信結果が変わらない。
- 注: 受信側（role = publish）が文脈限定パラメータ（LOCATION_FILTER を含む）の REQUEST_UPDATE を NOT_SUPPORTED で応答する既存挙動は本 issue では触らない。本 issue は送信側（subscriber role）の反映漏れのみを対象とする。

## 設計方針

- `PendingRequestUpdate` に送信時の LOCATION_FILTER 値（型 `LocationFilter`、省略時 undefined）を保持し、`bidiHandleRequestUpdateOk` の REQUEST_OK 受信時に `subscriber.setLocationFilter()` で反映する。`resolvePendingRequestUpdate` の戻り値にも `locationFilter` を含める。
- 反映は `forward` / `rangeFilters` と同じタイミング・同じセマンティクスにする。省略時 (undefined) はフィルタを変更しない (draft-ietf-moq-transport-20 §10.9 および §10.2.9 に従う)。`{ reset: true }` (Length 0) は除去として `setLocationFilter({ reset: true })` で反映する。反映順序は LARGEST_OBJECT 反映の後とし、相対指定フィルタが Largest 依存で解決されること（受信 PUBLISH_STATE_NOTIFY 経路の `setLargestLocation` → `setLocationFilter` と同順）に合わせる。
- 送信時の LOCATION_FILTER は `options.parameters` のトップレベルの `MessageParameterType.LOCATION_FILTER` のうち最初の 1 件を `decodeLocationFilterParameter()` でデコードした値とする（受信側の `find` による抽出と同形）。`FILL_PARAMETERS` 内側の LOCATION_FILTER は fill 範囲であり対象外とする。デコードは `pendingRequestUpdate.set` より前（0437 の送信前検証ガードと同じ位置）で行い、0437 のガードで検証済みの値を再利用する。不正値の throw 時は `pendingRequestUpdate` にエントリを残さない（ガードは登録前に配置の不変条件に従う）。

## 完了条件

- REQUEST_OK 受信時に、送信時の LOCATION_FILTER が `SubscriberImpl.locationFilter` と `resolvedFilterCache` に反映されること（`src/session/bidi.test.ts` の `bidiHandleRequestUpdateOk` 単体テストパターンで検証する）。
- 反映後の `handleObject` / `handleDatagram` が新しい Start Location で再適用されること。
- LOCATION_FILTER を送らなかった `update()` ではフィルタが不変であること。
- REQUEST_ERROR / セッション終了時には反映されないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)

## 解決方法

- `PendingRequestUpdate` に送信時の LOCATION_FILTER 値 (`LocationFilter` 型、省略時 undefined) を保持するフィールドを追加した。
- `bidiSendRequestUpdate` で `options.parameters` のトップレベル LOCATION_FILTER のうち配列順の先頭 1 件を `decodeLocationFilterParameter()` でデコードして保持する (全件検証は維持し、FILL_PARAMETERS 内側は対象外)。
- `bidiHandleRequestUpdateOk` で LARGEST_OBJECT 反映の後に `subscriber.setLocationFilter()` で反映する。省略時は不変、除去指定 (Length 0) はフィルタなしとして反映する。
- `resolvePendingRequestUpdate` の戻り値に `locationFilter` を含めた。
- テストは `src/session/bidi.test.ts` に 5 件追加した (反映と再適用・省略時不変・除去・pending 保持・失敗時非反映)。
- 触ったファイル: `src/session/bidi.ts`、`src/session/bidi.test.ts`、`CHANGES.md`。
