# Range Filter の Length が二重にエンコードされる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-range-filter-length-encoding
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.3 に基づき、Range Filter パラメータ（SUBGROUP_FILTER 0x25 / OBJECTID_FILTER 0x26 / PRIORITY_FILTER 0x27 / OBJECT_PROPERTY_FILTER 0x28 / TRACK_PROPERTY_FILTER 0x29）のワイヤエンコーディングを仕様どおりの「Length 1 つ」の構造に修正する。現在は Value 内部と外側の二重に Length がエンコードされ、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` が 0x25-0x29 を `"length-prefixed"` に分類している。このため `encodeMessageParameter()` が外側に Length フィールドを付加する。
- 一方 `encodeRangeFilter()` の出力（Value）は「Length + SetID + [Property Type] + Ranges」であり、内部にも Length を含む。
- 結果としてワイヤは「Type Delta + 外側 Length + 内側 Length + SetID + ...」の二重 Length になる。仕様 §5.1.3 の構造（`SUBGROUP_FILTER { Type=0x25, Length, [SetID], Range... }`）は Length 1 つが正しい。
- `REQUEST_UPDATE` での削除（Length=0）も「Type Delta + 0x01 + 0x00」になり、仕様の「Type Delta + 0x00」と不一致。
- 0x25-0x29 の各節（§10.2.10-10.2.14）には「uses length-prefixed encoding」の明記がなく（0x21 / 0x03 と対照的）、§10.2 は「the block is bounded by a parameter count rather than a length」と宣言している。
- `src/message/parameter.prop.ts` の PBT は `encodeRangeFilter()` → `decodeRangeFilter()` の自己整合 round-trip のみで、`encodeParameters()` 経由の実際のワイヤ形式を検証していないため欠陥を検出できていない。

## 設計方針

- 0x25-0x29 を `MESSAGE_PARAMETER_VALUE_ENCODING` の `"length-prefixed"` 分類から外し、`encodeRangeFilter()` の出力（Length 込み）をそのまま Value として書き込む。
- `encodeMessageParameter()` / `decodeMessageParameter()` の分岐を 0x25-0x29 で「Length 付き Value をそのまま」扱うよう調整する。
- 固定バイト列でワイヤ形式（Length が 1 つ、削除は Length=0）を検証するテストを追加する。

## 完了条件

- SUBSCRIBE / FETCH / SUBSCRIBE_TRACKS で送信する Range Filter のワイヤが「Type Delta + Length + SetID + [Property Type] + Ranges」の 1 Length 構造になる。
- `REQUEST_UPDATE` での Range Filter 削除が「Type Delta + 0x00」になる。
- 仕様準拠のワイヤバイト列（例: `0x25 0x03 0x01 0x03 0x02`）を正しくデコードできるテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §10.2 (Message Parameters)
- 関連: `0341-draft-19-add-range-filters.md`（導入時の issue。実装時に length-prefixed 分類と Value 内 Length の二重構造になった経緯がある）

## 解決方法

未着手。
