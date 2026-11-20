import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// devtools の event timeline (メッセージ) の UI テスト
// 実リレーは起動しない (配信を始めていない状態の表示だけを見る)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

test("Event Timeline の GZIP は既定で有効になり、チェックで無圧縮に切り替えられる", async ({
  page,
}) => {
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);
  const compression = page.getByTestId("event-timeline-compression");
  await expect(compression).toBeChecked();

  // 無圧縮の選択は共有 URL にも保存し、再読み込み後もチェックを外した状態にする。
  await compression.uncheck();
  await page.getByTestId("copy-url").click();
  await expect(page).toHaveURL(/eventTimelineCompression=0/);
  await page.reload();
  await expect(compression).not.toBeChecked();

  // 再度オンにすると、既定値を表すため URL の指定も消える。
  await compression.check();
  await page.getByTestId("copy-url").click();
  await expect(page).not.toHaveURL(/eventTimelineCompression=/);
  await page.reload();
  await expect(compression).toBeChecked();
});

test("Publisher の Messages は入力と送信を持ち、配信を始めるまで無効になる", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);

  const input = page.getByTestId("publisher-message-input");
  const send = page.getByTestId("publisher-message-send");
  await expect(input).toBeVisible();
  await expect(send).toBeVisible();

  // event timeline トラックの publisher が確立するまでは入力も送信も無効にする
  await expect(input).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(page.getByTestId("publisher-messages-sent")).toHaveText("Sent: 0");
});

test("Subscriber の Messages は購読前「-」を表示する", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);

  await expect(page.getByTestId("subscriber-messages")).toBeVisible();
  await expect(page.getByTestId("subscriber-messages-empty")).toHaveText("-");
});

test("表示モードに応じて Publisher と Subscriber の Messages を出し分ける", async ({ page }) => {
  await page.goto(`${DEVTOOLS_URL}?mode=publisher`);
  await expect(page.getByTestId("publisher-messages")).toBeVisible();
  await expect(page.getByTestId("subscriber-messages")).toHaveCount(0);

  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);
  await expect(page.getByTestId("subscriber-messages")).toBeVisible();
  await expect(page.getByTestId("publisher-messages")).toHaveCount(0);
});
