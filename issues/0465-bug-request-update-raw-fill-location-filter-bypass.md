# RequestUpdateOptions.parameters の手組み FILL_PARAMETERS 内側 LOCATION_FILTER が End Group 検証を回避できる

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-raw-fill-location-filter
- Polished: 2026-09-06

## 目的

`RequestUpdateOptions.parameters` に手組みの raw FILL_PARAMETERS (0x23) を渡し、その内側に End Group 超過の LOCATION_FILTER を埋めると、送信側検証を素通りして不正ワイヤを送出でき、対向が PROTOCOL_VIOLATION でセッションを閉じる。0437 で塞いだトップレベル経路の残余として塞ぐ。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）の raw 検証ガードはトップレベルの `MessageParameterType.LOCATION_FILTER` のみを走査し、手組みの raw `FILL_PARAMETERS` 内側はデコードしない。
- 型付き fill 経路（`options.fill`）は `buildFillParameters`（`src/session/params.ts`）が `encodeLocationFilterParameter` 経由で検証するため問題ない。未検証で送出され得るのは手組みの raw 0x23 のみである。
- 送信経路では `decodeFillParameters`（`src/message/parameter.ts`）を呼ばないため、内側の超過は検出されない。一方で受信側は内側を検証するため、送受で非対称になっている。
- draft-ietf-moq-transport-20 §5.1.2 の End Group 超過 MUST は FILL 内側にも適用される。

## 設計方針

- `bidiSendRequestUpdate` で `pendingRequestUpdate.set` より前（0437 ガードと同じ位置）に、`options.parameters` 内の raw `FILL_PARAMETERS` 全件を `decodeFillParameters()` でデコード検証するガードを追加する。複数ある場合は全件検証し、2 件目以降の超過を見逃さない（0437 ガードの全件方針と同形）。
- デコード失敗（End Group 超過の `ProtocolViolationError` を含む構造不正・切詰めの `IncompleteDataError`・内側除去や Range 違反の `InvalidFilterError`）はすべて `InvalidFilterError` へ変換して throw する（0437 ガードと同形）。`decodeFillParameters` による内側全体検証のため、End Group 以外の内側不正（許可外型・除去・Range 組み合わせ違反）も送信前に塞ぐ副作用を持つが、受信側で `PROTOCOL_VIOLATION` / `REQUEST_ERROR` になる不正の早期検出であり許容する。
- 検証対象の超過は 3 / 4 フィールド表現（`EndGroupDelta` を持つもの）に限る。1 / 2 フィールド表現には `EndGroupDelta` がなく超過し得ない。
- ガードは throw 時に `pendingRequestUpdate` エントリが残らない位置に配置する。
- 正常な raw `FILL_PARAMETERS` は従来どおり送信できること。型付き fill 経路の挙動は変えない。

## 完了条件

- 内側 LOCATION_FILTER の End Group が 2^64-1 を超える 3 / 4 フィールド表現（例: `StartGroup` 1 + `EndGroupDelta` 2^64-1）を `encodeParameters` で包んだ raw `FILL_PARAMETERS` を含めて `update()` を呼ぶと、送信前に `InvalidFilterError` で reject し、`pendingRequestUpdate` にエントリが残らないこと（`src/session/bidi.test.ts` の既存ガードテストのパターンで検証する）。
- 複数の raw `FILL_PARAMETERS` を渡し、2 件目以降の内側超過も `InvalidFilterError` で reject し、`pendingRequestUpdate` にエントリが残らないこと。
- 正常な raw `FILL_PARAMETERS`（正常な内側 LOCATION_FILTER を `encodeParameters` で包んだもの）を渡した場合は従来どおり送信され、ワイヤ上の parameters に `FILL_PARAMETERS` が残ること（回帰ガード）。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.15 (FILL PARAMETERS Parameter)
- 関連: `issues/closed/0437-bug-request-update-raw-location-filter-bypass.md`（トップレベル経路の送信前検証。本 issue は内側の残余）

## 解決方法

未着手。
