# Location Filter を draft-20 の Length ベースワイヤに合わせて再構成する

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/change-restructure-location-filter-wire
- Polished: {YYYY-MM-DD}

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
- `FilterType` (`src/message/types.ts`)、`filter.ts` の `resolveLocationFilter`、`buildSubscribeParameters` (`src/session/params.ts`)、公開型 `LocationFilter` (`src/index.ts`) が draft-19 形に依存している。
- 後続の FETCH 再構成 (0449) と FILL_PARAMETERS (0450) は本変更が前提。

## 設計方針

- `LocationFilter` の公開表現を draft-20 の意味論 (StartGroup / StartObject / EndGroupDelta / EndObject の有無) に合わせて再設計する。既存の `NextGroupStart` 等の別名は、同等意味を新表現で表せるなら移行ガイド付きで廃止する。
- `encodeLocationFilter` / `decodeLocationFilter` は Length からフィールド数を決定する。未知 Length・不正組み合わせは PROTOCOL_VIOLATION (受信) / 送信前エラーに揃える。
- Length 0 を明示サポートする (REQUEST_UPDATE でのフィルタ除去)。
- `filter.ts` の解決ロジックを新ワイヤ意味論に合わせて更新し、既存の AbsoluteRange End Group 超過検証 (§5.1.2) は維持する。
- 破壊的変更として `CHANGES.md` に `[UPDATE]` を記載する。

## 完了条件

- Location Filter の encode / decode が draft-20 §5.1.2 の Length ベースと round-trip すること。
- Length 0・1・2・3・4 フィールドの各ケースと不正 Length のテストがあること。
- `filter.ts` / SUBSCRIBE 送信経路 / 公開 API が新表現に追随していること。
- `FilterType` 定数と draft-19 専用ワイヤパスが残っていないこと。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-20 Appendix A.1 (#1809)
- 後続: `issues/0449-draft-20-change-fetch-to-location-filter-remove-joining.md`
- 後続: `issues/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
