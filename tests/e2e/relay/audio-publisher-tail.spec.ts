import { expect, test, type Page } from "@playwright/test";
import type { PublisherStatus, SubscriberStatus } from "../main";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * ライブラリの配信を停止したとき、符号化パイプラインの末尾が送られて購読者へ届くことを
 * 実リレーで確かめる。
 *
 * ライブラリの Publisher は既定で Dedicated Worker で符号化する (`useWorker` の既定は
 * true)。停止時の末尾 flush は worker との `flush` / `flushed` のやり取りに依存するため、
 * Node の単体テスト (direct 符号化) だけでは確かめられない。ここでは実ブラウザの
 * `createMediaPublisher` と `createMediaSubscriber` を使い、偽のマイクの音声を実リレーへ
 * 配信し、停止した直後の統計 (`tailFlushed*` / `tailDropped*`) と購読側の受信増加を見る。
 *
 * 停止は `close()` で行う (`stopPublisher` が使う経路)。`stop()` と `close()` は同じ末尾
 * flush を通る。
 */
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
  permissions: ["microphone"],
});

/** 配信が安定するまで待つ音声 Object の数 (20 ms × 20 件 = 400 ms 分) */
const WARMUP_PUBLISHER_FRAMES = 20;

/** 購読が安定するまで待つ音声 Object の数 */
const WARMUP_SUBSCRIBER_FRAMES = 10;

/** 停止した配信側の統計を読む */
async function readPublisher(page: Page, id: string): Promise<PublisherStatus> {
  return page.evaluate((publisherId) => window.__moqtE2E.getPublisher(publisherId), id);
}

/** 購読側の統計を読む */
async function readSubscriber(page: Page, id: string): Promise<SubscriberStatus> {
  return page.evaluate((subscriberId) => window.__moqtE2E.getSubscriber(subscriberId), id);
}

/**
 * 配信側が音声 Object を送り始めるまで待つ
 *
 * 固定の sleep で待つと遅い runner でだけ落ちるため、統計を polling する。
 */
async function waitForPublisherFrames(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = await readPublisher(page, id);
        return status.audio?.framesSent ?? 0;
      },
      {
        message: "配信側が音声 Object を送り始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(WARMUP_PUBLISHER_FRAMES);
}

/** 購読側が音声 Object を復号へ渡し始めるまで待つ */
async function waitForSubscriberFrames(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = await readSubscriber(page, id);
        return status.audio?.framesReceived ?? 0;
      },
      {
        message: "購読側が音声 Object を受け取り始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(WARMUP_SUBSCRIBER_FRAMES);
}

/**
 * 停止の後に購読側が末尾を受け取り終えるまで待つ
 *
 * 配信側の close は PUBLISH_DONE を送るが、ライブラリの購読はセッションを閉じないため
 * state は "active" のままである。受信数が 2 回続けて同じになった時点を末尾の受信完了と
 * みなし、最後の値を返す。
 */
async function waitForSubscriberEnd(page: Page, id: string): Promise<SubscriberStatus> {
  const deadlineMs = Date.now() + 8_000;
  let last = await readSubscriber(page, id);
  for (;;) {
    await page.waitForTimeout(500);
    const current = await readSubscriber(page, id);
    if ((current.audio?.framesReceived ?? 0) === (last.audio?.framesReceived ?? 0)) {
      return current;
    }
    last = current;
    if (Date.now() > deadlineMs) {
      return current;
    }
  }
}

