# Range Filter の Length が二重にエンコードされる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-range-filter-length-encoding
- Polished: 2026-08-07

## 目的

draft-ietf-moq-transport-19 §5.1.3 に基づき、Range Filter パラメータ（SUBGROUP_FILTER 0x25 / OBJECTID_FILTER 0x26 / PRIORITY_FILTER 0x27 / OBJECT_PROPERTY_FILTER 0x28 / TRACK_PROPERTY_FILTER 0x29）のワイヤエンコーディングを仕様どおりの「Length 1 つ」の構造に修正する。現在は Value 内部と外側の二重に Length がエンコードされ、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` が 0x25-0x29 を `"length-prefixed"` に分類している。このため `encodeMessageParameter()` が外側に Length フィールドを付加する。
- 一方 `encodeRangeFilter()` の出力（Value）は「Length + SetID + [Property Type] + Ranges」であり、内部にも Length を含む。
- 結果としてワイヤは「Type Delta + 外側 Length + 内側 Length + SetID + ...」の二重 Length になる。仕様 §5.1.3 の構造（`SUBGROUP_FILTER { Type=0x25, Length, [SetID], Range... }`）は Length 1 つが正しい。受信側も現状の分岐では仕様ワイヤの Length を剥がした value を保持するため、将来 `decodeRangeFilter()` で解釈すると SetID を Length と誤読する（受信経路は現在 value を解釈しないため未顕在化）。
- `rangeFilters` オプションのワイヤへの載荷は SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE で実施済み（0400 で SUBSCRIBE_TRACKS / REQUEST_UPDATE に配線。ただし二重 Length のままワイヤに載っている）。FETCH（standalone / Joining Fetch）への配線と Range Filter の送信ガード（削除 throw / 0x29 throw / FETCH への MAX_FILTER_RANGES 適用）は別 issue 0393 で対応する（`FetchOptions.rangeFilters` は定義済みだが `buildFetchParameters()` が無視する。`JoiningFetchOptions` に `rangeFilters` がない）。REQUEST_UPDATE では削除（Length=0）が「Type Delta + 0x01 + 0x00」として既に送信されており、仕様の「Type Delta + 0x00」と不一致。
- 0x25-0x29 の各節（§10.2.10-10.2.14）には「uses length-prefixed encoding」の明記がなく（0x21 / 0x03 と対照的）。決定的な根拠は §5.1.3 の構造図（Value 先頭の Length のみ）である。
- `src/message/parameter.prop.ts` の PBT は `encodeRangeFilter()` → `decodeRangeFilter()` の自己整合 round-trip のみで、`encodeParameters()` 経由の実際のワイヤ形式を検証していないため欠陥を検出できていない。

## 設計方針

- 0x25-0x29 を `MESSAGE_PARAMETER_VALUE_ENCODING` の `"length-prefixed"` 分類から外し、専用のエンコーディング種別（`"range-filter"` 等）を追加する。分類から外すだけでは `getMessageParameterValueEncoding()` が未知型の `ProtocolViolationError` を投げて decode が壊れるため、新種別の追加または専用分岐が必要。
- `encodeRangeFilter()` の出力（Length 込み）をそのまま Value として書き込む。`encodeMessageParameter()` は 0x25-0x29 の Value を外側 Length なしで書き込み、`decodeMessageParameter()` は 0x25-0x29 について先頭 Length varint を読んで消費バイト数を決め、Length 込みのバイト列を value として保持する（`decodeRangeFilter()` の入力形式に合わせる。Length を剥がすと SetID を Length と誤読する）。新分岐では内部 Length が残りバイト数（data.length - 現在 offset）を超えないことを検証し、超過時は `ProtocolViolationError` で扱う（不正ワイヤで長い slice を作らない。これは新分岐固有の仕様であり、既存 length-prefixed 分岐の `MAX_KVP_VALUE_LENGTH` 上限チェックは新分岐でも維持する。フレーミング破損はセッション切断を伴う `ProtocolViolationError` で扱い、フィルタ内容の不正（値域・重複・Property Type 偶数）は 0380 のスコープとして本 issue では扱わない）。
- FETCH（standalone / Joining Fetch）への `rangeFilters` 配線と、Range Filter の送信ガード（REQUEST_UPDATE 以外での削除 throw / 0x29 スコープ制約 / FETCH への MAX_FILTER_RANGES 適用 / 0400 の既存テストのガード方針合わせ）は別 issue 0393 で対応する。本 issue ではエンコード修正に集中し、配線済み経路（SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE）のワイヤが 1 Length 構造になることを確認する（0400 の配線はエンコード修正により自動的に 1 Length 構造へ変わる）。
- 固定バイト列でワイヤ形式（Length が 1 つ、削除は Length=0）を検証するテストを追加する。エンコード側（`encodeParameters()` の出力）とデコード側（パラメータ単体のバイト列、count プレフィックスなし。`decodeMessageParameter()` は private のため、テスト用に公開する単体デコード関数または同等の経路を用意する。削除の Length=0 ケースを含む）の両方を検証する。PBT の arbitrary に 0x25-0x29 を追加し、`encodeParameters()` → `decodeParameters()` 経由の round-trip で回帰を防ぐ（二重 Length 自体の検出は固定バイト列テストの役割）。PBT の arbitrary は `encodeRangeFilter()` の出力（内部 Length と整合したバイト列）で構築し、同型複数出現（複数 SetID）のケースも含める（生バイト列の任意生成は内部 Length 検証と衝突する）。ただし `parameter.prop.ts` の `parametersArb` は同型の type 重複を除去しているため、0x25-0x29 については重複除去を行わないよう arbitrary を変更する（`decodeParameters()` の isRepeatable と同じ扱い）。

## 完了条件

- SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE（配線済み）で送信する Range Filter のワイヤが「Type Delta + Length + SetID + [Property Type] + Ranges」の 1 Length 構造になる（FETCH への配線は 0393 で対応）。
- `REQUEST_UPDATE` での Range Filter 削除が「Type Delta + 0x00」になる。
- 仕様準拠のワイヤバイト列（例: `0x25 0x03 0x01 0x03 0x02` = Type Delta 0x25 / Length 3 / SetID 1 / Start delta 3 / End delta 2（Range {3, 5}））を正しくデコードできるテストがあること（パラメータ単体、count プレフィックスなし。単体デコード経路を用意する）。
- エンコード側が 1 Length 構造になることを固定バイト列で検証するテストがあること。
- 内部 Length が残りバイト数を超える不正ワイヤをデコードすると `ProtocolViolationError` になるテストがあること。
- 0400 で追加された既存テスト（`bidiSendRequestUpdate` の 0x29 送信テスト `src/session/bidi.test.ts`、SUBSCRIBE_TRACKS の削除指定テスト `src/session/params.test.ts`、`buildRangeFilterParameters` の追加・削除混在テスト `src/session/params.test.ts` 等、0400 追加分の Range Filter 関連テストすべて）が、1 Length 構造への変更後も期待値どおり通ること（ガード方針（REQUEST_UPDATE 以外での削除 throw・0x29 スコープ制約）への書き換えは 0393 で対応）。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters)
- draft-ietf-moq-transport-19 §10.2 (Message Parameters) / §10.2.1 (Message Parameter Scoping)
- 関連: `issues/closed/0341-draft-19-add-range-filters.md`（導入時から 0x25-0x29 の `"length-prefixed"` 分類が計画されており、二重構造の起源。FETCH 配線と送信ガードは 0393 で対応）
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md`（SUBSCRIBE_TRACKS / REQUEST_UPDATE の配線を完了させた。二重 Length のまま配線されたため、本 issue のエンコード修正で 1 Length 構造に変わる）
- 関連: `0393-add-range-filters-fetch.md`（FETCH への配線と送信ガード群を扱う。実装順は先に本 issue）
- 関連: `0380-moqt-draft-19-range-filter-value-validation.md`（フィルタ内容の値域・重複・Property Type 偶数検証を扱う。本 issue では扱わない。SetID / Property Type / Range 列の欠落等の構造不正も 0380 のスコープに含める）
- 関連: `0385-moqt-draft-19-range-filter-evaluation-logic.md`（フィルタの評価ロジックを扱う。本 issue の修正後の value 形式（Length 込み）を前提とする）

## 解決方法

未着手。
