# Range Filter の評価 (マッチング) ロジックが存在しない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/add-moqt-draft-19-range-filter-evaluation-logic
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.3 / §5.1.4 で定義される Range Filter の評価 (マッチング) ロジックを実装する。現在は Range Filter のワイヤエンコード / デコードのみが存在し、オブジェクトがフィルタ条件を満たすかの判定 (SetID ごとの AND / OR 結合) が実装されていない。

## 優先度根拠

§5.1.4 は「Pass = Forward AND Location Filters AND Range Filters」と定める。Range Filter 付きで SUBSCRIBE / FETCH を送っても、サブスクライバ側で通過判定を行う手段がなく、フィルタ機能として不完全。Medium。

## 現状

- `src/message/parameter.ts:1034-1143` に Range Filter の encode / decode (`encodeRangeFilter` / `decodeRangeFilter`) はある。
- フィルタ評価 (オブジェクトの Subgroup ID / Object ID / Priority / Property 値が Range に含まれるか、SetID ごとの AND / OR 結合) はリポジトリ内に一切存在しない。
- `src/filter.ts` は Location Filter のみ。`src/session/params.ts` は `getSetupMaxFilterRanges` (MAX_FILTER_RANGES) の取得のみ。

## 設計方針

- §5.1.3 に従い、同一 SetID のフィルタは AND、異なる SetID の結果は OR で結合する評価関数を実装する。
- 評価対象: Subgroup ID (SUBGROUP_FILTER)、Object ID (OBJECTID_FILTER)、Publisher Priority (PRIORITY_FILTER)、Object Property 値 (OBJECT_PROPERTY_FILTER)、Track Property 値 (TRACK_PROPERTY_FILTER)。
- Range の開始・終了の包含判定 (§5.1.3 の Range 構造、終端省略は open-ended) を実装する。
- 評価結果を Subscriber のオブジェクト受信経路 (`src/session/stream.ts` / `src/session/incoming.ts`) に適用する。

## 完了条件

- 各 Range Filter 種別の評価関数があり、SetID ごとの AND / OR 結合が正しく動作すること。
- 評価結果がオブジェクト受信経路で適用されること。
- §5.1.3 の例 (3-5 / 10-15 等) を再現するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §5.1.4 (Combining Filters)

## 解決方法

未着手。
