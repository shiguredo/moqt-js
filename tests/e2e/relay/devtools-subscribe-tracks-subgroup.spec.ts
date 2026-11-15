/**
 * devtools publisher と devtools subscriber を実リレーへつなぎ、SUBSCRIBE_TRACKS の
 * 結果 PUBLISH が同じ Track の 2 つ目の購読になっても、Malformed Track にならずに
 * 映像が復号されることを確かめる
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * relay は downstream の SUBSCRIBE_TRACKS を上流の publisher へ転送する。
 * publisher は一致する Track へ結果 PUBLISH を返し、relay が PUBLISH_OK を返すと
 * 同じ Track に 2 つ目の PUBLISH 購読ができる。
 *
 * draft-ietf-moq-transport-23 §7.1 (Caching Relays) / §12.1 (Malformed Tracks):
 * 同じ (Group, Object) を異なる Subgroup ID / Publisher Priority / Delivery Mode で
 * 送ると、受信側はその Track を Malformed として扱い、relay は downstream の購読を
 * PUBLISH_DONE (MALFORMED_TRACK) で終了させる。
 *
 * 起動時から配信している publisher の PUBLISH 購読は Group の先頭から送るが、
 * SUBSCRIBE_TRACKS の結果 PUBLISH の購読は配信の途中で確立するため Group の途中から
 * 送ることになる。両者が同じ Subgroup ID / Publisher Priority を使うことを、
 * 実ブラウザと実リレーだけで確かめる。観測する値は次の 2 つである。
 *
 * 1. publisher が SUBSCRIBE_TRACKS を受けて結果 PUBLISH の送信を始めていること
 *    (この経路が動かなければ、2 つ目の購読はできず検証にならない)
 * 2. subscriber が Malformed Track にならず、映像のフレームを復号し続けること
 *
 * 失敗を隠さないため、復号が始まらない場合と MALFORMED_TRACK で終わった場合は
 * どちらもテストを失敗させる。接続先は環境変数で渡し、ホスト名は spec に書かない。
 */

import { expect, test, type Browser, type Page } from "@playwright/test";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import type { PublisherStats, SubscriberStats } from "../../../devtools/src/testApi";
import { DEVTOOLS_URL } from "../urls";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  requireRelayUri,
} from "./support";

/**
 * テスト全体の上限
 *
 * publisher の起動、subscriber の起動、映像のキーフレーム到着 (既定の間隔は 10 秒) を
 * 1 本で待つため、既定の 30 秒では足りない。
 */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** publisher の起動 (告知の受理と最初の Object の送信) を待つ上限 */
const PUBLISH_START_TIMEOUT_MS = 30_000;

/** 結果 PUBLISH の送信開始を待つ上限 */
const RESULT_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * 映像の復号が始まるまで待つ上限
 *
 * subscriber は Group の途中から購読するため、最初のキーフレームまで待つ必要がある。
 * moqt-devtools のキーフレーム間隔の既定は 10 秒であり、経路の遅れも見込む。
 */
const FRAMES_TIMEOUT_MS = 60_000;

/** 復号が続いていることを確かめる観測時間 */
const GROWTH_OBSERVE_MS = 3_000;

/** 観測の間隔 */
const SAMPLE_INTERVAL_MS = 250;

/** devtools publisher の統計を読む */
async function readPublisher(page: Page): Promise<PublisherStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getPublisher(): PublisherStats } })
      .moqtDevTools;
    return api.getPublisher();
  });
}

/** devtools subscriber の統計を読む (先頭の購読者) */
async function readSubscriber(page: Page): Promise<SubscriberStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getSubscribers(): SubscriberStats[] } })
      .moqtDevTools;
    const subscriber = api.getSubscribers()[0];
    if (subscriber === undefined) {
      throw new Error("購読者がまだ作られていない");
    }
    return subscriber;
  });
}

