import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

// 実リレー経由で Canvas のダミー映像を publish し、同じ namespace を subscribe して
// 映像トラックが届くところまでを検証する
//
// draft-ietf-moq-transport-22 §9.1 (SETUP)
// draft-ietf-moq-transport-22 §9.6 (SUBSCRIBE) — §9.7 (SUBSCRIBE_OK)
// draft-ietf-moq-msf-01 Section 5 (Catalog)
//
// 高レベル API (WebCodecs / MediaStream) を使うため、接続、カタログの publish と FETCH、
// SUBSCRIBE、subgroup の配送、VP8 の encode と decode までが 1 本のテストで通る。
// 実リレー固有の挙動 (カタログの publish とカタログ以外の track の扱い) が入るため、
// 単体テストでは置き換えられない。
test("実リレー経由で Canvas の映像を publish し、同じ namespace の subscribe で受信できる", async ({
  browser,
}) => {
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
      (options) => window.__moqtE2E.startPublisher(options),
      { url: moqtUri, namespace },
    );
    const activePublisherId = publisherId;

    // Publisher が実際にフレームを送るまで待つ。固定の sleep で待つと、遅い runner で
    // カタログが届く前に subscribe してしまい flaky になる
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).framesSent,
            activePublisherId,
          ),
        {
          message: "Publisher が映像フレームを送信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    // 以降の Subscriber は、Publisher がカタログと映像を送っている状態で開始する
    subscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace },
    );
    const activeSubscriberId = subscriberId;

    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).framesReceived,
            activeSubscriberId,
          ),
        {
          message: "Subscriber が映像フレームを受信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    // キーフレームの到着も待つ。デルタフレームだけでは復号が始まらず、受信した
    // Object 数を数えているだけでは「映像が届いた」ことにならない
    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).keyFramesReceived,
            activeSubscriberId,
          ),
        {
          message: "Subscriber が映像のキーフレームを受信するのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    const subscriberStatus = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(subscriberStatus.errors).toEqual([]);
    expect(subscriberStatus.state).toBe("active");
    expect(subscriberStatus.hasCatalog).toBe(true);
    expect(subscriberStatus.hasVideoTrack).toBe(true);
    expect(subscriberStatus.bytesReceived).toBeGreaterThan(0);

    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherStatus.errors).toEqual([]);
    expect(publisherStatus.state).toBe("publishing");
    expect(publisherStatus.keyFramesSent).toBeGreaterThan(0);
  } finally {
    if (subscriberId !== undefined) {
      await subscriberPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(subscriberPage);
    await closeRelayPage(publisherPage);
  }
});
