/**
 * moqt-devtools の publisher が送る PUBLISH_NAMESPACE を、実リレー経由で観測する
 *
 * devtools は createMediaPublisher を使わず、publisher パネルから独自に
 * session.publish() を呼ぶ。そのため namespace の告知 (PUBLISH_NAMESPACE) も
 * 独自の経路で送る。ここでは実ブラウザと実リレーだけで次の 2 つを確かめる。
 *
 * 1. パネルの Announce namespace を有効にすると、配信の開始時に PUBLISH_NAMESPACE が
 *    送られ、relay の REQUEST_OK を受けて確立する。統計 API の namespaceAnnouncement が
 *    "active" になり、その後も映像の Object が流れ続ける
 * 2. 別 Session の SUBSCRIBE_NAMESPACE から、告知した namespace が NAMESPACE として
 *    観測できる
 *
 * draft-ietf-moq-transport-23 §7.7 は、namespace への購読を自分へルーティングして
 * ほしい publisher に PUBLISH_NAMESPACE を明示することを MUST とする。§4.2 は relay が
 * 告知された namespace を SUBSCRIBE_NAMESPACE の購読者へ列挙することを定める。
 *
 * 告知の受理 (REQUEST_OK) は 1 で、発見 (NAMESPACE) は 2 で別々に確かめる。relay が
 * PUBLISH_NAMESPACE を受理しても NAMESPACE を返さない実装はあり得るため、受理を先に
 * assert しておく。現行の relay は NAMESPACE を返すことを既存の
 * tests/e2e/relay/namespace-announcement.spec.ts で確認しているため、2 も必須にする。
 */

import { expect, test, type Browser, type Page } from "@playwright/test";
import { formatTrackNamespace, parseTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL } from "../urls";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  readNamespaceSubscription,
  requireRelayUri,
  startNamespaceSubscription,
  waitForNamespaceDiscovered,
  waitForNamespaceDone,
} from "./support";

/** devtools の publisher が映像の Object を送り始めるまで待つ上限 */
const PUBLISH_START_TIMEOUT_MS = 30_000;

/** テスト全体の上限 (開始待ちと観測待ちの合計に余裕を取る) */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** devtools の publisher の統計 (window.moqtDevTools.getPublisher()) の必要な部分 */
interface DevtoolsPublisherStats {
  status: string;
  /** パネルのトグルの値 (PUBLISH_NAMESPACE を送る設定か) */
  announceNamespace: boolean;
  /** relay に受理された告知の確立状態 (未確立は null) */
  namespaceAnnouncement: "active" | null;
  objectsSent: number;
}

/** 実リレーへ向けて devtools の publisher を起動し、告知を有効にして配信を始める */
async function startDevtoolsPublisher(
  browser: Browser,
  url: string,
  namespaceName: string,
): Promise<{ page: Page; namespace: string[] }> {
  const page = await browser.newPage();
  const params = new URLSearchParams({
    url,
    namespace: namespaceName,
    mode: "publisher",
    // vp8 は headless Chromium で符号化できる (既定の vp9 は環境によって失敗する)
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    audioSource: "dummy",
  });
  try {
    await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(page.getByTestId("moqt-uri")).toHaveValue(url);
    await expect(page.getByTestId("namespace-warning")).toHaveCount(0);
    // 接続先の URI の msf fragment が namespace を上書きすることがあるため、
    // 告知に使われる欄の実効値を使う
    const effectiveNamespaceName = await page.getByTestId("namespace").inputValue();
    const namespace = parseTrackNamespace(effectiveNamespaceName);
    expect(namespace.length, "告知する namespace が空である").toBeGreaterThan(0);

    // devtools の既定では告知が有効である (subscriber の SUBSCRIBE_TRACKS も既定で
    // 有効なため、既定同士で別ノードの prefix 購読が成立するようにする)
    const announceCheckbox = page.getByTestId("publisher-announce-namespace");
    await expect(announceCheckbox).toBeEnabled();
    await expect(announceCheckbox).toBeChecked();

    await page.getByTestId("publisher-publish-button").click();
    // 送る設定 (announceNamespace) だけでなく、relay の REQUEST_OK で告知が確立したこと
    // (namespaceAnnouncement が "active") を待つ。告知はすべての PUBLISH の後に始まり、
    // 最初の映像 Object の送信より前なので、objectsSent > 0 は告知の確立後である
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const api = (
              window as unknown as {
                moqtDevTools: { getPublisher(): DevtoolsPublisherStats };
              }
            ).moqtDevTools;
            const stats = api.getPublisher();
            return {
              started: stats.status === "connected" && stats.objectsSent > 0,
              announceNamespace: stats.announceNamespace,
              namespaceAnnouncement: stats.namespaceAnnouncement,
            };
          }),
        {
          message:
            "moqt-devtools の publisher が告知を受理され、映像の Object を送り始めるのを待つ",
          timeout: PUBLISH_START_TIMEOUT_MS,
        },
      )
      .toEqual({
        started: true,
        announceNamespace: true,
        namespaceAnnouncement: "active",
      });
    return { page, namespace };
  } catch (error) {
    await closeRelayPage(page);
    throw error;
  }
}

