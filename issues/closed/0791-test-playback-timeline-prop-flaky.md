# playbackTimeline の表示時刻の差のプロパティテストがまれに失敗する

- Created: 2026-10-01
- Completed: 2026-10-02
- Branch: feature/fix-playback-timeline-prop-flaky
- Polished: 2026-10-01

## 目的

表示時刻の差の許容 (50 ms) を固定するプロパティテストがまれに失敗し、レビューと CI を不安定にする。失敗する入力を特定して修正し、再発しないようにする。

## 現状

- `src/playbackTimeline.prop.ts` の「120 秒の到着列でも同時刻の表示時刻の差と skewMs が ±50 ms 以内になる」で、同時刻の表示時刻の差が 83.99 ms になる入力が観測された (レビュー中の実行で 1 回だけ失敗し、再実行では成功)
- 生成入力は fast-check のランダム (`fc.integer({ min: 1, max: 1_000_000 })`、`numRuns: 5`) であり、失敗した seed は記録されていない。fast-check は失敗時に counterexample と seed を含むメッセージを出すため、レビュー時のログが残っていれば確認できる。残っていなくても生成器は決定論的 (`seededRandom` と固定の揺らぎ分布) なので、seed を列挙して再現できる
- 再現確認 (2026-10-01): 同じ生成器で seed 1〜300 を列挙すると、50 ms を超える入力が 3 件あった (seed 50: 58.02 ms、seed 139: 80.07 ms、seed 194: 69.93 ms)。最大は 80.07 ms であり、83.99 ms の観測と整合する。約 1% の seed で 50 ms を超え、`numRuns: 5` の 1 回の実行では約 5% の割合で失敗し得る
- 許容 50 ms の根拠は現行実装に無い。±50 ms は 0635 (A/V 同期) が「時計の対応付けの不感帯 (`AUDIO_CLOCK_DEADBAND_MS` = 30 ms) + 映像の write の遅れ (`MAX_PRESENTATION_LAG_MS` = 20 ms)」として決めた予算であり、audioPlayout / playoutBuffer が対象である (closed の 0635 の完了条件)。本 PBT は PlaybackTimeline だけを観測しており、この 2 つは関係しない。`src/playbackTimeline.prop.ts` の冒頭コメントは「±50 ms 以内に収まる」と断言するだけで根拠を書いておらず、`src/playbackTimeline.ts` / `src/streamSynchronization.ts` の冒頭は不感帯 (`SYNC_MIN_DELTA_MS` = 30 ms) とフィルタの説明だけである

## 設計方針

- 失敗する seed と生成列を探索して特定し、最小の入力へ縮小する
- 原因を切り分ける。実装のずれなら実装を直し、テストの前提 (許容の式・生成範囲・warm-up の扱い) が誤りなら前提を直す。許容値を緩めることで隠さない
- 切り分けでは、測っている量と制御している量の対応を確かめる。テストの「同時刻の表示時刻の差」は (基準の遅れの差) + (表示の遅れの差) であり、`updateSyncDelays` (`computeRelativeDelay` と `computeDelays` を使う) が `SYNC_MIN_DELTA_MS` の不感帯に収めているのは「表示の遅れの差 + 直近の観測の offset の差」である。基準の遅れは直近 10 秒の最小値、直近の観測は最後の観測値であり、揺らぎの分だけ異なる。揺らぎは最大 240 ms まで生成されるため、測っている量は不感帯だけでは抑えられず 50 ms を超え得る。失敗する seed で、制御が追いついていないのか測定量と制御量の式の対応が違うのかを切り分ける
- 特定した入力を再現するテストを追加し、回帰を防ぐ
- 同じ 120 秒の到着列を使う他の assert (skewMs) も同時に確認する

## 完了条件

- 特定した入力で修正前に失敗し、修正後に通ることをテストで固定すること
- `vp test run src/playbackTimeline.prop.ts` を複数回実行して再発しないこと
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

切り分けの結果、テストの前提ではなく実装 (A/V 同期の制御) が意図を満たしていないことが分かったため、実装を直した。

- 失敗の再現: seed 50 は 58.0 ms、seed 139 は 80.1 ms、seed 194 は 69.9 ms で失敗する (実測)。120 秒の到着列では 109〜112 ms まで開く場合があった
- 原因は 2 つ。1 つ目は制御量が「表示時刻の差」ではなく「経路の相対遅延 (直近の観測の offset)」だったこと。2 つ目は libwebrtc の `StreamSynchronization` の移植が、1 秒ごとに 4 サンプル平均の半分 (上限 80 ms) しか動かせず、音声の目標遅延 (NetEq の 0.95 分位) が 80 ms から 220 ms へ段差で動くと追いつけないこと。相対遅延を基準 (10 秒窓の最小値) ベースに替える実験でも改善せず、律速はレート制限であることを確認した
- 対策として `updateSyncDelays` を「2 つのトラックの表示時刻 (基準の遅れ + 表示の遅れ) の差が `SYNC_MIN_DELTA_MS` (30 ms) を超えたら、先行する側の表示の遅れを『後行側 - 30 ms』まで即座に上げ、上げた分は毎秒 `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` (20 ms) までで戻す」方式に変更した。足すのは遅らせる向きであり、既に積んだフレームの並べ替えは起きない。観測のたびに行うのは、相手の目標遅延が段差で動いたときに次の観測まで差が開くのを防ぐためである。戻す量は自分の遅延の下限が下がった分だけ減らし、映像の遅延を下げる速さを毎秒 20 ms に保つ
- 基準の差の閾値 (`baseDifferenceLimitMs`) は、キューが吸収できる長さではなく表示の遅れの上限 (`presentationDelayCapMs`) から引くようにした。上限で切られる分は合わせられないためである。`setTargetLatencyMs` は下限が変わった時点で合わせ直し、`resetStream` は同期が足した分を戻す
- 未使用になった `src/streamSynchronization.ts` を削除した (`computeRelativeDelay` / `StreamSynchronization` / `reduceAudioDelay` / `reduceVideoDelay` / 使用されていない定数)。`SYNC_MIN_DELTA_MS` は `playbackTimeline.ts` へ移し、使われなくなった `SYNC_INTERVAL_MS` は削除した
- テスト: seed 50 / 139 / 194 を回帰テストとして固定し (修正前は 58.0 / 80.1 / 69.9 ms、修正後は 30.0 ms)、締められる assert は不感帯まで締めた。既存テストのうち音声を観測して同期を働かせていたものは、本来の対象 (映像の jitter buffer の遅延など) だけを見るよう音声の観測を外した
- 検証: `vp check` / `tsc --noEmit` / `vp test run` (197 files / 3557 tests) が通る。`vp test run src/playbackTimeline.prop.ts` は 50 回連続で成功し、seed 1〜2000 の走査でも差は 30.0 ms を超えなかった。`/review-diff-code` を 3 周回し、致命的・重要 0 件
- 残る制約: 2 つの遅延が表示の遅れの上限 (500 ms、またはキューが吸収できる長さ) に達しているときは合わせられず、ずれは基準の差の閾値 (下限 100 ms) まで広がり得る。`docs/HIGH_LEVEL_API.md` と `src/playbackTimeline.ts` のコメントに明記した
