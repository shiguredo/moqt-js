import { test, expect } from "@playwright/test";
import { waitForE2EReady } from "./helpers";

const HTTPS_URI = process.env["TEST_MOQT_HTTPS_URI"];
const AUTH_TOKEN = process.env["TEST_MOQT_AUTH_TOKEN"];

const PUBSUB_DURATION_MS = 5000;
// Publisher が catalog を publish してから Subscriber を起動するまでの遅延
// createMediaSubscriber.start() は内部で catalog を 5 秒で待つので、
// Subscriber が先に start すると Publisher の encoder 初期化と catalog publish が
// 5 秒以内に間に合わない relay 構成で flaky になる。
// Publisher を先に起動して joiningFetch 経由で Subscriber が catalog を取得する流れにする。
const SUBSCRIBER_START_DELAY_MS = 500;
// Subscriber 起動までの待ち時間ぶん Publisher 側を多く走らせる必要がある
const PUBLISHER_DURATION_MS = PUBSUB_DURATION_MS + SUBSCRIBER_START_DELAY_MS;

test.describe("MOQT Canvas pub/sub", () => {
  test.skip(!HTTPS_URI, "TEST_MOQT_HTTPS_URI is not set");

  // 同じ relay (TEST_MOQT_HTTPS_URI) に対して同一 namespace で pub/sub する
  // 5 秒間 publish/subscribe を継続し、その間に decode 失敗 (onError) が起きないことを成功条件とする
  test("publishes and subscribes a canvas video over MOQT", async ({ browser }) => {
    test.skip(!AUTH_TOKEN, "TEST_MOQT_AUTH_TOKEN is not set");

    const namespace = ["e2e", crypto.randomUUID()];

    const publisherContext = await browser.newContext();
    const subscriberContext = await browser.newContext();

    try {
      const publisherPage = await publisherContext.newPage();
      const subscriberPage = await subscriberContext.newPage();

      await Promise.all([waitForE2EReady(publisherPage), waitForE2EReady(subscriberPage)]);

      const publisherPromise = publisherPage.evaluate(
        ({ url, token, ns, durationMs }) =>
          window.__moqtE2E.publishCanvas({
            url,
            authorizationTokenValue: token,
            namespace: ns,
            durationMs,
          }),
        {
          url: HTTPS_URI as string,
          token: AUTH_TOKEN as string,
          ns: namespace,
          durationMs: PUBLISHER_DURATION_MS,
        },
      );

      // Publisher が catalog を publish するまで待つ
      await new Promise<void>((resolve) => setTimeout(resolve, SUBSCRIBER_START_DELAY_MS));

      const subscriberPromise = subscriberPage.evaluate(
        ({ url, token, ns, durationMs }) =>
          window.__moqtE2E.subscribeCanvas({
            url,
            authorizationTokenValue: token,
            namespace: ns,
            durationMs,
          }),
        {
          url: HTTPS_URI as string,
          token: AUTH_TOKEN as string,
          ns: namespace,
          durationMs: PUBSUB_DURATION_MS,
        },
      );

      const [publisherResult, subscriberResult] = await Promise.all([
        publisherPromise,
        subscriberPromise,
      ]);

      expect(publisherResult.errors).toEqual([]);
      expect(subscriberResult.errors).toEqual([]);
      expect(publisherResult.finalState).toBe("publishing");
      expect(subscriberResult.finalState).toBe("active");
      expect(subscriberResult.hasVideoTrack).toBe(true);
    } finally {
      await publisherContext.close();
      await subscriberContext.close();
    }
  });
});
