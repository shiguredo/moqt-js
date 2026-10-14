import type { Page } from "@playwright/test";

/**
 * Copy ボタンを押し、「Copied!」の表示を待つ
 *
 * 「Copied!」はクリップボードへの書き込みが成功した後、1.5 秒だけ出る
 * (devtools/src/hooks/useCopyFeedback.ts の DEFAULT_DURATION_MS)。遅い runner では
 * expect のポーリング間隔 (locator の解決とプロトコルの往復) がこの窓より長くなり、
 * 表示を取りこぼして失敗する。ページの中で繰り返し見ることで窓を取りこぼさない。
 *
 * 書き込みが失敗した場合、hook は表示を変えずに console.error だけを出すため、
 * ここでタイムアウトする (テストは失敗する)。
 *
 * @param page - 操作するページ
 * @param testId - Copy ボタンの data-testid
 */
export async function clickCopyButton(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.waitForFunction(
    (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent === "Copied!",
    testId,
    // ページの中で 50 ms ごとに見る (rAF だと描画が止まっている間だけ見落としうる)
    { polling: 50, timeout: 15_000 },
  );
}
