import { test, expect } from "@playwright/test";
import type { PublisherStats, SubscriberStats } from "../../devtools/src/testApi";

// devtools の遅延の区間ごとの統計と、stream の reset と欠落の一覧の UI テスト
// 実リレーは起動しない (値そのものは実リレー経由の相互運用 harness と手元の計測で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// subscriber の区間 (devtools/src/utils/latencyBreakdown.ts の LATENCY_SEGMENTS と同じ並び)
const SUBSCRIBER_SEGMENTS = [
  "arrival",
  "hold",
  "decodeWait",
  "decode",
  "displayWait",
  "displayLatency",
] as const;

test("window.moqtDevTools から遅延の区間ごとの統計が読める", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 配信も購読もしていない状態でも、統計の項目が公開されていること
  const stats = await page.evaluate(() => {
    // 公開する統計の型は実装から借りる (フィールド名のずれを型で検出する)
    const api = (
      window as unknown as {
        moqtDevTools: {
          getPublisher: () => PublisherStats;
          getSubscribers: () => SubscriberStats[];
        };
      }
    ).moqtDevTools;
    const [first] = api.getSubscribers();
    if (!first) {
      throw new Error("no subscriber instance");
    }
    return { publisher: api.getPublisher(), subscriber: first };
  });

  // publisher: 符号化と送信の時間、encoder の待ちで捨てたフレームの数
  expect(stats.publisher.publishTiming).toEqual({
    encodeMs: null,
    sendMs: null,
    encodeQueueDrops: 0,
  });
  // subscriber: 描いたフレームの区間ごとの遅延
  const timing = stats.subscriber.playbackTiming;
  expect(Object.keys(timing.latencyBreakdown)).toEqual([...SUBSCRIBER_SEGMENTS]);
  for (const segment of SUBSCRIBER_SEGMENTS) {
    expect(timing.latencyBreakdown[segment]).toBeNull();
  }
  // subscriber: RESET_STREAM の error code ごとの数と、reset と欠落の止まりの一覧
  expect(timing.subgroupStreamResetsByCode).toEqual({});
  expect(timing.recentLossEvents).toEqual([]);
});

// 分布の表の列 (devtools/src/components/StatsView.tsx の TimingTable と同じ並び)
const DISTRIBUTION_COLUMNS = ["p50", "p95", "max"] as const;

test("publisher と subscriber の画面に遅延の区間を出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // publisher: 記録が無いうちは分布の各列を "-"、捨てたフレームの数を 0 にする
  for (const column of DISTRIBUTION_COLUMNS) {
    await expect(page.getByTestId(`publisher-encode-time-${column}`)).toHaveText("-");
    await expect(page.getByTestId(`publisher-send-time-${column}`)).toHaveText("-");
  }
  await expect(page.getByTestId("publisher-encode-queue-drops")).toHaveText("0");

  // subscriber: 区間ごとの分布を表の 1 行ずつに出す。記録が無いうちは各列を "-" にする
  for (const segment of SUBSCRIBER_SEGMENTS) {
    for (const column of DISTRIBUTION_COLUMNS) {
      await expect(
        page.getByTestId(`subscriber-latency-breakdown-${segment}-${column}`),
      ).toHaveText("-");
    }
  }
  // 区間の行は LATENCY_SEGMENTS の並びで出す (表示の遅延を最後の合計の行にする)
  await expect(page.getByTestId("subscriber-latency-breakdown").getByRole("rowheader")).toHaveText([
    ...SUBSCRIBER_SEGMENTS,
  ]);

  // subscriber: reset と欠落の一覧
  await expect(page.getByTestId("subscriber-subgroup-stream-resets-by-code")).toHaveText("-");
  await expect(page.getByTestId("subscriber-recent-loss-events")).toHaveText("-");
});
