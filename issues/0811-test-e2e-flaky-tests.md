# e2e テストの間欠的な失敗を調査して安定させる

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-e2e-flaky-tests
- Polished: {YYYY-MM-DD}

## 目的

CI の e2e ジョブが間欠的に失敗し、マージ判断を誤らせる。実際に 0804 の PR (#448) では e2e が失敗し、再実行で pass した。失敗したテストは変更内容 (コメントのみ) と無関係であり、flaky であることが原因と見られる。CI の信頼性を回復するため、原因を特定して安定させる。

## 現状

- `tests/e2e/codec-wrappers.spec.ts` の「VideoEncoderWrapper Worker モード: Worker 経由でも同じ契約が成立する」が PR #448 の e2e で失敗した (58.5 秒で失敗)
- `tests/e2e/devtools-debug-panel.spec.ts` の「Copy for LLM は MOQT URI と fragment の c4m (認可トークン) を伏せる」が同じ run で失敗した (1.0 分)
- 同じ run を再実行すると全 12 チェックが pass した。この 2 件は再現手順が確立していない
- PR #445 でも e2e が失敗している (lint 失敗によるキャンセル)
- 失敗時のログは「The operation was canceled.」で終わっており、テスト側の失敗かジョブのタイムアウトかの切り分けができていない
- e2e の CI ジョブは chromium で WebCodecs (VideoEncoder / AudioEncoder) を使うテストを含み、実行環境の影響を受けやすい

## 設計方針

- まず失敗の再現条件を特定する。ローカルで該当 spec を繰り返し実行し、失敗率と失敗時のログ (タイムアウト / 例外 / Worker の起動失敗など) を記録する
- 原因が判明した場合はテスト側の待機条件・タイムアウトを実態に合わせて直す。原因が環境依存 (WebCodecs の Worker 起動やコーデックの可用性) の場合は、テストの前提を明示して skip 条件を入れるか、対象を絞る
- 原因が特定できない場合は CI のリトライ設定 (失敗時の 1 回再実行) を検討し、その判断理由を issue の解決方法に記録する。リトライで隠す前に、まず原因の切り分けを優先する
- e2e-test ワークフロー (実リレー接続) は draft-21 の実リレーを前提として停止したままにする。本 issue の対象は `ci.yml` の e2e ジョブ (playwright) である

## 完了条件

- 失敗した 2 テストの失敗原因が特定されている (再現手順または失敗時のログの分析結果が解決方法に記録されている)
- 特定した原因に応じた修正 (待機条件 / タイムアウト / skip 条件 / リトライ設定) が入り、根拠が説明されている
- 修正後に該当 spec を繰り返し実行して失敗しないことを確認している
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `tests/e2e/codec-wrappers.spec.ts`
- `tests/e2e/devtools-debug-panel.spec.ts`
- `.github/workflows/ci.yml` の e2e ジョブ
- `playwright.config.ts`
- 失敗した run: PR #448 の `ci` ワークフロー (job: e2e)

## 解決方法

{未着手}
