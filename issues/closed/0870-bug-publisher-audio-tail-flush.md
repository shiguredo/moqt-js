# 配信の停止で符号化パイプラインの末尾 30 ms が送られない

- Created: 2026-10-20
- Completed: 2026-10-20
- Branch: feature/fix-publisher-audio-tail-flush
- Polished: 2026-10-20
- Reporter: @voluntas

## 目的

利用者の「playout で最後が聞こえないことがある」との報告を調査した。購読側の停止で予約済みの
音声が切られる経路とは別に、配信側の停止でも末尾が欠けることを単体ハーネスで確認した。
前提は Opus (48 kHz) + Datagram (moqt-devtools の既定、冗長度 2) である。停止時に 10 ms の
ブロック 3 つ分 = 30 ms が符号化・送信されない。購読側が受信済みの音声を鳴らし切っても、
この 30 ms はそもそも届いていないため、末尾の語尾が切れる。

## 現状

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.stop` と `close` は、
  `processingGeneration` を進めてから `disposeAllResources` を呼ぶ。`processAudioFrames` は
  1 フレーム先読みし、世代が変わったフレームを encode せず破棄する。`handleAudioEncodedChunk`
  も世代不一致の出力を送らない。`disposeAllResources` は `cancelFrameReaders`、
  `audioFrameSource.close`、`audioEncoder.close` の順に解放する
- 単体ハーネス (10 ms ブロックを 4 つ投入して停止) で 30 ms の欠落を実測した。内訳は、cancel で
  未読のまま捨てた 1 ブロック、停止直後に読んだが世代不一致で encode されない 1 ブロック、
  encode されたが出力が close の後で捨てられる 1 ブロックである。先読みの pending が
  encode されない経路は無く、捨てられるのは出力側である。`pause` は reader を cancel しない
  ため 20 ms になる
- Opus の encoder は 20 ms のパケットを組むため、停止の位置によっては最大 1 パケット分が
  encoder の中に残る。`AudioEncoderWrapper.close` は encoder の出力を待たずに閉じる
  (`AudioEncoderWrapper` に flush が無い)
- 実リレーの devtools (main thread 符号化) では、停止クリックの 118 ms 後まで encode が
  呼ばれた。encode 入力の総時間 17370 ms と、encode が呼ばれた壁時計の幅 17307 ms の差は
  0.36 % である。devtools は 1 フレーム先読みが無く、`stopPublishing` が `stopSendingPaths`
  まで音声ループを走らせるため、この構成では末尾の欠落を検出できなかった。影響はライブラリの
  `stop` と `close` に限られる
- Datagram は送信完了の通知が無い。PUBLISH_DONE は control stream で送られ、datagram との
  順序保証が無い。購読者は PUBLISH_DONE を受けた時点で購読を closed にし、後から届いた
  datagram を捨てる (`src/subscriber.ts` の `SubscriberImpl.handleEnd` と `handleDatagram`)。
  停止時に書いた末尾の datagram が PUBLISH_DONE より後に届くと失われる。実リレーでは
  観測されなかったが、機序は残る

## 設計方針

- 停止を「新規フレームの読み出しを止める」「1 フレーム先読みを encode する」
  「`AudioEncoder` の flush 相当で出力を待つ」「残りの datagram を書く」
  「PUBLISH_DONE を送る」の順にする。`AudioEncoderWrapper` に flush を足すか、close の前に
  出力の完了を待つ契約にする (WebCodecs の `AudioEncoder.flush` を使える)
- 送るかどうかは世代ではなく「停止の受付時に確定した範囲」で決める。Datagram では Subgroup を
  閉じる処理が無いため、止めた後に送らない規則は「PUBLISH_DONE を送った後に Object を
  送らない」に読み替える
- PUBLISH_DONE と末尾 datagram の順序を守る手段を決める。候補は、PUBLISH_DONE の送信を
  一定時間 (例: 50 ms) 遅らせる、末尾の 2〜3 Object を冗長化する、購読側で PUBLISH_DONE の
  後の短い猶予の間 datagram を受け付ける、である。実装が単純で効果を測れる順に試す
- 捨てた出力の数を統計に出す。`issues/0863-add-dropped-output-stats.md` の
  `droppedEncodedOutputs` の計器と合わせ、停止時に送れなかった量を読めるようにする

## 完了条件

- 単体ハーネスで、stop() の前に読んだフレームがすべて encode され、送信されること
  (30 ms から 0 ms)
- Opus encoder に残った入力が flush で出力され、close の前に送信されること (単体テスト)
- PUBLISH_DONE の後に datagram を送らないことと、末尾の datagram が PUBLISH_DONE より先に
  届く方策が実装されていること
- 実リレーで publisher を停止したとき、購読側が停止後に末尾の Object を 1 件以上受信し、
  停止の所要時間が上限 (drain 55 ms + flush・送信 150 ms + 猶予 50 ms) に収まること
  (購読側の TIMESTAMP と停止時刻の比較は計測用の口が無いため未実施)
- 送れなかった出力が統計に出ること
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

## 解決方法

- 停止の順序を「周期読み出しのループ自身が取り込みキューを読み切る」「1 フレーム先読みを
  encode する」「`AudioEncoderWrapper.flush()` で encoder の出力を待つ」「datagram の
  write / subgroup の送信の完了を待つ」「配送方式にかかわらず 50 ms 待つ」「PUBLISH_DONE」
  に組み替えた。stop / close のたびに `processingGeneration` を先に進めると末尾の出力が
  世代不一致で捨てられるため、末尾 flush の後に進める
- 読み切りの打ち切りは、ループ内で `Promise.race([read, sleep(5 ms)])` を使い、停止の受付時
  に既に capture されていた分だけを末尾に含める。負けた read は後から解決したら閉じて
  捨てる。上限は 4 ブロック / 50 ms、停止の待ちは flush と送信を合わせて 150 ms で打ち切る
  (`tailFlushTimeoutCount` に残す。drain の待ち 55 ms は別に取る)
- `AudioEncoderWrapper.flush()` を追加した。direct は WebCodecs の `AudioEncoder.flush`、
  worker は `flush` / `flushed` メッセージで、worker が flush の出力を `encoded` として
  送ってから `flushed` を返す順序を保証する。`close()` は待っている flush を reject して
  ハングしない
- `Publisher.sendDatagram` の返値を `Promise<void>` にした (write の完了で resolve、失敗は
  従来どおり onError で通知)。停止時は末尾の write の完了を待った後に
  `AUDIO_TAIL_PUBLISH_DONE_GRACE_MS` = 50 ms 待ってから PUBLISH_DONE を送る
- 計器: `AudioStats` に `tailFlushedFrames` / `tailFlushedMs` (flush で送れた末尾)、
  `tailDroppedFrames` / `tailDroppedMs` (読んだが送れなかった末尾)、
  `tailFlushTimeoutCount` (上限で打ち切った回数) を追加した
- 単体ハーネス: 停止前に投入した 10 ms ブロック 4 個がすべて encode・送信され、30 ms から
  0 ms になった。flush の出力が encoder の close と PUBLISH_DONE より前に送られること、
  PUBLISH_DONE の後に datagram が無いこと、二重 stop / close 中の stop、再 start を固定した
- 実ブラウザ + 実リレー: `tests/e2e/relay/audio-publisher-tail.spec.ts` を追加した。library の
  Publisher (worker 符号化の既定) で datagram 配送は停止 102 ms・flush 1 件 20 ms・欠落 0・
  timeout 0、subgroup 配送は停止 44 ms・flush 1 件 20 ms・欠落 0 で、購読者は停止の後に
  末尾を 2 件受信した。全 E2E は 22 件成功 (AAC の 1 件は負荷時の flake で、単体再実行では
  成功)。`vp check` / `tsc --noEmit` / `vp test run` (234 ファイル / 4140 テスト) も成功

## 参照

- 調査記録: `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`
- `src/createMediaPublisher.ts` の `processAudioFrames` / `handleAudioEncodedChunk` /
  `MediaPublisherImpl.stop` / `disposeAllResources` / `sendAudioFrameFireAndForget`
- `src/codec/AudioEncoder.ts` の `AudioEncoderWrapper.encode` / `close`
- `src/publisher.ts` の `sendDatagram` / `done` / `terminate`
- `src/subscriber.ts` の `SubscriberImpl.handleEnd` / `handleDatagram`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.receiveAudioObject` /
  `handleAudioObject`
- `issues/0863-add-dropped-output-stats.md` (送れなかった出力の計器)
- draft-ietf-moq-transport-22 §11.2 (Datagrams) / §11.3.2 (Closing Subgroup Streams)
