# 展開後の payload のサイズを制限する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-29 の残りを実装する。§13.7 は、実装が入力 (特に展開後の payload) のサイズを制限して resource exhaustion を防ぐことを MUST とする。GZIP の展開は圧縮比が大きく、小さな入力から巨大な出力を作れるため、上限が無いとメモリを消費し続ける。

## 現状

- `decompressGzip` は `DecompressionStream` の出力を最後まで読み切ってから返すため、展開後のサイズに上限が無い
- `decompressPayload` / `decompressObjectPayload` も同じ経路を通る
- 参照カタログの循環検出と深さ上限は `0995` で実装済み

## 設計方針

- 展開の出力を chunk ごとに読み、合計が上限を超えた時点で読み出しを打ち切って Error にする
- 既定の上限を `DEFAULT_MAX_DECOMPRESSED_BYTES` (16 MiB) として export し、呼び出し側が変更できるようにする
- 上限超過は「展開の失敗」ではないため、圧縮データの破損を表すエラーに包み直さない

## 完了条件

- 上限を超える payload の展開が Error になる (`per §13.7` を含む文言)
- 上限以内の payload は展開できる
- 既定値を公開 API から参照できる

## 解決方法

{未着手}

## 解決方法

- `src/msf/compression.ts` の展開を chunk 単位の読み出しに変え、合計が上限を超えた時点で読み出しを打ち切って Error にした (§13.7)
- 既定値を `DEFAULT_MAX_DECOMPRESSED_BYTES` (16 MiB) として export し、`decompressGzip` / `decompressPayload` / `decompressObjectPayload` の引数で変更できるようにした
- 上限超過は圧縮データの破損ではないため、`decompressGzip` のエラー包み直しから除外した
- 上限超過の拒否と上限以内の展開を単体テストで固定した
