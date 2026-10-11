import { expect, test, type Browser, type Page } from "@playwright/test";
import type { PublisherStatus, SubscriberStatus } from "../main";
import {
  RELAY_TEST_TIMEOUT_MS,
  closeRelayPage,
  createTestNamespace,
  openRelayPage,
  requireRelayUri,
} from "./support";

/**
 * 実リレー経由で音声を Subgroup (Data Stream) と Datagram の両方で往復し、
 * 「途切れの少なさ」を数値で読めることを確かめる。
 *
 * draft-ietf-moq-transport-22 §11 (Data Streams and Datagrams) / §11.2 (Datagrams)
 *
 * 音声 Object の配送経路は Subgroup と Datagram の 2 つがあり、再送の有無が途切れに
 * 与える影響が異なる。同じ spec の中で両方の往復を行い、経路別の受信数・欠落率・補間率・
 * 捨て率を比べられるようにする (§11.2 はサイズ超過時の暗黙のドロップを許すため、Datagram の
 * 往復に「受信数 = 送信数」は要求しない)。
 *
 * 判定はライブラリの高レベル API (`createMediaPublisher` / `createMediaSubscriber`) の
 * 統計で行う。devtools の配線ではなくライブラリの経路そのものを見る。
 *
 * 音声のソースは偽のマイク (Chromium の fake device) である。CI の runner は音声の入力
 * デバイスを持たないため `--use-fake-device-for-media-stream` を付けて動かし、音声の再生が
 * ユーザー操作を待たずに始まるよう autoplay の制限も外す (テストページに操作できる UI が
 * 無く、再生が始まらないと補間率と捨て率の分母が 0 になる)。
 */
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
  permissions: ["microphone"],
});

/** 音声 Object の送り方 */
type Delivery = "subgroup" | "datagram";

/** 往復の観測を続ける秒数 */
const OBSERVE_SECONDS = 10;

/** 観測の間隔 (ミリ秒) */
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * Subgroup の往復で許す、まだ届いていない Object の数
 *
 * 送信側は符号化の出力の時点で数え、受信側は到着後に数えるため、観測の終わりに送った分の
 * 一部は次の瞬間に届く。実測では、負荷の低いときは送信 501 件 / 受信 501 件で一致し、
 * 負荷の高いとき (load average 14) は送信 501 件 / 受信 473 件と 28 件遅れた。1 秒分
 * (50 件 = 音声 20 ms × 50) を移動中として許す
 */
const SUBGROUP_IN_FLIGHT_FRAMES_MAX = 50;

/**
 * Datagram の往復で許す欠落率
 *
 * 実測 (手元の実リレー) は 0.024 (負荷時。送信 502 件 / 受信 490 件) である。QUIC 上の
 * WebTransport の datagram は再送されないため (RFC 9221)、経路の損失がそのまま欠落になる
 * (§11.2 はサイズ超過時の暗黙の drop も許す)。ここでは「明らかに途切れている」状態を
 * 捕まえ、runner の一時的な輻輳では落ちない値にする
 */
const DATAGRAM_LOSS_MAX = 0.1;

/**
 * 観測の間に許す補間率 (分母は鳴らすと決めた音の長さ)
 *
 * 実測 (手元の実リレー) は 0.000 である。Datagram の欠落と、遅れて届いた音の捨てが
 * 補間として現れる
 */
const CONCEALMENT_RATIO_MAX = 0.2;

/**
 * 観測の間に許す捨て率 (分母は鳴らすと決めた音の長さ)
 *
 * 実測 (手元の実リレー) は、負荷の低いときは 0.000、負荷の高いとき (load average 14) は
 * 0.057 (鳴らした 9164 ms / 捨て 520 ms) である。ここでは「明らかに途切れている」状態を
 * 捕まえ、runner の一時的な輻輳では落ちない値にする
 */
const DROP_RATIO_MAX = 0.2;

/** 配信側と購読側の観測 (近い時点で読む) */
interface RoundObservation {
  publisher: PublisherStatus;
  subscriber: SubscriberStatus;
}