test.describe("ライブラリの配信停止の末尾", () => {
  for (const delivery of ["datagram", "subgroup"] as const) {
    test(`worker 符号化の末尾が停止で送られ、${delivery} で購読者へ届く`, async ({ browser }) => {
      test.setTimeout(RELAY_TEST_TIMEOUT_MS);
      const moqtUri = requireRelayUri();
      if (moqtUri === null) {
        return;
      }
      const namespace = createTestNamespace();
      const publisherPage = await openRelayPage(browser);
      const subscriberPage = await openRelayPage(browser);
      let publisherId: string | undefined;
      let subscriberId: string | undefined;
      try {
        publisherId = await publisherPage.evaluate(
          (options) =>
            window.__moqtE2E.startPublisher({
              url: options.url,
              namespace: options.namespace,
              audio: { codec: "opus", bitrate: 64_000, delivery: options.delivery },
            }),
          { url: moqtUri, namespace, delivery },
        );
        await waitForPublisherFrames(publisherPage, publisherId);

        subscriberId = await subscriberPage.evaluate(
          (options) =>
            window.__moqtE2E.startSubscriber({
              url: options.url,
              namespace: options.namespace,
              audio: true,
              video: false,
            }),
          { url: moqtUri, namespace },
        );
        await waitForSubscriberFrames(subscriberPage, subscriberId);

        const beforeSubscriber = await readSubscriber(subscriberPage, subscriberId);
        const beforeFramesReceived = beforeSubscriber.audio?.framesReceived ?? 0;

        // 配信を停止する (close の完了まで待ち、末尾 flush の計器を読む)
        const stopStartedAtMs = Date.now();
        const afterPublisher = await publisherPage.evaluate(
          (id) => window.__moqtE2E.stopPublisher(id),
          publisherId,
        );
        const stopDurationMs = Date.now() - stopStartedAtMs;
        publisherId = undefined;

        // 末尾の Object が PUBLISH_DONE より先に購読者へ届くのを待つ
        const afterSubscriber = await waitForSubscriberEnd(subscriberPage, subscriberId);
        subscriberId = undefined;

        const publisherAudio = afterPublisher.audio;
        const subscriberAudio = afterSubscriber.audio;
        console.log(
          `配信停止 (${delivery}): 停止まで ${String(stopDurationMs)} ms / ` +
            `tailFlushed=${String(publisherAudio?.tailFlushedFrames)} 件 ${String(publisherAudio?.tailFlushedMs)} ms / ` +
            `tailDropped=${String(publisherAudio?.tailDroppedFrames)} 件 ${String(publisherAudio?.tailDroppedMs)} ms / ` +
            `timeout=${String(publisherAudio?.tailFlushTimeoutCount)} / ` +
            `購読の増加=${String((subscriberAudio?.framesReceived ?? 0) - beforeFramesReceived)} 件 / ` +
            `購読の状態=${afterSubscriber.state}`,
        );

        // worker の flush が上限で打ち切られていない (ハングしていない)
        expect(
          publisherAudio?.tailFlushTimeoutCount,
          `停止時の flush か送信が上限で打ち切られている (${delivery})`,
        ).toBe(0);
        // 停止の受付時に確定した末尾が encoder の flush で送られている
        expect(
          publisherAudio?.tailFlushedFrames ?? 0,
          `停止時に送れた末尾の Object が無い (${delivery})`,
        ).toBeGreaterThan(0);
        // 読んだが送れなかった末尾が無い
        expect(
          publisherAudio?.tailDroppedFrames,
          `停止時に読んだ末尾が送られていない (${delivery})`,
        ).toBe(0);
        // 停止の所要時間は計測してログに出すだけにする。E2E は page evaluate と後始末を
        // 含み、CI の負荷で変動するため、判定は計器 (tailFlushTimeoutCount / tailDropped)
        // で行う
        expect(afterPublisher.errors, `配信側のエラーが無い (${delivery})`).toEqual([]);
        expect(afterSubscriber.errors, `購読側のエラーが無い (${delivery})`).toEqual([]);
        // 末尾の Object が PUBLISH_DONE より先に届いている (少なくとも 1 件)
        expect(
          (subscriberAudio?.framesReceived ?? 0) - beforeFramesReceived,
          `停止したのに購読者が末尾を受け取っていない (${delivery})`,
        ).toBeGreaterThanOrEqual(1);
      } finally {
        if (subscriberId !== undefined) {
          await subscriberPage
            .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
            .catch(() => undefined);
        }
        if (publisherId !== undefined) {
          await publisherPage
            .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
            .catch(() => undefined);
        }
        await closeRelayPage(publisherPage);
        await closeRelayPage(subscriberPage);
      }
    });
  }
});
