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
