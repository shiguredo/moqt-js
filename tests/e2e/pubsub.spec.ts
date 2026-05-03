import { test, expect } from "@playwright/test";
import { waitForE2EReady } from "./helpers";

const HTTPS_URI = process.env["TEST_MOQT_HTTPS_URI"];
const AUTH_TOKEN = process.env["TEST_MOQT_AUTH_TOKEN"];

const PUBSUB_DURATION_MS = 5000;
// Subscriber が先行で subscribe を開始してから Publisher を起動する遅延
const PUBLISHER_START_DELAY_MS = 200;

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

      // Subscriber を先に立ち上げてから Publisher を始動する
      await new Promise<void>((resolve) => setTimeout(resolve, PUBLISHER_START_DELAY_MS));

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
