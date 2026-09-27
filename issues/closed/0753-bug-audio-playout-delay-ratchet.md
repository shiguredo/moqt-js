# 受信した音声の再生の遅れが、遅れて届いた音の後に上がったまま戻らない

- Created: 2026-09-25
- Completed: 2026-09-28
- Branch: feature/fix-audio-playout-delay-ratchet
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

`src/audioPlayout.ts` の `AudioPlayoutScheduler` は、復号した音声を再生の遅れ (80 ms) だけ遅らせて並べる (closed の `0750`)。鳴らす時刻を過ぎて届いた音で基準を取り直すと、以降はその分だけ遅れて鳴り続け、上限 (300 ms) を超えるまで遅れが下がらない。長く配信すると、途切れのたびに音声の遅れが積み上がり、映像より遅れて鳴る。利用者から「長時間配信するとどうやら遅延が発生してきました」と報告があった。

## 現状

- `AudioPlayoutScheduler.schedule` は、鳴らす時刻が今 + 余裕より前になった音で基準を取り直し、今 + 再生の遅れに置く。以降の音は基準から timestamp の間隔どおりに並べるため、届く時刻が戻っても遅れは下がらない
- 遅れを縮めるのは、遅れが上限 `AUDIO_PLAYOUT_MAX_DELAY_SECONDS` (300 ms) を超えた音を捨てるときだけ
- 実測 (2026-09-25、配備の relay、moqt-devtools、カメラ 1280x720 60fps、マイク Opus、headless Chromium の偽のデバイス): 鳴らす時刻までの余裕は、開始の 10 秒で 180 ms、80 秒以降は 260〜290 ms にとどまった (目標は 80 ms)。基準の取り直しは 346 秒で 15 回、捨てた音は 87 個
- `createMediaSubscriber` と moqt-devtools の subscriber が同じモジュールを使う

## 設計方針

- 遅れが目標より大きい状態が続いたら、少しずつ目標へ戻す
  - 直近の窓 (数秒) の「鳴らす時刻 - 今」の最小値が、目標 + 幅を超えていたら、音を 1 つ捨てて基準をその長さだけ前に寄せる (今の上限を超えたときの捨て方と同じ)
  - 捨てる音は、なるべく小さい音 (復号した音の RMS が小さい、無音に近い) を選ぶ。捨てる間隔には下限を置き、続けて捨てない
- 映像の jitter buffer (`devtools/src/utils/playoutBuffer.ts`) が再生遅延を毎秒 20 ms ずつ戻す作りを参考にする
- 窓の長さ、幅、捨てる間隔は実測で決める。純粋なモジュールのまま、fast-check で「鳴らす音が重ならない」「今 + 余裕以上」「遅れは上限以下」に加え、「届く時刻が落ち着けば遅れが目標へ戻る」を固定する

## 完了条件

- 上の実測と同じ条件で 10 分以上流して、鳴らす時刻までの余裕が目標の近くに戻る (取り直しの後も上がったままにならない)
- 単体テストと fast-check で戻り方を固定する
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 解決方法

closed の `0635` (音声と映像を LOC Timestamp と targetLatency で同期して再生する、Completed: 2026-09-26) で解決済みのため、対応不要として closed にする。根拠は次のとおり。

- 報告したメカニズム (鳴らす時刻を過ぎて届いた音での基準の取り直しによる遅れのラチェット) は 0635 で廃止された。`src/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` は、目標の開始時刻を守るとき (`src/createMediaSubscriber.ts` は映像も購読しているときだけ `enforceTarget` を true にし、moqt-devtools の購読側 (`devtools/src/hooks/useSubscriber.ts`) も同じ) は目標を過ぎた音を捨て、基準を取り直さない (捨てた分は 1 フレームで、次の音から目標へ戻る)。基準の取り直し (`scheduleByArrival`) を使うのは到着基準の経路 (音声のみの購読、壁時計の TIMESTAMP を持たない音、jitter buffer 無効、0754 の TIMESTAMP のドリフトによるフォールバック) だけである
- 「少しずつ目標へ戻す」は `src/playbackTimeline.ts` に実装されている。共有の再生遅延は `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` (毎秒 20 ms) で目標へ戻され (`observe`)、上がったときは直ちに追従する。`src/playbackTimeline.test.ts` の「観測する: 再生遅延を毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND ずつ下げる」と `src/playbackTimeline.prop.ts` で固定されている。この「毎秒 20 ms ずつ戻す作り」は本 issue の設計方針が参考に挙げた jitter buffer の仕組みであり、参照先の `devtools/src/utils/playoutBuffer.ts` は closed の 0762 で `src/playoutBuffer.ts` へ移り、学習は 0635 で `src/playbackTimeline.ts` へ移っている (参照先は現存しない)
- 0635 の実装順に「0753 は本 issue で音声の再生の遅れが共有の値になり、基準の取り直しもやめるため前提が変わる。本 issue を完了後に『共有の再生遅延を目標へ戻す』問題として作り直す」とある。作り直し先の「共有の再生遅延を目標へ戻す」も上記の減衰で満たされているため、本 issue に対応が残っていない
- 本 issue の 2026-09-25 の実測は 0635 より前の到着基準の実装に対するもので、現行実装では計算の前提が変わっている。実機での連続再生の確認は closed の 0636 の「実機での確認」節 (relay で 120 秒、±50 ms) に引き継がれており、送り側の TIMESTAMP のドリフト (到着基準へのフォールバックと取り直しの続発) は 0754 が持つため、本 issue とは別の原因である