test("moqt-devtools の publisher の namespace 告知が実リレーで受理され、SUBSCRIBE_NAMESPACE で観測できる", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const requestedNamespace = createTestNamespace();
  const publisher = await startDevtoolsPublisher(
    browser,
    moqtUri,
    formatTrackNamespace(requestedNamespace),
  );
  const observerPage = await openRelayPage(browser);
  let subscriptionId: string | undefined;
  let publisherStopped = false;

  try {
    // 告知した namespace の先頭フィールドを SUBSCRIBE_NAMESPACE の prefix にする。
    // NAMESPACE の suffix と連結して、自分の namespace だけを探す
    const subscribedPrefix = publisher.namespace[0];
    if (subscribedPrefix === undefined) {
      throw new Error("告知した namespace の先頭フィールドが無い");
    }
    subscriptionId = await startNamespaceSubscription(observerPage, moqtUri, [subscribedPrefix]);
    const activeSubscriptionId = subscriptionId;

    // 購読そのものが失敗していないことを先に確かめる (失敗を隠さない)
    const subscription = await readNamespaceSubscription(observerPage, activeSubscriptionId);
    expect(subscription.state).toBe("active");
    expect(subscription.errors).toEqual([]);

    // 告知が受理された後にだけ、別 Session の購読者へ NAMESPACE が届くところまで確かめる
    await waitForNamespaceDiscovered(observerPage, activeSubscriptionId, publisher.namespace);

    // 観測の間に購読側でエラーが起きていないこと (失敗を握り潰していないこと) も確かめる
    const observedSubscription = await readNamespaceSubscription(
      observerPage,
      activeSubscriptionId,
    );
    expect(observedSubscription.errors).toEqual([]);

    // 停止すると告知が done() で撤回され、購読者へ NAMESPACE_DONE が届く (§9.16)。
    // 告知の受理だけでなく撤回も実リレーで確かめる
    const stopButton = publisher.page.getByTestId("publisher-stop-button");
    await expect(stopButton).toBeEnabled();
    await stopButton.click();
    await waitForNamespaceDone(observerPage, activeSubscriptionId, publisher.namespace);
    publisherStopped = true;
  } finally {
    if (subscriptionId !== undefined) {
      await observerPage
        .evaluate((id) => window.__moqtE2E.stopSubscribeNamespace(id), subscriptionId)
        .catch(() => {});
    }
    // 停止まで到達していない場合だけ、配信を止めて告知を撤回する
    if (!publisherStopped) {
      const stopButton = publisher.page.getByTestId("publisher-stop-button");
      if (await stopButton.isEnabled().catch(() => false)) {
        await stopButton.click().catch(() => {});
      }
    }
    await closeRelayPage(observerPage);
    await closeRelayPage(publisher.page);
  }
});
