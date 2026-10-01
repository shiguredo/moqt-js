# 実リレーへ接続する E2E テストを追加する

- Created: 2026-09-30
- Completed: {YYYY-MM-DD}
- Branch: feature/add-relay-e2e-tests
- Polished: {YYYY-MM-DD}

## 目的

`secrets.TEST_MOQT_URI` は org の secret として存在し `moqt-js` にも公開されているが、リポジトリ側の配線がすべて外れており、実リレーへ接続する E2E テストが 1 本もない。実ブラウザの WebTransport と実リレーを経由しなければ検証できない経路 (SETUP の交換、publish / subscribe、FETCH の終端) は現在テストで覆われておらず、実装差による誤検出と見逃しの門がない。

## 現状

- `tests/e2e/` の spec は 16 ファイル 92 テストで、すべて実リレーを必要としない (moqt-devtools の UI と codec wrapper)。実接続テストは 0 本である
- `.github/workflows/ci.yml` の e2e job は `TEST_MOQT_URI` を注入していない。`playwright.config.ts` は `.env` を読まず、`.env.example` も存在しない
- 2026-06-20 に `test.describe.skip` で実接続テストを停止し、2026-09-14 に到達不能となったハーネス (`tests/e2e/main.ts` の `window.__moqtE2E`、`helpers.ts`、`index.html`、専用 Vite アプリ) ごと削除した。以後 `TEST_MOQT_URI` を読むコードはリポジトリに存在しない
- 同じ secret を使う姉妹リポジトリには先行例がある。`moqt-rs` は `e2e-test.yml` で `secrets.TEST_MOQT_URI` のリレーへ moq-pub を接続し、develop / feature の push と PR で実行して未設定なら skip する。`moqt-py` は `tests/test_connect.py` を `pytest.mark.skipif` で gate している
- `moqt-rs` の E2E は develop で success しており、リレーは CI の runner から到達できる
- `secrets.TEST_MOQT_URI` の値は `moqt://` の URI である。`moqt-rs` は公開ログにリレーのホストやトークンを残さないため、接続先 (authority) と fragment を `::add-mask::` でマスクしている
- 関連する pending の `0443-test-add-e2e-fetch-coverage.md` は「実サーバーを CI で安定して用意できるようになった時点で再開する」として、ハーネスの再作成を待っている

## 設計方針

- `tests/e2e/` に実接続用のテストページ (専用 Vite アプリ) を再作成する。`window.__moqtE2E` に接続 / publish / subscribe / fetch の操作を露出し、spec は `page.evaluate` 経由で呼ぶ。モックやスタブは使わない
- Publisher と Subscriber は開始と観測を分けたハンドル API にする。spec は `expect.poll` で状態を待ち、固定の sleep に依存しない
- spec は `tests/e2e/relay/` に置き、`playwright.config.ts` に `relay` project を追加する。実リレーを必要としないテストとは要求が異なるため project を分ける
- 接続先は環境変数 `TEST_MOQT_URI` で渡す。未設定の環境 (fork からの PR、secret を持たないローカル) では `test.skip` で skip として記録し、暗黙の成功扱いにしない。`describe.skip` は使わない
- `.github/workflows/e2e-test.yml` を新設し、`secrets.TEST_MOQT_URI` を環境変数として渡す。secret が未設定の場合はテストを実行せずジョブを成功させる。接続先の host / authority と fragment は `::add-mask::` でマスクする
- エラーメッセージに接続先が混ざることを防ぐため、テストページ側でも接続先を伏せ字にしてから spec へ返す
- `.env.example` を追加し、ローカルでは `.env` から `TEST_MOQT_URI` を読めるようにする。CI の環境変数を `.env` が上書きしないようにする
- 検証する経路は、SETUP の交換と正常な切断、Canvas のダミー映像の publish / subscribe、FETCH (絶対開始の Location Filter) とする。LOCATION FILTER を省略した FETCH と相対指定 (1 フィールド) は検証に使うリレーが応答を返さないため対象から外し、別の issue で扱う

## 完了条件

- `tests/e2e/relay/` の spec が `TEST_MOQT_URI` の設定された環境で実リレーへ接続し、SETUP の交換、publish / subscribe、FETCH を検証すること
- `TEST_MOQT_URI` が未設定の環境では全テストが skip として記録され、失敗しないこと
- `vp run e2e-test` が実リレーを必要としない 92 テストだけを実行し、従来どおり成功すること
- `.github/workflows/e2e-test.yml` が `secrets.TEST_MOQT_URI` を渡して実リレーのテストを実行し、secret が未設定の場合はジョブを成功させること
- `vp check` / `vp test run` / `vp run e2e-test` / `vp run e2e-test:relay` が通ること

## 解決方法

{未着手}
