import { test, expect } from "@playwright/test";
import { SHAKA_PLAYER_URL } from "./urls";

// shaka-player アプリの UI テスト。
// shaka のビルドが無い環境でも、フォームの検証と URL 共有は動く。
test("shaka-player の接続フォームを検証する", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(SHAKA_PLAYER_URL);

  await expect(page.getByRole("heading", { name: "Shaka Player" })).toBeVisible();
  await expect(page.getByTestId("shaka-version")).toContainText(/^v/);
  await expect(page.getByTestId("shaka-version-link")).toHaveAttribute(
    "href",
    /shaka-project\/shaka-player\/releases\/tag\/v/,
  );
  await expect(page.getByTestId("version").locator("option", { hasText: "draft-23" })).toHaveCount(
    1,
  );

  // 空の relay URL は shaka の有無より先に入力検証で止まる
  await page.getByTestId("load").click();
  await expect(page.getByTestId("error")).toContainText("relay URL is empty");

  // relay URL だけでは namespace が無いため開始できない
  await page.getByTestId("relay-url").fill("moqt://example.com/");
  // おめめボタンは表示だけを切り替え、値は変えない。
  // パスワード input は使わず、scheme と port を残した *** 表示にする
  await expect(page.getByTestId("relay-url")).toHaveValue("moqt://example.com/");
  await page.getByTestId("relay-url-visibility").click();
  await expect(page.getByTestId("relay-url")).toHaveValue("moqt://***/");
  await expect(page.getByTestId("relay-url")).toHaveAttribute("readonly", "");
  await page.getByTestId("relay-url-visibility").click();
  await expect(page.getByTestId("relay-url")).toHaveValue("moqt://example.com/");
  await page.getByTestId("load").click();
  await expect(page.getByTestId("error")).toContainText("Track Namespace is empty");

  // Copy URL は token を載せず、URL と namespace を共有する
  await page.getByTestId("namespace").fill("shaka-demo/abc123");
  await page.getByTestId("authorization-token").fill("secret-token");
  await page.getByTestId("copy-url").click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("url=moqt%3A%2F%2Fexample.com%2F");
  expect(clipboard).toContain("namespace=shaka-demo%2Fabc123");
  expect(clipboard).not.toContain("secret-token");
  expect(clipboard).not.toContain("authorizationToken");
});

// devtools の shaka-player.html から Shaka Player の画面へ移動できること。
test("devtools の Shaka Player リンクで shaka アプリへ移動する", async ({ page }) => {
  await page.goto("/");
  const [shakaPage] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("link", { name: "Shaka Player" }).click(),
  ]);
  await shakaPage.waitForLoadState("load");
  await expect(shakaPage).toHaveURL(/\/shaka-player\.html(?:\?.*)?$/);
  await expect(shakaPage.getByRole("heading", { name: "Shaka Player" })).toBeVisible();
});

// devtools の namespace-name 文字列 (ハイフン区切り) を、Shaka Player の
// namespace 入力 (スラッシュ区切り) に変換してリンクへ載せる。
test("devtools の namespace を Shaka のフィールド区切りに変換する", async ({ page }) => {
  await page.goto("/?url=moqt%3A%2F%2Fexample.com%2F&namespace=moqt-devtools-abc");
  const href = await page.getByTestId("shaka-player-link").getAttribute("href");
  expect(href).toContain("namespace=moqt%2Fdevtools%2Fabc");
});

// 候補プールに複数の MOQT URI があるときも、Shaka Player のリンクには
// 接続に使える URL を 1 つ載せる。
test("候補が複数あるとき Shaka Player のリンクに MOQT URI を載せる", async ({ page }) => {
  const candidates = ["moqt://relay-a.example:4443/", "moqt://relay-b.example:4443/"];
  const query = new URLSearchParams({
    urlCandidates: JSON.stringify(candidates),
    namespace: "moqt-devtools-abc",
  });
  await page.goto(`/?${query.toString()}`);
  const href = await page.getByTestId("shaka-player-link").getAttribute("href");
  if (href === null) {
    throw new Error("Shaka Player のリンクに href がありません");
  }
  const link = new URL(href, "http://localhost");
  expect(link.pathname).toBe("/shaka-player.html");
  expect(link.searchParams.get("url")).toBe(candidates[0]);
  expect(link.searchParams.get("namespace")).toBe("moqt/devtools/abc");
});
