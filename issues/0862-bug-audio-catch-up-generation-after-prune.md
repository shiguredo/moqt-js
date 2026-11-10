# 音声の記録を時間で破棄すると出力の対応づけがずれ、止める前の chunk を送り後続の時刻もずれる

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-catch-up-generation-after-prune
- Polished: 2026-11-10

## 目的

音声の配信は、配信を止めた時点で開いている Subgroup を閉じ (draft-ietf-moq-transport-23 §11.3.2)、止める前に符号化を依頼した出力を閉じた Subgroup へ送らないよう、依頼した時点の世代と現在の世代を比べて送信の可否を決める (issues/closed/0847-add-close-paused-subgroup.md)。この世代と LOC TIMESTAMP の対応づけは、`AudioPublishCatchUp` が出力の返らない記録を時間で破棄する (`prunePending()`) と、破棄した長さの分だけずれる。

- 破棄した記録の出力が後から届くと、後ろの記録 (新しい世代の記録を含む) に当たり、止める前に依頼した chunk を止めた後に送り得る
- 以後の出力も破棄した長さの分だけ後ろの記録に当たり続け、送られる chunk の LOC TIMESTAMP がその長さだけ実際の内容より後ろへずれ続ける
- ずれは、出力が届いた時点の `pending` がその出力の長さより短いと、足りない分だけ縮む。空ならその出力は対応なし (null) になって送られず、空でなければ残りの記録をずれた時刻のまま消費して送られる。停止の末尾では、`pending` が尽きてから届いた本物の出力が送られない (その長さは残ったずれ以下で、`pending` が出力より短いときに縮んだ分だけ短い)

破棄を挟んでも、世代と LOC TIMESTAMP の対応づけが崩れないようにする。

## 現状

- `src/audioPublishCatchUp.ts` の `evaluate()` は、符号化へ渡すフレームを `PendingFrame` として投入順の配列 `pending` に積む。`PendingFrame.generation` は投入した時点の世代 (`AudioPublishCatchUpFrameInput.generation`) である。
- `recordEncodedChunk()` は `pending` の先頭を「覆った最初の投入」とし、`AudioPublishCatchUpChunkInput.durationMicros` の分だけ古い方から記録を消費して、その記録の `timestampMicros` と `generation` を返す。`AudioEncoder` の出力は投入の順に返るため、対応づけを順番 (FIFO) で行う (出力の timestamp はフレームを捨てた分だけ投入より古くなるため使えない)。1 つの出力は複数の投入を覆いうる (`AudioPublishCatchUpChunkInput.durationMicros` のコメント。`src/audioPublishCatchUp.test.ts` の「世代が飛んでも覆った最初の投入の世代を返す」テストに、1 つの出力が 2 つの投入を覆う場合がある)。長さが分からない出力 (`durationMicros` が null) は先頭の記録 1 つ分を消費する。`pending` が空なら null を返す。
- `prunePending()` は、出力が返らないまま `AudioPublishCatchUpOptions.pendingTimeoutMs` (既定 `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` = 5 秒) を過ぎた記録を `pending` の先頭から捨てる (`readAtMs < nowMs - pendingTimeoutMs`)。捨てた区間の長さや世代はどこにも残らない。`prunePending()` を呼ぶのは `evaluate()` だけである。
- そのため、捨てた記録の出力が後から届くと、`recordEncodedChunk()` は残っている後ろの記録を「覆った最初の投入」として扱い、その記録の `timestampMicros` と `generation` を返す。この出力は自分が覆っていない記録まで長さの分だけ消費するので、以後の出力も破棄した長さの分だけ後ろの記録に当たり続ける。`src/createMediaPublisher.ts` の `processAudioFrames()` は 1 フレーム先読みし、符号化器は 1 パケット分の入力を保持したまま出力を返す (`src/audioPublishCatchUp.ts` 先頭のコメント) ため、出力が届く時点の `pending` には通常次の記録が積まれており、ずれは残り続ける。null が返って本物の出力が落ちるのは、`pending` が空のときに出力が届いた場合 (停止の末尾など) だけである。
- 呼び出し側 (`src/createMediaPublisher.ts` の `handleAudioEncodedChunk()`) は `encodedGeneration === this.processingGeneration` のときだけ送るため、取り違えた記録の世代が現在の世代と一致すると、破棄した方の出力が送られる。送られる chunk の LOC TIMESTAMP は返り値の `timestampMicros` (`AudioTimestampClock.apply()` を通す) から作るため、取り違えた記録の投入時刻になる。
- 到達する経路は 2 つある。
  - 配信を止めて再開する経路 (ライブラリのみ): `pause()` は `processingGeneration` を進めて Subgroup を閉じるが、エンコーダーには触らない。`resume()` は同じエンコーダーを使い続ける。止めた時点で出力の返っていない記録が残っていれば (符号化器が入力を保持するため通常は残る)、止めている時間が `pendingTimeoutMs` 以上あると、再開後の最初の `evaluate()` でその記録が捨てられる。保持されていた入力を含む出力は再開後の新しい世代の記録に当たり、世代が一致して送られる。`pendingTimeoutMs` を超えて止めてから再開するという通常の操作で起きる。
  - 配信中の経路 (ライブラリと devtools): 出力が `pendingTimeoutMs` 以上遅れて記録が捨てられた後に、その出力が届く。`processingGeneration` は配信中に変わらない (`pause()` / `stop()` / `close()` でだけ進む) ため、世代は一致して送られる。
