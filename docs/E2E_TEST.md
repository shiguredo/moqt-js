# E2E テスト

Playwright による E2E テストは、実リレーを必要としないもの、実リレーへ接続するもの、
利用側の production ビルドを検証するものに分かれています。

```bash
# 実リレーを必要としないテスト (moqt-devtools / c4m-devtools / webtransport-devtools の UI、codec wrapper)
vp run e2e-test

# 実リレーへ接続するテスト (SETUP の交換、publish / subscribe、FETCH、音声の往復、カタログ)
vp run e2e-test:relay

# 利用側 Vite の production ビルドで worker が起動するかの検証
vp run e2e-test:production
```

`vp run e2e-test:production` は `moqt-js` を `dist` 経由で消費する最小アプリを
production ビルドし、`new Worker` へ渡る参照先が自己完結していることと、実 Chromium の
実 Worker として起動して初期化へ応答することを検証します。`vp run e2e-test:relay` は
実リレーへ接続する production ビルドの検証も含みます。

初回は Chromium をインストールしてください。

```bash
vp exec playwright install --with-deps chromium
```

Safari 相当 (WebKit) の確認は macOS の開発機で実行します。Safari は
`MediaStreamTrackProcessor` をメインスレッドに公開しておらず、音声は Web Audio 経由で
取り出すため (`src/audioSource.ts`)、その経路を実機と同じ WebKit で確かめます。実リレーへ
接続するテストは `TEST_MOQT_URI` が設定されている場合だけ実行します。

```bash
vp exec playwright install webkit
vp exec playwright test --project=webkit
```

Playwright の設定は `.env` があれば読み込みます。実リレーへ接続するテストは、接続先の
`TEST_MOQT_URI` (`moqt://...`) が設定されていない場合は skip します。設定方法は
[.env.example](../.env.example) を参照してください。CI では `secrets.TEST_MOQT_URI`
を環境変数として渡し、push と pull request で実行します。
