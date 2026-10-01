# 短いフレームで補間できる周期の範囲を説明する

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-short-frame-concealment-doc
- Polished: {YYYY-MM-DD}

## 目的

補間は末尾の 2 周期分の相関から周期を求めるため、探せる周期はフレーム長の半分までに限られる (20 ms フレームで約 9.75 ms = 約 103 Hz、10 ms フレームで約 4.75 ms = 約 211 Hz)。10 ms 以下のフレームでは低い基本周波数の音が補間されない。安全側の挙動だが、コメントからは範囲が読めず「補間されない」と誤解される。

## 現状

- `src/audioTimeStretch.ts` の `concealSamples` の JSDoc は「2 周期分の末尾が取れない (音が短すぎる) ときは lag 0」とだけ書いている
- フレーム長ごとの範囲を固定するテストが無い。補間のテストは 20 ms フレームの周期 5 ms と 16 kHz の 20 ms フレームだけである
- `findTailLag` は `2 * lag <= ダウンサンプル後の長さ` の範囲でしか周期を探さない

## 設計方針

- `findTailLag` の条件から、フレーム長ごとに補間できる周期の範囲を計算し、`concealSamples` の JSDoc に書く
- 10 ms フレームのテストで、範囲の下限より低い周期 (例: 5 ms フレームでは補間しない、10 ms フレームでは 5 ms より長い周期で補間しない) を固定する。範囲内の周期では生成することをあわせて固定する
- CHANGES.md への追記は不要 (内部挙動で利用者向けの変更は無い)

## 完了条件

- `concealSamples` の JSDoc に、フレーム長と補間できる周期の関係が書かれていること
- 10 ms / 5 ms フレームのテストで範囲が固定されていること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
