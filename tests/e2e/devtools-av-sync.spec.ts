import { test, expect } from "@playwright/test";
import type { SubscriberStats } from "../../devtools/src/testApi";

// devtools の A/V 同期の統計と、publisher の Target Latency / Render Group の設定の UI テスト
// 実リレーは起動しない (同期の数値そのものは単体テストと実機の確認で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// 同期の 5 項目の data-testid (devtools/src/components/SubscriberPanel.tsx)
const AV_SYNC_ITEMS = {
  skewMs: "subscriber-av-sync-skew",
  presentationDelayMs: "subscriber-av-sync-presentation-delay",
  targetLatencyMs: "subscriber-av-sync-target-latency",
  targetLatencyLimitedMs: "subscriber-av-sync-target-latency-limited",
  audioClockFallback: "subscriber-av-sync-audio-clock-fallback",
} as const;

test("window.moqtDevTools から同期の 5 項目が読め、未購読では既定値になる", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 配信も購読もしていない状態でも、統計の項目が公開されていること
  const avSync = await page.evaluate(() => {
    // 公開する統計の型は実装から借りる (フィールド名のずれを型で検出する)
    const api = (
      window as unknown as {
        moqtDevTools: {
          getSubscribers: () => SubscriberStats[];
          getSubscriber: (id: string) => SubscriberStats | null;
        };
      }
    ).moqtDevTools;
    const [first] = api.getSubscribers();
    if (!first) {
      throw new Error("no subscriber instance");
    }
    // 実機の確認と同じ単数の経路 (getSubscriber) でも同じ値が読めること
    const single = api.getSubscriber(first.id);
    if (single === null) {
      throw new Error(`no subscriber stats: ${first.id}`);
    }
    return { list: first.avSync, single: single.avSync };
  });

  // 同期の推定が無い状態の既定値 (null / null / null / 0 / false)
  const defaults = {
    skewMs: null,
    presentationDelayMs: null,
    targetLatencyMs: null,
    targetLatencyLimitedMs: 0,
    audioClockFallback: false,
  };
  expect(avSync.list).toEqual(defaults);
  expect(avSync.single).toEqual(defaults);
});

test("subscriber の画面に同期の 5 項目を既定値で出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("subscriber-statistics-toggle").click();

  // 未購読では、値の無い 3 項目を "-"、切り下げた分を 0、時計の代用を false にする
  await expect(page.getByTestId(AV_SYNC_ITEMS.skewMs)).toHaveText("-");
  await expect(page.getByTestId(AV_SYNC_ITEMS.presentationDelayMs)).toHaveText("-");
  await expect(page.getByTestId(AV_SYNC_ITEMS.targetLatencyMs)).toHaveText("-");
  await expect(page.getByTestId(AV_SYNC_ITEMS.targetLatencyLimitedMs)).toHaveText("0");
  await expect(page.getByTestId(AV_SYNC_ITEMS.audioClockFallback)).toHaveText("false");
});

test("Target Latency と Render Group の選択が UI から URL へ反映され、生成された URL から復元される", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  // 既定は未指定であり、catalog に targetLatency も renderGroup も載せない
  await expect(page.getByTestId("target-latency")).toHaveValue("");
  await expect(page.getByTestId("render-group")).toHaveValue("");

  // UI から変更する (Copy URL は history.replaceState で URL を書き換える)
  await page.getByTestId("target-latency").selectOption("100");
  await page.getByTestId("render-group").selectOption("1");
  await page.getByTestId("copy-url").click();

  await expect(page).toHaveURL(/targetLatency=100/);
  await expect(page).toHaveURL(/renderGroup=1/);

  // 生成された URL を開き直すと設定が復元される (UI → signal → URL → signal の往復)
  await page.goto(page.url());
  await expect(page.getByTestId("target-latency")).toHaveValue("100");
  await expect(page.getByTestId("render-group")).toHaveValue("1");

  // 0 は有効値であるため、未指定 (Unset) と区別して往復する
  await page.getByTestId("target-latency").selectOption("0");
  await page.getByTestId("render-group").selectOption("0");
  await page.getByTestId("copy-url").click();

  await expect(page).toHaveURL(/targetLatency=0/);
  await expect(page).toHaveURL(/renderGroup=0/);

  await page.goto(page.url());
  await expect(page.getByTestId("target-latency")).toHaveValue("0");
  await expect(page.getByTestId("render-group")).toHaveValue("0");
});
