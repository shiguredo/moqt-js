import { test, expect } from "@playwright/test";
import type { SubscriberStats } from "../../devtools/src/testApi";
import { EMPTY_AUDIO_PLAYOUT_TIMING } from "../../src/playout/audioPlayoutTimingStats";
import { EMPTY_HOST_DELAY } from "../../devtools/src/utils/hostDelayTracker";
import { DEVTOOLS_URL } from "./urls";

// devtools の Subscriber パネルとテスト用 API が、音声の再生の観測値
// (再生予定時刻・到着時刻・鳴り始める時刻・予定に対する余裕・鳴らなかった量) を出すことの
// UI テスト。実リレーは起動しない (値そのものは単体テストと実機の確認で確かめる)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

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
  // メインスレッドの停止 (longtask) と、停止区間と重なった到着
  hostStallCount: "subscriber-audio-host-stall-count",
  hostStallMs: "subscriber-audio-host-stall-ms",
  hostOverlappedArrivals: "subscriber-audio-host-overlapped-arrivals",
  // 受信の到着の遅れ。配信側の sendLagMs と対で読む
  receiveDelayMs: "subscriber-audio-receive-delay",
  maxReceiveDelayMs: "subscriber-audio-max-receive-delay",
  // 補間で埋まらなかった穴と、予約できなかった穴
  gapCount: "subscriber-audio-playback-gap-count",
  gapMs: "subscriber-audio-playback-gap-ms",
  gapMaxMs: "subscriber-audio-playback-gap-max-ms",
  unrecoverableGapCount: "subscriber-audio-playback-unrecoverable-gap-count",
  unrecoverableGapMs: "subscriber-audio-playback-unrecoverable-gap-ms",
  // 予約の追い越しと押し直し
  lateStartCount: "subscriber-audio-playback-late-start-count",
  lateStartMaxMs: "subscriber-audio-playback-late-start-max",
  pushStartCount: "subscriber-audio-playback-push-start-count",
  pushStartMaxMs: "subscriber-audio-playback-push-start-max",
  // バッファ境界の段差
  boundaryStepCount: "subscriber-audio-playback-boundary-step-count",
  boundaryStepMax: "subscriber-audio-playback-boundary-step-max",
  // 停止の drain
  drainPlayedMs: "subscriber-audio-playback-drain-played-ms",
  drainCutMs: "subscriber-audio-playback-drain-cut-ms",
  drainWaitedMs: "subscriber-audio-playback-drain-waited-ms",
  drainRequestedMs: "subscriber-audio-playback-drain-requested-ms",
  // 目標遅延の上限と時間圧縮の速さ
  appliedCeilingMs: "subscriber-audio-playback-applied-ceiling",
  compressionMsPerSecond: "subscriber-audio-playback-compression-ms-per-second",
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
    return {
      list: first.audio.playoutTiming,
      single: single.audio.playoutTiming,
      listHostDelay: first.audio.hostDelay,
      singleHostDelay: single.audio.hostDelay,
    };
  });

  // まだ鳴らしていないため、値が無いことを null で、累積を 0 で表す
  expect(playoutTiming.list).toEqual(EMPTY_AUDIO_PLAYOUT_TIMING);
  expect(playoutTiming.single).toEqual(EMPTY_AUDIO_PLAYOUT_TIMING);
  // メインスレッドの停止もまだ観測していない (longtask を報告しない環境でも 0 になる)
  expect(playoutTiming.listHostDelay).toEqual(EMPTY_HOST_DELAY);
  expect(playoutTiming.singleHostDelay).toEqual(EMPTY_HOST_DELAY);
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
  // メインスレッドの停止はまだ観測していない (監視していない環境でも 0 になる)
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.hostStallCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.hostStallMs)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.hostOverlappedArrivals)).toHaveText("0");
  // 到着の遅れはまだ観測していない
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.receiveDelayMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.maxReceiveDelayMs)).toHaveText("-");
  // 穴・予約不能の穴・予約の追い越しと押し直し・境界の段差は 0 から始まる
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.gapCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.gapMs)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.gapMaxMs)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.unrecoverableGapCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.unrecoverableGapMs)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lateStartCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.lateStartMaxMs)).toHaveText("0.0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.pushStartCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.pushStartMaxMs)).toHaveText("0.0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.boundaryStepCount)).toHaveText("0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.boundaryStepMax)).toHaveText("0");
  // まだ停止していないため drain の値は "-"、上限は既定の 100 ms、圧縮は 0
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.drainPlayedMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.drainCutMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.drainWaitedMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.drainRequestedMs)).toHaveText("-");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.appliedCeilingMs)).toHaveText("100.0");
  await expect(page.getByTestId(AUDIO_PLAYBACK_ITEMS.compressionMsPerSecond)).toHaveText("0");
});
