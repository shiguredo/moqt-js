# 配信を止めるときに開いている Subgroup を閉じる手段が無い

- Created: 2026-10-13
- Completed: 2026-10-17
- Branch: feature/add-close-paused-subgroup
- Polished: 2026-10-17

## 目的

moqt-js の publisher は、配信を止めても開いている Subgroup ストリームを閉じない。`pause()` はループを止めるだけで MOQT のストリームに触れず、devtools の stop-sending も Publisher を active のまま残す。止めた時点で「もうその Subgroup へ Object を送らない」ことは送信側が知っているため、draft-ietf-moq-transport-22 §11.3.2 の FIN の MUST ("If a sender has delivered all objects in a Subgroup to the QUIC stream ... it MUST close the stream with a FIN.") を満たせるのに満たしていない。

開いたままの Subgroup で次の Object を待つ購読側は、§12.2 の DATA_STREAM_TIMEOUT でセッションを閉じうる (moqt-rs の moq-sub は 30 秒でセッションごと閉じる)。catalog と音声、devtools の event timeline は 1 Group 1 Object のため送信のたびに FIN を出すようにした (issues/closed/0846-bug-catalog-subgroup-fin.md) が、映像は Group が切り替わるまで 1 本の Subgroup を開いたままにする。配信中はキーフレームごとに Group が進むためこの待ちは 2 秒程度で解けるが、`pause()` で送信を止めると次のキーフレームが来ないため、その Subgroup は開いたままになる。

## 現状

