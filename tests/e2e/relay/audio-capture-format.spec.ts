import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import type { CatalogAudioFormat, PublisherTrackAudioFormat } from "../main";
import {
  RELAY_PAGE_URL,
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレー経由で、高レベル API が音声の取り出し経路から得た形式で符号化することを確かめる。
 *
 * Chromium の `AudioEncoder` は `AudioData` の `sampleRate` / `numberOfChannels` が configure の
 * 値と違うと、リサンプルもチャンネル変換もせずエラーにする ("Input audio buffer is
 * incompatible with codec parameters"。Chromium の実装に依存する挙動であり、将来変わり得る)。
 * `MediaStreamTrackProcessor` を使う経路はマイクの `AudioData` を変換せずに流すため、要求した
 * 値のままエンコーダーを構成すると符号化が止まり、音声の object が 1 件も送られない。偽の
 * マイクはモノラルであり、既定の要求 (2 ch) とも食い違うため、この経路をそのまま再現できる。
 *
 * Catalog の `samplerate` / `channelConfig` が実際に流れる形式と一致することも確かめる。
 * 購読側が受信した Catalog の宣言と、配信側が観測した配信に使ったトラックが報告した形式
 * (`PublisherStatus.trackAudioFormat`。MediaStreamTrackProcessor 経路はこれを実際に
 * 流れる形式として読む) を突き合わせる。
 *
 * draft-ietf-moq-msf-01 §5.2.28 (samplerate) / §5.2.29 (channelConfig)。草案の改訂で節番号と
 * 規定が変わる可能性がある
 */
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
  permissions: ["microphone"],
});

/** 配信と購読から観測した、宣言と実際の形式 */
interface AudioCaptureObservation {
  /** 購読側が受信した Catalog が宣言した音声トラックの形式 */
  catalogAudioFormat: CatalogAudioFormat;
  /** 配信に使ったトラックが報告した形式 */
  capture: PublisherTrackAudioFormat;
}

/**
 * 指定した要求で配信し、購読側で Catalog の宣言と音声の受信を確かめる
 *
 * 音声の object が 1 件も送られない (要求値のまま符号化してエラーになる) 場合は polling の
 * 待ちで時間切れになる。宣言の形式と、配信に使ったトラックの形式を返す。
 */
async function publishAndReadCatalogAudioFormat(
  browser: Browser,
  publisherPage: Page,
  moqtUri: string,
  audioOptions: { sampleRate?: number; channels?: number },
): Promise<AudioCaptureObservation> {
  const namespace = createTestNamespace();
  const subscriberPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let subscriberId: string | undefined;
  try {
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      {
        url: moqtUri,
        namespace,
        audio: { codec: "opus" as const, bitrate: 64_000, ...audioOptions },
      },
    );
    const activePublisherId = publisherId;

    // 音声の object が送られるまで待つ。要求値のまま符号化していると、エンコーダーが
    // エラーになって 0 のまま時間切れになる
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).audio?.framesSent ?? 0,
            activePublisherId,
          ),
        {
          message: "Publisher が音声オブジェクトを送信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    // エンコーダーのエラー (Input audio buffer is incompatible with codec parameters) が
    // 出ていないこと
    expect(publisherStatus.errors).toEqual([]);
    expect(publisherStatus.state).toBe("publishing");
    const capture = publisherStatus.trackAudioFormat;
    if (capture === null) {
      throw new Error("publisher did not report the audio capture format");
    }

    // 購読側は Catalog で音声トラックを知り、同じ namespace を購読する
    subscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace, audio: true },
    );
    const activeSubscriberId = subscriberId;

    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).catalogAudioFormat !== null,
            activeSubscriberId,
          ),
        {
          message: "Subscriber が Catalog の音声トラックを受け取るのを待つ",
          timeout: 30_000,
        },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          subscriberPage.evaluate(
            (id) => window.__moqtE2E.getSubscriber(id).audio?.framesReceived ?? 0,
            activeSubscriberId,
          ),
        {
          message: "Subscriber が音声オブジェクトを受信し始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    const subscriberStatus = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(subscriberStatus.errors).toEqual([]);
    const catalogAudioFormat = subscriberStatus.catalogAudioFormat;
    if (catalogAudioFormat === null) {
      throw new Error("subscriber did not receive an audio track in the catalog");
    }
    return { catalogAudioFormat, capture };
  } finally {
    if (subscriberId !== undefined) {
      await subscriberPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(subscriberPage);
  }
}

test("音声の形式を省略しても偽のマイクの形式で符号化し、Catalog に同じ形式を載せる", async ({
  browser,
  page: publisherPage,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  await publisherPage.goto(RELAY_PAGE_URL);
  await publisherPage.waitForFunction(() => Boolean(window.__moqtE2E));

  const { catalogAudioFormat, capture } = await publishAndReadCatalogAudioFormat(
    browser,
    publisherPage,
    moqtUri,
    {},
  );

  // 既定の要求 (2 ch) と食い違う形式でなければ、このテストは回帰を検出できない
  expect(
    capture.channelCount,
    "偽のマイクがモノラルでないため、既定の要求 (2 ch) との食い違いを再現できない",
  ).toBe(1);
  // 報告が無い項目はライブラリが要求値で埋めるため、宣言との比較が成立しない
  expect(capture.sampleRate, "偽のマイクがサンプルレートを報告しない").not.toBeNull();
  // Catalog の宣言は、配信に使ったトラックが報告した形式と一致する
  expect(catalogAudioFormat.samplerate).toBe(capture.sampleRate);
  expect(catalogAudioFormat.channelConfig).toBe(String(capture.channelCount));
});

test("指定した形式がマイクの形式と違っても、取り出した形式で符号化し、Catalog に同じ形式を載せる", async ({
  browser,
  page: publisherPage,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  await publisherPage.goto(RELAY_PAGE_URL);
  await publisherPage.waitForFunction(() => Boolean(window.__moqtE2E));

  // マイクと違う形式を要求する。要求は取り出し経路への要求であり、指定した値そのもので
  // configure してはならない (MediaStreamTrackProcessor 経路は変換しない)
  const { catalogAudioFormat, capture } = await publishAndReadCatalogAudioFormat(
    browser,
    publisherPage,
    moqtUri,
    { sampleRate: 16_000, channels: 2 },
  );

  // 要求と実際の形式が違うことを確かめる (どちらも同じなら、このテストは指定値の
  // 扱いを検証できない)。報告が無ければライブラリは要求値 (16000 / 2 ch) を使うため、
  // この比較も成立しない
  expect(capture.sampleRate, "偽のマイクがサンプルレートを報告しない").not.toBeNull();
  expect(
    capture.sampleRate,
    "偽のマイクのサンプルレートが要求値と同じため、指定値の扱いを検証できない",
  ).not.toBe(16_000);
  // 1 本目と同じく、偽のマイクがモノラルでなければ前提が崩れる
  expect(
    capture.channelCount,
    "偽のマイクがモノラルでないため、要求した 2 ch との食い違いを再現できない",
  ).toBe(1);
  expect(catalogAudioFormat.samplerate).toBe(capture.sampleRate);
  expect(catalogAudioFormat.channelConfig).toBe(String(capture.channelCount));
});