/** 配信側と購読側の統計を 1 回の往復でまとめて読む */
async function readRound(
  publisherPage: Page,
  publisherId: string,
  subscriberPage: Page,
  subscriberId: string,
): Promise<RoundObservation> {
  const [publisher, subscriber] = await Promise.all([
    publisherPage.evaluate((id) => window.__moqtE2E.getPublisher(id), publisherId),
    subscriberPage.evaluate((id) => window.__moqtE2E.getSubscriber(id), subscriberId),
  ]);
  return { publisher, subscriber };
}

/**
 * 観測の間の増加から、その配送経路の不変条件を判定し、結果をログへ出す
 *
 * 判定は観測の前後の増加で行う。購読より前に送られた Object の分や、復号の準備ができるまで
 * 保留していた分を数えないためである。
 */
function expectDeliveryInvariants(
  delivery: Delivery,
  before: RoundObservation,
  after: RoundObservation,
): void {
  const publisherAudio = after.publisher.audio;
  const subscriberAudio = after.subscriber.audio;
  // 失敗がしきい値の内側に紛れないよう、両側のエラーを先に見る
  expect(after.publisher.errors, `配信側のエラーが無い (${delivery})`).toEqual([]);
  expect(after.subscriber.errors, `購読側のエラーが無い (${delivery})`).toEqual([]);
  const beforePublisherAudio = before.publisher.audio;
  const beforeSubscriberAudio = before.subscriber.audio;
  // 送信側が実際にどちらの経路を使ったかは受信側の経路別の受信数で判定する (配信側の統計は
  // 送り方を公開していないため、指定した値をそのまま突き合わせても意味が無い)
  expect(subscriberAudio, `音声の統計が読める (${delivery})`).not.toBeNull();

  const sentGrowth = (publisherAudio?.framesSent ?? 0) - (beforePublisherAudio?.framesSent ?? 0);
  const receivedGrowth =
    (subscriberAudio?.framesReceived ?? 0) - (beforeSubscriberAudio?.framesReceived ?? 0);
  expect(sentGrowth, `観測の間に音声 Object が送られている (${delivery})`).toBeGreaterThan(0);
  expect(receivedGrowth, `観測の間に音声 Object を受信している (${delivery})`).toBeGreaterThan(0);
  expect(
    subscriberAudio?.framesReceived ?? -1,
    `受信数は経路別の受信数の和である (${delivery})`,
  ).toBe(
    (subscriberAudio?.subgroupFramesReceived ?? 0) + (subscriberAudio?.datagramFramesReceived ?? 0),
  );

  if (delivery === "subgroup") {
    // Subgroup は再送される Data Stream で届くため、観測の間に送られた分は欠落しない。
    // 購読より前に送られた分が relay の cache から届くこともあるため、受信は送信以上になる
    expect(
      subscriberAudio?.datagramFramesReceived ?? 0,
      `Subgroup の往復では Datagram で受信しない (${delivery})`,
    ).toBe(0);
    expect(
      receivedGrowth + SUBGROUP_IN_FLIGHT_FRAMES_MAX,
      `Subgroup の往復で受信数が送信数を下回らない (送信 ${sentGrowth} 件 / 受信 ${receivedGrowth} 件)`,
    ).toBeGreaterThanOrEqual(sentGrowth);
  } else {
    // Datagram は再送されない。届いた分だけを数え、欠落率を数値で読めることを確かめる
    expect(
      subscriberAudio?.subgroupFramesReceived ?? 0,
      `Datagram の往復では Subgroup で受信しない (${delivery})`,
    ).toBe(0);
    const lossRatio = 1 - receivedGrowth / sentGrowth;
    expect(
      lossRatio,
      `Datagram の欠落率がしきい値未満 (送信 ${sentGrowth} 件 / 受信 ${receivedGrowth} 件 / 欠落率 ${lossRatio.toFixed(3)})`,
    ).toBeLessThanOrEqual(DATAGRAM_LOSS_MAX);
  }

  // 途切れの指標 (補間率と捨て率) は、鳴らすと決めた音の長さを分母にする
  const playedGrowthMs = (subscriberAudio?.playedMs ?? 0) - (beforeSubscriberAudio?.playedMs ?? 0);
  const concealedGrowthMs =
    (subscriberAudio?.concealedMs ?? 0) - (beforeSubscriberAudio?.concealedMs ?? 0);
  const droppedGrowthMs =
    (subscriberAudio?.droppedMs ?? 0) - (beforeSubscriberAudio?.droppedMs ?? 0);
  expect(playedGrowthMs, `鳴らすと決めた音の長さが増える (${delivery})`).toBeGreaterThan(0);
  expect(
    concealedGrowthMs / playedGrowthMs,
    `補間率がしきい値未満 (鳴らした ${playedGrowthMs.toFixed(1)} ms / 補間 ${concealedGrowthMs.toFixed(1)} ms)`,
  ).toBeLessThanOrEqual(CONCEALMENT_RATIO_MAX);
  expect(
    droppedGrowthMs / playedGrowthMs,
    `捨て率がしきい値未満 (鳴らした ${playedGrowthMs.toFixed(1)} ms / 捨て ${droppedGrowthMs.toFixed(1)} ms)`,
  ).toBeLessThanOrEqual(DROP_RATIO_MAX);

  // 途切れの指標を CI のログからも読めるようにする
  console.log(
    `実リレーの音声の配送 (${delivery}): 送信 ${sentGrowth} 件 / 受信 ${receivedGrowth} 件 (Subgroup ${subscriberAudio?.subgroupFramesReceived ?? 0} / Datagram ${subscriberAudio?.datagramFramesReceived ?? 0})、再生 ${playedGrowthMs.toFixed(1)} ms、補間 ${concealedGrowthMs.toFixed(1)} ms、捨て ${droppedGrowthMs.toFixed(1)} ms、鳴らさなかった音 ${subscriberAudio?.missedFrames ?? 0} 件`,
  );
}

