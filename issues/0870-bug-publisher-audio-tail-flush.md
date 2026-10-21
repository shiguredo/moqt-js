# 配信の停止で符号化パイプラインの末尾 30 ms が送られない

- Created: 2026-10-20
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-audio-tail-flush
- Polished: {YYYY-MM-DD}
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
- 実リレーで publisher を停止したとき、購読側で最後に受信した Object の TIMESTAMP と停止
  時刻の差が、パイプライン遅延 (Opus の 20 ms と経路の遅れ) の範囲に収まること
- 送れなかった出力が統計に出ること
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

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
