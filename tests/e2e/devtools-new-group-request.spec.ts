import { test, expect } from "@playwright/test";
import type { PublisherStats } from "../../devtools/src/testApi";

// devtools の publisher が受けた新しい Group の要求 (NEW_GROUP_REQUEST) の数の UI テスト
// 実リレーは起動しない (relay を通した要求と新しい Group の開始は相互運用 harness で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

test("publisher が受けた新しい Group の要求の数を画面と window.moqtDevTools に出す", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("publisher-statistics-toggle").click();

  const newGroupRequests = await page.evaluate(() => {
    // 公開する統計の型は実装から借りる (フィールド名のずれを型で検出する)
    const api = (window as unknown as { moqtDevTools: { getPublisher: () => PublisherStats } })
      .moqtDevTools;
    return api.getPublisher().newGroupRequests;
  });
  // 配信していない状態では 0
  expect(newGroupRequests).toBe(0);
  await expect(page.getByTestId("publisher-new-group-requests")).toHaveText("0");
});

// Request Keyframe は購読中の操作であり、購読の設定 (購読の開始前に効く
// NEW_GROUP_REQUEST の切り替え) と同じ 1 行の項目の行に置く。主要な操作の行
// (Start Subscribing / Stop) には置かない。DYNAMIC_GROUPS=1 を広告しない Track では
// 要求できないため (§9.20.19 の MUST NOT)、購読していない間は押せない
test("Request Keyframe は NEW_GROUP_REQUEST と同じ行に置き、購読していない間は押せない", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  const optionRow = page.getByTestId("subscriber-option-row");
  const requestKeyframe = optionRow.getByRole("button", { name: "Request Keyframe" });
  await expect(requestKeyframe).toBeVisible();
  // 購読していない (subscriber が null) ため無効
  await expect(requestKeyframe).toBeDisabled();

  // 主要な操作の行にあるのは Start Subscribing と Stop の 2 つだけである
  const buttonsRow = page.getByTestId("subscriber-subscribe-button").locator("..");
  await expect(buttonsRow.getByRole("button")).toHaveCount(2);
  await expect(buttonsRow.getByRole("button", { name: "Start Subscribing" })).toBeVisible();
  await expect(buttonsRow.getByRole("button", { name: "Stop" })).toBeVisible();
});
