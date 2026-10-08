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
