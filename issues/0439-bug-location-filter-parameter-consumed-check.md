# decodeLocationFilterParameter が宣言 Length に対する消費バイト数不一致を検出しない

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-location-filter-parameter-consumed-check
- Polished: 2026-09-05

## 目的

`decodeLocationFilterParameter()`（`src/message/parameter.ts`）は `decodeLocationFilter()` の返り値から `filter` のみ採用し、消費バイト数 `consumed` を `param.value.length`（length-prefixed パラメータの宣言 Length）と突き合わせていない。Location Filter 構造が宣言 Length より短い場合に末尾残余バイトを黙って受理しており、同種の境界検証（制御メッセージのデコード消費バイト数と Body 長の不一致検出、Full Track Name の長さ検証など）を整備してきたリポジトリの方針から取りこぼしている。

## 現状

- `decodeLocationFilterParameter()` は `const [filter] = decodeLocationFilter(param.value, 0);` で `consumed` を破棄している。
- 受信側の self-length-prefixed パラメータ (0x21) は `decodeMessageParameter()`（`src/message/parameter.ts`）が Value 内側 Length ちょうどにスライスした `value` を作るため、`consumed < param.value.length`（末尾残余）は検出されず、`consumed > length` はバッファ境界で `IncompleteDataError` になることのみが結果的に発生する。
- 同種の不整合検証の先例: 制御メッセージペイロードでは Body 長と消費バイト数の不一致を `ProtocolViolationError` で検出済み（`CHANGES.md` の「制御メッセージのデコード消費バイト数と Body 長の不一致を検出する」）。内側 `Length` に対するフィールド境界の厳密化は Range (`decodeRangeFilter` の `bodyEnd`) / Location (`decodeLocationFilter` の `current !== end`) ともに済みだが、外側 `param.value.length` との突き合わせは個別デコード wrapper に共通して未整備であり、本 issue の対象は `decodeLocationFilterParameter` に限定する。
- draft-20 §1.4.3 / §5.1.2 / §10.2 / §10.2.9 のいずれにも Length 内余剰バイトの明示規定はない (許可文も禁止文もない)。残余拒否は仕様の直接要請ではなく、制御メッセージ境界検証を整備してきたリポジトリ方針に基づく堅牢性修正である。

## 設計方針

- `decodeLocationFilterParameter()` で `decodeLocationFilter()` の `consumed` を受け取り、`consumed !== param.value.length` の場合は `ProtocolViolationError` を throw する (仕様は本ケースのエラーコードを規定しないため、リポジトリ方針として `ProtocolViolationError` → PROTOCOL_VIOLATION の既存変換規則に乗せる。送信側生成では `encodeLocationFilter()` の出力 (= 内側 `Length` + ペイロード) そのままが `param.value` になるため発火しない)。
- 検証は内側 `Length` しか知らない `decodeLocationFilter()` 本体ではなく、パラメータ境界 (`param.value.length`) を知る `decodeLocationFilterParameter()` に持たせる。
- `src/message/parameterScope.ts` や `src/message/index.ts` の export 形状は変更しない。

## 完了条件

- `param.value` が Location Filter 構造より長い（末尾残余バイトあり）場合、`decodeLocationFilterParameter()` が `ProtocolViolationError` を throw すること（単体テスト: 正常エンコード + 残余 1 バイト付き param を構成する）。
- ちょうど一致する通常ケースは従来どおり受理されること（既存の round-trip テストと PBT が通ること）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §1.4.3 (Key-Value-Pair Structure、補助)
- draft-ietf-moq-transport-20 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-20 §10.2.9 (LOCATION FILTER Parameter)
- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md`（旧 AbsoluteRange 時代の値域検証。本 issue は構造長の検証）

## 解決方法

- `decodeLocationFilterParameter()` で `decodeLocationFilter()` の返り値から `consumed` を受け取り、`consumed !== param.value.length` の場合に `ProtocolViolationError` を throw するようにした。短い value は従来どおり `IncompleteDataError` のまま伝搬する。
- テストは `src/message/parameter.test.ts` に 4 件追加した (末尾残余拒否 2 件・一致時受理・短縮時素通し)。
- 触ったファイル: `src/message/parameter.ts`、`src/message/parameter.test.ts`、`CHANGES.md`。
