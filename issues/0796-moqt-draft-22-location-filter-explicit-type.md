# LOCATION FILTER を明示的な Location Filter Type 方式に変更する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/change-location-filter-encoding
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.20.9 で LOCATION_FILTER のワイヤ形式が変更された。v21 は先頭の Length (vi64) とその範囲内の vi64 個数でフィールド構成を推論していたが、v22 は Location Filter Type (vi64) が形式を明示する。Length フィールドは無くなり、後続フィールドは型ごとに決まる。

- 0x00 (None): フィールドなし。フィルタなし
- 0x01 (Relative Start): StartGroup が続く (相対)
- 0x02 (Absolute Start): StartGroup + StartObject
- 0x03 (Absolute Start, Group End): StartGroup + StartObject + EndGroupDelta
- 0x04 (Absolute Range): StartGroup + StartObject + EndGroupDelta + EndObject
- 0x05 (Next Object): フィールドなし
- 上記以外の型は PROTOCOL_VIOLATION

v21 の「2 フィールドで StartGroup = StartObject = 0 は Next Object」という特例は廃止され、Next Object は 0x05 が表す。後方互換はない。moqt-js は v21 形式で実装済みのため、ワイヤ形式・公開型・フィルタ解決を更新する。

## 現状

- `src/message/parameter/locationFilter.ts` の `encodeLocationFilter` は先頭にバイト長の Length (vi64) を付けてフィールド列を連結し、`decodeLocationFilter` は Length 範囲内の vi64 個数から 0〜4 フィールドに推論する
- `isNextObjectLocationFilter` は 2 フィールドで StartGroup = StartObject = 0 の形式を Next Object と判定し、`isSameLocationFilter` はフィールド列 (0〜4 個) で等価判定する
- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` は 0x21 を "self-length-prefixed" として扱い、外側 Length なしで内側 Length を読む。`decodeFillParameters` も同じ前提で FILL_PARAMETERS 内側の LOCATION_FILTER を処理する
- `src/filter.ts` の `resolveFilter` と `src/session/params.ts` の `resolveFetchStartLocation` は 2 フィールド 0:0 を Next Object として解決する
- `src/message/parameter.test.ts` は Length 形式のワイヤ (例: `[0x01, 0x21, 0x01, 0x03]`、reset は `[0x01, 0x21, 0x00]`) を固定している。`src/message/parameterArb.ts` の `locationFilterArb` / `locationFilterParameterArb` も Length 形式を前提にしている
- コメントの節番号は v21 の §9.20.10 のまま

## 設計方針

- 公開型 `LocationFilter` を v22 の 6 形式に対応させる。None (`{ reset: true }`) はそのまま、Next Object は専用の表現 (例: `{ nextObject: true }`) を追加し、2 フィールド 0:0 の特例を表現から除く
- `encodeLocationFilter` は先頭に Location Filter Type (vi64) を書き、型に応じた個数の vi64 を続ける。`decodeLocationFilter` は Type を読み、型ごとの個数を読む。未知の Type は PROTOCOL_VIOLATION とする。End Group の 2^64-1 超過検証は維持する
- `messageParameter.ts` の 0x21 を Length なしの専用エンコーディングに変更する。値の終端は Type とフィールド数で決まるため、`decodeMessageParameter` はストリームから Type とフィールドを読み、消費バイト数を確定してから値を保持する。FILL_PARAMETERS 内側の `decodeFillParameters` も同じ方式に合わせる
- `isNextObjectLocationFilter` は 0x05 表現を判定する。`resolveFilter` の Next Object と相対指定 (0x01) の解決、`resolveFetchStartLocation` の確定可否、`isSameLocationFilter` の比較を新しい表現に合わせる。0x02 の 0:0 は絶対位置 {0, 0} の指定として扱う (Next Object にはしない)
- コメントの §9.20.10 を §9.20.9 に更新する
- テストを更新する。新ワイヤ形式の固定、6 形式すべての round-trip、FILL_PARAMETERS 内側、未知 Type の拒否、2 フィールド 0:0 が絶対 {0,0} として解決されること、相対指定と Next Object (0x05) の解決を固定する

## 完了条件

- LOCATION_FILTER の encode / decode が v22 §9.20.9 の形式と一致する
- 旧 Length 形式の値が round-trip テストで再現されない (テストの期待値が新形式に更新されている)
- FILL_PARAMETERS 内側の LOCATION_FILTER も新形式で動作する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.3.1 (Location Filters) / §9.20.9 (LOCATION FILTER Parameter) / §9.20.15 (FILL PARAMETERS Parameter)
- `src/message/parameter/locationFilter.ts` の `encodeLocationFilter` / `decodeLocationFilter` / `isNextObjectLocationFilter` / `isSameLocationFilter`
- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` / `decodeFillParameters`
- `src/filter.ts` の `resolveFilter`
- `src/session/params.ts` の `resolveFetchStartLocation` / `buildFetchParameters` / `buildSubscribeParameters` / `buildSubscribeTracksParameters`
- `src/message/parameter.prop.ts` / `src/message/parameter.test.ts` / `src/filter.prop.ts` / `src/session/params.prop.ts`

## 解決方法

{未着手}
