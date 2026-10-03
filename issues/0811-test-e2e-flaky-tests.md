# CI の e2e ジョブが間欠的にタイムアウトを超えてキャンセルされるのを安定させる

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-e2e-flaky-tests
- Polished: 2026-10-03

## 目的

`ci.yml` の e2e ジョブの実行時間がランナーによって大きく変動し、`timeout-minutes: 15` (closed の 0777 で 10 分から 15 分に引き上げた) を超えてジョブごとキャンセルされることがある。通常は 5〜6 分で終わるため、キャンセルされた run を再実行すれば pass し、マージ判断を誤らせる。実行時間が 15 分を超える原因を特定し、安定して完走できるようにする。

## 現状

GitHub の Actions で確認できる発生記録は次の 2 件である (どちらも 2026-10-02)。

- 0804 の PR (#448) のマージ後の develop の run (#1509): e2e ジョブは 16m15s で、アノテーションに「The job has exceeded the maximum execution time of 15m0s」と「The operation was canceled.」が付いてキャンセル。run を再実行 (attempt 2) すると e2e は 4m45s で成功し、12 個のチェック (lint / build の 3 つ / typecheck の 6 つ / e2e / slack-notify) すべてが pass した
- #445 (0801) の PR ブランチの run (#1500): e2e ジョブは 18m53s で同じ「15m0s 超過」「The operation was canceled.」のアノテーション付きでキャンセル。この run では lint も失敗 (exit code 1) しているが、ci.yml のジョブは互いに独立 (slack-notify だけが全ジョブの完了を待ち、concurrency も無い) のため無関係。マージ後の develop の run (#1501) では lint だけが失敗し、e2e は 12m10s で成功している

- 当初メモされた「2 本のテストが 58.5 秒 / 1.0 分で失敗した」という解釈は、`playwright.config.ts` のテストタイムアウト (30 秒、`timeout: 30_000`) と矛盾し、上記のアノテーションとも整合しない。該当 2 本は、codec-wrappers.spec.ts の「VideoEncoderWrapper Worker モード」と devtools-debug-panel.spec.ts の「Copy for LLM は MOQT URI と fragment の c4m」で実在するが、テストの失敗としての記録は未確認である
- e2e ジョブは `vp run e2e-test` (package.json のスクリプト、`playwright test --project='chromium'`) を実行し、実リレーを必要としない 82 本 (tests/e2e/ 直下の 16 ファイル。relay/ の 3 本は対象外) を `fullyParallel: false` / `workers: 1` で回す
- 直近の成功 run での e2e ジョブの所要時間は 4m45s〜6m48s で、最長は #1501 の 12m10s。遅いランナーでは 15 分を超える。テストごとの所要時間は記録されておらず、遅い原因の切り分け材料が無い
- tests/e2e の大部分は devtools の UI テストと WebCodecs の実ブラウザテストである。codec-wrappers.spec.ts は音声コーデックの選定プローブ (closed の 0634) を含み、実行環境の影響を受けやすい

## 設計方針

- まず実行時間の内訳を取る。15 分を超えた run のログとローカルの `vp run e2e-test` の実行結果から、どのテストが秒数を消費しているかを確認する (ワークフローのキャンセル時点で実行中だったテストが最大の手がかりになる)
- 特定のテストが異常に遅い場合、そのテストの待機条件・タイムアウトを実態に合わせて直す (codec-wrappers.spec.ts の WebCodecs 系、devtools-debug-panel.spec.ts の 1000 件のログ投入系が候補)
- 特定のテストに問題が無く、ランナーの性能差によるものと判断できる場合は、e2e ジョブの `timeout-minutes` を余裕のある値 (20 分など) に上げる。closed の 0777 と同じ割り切りであり、判断根拠 (実測した所要時間の幅) を解決方法に記録する
- テストのリトライ設定 (Playwright の `retries`) は、ジョブのタイムアウトによるキャンセルには効かないため、対策として導入しない。テスト側の flaky が判明した場合のみ個別に検討する
- e2e-test ワークフロー (実リレー接続) は、リレーが draft-22 に対応するまで自動実行を止めたままにする (e2e-test.yml は workflow_dispatch のみ)。本 issue の対象は `ci.yml` の e2e ジョブである

## 完了条件

- e2e ジョブがタイムアウトでキャンセルされなくなる。`timeout-minutes` を変更する場合は、その値の根拠が解決方法に記録されている
- 15 分を超えた run について、何が遅かったのかが特定されている (テストごとの所要時間の記録、または再現の試行と結果)
- 修正後に `vp run e2e-test` が通り、e2e ジョブの所要時間がタイムアウトに収まることを複数回確認している
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `tests/e2e/codec-wrappers.spec.ts` (VideoEncoderWrapper Worker モードのテスト)
- `tests/e2e/devtools-debug-panel.spec.ts` (Copy for LLM の c4m 伏せ字のテスト)
- `.github/workflows/ci.yml` の e2e ジョブ (`timeout-minutes: 15`)
- `playwright.config.ts` (`timeout: 30_000`、`workers: 1`、`fullyParallel: false`)
- `package.json` の `e2e-test` スクリプト
- 失敗した run: develop の #1509 (attempt 1) / #445 (0801) ブランチの #1500、再実行: develop の #1509 (attempt 2)
- closed の 0777 (e2e ジョブのタイムアウトを 10 分から 15 分にした経緯)

## 解決方法

{未着手}