- `src/createMediaPublisher.ts` の `pause()` は `processingActive` を下げて世代を進め、状態を `paused` にするだけである。Publisher のストリームには触れない。`resume()` は状態を戻して処理ループを起動するだけであり、開いていた Subgroup の扱い (同じ Subgroup の続きとして送るのか、新しい Group を始めるのか) はどこにも書かれていない。
- `src/createMediaPublisher.ts` の解放経路 (`stop()` / `close()`) は `done()` を通るため FIN が出る。問題になるのは Publisher を active のまま止める経路である。
- `devtools/src/hooks/usePublisher.ts` の stop-sending モード (`sendCompleteCatalog` / `sendPublishDone` / `closeSession` がすべて false) は `stopSendingPaths()` でフレームリーダーと Encoder を止めるだけで、Publisher のストリームを閉じない。PUBLISH とセッションを維持したまま配信だけを止める設計であり、この状態が相手側の timeout に掛かる。
- 止めた時点で開いている Subgroup は映像のものだけである。catalog (`sendCatalogObject`) と音声 (`handleAudioEncodedChunk` が渡すパラメータ)、devtools の catalog / event timeline / 音声は `SendObjectParams.endOfSubgroup` を渡しており、1 Group 1 Object のため送信のたびに FIN で閉じている (issues/closed/0846-bug-catalog-subgroup-fin.md)。映像 (`handleVideoEncodedChunk` から `sendFrameFireAndForget` へ渡すパラメータ) は `endOfSubgroup` を渡さず、Group が切り替わるまで閉じない。
- `SendObjectParams.endOfSubgroup` は「送信する Object が Subgroup の最後である」ことを示す経路であり、送信を止める時点で初めて最後と分かる場合は使えない。止める時点で開いている Subgroup を閉じるには、Object を送らずに Subgroup を閉じる手段が要る。
- Object Status の `END_OF_GROUP` を 1 つ余分に送る方法は採れない。§11.1.1 により Normal 以外の status は payload を持てず、購読側の `handleCatalogObject` は status を見ずに空 payload を復号しようとする (同じ理由で 0846 でも採らなかった)。
- 開いている Subgroup が無い場合 (一度も送っていない、または直前に閉じた) と、省略がある Subgroup (§11.3.2 は FIN ではなく RESET の MUST) の扱いを決める必要がある。
- `src/session/publish.ts` の `closeSubgroupStreamWithoutWaiting` は `omittedObjects` で FIN / RESET を選ぶが、送信キュー (`publisherSendQueues`) には載らない。キューに載るのは `publishClosePublisherStream` だけで、こちらは FIN の完了待ちと `closedSubgroups` のクリアを伴うためそのまま流用できない。
- `src/session/publish.ts` の `publishSendObject` は、送信キューの中で `closedSubgroups` を検査し、閉じた Group への送信を `ClosedSubgroupError` として `publisher.handleError` に渡す (返値の Promise は reject しない)。止める時点で閉じた Group へ送ると、正常な停止でも `onError` が鳴る。
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk` と `handleAudioEncodedChunk` は `processingActive` と世代を見ない。`pause()` の直前に encode を依頼したフレームの出力は `pause()` の後に届き得るため、そのまま送ると閉じた Group への送信になる。
- 映像の Group はキーフレームでだけ進む (`allocateVideoObject`)。`startNewGroup()` は `lastKeyFrameTimestampUs` を消して次のフレームをキーフレームにするが、`state` が `"publishing"` のときだけ効く。
- `pause()` 中に `resume()` した場合は、現状は同じ Group の続きとして送る。一度閉じた Group へは `closedSubgroups` により送れない (`ClosedSubgroupError`)。
- `Publisher` インタフェース (`src/publisher.ts`) にも `src/index.ts` の再エクスポートにも、Object を送らずに開いている Subgroup を閉じる手段が無い。

## 設計方針

- `Publisher` インタフェース (`src/publisher.ts`) に `closeSubgroup(): Promise<void>` を足す。その track で開いている Subgroup を、Object を送らずに閉じる。
  - 開いている Subgroup が無い場合と、Publisher が既に `"closed"` の場合は何もしない (FIN も RESET も出さず、例外も投げない)。devtools の既定の停止は `done()` の後に `cleanupPublisher()` から `stopSendingPaths()` を通るため、閉じた Publisher に呼ぶ経路が必ず通る。ここで throw すると停止の後始末が `isStopping` を戻す前に落ちる (`sendObject` / `sendDatagram` の「closed なら throw」とは扱いを変える)。
  - FIN / RESET の選択は `closeSubgroupStreamWithoutWaiting` の判定 (`omittedObjects` がある Subgroup は RESET) を再利用する (§11.3.2)。
  - 送信キュー (`publisherSendQueues`) に載せ、キュー済みの送信が終わってから閉じる。Group の切り替えで `createUnidirectionalStream()` を待っている送信が閉じた後にストリームを開き直し、FIN が無効になる競合を防ぐ。
  - FIN の完了は待たない (既存の `closeSubgroupStreamWithoutWaiting` の契約)。`done()` が `publishClosePublisherStreamInternal` で完了を待つ既存の形に乗せる。
  - 返値の Promise は reject せず、失敗は `onError` へ通知する (既存の非同期の送信経路と同じ扱い)。
  - `Publisher` インタフェースに載せる (公開面)。devtools は `session.publish()` で得た Publisher から呼ぶ必要があり、内部経路だけでは devtools 側を直せない (0846 と同じ制約)。`Publisher` 型は既に `src/index.ts` から再エクスポートされているため、メソッドの追加だけで devtools から見える。
- `MediaPublisher.pause()` は、開いている Subgroup を `closeSubgroup()` で閉じてから `"paused"` にする。利用者が明示的に呼ぶ経路も API として残すが、`pause()` は暗黙に閉じる。「配信を止めた時点でその Subgroup に続く Object は無い」という §11.3.2 の前提を `pause()` でも満たすための判断であり、後方互換は無い (同じ Group の続きとして再開する挙動は失われる)。
- `resume()` は新しい Group から始める。映像は次に encode するフレームをキーフレームにする (`startNewGroup()` と同じ効果。`lastKeyFrameTimestampUs` を消す)。`state` が `"publishing"` に戻ってから `startNewGroup()` を呼ぶのではなく、`resume()` の中で同じ処理を行い、呼ぶ順序に依存させない。Group ID は単調増加を保つ (`allocateVideoObject` がキーフレームで進める)。
- `pause()` の前に encode を依頼したフレームの出力は、閉じた Subgroup へ送らない。WebCodecs はエンコーダーの出力が入力と同じ順に届くことを保証しない (既定の `latencyMode` は `"quality"`) ため、到着順では判定しない。encode を依頼した時点の世代を記録し、出力がどの依頼に対応するかを引いて、現在の世代と一致するときだけ送る。映像は入力の `timestamp` を鍵にしてよい (`EncodedVideoChunk.timestamp` には対応する入力の `VideoFrame.timestamp` が載る)。
  - 記録は配信ごとに消す。`stop()` のあとの `start()` は同じインスタンスを使い、世代のカウンタは戻さず (`processingGeneration` は増えるだけ)、エンコーダーやフレームソースは作り直す。前の配信の記録を残すと消費されないまま溜まり、同じ鍵を取り違える元にもなる。消す場所は配信ごとの初期化 (`setupEncoders()` の `audioCatchUp.reset()` と同じ位置) とする。
  - 音声は `timestamp` を鍵にできない。`AudioEncoder` の出力の `timestamp` は投入したフレームの値ではなく「最初のフレームの `timestamp` + 符号化したサンプル数」の連続値であり、フレームを捨てると投入より古くなる。`AudioData.timestamp` は同じ値が続くこともある。`src/audioPublishCatchUp.ts` の `recordEncodedChunk` が投入と出力を順番 (FIFO) で対応づけているため、その対応に世代を載せて引く (`AudioPublishCatchUpFrameInput` に世代を渡し、`AudioPublishCatchUpChunkResult` で返す。どちらも公開型のため後方互換は無い)。catch-up の記録は送信の可否より先に行う契約であるため、記録は常に行い、送信だけを止める。
  - 対応する記録が無い出力は送らない。1 つの chunk が pause をまたぐ投入を覆う場合は、覆った最初の投入の世代で判定するため、その chunk は捨てる (resume 直後の 1 chunk を落とすことは許容する)。
- devtools の stop-sending は `stopSendingPaths()` から、映像 / 音声 / catalog / event の各 Publisher の `closeSubgroup()` を呼ぶ。開いている Subgroup が無い track では何もしない。Encoder は `close()` の後も emit 済みの出力をコールバックへ届け得るため、閉じた後に届いた出力は送らずに捨てる (映像と同じ世代の判定を使う)。
- 対象は Subgroup ストリームのみとする。Datagram で送っている場合は閉じる対象が無い。
- 更新対象は `src/publisher.ts` / `src/session/publish.ts` / `src/createMediaPublisher.ts` / `src/audioPublishCatchUp.ts` / `src/codec/types.ts` (必要なら `pause()` / `resume()` の JSDoc) / `devtools/src/hooks/usePublisher.ts` / `docs/LOW_LEVEL_API.md` / `docs/HIGH_LEVEL_API.md` とする。`pause()` の挙動が変わるため、`docs/HIGH_LEVEL_API.md` の `pause()` / `resume()` の説明と状態遷移の補足も更新する。

## 完了条件

- `Publisher.closeSubgroup()` が、開いている Subgroup を Object を送らずに閉じること。実 `WritableStream` の sink で close / abort を観測する `src/session/` の単体テスト (`src/session/publishEndOfSubgroup.test.ts` / `src/session/publishSubgroupClose.test.ts` と同じ形) で、FIN / RESET / 開いていない場合の no-op を固定する。
- 省略がある Subgroup を `closeSubgroup()` で閉じた場合に RESET になること (§11.3.2)。
- 閉じる操作が送信キューに載り、キュー済みの送信の後に実行されること。閉じた後に同じ Group へ送った場合だけ `ClosedSubgroupError` が error 通知として届くこと (返値の Promise は reject しない)。
- `MediaPublisher.pause()` が開いている Subgroup を `closeSubgroup()` で閉じること、`pause()` の前に encode を依頼したフレームの出力が閉じた Subgroup へ送られないこと (送信されずに捨てられること)。`src/createMediaPublisher.test.ts` で、`pause()` が `closeSubgroup()` を呼ぶこと、遅れて届いた出力が送られないこと、`stop()` のあとの `start()` に前の配信の記録が残らないことを固定する。FIN が実際に出ることの観測は `src/session/` の実 `WritableStream` のテストで行う (同ファイルは記録用の最小の Publisher を注入する構成のため)。
- `src/audioPublishCatchUp.ts` の `recordEncodedChunk` が、覆った最初の投入に載せた世代を返すこと。`src/audioPublishCatchUp.test.ts` で世代の対応づけ (対応する記録が無い場合を含む) を固定し、`src/createMediaPublisher.test.ts` で `pause()` の前に encode を依頼した音声フレームの出力が送られないことを固定する。
- `resume()` の後の最初の映像 Object が新しい Group のキーフレームであること。`src/createMediaPublisher.test.ts` で、`pause()` → `resume()` の往復で Group ID が進み、先頭がキーフレームになることを固定する。
- `devtools/src/hooks/usePublisher.ts` の stop-sending (`stopSendingPaths()`) が各 Publisher の `closeSubgroup()` を呼び、Encoder の `close()` の後に届いた出力を送らないこと。`devtools/src/hooks/usePublisher.test.ts` で固定する。
- `closeSubgroup()` の契約 (開いている Subgroup が無い場合と `state` が `"closed"` の場合の挙動、閉じた Group への後続送信の扱い、FIN の完了を待つかどうか) が JSDoc に書かれ、`docs/LOW_LEVEL_API.md` の `Publisher` のメソッド表と `FIN` を出す契機の列挙に `closeSubgroup()` が追加されていること。`pause()` / `resume()` の挙動の変化が `docs/HIGH_LEVEL_API.md` に書かれていること。
- moqt-rs の `moq-sub` を相手に配信を止めたとき、約 30 秒後に `0x12 data stream timeout expired` でセッションが閉じないこと。この確認は moqt-rs を別リポジトリで起動する必要があり自動化できない (実施できなかった場合は PR に記録する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- ソースコードのコメントに issue 番号や issue への言及を書かないこと。

## 解決方法

- `Publisher` に `closeSubgroup(): Promise<void>` を公開 API として追加した (`src/publisher.ts`)。開いている Subgroup を Object を送らずに閉じる。セッション側は `publishCloseSubgroup` (`src/session/publish.ts`) が `publisherSendQueues` に載せ、既存の `closeSubgroupStreamWithoutWaiting` で `FIN` / `RESET` を選ぶ (draft-ietf-moq-transport-22 §11.3.2。見送った Object がある Subgroup は `RESET`)。開いている Subgroup が無い場合と Publisher が `"closed"` の場合は何もしない。返値の Promise は reject せず、内部コールバックの失敗 (同期 throw を含む) は error 通知にする。`FIN` の完了は待たず、`done()` が待つ
- `MediaPublisher.pause()` が開いている Subgroup を閉じるようにした (`src/createMediaPublisher.ts`)。`setState("paused")` の前に閉じる (アプリの `onStateChange` が throw しても後始末が残らないようにする)。閉じた Group へ送り直さないよう、`resume()` は次に encode するフレームをキーフレームにして新しい Group から始める (後方互換性は無い)。実際に閉じる対象は映像だけで、音声と catalog と event は 1 Object ごとに `endOfSubgroup: true` で送るため no-op になる
- 止める前に依頼した符号化の出力を送らないようにした。WebCodecs は出力の到着順を保証しないため、依頼した時点の世代を記録し、出力の到着時に現在の世代と比べる (`src/encodeGeneration.ts` に規則を集約し、moqt-devtools と共有)。映像は入力フレームの `timestamp` を鍵にし、音声は `audioPublishCatchUp` の投入と出力の対応に世代を載せる (`AudioPublishCatchUpFrameInput.generation` / `AudioPublishCatchUpChunkResult.generation`)。`pause()` のたびに `processingGeneration` が進むため、`stop()` / `close()` / 配信のやり直しでも同じ判定になる
- 捨てた出力が持つ codec description は失わない (`pendingAudioConfig` / `pendingVideoConfig`)。configure 後の最初の出力にしか載らないため、捨てると復号に必要な `AUDIO_CONFIG` を以後の配信で送れなくなる (AAC は AudioSpecificConfig が必須で、catalog の Track Property にも載せない)。空の description は「値なし」として扱い、保留値を覆わない (`selectCodecDescription`)。配信ごとの初期化と解放時に破棄する
- `devtools/src/hooks/usePublisher.ts` の stop-sending (`stopSendingPaths()`) が各 track の `closeSubgroup()` を呼び、Encoder を閉じた後に届いた出力と前の配信の保留 config を送らないようにした
- 追加・更新したテスト
  - `src/session/publishSubgroupClose.test.ts`: `FIN` で閉じること、省略がある Subgroup は `RESET` で閉じること、開いている Subgroup が無ければ何もしないこと、送信キューに載りキュー済みの送信の後に閉じること
  - `src/publisher.test.ts`: `onCloseSubgroup` を呼ぶこと、`"closed"` では呼ばないこと、未設定でも throw しないこと、同期 throw / 非同期 reject を error 通知にすること、error コールバックが throw しても reject しないこと
  - `src/createMediaPublisher.test.ts`: `pause()` が Subgroup を閉じること、止める前に依頼した映像 / 音声の出力を送らないこと、再開後はキーフレームで新しい Group を始めること (実ループで記録の実経路まで確認)、配信ごとの初期化で前の配信の記録を消すこと、捨てた出力の Audio Config / Video Config が次の送信で載ること、`selectCodecDescription` の境界
  - `src/encodeGeneration.test.ts` / `src/encodeGeneration.prop.ts`: 境界 (記録が無い出力、同じ timestamp の上書き) と、依頼と停止が任意の順で起き出力の到着順も保証されない状況で最後に依頼した世代の出力だけを送る性質
  - `src/audioPublishCatchUp.test.ts` / `src/audioPublishCatchUp.prop.ts`: 出力が覆った最初の投入の世代を返すこと、記録を消した後の出力は世代を返さないこと
  - `devtools/src/hooks/usePublisher.test.ts`: 送信を止めるときの状態遷移と、stop-sending が 4 track の Subgroup を閉じること
  - `src/testSupport/bidi.ts`: `SessionImpl.publish` と同じ配線に `onCloseSubgroup` を足した (harness 経由の検証が空振りしないようにする)
- `docs/LOW_LEVEL_API.md` (メソッド表、`FIN` を出す契機、契約) / `docs/HIGH_LEVEL_API.md` (メソッド表、状態遷移の説明、一時停止の例) / `src/codec/types.ts` に `closeSubgroup()` と `pause()` / `resume()` の契約を書いた
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」により更新していない (この issue の設計方針でも対象外)

### 残した穴 (別 issue 候補)

- moqt-rs の `moq-sub` を相手にした実機確認 (約 30 秒後に `0x12 data stream timeout expired` でセッションが閉じないこと) は、moqt-rs を別リポジトリで起動する必要があり自動化できないため実施していない (PR に記録する)
- 音声の `prunePending` が 5 秒で捨てた記録の出力が後から届くと、順番で対応づける `recordEncodedChunk` は 1 つ後ろの記録に当てる。その世代が現在の世代と一致すると、止める前に依頼した chunk を止めた後に送り得る (到達には出力が 5 秒以上遅れることが要る)。残余リスクとして `prunePending` の JSDoc に明記した
- 映像の世代の記録は入力 `timestamp` を鍵にするため、停止をまたいで同じ timestamp のフレームが現れると 1 枚落ちる (従来は両方送っていた)。`EncodedVideoChunk.timestamp === VideoFrame.timestamp` が崩れる実装では映像が無言で全損する (計器で気付ける経路が無い)
- `videoEncodeGenerations` には音声側の `prunePending` に相当する掃除が無く、出力が返らなかった記録は次の配信の初期化まで残る (実害は小さい)
- `AudioPublishCatchUpChunkResult` の `timestampMicros` と `generation` は必ず同時に null / 値になるが、型は独立した nullable のままである (判別可能 union にできる)
- devtools は `resolveAudioConfigToSend` を自前実装のまま持ち、ライブラリ版と空 description の扱いが違う (今回の呼び出しは `selectCodecDescription` を通るため正規化される)
