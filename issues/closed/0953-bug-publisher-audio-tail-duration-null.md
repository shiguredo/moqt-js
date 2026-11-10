# 符号化出力の duration が null のとき、末尾 flush の統計が送った音を送れなかったと数える

- Created: 2026-11-10
- Completed: 2026-11-10
- Branch: feature/fix-publisher-audio-tail-duration-null
- Polished: 2026-11-10

## 目的

`AudioEncoder` の出力 chunk の `duration` が `null` の場合、`src/createMediaPublisher.ts` は末尾 drain の統計で長さを 0 として扱う。その結果、実際に送った音まで `tailDroppedMs` に数えられ、`tailFlushedMs` が実態より小さくなる。chunk が覆った範囲を `AudioPublishCatchUp` から受け取り、統計を正しく出す。

## 現状

- `handleAudioEncodedChunk` は `this.audioCatchUp.recordEncodedChunk({ timestampMicros, durationMicros: chunk.duration, nowMs })` を呼び、戻り値の `timestampMicros` / `generation` で送信の可否を決める
- 末尾 drain 中は `tail.sentMs += (chunk.duration ?? 0) / 1_000`、`sentEndMicros = timestampMicros + (chunk.duration ?? 0)` を計算し、`sendAudioFrameFireAndForget` へ `durationMs: (chunk.duration ?? 0) / 1_000` を渡す
- `commitAudioTailStats` は `sentEndMicros` と `readBlocks` の差で `tailDroppedMs` を求め、`tailFlushedMs` に `sentMs` を足す。`chunk.duration` が `null` だと `sentEndMicros` が最後に送った chunk の先頭のままになり、送った音の範囲が読み出した範囲より短く見えるため、送れた分が `tailDroppedMs` に入る
- `AudioPublishCatchUp.recordEncodedChunk` は `durationMicros` が `null` のとき「先頭の記録 1 つ分を覆う」とみなして投入を消費するが、覆った範囲を返していない。`PendingFrame` は `timestampMicros` / `generation` / `readAtMs` / `durationMs` を持ち、1 つの投入が 2 つの出力にまたがる場合は `timestampMicros` を残したまま `durationMs` だけを残りに縮める。そのため、部分消費のあとは `timestampMicros + durationMs` が投入の末尾を表さない
- 音声の符号化出力の `duration` は入力 `AudioData` の duration を写す (W3C WebCodecs Working Draft 2026-11-09 の 5.6 Algorithms)。`AudioData.duration` は `numberOfFrames / sampleRate × 1,000,000` で求まる非 null の値 (同 9.2.3 Attributes) であるため実運用では `null` にならないが、`EncodedAudioChunk.duration` 自体は nullable であり、`AudioEncoder` の実装が `null` を返す場合に統計が壊れる
- `src/audioPublishCatchUp.test.ts` の「フレームの長さが分からなくても直前のフレームと同じ長さで扱う」のコメントは「`AudioData.duration` は null になりうる」と書いているが、仕様上は null にならない。`AudioPublishCatchUpFrameInput.durationMicros` が呼び出し側の都合で null になる場合の話である
- `src/codec/types.ts` と `docs/HIGH_LEVEL_API.md` の `AudioStats.tailFlushedMs` は「長さは chunk の duration の合計」と定義している

## 設計方針

- `AudioPublishCatchUpChunkResult` に、この chunk が覆った範囲を表す `coveredStartMicros` / `coveredEndMicros` (`number | null`) を足す
  - 対応づけられないとき (消費できる投入が無い) は両方 `null` で、既存の `timestampMicros` / `generation` も `null` のまま返す
  - 対応づけられたときは、消費した範囲の開始と末尾を返す。`timestampMicros` は既存の意味 (対応づけた最初の投入の timestamp) のまま変えない
- `PendingFrame` に `startMicros` と `endMicros` を足す。`startMicros` は残りの先頭、`endMicros` は投入の末尾 (部分消費しても変えない)。`recordEncodedChunk` の消費ループの前に退避した `startMicros` を `coveredStartMicros` に、消費し終えた位置を `coveredEndMicros` にする
  - `durationMicros` が非 null のときは、`durationMicros` の分だけ投入を消費するため、1 つの出力が複数の投入を覆う場合 (10 ms の `AudioData` を 2 つ読んで 20 ms の opus packet が出る) も消費した範囲の先頭から末尾までを返せる
  - `durationMicros` が `null` のときは既存の規則 (先頭の記録 1 つ分を消費する) を変えない。したがって null の chunk が複数の投入を覆う場合は、覆った範囲の一部しか特定できない (下の「対象外」)
- `handleAudioEncodedChunk` は、`chunk.duration` が `null` のときだけ `coveredStartMicros` / `coveredEndMicros` から長さと末尾を求める
  - `coveredEndMicros - coveredStartMicros` を `tail.sentMs` に足す
  - `tail.sentEndMicros` は `coveredEndMicros` で更新する
  - `sendAudioFrameFireAndForget` へ渡す `durationMs` も `(coveredEndMicros - coveredStartMicros) / 1_000` にする
  - `chunk.duration` が非 null のときは既存の計算を変えない (既存の回帰を避ける)
- `coveredStartMicros` / `coveredEndMicros` が `null` のときは、`timestampMicros` が `null` になっているため既存の早期 return で統計を更新しない。型を絞るために `coveredStartMicros === null || coveredEndMicros === null` の早期 return も足し、非 null アサーション (`!`) も `?? 0` も使わない
- `src/codec/types.ts` の `AudioStats.tailFlushedMs` のコメント、`src/createMediaPublisher.ts` の `AudioTailDrainState.sentMs` のコメント、`docs/HIGH_LEVEL_API.md` の `tailFlushedMs` の説明を「chunk の duration の合計 (null のときは chunk が覆った投入の長さ)」に更新する
- `src/audioPublishCatchUp.test.ts` の「`AudioData.duration` は null になりうる」というコメントを、仕様に合わせて「呼び出し側が長さを渡さない場合がある」に直す

