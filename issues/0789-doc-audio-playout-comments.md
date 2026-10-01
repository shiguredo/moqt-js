# audioPlayout の古いコメントを実装に合わせる

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-audio-playout-comments
- Polished: 2026-10-01

## 目的

`src/audioPlayout.ts` の冒頭 JSDoc と `src/audioPlayout.test.ts` のコメントが現行の実装と逆のことを書いており、読む人を誤らせる。規則はコメントと実装の両方から同じことが読める状態にする。

## 現状

- `src/audioPlayout.ts` の冒頭 JSDoc は「目標の時刻を過ぎて届いた音、並べすぎの音、前の音と重なる音は捨てる」と書いている
- `AudioPlayoutScheduler.schedule` の実装は、目標を過ぎて届いた音も前の音と重なる音も捨てず、今から鳴らせる最も早い時刻へずらし、ずらした分を時間圧縮で詰める。捨てるのは並べすぎの音と、目標から 500 ms を超えて離れた音だけである (0783 の修正)
- `src/audioPlayout.ts` の schedule の中のコメントは新しい規則を書いており、冒頭の JSDoc だけが古い
- `src/audioPlayout.test.ts` の冒頭と到着基準のテストのコメントも古い規則のままである (「目標を過ぎて届いた音・並べすぎの音・前の音と重なる音を捨て」「目標を守るときは捨てる」)。テスト名と期待値は現行の規則を固定しており、コメントだけが食い違っている

## 設計方針

- `src/audioPlayout.ts` の冒頭 JSDoc の箇条書きを、実装時の実装が持つ規則へ書き直す
  - 目標を過ぎた音と前の音と重なる音は、今から鳴らせる最も早い時刻へずらして鳴らし、ずらした分を時間圧縮で詰める
  - 並べすぎの音と、目標から 500 ms を超えて離れた音は捨てる
- 前の音の終わりより後ろに空いた分の扱いは、0786 の実装 (直前の音の時間伸長による補間) を前提にして書く。この issue は 0786 の実装を前提にする
- 目標を守るとき (`enforceTarget`) と到着基準 (`scheduleByArrival`) の規則を区別して書く。到着基準では、届かなかった音は捨てずに基準を取り直し、並べすぎの音は捨てること。壁時計の TIMESTAMP を持たない音が目標を持たないことも、現在の JSDoc と同じように書く
- `src/audioPlayout.test.ts` の冒頭と到着基準のコメントを、テスト名と期待値に合わせて直す (テスト名と期待値は変えない)
- 「捨てる」「鳴らす」の言葉を実装のコメントと揃える
- `CHANGES.md` の `## develop` の `### misc` に [UPDATE] エントリを追記する

## 完了条件

- `src/audioPlayout.ts` の冒頭 JSDoc の記述と `schedule` / `scheduleByArrival` の実装が一致していること (コードを読んで確認できること)
- `src/audioPlayout.test.ts` のコメントがテスト名と期待値に一致していること
- `CHANGES.md` の `## develop` の `### misc` に [UPDATE] エントリがあること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
