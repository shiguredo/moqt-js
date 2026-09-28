# CI の遅い runner で再生時刻の計算のテストがタイムアウトするのを緩める

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/fix-ci-test-timeouts
- Polished: {YYYY-MM-DD}

## 目的

GitHub Actions の runner が遅いとき、再生時刻 (PlaybackTimeline / PlayoutBuffer) の計算を回す重いテストが Vitest のタイムアウトで fail し、無関係な PR や develop の CI が赤くなる。テストが検証する性質は変えず、遅い runner でも完走できる時間の余裕を持たせる。

根拠:

- develop の run 36439629540 (0741 の push) で `src/playoutBuffer.prop.ts` の「揺らぎの p95 が最大の揺らぎのとき、表示間隔は TIMESTAMP の間隔どおりになる」が 5 秒のタイムアウトで fail した
- PR #407 の run 36443559820 で `src/playbackTimeline.prop.ts` の「120 秒の到着列でも同時刻の表示時刻の差と skewMs が ±50 ms 以内になる」が 20 秒、`src/playbackTimeline.test.ts` の「observe: 音声の TIMESTAMP がドリフトしたら基準を共有せず、映像の表示時刻が伸びない」と「recordPresentation: 不感帯と write の遅れを含めても skewMs が ±50 ms に収まる」が 5 秒のタイムアウトで fail した。同じ内容を push し直した run 36443734678 ではすべて pass している
- ローカルの所要時間は、`src/playbackTimeline.prop.ts` の 120 秒の到着列のテストが 2.5〜4.4 秒、`src/playbackTimeline.test.ts` の重い 2 件が 0.9〜1.4 秒である。CI の runner はこれより 10 倍程度遅い

## 現状

- Vitest のテストのタイムアウトは既定の 5 秒である (`vite.config.ts` の `test` に指定が無い)。`src/playbackTimeline.prop.ts` の 120 秒の到着列のテストだけが 20 秒を指定している
- 120 秒の到着列のテストは 5 回の実行で 30 fps と Opus の 120 秒分の観測を回すため、ローカルでも数秒かかる
- CI の遅い runner では 5 秒 / 20 秒を超え、検証内容ではなく実行時間で fail する

## 設計方針

- テストの内容 (到着列の長さ、実行回数、検証する性質) は変えない
- `vite.config.ts` の `test` に `testTimeout: 30_000` を指定し、既定を 5 秒から 30 秒にする
- `src/playbackTimeline.prop.ts` の 120 秒の到着列のテストのタイムアウトを 20 秒から 60 秒にする
- 変更履歴は `### misc` に記載する

## 完了条件

- 再生時刻の計算の重いテストが、CI の遅い runner でもタイムアウトせずに完走する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `vite.config.ts` の `test` に `testTimeout: 30_000` を指定し、Vitest の既定を 5 秒から 30 秒にした
- `src/playbackTimeline.prop.ts` の 120 秒の到着列のテストのタイムアウトを 20 秒から 60 秒にした
- テストの内容 (到着列の長さ、実行回数、検証する性質) は変えていない
