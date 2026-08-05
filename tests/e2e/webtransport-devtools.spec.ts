import { test, expect } from "@playwright/test";

// webtransport-devtools の UI テスト
// WebTransport サーバーへの接続は不要で、接続時設定の UI 動作と
// クエリパラメータ連携（保存・復元・排他検証）を検証する
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/webtransport-devtools.html";

test("クエリパラメータから接続時設定が復元される", async ({ page }) => {
  // 接続時設定を含む URL を開くと、各入力欄に値が復元されることを確認する
  await page.goto(
    `${DEVTOOLS_URL}?url=https%3A%2F%2Fexample.com%2Fwt&allowPooling=true&congestionControl=low-latency&protocols=foo%2C+bar`,
  );

  await expect(page.getByTestId("connection-url")).toHaveValue("https://example.com/wt");
  await expect(page.getByTestId("connection-allow-pooling")).toBeChecked();
  await expect(page.getByTestId("connection-congestion-control")).toHaveValue("low-latency");
  await expect(page.getByTestId("connection-protocols")).toHaveValue("foo, bar");
});

test("allowPooling と certificateHash の排他検証が働く", async ({ page }) => {
  // W3C §6.9 の allowPooling と serverCertificateHashes の排他制約に基づく
  await page.goto(DEVTOOLS_URL);

  const certificateHashInput = page.getByTestId("connection-certificate-hash");
  const allowPoolingCheckbox = page.getByTestId("connection-allow-pooling");

  // certificateHash に入力すると allowPooling がオフになる
  await certificateHashInput.fill("hash");
  await expect(allowPoolingCheckbox).not.toBeChecked();

  // allowPooling をオンにすると certificateHash がクリアされ、入力欄が無効化される
  await allowPoolingCheckbox.check();
  await expect(certificateHashInput).toHaveValue("");
  await expect(certificateHashInput).toBeDisabled();
});

test("Copy URL で接続時設定がクエリパラメータに反映される", async ({ page }) => {
  // Copy URL ボタンは history.replaceState で URL を書き換えるため、
  // クリック後にページ URL へ設定が反映されることを確認する
  await page.goto(DEVTOOLS_URL);

  await page.getByTestId("connection-url").fill("https://example.com/wt");
  await page.getByTestId("connection-allow-pooling").check();
  await page.getByTestId("connection-congestion-control").selectOption("low-latency");
  await page.getByTestId("connection-headers").fill("X-Foo: bar");

  await page.getByTestId("copy-url").click();

  await expect(page).toHaveURL(/allowPooling=true/);
  await expect(page).toHaveURL(/congestionControl=low-latency/);
  // headers は "key: value" が URL エンコードされるため、正規表現ではなく includes で検証する
  await expect(page).toHaveURL((url) => url.href.includes("headers=X-Foo%3A+bar"));
});
