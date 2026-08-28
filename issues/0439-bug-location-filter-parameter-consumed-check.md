# decodeLocationFilterParameter が宣言 Length に対する消費バイト数不一致を検出しない

- Created: 2026-08-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-location-filter-parameter-consumed-check
- Polished: {YYYY-MM-DD}

## 目的

`decodeLocationFilterParameter()`（`src/message/parameter.ts`）は `decodeLocationFilter()` の返り値から `filter` のみ採用し、消費バイト数 `consumed` を `param.value.length`（length-prefixed パラメータの宣言 Length）と突き合わせていない。Location Filter 構造が宣言 Length より短い場合に末尾残余バイトを黙って受理しており、同種の境界検証（制御メッセージのデコード消費バイト数と Body 長の不一致検出、Full Track Name の長さ検証など）を整備してきたリポジトリの方針から取りこぼしている。

## 現状

- `decodeLocationFilterParameter()` は `const [filter] = decodeLocationFilter(param.value, 0);` で `consumed` を破棄している。
- 受信側の length-prefixed パラメータは `decodeMessageParameter()`（`src/message/parameter.ts`）が宣言 Length ちょうどにスライスした `value` を作るため、`consumed < param.value.length`（末尾残余）は検出されず、`consumed > length` はバッファ境界で `IncompleteDataError` になることのみが結果的に発生する。
- 同種の不整合検証の先例: 制御メッセージペイロードでは Body 長と消費バイト数の不一致を `ProtocolViolationError` で検出済み（`CHANGES.md` の「制御メッセージのデコード消費バイト数と Body 長の不一致を検出する」）。パラメータ値内部では Range Filter が `decodeRangeFilter()` で宣言 Length を厳密に境界 (`pos < bodyEnd`) として扱い、Location Filter だけが未検証である。
- draft-19 は Key-Value-Pair の Length 内剩余バイトの扱いを明示的に許可しておらず、構造より長い Length はエンコーダの実装ミスまたは不正データである。

## 設計方針

- `decodeLocationFilterParameter()` で `decodeLocationFilter()` の `consumed` を受け取り、`consumed !== param.value.length` の場合は `ProtocolViolationError` を throw する（受信データの構造不整合は `ProtocolViolationError` → PROTOCOL_VIOLATION の既存変換規則に乗せる。送信側生成では `encodeLocationFilter()` の出力長と宣言 Length が一致するため発火しない）。
- 検証は `decodeLocationFilter()` 本体ではなくパラメータ境界を知る `decodeLocationFilterParameter()` に持たせる（`decodeLocationFilter()` は Length の概念なしにストリームから読むため消費数を返す設計のまま変更しない）。
- `src/message/parameterScope.ts` や `src/message/index.ts` の export 形状は変更しない。

## 完了条件

- `param.value` が Location Filter 構造より長い（末尾残余バイトあり）場合、`decodeLocationFilterParameter()` が `ProtocolViolationError` を throw すること（単体テスト: 正常エンコード + 残余 1 バイト付き param を構成する）。
- ちょうど一致する通常ケースは従来どおり受理されること（既存の round-trip テストと PBT が通ること）。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-19 §10.2.9 (LOCATION FILTER Parameter)
- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md`（同一関数の値域検証。本 issue は構造長の検証）

## 解決方法

未着手。
