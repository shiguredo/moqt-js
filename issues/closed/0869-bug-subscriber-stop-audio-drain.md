# 購読の停止で予約済みの音声を鳴らし切らずに切り捨てる

- Created: 2026-10-20
- Completed: 2026-10-20
- Branch: feature/fix-subscriber-stop-audio-drain
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

利用者から「playout で最後が聞こえないことがある」との報告があり、実リレー経由で購読音声を
収録して停止時の挙動を測った。計測の構成は Opus (48 kHz) + Datagram (moqt-devtools の既定、
冗長度 2) である。購読側で Stop を押すと、既に予約した音声のうち 7 件 / 121.3 ms (3 回の
計測で 121.3 / 124.0 / 121.7 ms) が鳴らないまま `AudioContext` が閉じられる。停止の直前に
話された約 0.12 秒が聞こえない。配信側の停止ではこの現象は起きない。

停止の時点で受信済みの音声を鳴らし切り、末尾を欠けさせないようにする。

## 現状

- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.stop` は、
  `AudioPlayoutSession.recordStopped` を呼んだ直後に `AudioContext.close()` する。
  `devtools/src/hooks/useSubscriber.ts` の `stopAudioPlayback` も同じである。予約済みの音は
  目標遅延 (計測時は `appliedMs` = 100 ms) と 1 フレーム (20 ms) の分だけ先に積まれている。
  切った量は `missedByReason.stopped` に残るが、鳴らし切る処理は無い
- `preDecodeDelayMs` が 0 より大きいときは、`MediaSubscriberImpl.disposeAllResources` が
  `audioPreDecodeStage.stop()` を呼び、`PreDecodeDelayStage.stop` がタイマーとキューを捨てる。
  保持中の Object は復号へ流れない。失われる量は最大で `delayMs` 分である (2000 ms の設定で
  20 ms の Object 3 件 = 60 ms を実測)。devtools も同じで、遅延を 0 に動的に変えたときだけ
  `flush` する
- 配信側の停止 (stop-sending / close-session / publish-done) では、購読側の状態は connected の
  ままで、停止操作の後 +163〜+234 ms 音が続いた。切られた予約は 0 件である。購読側自身の
  stop とセッションの close だけが対象になる
- 切断量は目標遅延に依存する。実測は目標遅延が上限 (100 ms) に張り付いた条件であり、
  静かな条件 (目標 50 ms) では測っていない
- 計器の `missedByReason.stopped` は切った量を返すが、drain で鳴らせた量を読む手段は無い

## 設計方針

- 停止を「新規の受信と復号を止める」「予約済みが鳴り終わるまで待つ」「`AudioContext` を
  閉じる」の段階に分ける。待ち時間は、最後に鳴り終わる予約の時刻から現在までに余裕
  (例: 100 ms) を足し、0〜300 ms にクランプする
- 復号前の段は stop ではなく flush して復号へ流す。flush した分も待ち時間に含める
- `MediaSubscriber.stop` は Promise を返すため待ちを追加できる。`docs/HIGH_LEVEL_API.md` の
  状態遷移と `docs/PLAYOUT_DELAY.md` の停止時の記述を更新する
- devtools の停止は同期関数である。drain の完了を待つ非同期の停止に変え、停止中であること
  を UI に出す。即座に閉じる必要がある利用者向けに待たない指定を残すかは設計時に決める
- drain で鳴らせた量と、上限で切った量を統計に出す

## 完了条件

- 実リレーで購読側の Stop を押したとき、`missedByReason.stopped` の増分が 0 件
  (上限で切った場合だけ残る) になること。3 回の再現で確認する
- `preDecodeDelayMs = 2000` で停止しても、保持中の Object が復号と再生へ流れること
  (単体テスト)
- 停止に要する時間が上限 (例: 300 ms) を超えないこと (単体テスト)
- `MediaSubscriber.stop` の契約と docs が更新されていること
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

## 解決方法

- 停止を「受信停止 → 復号前の段を flush → 予約済みの drain (上限 300 ms) → 復号停止 →
  `AudioContext.close`」の順に組み替えた。停止の要求後は新しい音声 Object を受け付けず
  (`audioReceiveStopped`)、drain の間は flush した Object だけを復号する
  (`audioDecodeStopped`)。drain の後に届いた復号出力は予約せず閉じる
- `AudioPlayoutSession.drainReserved` を追加し、ライブラリと devtools で共有した。待ち時間は
  「最後に鳴り終わる予約 - 現在 + 余裕 100 ms」を 0〜300 ms にクランプする。flush した
  Object の復号出力は timestamp で対応させ、flush 分だけが 0 になるまで待つ (停止の前に
  復号器へ投入していた Object の出力では減らさない)。予約が無くても、flush があれば上限まで
  待つ (復号が終われば早く終わる)。`stop` は 300 ms、`close` とピア起点の close は 150 ms、
  start 失敗の巻き戻しは drain しない
- 計器: `AudioPlayoutTimingSnapshot.lastDrain` に、停止時の予約残 (`pendingMsAtStart`)、
  要求した待ち時間 (`requestedMs`)、実際の待ち時間 (`waitedMs`)、鳴らすことになった量
  (`playedMs`)、切った量 (`cutMs`)、flush した件数 (`flushedObjects`)、復号の出力が届かず
  切った件数 (`undecodedFlushedObjects`) を足した。`missedByReason.stopped` の意味は
  変えていない
- devtools: `SubscriberAudioStop` に停止処理を切り出し、`stopAudioPlayback` を非同期化した。
  二重停止は同じ Promise を共有し、停止中は `Finishing audio playback...` を出してボタンを
  無効にする。パネルの削除・アンマウント・セッションの close は fire-and-forget で drain し、
  `AudioContext` は必ず閉じる (flush や drain が失敗しても閉じる)。音声の再生トグルを OFF に
  しただけでは購読を止めないため、復号前の段を flush せず、復号チェーンへの接続も外さない
- 実リレーの検証 (3 回): `missedByReason.stopped` の増分は 0 件、`lastDrain.cutMs` は 0 ms、
  drain の待ち時間は 51〜153 ms、停止の完了 (statusMessage が `Ready to subscribe` へ戻るまで)
  は 94〜209 ms だった。修正前は 7 件 / 121〜124 ms が切られていた
- `preDecodeDelayMs = 2000` の検証: 保持分を 200 件 flush し、drain の 225.7 ms は鳴らせたが、
  上限 300 ms を超える 1467.8 ms は `stopped` に計上した。上限までに復号の出力が届かなかった
  flush 分は件数だけ `lastDrain.undecodedFlushedObjects` に残る (復号していないため長さは
  分からず、`stopped` には入らない)。保持分をすべて鳴らすには設定した遅延の分だけ停止を
  待つことになり、停止の応答性と取引になるため、上限内だけ鳴らす設計にした
- 実リレーの既存 E2E は 21 件成功 (skip 11)。`vp check` / `tsc --noEmit` /
  `vp test run` (234 ファイル / 4137 テスト) も成功

## 参照

- 調査記録: `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`、`docs/PLAYOUT_DELAY.md`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.stop` / `disposeAllResources` /
  `releasePendingAudioObjects`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.recordStopped` /
  `releaseAudioContext`
- `src/playout/audioPlayoutTimingStats.ts` の `AudioPlayoutTimingStats.recordStopped` /
  `pending`
- `src/playout/preDecodeDelayStage.ts` の `PreDecodeDelayStage.stop` / `flush`
- `devtools/src/hooks/useSubscriber.ts` の `stopAudioPlayback` / `teardownSubscriber` /
  `resetPreDecodeDelay`
- `devtools/src/hooks/subscriberPreDecodeDelay.ts` の `SubscriberPreDecodeDelay.stop`
- `docs/HIGH_LEVEL_API.md` の状態遷移