/**
 * devtools publisher を実リレーへつなぎ、namespace の告知を有効にして配信を始める
 *
 * SUBSCRIBE_TRACKS を上流の publisher へ転送してもらうには、publisher が namespace を
 * PUBLISH_NAMESPACE で告知している必要がある (draft-ietf-moq-transport-23 §7.7 の MUST)。
 */
async function startDevtoolsPublisher(
  browser: Browser,
  moqtUri: string,
  namespaceName: string,
): Promise<Page> {
  const page = await browser.newPage();
  const params = new URLSearchParams({
    url: moqtUri,
    namespace: namespaceName,
    mode: "publisher",
    // headless Chromium で符号化できるコーデックにする (既定の vp9 は環境によって失敗する)
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    // 映像だけで検証する (音声の有無は Subgroup ID / Priority の一致に影響しない)
    audioSource: "none",
  });
  try {
    await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);
    await expect(page.getByTestId("namespace-warning")).toHaveCount(0);

    const announceCheckbox = page.getByTestId("publisher-announce-namespace");
    await expect(announceCheckbox).toBeEnabled();
    await announceCheckbox.check();
    await expect(announceCheckbox).toBeChecked();

    await page.getByTestId("publisher-publish-button").click();
    // 告知が relay に受理され (namespaceAnnouncement が "active")、映像の Object が
    // 流れ始めるまで待つ。この時点から Group が進むため、後から確立する結果 PUBLISH は
    // Group の途中からになる。
    await expect
      .poll(
        async () => {
          const stats = await readPublisher(page);
          return {
            connected: stats.status === "connected",
            announcement: stats.namespaceAnnouncement,
            publishing: stats.objectsSent > 0,
          };
        },
        {
          message: "devtools publisher の告知が受理され、映像の Object が流れ始めるのを待つ",
          timeout: PUBLISH_START_TIMEOUT_MS,
        },
      )
      .toEqual({ connected: true, announcement: "active", publishing: true });
    return page;
  } catch (error) {
    await closeRelayPage(page);
    throw error;
  }
}

/**
 * devtools subscriber を実リレーへつなぎ、SUBSCRIBE_TRACKS を有効にして購読を始める
 *
 * SUBSCRIBE_TRACKS は既定で有効であるが、この検証の前提なので明示的に確かめる。
 * 購読の開始後、relay が publisher へ転送した SUBSCRIBE_TRACKS が届いて結果 PUBLISH が
 * 送られることを、publisher の統計で待つ。ここが動かなければ 2 つ目の購読はできず、
 * Subgroup ID の一致を確かめる対象が無い。
 */
async function startDevtoolsSubscriber(
  browser: Browser,
  moqtUri: string,
  namespaceName: string,
  publisherPage: Page,
): Promise<Page> {
  const page = await browser.newPage();
  const params = new URLSearchParams({
    url: moqtUri,
    namespace: namespaceName,
    mode: "subscriber",
    codec: "vp8",
    audioSource: "none",
  });
  try {
    await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);

    const subscribeTracksCheckbox = page.getByTestId("subscriber-subscribe-tracks");
    await expect(subscribeTracksCheckbox).toBeEnabled();
    if (!(await subscribeTracksCheckbox.isChecked())) {
      await subscribeTracksCheckbox.check();
    }
    await expect(subscribeTracksCheckbox).toBeChecked();

    await page.getByTestId("subscriber-subscribe-button").click();

    await expect
      .poll(
        async () => {
          const stats = await readPublisher(publisherPage);
          return stats.sessionStatistics?.subscribeTracksPublishSent ?? 0;
        },
        {
          message: "publisher が受信 SUBSCRIBE_TRACKS への結果 PUBLISH の送信を始めるのを待つ",
          timeout: RESULT_PUBLISH_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);
    return page;
  } catch (error) {
    await closeRelayPage(page);
    throw error;
  }
}

