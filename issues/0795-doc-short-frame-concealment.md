# 短いフレームで補間できる周期の範囲を説明する

- Created: 2026-10-01
- Completed: 2026-11-07
- Branch: feature/update-short-frame-concealment-doc
- Polished: 2026-10-01

## 目的

補間は末尾の 2 周期分の相関から周期を求めるため、探せる周期はフレーム長の半分までに限られる (20 ms フレームで約 9.75 ms = 約 103 Hz、10 ms フレームで約 4.75 ms = 約 211 Hz)。10 ms 以下のフレームでは低い基本周波数の音が補間されない。安全側の挙動だが、コメントからは範囲が読めず「補間されない」と誤解される。

## 現状

- `src/playout/audioTimeStretch.ts` の `concealSamples` の JSDoc は、相関が足りない音では補間しないことだけを書いている。`findTailLag` の JSDoc も「2 周期分の末尾が取れない (音が短すぎる) ときは lag 0 を返す」とだけ書いており、どちらもフレーム長で決まる探索範囲を説明していない
- フレーム長ごとの範囲を固定するテストが無い。補間のテストは 20 ms フレームの周期 5 ms と 16 kHz の 20 ms フレームだけである
- `findTailLag` は `2 * lag <= ダウンサンプル後の長さ` の範囲でしか周期を探さない

## 設計方針

- `findTailLag` の条件から、フレーム長ごとに補間できる周期の上限を計算し、`concealSamples` の JSDoc に書く。下限 (`TIME_STRETCH_MIN_LAG`) は探索の開始位置であり、周期が下限より短い音もその倍数の lag で見つかるため、書くのは上限側であること。5 ms フレームでは上限が下限未満になり、一切補間されないことも書く
- 10 ms フレームのテストで、探索範囲の上限を超える周期では補間しないことを固定する (例: 10 ms フレームで 5 ms より長い周期、5 ms フレームは 2.5 ms の 2 周期分すら取れずどの周期でも補間しない)。上限以内の周期では生成することをあわせて固定する
- CHANGES.md への追記は不要 (内部挙動で利用者向けの変更は無い)

## 完了条件

- `concealSamples` の JSDoc に、フレーム長と補間できる周期の関係が書かれていること
- 10 ms / 5 ms フレームのテストで範囲が固定されていること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

- 前提が無くなったため closed にする。補間は出力側の AudioWorklet が行う方式に変わり (`src/playout/audioRenderConcealer.ts`)、周期の探索に使うのは復号フレームではなく Worklet が保持する直近の出力 (`historyLimit` の 30 ms) である。`src/playout/audioExpansion.ts` の `expandAudio` は直近 20 ms で探し、見つからなければ 30 ms の履歴で探し直す。10 ms 以下のフレームでも履歴が溜まれば探索範囲は変わらない
- 入力の長さと探せる周期の関係 (20 ms で約 100 Hz まで、30 ms 以上で `TIME_STRETCH_MAX_LAG` の 66.7 Hz まで) は `concealSamples` の JSDoc に書いた
- フレーム長ごとの範囲を固定するテストは、フレーム長が範囲を決めなくなったため追加しない
