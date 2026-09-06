# devtools の重複とデバッグ残留を整理する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-devtools-cleanup
- Polished: YYYY-MM-DD

## 目的

表示・複写・証明書処理の重複と製品コードの大量 `console.log` が残り、修正漏れと騒音の原因になる。整理する必要がある。

## 現状

- `formatBytes` / `formatBitrate` が 4 箇所に並立し丸めが微差である。
- `EncoderWrapper` / `DecoderWrapper` のライフサイクル、`handleDebugMessage` の複写、`useCopyFeedback` と examples のクリップボード・URL 処理、証明書 base64 デコード (挙動も不統一) が重複する。
- `usePublisher` にデバッグ `console.log` が 20 件超残る。
- `devtools/src/utils/codec.ts` の `getDecoderConfig` が未使用で残る (`devtools/main.ts` に同名ローカル版があり定義重複)。
- `parseResolution` が無検証で `NaN` を流し、接続設定の検証が `connect` まで遅延する。

## 設計方針

1. 重複を正本へ一本化し、死にコードを削除する。
2. 情報ログは DebugPanel 経路に寄せ、`console.log` を除去する。
3. 入力検証を UI 側に寄せる。

## 完了条件

- 重複・死にコード・デバッグログが除去されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
