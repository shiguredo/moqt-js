import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * namespace のフィールド列が完全一致するかを判定する
 *
 * SUBSCRIBE_NAMESPACE の prefix は共有のため、他のテストの namespace も届く。
 * 対象の namespace だけを見るために完全一致で比較する。
 */
function matchesNamespace(candidate: string[], expected: string[]): boolean {
  return (
    candidate.length === expected.length &&
    candidate.every((field, index) => field === expected[index])
  );
}

/**
 * 実リレーで、告知された namespace を発見し、その namespace の track を購読して
 * 映像が届くまでの通しを検証する
 *
 * draft-ietf-moq-transport-22 §4.1 (Publishing Namespaces):
 * publisher は PUBLISH_NAMESPACE で namespace を告知する。
 *
 * draft-ietf-moq-transport-22 §4.2 (Subscribing to Namespaces):
 * relay は告知された namespace を SUBSCRIBE_NAMESPACE の購読者へ NAMESPACE として列挙し、
 * 告知が撤回されると NAMESPACE_DONE を送る。
 *
 * draft-ietf-moq-transport-22 §9.6 (SUBSCRIBE) — §9.7 (SUBSCRIBE_OK)
 * draft-ietf-moq-msf-01 Section 5 (Catalog)
 *
 * 告知と発見の往復 (namespace-announcement.spec.ts) と、既知の namespace の購読
 * (pubsub.spec.ts) を組み合わせ、本来の用途 (発見した配信を視聴する) の全体を
 * 実ブラウザの WebTransport と実リレーだけで確かめる。低レベル API の
 * `PUBLISH_NAMESPACE` 単体の probe は使わない。
 */
test("実リレーで発見した namespace の track を購読して映像を受信できる", async ({ browser }) => {
  // この spec は 5 段階を待つ (publishing / framesSent / NAMESPACE / framesReceived /
  // keyFramesReceived)。各 poll の上限は 30 秒で、合計 150 秒が既定の
  // RELAY_TEST_TIMEOUT_MS を超えるため、全体の timeout だけを延ばす
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 2);
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

    // 後続の startSubscriber が catalog を受信できるよう、publisher の送信開始を
    // 先に待つ (固定の sleep で待つと、遅い runner で catalog が届く前に購読して
    // しまい flaky になる)
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
                .namespaces.find(
                  (candidate) =>
                    candidate.length === args.expected.length &&
                    candidate.every((field, index) => field === args.expected[index]),
                ) ?? null,
            { id: activeSubscriptionId, expected: namespace },
          ),
        { message: "SUBSCRIBE_NAMESPACE で告知された namespace を観測する", timeout: 30_000 },
      )
      .not.toBeNull();

    // 発見した namespace を取り出し、そのまま購読へ渡す
    const discovered = await observerPage.evaluate(
      (args) =>
        window.__moqtE2E
          .getSubscribeNamespace(args.id)
          .namespaces.find(
            (candidate) =>
              candidate.length === args.expected.length &&
              candidate.every((field, index) => field === args.expected[index]),
          ) ?? null,
      { id: activeSubscriptionId, expected: namespace },
    );
    if (discovered === null) {
      throw new Error("発見した namespace を取り出せなかった");
    }
    subscriberId = await observerPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace: discovered },
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

    // キーフレームの到着も待つ。デルタフレームだけでは復号が始まらず、受信した
    // Object 数を数えているだけでは「映像が届いた」ことにならない
    await expect
      .poll(
        () =>
          observerPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).keyFramesReceived,
            activeSubscriberId,
          ),
        {
          message: "発見した namespace の購読でキーフレームを受信するのを待つ",
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

    // 告知側のセッションも失敗を握り潰していない
    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherStatus.errors).toEqual([]);
    expect(publisherStatus.state).toBe("publishing");

    // 告知は購読の間も維持されている (対象の namespace の NAMESPACE_DONE を受けていない)
    const subscriptionStatus = await observerPage.evaluate(
      (id) => window.__moqtE2E.getSubscribeNamespace(id),
      activeSubscriptionId,
    );
    expect(subscriptionStatus.errors).toEqual([]);
    expect(subscriptionStatus.state).toBe("active");
    expect(
      subscriptionStatus.done.some((candidate) => matchesNamespace(candidate, namespace)),
    ).toBe(false);
  } finally {
    // 停止時に relay が control stream を RESET_STREAM することがあるため、
    // 停止とページ close の失敗で元の失敗を上書きしない
    if (subscriberId !== undefined) {
      await observerPage
        .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
        .catch(() => {});
    }
    if (subscriptionId !== undefined) {
      await observerPage
        .evaluate((id) => window.__moqtE2E.stopSubscribeNamespace(id), subscriptionId)
        .catch(() => {});
    }
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => {});
    }
    await closeRelayPage(observerPage).catch(() => {});
    await closeRelayPage(publisherPage).catch(() => {});
  }
});
