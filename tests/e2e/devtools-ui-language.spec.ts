import { test, expect, type Page } from "@playwright/test";

// devtools の画面の文言の UI テスト
// 画面に出す文言は英語だけにする (コードのコメントとテストのログは日本語のまま)
// 実リレーは起動しない (接続前の画面と、開いたヘルプ・パネルの文言を見る)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_ORIGIN = "http://localhost:5173";

// ひらがな・カタカナ・漢字のいずれかを含む
const JAPANESE_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/**
 * 画面の文言を集める
 *
 * 隠れている要素 (閉じたポップオーバー) の文言も含めるため、表示の有無に依らずテキスト
 * ノードを 1 つずつ集める (失敗したときにどの文言かを読めるようにする)。文字として出る属性
 * (placeholder / title / aria-label / alt) も含める
 */
async function collectUiText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = [document.title];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      // script と style の中身は画面に出ない
      const parentTag = node.parentElement?.tagName;
      if (parentTag !== "SCRIPT" && parentTag !== "STYLE") {
        texts.push(node.textContent ?? "");
      }
    }
    for (const element of document.body.querySelectorAll("*")) {
      for (const name of ["placeholder", "title", "aria-label", "alt"]) {
        const value = element.getAttribute(name);
        if (value !== null) {
          texts.push(value);
        }
      }
    }
    return texts;
  });
}

/**
 * 日本語を含む文言だけを返す (失敗したときにどこが日本語かを出すため)
 */
function findJapanese(texts: string[]): string[] {
  return texts
    .flatMap((text) => text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => JAPANESE_PATTERN.test(line));
}

test("MOQT DevTools の画面の文言に日本語を使わない", async ({ page }) => {
  await page.goto(`${DEVTOOLS_ORIGIN}/index.html`);
  await expect(page.getByRole("heading", { name: "MOQT DevTools" })).toBeVisible();

  // 接続前の画面 (統計の説明のポップオーバーは閉じていても DOM にあるため含まれる)
  const texts = await collectUiText(page);

  // 接続設定のヘルプは開いたときだけ描画するため、1 つずつ開いて集める
  for (const name of ["MOQT", "LOC", "MSF", "C4M"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const closeButton = page.getByRole("button", { name: "Close", exact: true });
    await expect(closeButton).toBeVisible();
    texts.push(...(await collectUiText(page)));
    await closeButton.click();
    await expect(closeButton).toBeHidden();
  }

  // デバッグログのパネルも開いたときだけ描画する
  await page.getByRole("button", { name: /^Debug/ }).click();
  await expect(page.getByRole("heading", { name: "Debug Logs" })).toBeVisible();
  texts.push(...(await collectUiText(page)));

  expect(findJapanese(texts)).toEqual([]);
});

test("WebTransport DevTools の画面の文言に日本語を使わない", async ({ page }) => {
  await page.goto(`${DEVTOOLS_ORIGIN}/webtransport-devtools.html`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // API の対応状況は開いたときだけ描画するため、開いてから集める (API ごとの説明を含む)
  await page.getByTestId("api-support-toggle").click();
  await expect(page.getByText("WebTransport.prototype.ready")).toBeVisible();

  expect(findJapanese(await collectUiText(page))).toEqual([]);
});

test("WebCodecs DevTools の画面の文言に日本語を使わない", async ({ page }) => {
  await page.goto(`${DEVTOOLS_ORIGIN}/webcodecs-devtools.html`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  expect(findJapanese(await collectUiText(page))).toEqual([]);
});
