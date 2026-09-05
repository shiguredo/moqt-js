# RequestUpdateOptions.parameters の手組み FILL_PARAMETERS 内側 LOCATION_FILTER が End Group 検証を回避できる

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-update-raw-fill-location-filter
- Polished: {YYYY-MM-DD}

## 目的

`RequestUpdateOptions.parameters` に手組みの raw FILL_PARAMETERS (0x23) を渡し、その内側に End Group 超過の LOCATION_FILTER を埋めると、送信側検証を素通りして不正ワイヤを送出でき、対向が PROTOCOL_VIOLATION でセッションを閉じる。0437 で塞いだトップレベル経路の残余として塞ぐ。

## 現状

- `bidiSendRequestUpdate`（`src/session/bidi.ts`）の raw 検証ガードはトップレベルの `MessageParameterType.LOCATION_FILTER` のみを走査し、手組みの raw `FILL_PARAMETERS` 内側はデコードしない。
- 型付き fill 経路（`options.fill`）は `buildFillParameters`（`src/session/params.ts`）が `encodeLocationFilterParameter` 経由で検証するため問題ない。未検証で送出され得るのは手組みの raw 0x23 のみである。
- 送信経路では `decodeFillParameters`（`src/message/parameter.ts`）を呼ばないため、内側の超過は検出されない。一方で受信側は内側を検証するため、送受で非対称になっている。
- draft-ietf-moq-transport-20 §5.1.2 の End Group 超過 MUST は FILL 内側にも適用される。

## 設計方針

- `bidiSendRequestUpdate` で `pendingRequestUpdate.set` より前（0437 ガードと同じ位置）に、`options.parameters` 内の raw `FILL_PARAMETERS` を検出し `decodeFillParameters()` でデコード検証するガードを追加する。デコード失敗は `InvalidFilterError` へ変換して throw する。
- ガードは throw 時に `pendingRequestUpdate` エントリが残らない位置に配置する。
- 正常な raw `FILL_PARAMETERS` は従来どおり送信できること。型付き fill 経路の挙動は変えない。

## 完了条件

- 内側 LOCATION_FILTER の End Group が 2^64-1 を超える raw `FILL_PARAMETERS` を含めて `update()` を呼ぶと、送信前に `InvalidFilterError` で reject し、`pendingRequestUpdate` にエントリが残らないこと（`src/session/bidi.test.ts` の既存ガードテストのパターンで検証する）。
- 正常な raw `FILL_PARAMETERS` を渡した場合従来どおり送信できること（回帰ガード）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.15 (FILL PARAMETERS Parameter)
- 関連: `issues/closed/0437-bug-request-update-raw-location-filter-bypass.md`（トップレベル経路の送信前検証。本 issue は内側の残余）

## 解決方法

未着手。
