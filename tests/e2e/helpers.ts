import type { Page } from "@playwright/test";

/**
 * page.goto の load 完了と module script の評価完了は別タイミングなので
 * window.__moqtE2E が定義されるまで明示的に待つ
 */
export async function waitForE2EReady(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__moqtE2E));
}
