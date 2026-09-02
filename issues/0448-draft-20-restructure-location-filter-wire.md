# Location Filter を draft-20 の Length ベースワイヤに合わせて再構成する

- Created: 2026-09-01
- Completed: 2026-09-02
- Branch: feature/change-restructure-location-filter-wire
- Polished: 2026-09-01

## 目的

draft-ietf-moq-transport-20 §5.1.2 / §10.2.9 で Location Filter のワイヤ形式が Filter Type enum から Length で optional フィールド数を決める形式に変わった。互換不能な破壊的変更なので、エンコード・デコードと公開型を draft-20 に揃える。

## 現状

- `src/message/parameter.ts` の `LocationFilter` / `encodeLocationFilter` / `decodeLocationFilter` は draft-19 の Filter Type (`NextGroupStart` / `LargestObject` / `AbsoluteStart` / `AbsoluteRange`) を `FILTER_TYPE` 定数 (0x01–0x04) でワイヤ化する。
- draft-20 §5.1.2 は次の length-prefixed 構造:
  - Length 0: フィルタなし (REQUEST_UPDATE での除去など)
  - 1 フィールド: StartGroup (相対。Next Group 基準)
  - 2 フィールド: StartGroup + StartObject
  - 3 フィールド: StartGroup + StartObject + EndGroupDelta
  - 4 フィールド: StartGroup + StartObject + EndGroupDelta + EndObject
- `FilterType` (`src/message/types.ts`)、`filter.ts` の `resolveFilter`、`buildSubscribeParameters` (`src/session/params.ts`)、公開型 `LocationFilter` (`src/index.ts`) が draft-19 形に依存している。
- 後続の FETCH 再構成 (0449) と FILL_PARAMETERS (0450) は本変更が前提。

## 設計方針

- `LocationFilter` の公開表現を draft-20 の意味論 (StartGroup / StartObject / EndGroupDelta / EndObject の有無) に合わせて再設計する。既存の `NextGroupStart` 等の別名は、同等意味を新表現で表せるなら移行ガイド付きで廃止する。
- `encodeLocationFilter` / `decodeLocationFilter` は Length (バイト長) を optional vi64 フィールドの区切りとし、Length が示す範囲内のフィールド数 (0〜4) を決定する。Length と実際の消費バイト数が一致しない場合、またはフィールド数が 4 超になる場合は PROTOCOL_VIOLATION (受信) / 送信前エラーに揃える。Length のバイト値はフィールド数と直接対応しないため、Length=2 を「2 フィールド」と解釈しないこと。
- Length 0 を明示サポートする (REQUEST_UPDATE でのフィルタ除去)。
- `filter.ts` の解決ロジックを新ワイヤ意味論に合わせて更新し、既存の AbsoluteRange End Group 超過検証 (§5.1.2) は維持する。
- 破壊的変更として `CHANGES.md` に `[CHANGE]` を記載する。

## 完了条件

- Location Filter の encode / decode が draft-20 §5.1.2 の Length ベースと round-trip すること。
- フィールド数 0 (Length 0)・1・2・3・4 の各ケースと、不正 Length (Length と消費バイト数の不一致など) のテストがあること。
- `filter.ts` / SUBSCRIBE 送信経路 / 公開 API が新表現に追随していること。
- `FilterType` 定数と draft-19 専用ワイヤパスが残っていないこと。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1809)
- 後続: `issues/0449-draft-20-change-fetch-to-location-filter-remove-joining.md`
- 後続: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`

## 解決方法

draft-20 §5.1.2 の Length ベースワイヤ (フィールド数 0〜4) に合わせて Location Filter を再構成した。

- `src/message/parameter.ts`: 公開型 `LocationFilter` をフィールド有無ベースの union (`{ reset: true }` / `{ startGroup }` / `{ startGroup, startObject }` / `+ endGroupDelta` / `+ endObject`) に再設計。`encodeLocationFilter` / `decodeLocationFilter` を Length (バイト長) プレフィックス方式に書き直し、Length 0 を `reset` として明示サポートした。不正 Length (フィールド数 4 超・Length 境界跨ぎ・境界内で varint が切れる) は ProtocolViolationError、送信側の End Group (StartGroup + EndGroupDelta) 2^64-1 超過は InvalidFilterError で拒否する。
- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING`: `0x21` を Range Filter と同じ `self-length-prefixed` (単一 Length 構造) に変更し、外側 Length を付加しないワイヤに修正した (Appendix A.1 #1809 の「match the other filter parameters」)。
- `src/filter.ts`: `ResolvedFilter` に `endObject` を追加し、`resolveFilter` を新意味論 (1 フィールド相対 / 2 フィールド 0:0 の Next Object / 3・4 フィールド絶対) に更新。相対計算の上下端 (0 / 2^64-1) クランプと `objectMatchesFilter` の End Object 評価を実装した。
- `src/session.ts`: joiningFetch の旧 LargestObject 検証を Next Object 形式判定 (`isNextObjectLocationFilter`) に置き換え、デバッグログのフィールドを新表現に追随させた。`isNextObjectLocationFilter` は `src/message/parameter.ts` に共通ヘルパとして export した。
- `src/message/types.ts` / `src/message/index.ts`: `FilterType` 定数と export を削除した。
- テスト: `parameter.test.ts` に Length 0/1/2/3/4 の round-trip、ワイヤ固定バイト列 (単一 Length 構造)、不正 Length 4 種、End Group 境界 2^64-1 のテストを追加。`filter.test.ts` に新旧意味論・上下端クランプ・End Object 評価のテストを更新。プロパティテスト (`parameter.prop.ts` / `session.prop.ts` / メッセージ系 prop 6 ファイル) を新ワイヤ生成に追随させた。
- `README.md` / `docs/LOW_LEVEL_API.md` / devtools の旧 Filter 表現・死んだフィールド名マッピングを新形式に更新した。
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記した。
- `vp check` / `tsc --noEmit` / `vp test run` / `vp run build` すべて通過。
