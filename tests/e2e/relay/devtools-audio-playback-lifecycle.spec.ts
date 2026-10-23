import { expect, test, type Page } from "@playwright/test";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL } from "../urls";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";

// 音声の再生の開始を page.evaluate の中で連続して押すため、ユーザー操作を待たずに
// AudioContext を再開できるようにする (実ブラウザのフラグであり、mock ではない)
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// moqt-devtools の subscriber で、音声の再生の停止・再開と購読のやり直しを実リレーで確かめる。
//
// 1 つ目は、購読の停止で音声を鳴らし切る (drain、上限 300 ms) 直後に購読をやり直しても、
// 古い停止の後始末が新しい購読の再生を壊さないことを見る。2 つ目は、音声の再生を始めた
// 直後に止めたときに、再生の状態と画面のエラーが壊れないことを見る (切り替えの await の
// 競合の回帰)。
//
// 配信は devtools の dummy の音声と映像を使う (マイクとカメラを要求しない)。
// 実リレーは TEST_MOQT_URI が設定された環境でだけ動く。

/** テスト全体の上限 (接続・配信・購読の確立までを 1 本のテストで待つ) */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 2;

/** 音声の Object が届いて鳴り始めるまでに待つ上限 (ミリ秒) */
const AUDIO_ARRIVAL_TIMEOUT_MS = 30_000;

/** 購読が確立するまでに待つ上限 (ミリ秒) */
const SUBSCRIBE_TIMEOUT_MS = 30_000;

/** devtools の subscriber の統計 (必要な部分) */
interface DevtoolsSubscriberStats {
  id: string;
  status: string;
  statusMessage: string;
  warnings: readonly unknown[];
  audio: {
    objectsReceived: number;
    chunksDecoded: number;
    playbackEnabled: boolean;
    peakDbfs: number | null;
    rmsDbfs: number | null;
    playoutTiming: {
      playedFrames: number;
      playedMs: number;
    };
  };
}

/** devtools の publisher の統計 (必要な部分) */
interface DevtoolsPublisherStats {
  status: string;
  audio: {
    objectsSent: number;
    chunksEncoded: number;
  };
}

/** 統計を読む */
async function readSubscriber(page: Page): Promise<DevtoolsSubscriberStats> {
  return page.evaluate(() => {
    const api = (
      window as unknown as { moqtDevTools: { getSubscribers(): DevtoolsSubscriberStats[] } }
    ).moqtDevTools;
    const subscriber = api.getSubscribers()[0];
    if (subscriber === undefined) {
      throw new Error("the subscriber has not been created yet");
    }
    return subscriber;
  });
}

/** 統計を読む */
async function readPublisher(page: Page): Promise<DevtoolsPublisherStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getPublisher(): DevtoolsPublisherStats } })
      .moqtDevTools;
    return api.getPublisher();
  });
}

/** 判定に使う値を 1 行にする (失敗メッセージとログに残す) */
function summarizeSubscriber(stats: DevtoolsSubscriberStats): string {
  const { audio } = stats;
  return [
    `status=${stats.status}`,
    `objects=${audio.objectsReceived}`,
    `decoded=${audio.chunksDecoded}`,
    `playbackEnabled=${audio.playbackEnabled}`,
    `playedFrames=${audio.playoutTiming.playedFrames}`,
    `playedMs=${audio.playoutTiming.playedMs.toFixed(0)}`,
    `peakDbfs=${audio.peakDbfs === null ? "-" : audio.peakDbfs.toFixed(1)}`,
    `warnings=${stats.warnings.length}`,
  ].join(", ");
}

/** 購読が確立するのを待つ */
async function waitForSubscriberConnected(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.status;
      },
      { message: "購読が確立するのを待つ", timeout: SUBSCRIBE_TIMEOUT_MS },
    )
    .toBe("connected");
}

/**
 * 配信と購読を始める (both モードのページを開き、Publish と Subscribe を押す)
 *
 * 音声の再生はまだ有効にしない (呼び出し側が状態を確かめてから押す)。
 */
async function startBoth(page: Page, moqtUri: string, namespace: string): Promise<void> {
  const params = new URLSearchParams({
    url: moqtUri,
    // devtools の namespace 欄は draft-ietf-moq-transport-22 §8.8 の表現 (フィールドを "-" で
    // 並べる) を読む。配列をそのまま渡すと "," が混ざって弾かれる
    namespace,
    mode: "both",
    // headless Chromium で符号化できるコーデックにする (既定は vp9)
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
  });
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);

  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const stats = await readPublisher(page);
        return stats.audio.objectsSent;
      },
      {
        message: "配信側が音声の Object を送り始めるのを待つ",
        timeout: SUBSCRIBE_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);

  await page.getByTestId("subscriber-subscribe-button").click();
}