- devtools の `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()` も同じ規則 (`encodeState.generation` と比べる) で、共有の `AudioPublishCatchUp` を使うため、クラス側を直せば両方に効く。devtools は停止時にエンコーダーを閉じ、次の配信で `AudioPublishCatchUp` を作り直すため、止めて再開する経路は無い。`AudioPublishCatchUp` は `src/index.ts` から再エクスポートされており、この対応づけは公開の振る舞いである。
- この挙動は `prunePending()` の JSDoc の「注意 (残余リスク)」に書かれているだけで (「1 つ後ろの記録に当てる」と書いているが、実際のずれは破棄した長さの分である)、テストで固定されていない。
- `issues/closed/0847-add-close-paused-subgroup.md` の「残した穴 (別 issue 候補)」に、この残余リスクが記録されている。

## 設計方針

破棄した区間を覆う出力を「対応する投入が無い出力」として扱い、世代を返さない。

### 前提

- encode に渡した入力の出力は、エンコーダーが閉じない限り、遅れても届く。破棄した記録の出力は後から届くものとして扱う
- エンコーダーのエラーでは WebCodecs がエンコーダーを閉じるため以後の出力は無く、破棄した区間が残っても次の配信の `reset()` で消えるため影響しない
- 記録は積んだが encode に届かなかった入力 (`processAudioFrames()` のループで例外が出て、先読みのフレームを encode せずに抜けた場合など) は、この前提から外れる。その記録の長さを区間に積むと、後続の本物の出力がその長さの分だけ区間に充てられて落ち、以後の出力はその長さの分だけ前の記録に当たり続ける (LOC TIMESTAMP が内容より前へずれ、`reset()` まで残る)。この経路は現状でも (破棄の前に再開すれば) 同じずれを起こす別の問題であり、本 issue の対象外とする (下の「対象外」)
- 長さが分からない出力 (`durationMicros` が null) は 1 フレームを覆うものとして扱う (既存の `recordEncodedChunk()` の消費と同じ仮定)。1 つの出力が複数の投入を覆う構成 (10 ms の `AudioData` を 2 つ読んで 20 ms の packet が出るなど) で長さが null だと、この仮定は成り立たない。その構成では現状でも対応づけが壊れており (`policy: "keep"` では `pendingMs` が `pendingTimeoutMs` まで伸びて時刻がずれ続け、既定の `policy: "drop"` では追いつきが投入をほぼすべて捨てる)、本 issue の規則を入れると区間が戻らずに以後の出力がすべて対応なしになる。この組み合わせは本 issue の対象外とする (下の「対象外」)

### 規則