/** 1 つの配送経路で配信と購読を確立し、観測して判定し、後始末する */
async function runDeliveryRound(
  browser: Browser,
  moqtUri: string,
  delivery: Delivery,
): Promise<void> {
  const namespace = createTestNamespace();
  const publisherPage = await openRelayPage(browser);
  const subscriberPage = await openRelayPage(browser);
  let publisherId: string | undefined;
  let subscriberId: string | undefined;

  try {
    publisherId = await publisherPage.evaluate(
      (options) => window.__moqtE2E.startPublisher(options),
      {
        url: moqtUri,
        namespace,
        audio: { codec: "opus" as const, bitrate: 64_000, delivery },
      },
    );
    const activePublisherId = publisherId;

    // Publisher が実際に音声 Object を送るまで待つ。固定の sleep で待つと、遅い runner で
    // カタログが届く前に subscribe してしまい flaky になる
    await expect
      .poll(
        () =>
          publisherPage.evaluate(
            (id) => window.__moqtE2E.getPublisher(id).audio?.framesSent ?? 0,
            activePublisherId,
          ),
        {
          message: `Publisher が音声 Object を送信し始めるのを待つ (${delivery})`,
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

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
          message: `Subscriber が音声 Object を受信し始めるのを待つ (${delivery})`,
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    const before = await readRound(
      publisherPage,
      activePublisherId,
      subscriberPage,
      activeSubscriberId,
    );
    for (let second = 0; second < OBSERVE_SECONDS; second++) {
      await subscriberPage.waitForTimeout(SAMPLE_INTERVAL_MS);
    }
    const after = await readRound(
      publisherPage,
      activePublisherId,
      subscriberPage,
      activeSubscriberId,
    );
    expectDeliveryInvariants(delivery, before, after);
  } finally {
    // 後始末は購読 → 配信の順に行う。リレー側から先に切れていることがあるため、
    // 失敗してもテストの結果を変えない
    if (subscriberId !== undefined) {
      await subscriberPage
        .evaluate((id) => window.__moqtE2E.stopSubscriber(id), subscriberId)
        .catch(() => undefined);
    }
    if (publisherId !== undefined) {
      await publisherPage
        .evaluate((id) => window.__moqtE2E.stopPublisher(id), publisherId)
        .catch(() => undefined);
    }
    await closeRelayPage(subscriberPage);
    await closeRelayPage(publisherPage);
  }
}

test("実リレー経由で音声を Subgroup と Datagram の両方で往復し、途切れの指標を経路ごとに読める", async ({
  browser,
}) => {
  // 2 つの経路で、配信と購読の確立・観測 (10 秒)・後始末を繰り返す
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  for (const delivery of ["subgroup", "datagram"] as const) {
    await runDeliveryRound(browser, moqtUri, delivery);
  }
});
