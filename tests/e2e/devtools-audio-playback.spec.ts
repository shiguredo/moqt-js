import { test, expect } from "@playwright/test";
import type { SubscriberStats } from "../../devtools/src/testApi";
import { EMPTY_AUDIO_PLAYOUT_TIMING } from "../../src/audioPlayoutTimingStats";

// devtools の Subscriber パネルとテスト用 API が、音声の再生の観測値
// (再生予定時刻・到着時刻・鳴り始める時刻・予定に対する余裕・鳴らなかった量) を出すことの
// UI テスト。実リレーは起動しない (値そのものは単体テストと実機の確認で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

// 音声の再生の観測の data-testid (devtools/src/components/SubscriberPanel.tsx)
const AUDIO_PLAYBACK_ITEMS = {
  // 分布 (p50 / p95 / max) の表。行の testId に列名が付く
  slackP50: "subscriber-audio-playback-slack-p50",
  startDelayP50: "subscriber-audio-playback-start-delay-p50",
  latenessP50: "subscriber-audio-playback-lateness-p50",
  // 直近に鳴らすと決めた音の値
  lastTargetMs: "subscriber-audio-playback-last-target",
  lastArrivalMs: "subscriber-audio-playback-last-arrival",
  lastStartMs: "subscriber-audio-playback-last-start",
  lastSlackMs: "subscriber-audio-playback-last-slack",
  playedFrames: "subscriber-audio-playback-played-frames",
  playedMs: "subscriber-audio-playback-played-ms",
  arrivalPlannedFrames: "subscriber-audio-playback-arrival-planned-frames",
  unplannedFrames: "subscriber-audio-playback-unplanned-frames",
  // 鳴らさなかった量 (理由ごとの件数とミリ秒、および合計)。鳴り遅れでは捨てないため、
  // 理由は backlog / catchUp / error / stopped の 4 つである
  missedBacklogCount: "subscriber-audio-playback-missed-backlog-count",
  missedCatchUpCount: "subscriber-audio-playback-missed-catchUp-count",
  missedErrorCount: "subscriber-audio-playback-missed-error-count",
  missedStoppedCount: "subscriber-audio-playback-missed-stopped-count",
  missedTotalCount: "subscriber-audio-playback-missed-total-count",
  missedTotalMs: "subscriber-audio-playback-missed-total-ms",
  recentMisses: "subscriber-audio-playback-recent-misses",
} as const;

test("window.moqtDevTools から音声の再生の観測値が読め、未購読では既定値になる", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  // 配信も購読もしていない状態でも、統計の項目が公開されていること
  const playoutTiming = await page.evaluate(() => {
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
    return { list: first.audio.playoutTiming, single: single.audio.playoutTiming };
  });

  // まだ鳴らしていないため、値が無いことを null で、累積を 0 で表す
  expect(playoutTiming.list).toEqual(EMPTY_AUDIO_PLAYOUT_TIMING);
  expect(playoutTiming.single).toEqual(EMPTY_AUDIO_PLAYOUT_TIMING);
});

test("subscriber の画面に音声の再生の観測を既定値で出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("subscriber-statistics-toggle").click();

  // まだ鳴らしていないため、時刻と分布は "-"、累積は 0 になる
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.slackP50)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.startDelayP50)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.latenessP50)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lastTargetMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lastArrivalMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lastStartMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lastSlackMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.playedFrames)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.playedMs)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.arrivalPlannedFrames)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.unplannedFrames)).toHaveText("0");
  // 鳴らさなかった量は、理由ごとと合計の両方を出す (audio → video の順に並ぶ)
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedBacklogCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedCatchUpCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedErrorCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedStoppedCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedTotalCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.missedTotalMs)).toHaveText("0");
  // 直近の一覧はまだ空である
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.recentMisses)).toHaveText("-");
});
