import { test, type Browser, type Page } from "@playwright/test";

/**
 * 実リレーへ接続する e2e テストの共通部分
 *
 * 接続先は環境変数 `TEST_MOQT_URI` で渡す。CI では GitHub Actions の secret から
 * 環境変数として注入し、未設定の環境 (fork からの PR、secret を持たないローカル) では
 * テストを skip として記録する。暗黙の成功扱いにはしない。
 */
export const TEST_MOQT_URI = process.env.TEST_MOQT_URI;

/** 接続先が無い環境での skip 理由 (日本語のテストログとして出す) */
export const RELAY_REQUIRED_SKIP_REASON =
  "TEST_MOQT_URI が設定されていないため実リレーへ接続するテストを実行しない";

/**
 * 実リレーとの往復はローカルより CI の runner で遅い
 *
 * 接続、エンコーダーの初期化、カタログの往復、フレームの到達までを 1 本のテストで
 * 待つため、既定の 30 秒では足りない。
 */
export const RELAY_TEST_TIMEOUT_MS = 90_000;

/**
 * 実リレー接続用のテストページ
 *
 * playwright.config.ts の 2 本目の webServer が配信する。
 */
export const RELAY_PAGE_URL = "http://localhost:5180/index.html";

/**
 * 実リレーの MOQT URI を取り出す
 *
 * 未設定の環境ではテストを skip として記録し、null を返す。呼び出し側は null なら
 * 直ちに return する (skip したテストの本体を走らせない)。
 */
export function requireRelayUri(): string | null {
  if (TEST_MOQT_URI !== undefined && TEST_MOQT_URI.length > 0) {
    return TEST_MOQT_URI;
  }
  test.skip(true, RELAY_REQUIRED_SKIP_REASON);
  return null;
}

/**
 * テストごとに一意な Track Namespace を作る
 *
 * 実リレーは共有のため、テストを並行実行しても namespace が衝突しないようにする。
 * `crypto.randomUUID()` はブラウザと Node の両方にある標準 API。
 */
export function createTestNamespace(): string[] {
  return ["moqt-js-e2e", crypto.randomUUID()];
}

/**
 * 実リレー接続用のテストページを開き、テスト API が公開されるまで待つ
 *
 * `page.goto` の load 完了と module script の評価完了は別タイミングなので、
 * `window.__moqtE2E` の定義を明示的に待つ。
 */
export async function openRelayPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(RELAY_PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__moqtE2E));
  return page;
}

/**
 * テストページを閉じる
 *
 * `browser.newPage()` は暗黙に context を作るため、context ごと閉じる。
 */
export async function closeRelayPage(page: Page): Promise<void> {
  await page.context().close();
}
