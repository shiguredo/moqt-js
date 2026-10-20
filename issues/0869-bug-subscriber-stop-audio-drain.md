# 購読の停止で予約済みの音声を鳴らし切らずに切り捨てる

- Created: 2026-10-20
- Completed: {YYYY-MM-DD}
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
