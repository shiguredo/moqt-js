# 未使用の AUDIO_PLAYOUT_MAX_OVERLAP_SECONDS を削除する

- Created: 2026-10-01
- Completed: 2026-10-01
- Branch: feature/refactor-remove-overlap-constant
- Polished: 2026-10-01

## 目的

未使用の定数が残っていると、重なりの扱いについての現在の意図が実装から読み取れず、同じ判定を再導入する誘導になる。0783 の修正で「前の音と重なる音」は捨てる対象ではなくなったため、その名残を消す。

## 現状

- `src/audioPlayout.ts` の `AUDIO_PLAYOUT_MAX_OVERLAP_SECONDS` は定義だけがあり、src / devtools / tests のどこからも参照されていない (ripgrep で確認)
- この定数は、目標の間隔が音の長さと同じときに生じる浮動小数点の誤差を「重なり」とみなして捨てないための閾値だった。`AudioPlayoutScheduler.schedule` は前の音の終わりに繋げて鳴らす実装へ変わり、捨てる判定そのものが無くなっている

## 設計方針

- 定数を削除する。等価な閾値が必要になった場合は、そのときの実装と一緒に定義する
- `CHANGES.md` の `## develop` の `### misc` に [CHANGE] エントリを追記する (削除するシンボル名を書く)
- 冒頭 JSDoc の記述 (0789) と合わせて、重なりの扱いが実装から読める状態にする

## 完了条件

- `src/audioPlayout.ts` から `AUDIO_PLAYOUT_MAX_OVERLAP_SECONDS` が消え、コード (src / devtools / tests) に参照が残らないこと
- `CHANGES.md` の `## develop` の `### misc` に [CHANGE] エントリがあること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

- `src/audioPlayout.ts` から `AUDIO_PLAYOUT_MAX_OVERLAP_SECONDS` とその JSDoc を削除した。参照はコード・テスト・docs に残っていない (ripgrep で確認)
- `CHANGES.md` の `## develop` の `### misc` に [CHANGE] エントリを追加した。削除の理由 (重なりの判定が無くなって参照されず、定義だけが残っていた) と、公開 API に変更がないことを書いた
- 浮動小数点の誤差の説明は `src/audioPlayout.test.ts` のコメントとテスト、`CHANGES.md` の既存エントリに残っており、失われていない
- `vp check` / `tsc --noEmit` / 全 3554 テストが通った。ビルド (`vp run build`) の成果物 (dist/index.d.ts / index.js) は削除の前後で一致し、公開 API への影響が無いことも確認した
