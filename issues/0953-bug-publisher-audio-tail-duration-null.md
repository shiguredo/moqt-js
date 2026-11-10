# 符号化出力の duration が null のとき、末尾 flush の統計が送った音を送れなかったと数える

- Created: 2026-11-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-audio-tail-duration-null
- Polished: {YYYY-MM-DD}

## 目的

`AudioEncoder` の出力 chunk の `duration` が `null` の場合、`src/createMediaPublisher.ts` は末尾 drain の統計で長さを 0 として扱う。その結果、実際に送った音まで `tailDroppedMs` に数えられ、`tailFlushedMs` が実態より小さくなる。chunk が覆った長さを `AudioPublishCatchUp` から受け取り、統計を正しく出す。

## 現状

- `handleAudioEncodedChunk` は `this.audioCatchUp.recordEncodedChunk({ timestampMicros, durationMicros: chunk.duration, nowMs })` を呼び、戻り値の `timestampMicros` / `generation` で送信の可否を決める
- 末尾 drain 中は `tail.sentMs += (chunk.duration ?? 0) / 1_000`、`sentEndMicros = timestampMicros + (chunk.duration ?? 0)` を計算し、`sendAudioFrameFireAndForget` へ `durationMs: (chunk.duration ?? 0) / 1_000` を渡す
- `commitAudioTailStats` は `sentEndMicros` と `readBlocks` の差で `tailDroppedMs` を求め、`tailFlushedMs` に `sentMs` を足す。`chunk.duration` が `null` だと `sentEndMicros` が chunk の先頭のままになり、送った音の範囲が読み出した範囲より短く見えるため、送れた分が `tailDroppedMs` に入る
- `AudioPublishCatchUp.recordEncodedChunk` は `durationMicros` が `null` のとき「先頭の記録 1 つ分を覆う」とみなして投入を消費するが、覆った長さを返していない
- 音声の符号化出力の `duration` は入力 `AudioData` の duration を写す (W3C WebCodecs 5.6 Algorithms)。`AudioData.duration` は常に数値であるため実運用では `null` にならないが、`AudioEncoder` の実装が `null` を返す場合に統計が壊れる

## 設計方針

- `AudioPublishCatchUpChunkResult` に `coveredMicros: number | null` を足し、`recordEncodedChunk` が「この chunk が覆った投入の長さ」を返す。`durationMicros` が `null` のときは消費した投入の長さ (先頭の記録 1 つ分) を返し、対応づけられないときは `null` を返す
- `handleAudioEncodedChunk` は `chunk.duration ?? coveredMicros` を統計 (`sentMs` / `sentEndMicros` / `durationMs`) に使う。`timestampMicros` が `null` の早期 return より後では `coveredMicros` も非 null になるため、統計の計算に `?? 0` を残さない
- `AudioPublishCatchUp` の既存の消費規則 (長さが分からない chunk は 1 フレーム分だけ消費する) は変えない

### 対象外

- `AudioPublishCatchUp` の追いつきの判定と `durationMs` のフォールバック (既存のまま)
- 映像の符号化出力の `duration` の扱い

## 完了条件

- `chunk.duration` が `null` でも、末尾 drain の `tailFlushedMs` が送った chunk の覆った長さになり、送れた分が `tailDroppedMs` に数えられないこと
- `src/createMediaPublisher.test.ts` に、`duration` が `null` の chunk を末尾 drain で送ったときの統計を固定するテストがあり、修正前は `tailDroppedMs` が 0 より大きくなること
- `src/audioPublishCatchUp.test.ts` に、`durationMicros` が `null` のとき `coveredMicros` が先頭の記録の長さになることを固定するテストがあること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk` / `commitAudioTailStats` / `AudioTailDrainState`
- `src/audioPublishCatchUp.ts` の `AudioPublishCatchUpChunkResult` / `AudioPublishCatchUpChunkInput` / `recordEncodedChunk`
- W3C WebCodecs (Working Draft 2026-11-09) の 5.6 Algorithms (Output EncodedAudioChunks)
