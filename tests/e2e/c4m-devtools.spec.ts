import { test, expect } from "@playwright/test";

// C4M DevTools の UI テスト
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)。
// 鍵の生成は Web Crypto API で行い、トークンの発行から検証までをブラウザ内で確認する。
const C4M_DEVTOOLS_URL = "/c4m-devtools.html";

test("生成した Ed25519 の鍵で compact 形式のトークンを発行して検証できる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);
  await expect(page.getByTestId("c4m-title")).toHaveText("C4M DevTools");

  // EdDSA の鍵ペアを生成する
  await page.getByTestId("c4m-key-algorithm").selectOption("EdDsa");
  await page.getByTestId("c4m-generate-key-button").click();
  await expect(page.getByTestId("c4m-key-public")).not.toHaveValue("");
  await expect(page.getByTestId("c4m-key-private")).not.toHaveValue("");

  // 生成した鍵を署名と検証に使う
  await page.getByTestId("c4m-use-for-sign").click();
  await page.getByTestId("c4m-use-for-verify").click();
  // 署名鍵の解釈結果はすぐに表示される
  await expect(page.getByTestId("c4m-signing-key-status")).toContainText("private key");

  // Publish を example.com にだけ許可するスコープを設定する
  await page.getByTestId("c4m-scope-0-namespace").fill("example.com");

  // クレームを設定して発行する
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-expiration").fill("1700086400");
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-build-error")).toHaveCount(0);
  await expect(page.getByTestId("c4m-output")).toHaveValue(/.+/);

  // compact 形式は 3 分割になる
  const tokenText = await page.getByTestId("c4m-output").inputValue();
  expect(tokenText.split(".")).toHaveLength(3);

  // 発行したトークンをデコードして検証する
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-decode-error")).toHaveCount(0);
  await expect(page.getByTestId("c4m-format")).toHaveText("compact");
  await expect(page.getByTestId("c4m-alg")).toContainText("EdDsa");
  await expect(page.getByTestId("c4m-claim-iss")).toHaveText("https://auth.example.com");
  // 検証鍵の解釈結果はトークンの検証欄に表示される
  await expect(page.getByTestId("c4m-verify-key-status")).toContainText("public key");
  await page.getByTestId("c4m-verify-button").click();
  await expect(page.getByTestId("c4m-verify-result")).toHaveText("Signature verified");

  // 認可判定: PUBLISH は example.com にだけ許可される
  await page.getByTestId("c4m-authorize-action").selectOption("PUBLISH");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await page.getByTestId("c4m-authorize-track").fill("video-hd");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Allowed");
  await page.getByTestId("c4m-authorize-namespace").fill("other.example.com");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Denied");
  await page.getByTestId("c4m-authorize-action").selectOption("SUBSCRIBE");
  await page.getByTestId("c4m-authorize-namespace").fill("example.com");
  await expect(page.getByTestId("c4m-authorize-result")).toHaveText("Denied");
});

test("生成した HMAC の対称鍵で COSE 形式のトークンを発行して検証できる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  // HMAC-SHA256 の対称鍵を生成する
  await page.getByTestId("c4m-key-algorithm").selectOption("HmacSha256");
  await page.getByTestId("c4m-generate-key-button").click();
  await expect(page.getByTestId("c4m-key-secret")).not.toHaveValue("");
  await page.getByTestId("c4m-use-for-sign").click();
  await page.getByTestId("c4m-use-for-verify").click();
  // 生成した secret は hex として解釈される
  await expect(page.getByTestId("c4m-signing-key-status")).toContainText("hex, 32 bytes");

  // COSE 形式で発行する
  await page.getByTestId("c4m-issuer").fill("https://auth.example.com");
  await page.getByTestId("c4m-output-format").selectOption("cose");
  await page.getByTestId("c4m-build-button").click();
  await expect(page.getByTestId("c4m-output")).toHaveValue(/.+/);

  // デコードすると COSE_Mac0 として判別される
  await page.getByTestId("c4m-output-load").click();
  await expect(page.getByTestId("c4m-format")).toHaveText("coseMac0");
  await expect(page.getByTestId("c4m-alg")).toContainText("HmacSha256");
  await expect(page.getByTestId("c4m-verify-key-status")).toContainText("hex, 32 bytes");
  await page.getByTestId("c4m-verify-button").click();
  await expect(page.getByTestId("c4m-verify-result")).toHaveText("Signature verified");
});

test("不正なトークンはデコードエラーになる", async ({ page }) => {
  await page.goto(C4M_DEVTOOLS_URL);

  await page.getByTestId("c4m-token-input").fill("not a token");
  await page.getByTestId("c4m-decode-button").click();
  await expect(page.getByTestId("c4m-decode-error")).not.toHaveText("");

  // 署名の検証鍵を入れずに検証するとエラーになる
  await page.getByTestId("c4m-decode-error").waitFor();
  await expect(page.getByTestId("c4m-token-panel")).toContainText("Token");
});