- `AudioPublishCatchUp` が、`prunePending()` で捨てた区間の合計の長さ (ミリ秒。`PendingFrame.durationMs` と同じ単位) を持つ。破棄は `pending` の先頭から連続して起きるため、区間は 1 つの長さで表せる。
- `recordEncodedChunk()` は、区間が残っている間は、`pending` が空かどうかの判定 (早期 return) より先に、届いた出力の長さをこの区間に古い方から充てる。出力の先頭が区間にある間は、覆った最初の投入の世代を特定できない (記録を捨てている) ため、`timestampMicros` と `generation` を null にして返す。区間の一部だけを覆う出力も null にする (0847 の「1 つの chunk が pause をまたぐ投入を覆う場合は、覆った最初の投入の世代で判定するため、その chunk は捨てる」と同じ扱い)。呼び出し側は既に null の出力を送らない (`handleAudioEncodedChunk()` の `timestampMicros === null` の判定) ため、`src/createMediaPublisher.ts` の変更は要らない。
- 長さが分からない出力 (`durationMicros` が null) は、直前に読んだフレームの長さ (`lastFrameDurationMs`。`evaluate()` が長さの分からないフレームに使う値と同じ) を 1 フレーム分として区間に充てる。区間に先頭があるときの代わりの長さに `pending` の先頭の記録は使わない (`pending` が空なら値そのものが無く、空でなくても先頭は破棄した区間より後ろの別の記録であり、その出力が覆うフレームの長さではないため)。
- 出力が破棄した区間より長い場合は、越えた分を `pending` の記録から消費する (既存のループと同じく、先頭の記録を分割して残りを持ち越す)。消費しないと、次の出力がこの出力の既に覆った記録 (1 つ前) に当たり、逆向きのずれが残る。返すのは対応なしのままにする (覆った最初の投入は破棄した区間にあり、その chunk の LOC TIMESTAMP を正しく決められない)。
- 破棄した区間の長さは `reset()` で 0 に戻す (配信ごとの初期化。残すと、次の配信の先頭の出力 (残った長さの分) が対応なしになり音声が欠ける)。
- 破棄した記録の「数」だけ出力を読み飛ばす方法は採らない。1 つの出力が複数の投入を覆いうるため、破棄した記録の数と、破棄した区間を覆う出力の数は一致しない。長さで数える。
- 破棄した区間の長さは `pendingMs` とは別に持つ。`pendingMs` は「符号化へ渡したまま出力が返っていない音声の長さ」であり、破棄した分は既に引かれている (追いつきの判定 `shouldDrop()` に使う値の意味を変えない)。
- `AudioPublishCatchUpChunkResult` の型は変えない。対応なしは既に null で表せる。

### 対象外

- 記録を積んだが encode に届かなかった入力の扱い (`processAudioFrames()` / `encodeWithSpliceFade()` の例外で先読みのフレームを encode しないまま抜ける経路)。記録が出力の来ないまま残り、破棄の前でも後続の出力の対応づけをずらす。別 issue とする
- 長さが分からない出力 (`durationMicros` が null) が複数の投入を覆う構成での対応づけ。現状でも壊れており、本 issue の規則では区間が戻らなくなる。別 issue とする

## 完了条件

- 破棄した区間を覆う出力が、`recordEncodedChunk()` から `timestampMicros` と `generation` の両方 null で返ること。止めて再開する経路で、破棄の後に届いた止める前に依頼した chunk が送られないこと。
- `src/audioPublishCatchUp.test.ts` に、`pendingTimeoutMs` を短くした `AudioPublishCatchUp` で (既存の「出力が返らないままの記録は、一定の時間で捨てる」テストと同じ形)、次を固定する。
  - 破棄した区間を覆う出力が対応なしになること (破棄した区間の投入を世代 0、破棄の後に積む投入を世代 1 とし、破棄した区間の入力に対応する出力が世代 1 の記録の世代を返さないこと)。
  - 破棄した区間を越える長さの出力でも、越えた分の `pending` の記録が消費され、その次以降の出力が正しい投入の `timestampMicros` に当たること (ずれが残らないこと)。
  - 区間が残ったまま `pending` が空のときに届いた出力も区間に充てられ、その次の本物の出力の対応づけが壊れないこと。
  - `reset()` の後に破棄した区間の長さが残らないこと。
- `src/audioPublishCatchUp.prop.ts` に、任意の間隔で出力が遅れる状況で「破棄した区間を覆う出力は世代を返さず、それ以外の出力は覆った最初の投入の timestamp と世代を返す」性質を足す (`policy: "keep"` で投入を保ち、`pendingTimeoutMs` を短くして破棄を混ぜる)。
- 破棄が無い場合の既存の対応づけ (覆った最初の投入の世代を返すこと) と、既存のテストが変わらないこと。
- `prunePending()` の JSDoc の「注意 (残余リスク)」、`recordEncodedChunk()` の JSDoc と内部のコメント (「記録より長い出力 (捨てた分を覆った、配信の停止をまたいだなど)。残りは捨てる」など)、`AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` の JSDoc (「記録を残す意味が無い」) が、新しい規則と前提に一致していること。
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/audioPublishCatchUp.ts` の `prunePending()` / `recordEncodedChunk()` / `evaluate()` / `reset()` / `lastFrameDurationMs` / `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS`
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `processAudioFrames()` / `pause()` / `resume()`
- `src/audioPublishCatchUp.test.ts` / `src/audioPublishCatchUp.prop.ts`
- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk()`
- `issues/closed/0847-add-close-paused-subgroup.md` (世代で送信を選り分ける規則と、この残余リスクの記録)
- draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams)
- `refs/moq/draft-ietf-moq-transport-23.txt`
