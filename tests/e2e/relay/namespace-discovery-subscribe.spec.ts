import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレーで、告知された namespace を発見し、その namespace の track を購読して
 * 映像が届くまでの通しを検証する
 *
 * draft-ietf-moq-transport-22 §4.1 (Publishing Namespaces):
 * publisher は PUBLISH_NAMESPACE で namespace を告知する。
 *
 * draft-ietf-moq-transport-22 §4.2 (Subscribing to Namespaces):
 * relay は告知された namespace を SUBSCRIBE_NAMESPACE の購読者へ NAMESPACE として列挙する。
 *
 * draft-ietf-moq-transport-22 §9.6 (SUBSCRIBE) — §9.7 (SUBSCRIBE_OK)
 * draft-ietf-moq-msf-01 Section 5 (Catalog)
 *
 * 告知と発見の往復 (namespace-announcement.spec.ts) と、既知の namespace の購読
 * (pubsub.spec.ts) を組み合わせ、本来の用途 (発見した配信を視聴する) の全体を
 * 実ブラウザの WebTransport と実リレーだけで確かめる。低レベルの probe は使わない。
 */
test("実リレーで発見した namespace の track を購読して映像を受信できる", async ({ browser }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // テストごとに一意な namespace を使う。SUBSCRIBE_NAMESPACE の prefix は先頭
  // フィールドだけにし、NAMESPACE の suffix と連結して自分の namespace を探す
  const namespace = createTestNamespace();
  const subscribedPrefix = [namespace[0]];
  const publisherPage = await openRelayPage(browser);
  const observerPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let subscriptionId: string | undefined;
  let subscriberId: string | undefined;

  try {
    // 告知する publisher を開始する。start() は PUBLISH_NAMESPACE の REQUEST_OK を
    // 待つため、relay が告知を拒否すればこの evaluate で失敗する
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      { url: moqtUri, namespace, announceNamespace: true },
    );
    const activePublisherId = publisherId;
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).state,
            activePublisherId,
          ),
        { message: "告知が受理されて Publisher が publishing になるのを待つ", timeout: 30_000 },
      )
      .toBe("publishing");

    // 購読は catalog と映像が送られている状態で開始する (固定の sleep で待つと、
    // 遅い runner で catalog が届く前に購読してしまい flaky になる)
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).framesSent,
            activePublisherId,
          ),
        { message: "Publisher が映像フレームを送信し始めるのを待つ", timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // 別セッションで prefix を購読し、告知された namespace を発見する
    subscriptionId = await observerPage.evaluate(
      (options) => window.__moqtE2E.startSubscribeNamespace(options),
      { url: moqtUri, namespacePrefix: subscribedPrefix },
    );
    const activeSubscriptionId = subscriptionId;
    await expect
      .poll(
        () =>
          observerPage.evaluate(
            (args) =>
              window.__moqtE2E
                .getSubscribeNamespace(args.id)
                .namespaces.some(
                  (candidate) =>
                    candidate.length === args.expected.length &&
                    candidate.every((field, index) => field === args.expected[index]),
                ),
            { id: activeSubscriptionId, expected: namespace },
          ),
        { message: "SUBSCRIBE_NAMESPACE で告知された namespace を観測する", timeout: 30_000 },
      )
      .toBe(true);

    // 発見した namespace をそのまま購読へ渡し、映像が届くまで待つ
    subscriberId = await observerPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace },
    );
    const activeSubscriberId = subscriberId;
    await expect
      .poll(
        () =>
          observerPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).framesReceived,
            activeSubscriberId,
          ),
        {
          message: "発見した namespace の購読で映像フレームを受信するのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    // 失敗を握り潰していないことと、購読が active であることを確かめる
    const subscriberStatus = await observerPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(subscriberStatus.errors).toEqual([]);
    expect(subscriberStatus.state).toBe("active");
    expect(subscriberStatus.hasCatalog).toBe(true);
    expect(subscriberStatus.hasVideoTrack).toBe(true);
    expect(subscriberStatus.bytesReceived).toBeGreaterThan(0);

    // 告知は購読の間も維持されている (NAMESPACE_DONE を受けていない)
    const subscriptionStatus = await observerPage.evaluate(
      (id) => window.__moqtE2E.getSubscribeNamespace(id),
      activeSubscriptionId,
    );
    expect(subscriptionStatus.state).toBe("active");
    expect(
      subscriptionStatus.done.some(
        (candidate) =>
          candidate.length === namespace.length &&
          candidate.every((field, index) => field === namespace[index]),
      ),
    ).toBe(false);
  } finally {
    if (subscriberId !== undefined) {
      await observerPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (subscriptionId !== undefined) {
      await observerPage.evaluate(
        (id) => window.__moqtE2E.stopSubscribeNamespace(id),
        subscriptionId,
      );
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(observerPage);
    await closeRelayPage(publisherPage);
  }
});
