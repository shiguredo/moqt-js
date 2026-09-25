import { expect, test, type Page } from "@playwright/test";

// Relay URI は OPFS に覚え、localStorage は使わない。
// 実リレーは起動しない。dev サーバーは playwright.config.ts の webServer (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";
const SERVER_URL_FILE = "server-url.txt";

/** このオリジンの OPFS から覚えた Relay URI を消す */
async function forgetServerUrl(page: Page): Promise<void> {
  await page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(fileName);
    } catch {
      // まだ覚えていない
    }
  }, SERVER_URL_FILE);
}

/** OPFS に書いた文字列を読む。無ければ空 */
async function readServerUrlFile(page: Page): Promise<string> {
  return page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    try {
      const handle = await root.getFileHandle(fileName);
      const file = await handle.getFile();
      return await file.text();
    } catch {
      return "";
    }
  }, SERVER_URL_FILE);
}

test("入力した Relay URI を次に開いたときに戻す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await forgetServerUrl(page);
  await page.reload();

  const saved = "moqt://remembered.example:4443/";
  const input = page.getByTestId("relay-uri");
  const save = page.getByTestId("relay-uri-save");
  const forget = page.getByTestId("relay-uri-forget");
  await expect(save).toBeEnabled();
  await expect(forget).toBeDisabled();
  // 欄を変えただけでは覚えない
  await input.fill(saved);
  await input.blur();
  await expect.poll(() => readServerUrlFile(page)).toBe("");

  await save.click();
  await expect.poll(() => readServerUrlFile(page)).toBe(saved);
  await expect(save).toBeDisabled();
  await expect(forget).toBeEnabled();

  // クエリの url が無い再読み込みでは、OPFS の値を戻し、Forget だけ押せる
  await page.goto(DEVTOOLS_URL);
  await expect(input).toHaveValue(saved);
  await expect(save).toBeDisabled();
  await expect(forget).toBeEnabled();

  await forget.click();
  await expect.poll(() => readServerUrlFile(page)).toBe("");
  await expect(save).toBeEnabled();
  await expect(forget).toBeDisabled();
  await expect(input).toHaveValue(saved);

  await page.reload();
  await expect(input).toHaveValue("moqt://127.0.0.1:4443/");
  await expect(save).toBeEnabled();
  await expect(forget).toBeDisabled();
});

test("共有リンクの url は表示するが、覚えた Relay URI は上書きしない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await forgetServerUrl(page);
  await page.reload();

  const saved = "moqt://remembered.example:4443/";
  const shared = "moqt://shared.example:4443/";
  const input = page.getByTestId("relay-uri");
  const save = page.getByTestId("relay-uri-save");
  const forget = page.getByTestId("relay-uri-forget");
  await input.fill(saved);
  await save.click();
  await expect.poll(() => readServerUrlFile(page)).toBe(saved);

  await page.goto(`${DEVTOOLS_URL}?url=${encodeURIComponent(shared)}`);
  await expect(input).toHaveValue(shared);
  // 共有リンクを開いただけでは Save 済みにせず、ファイルも書き換えない
  await expect(save).toBeEnabled();
  await expect(forget).toBeDisabled();
  await expect.poll(() => readServerUrlFile(page)).toBe(saved);

  await page.goto(DEVTOOLS_URL);
  await expect(input).toHaveValue(saved);
  await expect(save).toBeDisabled();
  await expect(forget).toBeEnabled();
});
