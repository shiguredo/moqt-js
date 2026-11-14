# 音声の記録を時間で破棄すると出力の対応づけがずれ、止める前の chunk を送り後続の時刻もずれる

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-catch-up-generation-after-prune
- Polished: 2026-11-14

## 目的

音声は 1 chunk = 1 Object = 1 Group で送る。Subgroup 配送では Object ごとに `endOfSubgroup: true` を付けて Subgroup を閉じ、既定の datagram 配送には Subgroup が無い (`src/createMediaPublisher.ts` の `handleAudioEncodedChunk()`)。そのため `pause()` が閉じる Subgroup は映像だけで、音声には無い (issues/closed/0847-add-close-paused-subgroup.md)。音声で問題になるのは、破棄によって古い出力が後ろの記録に当たり、再開後の新しい世代の音として送られることである。

`AudioPublishCatchUp` は出力の返らない記録を時間で破棄する (`prunePending()`)。破棄した記録の出力が後から届くと、FIFO の対応づけが破棄した長さの分だけ後ろへずれ、次の害が出る。

- 止める前に依頼した chunk が、現在の世代と一致する後ろの記録に当たり、止めた後に送られる。音声は 1 Object = 1 Group なので、閉じた Subgroup ではなく新しい Group に、止める前の音が新しい音として載る
- 送られる chunk の LOC TIMESTAMP は、当たった記録の投入時刻になるため内容より後ろへずれる。ずれは以後の出力に残り、`reset()` まで続く
- `pending` が空のときに届いた出力は対応なしになり、送られない

破棄を挟んでも、世代と LOC TIMESTAMP の対応づけが崩れないようにする。

## 現状

