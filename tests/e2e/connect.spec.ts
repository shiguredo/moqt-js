import { test, expect } from "@playwright/test";
import { waitForE2EReady } from "./helpers";

const MOQT_URI = process.env["TEST_MOQT_URI"];
const AUTH_TOKEN = process.env["TEST_MOQT_AUTH_TOKEN"];

// MOQT Session 接続成立まで (SETUP メッセージ交換完了) を検証する
// draft-ietf-moq-transport-17 Section 9.4.1 (SETUP Message)
test.describe("MOQT Session connection", () => {
  test.skip(!MOQT_URI, "TEST_MOQT_URI is not set");

  test("connects to MOQT server without authorization token", async ({ page }) => {
    await waitForE2EReady(page);
    const state = await page.evaluate(
      (url) => window.__moqtE2E.connectSession({ url }),
      MOQT_URI as string,
    );
    expect(state).toBe("connected");
  });

  test("connects to MOQT server with authorization token", async ({ page }) => {
    test.skip(!AUTH_TOKEN, "TEST_MOQT_AUTH_TOKEN is not set");
    await waitForE2EReady(page);
    const state = await page.evaluate(
      ({ url, token }) => window.__moqtE2E.connectSession({ url, authorizationTokenValue: token }),
      { url: MOQT_URI as string, token: AUTH_TOKEN as string },
    );
    expect(state).toBe("connected");
  });
});
