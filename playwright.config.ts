import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// ローカル実行用に .env を読む。
// CI では GitHub Actions の secret が環境変数として渡され .env は存在しないため、
// 存在する場合だけ読む (process.loadEnvFile はファイルが無いと例外になる)。
// 読み込みは既に設定済みの環境変数を上書きしないため、CI の値が優先される。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// 実リレーへ接続する spec は tests/e2e/relay/ に置く。
// 実リレーを必要としない devtools の UI テストとは要求が異なるため project を分け、
// 接続先を渡していない実行で意図せず実リレーへ接続しないようにする。
// 接続先は環境変数 TEST_MOQT_URI で渡し、未設定なら spec 側が skip する。
const RELAY_SPEC_PATTERN = /relay\/.*\.spec\.ts$/;

// production ビルドの検証は tests/e2e/production/ に置く。
// このアプリだけが `moqt-js` を src alias ではなく workspace リンクの dist で解決するため、
// dev サーバー上のテストとは要求が異なる (既存の chromium project からは除外する)。
const PRODUCTION_SPEC_PATTERN = /production\/.*\.spec\.ts$/;

// production ビルド + 実リレーの検証 (TEST_MOQT_URI が設定された環境でだけ実行される)
const PRODUCTION_RELAY_SPEC_PATTERN = /production\/publisher-relay\.spec\.ts$/;

// production 検証用アプリの preview サーバー
// ポートは tests/e2e/production/vite.config.ts の preview.port (5190) に固定される
const PRODUCTION_URL = "http://localhost:5190/index.html";

/**
 * production 検証用アプリのサーバーを起動すべきかを判定する
 *
 * Playwright は選択した project に関係なく webServer を全て起動する。production 検証用の
 * preview はルートの vp pack の成果物 (dist) と production アプリのビルド成果物を必要と
 * するため、それを使わない project (chromium / relay / webkit / webkit-relay) の実行では
 * 起動しない。project を指定しない実行は全 project が対象になるため起動する。
 */
function usesProductionApp(argv: readonly string[]): boolean {
  const selectedProjects: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") {
      // `--project name` 形式。値は次の引数にある
      const value = argv[index + 1];
      if (value !== undefined) {
        selectedProjects.push(...value.split(","));
      }
      index += 1;
      continue;
    }
    if (argument !== undefined && argument.startsWith("--project=")) {
      // `--project=name` 形式。カンマ区切りで複数指定できる
      selectedProjects.push(...argument.slice("--project=".length).split(","));
    }
  }
  if (selectedProjects.length === 0) {
    return true;
  }
  return selectedProjects.some((name) => name.startsWith("chromium-production"));
}

// 起動するサーバー。production 検証用だけは選択された project に応じて条件付きで足す
const webServer = [
  {
    // devtools の UI テスト用
    // ポートは devtools/vite.config.ts の server.port (5173) に固定される
    command: "pnpm --filter moqt-devtools dev",
    url: "http://localhost:5173/webtransport-devtools.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  {
    // 実リレー接続用のテストページ
    // ポートは tests/e2e/vite.config.ts の server.port (5180) に固定される
    command: "pnpm --filter moqt-js-e2e dev",
    url: "http://localhost:5180/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
];

if (usesProductionApp(process.argv)) {
  webServer.push({
    // production ビルド検証用のテストページ。
    // dev サーバーではなく production ビルド (vp build) を preview (vp preview) で配信する。
    // 既定の assetsInlineLimit のままビルドし、利用者が既定設定で production ビルドした
    // ときの worker の参照 (data URL またはファイル) を spec がそのまま検査できるようにする。
    // ビルドは 1 秒程度であり、dist を必要とする project の実行時だけ最新に保つ
    command:
      "pnpm --filter moqt-js-e2e build:production && pnpm --filter moqt-js-e2e preview:production",
    url: PRODUCTION_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  });
}

// WebTransport は Chromium 系のみ対応
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      // 実リレーを必要としないテスト (devtools の UI、codec wrapper)
      // production ビルドの検証は dist を消費するアプリ (chromium-production) の担当であり、
      // dev サーバー + src alias のこのプロジェクトでは再現できないため除外する
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [RELAY_SPEC_PATTERN, PRODUCTION_SPEC_PATTERN],
    },
    {
      // 利用側 Vite の production ビルド + moqt-js の既定 useWorker の検証。
      // テスト対象は preview が配信するビルド成果物だけであり、dev サーバーは使わない
      name: "chromium-production",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5190" },
      testMatch: PRODUCTION_SPEC_PATTERN,
      testIgnore: PRODUCTION_RELAY_SPEC_PATTERN,
    },
    {
      // production ビルド + 実リレーの検証 (TEST_MOQT_URI が設定された環境でだけ実行される)
      name: "chromium-production-relay",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:5190",
        // relay のプロジェクトと同じ理由で記録しない (実時間のメディアを扱う)
        trace: "off",
      },
      testMatch: PRODUCTION_RELAY_SPEC_PATTERN,
    },
    {
      // 実リレーへ接続するテスト (TEST_MOQT_URI が設定された環境でだけ実行される)
      name: "relay",
      use: {
        ...devices["Desktop Chrome"],
        // 実時間のメディアを扱うテストであり、runner の処理能力そのものがテストの条件に
        // なる。trace のスクリーンキャストは同じコアを奪い、配信側の音声の符号化を
        // 実時間から遅らせて計測を歪めるため、このプロジェクトだけ記録しない
        trace: "off",
      },
      testMatch: RELAY_SPEC_PATTERN,
    },
    {
      // Safari 相当 (WebKit) の確認。Safari は MediaStreamTrackProcessor をメインスレッドに
      // 公開しておらず (WebKit の IDL は Exposed=DedicatedWorker)、Worker へ
      // MediaStreamTrack も渡せない。そのため音声は Web Audio 経由で取り出す
      // (src/audioSource.ts)。このプロジェクトは、その経路を実機と同じ WebKit で確かめる。
      //
      // CI では実行しない。CI の runner は ubuntu であり、そこの WebKit には音声デバイスが
      // 無いため AudioContext の処理が回らない。`vp exec playwright test --project=webkit`
      // として macOS の開発機で回す (package.json の e2e-test は chromium だけを指定する)。
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /devtools-audio-fallback\.spec\.ts$/,
    },
    {
      // Safari 相当 (WebKit) から実リレーへ配信する確認。Safari は
      // MediaStreamTrackProcessor をメインスレッドに持たないため、音声は Web Audio 経由に
      // なる (src/audioSource.ts)。その経路が devtools の Publisher からリレー、購読者まで
      // 通ることを実機と同じ WebKit で確かめる。
      //
      // CI では実行しない。CI の runner は ubuntu であり、そこの WebKit には WebTransport も
      // 音声デバイスも無い。`vp exec playwright test --project=webkit-relay` として macOS の
      // 開発機で回す (接続先は relay のプロジェクトと同じく TEST_MOQT_URI で渡す)。
      name: "webkit-relay",
      use: {
        ...devices["Desktop Safari"],
        // relay のプロジェクトと同じ理由で記録しない (実時間のメディアを扱う)
        trace: "off",
      },
      testMatch: /relay\/devtools-audio-publish\.spec\.ts$/,
    },
  ],
  webServer,
});
