# 受信バッファの再確保がチャンク数に対して二次のコストになっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-incoming-data-stream-buffer-growth
- Polished: {YYYY-MM-DD}

## 目的

Object を受信するたびに累積バッファ全体をコピーし直しており、1 つの Object が多数のチャンクに分割されて届くと処理時間がチャンク数に対して二次に増える。大容量 Object (映像フレームなど) を小さいチャンクで受けるほど劣化する。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` は読み取りループで `new Uint8Array(buffer.byteLength + result.value.byteLength)` を作り、未消費の累積バッファと新しいチャンクの両方をコピーする。FETCH 側の `dataStreamHandleFillFetchStream` も同じ形である
- `src/session/stream.ts` の `processSubgroupObjects` / `processFetchObjects` は戻り値で `remainingBuffer: buffer.slice(offset)` を返し、未完成 Object の累積バッファをもう一度複製する
- 未完成のチャンクが届くたびに、コピーと先頭からのパースやり直しが発生する。コピー量は Object 長 P とチャンク長 C に対して P × ceil(P/C) のオーダーになる
- 測定 (Apple M4 Pro / Node.js v26.4.0。リポジトリの esbuild でバンドルしたドライバから実 `processSubgroupObjects` を呼び、読み取りループと同じ連結式でチャンクを与えた。ウォームアップ後の中央値)
  - 4 MiB の Object を 16 KiB ずつ: 24.7 ms
  - 4 MiB の Object を分割なし: 0.40 ms
  - 1 MiB を 16 KiB ずつ: 1.27 ms
  - 16 MiB を 16 KiB ずつ: 1080 ms
  - 4 MiB を 64 KiB ずつ: 6.76 ms
  - 理論コピー量 P × (ceil(P/C) - 1) と実測時間は比例する

## 設計方針

- 容量を倍々で伸ばす書き込みバッファと読み出し offset に変え、チャンク到着ごとの全コピーをやめる
- `slice` による残バッファ複製を無くし、Object 完成時に 1 回だけ payload を切り出す
- パースの再開位置を offset で保持するため、`processSubgroupObjects` / `processFetchObjects` の引数と戻り値の契約を見直す
- `src/session.test.ts` に「1 MiB の Object を 16 KiB ずつ受信する」回帰テストを追加する

## 完了条件

- 4 MiB / 16 KiB の受信が 1 ms 未満になる
- 既存テストが通る
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
