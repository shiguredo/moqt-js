# 開発と検証

## 開発環境

Node.js 22.22.2 以降が必要である。Node.js の下限と package manager の指定は
[package.json](../package.json) を参照すること。CI では Node.js 22 / 24 / 26 を使う。
ビルドとテストには [Vite+](https://github.com/voidzero-dev/vite-plus) の `vp` コマンドを使う。

```bash
vp install
```

## ビルド

`vp install` は prepare スクリプトを通して `vp pack` を実行し、dist/ に index.js と
index.d.ts を生成する。ソースを変更した後は、次のコマンドでビルドし直す。

```bash
vp run build
vp run build:devtools
vp run build:examples
```

SDK のビルド先は dist/、DevTools は devtools/dist/、サンプルは examples/dist/ である。
開発サーバーは `vp run dev`、サンプルの開発サーバーは `vp run dev:examples` で起動する。

DevTools の Preact 変換は UI のソースに限定する。SDK の AudioWorklet に HMR のコードを
混ぜると、Worklet に無い API の呼び出しでプロセッサー登録前に失敗する。
通常のテストページに加え、DevTools のサーバー経由でも実プロセッサーの準備を検査する。

### git 依存として取り込む場合

git から取得したツリーには dist/ が含まれないため、消費側で prepare の実行を許可する。
許可が無い場合、配布物の生成前に import すると解決に失敗する。

pnpm の `allowBuilds` は、git 依存を単なるパッケージ名では許可しない。
解決された取得元または対応する repository URL の設定が必要である。
設定形式と対応バージョンは [pnpm の build 設定](https://github.com/pnpm/pnpm.io/blob/main/docs/settings/build.md#allowbuilds)
を参照すること。

npm を使う消費側でも、git の取得許可と依存スクリプトの実行許可を分けて確認する。
`allow-git` だけで prepare の実行まで許可したと扱わない。
対応する設定は [npm の config](https://docs.npmjs.com/cli/v12/using-npm/config) を参照すること。

## 整形、lint、型検査

```bash
vp check
```

E2E の型解決には SDK の dist/ が必要である。新しい checkout で解決に失敗した場合は、
先に `vp install` または `vp run build` を実行する。

## 単体テスト

```bash
vp test
vp run test:cov
```

新しい PBT は `@fast-check/vitest` の `test.prop` を使う。既存の `fast-check` と
`fc.assert` の試験も同じ生成と縮小の仕組みを使うため維持し、記法だけを目的に一括置換しない。
各試験内では記法を統一する。

## E2E テスト

初回は Playwright の Chromium をインストールする。

```bash
vp exec playwright install --with-deps chromium
```

| コマンド                     | 検証対象                                                 | 実リレー |
| ---------------------------- | -------------------------------------------------------- | -------- |
| `vp run e2e-test`            | DevTools、codec wrapper、再生などの Chromium 試験        | 不要     |
| `vp run e2e-test:production` | SDK の dist/ を使うアプリの production ビルドと実 Worker | 不要     |
| `vp run e2e-test:relay`      | 接続、配信、購読、FETCH、媒体の往復、production 経路     | 必要     |

production の試験は、利用側 Vite で最小アプリをビルドし、Worker の参照先が自己完結して
実ブラウザーで初期化できることを確認する。

### 実リレーの設定

Playwright の設定は、リポジトリルートに .env があれば読み込む。
`TEST_MOQT_URI` が無ければ、実リレーの試験は skip する。
設定の形式は [.env.example](../.env.example) を参照すること。
CI は `secrets.TEST_MOQT_URI` を環境変数として渡す。

CI の通常の実リレー試験は、1 worker を維持してテスト単位で 2 分割する。
各試行は最大 8 分、再試行を含めて 16 分、ジョブは準備を含め最大 20 分である。
`調査:` で始まる手動計測は通常の CI から除く。設定の正本は
[e2e-test.yml](../.github/workflows/e2e-test.yml) である。

### WebKit の確認

WebKit の確認は macOS の開発機で実行する。
音声の Web Audio 取り出し経路も、実際の WebKit で確認する。

```bash
vp exec playwright install webkit
vp exec playwright test --project=webkit
```

## 再生品質を測る場合

E2E の合格件数と実際の発話の品質は分けて評価する。
同じ入力の保存、出力時計、収録の採否、WebRTC との比較は
[再生の計測](PLAYOUT_MEASUREMENT.md) にまとめている。
過去のテスト件数と監査結果は [調査記録](archive/README.md) に残す。
