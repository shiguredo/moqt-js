# 境界値テストの未検証領域を埋める

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-boundary-tests
- Polished: YYYY-MM-DD

## 目的

値域外・不正形の入力挙動が pin されておらず、文書化された折り畳みやフォールバックの退行を検出できない。

## 現状

- LOC の値域外折り畳み (`temporalLayerId` / `spatialLayerId` のマスク) が PBT の arbitrary 制約で未テストである。
- moqlog の `pri` 値域・severity 短縮形、moqmetrics の `NaN` / `Infinity` 挙動が未テストである。
- `moqtUri` の IPv6 / userinfo / 不正ポート、`grease` の非整数入力、devtools params の `0x` / `Infinity` / 指数表記、log 表示の underscore なし大文字が未定義である。
- `frameSource` フォールバック経路は可用性判定の 1 件のみである (実ブラウザ基盤が必要な範囲は方針決定を含む)。

## 設計方針

1. 上記を単体テストまたは PBT で pin する (実行基盤の制約があるものは方針を明記)。
2. 仕様・ヘルパーの想定動作とテストを対応させる。

## 完了条件

- 上記領域の挙動がテストで pin されること (基盤制約分は方針が決まること)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
