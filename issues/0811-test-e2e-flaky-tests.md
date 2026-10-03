# CI の e2e ジョブが間欠的にタイムアウトを超えてキャンセルされるのを安定させる

- Created: 2026-10-03
- Completed: 2026-10-03
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
- e2e-test ワークフロー (実リレー接続) は、リレー (sora-moq) が draft-22 に対応したため自動実行を再開した (PR #457)。本 issue の対象は `ci.yml` の e2e ジョブであり、e2e-test ワークフローの所要時間は別途扱う

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

所要時間の内訳を実測した結果、特定のテストが遅いのではなく、テスト全体の合計がランナーの性能に比例して伸びることが原因と分かった。テストの内容と並列度は変えず、`ci.yml` の e2e ジョブの `timeout-minutes` を 15 分から 20 分に引き上げた。

### 1. テストごとの所要時間 (ローカル、Apple Silicon)

`npx playwright test --project=chromium --reporter=json` で 92 テストの所要時間を計測した。

- 合計 45.1 秒、最も遅いテストでも 2.3 秒 (devtools-debug-panel「行のコピーで、その行だけがコピー済みの表示になる」)
- 上位は c4m-devtools の鍵生成 1.8 秒 / 1.4 秒、codec-wrappers のコーデック未設定系 1.6 秒 / 1.1 秒、devtools-debug-panel の 1000 件ログ 0.9 秒で、**突出して遅いテストは無い**
- 起動から終了までの wall time は 48.6 秒 / 48.3 秒 (2 回連続で 92 件すべて pass)

### 2. CI のジョブ内訳 (run 37125843228、e2e ジョブ 9 分)

| ステップ                                 | 所要時間              |
| ---------------------------------------- | --------------------- |
| setup-vp                                 | 46s                   |
| vp install                               | 2s                    |
| playwright install --with-deps chromium  | 97s                   |
| **vp run e2e-test (ビルド + 92 テスト)** | **414s (6 分 54 秒)** |
| 合計                                     | 約 9 分               |

ローカルでは 92 テストが 45 秒なのに対し、CI の 2 vCPU ランナーでは 414 秒 (1 テストあたり約 4.5 秒、ローカルの約 9 倍) かかる。**テスト実行時間はランナーの CPU 性能に比例して伸びる**ため、遅いランナーでは 15 分を超えてキャンセルされる。テスト側に直すべき遅さは無い (振幅はランナー性能差)。

### 3. 修正

- `.github/workflows/ci.yml` の e2e ジョブの `timeout-minutes` を 15 から 20 に変更した
- コメントに実測値 (ローカル 45 秒 / CI 414 秒、遅いランナーでは 15 分超) と、テストの内容と並列度を変えない理由を残した

### 4. 検討して採らなかった案

- `e2e-test` スクリプトから `vp run build` を外す: `tests/e2e/vite.config.ts` と `devtools/vite.config.ts` は `moqt-js` を `src/index.ts` にエイリアスしており、テスト自体はビルド成果物を使わない。ただし CI の `build` ジョブで計測した `vp run build` は 3 秒であり、削っても効果が無いため変更しない
- 並列度 (`workers` / `fullyParallel`) を上げる: devtools の UI テストはサーバーと画面状態を共有するため、issue の設計方針どおり変更しない
- Playwright の `retries`: ジョブのタイムアウトによるキャンセルには効かない
- Playwright のブラウザのキャッシュ: 97 秒のステップを削れるが、9〜20 分のジョブに対して効果が小さく、設定が増えるため見送る

### 5. 検証

- ローカルで 92 件 pass を 2 回連続で確認 (48.6 秒 / 48.3 秒)
- 本 issue の PR の CI では e2e ジョブが 5 分 19 秒 (テストステップ 194 秒) で完走し、全チェックが pass した
- **同じ 92 テストでも CI 上では 194 秒 (今回) と 414 秒 (前述の run) で 2 倍以上の幅がある**。これは「テスト実行時間がランナー性能に比例して伸びる」という結論と整合し、15 分の上限では遅いランナーで超過し得ることを裏付けている
- `vp check` / `tsc --noEmit` / `vp test run` が通る
