import { expect, test } from "@playwright/test";
import {
  RELAY_PAGE_URL,
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレー経由で、MediaStreamTrackProcessor が無いブラウザでも音声を publish し、
 * 同じ namespace の subscribe で受信できることを確かめる。
 *
 * Safari と Firefox はメインスレッドに MediaStreamTrackProcessor を持たない (Safari は
 * DedicatedWorker にしか公開しておらず、Worker へ MediaStreamTrack も渡せない。Firefox は
 * 未実装)。そのため音声は Web Audio の AudioWorklet で取り出し、AudioData を組み立てる
 * (ライブラリの src/audioSource.ts)。この経路は音声の取り出しから符号化、PUBLISH、購読までを
 * 通すため、実リレー以外では置き換えられない。
 *
 * 条件は Playwright の init script で「そのブラウザに無い API を無い状態にする」ことで作る
 * (実装を差し替えるスタブではない)。CI は chromium だけを入れるため、Safari 実機の代わりに
 * この条件で回す。Safari 実機の WebKit で通ることは tests/e2e/devtools-audio-fallback.spec.ts
 * と同じ条件を Playwright WebKit で走らせて確かめる (開発機での手動確認)。
 *
 * draft-ietf-moq-transport-22 §9.6 (SUBSCRIBE) / draft-ietf-moq-msf-01 Section 5 (Catalog)
 */
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
  permissions: ["microphone"],
});

/** 音声の配信を観測する時間 (ミリ秒) */
const OBSERVE_MS = 5_000;

/**
 * 補間率と捨て率の上限 (分母は鳴らすと決めた音の長さ)
 *
 * 購読側は音声の購読を始めた時点で再生の時計を進めるため、最初の Object が届くまでの分が
 * 補間として現れる (実測: 観測 5 秒で 41 ms = 0.008)。取り出し経路がサンプルを継続的に
 * 取りこぼしていれば、観測時間に対してこの値が増え続ける
 */
const CONCEALMENT_RATIO_MAX = 0.05;
const DROP_RATIO_MAX = 0.05;

test("MediaStreamTrackProcessor が無いブラウザでも実リレー経由で音声を publish し subscribe で受信できる", async ({
  browser,
  page: publisherPage,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = createTestNamespace();

  // 配信側だけを MediaStreamTrackProcessor の無いブラウザと同じ条件にする
  await publisherPage.addInitScript(() => {
    Object.defineProperty(window, "MediaStreamTrackProcessor", {
      value: undefined,
      configurable: true,
    });
  });
  await publisherPage.goto(RELAY_PAGE_URL);
  await publisherPage.waitForFunction(() => Boolean(window.__moqtE2E));

  const subscriberPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let subscriberId: string | undefined;

  try {
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      { url: moqtUri, namespace, audio: { codec: "opus" as const, bitrate: 64_000 } },
    );
    const activePublisherId = publisherId;

    // 音声オブジェクトが実際に送られるまで待つ。MediaStreamTrackProcessor が無い状態で
    // 音声を諦めていると、ここが 0 のまま時間切れになる
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

    // 購読側はカタログで音声トラックを知り、同じ namespace を購読する
    subscriberId = await subscriberPage.evaluate(
      (options) => window.__moqtE2E.startSubscriber(options),
      { url: moqtUri, namespace, audio: true },
    );
    const activeSubscriberId = subscriberId;

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

    // 途切れずに届き続けることを見る (受信数だけでは、1 個届いて止まっていても通る)
    await new Promise((resolve) => {
      setTimeout(resolve, OBSERVE_MS);
    });

    const subscriberStatus = await subscriberPage.evaluate(
      (id) => window.__moqtE2E.getSubscriber(id),
      activeSubscriberId,
    );
    expect(subscriberStatus.errors).toEqual([]);
    expect(subscriberStatus.state).toBe("active");
    expect(subscriberStatus.hasCatalog).toBe(true);
    expect(subscriberStatus.audio?.framesReceived ?? 0).toBeGreaterThan(0);
    // 鳴らすと決めた音の長さを分母に、補間と捨ての割合が小さいこと。取り出し経路が
    // サンプルを取りこぼしていれば、この割合が観測時間とともに増える
    const playedMs = subscriberStatus.audio?.playedMs ?? 0;
    expect(playedMs).toBeGreaterThan(0);
    expect((subscriberStatus.audio?.concealedMs ?? 0) / playedMs).toBeLessThan(
      CONCEALMENT_RATIO_MAX,
    );
    expect((subscriberStatus.audio?.droppedMs ?? 0) / playedMs).toBeLessThan(DROP_RATIO_MAX);

    const publisherStatus = await publisherPage.evaluate(
      (id) => window.__moqtE2E.getPublisher(id),
      activePublisherId,
    );
    expect(publisherStatus.errors).toEqual([]);
    expect(publisherStatus.state).toBe("publishing");
    expect(publisherStatus.audio?.framesSent ?? 0).toBeGreaterThan(0);
  } finally {
    if (subscriberId !== undefined) {
      await subscriberPage.evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId);
    }
    if (publisherId !== undefined) {
      await publisherPage.evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId);
    }
    await closeRelayPage(subscriberPage);
  }
});
