# RequestUpdateOptions.parameters の生 LOCATION_FILTER が End Group 2^64-1 検証を回避できる

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-raw-location-filter-bypass
- Polished: 2026-09-05

## 目的

`Subscriber.update()` の `RequestUpdateOptions.parameters`（`src/subscriber.ts`）は `Parameter[]` を直接受け取る raw 経路であり、doc に「LOCATION_FILTER, SUBSCRIBER_PRIORITY など」と LOCATION_FILTER を例示している。しかしこの経路は `encodeLocationFilterParameter()` を通さないため、0426 で追加した End Group の 2^64-1 超過検証を回避して、対向を PROTOCOL_VIOLATION でセッション終了させ得る不正ワイヤを送信できてしまう。raw パラメータ経路でも同一の値検証を強制する (End Group 超過は 3 / 4 フィールド表現 = 旧 AbsoluteRange 相当が対象)。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）は `const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];` と生パラメータを無検証で複製し、`options.rangeFilters` / `forward` / `authorizationToken` を追記した上で `encodeRequestUpdatePayload()` に渡す。LOCATION_FILTER の値内容は一切検証されない。
- `encodeParameters()` / `encodeRequestUpdatePayload()` も delta encoding とソートは行うが、パラメータ値の構造・値域は検証しない。
- 0426 は `encodeLocationFilter()` / `encodeLocationFilterParameter()` に送信前検証を入れたが、これは型付き Location Filter を組み立てる駆動経路 (SUBSCRIBE / FETCH / FILL_PARAMETERS 構築経路の `encodeLocationFilterParameter` 経由) にのみ効く。raw `Parameter` 生成は公開の `RequestUpdateOptions.parameters` に type 0x21 の `Parameter` を手組みして到達可能なため、検証を素通りして超過ワイヤが送信され得る。
- 対向実装は §5.1.2 の MUST に従い超過 End Group を PROTOCOL_VIOLATION でセッションを閉じるため、ローカル検証を通過した `update()` が対向とのセッションを落とす結果になる。

## 設計方針

- `bidiSendRequestUpdate` で `pendingRequestUpdate.set` より前（既存の `validateRangeFilterSpecs` / MAX_FILTER_RANGES ガードと同じ位置）に、`options.parameters` のトップレベルの `MessageParameterType.LOCATION_FILTER` を検出し `decodeLocationFilterParameter()` でデコード検証するガードを追加する。デコード失敗（End Group 超過の `ProtocolViolationError` を含む構造不正・切詰めの `IncompleteDataError`）はすべて `InvalidFilterError` へ変換して throw する（raw 経路でのローカル API 誤用は送信側検証の一環であり、`InvalidFilterError` の適用範囲と整合。型不一致は型で絞るため到達しない）。
- `FILL_PARAMETERS` 内側の LOCATION_FILTER は対象外とする。型付き fill 経路は `buildFillParameters` 経由で検証済みであり、手組みの raw `FILL_PARAMETERS` 内側は本 issue では扱わない。必要なら別途 issue 化する。
- ガードは throw 時に `pendingRequestUpdate` エントリが残らない位置に配置する（0426・0393 の「ガードは登録前に配置」の不変条件に従う）。
- `Parameter` を生で受け取る API 設計自体の見直し（型付き Location Filter に寄せる破壊的変更）は本 issue の範囲外とし、まずは検証の接続を優先する。設計変更が必要なら別途 issue 化する。
- LOCATION_FILTER 以外の生パラメータ（SUBSCRIBER_PRIORITY 等）の値域検証は本 issue では扱わない（目的は End Group 超過の回避経路の塞止みに限定する）。

## 完了条件

- `options.parameters` に End Group が 2^64-1 を超える 3 / 4 フィールド表現の LOCATION_FILTER を含めて `update()` を呼ぶと、送信前に `InvalidFilterError` で reject し、`pendingRequestUpdate` にエントリが残らないこと（`src/session/bidi.test.ts` の既存ガードテストのパターンで検証する）。
- 正常な LOCATION_FILTER を raw パラメータで渡した場合従来どおり送信できること（回帰ガード）。
- `MessageParameterType.LOCATION_FILTER` 以外のパラメータは検証対象にしないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-20 §10.9 (REQUEST_UPDATE)
- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md`（型付き駆動経路の送信前検証。本 issue は raw パラメータの回避経路）

## 解決方法

未着手。
