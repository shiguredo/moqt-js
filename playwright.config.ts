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
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: RELAY_SPEC_PATTERN,
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
  webServer: [
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
  ],
});
