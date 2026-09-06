# devtools Publisher が h264 / h265 選択時に Catalog へ av1 用 codec 文字列を誤記する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-catalog-codec
- Polished: 2026-09-06

## 目的

h264 で publish するとエンコーダ設定は `avc1.42001f` なのに Catalog が `av01.0.04M.08` となり (h265 では設定 `hvc1.1.6.L93.B0` に対して Catalog が `av01.0.04M.08`)、Subscriber が Catalog の `codec` を `VideoDecoderConfig.codec` に直結するため (`useSubscriber` の `buildVideoDecoderConfig`) 誤ったデコーダを構築して復号に失敗する。Catalog 生成をエンコーダ設定と一致させる必要がある。

## 現状

- `devtools/src/hooks/usePublisher.ts` の Catalog 生成は `vp8` / `vp9` 以外を `av01.0.04M.08` に潰す。
- `devtools/src/utils/codec.ts` は `h264` → `avc1.42001f` (`annexb`)、`h265` → `hvc1.1.6.L93.B0` を返す。
- UI の codec 選択肢は h264 / h265 を含む。

## 設計方針

1. `devtools/src/utils/codec.ts` に codec 文字列のみ返すヘルパー (例: `getCatalogCodec`) を新設し、Catalog 生成で使う。対応表は `getEncoderConfig` と同一にする。
2. h264 / h265 の publish / subscribe 疎通を手動確認する (自動テストは `0513` に委ねる)。

## 完了条件

- h264 選択時に Catalog の `codec` が `avc1.42001f`、h265 選択時に `hvc1.1.6.L93.B0` になること (完全一致)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
