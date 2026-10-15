import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// ローカル実行用に .env を読む。
// CI では GitHub Actions の secret が環境変数として渡され .env は存在しないため、
// 存在する場合だけ読む (process.loadEnvFile はファイルが無いと例外になる)。
// 読み込みは既に設定済みの環境変数を上書きしないため、CI の値が優先される。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

/**
 * 空きポートを取る
 *
 * Playwright の設定は**同期のオブジェクトでなければならない** (非同期の関数を返すと
 * "Configuration file must export a single object" で起動できない。実測)。そのため、
 * `bind(0)` で OS に選ばせて番号を読む処理だけを子プロセス
 * (tests/e2e/free-ports.mjs) で行い、同期で受け取る。
 *
 * 固定ポートにすると、同じポートで別のアプリが動いているときに `reuseExistingServer` が
 * それを黙って使い、**別のアプリを相手にテストしてしまう** (実際に起きた)。
 *
 * 番号を取ってから実際に listen するまでの間に他のプロセスが同じ番号を取る余地は残るが、
 * その場合は vite の `strictPort` が起動に失敗するため、黙って別のアプリを使うことはない。
 */
function freePorts(count: number): number[] {
  const scriptPath = join(import.meta.dirname, "tests/e2e/free-ports.mjs");
  const output = execFileSync(process.execPath, [scriptPath, String(count)], { encoding: "utf8" });
  const ports = output.trim().split("\n").map(Number);
  if (ports.length !== count || ports.some((port) => !Number.isInteger(port) || port <= 0)) {
    throw new Error(`free ports could not be reserved: ${JSON.stringify(ports)}`);
  }
  return ports;
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

// production 検証用アプリの preview サーバーの URL を作る
// ポートは空きポートを取り、preview へ --port で渡す (vite.config.ts の preview.port は
// 単体起動時の既定)
function productionUrl(port: number): string {
  return `http://localhost:${port}/index.html`;
}

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

/**
 * 起動するサーバー
 *
 * ポートは全て空きポートを取り、`--port` で渡す。固定ポートにすると、同じポートで別の
 * アプリが動いているときに `reuseExistingServer` がそれを黙って使い、**別のアプリを相手に
 * テストしてしまう** (実際に起きた)。空きポートなので再利用の余地は無く、
 * `reuseExistingServer` は常に false にする。
 *
 * production 検証用だけは選択された project に応じて条件付きで足す (Playwright は選択した
 * project に関係なく webServer を全て起動するため)。
 */
function webServers(ports: {
  devtools: number;
  production: number;
  relayPage: number;
}): Parameters<typeof defineConfig>[0]["webServer"] {
  const servers = [
    {
      // devtools の UI テスト用
      command: `pnpm --filter moqt-devtools dev --port ${ports.devtools}`,
      url: `http://localhost:${ports.devtools}/webtransport-devtools.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // 実リレー接続用のテストページ
      command: `pnpm --filter moqt-js-e2e dev --port ${ports.relayPage}`,
      url: `http://localhost:${ports.relayPage}/index.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ];

  if (usesProductionApp(process.argv)) {
    servers.push({
      // production ビルド検証用のテストページ。
      // dev サーバーではなく production ビルド (vp build) を preview (vp preview) で配信する。
      // 既定の assetsInlineLimit のままビルドし、利用者が既定設定で production ビルドした
      // ときの worker の参照 (data URL またはファイル) を spec がそのまま検査できるようにする。
      // ビルドは 1 秒程度であり、dist を必要とする project の実行時だけ最新に保つ
      command: `pnpm --filter moqt-js-e2e build:production && pnpm --filter moqt-js-e2e preview:production --port ${ports.production}`,
      url: productionUrl(ports.production),
      reuseExistingServer: false,
      timeout: 120_000,
    });
  }

  return servers;
}

// 空きポートを取る。spec は tests/e2e/urls.ts を通してこの値を使う
//
// この設定は runner だけでなく **worker プロセスも読む**。worker が読み直すたびに取り直す
// と、worker はサーバーの居ないポートを見に行く (実際に ERR_CONNECTION_REFUSED になった)。
// 最初に読んだプロセスが決め、環境変数で子へ渡す。
const reservedPorts = process.env.MOQT_TEST_PORTS;
const [devtoolsPort, relayPagePort, productionPort] = (
  reservedPorts === undefined ? freePorts(3) : (JSON.parse(reservedPorts) as number[])
) as [number, number, number];
process.env.MOQT_TEST_PORTS = JSON.stringify([devtoolsPort, relayPagePort, productionPort]);
const devtoolsOrigin = `http://localhost:${devtoolsPort}`;
const productionOrigin = `http://localhost:${productionPort}`;
process.env.MOQT_DEVTOOLS_ORIGIN = devtoolsOrigin;
process.env.MOQT_E2E_PAGE_URL = `http://localhost:${relayPagePort}/index.html`;
process.env.MOQT_PRODUCTION_ORIGIN = productionOrigin;

// WebTransport は Chromium 系のみ対応
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: devtoolsOrigin,
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
      use: { ...devices["Desktop Chrome"], baseURL: productionOrigin },
      testMatch: PRODUCTION_SPEC_PATTERN,
      testIgnore: PRODUCTION_RELAY_SPEC_PATTERN,
    },
    {
      // production ビルド + 実リレーの検証 (TEST_MOQT_URI が設定された環境でだけ実行される)
      name: "chromium-production-relay",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: productionOrigin,
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
  webServer: webServers({
    devtools: devtoolsPort,
    production: productionPort,
    relayPage: relayPagePort,
  }),
});
