import { test, expect } from "@playwright/test";

// devtools の event timeline (メッセージ) の UI テスト
// 実リレーは起動しない (配信を始めていない状態の表示だけを見る)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

test("Publisher の Messages は入力と送信を持ち、配信を始めるまで無効になる", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);

  const input = page.getByTestId("publisher-message-input");
  const send = page.getByTestId("publisher-message-send");
  await expect(input).toBeVisible();
  await expect(send).toBeVisible();

  // event timeline トラックの publisher が確立するまでは入力も送信も無効にする
  await expect(input).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(page.getByTestId("publisher-messages-sent")).toHaveText("Sent: 0");
});

test("Subscriber の Messages は購読前「-」を表示する", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);

  await expect(page.getByTestId("subscriber-messages")).toBeVisible();
  await expect(page.getByTestId("subscriber-messages-empty")).toHaveText("-");
});

test("表示モードに応じて Publisher と Subscriber の Messages を出し分ける", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);
  await expect(page.getByTestId("publisher-messages")).toBeVisible();
  await expect(page.getByTestId("subscriber-messages")).toHaveCount(0);

  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);
  await expect(page.getByTestId("subscriber-messages")).toBeVisible();
  await expect(page.getByTestId("publisher-messages")).toHaveCount(0);
});
