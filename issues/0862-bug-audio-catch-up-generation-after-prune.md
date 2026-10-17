# 音声の記録を時間で破棄すると、止める前に依頼した chunk を止めた後に送り得る

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-catch-up-generation-after-prune
- Polished: {YYYY-MM-DD}

## 目的

音声の配信は、配信を止めた時点で開いている Subgroup を閉じ (draft-ietf-moq-transport-22 §11.3.2)、止める前に符号化を依頼した出力を閉じた Subgroup へ送らないよう、依頼した時点の世代と現在の世代を比べて送信の可否を決める (issues/closed/0847-add-close-paused-subgroup.md)。この世代の対応づけは、`AudioPublishCatchUp` が出力の返らない記録を時間で破棄する (`prunePending()`) と 1 つずれ、止める前に依頼した chunk を止めた後に送り得る。送られた chunk の LOC TIMESTAMP は取り違えた記録の値になり実際の内容とずれる。あわせて、取り違えで記録を消費された側の本物の出力は対応なしになって落ちる。破棄を挟んでも世代の対応づけが崩れないようにする。

## 現状

- `src/audioPublishCatchUp.ts` の `evaluate()` は、符号化へ渡すフレームを `PendingFrame` として投入順の配列 `pending` に積む。`PendingFrame.generation` は投入した時点の世代 (`AudioPublishCatchUpFrameInput.generation`) である。
- `recordEncodedChunk()` は `pending` の先頭を「覆った最初の投入」とし、`AudioPublishCatchUpChunkInput.durationMicros` の分だけ古い方から記録を消費して、その記録の `timestampMicros` と `generation` を返す。`AudioEncoder` の出力は投入の順に返るため、対応づけを順番 (FIFO) で行う (出力の timestamp はフレームを捨てた分だけ投入より古くなるため使えない)。1 つの出力は複数の投入を覆いうる (`AudioPublishCatchUpChunkInput.durationMicros` のコメント。`src/audioPublishCatchUp.test.ts` の「世代が飛んでも覆った最初の投入の世代を返す」テストに、1 つの出力が 2 つの投入を覆う場合がある)。
- `prunePending()` は、出力が返らないまま `AudioPublishCatchUpOptions.pendingTimeoutMs` (既定 `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` = 5 秒) を過ぎた記録を `pending` の先頭から捨てる (`readAtMs < nowMs - pendingTimeoutMs`)。捨てた区間の長さや世代はどこにも残らない。
- そのため、捨てた記録の出力が後から届くと、`recordEncodedChunk()` は残っている 1 つ後ろの記録を「覆った最初の投入」として扱い、その記録の `generation` を返す。呼び出し側 (`src/createMediaPublisher.ts` の `handleAudioEncodedChunk()`) は `encodedGeneration === this.processingGeneration` のときだけ送るため、取り違えた記録の世代が現在の世代と一致すると、破棄した方の出力が送られる。
  - 配信中は `processingGeneration` が変わらない (`src/createMediaPublisher.ts` の `pause()` / `stop()` / `close()` でだけ進む) ため、破棄の直後に届いた出力でも世代は一致し、そのまま送られる。
  - 配信を止めて再開した場合は、止める前に積んだ記録が再開後の `evaluate()` の `prunePending()` で落ち、再開後に積んだ新しい世代の記録が残る。`resume()` は同じエンコーダーを使い続けるため止める前に依頼した入力の出力は失われず、それが届くと新しい世代の記録に当たり、世代が一致して送られる。これが「止める前に依頼した chunk を止めた後に送る」経路である。
- 送られる chunk の LOC TIMESTAMP は、`handleAudioEncodedChunk()` が返り値の `timestampMicros` (`AudioTimestampClock.apply()` を通す) から作るため、取り違えた記録の投入時刻になる。chunk の内容 (破棄した記録の音声) とずれる。
- 取り違えで記録を消費された側の本物の出力は、次に届いたときに `pending` が空 (または別の記録) になっており、対応なし (`timestampMicros` / `generation` が null) として送られない。音声が 1 chunk 欠ける。
- この挙動は現在 `prunePending()` の JSDoc の「注意 (残余リスク)」に書かれているだけで、テストで固定されていない。到達には出力が 5 秒以上遅れることが要る。
- 同じ規則は devtools の `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()` にもある (`encodeState.generation` と比べる)。どちらも共有の `AudioPublishCatchUp` を使うため、クラス側を直せば両方に効く。`AudioPublishCatchUp` は `src/index.ts` から再エクスポートされており、この対応づけは公開の振る舞いである。
- `issues/closed/0847-add-close-paused-subgroup.md` の「残した穴 (別 issue 候補)」に、この残余リスクが記録されている。

