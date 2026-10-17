# 配信を止める前に依頼した符号化の出力を捨てたことを計器で観測できるようにする

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/add-dropped-output-stats
- Polished: {YYYY-MM-DD}

## 目的

配信を止めるとき (ライブラリの `pause()` / devtools の stop-sending) に、止める前に依頼した符号化の出力を送らずに捨てる経路がある。捨てた数がどの計器にも出ないため、この経路が壊れても気付けない。とくに映像は「符号化の出力の timestamp が入力フレームの timestamp と一致する」という前提に依存しており、前提が崩れると映像が 1 枚も送られないまま何も通知されない (無言の全損)。

捨てた出力の数を計器で読めるようにし、この前提と異常時の読み方を docs / JSDoc に書く。

## 現状

- 止める前に依頼した出力を送らない規則は `src/encodeGeneration.ts` に集約されている。`recordEncodeGeneration()` が「符号化を依頼した時点の世代」を入力フレームの `timestamp` を鍵に記録し、`shouldSendEncodedChunk()` が現在の世代と一致するときだけ送ると決める。`advanceEncodeGeneration()` が世代を進めて記録を消す (devtools の stop-sending が呼ぶ)。
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk()` は `shouldSendEncodedChunk()` が false のとき、`videoStats` を更新する前に return する。`handleAudioEncodedChunk()` も `audioCatchUp.recordEncodedChunk()` が返した世代が現在の世代と一致しないとき、および対応する記録が無いとき (`timestampMicros` が null) に、`audioStats` を更新する前に return する。どちらの経路も捨てた数をどこにも残さない。
- `src/codec/types.ts` の `VideoStats.droppedFrames` は入力側の破棄だけを数える。JSDoc は「エンコード能力を超えたため、または実行時エラーでエンコーダーが使えなくなったために破棄したフレーム数」と定め、「世代が変わった後に読んだフレームと encode が同期 throw したフレームは数えない」と明記している。`AudioStats` にも符号化の出力を捨てた数を表すフィールドは無い (`catchUp.droppedFrames` は遅れが上限を超えたときに符号化せずに捨てた入力側の数である)。
- 映像の判定は timestamp で記録を引くため、「`EncodedVideoChunk.timestamp` に入力の `VideoFrame.timestamp` が載る」という前提に依存する。前提が崩れると記録を引けず、すべての出力が送られない (映像が 1 枚も送られない)。エラーもログも出ない。止める前の出力を捨てる経路が無かった頃は、同じ前提が崩れても出力は送られ、LOC TIMESTAMP の換算が合わないだけだった。
- 停止をまたいで同じ timestamp のフレームが現れた場合も、2 枚目の記録が無いため 1 枚落ちる。これも同じ経路で無言のままである。
- devtools も同じ規則を使う (`devtools/src/hooks/usePublisher.ts` の `handleEncodedChunk()` / `handleAudioEncodedChunk()`)。`devtools/src/utils/publishTimingStats.ts` の `encodeQueueDrops` は符号化せずに捨てた入力フレームを数えるだけで、符号化した後に捨てた出力は数えない。音声は `devtools/src/signals/publisher.ts` の `audioChunksEncoded` などが符号化の結果を数えるが、同じく捨てた出力は数えない。
- issues/closed/0847-add-close-paused-subgroup.md の「残した穴」に、統計に出ないことと、timestamp の前提が崩れると無言で全損することが記録されている。
- 関連仕様: draft-ietf-moq-transport-22 §11.3.2 は「Subgroup の全 Object を送ったなら FIN、送り切る前に閉じるなら RESET」を MUST とする。止める前に依頼した出力を送らないのは、閉じた Subgroup へ送らないための判断である。捨てた出力は wire 上に存在せず、送らなかった Object の数として観測できる。

## 設計方針

- 送らなかった符号化の出力の数を、両方の実装の計器に足す。
  - ライブラリ: `VideoStats.droppedEncodedOutputs` と `AudioStats.droppedEncodedOutputs` (`src/codec/types.ts`)。映像は 1 フレーム、音声は 1 chunk (1 Object) を 1 とする。数えるのは「符号化を依頼した時点の世代と一致しなかったため送らなかった出力」であり、対応する記録が無い出力 (配信を始める前の出力、配信ごとの初期化で記録を消した後の出力、timestamp が入力と対応しない出力) も同じ数に含める。原因を区別しないのは、全損の検知に要るのが「送らなかった出力の総数」であり、`framesSent` が増えないままこの数だけが増えることが異常の目印になるためである。
  - devtools: 映像は `PublishTimingSnapshot.droppedEncodedOutputs` (`devtools/src/utils/publishTimingStats.ts`)。`encodeQueueDrops` が「符号化せずに捨てた入力」なので、その隣に「符号化したが送らなかった出力」を置く。音声は `devtools/src/signals/publisher.ts` の `audioChunksEncoded` の隣に置く signal (`audioDroppedEncodedOutputs` とし、`PublisherAudioStats` では `chunksEncoded` と対になる `droppedEncodedOutputs` にする)。devtools は映像の符号化の計器が `PublishTimingStats`、音声は `signals/publisher.ts` の `audio*` に分かれているため、それぞれの既存の置き場に合わせる。
- `shouldSendEncodedChunk()` と `recordEncodedChunk()` の契約は変えない。判定が false / 世代不一致のときに、呼び出し側が自分の計器を 1 増やす。規則は `src/encodeGeneration.ts` に 1 つのまま、計器はそれぞれの所有者が持つ。
- 数えるのは送信の可否の判定の結果だけにする。捨てた出力が持つ codec description を保留する処理 (`pendingVideoConfig` / `pendingAudioConfig`) は従来どおり判定より先に行う。
- devtools の映像は、捨てた出力の `readAt` の記録も消す。残すと、再開後に同じ timestamp のフレームが現れたときに古い読み出し時刻と対応づき、符号化の時間が誤って記録される。
- 累積の扱いは既存のフィールドに合わせる。ライブラリの `VideoStats` / `AudioStats` は配信ごとに消さない (`framesSent` / `droppedFrames` と同じ)。devtools の映像は `resetVideoPublishState()` が `PublishTimingStats` を作り直すため配信ごと、音声の signal も配信のたびに 0 に戻す (`audioChunksEncoded` と同じ)。
- 異常の読み方: 配信中に `framesSent` が増えないまま `droppedEncodedOutputs` だけが増え続けるなら、符号化の出力の timestamp が入力フレームと対応していない (無言の全損)。この前提と読み方を `src/encodeGeneration.ts` の JSDoc、`src/codec/types.ts` の新しいフィールドの JSDoc、`docs/HIGH_LEVEL_API.md` の統計情報の節に書く。
- `docs/HIGH_LEVEL_API.md` の状態遷移の `pause()` の説明に、止める前に依頼した出力は送らずに捨てる (数は `getStats()` で読める) ことを足す。
- `docs/LOW_LEVEL_API.md` は変更しない。低レベル API の契約 (`Publisher` のメソッドと FIN / RESET の契機) は変わらず、`VideoStats` / `AudioStats` は `docs/HIGH_LEVEL_API.md` の統計情報の節だけが説明している。
- 公開型へのフィールド追加は読み取り側のコードを壊さない。後方互換のための別名や移行期間は設けない (CODEBASE.md「破壊的変更は積極的に行う」/ shiguredo-typescript「後方互換性は考慮しないこと」)。追加と同時に docs と JSDoc を更新する。
- ログや警告は足さない。ライブラリの送信経路はログを出さない (`src/createMediaPublisher.ts` に console 出力が無い)。気付ける経路は計器と docs に置く。
- `CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新しない。

