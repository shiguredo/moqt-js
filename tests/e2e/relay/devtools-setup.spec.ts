import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "../urls";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { createTestNamespace, requireRelayUri, RELAY_TEST_TIMEOUT_MS } from "./support";

// 実リレーとの SETUP と、その接続を使った配信・購読を確認する。送信ログも確認し、
// SETUP 単独で Catalog や namespace の要求が送られていないことを確かめる。
test("Setup は SETUP だけを送り、Publish と Subscribe は確立済みの接続を使う", async ({ page }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const url = requireRelayUri();
  if (url === null) return;
  const params = new URLSearchParams({
    url,
    namespace: formatTrackNamespace(createTestNamespace()),
    codec: "vp8",
    resolution: "640x360",
    audioSource: "none",
  });
  await page.goto(`${DEVTOOLS_URL}?${params}`);
  await page.getByRole("button", { name: /^Debug/ }).click();
  const sentMessages = page.getByTestId("debug-log-row").filter({ hasText: "[SEND]" });
  const setupMessages = sentMessages.filter({ hasText: "[SEND] SETUP" });

  for (const panel of ["publisher", "subscriber"]) {
    const setupButton = page.getByTestId(`${panel}-setup-button`);
    await expect(setupButton).toBeEnabled();
    await setupButton.click();
    await expect(page.getByTestId(`${panel}-status-message`)).toHaveText("Connected (SETUP only)");
    await expect(setupButton).toBeDisabled();
    // SETUP だけが完了しても、主操作は開始前のままである。
    await expect(page.getByTestId(`${panel}-stop-button`)).toHaveCount(0);
  }

  await expect(sentMessages).toHaveCount(2);
  await expect(setupMessages).toHaveCount(2);
  await expect(page.getByTestId("publisher-publish-button")).toBeEnabled();
  await expect(page.getByTestId("subscriber-subscribe-button")).toBeEnabled();

  await page.getByTestId("publisher-publish-button").click();
  await expect(page.getByTestId("publisher-setup-button")).toBeDisabled();
  await expect(page.getByTestId("publisher-stop-button")).toHaveText("Stop");
  await page.getByTestId("subscriber-subscribe-button").click();
  await expect(page.getByTestId("subscriber-setup-button")).toBeDisabled();
  await expect(page.getByTestId("subscriber-status-message")).toContainText("Subscribed");
  await expect(page.getByTestId("subscriber-stop-button")).toHaveText("Stop");

  // 開始時に接続し直すと SETUP が増える。SETUP が 2 件のまま、通常の要求だけが増える。
  await expect(setupMessages).toHaveCount(2);
  await expect(sentMessages.filter({ hasText: "[SEND] PUBLISH" }).first()).toBeVisible();
  await expect(sentMessages.filter({ hasText: "[SEND] SUBSCRIBE" }).first()).toBeVisible();

  await page.getByTestId("subscriber-stop-button").click();
  await expect(page.getByTestId("subscriber-setup-button")).toBeEnabled();
  await page.getByTestId("publisher-stop-button").click();
  await expect(page.getByTestId("publisher-setup-button")).toBeEnabled();

  // SETUP 単独の Subscriber を削除した場合も、接続を残さず設定の入力を元へ戻す。
  await page.getByRole("button", { name: "Add Subscriber", exact: true }).click();
  const extraSetup = page.getByTestId("subscriber-setup-button").nth(1);
  await extraSetup.click();
  await expect(page.getByTestId("subscriber-status-message").nth(1)).toHaveText(
    "Connected (SETUP only)",
  );
  await page.getByRole("button", { name: "Remove this subscriber", exact: true }).nth(1).click();
  await expect(page.getByTestId("subscriber-setup-button")).toHaveCount(1);
  await expect(page.getByTestId("moqt-uri")).toBeEditable();
});