/** 受信した音声の再生を有効にする (既に有効なら押さない) */
async function ensureAudioPlaybackEnabled(page: Page): Promise<void> {
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/** 再生を有効にし、音が鳴り始めるまで待つ */
async function playAndWaitForAudio(page: Page, message: string): Promise<void> {
  await ensureAudioPlaybackEnabled(page);
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        // 開始の反映を待つ間に鳴らした数が 0 のまま判定しないよう、有効なときだけ数える
        return stats.audio.playbackEnabled ? stats.audio.playoutTiming.playedFrames : 0;
      },
      { message, timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBeGreaterThan(0);
}

/** 再生で鳴らしたフレーム数が `minimum` を超えるのを待つ */
async function waitForPlayedFrames(page: Page, minimum: number, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playoutTiming.playedFrames;
      },
      { message, timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBeGreaterThan(minimum);
}

/** 音声の Object が届いて復号され始めるのを待つ */
async function waitForAudioDecoded(page: Page, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.chunksDecoded;
      },
      { message, timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBeGreaterThan(0);
}

/**
 * 購読をやり直し、購読が確立するまで待つ
 *
 * Stop の後始末が終わるまで Subscribe ボタンは無効であるため、押せるようになってから押す。
 */
async function resubscribe(page: Page): Promise<void> {
  await page.getByTestId("subscriber-subscribe-button").click();
  await waitForSubscriberConnected(page);
}

/** 停止の後始末が終わるまで待つ (Subscribe ボタンは停止中は無効) */
async function waitForStopFinished(page: Page): Promise<void> {
  await expect(page.getByTestId("subscriber-subscribe-button")).toBeEnabled();
}

/**
 * Play Audio と Stop を同じタスクで押す
 *
 * Play Audio の処理は非同期 (AudioContext の作成と resume、`<audio>` の play) なので、
 * その await の間に購読の停止 (drain と AudioContext の close) が入り得る。2 つのクリックを
 * 同じタスクで行い、その競合を作る。
 */
async function pressPlayThenStop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const playbackToggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="subscriber-audio-playback-toggle"]',
    );
    const stopButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="subscriber-stop-button"]',
    );
    if (playbackToggle === null || stopButton === null) {
      throw new Error("failed to find the playback toggle or the stop button");
    }
    playbackToggle.click();
    stopButton.click();
  });
}

/**
 * 実リレーへの配信と購読を始める
 *
 * TEST_MOQT_URI が無い環境では null を返す (呼び出し側はテストを打ち切る)。
 */
async function startRelayPair(page: Page): Promise<string[] | null> {
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return null;
  }
  const consoleErrors = collectConsoleErrors(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForSubscriberConnected(page);
  return consoleErrors;
}

