import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// 主操作は開始と停止で同じ場所を使う。補助操作、SETUP、主操作の順に置く。
// モックは使わず、接続前の実際のパネルと、入力の検証で開始に失敗した後の復帰を確かめる。
test("Publish と Subscribe の操作をそろえ、開始に失敗しても再実行できる", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const publishButton = page.getByTestId("publisher-publish-button");
  const subscribeButton = page.getByTestId("subscriber-subscribe-button");
  await expect(publishButton).toHaveText("Publish");
  await expect(subscribeButton).toHaveText("Subscribe");
  await expect(publishButton.locator("..").getByRole("button")).toHaveCount(3);
  await expect(subscribeButton.locator("..").getByRole("button")).toHaveCount(3);
  await expect(page.getByTestId("publisher-setup-button")).toBeEnabled();
  await expect(page.getByTestId("subscriber-setup-button")).toBeEnabled();
  await expect(page.getByTestId("publisher-stop-button")).toHaveCount(0);
  await expect(page.getByTestId("subscriber-stop-button")).toHaveCount(0);

  // 停止方法は主操作の幅を圧迫しないよう、配信の設定行に置く。
  await expect(
    page.getByTestId("publisher-option-row").getByTestId("publisher-stop-mode"),
  ).toHaveValue("publish-done");

  // 解析できない Namespace はネットワーク接続より前に拒否される。
  // 開始中の表示や無効状態が残らず、同じボタンからやり直せることを確かめる。
  await page.getByTestId("namespace").fill("invalid/namespace");
  for (const [button, panel, label] of [
    [publishButton, "publisher", "Publish"],
    [subscribeButton, "subscriber", "Subscribe"],
  ] as const) {
    // SETUP 単独の失敗でも、配信・購読を始めずに入力と操作を有効へ戻す。
    const setupButton = page.getByTestId(`${panel}-setup-button`);
    await setupButton.click();
    await expect(page.getByTestId(`${panel}-status-message`)).toHaveText(/^Failed:/);
    await expect(setupButton).toBeEnabled();
    await button.click();
    await expect(page.getByTestId(`${panel}-status-message`)).toHaveText(/^Failed:/);
    await expect(button).toHaveText(label);
    await expect(button).toBeEnabled();
    await expect(page.getByTestId(`${panel}-stop-button`)).toHaveCount(0);
    await expect(setupButton).toBeEnabled();
  }
});
