# LOCATION FILTER を明示的な Location Filter Type 方式に変更する

- Created: 2026-10-02
- Completed: 2026-10-02
- Branch: feature/change-location-filter-encoding
- Polished: 2026-10-02

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
- 0:0 を Next Object として送る内部呼び出しがある。`src/createMediaSubscriber.ts` (catalog の live SUBSCRIBE) と `devtools/src/hooks/useSubscriber.ts` (catalog の live SUBSCRIBE) が `filter: { startGroup: 0n, startObject: 0n }` を Next Object として使う
- 公開 API ドキュメントも旧表現のまま。`src/session/publicTypes.ts` の `SubscribeOptions.filter` / `FetchOptions.filter` / `FillRequestOptions.filter` と fill の説明、`src/subscriber.ts` の `largestLocation`、`src/session/requests.ts` のコメントに「Length ベース」「両方 0 は Next Object」が残る
- コメントの節番号は v21 の §9.20.10 のまま

## 設計方針

- 公開型 `LocationFilter` を v22 の 6 形式に対応させる。None (`{ reset: true }`) はそのまま、Next Object は専用の表現 (例: `{ nextObject: true }`) を追加し、2 フィールド 0:0 の特例を表現から除く
- `encodeLocationFilter` は先頭に Location Filter Type (vi64) を書き、型に応じた個数の vi64 を続ける。`decodeLocationFilter` は Type を読み、型ごとの個数を読む。未知の Type は PROTOCOL_VIOLATION とする。End Group の 2^64-1 超過検証は維持する
- `messageParameter.ts` の 0x21 を Length なしの専用エンコーディングに変更する。値の終端は Type とフィールド数で決まるため、`decodeMessageParameter` はストリームから Type とフィールドを読み、消費バイト数を確定してから値を保持する。FILL_PARAMETERS 内側の `decodeFillParameters` も同じ方式に合わせる
- `isNextObjectLocationFilter` は 0x05 表現を判定する。`resolveFilter` の Next Object と相対指定 (0x01) の解決、`resolveFetchStartLocation` の確定可否、`isSameLocationFilter` の比較を新しい表現に合わせる。0x02 の 0:0 は絶対位置 {0, 0} の指定として扱う (Next Object にはしない)
- `{ startGroup: 0n, startObject: 0n }` を Next Object として送っていた内部呼び出し (`src/createMediaSubscriber.ts` / `devtools/src/hooks/useSubscriber.ts` の catalog の live SUBSCRIBE) を `{ nextObject: true }` に移行する。0:0 のまま残すと 0x02 の絶対 {0, 0} 指定として解釈され、トラック先頭から全 Object を受信してしまう
- LOCATION_FILTER 関連のコメントを v22 に更新する (節番号 §9.20.10 → §9.20.9 に加えて、「Length ベース」「両方 0 は Next Object」の旧意味論が残る `src/session/publicTypes.ts` / `src/subscriber.ts` / `src/session/requests.ts` の記述を新表現に合わせる)
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
- `src/session/publicTypes.ts` / `src/subscriber.ts` / `src/session/requests.ts`
- `src/createMediaSubscriber.ts` / `devtools/src/hooks/useSubscriber.ts`
- `src/message/parameter.prop.ts` / `src/message/parameter.test.ts` / `src/filter.prop.ts` / `src/session/params.prop.ts`

## 解決方法

LOCATION_FILTER のワイヤ形式・公開型・フィルタ解決を draft-ietf-moq-transport-22 §9.20.9 の Location Filter Type 方式に変更した。

- `src/message/parameter/locationFilter.ts`: 公開型 `LocationFilter` を 6 形式 (0x00 `{ reset: true }` / 0x01 `{ startGroup }` / 0x02 `{ startGroup, startObject }` / 0x03 `+ endGroupDelta` / 0x04 `+ endObject` / 0x05 `{ nextObject: true }`) に変更した。`encodeLocationFilter` は先頭に Type を書き、`decodeLocationFilter` は Type が定める個数の vi64 を読む。未知の Type は `ProtocolViolationError`、End Group (StartGroup + EndGroupDelta) の 2^64-1 超過は送信前 `InvalidFilterError` / 受信時 `ProtocolViolationError` を維持する。公開型 → Type・フィールド列の写像は 1 関数に、フレーミングの走査は `scanLocationFilter` に集約した
- `src/message/parameter/messageParameter.ts`: 0x21 の Value エンコーディングを `"location-filter"` として分離し、Type とフィールド数から消費バイト数を確定する (意味論の検証は `decodeLocationFilterParameter` が担う)。FILL_PARAMETERS 内側も同じ経路になる
- `src/filter.ts` / `src/session/params.ts`: `isNextObjectLocationFilter` を型述語にして Type 0x05 を判定する。`resolveFilter` の 0x05 は `{Largest.Object.Group, Largest.Object.Object + 1}` (未配信時 `{0, 0}`)、0x01 は Next Group 基準で上下端クランプ、0x02 の 0:0 は絶対位置 `{0, 0}` として解決する。`resolveFetchStartLocation` は 0x05 と 0x01 だけを未確定とし、0:0 も絶対位置として確定する。`isSameLocationFilter` は Type を先に比較し、0x00 と 0x05 の空フィールド列の衝突を防ぐ
- `src/createMediaSubscriber.ts` / `devtools/src/hooks/useSubscriber.ts`: catalog の live SUBSCRIBE を `{ nextObject: true }` に移行した (`catalogFetchFilter` は Group 0 のときフィルタを付けない挙動を維持する)
- コメント: LOCATION_FILTER 関連の節番号を v22 に更新した。他パラメータの節番号が同じ行に混在する参照 (§9.20.16 の FILL_PARAMETERS など) は、許可パラメータ一覧の監査 (0803) の担当として残し、混在が誤読を招く箇所は版を明記した
- テスト: 6 形式すべてのワイヤ固定 (0x00 / 0x05 は Type のみ)、多バイト varint で v21 の Length 前置き形式と区別できること、未知 Type の拒否、フィールド切り詰め、0:0 が絶対位置 `{0, 0}` になること、Next Object の解決、FILL_PARAMETERS 内側、live SUBSCRIBE の `{ nextObject: true }`、送信側の Type 0x00 / 0x05 を追加・更新した。v21 の Length 形式で手組みしていた超過テスト 3 件は新形式の共有ヘルパに置き換え、エラーメッセージまで固定した
- 検証: `vp check` / `tsc --noEmit` / `vp test run` (198 files / 3564 tests) が通る。`/review-diff-code` を 3 周回し、致命的・重要 0 件

### 範囲外として残した点

レビューで判明した次の 2 件は本 issue の範囲外のため対応せず、issue 化候補として扱う。

- PUBLISH_STATE_NOTIFY が載せる LARGEST_OBJECT と、送信後に反映する Location Filter の解決基準が `await` を挟むためずれ得る (取りこぼしの可能性)
- moqt-devtools の catalog SUBSCRIBE の `{ nextObject: true }` は devtools 側のテストで固定されていない (ライブラリ側の `createMediaSubscriber` では固定済み)
