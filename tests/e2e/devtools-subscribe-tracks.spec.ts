import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// devtools の subscriber の SUBSCRIBE_TRACKS の UI テスト
// 実リレーは起動しない (relay を通した SUBSCRIBE_TRACKS / PUBLISH のやり取りは
// 相互運用 harness で確かめる)
// dev サーバーは playwright.config.ts の webServer が空きポートで起動する

// SUBSCRIBE_TRACKS は SUBSCRIBE とは別の制御メッセージである (§9.17)。購読オプション行の
// 見出しは「その指定がどのメッセージで効くか」を表すため、既存の SUBSCRIBE の見出しを
// 再利用せず SUBSCRIBE_TRACKS を出す。購読の開始時にだけ効く指定であり、購読中は
// 変更できない
test("SUBSCRIBE_TRACKS の切り替えを購読オプション行に置き、既定で送る", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  const optionRow = page.getByTestId("subscriber-option-row");
  // SUBSCRIBE_TRACKS の見出し (メッセージ名) と切り替えを出す
  await expect(optionRow.getByText("SUBSCRIBE_TRACKS", { exact: true })).toBeVisible();
  const subscribeTracks = optionRow.getByTestId("subscriber-subscribe-tracks");
  await expect(optionRow.getByText("Accept PUBLISH", { exact: true })).toBeVisible();
  await expect(subscribeTracks).toBeVisible();
  // 既定で送る
  await expect(subscribeTracks).toBeChecked();
  // 購読していないため変更できる
  await expect(subscribeTracks).toBeEnabled();

  // チェックを外せる
  await subscribeTracks.uncheck();
  await expect(subscribeTracks).not.toBeChecked();
  // 元に戻す
  await subscribeTracks.check();
  await expect(subscribeTracks).toBeChecked();
});
