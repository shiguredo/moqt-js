# Range Filter の Length が二重にエンコードされる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-range-filter-length-encoding
- Polished: 2026-08-03

## 目的

draft-ietf-moq-transport-19 §5.1.3 に基づき、Range Filter パラメータ（SUBGROUP_FILTER 0x25 / OBJECTID_FILTER 0x26 / PRIORITY_FILTER 0x27 / OBJECT_PROPERTY_FILTER 0x28 / TRACK_PROPERTY_FILTER 0x29）のワイヤエンコーディングを仕様どおりの「Length 1 つ」の構造に修正する。現在は Value 内部と外側の二重に Length がエンコードされ、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` が 0x25-0x29 を `"length-prefixed"` に分類している。このため `encodeMessageParameter()` が外側に Length フィールドを付加する。
- 一方 `encodeRangeFilter()` の出力（Value）は「Length + SetID + [Property Type] + Ranges」であり、内部にも Length を含む。
- 結果としてワイヤは「Type Delta + 外側 Length + 内側 Length + SetID + ...」の二重 Length になる。仕様 §5.1.3 の構造（`SUBGROUP_FILTER { Type=0x25, Length, [SetID], Range... }`）は Length 1 つが正しい。受信側も現状の分岐では仕様ワイヤの Length を剥がした value を保持するため、将来 `decodeRangeFilter()` で解釈すると SetID を Length と誤読する（受信経路は現在 value を解釈しないため未顕在化）。
- `rangeFilters` オプションのワイヤへの載荷は SUBSCRIBE のみで、FETCH / SUBSCRIBE_TRACKS / REQUEST_UPDATE は API 型のみが存在し未配線（0341 の完了条件の一部が未達のまま）。配線した場合、削除（Length=0）は「Type Delta + 0x01 + 0x00」になり、仕様の「Type Delta + 0x00」と不一致になる。
- 0x25-0x29 の各節（§10.2.10-10.2.14）には「uses length-prefixed encoding」の明記がなく（0x21 / 0x03 と対照的）。決定的な根拠は §5.1.3 の構造図（Value 先頭の Length のみ）である。
- `src/message/parameter.prop.ts` の PBT は `encodeRangeFilter()` → `decodeRangeFilter()` の自己整合 round-trip のみで、`encodeParameters()` 経由の実際のワイヤ形式を検証していないため欠陥を検出できていない。

## 設計方針

- 0x25-0x29 を `MESSAGE_PARAMETER_VALUE_ENCODING` の `"length-prefixed"` 分類から外し、専用のエンコーディング種別（`"range-filter"` 等）を追加する。分類から外すだけでは `getMessageParameterValueEncoding()` が未知型の `ProtocolViolationError` を投げて decode が壊れるため、新種別の追加または専用分岐が必要。
- `encodeRangeFilter()` の出力（Length 込み）をそのまま Value として書き込む。`encodeMessageParameter()` は 0x25-0x29 の Value を外側 Length なしで書き込み、`decodeMessageParameter()` は 0x25-0x29 について先頭 Length varint を読んで消費バイト数を決め、Length 込みのバイト列を value として保持する（`decodeRangeFilter()` の入力形式に合わせる。Length を剥がすと SetID を Length と誤読する）。内部 Length が残りバイト数を超えないことの検証（不正ワイヤで長い slice を作らない）は新分岐でも行い、フレーミング破損は既存の length-prefixed 分岐と同じ `ProtocolViolationError` で扱う（フィルタ内容の不正は 0341 の `REQUEST_ERROR` / `INVALID_FILTER` 経路）。
- FETCH（standalone / Joining Fetch）・SUBSCRIBE_TRACKS・REQUEST_UPDATE への `rangeFilters` 配線（0341 の残余）を完了させる。`buildFetchParameters()` / `buildSubscribeTracksParameters()` / `bidiSendRequestUpdate()` / `bidiSendJoiningFetch()`（`JoiningFetchOptions` に `rangeFilters` を追加）に SUBSCRIBE と同様の載荷処理を追加する（REQUEST_UPDATE では `RangeFilterRemove` による Length=0 の削除がワイヤに載る。Length=0 の削除は仕様上 REQUEST_UPDATE のみのため、REQUEST_UPDATE 以外のメッセージで削除を指定した場合は throw する）。PUBLISH_OK の配線は対象外。送信前ガード（ピア `MAX_FILTER_RANGES` が 0 なら throw、Range 総数超過なら throw。0341 の完了条件）は全配線経路で適用する。TRACK_PROPERTY_FILTER (0x29) は仕様 §5.1.3 で SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ許可のため、SUBSCRIBE / FETCH / subscription の REQUEST_UPDATE に指定された場合は throw する（SUBSCRIBE_TRACKS 由来の REQUEST_UPDATE 経路は現状未実装のため、0x29 はどの送信経路でも許可しない。現状の `buildSubscribeParameters()` は無検証で載せており、§10.2.1 により対向が PROTOCOL_VIOLATION でセッションを閉じる実害がある）。
- 固定バイト列でワイヤ形式（Length が 1 つ、削除は Length=0）を検証するテストを追加する。エンコード側（`encodeParameters()` の出力）とデコード側（パラメータ単体のバイト列、count プレフィックスなし。削除の Length=0 ケースを含む）の両方を検証する。PBT の arbitrary に 0x25-0x29 を追加し、`encodeParameters()` → `decodeParameters()` 経由の round-trip で回帰を防ぐ（二重 Length 自体の検出は固定バイト列テストの役割）。PBT の arbitrary は `encodeRangeFilter()` の出力（内部 Length と整合したバイト列）で構築し、同型複数出現（複数 SetID）のケースも含める（生バイト列の任意生成は内部 Length 検証と衝突する）。

## 完了条件

- SUBSCRIBE / FETCH（standalone / Joining Fetch）・SUBSCRIBE_TRACKS・REQUEST_UPDATE で送信する Range Filter のワイヤが「Type Delta + Length + SetID + [Property Type] + Ranges」の 1 Length 構造になる（削除・置換は REQUEST_UPDATE のみ）。
- `REQUEST_UPDATE` での Range Filter 削除が「Type Delta + 0x00」になる。
- 仕様準拠のワイヤバイト列（例: `0x25 0x03 0x01 0x03 0x02` = Type Delta 0x25 / Length 3 / SetID 1 / Start delta 3 / End delta 2（Range {3, 5}））を正しくデコードできるテストがあること（パラメータ単体、count プレフィックスなし。単体デコード経路を用意する）。
- エンコード側が 1 Length 構造になることを固定バイト列で検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §10.2 (Message Parameters) / §10.2.1 (Message Parameter Scoping)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（導入時から 0x25-0x29 の `"length-prefixed"` 分類が計画されており、二重構造の起源。SUBSCRIBE 以外の配線は未完）

## 解決方法

未着手。
