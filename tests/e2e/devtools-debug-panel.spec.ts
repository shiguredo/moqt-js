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
  // Subscriber は起動時に 1 つ作られる (devtools/src/main.tsx) ため、その節が出る
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

test("Copy for LLM の Publisher と Subscriber のボタンは、その接続のログだけを出す", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);
  await openDebugPanel(page);
  // 起動時に作られた Subscriber の id を、そのコピーボタンを押すために使う
  const targetId = await page.evaluate(() => {
    const host = window as unknown as {
      moqtDevTools: { getSubscribers: () => { id: string }[] };
    };
    return host.moqtDevTools.getSubscribers()[0]?.id ?? "";
  });
  expect(targetId).toMatch(/^subscriber-[0-9a-f]{8}$/);

  await addLogs(page, [
    { level: "info", message: "[publisher] [SEND] OBJECT" },
    { level: "info", message: `[${targetId}] [RECV] OBJECT` },
  ]);

  // Publisher のボタンは [publisher] のログだけを出す
  const publisherButton = page.getByTestId("debug-log-copy-publisher");
  await publisherButton.click();
  await expect(publisherButton).toHaveText("Copied!");
  const publisherText = await page.evaluate(() => navigator.clipboard.readText());
  expect(publisherText).toContain("=== Debug Logs ([publisher]) ===");
  expect(publisherText).toContain("[publisher] [SEND] OBJECT");
  expect(publisherText).not.toContain(`[${targetId}] [RECV] OBJECT`);

  // Subscriber のボタンはその id の統計とログを出す
  const subscriberButton = page.getByTestId(`debug-log-copy-${targetId}`);
  await subscriberButton.click();
  await expect(subscriberButton).toHaveText("Copied!");
  const subscriberText = await page.evaluate(() => navigator.clipboard.readText());
  expect(subscriberText).toContain(`=== Subscriber Statistics (${targetId}) ===`);
  expect(subscriberText).toContain(`=== Debug Logs ([${targetId}]) ===`);
  expect(subscriberText).toContain(`[${targetId}] [RECV] OBJECT`);
  expect(subscriberText).not.toContain("[publisher] [SEND] OBJECT");
});

test("上限で捨てたログの展開状態を残さない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await openDebugPanel(page);
  const rows = page.getByTestId("debug-log-row");

  // 上限 (1000 件) まで追加し、さらに 1 件足して最古を捨てる。ここで表示の位置と
  // ログの連番がずれる (先頭の行の連番は 1000、表示の位置は 0)
  await addLogs(
    page,
    Array.from({ length: 1001 }, (_, index) => ({
      level: "info" as const,
      message: `keep-${index}`,
      data: { index },
    })),
  );
  await expect(page.getByTestId("debug-log-count")).toHaveText("Logs: 1000");
  await expect(rows.nth(0)).toContainText("keep-1000");

  // 最新の行を展開する。展開の状態を配列の添字で持っていると、この行は開かない
  await rows.nth(0).click();
  await expect(rows.nth(0).locator("pre")).toContainText("index: 1000");
  await expect(page.getByRole("button", { name: "Collapse All" })).toBeVisible();

  // 展開していた行を捨てるまで追加する (1000 件追加すると、残るのは後ろの 1000 件)
  await addLogs(
    page,
    Array.from({ length: 1000 }, (_, index) => ({
      level: "info" as const,
      message: `filler-${index}`,
    })),
  );

  await expect(page.getByTestId("debug-log-count")).toHaveText("Logs: 1000");
  // 捨てたログの展開状態が残っていれば "Collapse All" のままになる
  await expect(page.getByRole("button", { name: "Expand All" })).toBeVisible();
  await expect(page.locator('[data-testid="debug-log-row"] pre')).toHaveCount(0);
  // 一覧の先頭は、残っている最新のログ
  await expect(rows.nth(0)).toContainText("filler-999");
});

test("パネルを閉じているときは Debug ボタンにログ件数のバッジを出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  const badge = page.getByTestId("debug-log-badge");
  await expect(badge).toHaveCount(0);

  await addLogs(page, [{ level: "info", message: "badge-log" }]);
  await expect(badge).toHaveText("1");

  // パネルを開いている間は件数をツールバーに出すため、バッジは出さない
  await openDebugPanel(page);
  await expect(page.getByTestId("debug-log-badge")).toHaveCount(0);
  await expect(page.getByTestId("debug-log-count")).toHaveText("Logs: 1");
});
