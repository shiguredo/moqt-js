/**
 * moqt-devtools の配信経路で、MediaStreamTrackProcessor が無いブラウザでも音声が届くことを
 * 実リレーで確かめる
 *
 * Safari は MediaStreamTrackProcessor をメインスレッドに公開しておらず (WebKit の IDL は
 * Exposed=DedicatedWorker)、Worker へ MediaStreamTrack も渡せない。Firefox は実装していない。
 * そのため devtools は音声を Web Audio の AudioWorklet で取り出す (ライブラリの
 * src/audioSource.ts)。この経路は devtools の Publisher からリレー、購読者までを通すため、
 * 実リレー以外では置き換えられない。以前は MediaStreamTrackProcessor が無いだけで音声トラックを
 * catalog に載せず、購読者には音声が届かなかった。
 *
 * 条件は Playwright の init script で「そのブラウザに無い API を無い状態にする」ことで作る
 * (実装を差し替えるスタブではない)。接続先は他の relay の spec と同じく `TEST_MOQT_URI` で
 * 渡し、未設定の環境では skip する。
 *
 * draft-ietf-moq-msf-01 Section 5 (Catalog) / draft-ietf-moq-loc-04 §4.1 (Application with one
 * audio track)
 */

import { expect, test, type Page } from "@playwright/test";
import { formatTrackNamespace, parseTrackNamespace } from "../../../src/fullTrackName";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/** moqt-devtools (publisher 側) の URL */
const DEVTOOLS_URL = "http://localhost:5173/index.html";

/** 配信の開始と購読の確立を待つ上限 (ミリ秒) */
const WAIT_TIMEOUT_MS = 30_000;

/** テスト全体の上限 (配信の開始、購読、受信の待ちの合計に余裕を取る) */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** devtools の publisher の統計 (window.moqtDevTools.getPublisher()) の必要な部分 */
interface DevtoolsPublisherStats {
  status: string;
  statusMessage: string;
  audio: {
    publishing: boolean;
    chunksEncoded: number;
    encodeErrors: number;
    objectsSent: number;
  };
}

/** devtools の publisher の統計を読む */
async function readPublisherStats(page: Page): Promise<DevtoolsPublisherStats> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: { getPublisher(): DevtoolsPublisherStats };
      }
    ).moqtDevTools;
    return api.getPublisher();
  });
}

test("MediaStreamTrackProcessor が無いブラウザでも moqt-devtools のダミー音声が実リレー経由で届く", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const requestedNamespace = createTestNamespace();
  const publisherPage = await browser.newPage();
  // 配信側を Safari / Firefox と同じ条件にする (メインスレッドに
  // MediaStreamTrackProcessor が無い状態にする)
  await publisherPage.addInitScript(() => {
    Object.defineProperty(window, "MediaStreamTrackProcessor", {
      value: undefined,
      configurable: true,
    });
  });

  const params = new URLSearchParams({
    url: moqtUri,
    namespace: formatTrackNamespace(requestedNamespace),
    mode: "publisher",
    // 映像を送らず音声だけを配信する (この経路だけを見る)
    videoSource: "none",
    audioSource: "dummy",
    audioCodec: "opus",
    audioBitrate: "64000",
    audioSampleRate: "48000",
    audioChannels: "2",
  });

  let subscriberId: string | undefined;
  let subscriberPage: Page | null = null;
  try {
    await publisherPage.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(publisherPage.getByTestId("moqt-uri")).toHaveValue(moqtUri);
    await expect(publisherPage.getByTestId("namespace-warning")).toHaveCount(0);
    // 音声トラックを catalog に載せる予定であること。ここが No になると購読者に音声が届かない
    await expect(publisherPage.getByTestId("audio-track-advertised")).toHaveText("Yes");
    // TEST_MOQT_URI の msf fragment が namespace を上書きする場合があるため、欄の実効値を使う
    const effectiveNamespace = parseTrackNamespace(
      await publisherPage.getByTestId("namespace").inputValue(),
    );

    await publisherPage.getByTestId("publisher-publish-button").click();
    await expect
      .poll(
        async () => {
          const stats = await readPublisherStats(publisherPage);
          return stats.audio.objectsSent;
        },
        {
          message: "moqt-devtools の publisher がダミー音声の Object を送り始めるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);

    // 購読者は別のページで同じ namespace を購読する。配信側は映像を送っていないため、
    // 映像の購読は要求しない (catalog に無いトラックを購読すると失敗する)
    subscriberPage = await openRelayPage(browser);
    const receivingPage = subscriberPage;
    subscriberId = await receivingPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace: effectiveNamespace, audio: true, video: false },
    );
    const activeSubscriberId = subscriberId;

    await expect
      .poll(
        () =>
          receivingPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).audio?.framesReceived ?? 0,
            activeSubscriberId,
          ),
        {
          message: "購読者が音声の Object を受信し始めるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
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
    expect(subscriberStatus.audio?.framesReceived ?? 0).toBeGreaterThan(0);

    // 配信側の符号化が失敗していないこと (取り出し経路がサンプルを渡せていないと、ここに
    // エラーが溜まる)
    const publisherStats = await readPublisherStats(publisherPage);
    expect(publisherStats.audio.encodeErrors).toBe(0);
    expect(publisherStats.audio.chunksEncoded).toBeGreaterThan(0);
    expect(publisherStats.audio.objectsSent).toBeGreaterThan(0);
    expect(publisherStats.status).toBe("connected");

    // 観測した値をログに残す (WebKit と Chromium で同じ数字が並ぶことを目で確かめられるように)
    console.log(
      "ダミー音声の配信結果:",
      `objectsSent=${publisherStats.audio.objectsSent}`,
      `chunksEncoded=${publisherStats.audio.chunksEncoded}`,
      `framesReceived=${subscriberStatus.audio?.framesReceived ?? 0}`,
    );
  } finally {
    if (subscriberPage !== null && subscriberId !== undefined) {
      await subscriberPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (subscriberPage !== null) {
      await closeRelayPage(subscriberPage);
    }
    await closeRelayPage(publisherPage);
  }
});
