import { expect, test, type Page } from "@playwright/test";

// MOQT URI は OPFS に覚え、localStorage は使わない。
// 実リレーは起動しない。dev サーバーは playwright.config.ts の webServer (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";
const SERVER_URL_FILE = "server-url.txt";

/** このオリジンの OPFS から覚えた MOQT URI を消す */
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

test("入力した MOQT URI を次に開いたときに戻す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await forgetServerUrl(page);
  await page.reload();

  const saved = "moqt://remembered.example:4443/";
  const input = page.getByTestId("moqt-uri");
  const save = page.getByTestId("moqt-uri-save");
  const forget = page.getByTestId("moqt-uri-forget");
  // MOQT URI の初期値は空のため、何も入っていない間は Save も Forget も押せない
  await expect(save).toBeDisabled();
  await expect(forget).toBeDisabled();
  // 欄を変えただけでは覚えない
  await input.fill(saved);
  await input.blur();
  await expect.poll(() => readServerUrlFile(page)).toBe("");
  await expect(save).toBeEnabled();

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
  await expect(input).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(forget).toBeDisabled();
});

test("共有リンクの url は表示するが、覚えた MOQT URI は上書きしない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await forgetServerUrl(page);
  await page.reload();

  const saved = "moqt://remembered.example:4443/";
  const shared = "moqt://shared.example:4443/";
  const input = page.getByTestId("moqt-uri");
  const save = page.getByTestId("moqt-uri-save");
  const forget = page.getByTestId("moqt-uri-forget");
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

// 覚えた MOQT URI に msf fragment と c4m があるときも、次に開いたときに貼り付けたときと
// 同じく namespace の固定と c4m の取り込みを行う (Save/Forget のテストの後始末もする)
test("覚えた MOQT URI の msf fragment と c4m を次に開いたときも取り込む", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await forgetServerUrl(page);
  await page.reload();

  const saved = "moqt://remembered.example/#msf:15551-spam--catalog&c4m=QUFB";
  const input = page.getByTestId("moqt-uri");
  await input.fill(saved);
  await page.getByTestId("moqt-uri-save").click();
  await expect.poll(() => readServerUrlFile(page)).toBe(saved);

  // クエリの url が無い再読み込みでは、覚えた URL の msf fragment と c4m を取り込む
  await page.goto(DEVTOOLS_URL);
  await expect(input).toHaveValue(saved);
  await expect(page.getByTestId("uri-fragment")).toHaveValue("msf:15551-spam--catalog&c4m=QUFB");
  const namespaceInput = page.getByTestId("namespace");
  await expect(namespaceInput).toHaveValue("15551-spam");
  await expect(namespaceInput).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("authorization-token-type")).toHaveValue("1");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);

  await forgetServerUrl(page);
});
