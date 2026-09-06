# devtools Publisher が h264 / h265 選択時に Catalog へ av1 と誤記する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-catalog-codec
- Polished: YYYY-MM-DD

## 目的

h264 で publish するとワイヤは `avc1` なのに Catalog が `av1` となり、Subscriber が誤ったデコーダを構築して復号に失敗する。Catalog 生成をエンコーダ設定と一致させる必要がある。

## 現状

- `devtools/src/hooks/usePublisher.ts` の Catalog 生成は `vp8` / `vp9` 以外を `av01.0.04M.08` に潰す。
- `devtools/src/utils/codec.ts` は `h264` → `avc1.42001f` (`annexb`)、`h265` → `hvc1.1.6.L93.B0` を返す。
- UI の codec 選択肢は h264 / h265 を含む。

## 設計方針

1. Catalog の codec 文字列を `codec.ts` の解決結果と一致させる (共通ヘルパー化)。
2. h264 / h265 の publish / subscribe 疎通を確認する。

## 完了条件

- h264 / h265 選択時に正しい codec で Catalog が生成されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
