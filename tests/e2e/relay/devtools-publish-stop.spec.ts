/**
 * Stop Publish の止め方ごとに、購読者へ何が届くかを実リレーで観測する
 *
 * moqt-devtools の Stop Publish は 3 通りの止め方を持つ (URL クエリ `publishStop`)。
 * publisher の止め方によって購読者に届く終了通知は変わり、どちらになるかは止め方と relay の
 * 実装で決まる (draft-ietf-moq-transport-22 §7.4: 購読は unsubscribe するか、上流の publisher
 * が購読を終えるか、購読の期限が切れるまで残る)。ここでは実リレーに対して次の 2 つを観測し、
 * 結果をログに残す。差が出なかった場合はその事実を issue に記録する。
 *
 * - PUBLISH_DONE を送らずにセッションを閉じたとき (`close-session`)、購読者に何が届くか
 *   (relay が PUBLISH_DONE を代行して送るか、購読が残るか)
 * - 何も送らずに配信だけ止めたとき (`stop-sending`)、購読者に何も届かず購読が残るか
 *
 * 接続先は他の relay の spec と同じく `TEST_MOQT_URI` で渡す。未設定の環境では skip する。
 */

import { expect, test, type Browser, type Page } from "@playwright/test";
import { formatTrackNamespace, parseTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL } from "../urls";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/** moqt-devtools (publisher 側) の URL */

/** 配信が始まるまでの待ち (エンコーダの初期化と最初の Object の送信を待つ) */
const PUBLISH_START_TIMEOUT_MS = 30_000;

/** 購読が確立して最初の Object が届くまでの待ち */
const RECEIVE_TIMEOUT_MS = 30_000;

/** 停止の後で購読者の状態を見るまでの待ち */
const OBSERVE_TIMEOUT_MS = 10_000;

/** テスト全体の上限 (開始待ち + 受信待ち + 観測待ちの合計に余裕を取る) */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** devtools の publisher の統計 (window.moqtDevTools.getPublisher()) の必要な部分 */
interface DevtoolsPublisherStats {
  status: string;
  statusMessage: string;
  objectsSent: number;
  framesEncoded: number;
}

/**
 * devtools の Publisher を実リレーへ向けて起動し、ダミーの映像を送り始めるまで待つ
 *
 * 止め方は URL クエリ `publishStop` で渡す (select の値がそのまま反映される)。
 */
async function startDevtoolsPublisher(
  browser: Browser,
  url: string,
  namespaceName: string,
  publishStop: string,
): Promise<{ page: Page; namespace: string[] }> {
  const page = await browser.newPage();
  const params = new URLSearchParams({
    url,
    namespace: namespaceName,
    mode: "publisher",
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    audioSource: "dummy",
    publishStop,
  });
  try {
    await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(page.getByTestId("moqt-uri")).toHaveValue(url);
    // URL の止め方が select に反映されていること
    await expect(page.getByTestId("publisher-stop-mode")).toHaveValue(publishStop);
    await expect(page.getByTestId("namespace-warning")).toHaveCount(0);
    // TEST_MOQT_URI の msf fragment が namespace を上書きする場合があるため、欄の実効値を使う
    const effectiveNamespaceName = await page.getByTestId("namespace").inputValue();

    await page.getByTestId("publisher-publish-button").click();
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
            return stats.status === "connected" && stats.objectsSent > 0 && stats.framesEncoded > 0;
          }),
        {
          message: "moqt-devtools の publisher がダミー映像の Object を送り始めるのを待つ",
          timeout: PUBLISH_START_TIMEOUT_MS,
        },
      )
      .toBe(true);
    return { page, namespace: parseTrackNamespace(effectiveNamespaceName) };
  } catch (error) {
    await closeRelayPage(page);
    throw error;
  }
}

/** devtools の Publisher が送った Object と符号化したフレームの数 */
async function readPublisherSent(
  page: Page,
): Promise<{ objectsSent: number; framesEncoded: number }> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: { getPublisher(): DevtoolsPublisherStats };
      }
    ).moqtDevTools;
    const stats = api.getPublisher();
    return { objectsSent: stats.objectsSent, framesEncoded: stats.framesEncoded };
  });
}

/**
 * devtools の Publisher で配信を止める
 *
 * Stop を押した後、止め方ごとの表示になるまで待つ。`stop-sending` ではセッションを維持する
 * ため Status は connected のまま (押す前から connected) で、文言だけが変わる。したがって
 * 待つのは status ではなく statusMessage である。
 */
