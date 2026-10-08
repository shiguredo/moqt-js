import { expect, test } from "@playwright/test";

// Namespace の欄は draft-ietf-moq-transport-22 §8.8 の namespace-name 文字列
// (フィールドを "-" で並べ、literal で書けない byte は "." + 小文字 16 進 2 桁) である。
// 解析できない値では接続に使う Track Namespace のフィールド列が無いため、欄に理由を出し、
// 配信 / 購読の開始を拒否する。実リレーは起動しない。
// dev サーバーは playwright.config.ts の webServer (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

/** 解析できない namespace の値と、その理由 (解析器のエラーメッセージ) */
const INVALID_NAMESPACE = "moqt/devtools/a1B2c3D4e5F6g7H8";
const INVALID_REASON =
  /character "\/" in track namespace field at index 0 is not in \[A-Za-z0-9_\]/;

test("Namespace が §8.8 の表記として読めないときは理由を出し、Publish を拒否する", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  const namespaceInput = page.getByTestId("namespace");
  const warning = page.getByTestId("namespace-warning");

  // 初期値 (moqt-devtools-{ランダム 16 文字}) は §8.8 の表記であり、警告を出さない
  await expect(namespaceInput).toHaveValue(/^moqt-devtools-[a-zA-Z0-9]{16}$/);
  await expect(warning).toHaveCount(0);

  // "/" は §8.8 の literal 文字でもエスケープでもないため読めない。理由は欄に出す
  await namespaceInput.fill(INVALID_NAMESPACE);
  await expect(warning).toHaveText(INVALID_REASON);

  // Publish は接続の前に拒否され、解析の失敗理由がステータスに出る
  await page.getByTestId("publisher-publish-button").click();
  await expect(page.getByTestId("publisher-status-message")).toHaveText(
    /Failed: character "\/" in track namespace field at index 0/,
  );

  // "-" 区切りに直すと警告が消え、入力も編集できる状態に戻る
  await namespaceInput.fill("moqt-devtools-a1B2c3D4e5F6g7H8");
  await expect(warning).toHaveCount(0);
});

test("Namespace が §8.8 の表記として読めないときは Start Subscribing を拒否する", async ({
  page,
}) => {
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);

  await expect(page.getByTestId("namespace-warning")).toHaveCount(0);
  await page.getByTestId("namespace").fill(INVALID_NAMESPACE);

  // 購読側も接続の前に拒否し、解析の失敗理由をステータスに出す
  await page.getByTestId("subscriber-subscribe-button").click();
  await expect(page.getByTestId("subscriber-status-message")).toHaveText(
    /Failed: character "\/" in track namespace field at index 0/,
  );
});

// §8.8 の表記として読めても送信できない値 (予約 namespace / 32 フィールド超) は、接続の前に
// 理由を出して拒否する。検証はライブラリの送信時のもの (src/session/params.ts) を共有する
test("送信できない Namespace は理由を出し、接続の前に Publish を拒否する", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const namespaceInput = page.getByTestId("namespace");
  const warning = page.getByTestId("namespace-warning");

  // ".session" は §2.4.3 の予約 namespace で、§8.8 では ".2esession" と書く
  await namespaceInput.fill(".2esession");
  await expect(warning).toHaveText(/reserved/);

  await page.getByTestId("publisher-publish-button").click();
  await expect(page.getByTestId("publisher-status-message")).toHaveText(/Failed: .*reserved/);

  // 33 フィールドは §8.7 の上限 (32) を超える
  await namespaceInput.fill(Array.from({ length: 33 }, (_value, index) => `n${index}`).join("-"));
  await expect(warning).toHaveText(/track namespace fields exceeds maximum: 33 > 32/);

  await page.getByTestId("publisher-publish-button").click();
  await expect(page.getByTestId("publisher-status-message")).toHaveText(
    /Failed: track namespace fields exceeds maximum: 33 > 32/,
  );
});

// 購読側も同じ検証を通る (requireConnectNamespace)。CHANGES / README が「配信 / 購読の開始を
// 拒否する」と書くため、予約 namespace で Start Subscribing が拒否されることを固定する
test("送信できない Namespace では Start Subscribing も拒否する", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);

  const namespaceInput = page.getByTestId("namespace");
  await namespaceInput.fill(".2esession");
  await expect(page.getByTestId("namespace-warning")).toHaveText(/reserved/);

  await page.getByTestId("subscriber-subscribe-button").click();
  await expect(page.getByTestId("subscriber-status-message")).toHaveText(
    /Failed: session-level namespace \.session is reserved/,
  );
});
