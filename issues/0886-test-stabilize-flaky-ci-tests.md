# CI で間欠的に失敗するテストを安定させる

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-flaky-tests
- Polished: {YYYY-MM-DD}

## 目的

CI の e2e job と build job が間欠的に失敗し、develop が赤くなる。2026-10-27 から 2026-11-02 にかけて確認した失敗を分類し、テスト側の誤った前提と実装側の不具合を根本原因から直す。あわせて、失敗時に原因を追える診断情報を CI に残す。

## 現状

- 2026-11-02 の develop の ci (run 41368654670) で `tests/e2e/media-playout-short-frames.spec.ts` の「192 サンプルの連続予約でも開始と接続を滑らかにする: conceal」が `maximumStep < 0.006` で失敗した。出力波形に 0.1 から 0.3 への段差 0.2 が残った
- 同じ spec の drain の検査は `cutMs` を `reservedEndSeconds - endAtDrain` と比べていた。`cutMs` は鳴らせなかった予約の長さであり、予約開始前の lead を含まない。出力時計が止まったときは予約開始が未来のまま drain が上限で打ち切られ、差が lead の分だけ開くため、実装が正しくても失敗する (負荷時に 600 回中 2 回再現)
- 段差の原因は `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.scheduleByArrival` にある。到着基準の開始時刻を `nowSeconds + minLeadSeconds` へ押し戻したとき、`PlayoutAnchor` (timestamp と鳴る時刻の対応) を更新していなかった。次の音の予想開始が古い対応で計算され、`snapToPreviousEnd` が前の音の終わりへ揃えるため、媒体の 1 ms の穴が消える。出力側 (`src/playout/audioRenderConcealer.ts`) は連続した実音として扱うため復帰のフェードが入らず、段差が残る。実 `AudioContext` を `latencyHint: "playback"` で動かすと 10 回中 10 回再現した
- `src/playout/audioOutputRenderer.ts` の `AudioOutputRenderer.prepare` は実出力の時計が動き出すまで 1000 ms 待つ。headless Chrome に CPU 負荷をかけると 1000 ms を超え、`Audio output clock did not start within 1000 ms` で E2E が失敗した (78 回中 1 回再現)
- `playwright.config.ts` は `trace: retain-on-failure` を設定しているが、`.github/workflows/ci.yml` の e2e job と `.github/workflows/e2e-test.yml` の relay job は `test-results/` を artifact として保存していないため、失敗時の trace と attachment が失われる
- 過去の build job のフレーキーは develop 上で修正済みであることを再現試行で確認した。`src/playout/videoPlayoutSession.test.ts` のアイドル判定は注入した時計へ揃えられており、`src/playout/timingSummary.prop.ts` の符号付きゼロは正規化され、`src/createMediaPublisher.test.ts` の再 start のテストは削除されて E2E が担当している
- 2026-10-31 の `media-playout-quality.spec.ts` の gapCount、`devtools-audio-output-latency.spec.ts` の音声出力取得、`playout-measurement-guards.spec.ts` の音声 Context の失敗は、現行コードでは 40〜100 回の繰り返しで再現しなかった

## 設計方針

- 到着基準の予約で開始時刻を動かしたときは、実際に置いた開始時刻の分だけ `PlayoutAnchor` をずらす。`AudioPlayoutSession` は `startBuffer` が開始を押し直した分を `AudioPlayoutScheduler.confirmStartPush` で返す
- 押し戻しと押し直しの両方を決定的な単体テストで固定する。E2E だけに依存させない
- short-frames の drain の検査は、予約の実際の開始時刻と終端から未描画の予約長を求め、`cutMs` と比べる。未描画を再生済みと報告する退行は引き続き検出する。assert を緩めることや固定 sleep の追加でフレーキーを隠さない
- 音声出力時計の開始待ちは、負荷時の実測を踏まえて 1000 ms から 3000 ms へ広げる。動き出した時点で待ちを抜けるため、通常の待ち時間は増えない
- CI は失敗時だけ `test-results/` を artifact として保存する。relay job は再実行の前に 1 回目の結果を退避し、再実行の結果と別の artifact 名で保存する
- 再現しなかった過去のフレーキーは、証拠が無いため変更しない

## 完了条件

- `tests/e2e/media-playout-short-frames.spec.ts` の 12 テストが `--repeat-each=20` で安定する
- 到着基準の押し戻しと押し直しを固定する単体テストがある
- 音声出力時計の開始待ちが、CPU 負荷時に 1000 ms では足りなかった実測を踏まえた長さになっている
- CI の e2e job と e2e-test job が、失敗時に Playwright の診断情報を artifact として残す
- `vp check` / `vp exec tsc --noEmit` / `vp test run` / `vp run e2e-test` / `vp run e2e-test:production` が通る

## 参照

- `.github/workflows/ci.yml` / `.github/workflows/e2e-test.yml` / `playwright.config.ts`
- `src/playout/audioPlayout.ts` / `src/playout/audioPlayoutSession.ts` / `src/playout/audioOutputRenderer.ts`
- `tests/e2e/media-playout-short-frames.spec.ts`
- 失敗した run: develop 41368654670 / feature/fix-video-presentation-vsync 41334731139
- closed `0791-test-playback-timeline-prop-flaky.md` (フレーキーを実装の修正で解消した例)

## 解決方法

{未着手}
