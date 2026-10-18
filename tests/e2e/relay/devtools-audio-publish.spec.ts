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
import { DEVTOOLS_URL } from "../urls";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/** moqt-devtools (publisher 側) の URL */

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

/** AAC の実符号化確認の結果 (devtools の publisher が使う判定と同じ形) */
interface AacEncoderProbe {
  supported: boolean;
  reason?: string;
}

/**
 * このブラウザが AAC を実際に符号化できるかを、devtools と同じ判定で確かめる
 *
 * AAC の符号化はプラットフォームのエンコーダーに依存する。macOS は AudioToolbox、
 * Windows は Media Foundation を使うが、Linux の Chrome には AAC エンコーダーが無い。
 * CI の runner は Linux のため、AAC の実リレー配信を確かめる前に、実行環境で符号化
 * できるかを判定する。判定規則を二重に持たないよう、devtools が読み込んだ
 * src/codec/configSupport.ts の実体を performance の取得結果から探して import する
 */
async function probeAacEncoding(page: Page): Promise<AacEncoderProbe> {
  return page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/src/codec/configSupport.ts"));
    if (moduleUrl === undefined) {
      throw new Error("configSupport.ts is not loaded by the devtools page");
    }
    const module = (await import(moduleUrl)) as {
      probeAudioEncoderConfig: (config: {
        codec: string;
        sampleRate: number;
        numberOfChannels: number;
        bitrate: number;
      }) => Promise<AacEncoderProbe>;
    };
    return module.probeAudioEncoderConfig({
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: 96_000,
    });
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

test("moqt-devtools のダミー音声を AAC で符号化して実リレー経由で届く", async ({ browser }) => {
  // AAC の経路は Opus と符号化の入口が違い (Audio Config を AUDIO_CONFIG として送る)、
  // ビットレートの下限もブラウザの実装で決まる。実際に配信と購読を通して確かめる
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const requestedNamespace = createTestNamespace();
  const publisherPage = await browser.newPage();
  const params = new URLSearchParams({
    url: moqtUri,
    namespace: formatTrackNamespace(requestedNamespace),
    mode: "publisher",
    videoSource: "none",
    audioSource: "dummy",
    audioCodec: "aac",
    // Chrome 155 の AAC エンコーダーは 48 kHz ステレオで 64000 bps を符号化できない
    // (isConfigSupported は true を返すが実際の符号化は EncodingError。実測)。
    // 96000 bps なら Chrome 155 と Playwright の Chromium のどちらでも成功する
    audioBitrate: "96000",
    audioSampleRate: "48000",
    audioChannels: "2",
  });

  let subscriberId: string | undefined;
  let receivingPage: Page | null = null;
  try {
    await publisherPage.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await expect(publisherPage.getByTestId("moqt-uri")).toHaveValue(moqtUri);
    // AAC を符号化できない環境 (CI の Linux など) では、この経路を確かめずに skip する。
    // 配信を始めてからでは、失敗した理由が対象の不具合か環境の制約かを切り分けられない
    const aacEncoding = await probeAacEncoding(publisherPage);
    if (!aacEncoding.supported) {
      const reason = aacEncoding.reason === undefined ? "" : `: ${aacEncoding.reason}`;
      test.skip(
        true,
        `このブラウザは AAC を符号化できないため、AAC の実リレー配信を確かめない${reason}`,
      );
      return;
    }
    await expect(publisherPage.getByTestId("audio-track-advertised")).toHaveText("Yes");
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
          message: "AAC で符号化したダミー音声の Object が送られ始めるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);

    const publisherStats = await readPublisherStats(publisherPage);
    expect(publisherStats.status).toBe("connected");
    expect(publisherStats.audio.encodeErrors).toBe(0);
    expect(publisherStats.audio.chunksEncoded).toBeGreaterThan(0);

    receivingPage = await openRelayPage(browser);
    subscriberId = await receivingPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      {
        url: moqtUri,
        namespace: effectiveNamespace,
        audio: true,
        audioCodec: "aac" as const,
        video: false,
      },
    );
    const activeSubscriberId = subscriberId;

    // 受信だけでなく、復号して鳴らし始めたところまで待つ (AAC の Audio Config を
    // 適用できていないと、Object は届いても復号が進まず、鳴った長さが 0 のままになる)
    await expect
      .poll(
        () =>
          receivingPage?.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).audio?.playedMs ?? 0,
            activeSubscriberId,
          ),
        {
          message: "購読者が AAC の音声を復号して鳴らし始めるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);

    const subscriberStatus = await receivingPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(subscriberStatus.errors).toEqual([]);
    expect(subscriberStatus.state).toBe("active");
    expect(subscriberStatus.hasCatalog).toBe(true);
    expect(subscriberStatus.audio?.framesReceived ?? 0).toBeGreaterThan(0);
    expect(subscriberStatus.audio?.playedMs ?? 0).toBeGreaterThan(0);
    expect(subscriberStatus.catalogAudioFormat?.samplerate).toBe(48_000);
    expect(subscriberStatus.catalogAudioFormat?.channelConfig).toBe("2");

    console.log(
      "AAC の配信結果:",
      `objectsSent=${publisherStats.audio.objectsSent}`,
      `chunksEncoded=${publisherStats.audio.chunksEncoded}`,
      `framesReceived=${subscriberStatus.audio?.framesReceived ?? 0}`,
    );
  } finally {
    if (receivingPage !== null && subscriberId !== undefined) {
      await receivingPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (receivingPage !== null) {
      await closeRelayPage(receivingPage);
    }
    await closeRelayPage(publisherPage);
  }
});

test("moqt-devtools は AAC で符号化できない形式のとき、配信開始前に理由付きで失敗する", async ({
  browser,
}) => {
  // Chromium の AAC エンコーダーは 44100 / 48000 Hz だけに対応する (実測。
  // isConfigSupported は 16000 Hz を非対応と報告する)。対応の申告だけで配信を
  // 始めると、音声 Object が 1 つも送られないまま catalog だけが音声トラックを
  // 広告するため、配信開始前に失敗することを固定する
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = createTestNamespace();
  const publisherPage = await browser.newPage();
  const params = new URLSearchParams({
    url: moqtUri,
    namespace: formatTrackNamespace(namespace),
    mode: "publisher",
    videoSource: "none",
    audioSource: "dummy",
    audioCodec: "aac",
    audioBitrate: "96000",
    audioSampleRate: "16000",
    audioChannels: "2",
  });

  try {
    await publisherPage.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await publisherPage.getByTestId("publisher-publish-button").click();

    await expect
      .poll(
        async () => {
          const stats = await readPublisherStats(publisherPage);
          return stats.status;
        },
        {
          message: "AAC の符号化できない設定で配信開始がエラーになるのを待つ",
          timeout: WAIT_TIMEOUT_MS,
        },
      )
      .toBe("error");

    const stats = await readPublisherStats(publisherPage);
    // どの設定が符号化できなかったかと、ブラウザが返した理由が読めること
    expect(stats.statusMessage).toContain(
      "Failed: audio encoder cannot encode the selected settings",
    );
    expect(stats.statusMessage).toContain("codec=aac");
    expect(stats.statusMessage).toContain("codecString=mp4a.40.2");
    expect(stats.statusMessage).toContain("sampleRate=16000");
    expect(stats.statusMessage).toContain("bitrate=96000");
    // 音声 Object は 1 つも送られない (catalog も送らないため、購読側を待たせない)
    expect(stats.audio.objectsSent).toBe(0);
    expect(stats.audio.encodeErrors).toBe(0);
  } finally {
    await closeRelayPage(publisherPage);
  }
});
