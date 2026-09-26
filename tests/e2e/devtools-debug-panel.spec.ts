import { expect, test, type Page } from "@playwright/test";

// デバッグパネルの表示と「Copy for LLM」のテキストを実ブラウザで確かめる。
// 実リレーは起動せず、ログはページの中でモジュールを読み込んで直接追加する
// (devtools にはコンポーネントテストの基盤 (Vitest Browser Mode) が無いため、
//  表示の確認はこの E2E で行う)。
// コピーしたテキストを読むため、このファイルだけクリップボードの権限を与える
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const DEVTOOLS_URL = "http://localhost:5173/index.html";

interface InjectedLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
  payload?: number[];
}

/**
 * ログをページの中で直接追加する
 *
 * アプリが読み込んだものと同じモジュール実体を使う必要があるため、URL は
 * Resource Timing から取る (HMR のタイムスタンプ付きでも同じ実体になる)。
 */
async function addLogs(page: Page, logs: InjectedLog[]): Promise<void> {
  await page.evaluate(async (entries) => {
    const findResource = (pattern: RegExp): string => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => pattern.test(name));
      if (!url) {
        throw new Error(`no loaded module: ${String(pattern)}`);
      }
      return url;
    };

    const debugLog = (await import(findResource(/\/src\/signals\/debugLog\.ts/))) as {
      addLog: (
        level: InjectedLog["level"],
        message: string,
        data?: unknown,
        payload?: Uint8Array,
      ) => void;
    };

    for (const entry of entries) {
      debugLog.addLog(
        entry.level,
        entry.message,
        entry.data,
        entry.payload === undefined ? undefined : new Uint8Array(entry.payload),
      );
    }
  }, logs);
}

/** デバッグパネルを開く */
async function openDebugPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Debug/ }).click();
  await expect(page.getByRole("heading", { name: "Debug Logs" })).toBeVisible();
}

test("デバッグパネルがログを新しい順に表示し、展開と折りたたみとクリアが動く", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await openDebugPanel(page);
  await expect(page.getByTestId("debug-log-list")).toContainText("No logs yet.");

  await addLogs(page, [
    { level: "info", message: "e2e-log-1", data: { requestId: 1 } },
    { level: "warn", message: "e2e-log-2", data: { requestId: 2 }, payload: [1, 2, 3] },
  ]);

  const rows = page.getByTestId("debug-log-row");
  await expect(rows).toHaveCount(2);
  // 表示は新しい順
  await expect(rows.nth(0)).toContainText("e2e-log-2");
  await expect(rows.nth(1)).toContainText("e2e-log-1");
  await expect(page.getByTestId("debug-log-count")).toHaveText("Logs: 2");
  // 追加時に整形した絶対時刻 (HH:MM:SS.mmm) と経過時間 (+S.mmm) を出す
  await expect(rows.nth(1)).toContainText(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  await expect(rows.nth(1)).toContainText(/\+\d+\.\d{3}/);

  // 行をクリックすると data を開き、もう一度クリックすると閉じる
  await rows.nth(1).click();
  await expect(rows.nth(1).locator("pre")).toContainText("Request ID: 1");
  await rows.nth(1).click();
  await expect(rows.nth(1).locator("pre")).toHaveCount(0);

  // payload を持つ行は Binary タブで hex dump を見られる
  await rows.nth(0).click();
  await expect(rows.nth(0).locator("pre")).toContainText("Request ID: 2");
  await rows
    .nth(0)
    .getByRole("button", { name: /^Binary/ })
    .click();
  await expect(rows.nth(0).locator("pre")).toContainText("0000  01 02 03");
  // 開いている行を閉じてから一括の操作を行う ("Collapse All" 表示を "Expand All" へ戻す)
  await rows.nth(0).click();
  await expect(rows.nth(0).locator("pre")).toHaveCount(0);

  // Expand All は data を持つ行をすべて開き、Collapse All はすべて閉じる
  await page.getByRole("button", { name: "Expand All" }).click();
  await expect(page.locator('[data-testid="debug-log-row"] pre')).toHaveCount(2);
  await page.getByRole("button", { name: "Collapse All" }).click();
  await expect(page.locator('[data-testid="debug-log-row"] pre')).toHaveCount(0);

  // Clear で空に戻る
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("debug-log-list")).toContainText("No logs yet.");
  await expect(page.getByTestId("debug-log-count")).toHaveText("Logs: 0");
});

test("Copy for LLM が設定と統計の項目とログを出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // Subscriber を 1 つ足して、Subscriber の統計の節も出す
  await page.getByRole("button", { name: "Add Subscriber" }).click();
  await openDebugPanel(page);
  await addLogs(page, [{ level: "info", message: "copy-log", data: { requestId: 7 } }]);

  const copyButton = page.getByTestId("debug-log-copy-all");
  await copyButton.click();
  // クリップボードへの書き込みの完了を待つ ("Copied!" は書き込みが成功した後だけ出る)
  await expect(copyButton).toHaveText("Copied!");
  const text = await page.evaluate(() => navigator.clipboard.readText());

  // 設定の節。Target Latency / Render Group と音声の設定、認可トークンの設定の有無を出す
  expect(text).toContain("=== Connection Settings ===");
  expect(text).toContain("targetLatencyMs: -");
  expect(text).toContain("renderGroup: -");
  expect(text).toContain("catalogSubscriptionTimeoutMs: 5000");
  expect(text).toContain("audioCodec: opus");
  expect(text).toContain("audioDelivery: subgroup");
  expect(text).toContain("useDedicatedWorker: true");
  expect(text).toContain("jitterBufferEnabled: true");
  expect(text).toContain("authorizationTokenConfigured: false");

  // Subscriber の節。同期の推定と音声の統計を出す (id は subscriber- + 8 桁の 16 進)
  expect(text).toMatch(/=== Subscriber Statistics \(subscriber-[0-9a-f]{8}\) ===/);
  expect(text).toContain("currentSubGroup:");
  expect(text).toContain("avSync:");
  expect(text).toContain("audio:");
  expect(text).toContain("sessionStatistics: -");

  // ログの節
  expect(text).toContain("=== Debug Logs ===");
  expect(text).toContain("copy-log");
  expect(text).toContain("Request ID: 7");

  // 配信していないページでは Publisher の節を出さない
  expect(text).not.toContain("Publisher Statistics");
});
