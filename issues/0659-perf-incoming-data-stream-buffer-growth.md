# 受信バッファの再確保がチャンク数に対して二次のコストになっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-incoming-data-stream-buffer-growth
- Polished: 2026-11-14

## 目的

チャンクを受信するたびに累積バッファ全体をコピーし直しており、1 つの Object が多数のチャンクに分割されて届くと処理時間がチャンク数に対して二次に増える。大容量 Object (映像フレームなど) を小さいチャンクで受けるほど劣化する。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamAppendChunk` は、読み取りループがチャンクを受け取るたびに `new Uint8Array(buffer.length + chunk.length)` を作り、未消費の累積バッファと新しいチャンクの両方をコピーする。この関数は Subgroup (`dataStreamHandleSubgroupStream`) / fill fetch (`dataStreamHandleFillFetchStream`) / 通常 FETCH (`dataStreamHandleIncomingStream` の fetcher 確定後の読み取りループ) の 3 経路から呼ばれる
- `src/session/stream.ts` の `processSubgroupObjects` / `processFetchObjects` は戻り値で `remainingBuffer: buffer.slice(offset)` を返し、未完成 Object の累積バッファをもう一度複製する。受信ループは `src/session/incoming.ts` の `incomingProcessSubgroupObjects` / `incomingProcessFetchObjects` を経由してこれらを呼ぶ
- 未完成のチャンクが届くたびに、コピーと先頭からのパースやり直しが発生する。コピー量は Object 長 P とチャンク長 C に対して P × ceil(P/C) のオーダーになる
- §12.5 (EXCESSIVE_LOAD) のセッション合計 (`dataStreamBufferedBytesTotal`) は `dataStreamBufferBytesAdd` / `dataStreamBufferBytesRelease` で増減し、`dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` の上限判定と `dataStreamCreateDataStreamTimeout` の期限は、いずれも `buffer.byteLength` (未消費の累積バッファ長) を基準にしている
- 測定 (Apple M4 Pro / Node.js v26.4.0。リポジトリの esbuild でバンドルしたドライバから実 `processSubgroupObjects` を呼び、読み取りループと同じ連結式でチャンクを与えた。ウォームアップ後の中央値)
  - 4 MiB の Object を 16 KiB ずつ: 24.7 ms
  - 4 MiB の Object を分割なし: 0.40 ms
  - 1 MiB を 16 KiB ずつ: 1.27 ms
  - 16 MiB を 16 KiB ずつ: 1080 ms
  - 4 MiB を 64 KiB ずつ: 6.76 ms
  - 理論コピー量 P × (ceil(P/C) - 1) の増加に伴って実測時間も増える (16 MiB では単純比例より大きく伸びる)

## 設計方針

- 容量を倍々で伸ばす書き込みバッファ (有効データ長は書き込み位置) と読み出し位置に変え、チャンク到着ごとの全コピーをやめる (Subgroup / fill fetch / 通常 FETCH の 3 経路)
- 読み出し位置が進んだ分は未消費の残りを先頭へ詰めて容量を再利用し、ストリームの総受信量に比例してメモリが増えないようにする。容量の余剰分は §12.5 の計上に含めない (実際のメモリは、そのストリームで必要になった最大の未消費長の 2 倍程度を上限にする)
- `slice` による残バッファ複製を無くし、Object 完成時に 1 回だけ payload を切り出す。ヘッダー解析後の残バッファも `slice` せず、バッファと offset を引き継ぐ
- パースの再開位置を offset で保持するため、`processSubgroupObjects` / `processFetchObjects` に有効データ長 (書き込み位置) と読み出し位置を渡し、新しい読み出し位置を返す契約に見直す。`previousObjectId` / `resolvedSubgroupId` / `context` / `isFirst` などの状態は現行どおり引き継ぐ。ラッパー (`incomingProcessSubgroupObjects` / `incomingProcessFetchObjects`) と直接呼び出しのテストも追随する
- §12.5 (EXCESSIVE_LOAD) のセッション合計の増減は、現行の `dataStreamBufferBytesAdd` / `dataStreamBufferBytesRelease` の呼び出し位置を維持する。バッファの容量 (capacity) ではなく未消費バイト数 (書き込み位置 - 読み出し位置) を計上し、上限判定、タイムアウトの arm/clear、ループの進捗判定、FIN 時の未完成 Object 判定など、`buffer.byteLength` / `buffer.length` を未消費長として使っているすべての箇所で同じ未消費長を使う
- `src/session.test.ts` に「1 MiB の Object を 16 KiB ずつ受信する」回帰テストを追加する。実受信経路 (`handleIncomingStream`) にチャンクを分割して enqueue し、`dataStreamAppendChunk` の追記と `processSubgroupObjects` の offset 契約の両方を通す

## 完了条件

- 現状の測定と同じ条件 (Apple M4 Pro / Node.js v26.4.0、リポジトリの esbuild でバンドルしたドライバ、ウォームアップ後の中央値) で、新しい追記方式を含めた 4 MiB / 16 KiB の受信が 1 ms 未満になる
- 追加した回帰テストと既存テストが通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed `issues/closed/0686-bug-session-wide-data-stream-buffer-cap.md` (セッション合計の上限と、offset 方式へ変更しても計上ヘルパーを維持する設計)
- `src/session/dataStreamIncoming.ts` の `dataStreamAppendChunk` / `dataStreamBufferBytesAdd` / `dataStreamBufferBytesRelease` / `dataStreamCreateDataStreamTimeout`

## 解決方法

{未着手}
