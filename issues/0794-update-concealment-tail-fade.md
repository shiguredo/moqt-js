# 補間が上限で切れるときに末尾をフェードして無音へ繋ぐ

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-concealment-tail-fade
- Polished: {YYYY-MM-DD}

## 目的

隙間が上限 (100 ms) を超えるとき、補間は上限で止まり、生成した音の末尾が `AUDIO_PLAYOUT_CONCEAL_END_GAIN` (最大 0.5) の振幅のまま無音へ切り替わる。クリックとして聞こえる可能性があるため、末尾をフェードして無音へ繋ぐ。

## 現状

- `src/audioTimeStretch.ts` の `concealSamples` の `endGain` は 1 から `AUDIO_PLAYOUT_CONCEAL_END_GAIN` (0.5) までしか下げず、末尾を 0 にしない
- `src/audioPlayout.ts` の `concealmentOf` は上限を超えた分を無音のまま残す。補間の末尾の直後は無音になる
- 上限ちょうど (100 ms) の隙間では、補間の末尾がそのまま次の音の開始になる。常に 0 まで下げると音が途切れる
- 呼び出し側は `AudioPlayoutDecision` の `gapSeconds` と `AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS` から上限で切れたかを判定できるが、上限ちょうどとの区別ができない

## 設計方針

- 上限で切れたときだけ、生成した音の末尾 (数 ms) を 0 まで下げる。上限ちょうどでは下げない
- 上限で切れたかを `AudioPlayoutScheduler` が返す (`gapCapped` を追加するなど) か、呼び出し側の判定にするかを決め、決めた理由をコメントに書く。`AudioPlayoutDecision` の形を変える場合はテストを追随させる
- 配備 relay で、上限を超える欠落のときにクリックが無いことを実測する

## 完了条件

- 上限を超える入力で生成した音の末尾が 0 に落ち、上限ちょうどの入力では 0 に落ちないこと (テストで固定)
- 上限内の補間の波形と長さが変わらないこと
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
