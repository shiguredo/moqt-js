import { test, expect } from "@playwright/test";
import type { PublisherStats } from "../../devtools/src/testApi";
import { DEVTOOLS_URL } from "./urls";

// devtools の publisher が受けた新しい Group の要求 (NEW_GROUP_REQUEST) の数の UI テスト
// 実リレーは起動しない (relay を通した要求と新しい Group の開始は相互運用 harness で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

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

// NEW_GROUP_REQUEST (REQUEST_UPDATE) は購読中の操作 (REQUEST_UPDATE に NEW_GROUP_REQUEST を
// 載せて送る) であり、購読の設定 (購読の開始前に効く NEW_GROUP_REQUEST の切り替え) と
// 同じ項目の行に置く。主要な操作の行 (Start Subscribing / Stop) には置かない。同じ
// NEW_GROUP_REQUEST がどのメッセージで届くのかを読み取れるよう、行の中の各項目は
// メッセージ名の見出し (SUBSCRIBE / REQUEST_UPDATE) を出す。DYNAMIC_GROUPS=1 を
// 広告しない Track では要求できないため (§9.20.19 の MUST NOT)、購読していない間は
// 押せない
test("NEW_GROUP_REQUEST は SUBSCRIBE と同じ行に置き、購読していない間は押せない", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  const optionRow = page.getByTestId("subscriber-option-row");
  // 購読の開始時に送る SUBSCRIBE の指定と、購読中に送る REQUEST_UPDATE の操作である
  // ことを、項目の見出しで明示する
  await expect(optionRow.getByText("SUBSCRIBE", { exact: true })).toBeVisible();
  await expect(optionRow.getByTestId("subscriber-new-group-request")).toBeVisible();
  await expect(optionRow.getByText("REQUEST_UPDATE", { exact: true })).toBeVisible();
  const requestNewGroup = optionRow.getByRole("button", {
    name: "NEW_GROUP_REQUEST",
    exact: true,
  });
  await expect(requestNewGroup).toBeVisible();
  // 購読していない (subscriber が null) ため無効
  await expect(requestNewGroup).toBeDisabled();

  // 主要な操作の行にあるのは、受信した音声の再生 (Play Audio)、Start Subscribing、Stop の
  // 3 つである。NEW_GROUP_REQUEST の操作は項目の行にあり、ここには置かない
  const buttonsRow = page.getByTestId("subscriber-subscribe-button").locator("..");
  await expect(buttonsRow.getByRole("button")).toHaveCount(3);
  await expect(
    buttonsRow.getByRole("button", { name: "NEW_GROUP_REQUEST", exact: true }),
  ).toHaveCount(0);
  await expect(buttonsRow.getByRole("button", { name: "Start Subscribing" })).toBeVisible();
  await expect(buttonsRow.getByRole("button", { name: "Stop" })).toBeVisible();
});
