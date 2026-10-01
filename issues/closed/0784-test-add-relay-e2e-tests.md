# 実リレーへ接続する E2E テストを追加する

- Created: 2026-09-30
- Completed: 2026-10-01
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

`secrets.TEST_MOQT_URI` を渡して実リレーへ接続する E2E テストを追加した。

変更内容:

- `tests/e2e/` に実接続用のテストページ (専用 Vite アプリ) を再作成した。`main.ts` が `window.__moqtE2E` として `connectRelay` / `startPublisher` / `getPublisher` / `stopPublisher` / `startSubscriber` / `getSubscriber` / `stopSubscriber` / `startFetch` / `getFetch` / `stopFetch` を公開する。Publisher と Subscriber は開始と観測を分けたハンドル API にし、spec は `expect.poll` で状態を待つ (固定の sleep に依存しない)
- テストページは接続先の URI と host を保持し、エラーメッセージは伏せ字にしてから spec へ返す。FETCH の応答には 30 秒の上限を設け、届かない場合は何を待っていたかをメッセージに残す
- `tests/e2e/relay/` に 3 本の spec を追加した:
  - `connect.spec.ts`: SETUP の交換が完了して `state` が `connected` になり、`close()` で close code 0 の通知が届く
  - `pubsub.spec.ts`: Canvas のダミー映像を VP8 で publish し、同じ namespace を subscribe してカタログ、映像トラック、キーフレームの受信までを確認する
  - `fetch.spec.ts`: 絶対開始の Location Filter (`{ startGroup, startObject }`) を指定した FETCH で end が通知され、error が 0 で、指定した Group より前の Object が混ざらないことを確認する
- 接続先は環境変数 `TEST_MOQT_URI` で渡す。未設定の環境では `requireRelayUri()` が `test.skip` を呼び、skip として記録する。`describe.skip` は使わない
- `playwright.config.ts` に `relay` project (spec は `tests/e2e/relay/`) と実リレー接続用テストページの webServer (port 5180) を追加し、`.env` があれば `process.loadEnvFile` で読み込むようにした。`process.loadEnvFile` は既存の環境変数を上書きしないため、CI の secret が優先される
- `package.json` に `e2e-test:relay` を追加した。`e2e-test` は従来どおり実リレーを必要としないテストだけを実行する
- `.github/workflows/e2e-test.yml` を追加した。`push` (develop / feature/**) と `pull_request`、`workflow_dispatch` で起動し、`secrets.TEST_MOQT_URI` を環境変数として渡す。secret が未設定の場合はテストを実行せずジョブを成功させる。接続先の host / authority と fragment を `::add-mask::` でマスクする
- `.env.example` を追加した

検証:

- `vp check` と `vp test run` (197 ファイル / 3525 テスト) が通る
- `vp run e2e-test` (実リレーを必要としない 92 本) が通る
- `TEST_MOQT_URI` が未設定の環境で `vp run e2e-test:relay` の 3 本が skip として記録される
- `e2e-test` workflow で 3 本が実リレーに対して成功する (connect 2.4 秒 / fetch 5.3 秒 / pubsub 5.7 秒、合計 25.2 秒)

残した課題:

- LOCATION FILTER を省略した FETCH と 1 フィールドの相対指定の FETCH は、検証に使うリレーが FETCH_OK を返さないため CI の対象から外した。別の issue で扱う
- `TEST_MOQT_AUTH_TOKEN` は org の secret に存在しないため、Authorization Token を伴う接続の e2e は対象外とした