- `src/audioPublishCatchUp.ts` の `evaluate()` は、符号化へ渡すフレームを `PendingFrame` として投入順の配列 `pending` に積む。`PendingFrame.generation` は投入した時点の世代 (`AudioPublishCatchUpFrameInput.generation`) である
- `recordEncodedChunk()` は `pending` の先頭を「覆った最初の投入」とし、`AudioPublishCatchUpChunkInput.durationMicros` の分だけ古い方から記録を消費して、その記録の `timestampMicros` と `generation` を返す。`AudioEncoder` の出力は投入の順に返るため、対応づけを順番 (FIFO) で行う (出力の timestamp はフレームを捨てた分だけ投入より古くなるため使えない)。1 つの出力は複数の投入を覆いうる (`AudioPublishCatchUpChunkInput.durationMicros` のコメント。`src/audioPublishCatchUp.test.ts` の「世代が飛んでも覆った最初の投入の世代を返す」テストに、1 つの出力が 2 つの投入を覆う場合がある)。長さが分からない出力 (`durationMicros` が null) は先頭の記録 1 つ分を消費する。`pending` が空なら null を返す
- closed 0953 で `AudioPublishCatchUpChunkResult` に `coveredStartMicros` / `coveredEndMicros` が加わり、`PendingFrame` に `startMicros` / `endMicros` が加わった。`recordEncodedChunk()` は消費した pending の範囲を covered として返し、`src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` は `AudioEncoder` の出力の duration が null のとき、この範囲から末尾 drain の長さと末尾を求める
- `prunePending()` は、出力が返らないまま `AudioPublishCatchUpOptions.pendingTimeoutMs` (既定 `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` = 5 秒) を過ぎた記録を `pending` の先頭から捨てる (`readAtMs < nowMs - pendingTimeoutMs`、すなわち経過が `pendingTimeoutMs` を超えたときだけ捨てる)。捨てた区間の長さや世代はどこにも残らない。`prunePending()` を呼ぶのは `evaluate()` だけである
- そのため、捨てた記録の出力が後から届くと、`recordEncodedChunk()` は残っている後ろの記録を「覆った最初の投入」として扱い、その記録の `timestampMicros` と `generation` を返す。この出力は自分が覆っていない記録まで長さの分だけ消費するので、以後の出力も破棄した長さの分だけ後ろの記録に当たり続ける。`src/createMediaPublisher.ts` の `processAudioFrames()` は 1 フレーム先読みし、符号化器は 1 パケット分の入力を保持したまま出力を返す (`src/audioPublishCatchUp.ts` 先頭のコメント) ため、出力が届く時点の `pending` には通常次の記録が積まれており、ずれは残り続ける。null が返って本物の出力が落ちるのは、`pending` が空のときに出力が届いた場合 (停止の末尾など) だけである
- 呼び出し側 (`src/createMediaPublisher.ts` の `handleAudioEncodedChunk()`) は `encodedGeneration === this.processingGeneration` のときだけ送るため、取り違えた記録の世代が現在の世代と一致すると、破棄した方の出力が送られる。送られる chunk の LOC TIMESTAMP は返り値の `timestampMicros` (`AudioTimestampClock.apply()` を通す) から作るため、取り違えた記録の投入時刻になる
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` は、`timestampMicros` / `generation` / `coveredStartMicros` / `coveredEndMicros` のどれかが null なら送らずに早期 return する。`AudioTailDrainState` は `readBlocks` と `sentEndMicros` を持ち、`commitAudioTailStats()` は `sentEndMicros` までの入力ブロックを送信済みとして扱う。そのため、破棄区間を越える出力が pending の記録を消費して捨てられると、消費された記録が後に送信された chunk の `sentEndMicros` に覆われ、送っていない音が送信済みとして数えられ得る
- 到達する経路は 2 つある。
  - 配信を止めて再開する経路 (ライブラリのみ): `pause()` は `processingGeneration` を進める。音声は 1 Object = 1 Group で送るため閉じる Subgroup は無いが、エンコーダーには触らない。`resume()` は同じエンコーダーを使い続ける。止めた時点で出力の返っていない記録が残っていれば (符号化器が入力を保持するため通常は残る)、止めている時間が `pendingTimeoutMs` を超えると、再開後の最初の `evaluate()` でその記録が捨てられる。保持されていた入力を含む出力は再開後の新しい世代の記録に当たり、世代が一致して送られる
  - 配信中の経路 (ライブラリと devtools): 出力が `pendingTimeoutMs` を超えて遅れて記録が捨てられた後に、その出力が届く。`processingGeneration` は配信中に変わらない (`pause()` / `stop()` / `close()` でだけ進む) ため、世代は一致して送られる
- devtools の `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()` も同じ規則 (`encodeState.generation` と比べる) で、共有の `AudioPublishCatchUp` を使うため、クラス側を直せば両方に効く。devtools は停止時にエンコーダーを閉じ、次の配信で `AudioPublishCatchUp` を作り直すため、止めて再開する経路は無い。`AudioPublishCatchUp` は `src/index.ts` から再エクスポートされており、この対応づけは公開の振る舞いである
- この挙動は `prunePending()` の JSDoc の「注意 (残余リスク)」に書かれているだけで、テストで固定されていない
- `issues/closed/0847-add-close-paused-subgroup.md` の「残した穴 (別 issue 候補)」に、この残余リスクが記録されている

## 設計方針

破棄した区間を覆う出力を「対応する投入が無い出力」として扱い、世代を返さない。あわせて、その出力が pending の記録を消費した場合は、消費した範囲を呼び出し側へ返し、末尾 drain の統計 (0953) と整合させる。

### 前提

- encode に渡した入力の出力は、エンコーダーが閉じない限り、遅れても届く。破棄した記録の出力は後から届くものとして扱う
- エンコーダーのエラーでは WebCodecs がエンコーダーを閉じるため以後の出力は無く、破棄した区間が残っても次の配信の `reset()` で消えるため影響しない
- 記録は積んだが encode に届かなかった入力 (`processAudioFrames()` のループで例外が出て、先読みのフレームを encode せずに抜けた場合など) は、この前提から外れる。その記録の長さを区間に積むと、後続の本物の出力がその長さの分だけ区間に充てられて落ち、以後の出力はその長さの分だけ前の記録に当たり続ける (LOC TIMESTAMP が内容より前へずれ、`reset()` まで残る)。この経路は現状でも (破棄の前に再開すれば) 同じずれを起こす別の問題であり、本 issue の対象外とする (下の「対象外」)
- 長さが分からない出力 (`durationMicros` が null) は 1 フレームを覆うものとして扱う (既存の `recordEncodedChunk()` の消費と同じ仮定)。1 つの出力が複数の投入を覆う構成 (10 ms の `AudioData` を 2 つ読んで 20 ms の packet が出るなど) で長さが null だと、この仮定は成り立たない。その構成では現状でも対応づけが壊れており (`policy: "keep"` では `pendingMs` が `pendingTimeoutMs` まで伸びて時刻がずれ続け、既定の `policy: "drop"` では追いつきが投入をほぼすべて捨てる)、本 issue の規則を入れると区間が戻らずに以後の出力がすべて対応なしになる。この組み合わせは本 issue の対象外とする (下の「対象外」)

### 規則

- `AudioPublishCatchUp` が、`prunePending()` で捨てた区間の合計の長さ (ミリ秒。`PendingFrame.durationMs` と同じ単位) を `prunedMs` として持つ。破棄は `pending` の先頭から連続して起きるため、区間は 1 つの長さで表せる
- `recordEncodedChunk()` は `prunedMs > 0` のとき、次を順に行う。
  - 出力の長さ `L` (ミリ秒) を決める。`durationMicros` が非 null なら `durationMicros / 1_000`、null なら `lastFrameDurationMs` を 1 フレーム分とする
  - `min(L, prunedMs)` を区間から引く。`L <= prunedMs` なら pending は消費せず、`timestampMicros` / `generation` / `coveredStartMicros` / `coveredEndMicros` をすべて null にして返す
  - `L > prunedMs` なら、残り `L - prunedMs` を pending から消費する。消費は既存のループと同じく、先頭の記録を分割して残りを持ち越す。`timestampMicros` と `generation` は null にし、`coveredStartMicros` / `coveredEndMicros` は消費した pending の範囲 (最初に消費した記録の `startMicros` から最後に消費した位置まで) にする。pending が空なら covered も null にする
  - 区間を引いた後に `prunedMs` が 0 になり、pending の消費も 0 なら、その後の動作は既存と同じになる
- `prunedMs == 0` のときの既存の動作 (duration が null なら先頭の記録 1 つ分を消費する、covered は消費した範囲、pending が空なら全 null) は変えない
- `coveredStartMicros` / `coveredEndMicros` の意味を「pending の記録から消費した範囲」に広げる。破棄区間の先頭を覆う出力では、pending の部分だけを返す。0953 の issue 本文は closed 時点の記録として残し、ソースの `AudioPublishCatchUpChunkResult` の JSDoc を新しい意味に更新する。型は変えない
- `reset()` で `prunedMs` を 0 にする (配信ごとの初期化。残すと、次の配信の先頭の出力 (残った長さの分) が対応なしになり音声が欠ける)
- 呼び出し側 (`src/createMediaPublisher.ts`) を次のように変える。
  - `handleAudioEncodedChunk()` は、`timestampMicros` が null でも covered が非 null なら、末尾 drain 中の未送信範囲として記録する。送信の統計 (`sentFrames` / `sentMs` / `sentEndMicros`) には足さない
  - `AudioTailDrainState` に `unsentRanges` (`startMicros` / `endMicros` の配列) を持たせ、`commitAudioTailStats()` は `sentEndMicros` までの範囲から `unsentRanges` との重なりを除いて送信済みの範囲を求め、`tailDroppedMs` / `tailDroppedFrames` を数える。`unsentRanges` が空のときの結果は変えない。重なりは加算時に統合し、二重に引かない。読み出したブロックの一部でも未送信なら `tailDroppedFrames` を 1 と数える (0953 の現在の数え方に合わせる)
  - 本 issue の末尾 drain の統計は、破棄区間が drain 開始前にできた場合を対象とする。既定の `pendingTimeoutMs` (5 秒) は drain の上限より長いため、drain 中に読んだ記録が破棄されることはない。短い `pendingTimeoutMs` で試すテストは、drain の前に `evaluate()` を直接呼んで区間を作る
  - これにより、破棄区間を越える出力が pending の記録を消費して捨てられても、その範囲が「送った」と数えられない
- 破棄した記録の「数」だけ出力を読み飛ばす方法は採らない。1 つの出力が複数の投入を覆いうえ、破棄した記録の数と破棄した区間を覆う出力の数は一致しない。長さで数える
- 破棄した区間の長さは `pendingMs` とは別に持つ。`pendingMs` は「符号化へ渡したまま出力が返っていない音声の長さ」であり、破棄した分は既に引かれている (追いつきの判定 `shouldDrop()` に使う値の意味を変えない)

### 対象外

- 記録を積んだが encode に届かなかった入力の扱い (`processAudioFrames()` / `encodeWithSpliceFade()` の例外で先読みのフレームを encode しないまま抜ける経路)。記録が出力の来ないまま残り、破棄の前でも後続の出力の対応づけをずらす。別 issue とする
- 長さが分からない出力 (`durationMicros` が null) が複数の投入を覆う構成での対応づけ。現状でも壊れており、本 issue の規則では区間が戻らなくなる。別 issue とする

## 完了条件

- 破棄した区間を覆う出力が `recordEncodedChunk()` から `timestampMicros` と `generation` の両方 null で返り、`handleAudioEncodedChunk()` の既存の早期 return で送られないこと。未送信範囲の `unsentRanges` への記録は、その早期 return より前に行うこと
- `src/audioPublishCatchUp.test.ts` に、`pendingTimeoutMs` を短くした `AudioPublishCatchUp` で次を固定する。
  - 破棄区間の中に収まる出力が 4 フィールドすべて null になり、pending が消費されないこと
  - 破棄区間を越える出力が timestamp / generation null、covered が pending の消費範囲になり、pending が正しく減ること
  - 破棄区間を越えて pending の記録を分割する出力の後、次の出力が残りの記録に正しく当たること (ずれが残らないこと)
  - duration が null で破棄区間を越える出力が、`lastFrameDurationMs` を長さとして区間と pending に按分され、次の出力の対応づけが壊れないこと
  - `reset()` の後に破棄した区間の長さが残らないこと
- pause / resume の実経路は、既存の「止める前に依頼した音声の出力は送られない」テスト (`src/createMediaPublisher.test.ts`) で null の出力が送られないことを担保する。prune を挟む世代の切り替えは、クラス単体テストで世代 0 の記録を破棄し、世代 1 の記録を積んだ後に世代 0 の出力を渡し、世代 1 の記録の世代を返さないことで固定する
- `src/audioPublishCatchUp.prop.ts` に、任意の間隔で出力が遅れる状況で「破棄した区間を覆う出力は世代を返さず、それ以外の出力は覆った最初の投入の timestamp と世代を返す」性質を足す (`policy: "keep"` で投入を保ち、`pendingTimeoutMs` を短くして破棄を混ぜる)
- 破棄が無い場合の既存の対応づけ (覆った最初の投入の世代を返すこと) と、既存のテストが変わらないこと
- `src/createMediaPublisher.test.ts` に、制御口から `pendingTimeoutMs` を長め (例: 1,000 ms) にした `AudioPublishCatchUp` を差し替え、drain の前に `evaluate(nowMs)` を直接呼んで破棄区間を作るテストを足す。drain 中に破棄区間を越える出力が届いたとき、消費した pending の範囲が `tailDroppedMs` に入り、`tailFlushedMs` に二重計上されず、後続の送信 chunk の `sentEndMicros` に覆われないことを固定する。実時間の待ちは使わない。0953 の既存の末尾統計のテストが変わらず通ること
- `prunePending()` の JSDoc の「注意 (残余リスク)」、`recordEncodedChunk()` の JSDoc と内部のコメント (「記録より長い出力 (捨てた分を覆った、配信の停止をまたいだなど)。残りは捨てる」など)、`AudioPublishCatchUpChunkResult` の JSDoc、`AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` の JSDoc (「記録を残す意味が無い」) が、新しい規則と前提に一致していること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること
- ソースコードのコメントに issue 番号や issue への言及を書かないこと

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/audioPublishCatchUp.ts` の `prunePending()` / `recordEncodedChunk()` / `evaluate()` / `reset()` / `lastFrameDurationMs` / `AudioPublishCatchUpChunkResult` / `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS`
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `processAudioFrames()` / `pause()` / `resume()` / `commitAudioTailStats()` / `AudioTailDrainState`
- `src/audioPublishCatchUp.test.ts` / `src/audioPublishCatchUp.prop.ts` / `src/createMediaPublisher.test.ts`
- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()`
- `issues/closed/0847-add-close-paused-subgroup.md` (世代で送信を選り分ける規則と、この残余リスクの記録)
- `issues/closed/0953-bug-publisher-audio-tail-duration-null.md` (covered の契約と末尾 drain の統計)
- draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams)
- `refs/moq/draft-ietf-moq-transport-23.txt`

## 着手前の確認

- 0953 の covered の契約を「pending の記録から消費した範囲」に広げる。0953 の issue 本文は closed 時点の記録として残し、ソースの JSDoc とテストを新しい契約に合わせる。対応づけられた chunk では従来どおり消費範囲全体を返すため、0953 の duration null の統計は変わらない
- 破棄区間を越える出力は timestamp / generation null のまま送らない。covered は pending の部分だけを返し、`handleAudioEncodedChunk()` が末尾 drain の未送信範囲として `unsentRanges` に積む
- 末尾 drain の統計は、`sentEndMicros` による被覆から `unsentRanges` を差し引く方式にする。0953 の統計の結果を変えないことを完了条件に含める
