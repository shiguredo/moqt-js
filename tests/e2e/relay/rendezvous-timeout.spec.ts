import { expect, test } from "@playwright/test";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレーで RENDEZVOUS_TIMEOUT の往復を検証する
 *
 * draft-ietf-moq-transport-22 §9.20.6 (RENDEZVOUS_TIMEOUT):
 * 省略時の既定は 0 であり、publisher が居なければ relay は即 REQUEST_ERROR
 * (DOES_NOT_EXIST) を返す MUST。relay は要求より短い時間で TIMEOUT を返し得る。
 *
 * 高レベル API の rendezvousTimeout が SUBSCRIBE に載り、publisher 不在のときに
 * RequestError (code と retryInterval) として start() の失敗に届くことと、
 * publisher が居る購読が待ちの指定で壊れないことを確かめる。
 */
test("実リレーで publisher 不在の購読に RENDEZVOUS_TIMEOUT を載せると RequestError で失敗する", async ({
  browser,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // このテストは publisher を開始しないため、namespace は誰も publish していない
  const namespace = createTestNamespace();
  const page = await openRelayPage(browser);

  try {
    const failure = await page.evaluate(
      (options) => window.__moqtE2E.startSubscriberFailure(options),
      { url: moqtUri, namespace, rendezvousTimeout: 1000 },
    );

    // relay が即時または期限切れで publisher 不在を伝えること
    expect(failure.isRequestError).toBe(true);
    expect([0x02, 0x10]).toContain(failure.code); // TIMEOUT / DOES_NOT_EXIST
    expect(failure.message.length).toBeGreaterThan(0);
  } finally {
    await closeRelayPage(page);
  }
});

/**
 * 実リレーで publisher が居る購読に RENDEZVOUS_TIMEOUT を指定しても購読が確立する
 * (待ちの指定が通常の購読経路を壊さない)。
 */
test("実リレーで publisher が居る購読は RENDEZVOUS_TIMEOUT を指定しても確立する", async ({
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
    // Publisher がフレームを送るまで待ってから購読する
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

    subscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace, rendezvousTimeout: 5000 },
    );
    const activeSubscriberId = subscriberId;
    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).state,
            activeSubscriberId,
          ),
        { message: "RENDEZVOUS_TIMEOUT を指定した購読が active になるのを待つ", timeout: 30_000 },
      )
      .toBe("active");
  } finally {
    if (subscriberId !== undefined) {
      await subscriberPage
        .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
        .catch(() => {});
    }
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => {});
    }
    await closeRelayPage(publisherPage);
    await closeRelayPage(subscriberPage);
  }
});