/** アプリの console error が 1 件も無いことを確かめる (`context` は失敗メッセージに使う) */
function expectNoApplicationConsoleErrors(consoleErrors: readonly string[], context: string): void {
  expect(consoleErrors, `${context}に console error が出た: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );
}

/**
 * 経路 (リソースの取得、WebTransport / QUIC) の console error か
 *
 * 判定から除くのは既知の接頭辞のものだけにする。大文字小文字を無視して `QUIC` や
 * `net::` / `ERR_` のような広い語で除くと、アプリのエラーまで落とす。
 */
function isNetworkConsoleError(text: string): boolean {
  return (
    text.includes("Failed to load resource: net::") ||
    text.startsWith("net::ERR_") ||
    text.includes("WebTransportError") ||
    text.includes("WebTransport connection")
  );
}

/**
 * console error と捕捉されなかった例外の記録を作る
 *
 * 判定にはアプリのエラーだけを使う。経路のエラーはログへ残す。
 */
function collectConsoleErrors(page: Page): string[] {
  const applicationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (isNetworkConsoleError(text)) {
      console.log(`経路の console error は判定から除く: ${text}`);
      return;
    }
    applicationErrors.push(text);
  });
  page.on("pageerror", (error) => {
    applicationErrors.push(String(error));
  });
  return applicationErrors;
}

// このテストは、購読の停止 (drain と AudioContext の close) が終わってから購読をやり直す。
// Stop の後始末が終わるまで Subscribe は無効であり、操作は直列化される。停止の drain の
// 途中に再購読が入る競合は、devtools 側の単体 seam (audioPlaybackLifecycle) が担保する。
test("購読の停止後に購読をやり直しても、音声の再生を続けられる (直列化された再購読)", async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const consoleErrors = await startRelayPair(page);
  if (consoleErrors === null) {
    return;
  }

  await ensureAudioPlaybackEnabled(page);
  // 再生が定常になってから停止する
  await waitForPlayedFrames(page, 50, "停止の前に音を鳴らし始めるのを待つ");
  const beforeStop = await readSubscriber(page);
  console.log(`停止の前: ${summarizeSubscriber(beforeStop)}`);

  // 停止する。音声は予約済みの分を鳴らし切ってから止まる (drain、上限は 300 ms)。
  // Stop の直後に Subscribe を押す。Subscribe は停止の後始末が終わるまで無効なので、
  // 押せるようになった時点で押す = drain が終わった後の再購読になる。
  const stopStartedMs = Date.now();
  await page.getByTestId("subscriber-stop-button").click();
  await resubscribe(page);
  console.log(`停止から再購読までの時間: ${Date.now() - stopStartedMs} ms`);

  // 再購読が確立し、音声の Object が届いて復号されることを待つ
  await waitForAudioDecoded(page, "再購読の後も音声の Object が復号されるのを待つ");
  // 再購読の後に音声が届き、再生が無効のままであることを条件で待つ (反映の周期を
  // 固定の時間で待たない)
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playbackEnabled ? -1 : stats.audio.chunksDecoded;
      },
      {
        message: "再購読の後も音声が届き、再生が無効のままであることを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);
  const afterSubscribe = await readSubscriber(page);
  console.log(`再購読の直後: ${summarizeSubscriber(afterSubscribe)}`);
  // 再購読した時点では再生はまだ有効ではない (Stop で止まっている)
  expect(
    afterSubscribe.audio.playbackEnabled,
    `再購読の直後の再生の状態が想定と違う (${summarizeSubscriber(afterSubscribe)})`,
  ).toBe(false);
  // 再生を有効にしていない間は、鳴らした記録が増えない
  expect(
    afterSubscribe.audio.playoutTiming.playedFrames,
    `再生を有効にする前に音を鳴らしている (${summarizeSubscriber(afterSubscribe)})`,
  ).toBe(0);

  // Play Audio を押すと音が届いて鳴り始める
  await playAndWaitForAudio(page, "再購読の後に押した再生で音を鳴らし始めるのを待つ");

  const after = await readSubscriber(page);
  console.log(`再購読の後: ${summarizeSubscriber(after)}`);
  // 再生の状態が正常 (有効のまま、音が鳴っている)
  expect(
    after.audio.playbackEnabled,
    `再生が有効になっていない (${summarizeSubscriber(after)})`,
  ).toBe(true);
  expect(
    after.audio.playoutTiming.playedFrames,
    `押した後に音が鳴っていない (${summarizeSubscriber(after)})`,
  ).toBeGreaterThan(0);
  // 停止と再購読の間、アプリの console error を出さない
  expectNoApplicationConsoleErrors(consoleErrors, "停止と再購読の間");
});

test("音声の再生を押した直後に購読を止めても、再生の状態とアプリのエラーが壊れない", async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const consoleErrors = await startRelayPair(page);
  if (consoleErrors === null) {
    return;
  }

  // 音声が届いていないと再生の開始もすぐ終わってしまい、await の競合を作れない
  await waitForAudioDecoded(page, "音声が復号され始めるのを待つ");

  // Play Audio と Stop を同じタスクで押し、最終状態が壊れないことを確かめる。Play Audio の
  // 処理は非同期 (AudioContext の作成と resume、<audio> の play) であり、その await の間に
  // 購読の停止 (drain と AudioContext の close) が始まり得る。停止後に開始の続きが戻っても
  // 再生を有効にしてはならない。停止側は unsubscribe を待ってから再生を止めるため、この
  // 順序が必ず stale 分岐を通る保証はない。判定の順序は devtools の
  // audioPlaybackLifecycle の単体テストが担保する。
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");
  await pressPlayThenStop(page);

  // 停止の後始末が終わるまで待つ (Subscribe は停止中は無効)
  await waitForStopFinished(page);
  // 停止の後に、開始の続きが再生を有効にしていない
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playbackEnabled;
      },
      { message: "停止の後に再生が有効に戻っていないことを待つ", timeout: 10_000 },
    )
    .toBe(false);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const after = await readSubscriber(page);
  console.log(`停止の直後: ${summarizeSubscriber(after)}`);
  // 停止した後の状態が「購読していない」になっている
  expect(after.status, `停止の直後に購読の状態が壊れている (${summarizeSubscriber(after)})`).toBe(
    "disconnected",
  );

  // 停止の後始末が終わった後に購読と再生をやり直せる (停止が次の購読を壊さない)
  await resubscribe(page);
  await playAndWaitForAudio(page, "停止の後に再生をやり直して音を鳴らし始めるのを待つ");
  const afterRestart = await readSubscriber(page);
  console.log(`再開の後: ${summarizeSubscriber(afterRestart)}`);
  expect(
    afterRestart.audio.playoutTiming.playedFrames,
    `停止の後に再生をやり直しても音が鳴らない (${summarizeSubscriber(afterRestart)})`,
  ).toBeGreaterThan(0);
  // 押した直後に停止しても、アプリの console error を出さない
  expectNoApplicationConsoleErrors(consoleErrors, "再生の開始と停止の間");
});