async function stopDevtoolsPublisher(page: Page, publishStop: string): Promise<void> {
  const stopButton = page.getByTestId("publisher-stop-button");
  await expect(stopButton).toBeEnabled();
  await stopButton.click();
  const expectedMessage =
    publishStop === "stop-sending" ? "Stopped sending (session kept)" : "Ready to publish";
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const api = (
            window as unknown as {
              moqtDevTools: { getPublisher(): DevtoolsPublisherStats };
            }
          ).moqtDevTools;
          return api.getPublisher().statusMessage;
        }),
      {
        message: "止めた後の publisher の表示になるのを待つ",
        timeout: OBSERVE_TIMEOUT_MS,
      },
    )
    .toBe(expectedMessage);
  console.log("止めた後の publisher の表示", publishStop, expectedMessage);
}

/**
 * 止め方ごとの観測結果を 1 行にまとめる
 *
 * 差が出なかった場合もそのまま記録できるよう、購読者の状態をそのまま出す。
 * 購読者は PUBLISH_DONE を受け取ると per-track の購読を閉じるため、state が active のままなら
 * 「relay が PUBLISH_DONE を代行していない」ことが分かる (src/subscriber.ts の handleEnd)。
 */
function formatObservation(
  publishStop: string,
  state: string,
  framesBefore: number,
  framesAfter: number,
  errors: string[],
): string {
  return [
    `publishStop=${publishStop}`,
    `購読者の state=${state}`,
    `停止前の受信 Object=${framesBefore}`,
    `停止後の受信 Object=${framesAfter}`,
    `購読者の error=${errors.length === 0 ? "なし" : errors.join(" / ")}`,
  ].join(" ");
}

test("Stop Publish の止め方ごとに、実リレーの購読者へ何が届くかを観測する", async ({ browser }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // PUBLISH_DONE を送らずにセッションを閉じる場合と、何も送らずに配信だけ止める場合
  for (const publishStop of ["close-session", "stop-sending"] as const) {
    const requestedNamespace = createTestNamespace();
    const publisher = await startDevtoolsPublisher(
      browser,
      moqtUri,
      formatTrackNamespace(requestedNamespace),
      publishStop,
    );
    const publisherPage = publisher.page;
    const subscriberPage = await openRelayPage(browser);
    let subscriberId: string | undefined;

    try {
      subscriberId = await subscriberPage.evaluate(
        (options) => window.__moqtE2E.startSubscriber(options),
        { url: moqtUri, namespace: publisher.namespace, audio: true },
      );
      const activeSubscriberId = subscriberId;

      // 購読が確立して Object が届くまで待つ
      await expect
        .poll(
          () =>
            subscriberPage.evaluate(
              (id) => window.__moqtE2E.getSubscriber(id).framesReceived,
              activeSubscriberId,
            ),
          { message: "購読者が映像の Object を受信するのを待つ", timeout: RECEIVE_TIMEOUT_MS },
        )
        .toBeGreaterThan(0);
      const before = await subscriberPage.evaluate(
        (id) => window.__moqtE2E.getSubscriber(id),
        activeSubscriberId,
      );

      await stopDevtoolsPublisher(publisherPage, publishStop);

      // 止めた後に送信が伸びないこと (止め方が効いていること)。停止の直後は送信の途中で
      // あり得るため、少し待ってから 2 回サンプリングして比べる
      await subscriberPage.waitForTimeout(OBSERVE_TIMEOUT_MS);
      const sentAfterStop = await readPublisherSent(publisherPage);
      await subscriberPage.waitForTimeout(OBSERVE_TIMEOUT_MS);
      const sentLater = await readPublisherSent(publisherPage);
      expect(sentLater, "止めた後に送信が伸びない").toEqual(sentAfterStop);

      const after = await subscriberPage.evaluate(
        (id) => window.__moqtE2E.getSubscriber(id),
        activeSubscriberId,
      );

      console.log(
        formatObservation(
          publishStop,
          after.state,
          before.framesReceived,
          after.framesReceived,
          after.errors,
        ),
      );

      // どちらの止め方でも、購読者が異常終了していないことだけを固定する。購読が残るか
      // PUBLISH_DONE が届くかは relay の実装で決まるため、ここでは結果をログに残すだけにする
      expect(after.state).toBe("active");
    } finally {
      if (subscriberId !== undefined) {
        await subscriberPage
          .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
          .catch(() => {});
      }
      await closeRelayPage(subscriberPage);
      // publisher のセッションを閉じる。stop-sending では開いたままのため、止め方を既定に
      // 戻してから Stop を押すのが close-session と同じ後始末になる
      const publisherStopButton = publisherPage.getByTestId("publisher-stop-button");
      if (await publisherStopButton.isEnabled().catch(() => false)) {
        await publisherPage
          .getByTestId("publisher-stop-mode")
          .selectOption("publish-done")
          .catch(() => {});
        await publisherStopButton.click({ timeout: 5_000 }).catch(() => {});
      }
      await closeRelayPage(publisherPage);
    }
  }
});
