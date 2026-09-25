import { test, expect } from "@playwright/test";

// devtools の統計の説明 (?) の UI テスト
// 説明は常に画面に並べず、(?) を押したときだけポップオーバーに出す
// 実リレーは起動しない (説明の表示は接続の有無に依らない)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// subscriber の区間 (devtools/src/utils/latencyBreakdown.ts の LATENCY_SEGMENTS と同じ並び)
const SUBSCRIBER_SEGMENTS = [
  "arrival",
  "hold",
  "decodeWait",
  "decode",
  "displayWait",
  "displayLatency",
] as const;

test("統計の説明は (?) を押したときだけポップオーバーに出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("publisher-statistics-toggle").click();
  await page.getByTestId("subscriber-statistics-toggle").click();

  const button = page.getByTestId("subscriber-latency-breakdown-help-button");
  const popover = page.getByTestId("subscriber-latency-breakdown-help");

  // 押す前は説明を出さない (統計の横に長い文を並べない)
  await expect(button).toBeVisible();
  await expect(popover).toBeHidden();

  // (?) を押すと説明を出す
  await button.click();
  await expect(popover).toBeVisible();
  // 区間の和の式と、区間ごとの説明を項目の並びで出す
  await expect(popover).toContainText(
    "arrival + hold + decodeWait + decode + displayWait = displayLatency",
  );
  await expect(popover.getByRole("term")).toHaveText([...SUBSCRIBER_SEGMENTS]);

  // ポップオーバーは画面の中に収まる (はみ出して読めない部分を作らない)
  const viewport = page.viewportSize();
  const box = await popover.boundingBox();
  if (viewport === null || box === null) {
    throw new Error("ポップオーバーの位置か画面の大きさが取れない");
  }
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // Escape で閉じる
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // ポップオーバーの外を押しても閉じる
  await button.click();
  await expect(popover).toBeVisible();
  await page.getByRole("heading", { name: "MOQT DevTools" }).click();
  await expect(popover).toBeHidden();

  // (?) をもう一度押すと閉じる
  await button.click();
  await expect(popover).toBeVisible();
  await button.click();
  await expect(popover).toBeHidden();
});

test("すべての統計の説明を (?) から開ける", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("publisher-statistics-toggle").click();
  await page.getByTestId("subscriber-statistics-toggle").click();

  // (?) の data-testid は「説明の data-testid + "-button"」にする
  const buttons = page.locator('[data-testid$="-help-button"]');
  const buttonTestIds = await buttons.evaluateAll((elements) =>
    elements.map((element) => element.dataset.testid ?? ""),
  );
  // publisher と subscriber の両方に説明がある (空振りでないことの確認)
  expect(buttonTestIds).toContain("publisher-latency-breakdown-help-button");
  expect(buttonTestIds).toContain("subscriber-latency-breakdown-help-button");
  expect(buttonTestIds).toContain("subscriber-stall-causes-help-button");

  for (const buttonTestId of buttonTestIds) {
    const popover = page.getByTestId(buttonTestId.replace(/-button$/, ""));
    await page.getByTestId(buttonTestId).click();
    // 押した (?) の説明だけを出し、説明には要約と項目がある
    await expect(popover, `${buttonTestId} の説明が出ない`).toBeVisible();
    await expect(popover.getByRole("term").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  }
});