/** 購読の状態を 1 行にする (失敗したときの診断用。接続先は含めない) */
function summarizeSubscriber(stats: SubscriberStats): string {
  return [
    `status=${stats.status}`,
    `statusMessage=${JSON.stringify(stats.statusMessage)}`,
    `framesDecoded=${stats.framesDecoded}`,
    `objectsReceived=${stats.objectsReceived}`,
    `chunksDecoded=${stats.chunksDecoded}`,
    `decodeErrors=${stats.decodeErrors}`,
    `warnings=${stats.warnings.length}`,
  ].join(", ");
}

/**
 * 映像が復号されるまで待ち、Malformed Track で終わっていないことを確かめる
 *
 * MALFORMED_TRACK で終わった場合 (relay が同じ Object を異なる Subgroup ID で
 * 受信した場合) は、待ち切らずにその場で失敗させる。復号が始まらない場合は
 * 待ち時間の経過で失敗する。
 */
async function waitForVideoDecoding(page: Page): Promise<SubscriberStats> {
  const startedAtMs = Date.now();
  let latest = await readSubscriber(page);
  while (Date.now() - startedAtMs < FRAMES_TIMEOUT_MS) {
    if (latest.statusMessage.includes("MALFORMED_TRACK")) {
      throw new Error(
        `relay が Track を Malformed として終了させた (${summarizeSubscriber(latest)})`,
      );
    }
    if (latest.framesDecoded > 0) {
      return latest;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    latest = await readSubscriber(page);
  }
  throw new Error(
    `${FRAMES_TIMEOUT_MS} ms 待っても映像の復号が始まらない (${summarizeSubscriber(latest)})`,
  );
}

test("SUBSCRIBE_TRACKS の結果 PUBLISH が加わっても、実リレーで Malformed Track にならず映像が復号される", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  const publisherPage = await startDevtoolsPublisher(browser, moqtUri, namespace);
  let subscriberPage: Page | undefined;
  try {
    subscriberPage = await startDevtoolsSubscriber(browser, moqtUri, namespace, publisherPage);

    // 復号が始まるまで待つ。MALFORMED_TRACK で終わった場合はここで失敗する。
    const decoded = await waitForVideoDecoding(subscriberPage);
    const subscriber = await readSubscriber(subscriberPage);
    const publisher = await readPublisher(publisherPage);
    console.log(
      `配信側の観測: objectsSent=${publisher.objectsSent}, currentGroup=${publisher.currentGroup}`,
    );
    console.log(`購読側の観測: ${summarizeSubscriber(subscriber)}`);

    // 1. Malformed Track で終わっていない。relay は同じ Object を異なる Subgroup ID で
    //    受信すると PUBLISH_DONE (MALFORMED_TRACK) を送る。
    expect(
      subscriber.statusMessage,
      `MALFORMED_TRACK で購読が終了している (${summarizeSubscriber(subscriber)})`,
    ).not.toContain("MALFORMED_TRACK");
    // 2. 映像が復号されている
    expect(
      decoded.framesDecoded,
      `映像のフレームが復号されていない (${summarizeSubscriber(decoded)})`,
    ).toBeGreaterThan(0);
    // 3. 復号が止まっていない (途中で Malformed になって止まる回帰を検出する)
    const beforeGrowth = subscriber.framesDecoded;
    await subscriberPage.waitForTimeout(GROWTH_OBSERVE_MS);
    const afterGrowth = await readSubscriber(subscriberPage);
    console.log(
      `復号の増加: ${beforeGrowth} -> ${afterGrowth.framesDecoded} ` +
        `(${GROWTH_OBSERVE_MS} ms, ${summarizeSubscriber(afterGrowth)})`,
    );
    expect(
      afterGrowth.statusMessage,
      `観測中に MALFORMED_TRACK で購読が終了した (${summarizeSubscriber(afterGrowth)})`,
    ).not.toContain("MALFORMED_TRACK");
    expect(
      afterGrowth.framesDecoded,
      `映像の復号が続いていない (${summarizeSubscriber(afterGrowth)})`,
    ).toBeGreaterThan(beforeGrowth);
  } finally {
    if (subscriberPage !== undefined) {
      await closeRelayPage(subscriberPage);
    }
    await closeRelayPage(publisherPage);
  }
});
