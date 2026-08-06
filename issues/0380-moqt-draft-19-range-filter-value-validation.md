# Range Filter の値域検証 (INVALID_FILTER) が未実装

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-range-filter-value-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.3 / §10.2.12-14 の MUST 要件を満たす。PRIORITY_FILTER の値域 (255 超)、OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER の Property Type 偶数、SetID / Property Type 組み合わせの重複を検証し、違反時は REQUEST_ERROR (INVALID_FILTER) で応答する。現在は encode / decode とも検証がない。

## 優先度根拠

§10.2.12 は「If a decoded value exceeds 255, the endpoint MUST reject this with REQUEST_ERROR with error code INVALID_FILTER」、§10.2.13-14 は Property Type が偶数でない場合に同様の拒否を要求する。また §5.1.3 は「If the same combination of Parameter Type, SetID, and Property Type repeat in any message, an endpoint MUST reject this with REQUEST_ERROR with error code INVALID_FILTER.」を定める。すべて未実装。Medium。

## 現状

- `src/message/parameter.ts:1095-1155` (`decodeRangeFilter`) は PRIORITY_FILTER の値域チェック、Property Type の偶数チェック、SetID / PropertyType 組み合わせ重複チェックをいずれも行わない。
- `src/message/parameter.ts:1037-1088` (`encodeRangeFilter`) も propertyType の偶数検証なし。
- `src/message/parameter.ts:823-838` (`decodeParameters`) は 0x25-0x29 を全メッセージで一律「繰り返し可」として重複検出から除外しているが、§5.1.3 ではメッセージ種別ごとに繰り返し可否が異なる (0x29 は SUBSCRIBE_TRACKS とその REQUEST_UPDATE のみ)。

## 設計方針

- `decodeRangeFilter` に値域検証 (priority 255 超、propertyType 偶数、delta 2^64-1 超過) を追加する。
- `decodeParameters` の重複検出をメッセージ種別ごとの繰り返し可否規則に合わせる。
- 受信パスで検証違反を検出した場合、REQUEST_ERROR (INVALID_FILTER) で応答する経路を実装する。
- encode 側にも propertyType 偶数検証を追加する。

## 完了条件

- PRIORITY_FILTER で 255 超の値を受信した場合に INVALID_FILTER で拒否されること。
- OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER で奇数の Property Type を受信した場合に INVALID_FILTER で拒否されること。
- 同じ組み合わせ (Parameter Type / SetID / Property Type) の重複がメッセージ種別ごとの規則に従って検出されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §10.2.12 (PRIORITY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.13 (OBJECT PROPERTY FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.14 (TRACK PROPERTY FILTER Parameter)

## 解決方法

未着手。
