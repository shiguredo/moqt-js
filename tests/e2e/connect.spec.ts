import { test, expect, type Page } from "@playwright/test";

const HTTPS_URI = process.env["TEST_MOQT_HTTPS_URI"];
const AUTH_TOKEN = process.env["TEST_MOQT_AUTH_TOKEN"];

// page.goto の load 完了と module script の評価完了は別タイミングなので
// window.__moqtE2E が定義されるまで明示的に待つ
async function waitForE2EReady(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__moqtE2E));
}

// MOQT Session 接続成立まで (SETUP メッセージ交換完了) を検証する
// draft-ietf-moq-transport-17 Section 9.4.1 (SETUP Message)
test.describe("MOQT Session connection", () => {
  test.skip(!HTTPS_URI, "TEST_MOQT_HTTPS_URI is not set");

  test("connects to MOQT server without authorization token", async ({ page }) => {
    await waitForE2EReady(page);
    const state = await page.evaluate(
      (url) => window.__moqtE2E.connectSession({ url }),
      HTTPS_URI as string,
    );
    expect(state).toBe("connected");
  });

  test("connects to MOQT server with authorization token", async ({ page }) => {
    test.skip(!AUTH_TOKEN, "TEST_MOQT_AUTH_TOKEN is not set");
    await waitForE2EReady(page);
    const state = await page.evaluate(
      ({ url, token }) => window.__moqtE2E.connectSession({ url, authorizationTokenValue: token }),
      { url: HTTPS_URI as string, token: AUTH_TOKEN as string },
    );
    expect(state).toBe("connected");
  });
});
