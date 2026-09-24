import { test, expect } from "@playwright/test";

// devtools の Authorization Token の UI テスト
// 実リレーは起動しない。c4m の取り込みと Token Type 入力による解除を UI で観測する。
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// c4m の Base64 トークン (draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-01 §2)
const C4M_BASE64 = "QUFB";

test("c4m の取り込みで表示が出て Token Type が 1 (CAT) になり、Token Type の編集で解除される", async ({
  page,
}) => {
  // MSF URL の c4m は fragment に含まれるため、URLSearchParams で組み立てる
  // (素の文字列連結では # 以降が落ちて c4m が取り込まれない)
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${C4M_BASE64}`);

  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);

  // c4m から読み込んだトークンの表示が 1 つだけ出る
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(1);
  // draft-ietf-moq-c4m-01 §7.1 Table 4: Token Type 0x01 は CAT
  await expect(page.locator("#authorizationTokenType")).toHaveValue("1");
  // c4m の取り込みでは Token Value をクリアする
  await expect(page.locator("#authorizationTokenValue")).toHaveValue("");

  // Token Type を手入力すると c4m の取り込みが解除される
  await page.locator("#authorizationTokenType").fill("0");
  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
});

test("c4m が無い URL では既定の Token Type 0 のままで c4m の表示も出ない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  await expect(page.getByTestId("authorization-token-c4m")).toHaveCount(0);
  await expect(page.locator("#authorizationTokenType")).toHaveValue("0");
});