## 完了条件

- `pause()` の前に依頼した映像 / 音声の出力が送られず、`getStats()` の `video.droppedEncodedOutputs` / `audio.droppedEncodedOutputs` が 1 増えること。`src/createMediaPublisher.test.ts` の `pause: 止める前に依頼した映像の出力は送られない` / 音声のテストで固定する。`getStats()` は `options.video` / `options.audio` が無いと null を返すため、映像は `createLoopTestContext()` の映像オプションを渡して作り、音声は同ヘルパが音声オプションを受け取らないため音声オプションを足すか `MediaPublisherImpl` を直接作る。
- 対応する記録が無い timestamp の出力 (前提が崩れた場合に相当) を `handleVideoEncodedChunk()` / `handleAudioEncodedChunk()` に渡しても送られず、同じ数に数えられること。`src/createMediaPublisher.test.ts` で固定する (記録を作らずに出力を渡す)。
- devtools の stop-sending で捨てた出力が `PublishTimingSnapshot.droppedEncodedOutputs` と音声の signal に出ること。`devtools/src/utils/publishTimingStats.test.ts` と `devtools/src/hooks/usePublisher.test.ts` で固定し、統計の網羅は `devtools/src/signals/snapshotCoverage.test.ts` と `devtools/src/signals/statsSnapshot.test.ts` に従う。
- 配信ごとの後始末: devtools で配信を始め直したときに前の配信の数が残らないこと。ライブラリは既存の `framesSent` と同じく累積であり、配信ごとの初期化 (`setupEncoders()`) で消さないこと。
- 符号化出力の timestamp の前提 (`EncodedVideoChunk.timestamp` に入力の `VideoFrame.timestamp` が載る) と、崩れた場合にこの数だけが増えることが、`src/encodeGeneration.ts` の JSDoc・`src/codec/types.ts` の新しいフィールドの JSDoc・`docs/HIGH_LEVEL_API.md` に書かれていること。
- devtools の Publisher 統計に新しい数が表示され、`devtools/src/components/statsHelp.ts` に説明があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 参照

- `src/encodeGeneration.ts` / `src/createMediaPublisher.ts` / `src/codec/types.ts` / `src/audioPublishCatchUp.ts`
- `devtools/src/hooks/usePublisher.ts` / `devtools/src/utils/publishTimingStats.ts` / `devtools/src/signals/publisher.ts` / `devtools/src/signals/statsSnapshot.ts`
- `docs/HIGH_LEVEL_API.md` の「統計情報」「状態遷移」
- `refs/moq/draft-ietf-moq-transport-22.txt` §11.3.2 (Closing Subgroup Streams)
- `issues/closed/0847-add-close-paused-subgroup.md` の「残した穴」
- `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」