## 設計方針

破棄した区間を覆う出力を「対応する投入が無い出力」として扱い、世代を返さない。

- `AudioPublishCatchUp` が、`prunePending()` で捨てた区間の合計の長さ (ミリ秒) を持つ。破棄は `pending` の先頭から連続して起きるため、区間は 1 つの長さで表せる。
- `recordEncodedChunk()` は、届いた出力の長さをまずこの区間に古い方から充てる。出力の先頭が区間にある間は、覆った最初の投入の世代を特定できない (記録を捨てている) ため、`timestampMicros` と `generation` を null にして返す。呼び出し側は既に null の出力を送らない (`handleAudioEncodedChunk()` の `timestampMicros === null` の判定) ため、`src/createMediaPublisher.ts` の変更は要らない。
- 出力が破棄した区間より長い場合は、越えた分を `pending` の記録から消費する。消費しないと、次の出力がさらに 1 つ後ろの記録に当たり、同じずれが残る。返すのは対応なしのままにする (覆った最初の投入は破棄した区間にあり、その chunk の LOC TIMESTAMP を正しく決められない)。
- 破棄した区間の長さは `reset()` で 0 に戻す (配信ごとの初期化。残すと次の配信の出力がすべて対応なしになる)。
- 破棄した記録の「数」だけ出力を読み飛ばす方法は採らない。1 つの出力が複数の投入を覆いうるため、破棄した記録の数と、破棄した区間を覆う出力の数は一致しない。長さで数える。
- 破棄した区間の長さは `pendingMs` とは別に持つ。`pendingMs` は「符号化へ渡したまま出力が返っていない音声の長さ」であり、破棄した分は既に引かれている (追いつきの判定 `shouldDrop()` に使う値の意味を変えない)。
- `AudioPublishCatchUpChunkResult` の型は変えない。対応なしは既に null で表せる。
- `prunePending()` の JSDoc の「注意 (残余リスク)」は、対応後の規則 (破棄した区間を覆う出力は対応なしとして扱う) に書き換える。

## 完了条件

- 破棄した区間を覆う出力が、`recordEncodedChunk()` から `timestampMicros` と `generation` の両方 null で返ること。破棄の後に届いた、止める前に依頼した chunk が送られないこと。
- `src/audioPublishCatchUp.test.ts` に、`pendingTimeoutMs` を短くした `AudioPublishCatchUp` で (既存の「出力が返らないままの記録は、一定の時間で捨てる」テストと同じ形)、次を固定する。
  - 破棄した区間を覆う出力が対応なしになること (破棄した区間の投入を世代 0、破棄の後に積む投入を世代 1 とし、破棄した区間の入力に対応する出力が世代 1 の記録の世代を返さないこと)。
  - 破棄した区間を越える長さの出力でも、越えた分の `pending` の記録が消費され、その次の出力が正しい投入に当たること (ずれが残らないこと)。
  - 破棄の後に届く本物の出力 (現在の世代の記録に対応する出力) の対応づけが壊れないこと。
  - `reset()` の後に破棄した区間の長さが残らないこと。
- `src/audioPublishCatchUp.prop.ts` に、任意の間隔で出力が遅れる状況で「破棄した区間を覆う出力は世代を返さない」性質を足す (`policy: "keep"` で投入を保ち、`pendingTimeoutMs` を短くして破棄を混ぜる)。
- 破棄が無い場合の既存の対応づけ (覆った最初の投入の世代を返すこと) と、既存のテストが変わらないこと。
- `prunePending()` の JSDoc が実装と一致していること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 参照

- `src/audioPublishCatchUp.ts` の `prunePending()` / `recordEncodedChunk()` / `evaluate()` / `reset()` / `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS`
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `pause()` / `resume()`
- `src/audioPublishCatchUp.test.ts` / `src/audioPublishCatchUp.prop.ts`
- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()`
- `issues/closed/0847-add-close-paused-subgroup.md` (世代で送信を選り分ける規則と、この残余リスクの記録)
- draft-ietf-moq-transport-22 §11.3.2 (Closing Subgroup Streams)
- `refs/moq/draft-ietf-moq-transport-22.txt`
