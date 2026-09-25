# 受信した音声の再生の遅れが、遅れて届いた音の後に上がったまま戻らない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