### 対象外

- `AudioPublishCatchUp.durationMs()` (入力フレームの長さが分からないときに直前のフレームの長さで代用する処理) は既存のまま
- `chunk.duration` が非 null の場合の末尾の計算 (既存の `timestampMicros + chunk.duration`)。部分消費のあとの投入では末尾が手前に見える既存の近似が残るが、この issue では null の経路だけを直す
- `chunk.duration` が null で、1 つの出力が複数の投入を覆う場合。既存の消費規則が先頭の記録 1 つ分しか消費しないため、覆った範囲の残りは特定できない。実際の音声は 10 ms の `AudioData` から 20 ms の opus packet を作るため、この構成では null の chunk の長さを 10 ms と過小に見積もる。消費規則そのものを変える設計はこの issue の範囲を超えるため、対象外とする
- 映像の符号化出力の `duration` の扱い

## 完了条件

- `chunk.duration` が `null` でも、末尾 drain の `tailFlushedMs` が chunk の覆った範囲の長さになり、送れた分が `tailDroppedMs` に数えられないこと
- `src/createMediaPublisher.test.ts` に、`duration` が `null` の chunk を末尾 drain で送ったときの統計を固定するテストがあること。1 出力 = 1 投入 (10 ms の投入に対して 10 ms の chunk) の構成で、修正前は `tailDroppedMs` が 0 より大きく、修正後は `tailFlushedMs` が送った長さの合計になり `tailDroppedMs` が 0 になること
- `src/createMediaPublisher.test.ts` に、`duration` が非 null で 1 つの出力が複数の投入を覆う構成 (10 ms の投入 2 つに対して 20 ms の chunk) の統計が変わらないことを固定するテストがあること
- `src/audioPublishCatchUp.test.ts` に、`durationMicros` が `null` のとき `coveredStartMicros` / `coveredEndMicros` が消費した投入の範囲になることを固定するテストがあること。部分消費のあとの出力でも、開始が残りの先頭になること
- `src/codec/types.ts`、`src/createMediaPublisher.ts` の `AudioTailDrainState.sentMs`、`docs/HIGH_LEVEL_API.md` の `tailFlushedMs` の説明が実装と一致していること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

符号化出力の `duration` が `null` のとき、末尾 drain の統計が送った音を送れなかったと数えないようにした。

- `src/audioPublishCatchUp.ts` の `PendingFrame` に `startMicros` (残りの先頭) と `endMicros` (投入の末尾) を足した。部分消費では `startMicros` を進め、`endMicros` は変えない
- `AudioPublishCatchUpChunkResult` に `coveredStartMicros` / `coveredEndMicros` を足し、`recordEncodedChunk` が消費した範囲の開始と末尾を返すようにした。1 つの出力が複数の投入を覆う場合も、消費した投入の先頭から末尾までを返す
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk` は、`chunk.duration` が `null` のとき `coveredEndMicros - coveredStartMicros` を長さに、`coveredEndMicros` を末尾に使う。`duration` が非 null のときは既存の計算を変えていない。`sendAudioFrameFireAndForget` へ渡す `durationMs` も同じ長さにした
- `coveredStartMicros` / `coveredEndMicros` が `null` のときは早期 return し、非 null アサーションも `?? 0` も使わない
- `src/codec/types.ts` の `AudioStats.tailFlushedMs`、`src/createMediaPublisher.ts` の `AudioTailDrainState.sentMs`、`docs/HIGH_LEVEL_API.md` の説明を、duration が null のときは覆った投入の長さを使う旨に更新した
- `src/audioPublishCatchUp.test.ts` の「`AudioData.duration` は null になりうる」というコメントを、呼び出し側が長さを渡さない場合がある旨に直した
- テストを追加した
  - `src/audioPublishCatchUp.test.ts` に、1 出力 = 1 投入、部分消費のあとの 2 回目の出力、1 出力 = 複数投入の 3 つで `coveredStartMicros` / `coveredEndMicros` を固定するテスト
  - `src/createMediaPublisher.test.ts` に、`duration` が `null` の chunk を末尾 drain で送ったとき `tailFlushedMs` が 40 ms、`tailDroppedMs` が 0 になるテスト。`duration` が 0 として扱われる実装に戻すと `tailFlushedMs` が 0、`tailDroppedMs` が 10 ms になって失敗することを確認した
  - `duration` が非 null で 1 出力が複数投入を覆う構成は、既存のテスト (2 つの 10 ms ブロックを 20 ms の chunk で送る) が変わらず通ることで確認した
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` / `vp test run` (277 ファイル、5079 テスト) が通る

`chunk.duration` が null で 1 つの出力が複数の投入を覆う構成は、既存の消費規則が先頭の記録 1 つ分しか消費しないため対象外のままである。

`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk` / `commitAudioTailStats` / `AudioTailDrainState` / `sendAudioFrameFireAndForget`
- `src/audioPublishCatchUp.ts` の `AudioPublishCatchUpChunkResult` / `AudioPublishCatchUpChunkInput` / `recordEncodedChunk` / `PendingFrame` / `durationMs`
- `src/createMediaPublisher.test.ts` の末尾 drain のテスト、`src/audioPublishCatchUp.test.ts` の消費規則のテスト
- `src/codec/types.ts` の `AudioStats`、`docs/HIGH_LEVEL_API.md` の `AudioStats`
- W3C WebCodecs (Working Draft 2026-11-09) の 5.6 Algorithms (Output EncodedAudioChunks) / 9.2.3 Attributes (AudioData.duration)
