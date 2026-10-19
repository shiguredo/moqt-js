import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// Subscriber の Playback Delay の設定が画面にあり、既定は Off で、UI から変更でき、
// Copy URL と URL クエリで往復できることを確かめる。復号前キューへの実際の反映は
// 単体テスト (PreDecodeDelayQueue の setDelayMs / takeAll) で固定する。
test("Playback Delay は既定で Off で、UI から動的に変更でき、URL で往復できる", async ({
  page,
}) => {
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber`);
  const select = page.getByTestId("settings-pre-decode-delay");
  await expect(select).toHaveValue("0");
  await expect(select.locator("option:checked")).toHaveText("Off");

  // UI から変更すると signal が変わり、Copy URL にも載る
  await select.selectOption("2000");
  await expect(select).toHaveValue("2000");
  await page.getByTestId("copy-url").click();
  await expect(page).toHaveURL(/preDecodeDelayMs=2000/);

  // URL から復元できる
  await page.goto(`${DEVTOOLS_URL}?mode=subscriber&preDecodeDelayMs=2000`);
  const restored = page.getByTestId("settings-pre-decode-delay");
  await expect(restored).toHaveValue("2000");
  await expect(restored.locator("option:checked")).toHaveText("2000 ms");
});
