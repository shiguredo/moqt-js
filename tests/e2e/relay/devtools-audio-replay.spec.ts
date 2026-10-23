import { expect, test, type Page } from "@playwright/test";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL } from "../urls";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";

// moqt-devtools の subscriber で、音声の再生の停止・再開と購読のやり直しを実リレーで確かめる。
//
// 1 つ目は、購読の停止で音声を鳴らし切る (drain、上限 300 ms) 直後に購読をやり直しても、
// 古い停止の後始末が新しい購読の再生を壊さないことを見る。2 つ目は、音声の再生を
// 切り替えて `AudioContext` を作り直したとき、画面へ出す加工の量 (時間圧縮・補間) が
// 前の再生の累積を持ち越さず 0 から始まることを見る。
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
    playoutCompressedMs: number;
    playoutConcealedMs: number;
    playoutConcealments: number;
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
    `compressedMs=${audio.playoutCompressedMs}`,
    `concealedMs=${audio.playoutConcealedMs}`,
    `concealments=${audio.playoutConcealments}`,
    `peakDbfs=${audio.peakDbfs === null ? "-" : audio.peakDbfs.toFixed(1)}`,
    `warnings=${stats.warnings.length}`,
  ].join(", ");
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

test("購読の停止の直後に購読をやり直しても、音声の再生を続けられる", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // 実ブラウザの console error と、捕捉されなかった例外を記録する
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(String(error));
  });

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  // 購読を確立してから再生を有効にする
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.status;
      },
      {
        message: "購読が確立するのを待つ",
        timeout: SUBSCRIBE_TIMEOUT_MS,
      },
    )
    .toBe("connected");
  await ensureAudioPlaybackEnabled(page);
  // 再生が定常になってから停止する
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playoutTiming.playedFrames;
      },
      {
        message: "停止の前に音を鳴らし始めるのを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(50);
  const beforeStop = await readSubscriber(page);
  console.log(`停止の前: ${summarizeSubscriber(beforeStop)}`);

  // 停止する。音声は予約済みの分を鳴らし切ってから止まる (drain、上限は 300 ms)。
  // Stop の直後に Subscribe を押す。Subscribe は停止の後始末が終わるまで無効なので、
  // 押せるようになった時点で押す = drain が終わった直後の再購読になる。
  const stopStartedMs = Date.now();
  await page.getByTestId("subscriber-stop-button").click();
  await page.getByTestId("subscriber-subscribe-button").click();
  const stopToSubscribeMs = Date.now() - stopStartedMs;
  console.log(`停止から再購読までの時間: ${stopToSubscribeMs} ms`);
  // drain の上限 (300 ms) と、操作の往復と CI の遅さの余裕。これより長いと「直後」ではない
  expect(stopToSubscribeMs, "停止から再購読までに時間がかかりすぎている").toBeLessThan(3_000);

  // 再購読の確立と音声の再生を待つ
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.status;
      },
      {
        message: "再購読が確立するのを待つ",
        timeout: SUBSCRIBE_TIMEOUT_MS,
      },
    )
    .toBe("connected");
  const afterSubscribe = await readSubscriber(page);
  console.log(`再購読の直後: ${summarizeSubscriber(afterSubscribe)}`);
  // 再購読した時点では再生はまだ有効ではない (Stop で止まっている)
  expect(
    afterSubscribe.audio.playbackEnabled,
    `再購読の直後の再生の状態が想定と違う (${summarizeSubscriber(afterSubscribe)})`,
  ).toBe(false);
  const framesBeforePlay = afterSubscribe.audio.playoutTiming.playedFrames;
  expect(
    framesBeforePlay,
    `再生を有効にする前に音を鳴らしている (${summarizeSubscriber(afterSubscribe)})`,
  ).toBe(0);

  // Play Audio を押すと音が届いて鳴り始める
  await ensureAudioPlaybackEnabled(page);
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playbackEnabled ? stats.audio.playoutTiming.playedFrames : 0;
      },
      {
        message: "再購読の後に押した再生で音を鳴らし始めるのを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);

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
  // 停止と再購読の間、実ブラウザの console error を出さない
  expect(
    consoleErrors,
    `停止と再購読の間に console error が出た: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);
});

test("音声の再生を入れ直すと、加工した量の表示が 0 から始まる", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.status;
      },
      {
        message: "購読が確立するのを待つ",
        timeout: SUBSCRIBE_TIMEOUT_MS,
      },
    )
    .toBe("connected");
  await ensureAudioPlaybackEnabled(page);
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playoutTiming.playedFrames;
      },
      {
        message: "音を鳴らし始めるのを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(50);

  // 加工 (時間圧縮・補間) の量を計器へ出す。メインスレッドを実時間で止めると、その間に
  // 鳴る予定だった音が遅れて届き、目標へ詰める (圧縮) か穴を補間する (補間) 動きになる。
  // 実ブラウザの停止であり、longtask と同じ条件である。
  await page.evaluate(() => {
    const endMs = performance.now() + 2_000;
    while (performance.now() < endMs) {
      // 実時間で止まるまで空回しする
    }
  });
  // 停止から復帰し、加工の量が計器に出るまで待つ
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playoutCompressedMs + stats.audio.playoutConcealedMs;
      },
      { message: "音を加工した量が計器に出るのを待つ", timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const beforeToggle = await readSubscriber(page);
  console.log(`再生を入れ直す前: ${summarizeSubscriber(beforeToggle)}`);
  const beforeTotal =
    beforeToggle.audio.playoutCompressedMs + beforeToggle.audio.playoutConcealedMs;
  expect(
    beforeTotal,
    `再生を入れ直す前に加工の量が計器へ出ていない (${summarizeSubscriber(beforeToggle)})`,
  ).toBeGreaterThan(0);

  // 再生を止めて入れ直す。AudioContext を作り直し、累積の計器は購読の統計として残るが、
  // 画面へ出す値は再生を始めた時点からの差 (0 起点) になる。
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // 押した直後 (累積の計器の基準を取り直した直後) の表示を読む
  const afterToggle = await readSubscriber(page);
  expect(
    afterToggle.audio.playbackEnabled,
    `再生を再開できていない (${summarizeSubscriber(afterToggle)})`,
  ).toBe(true);
  console.log(`再生を入れ直した直後: ${summarizeSubscriber(afterToggle)}`);
  // 前の再生の累積を持ち越さず、0 から始まる (直後に少し加工されても、前の累積とは
  // 桁が違う)。前の累積が計器から消えないことを、次の再生で増えることで確かめる
  expect(
    afterToggle.audio.playoutCompressedMs,
    `入れ直した直後の時間圧縮の表示が 0 起点になっていない (前=${beforeToggle.audio.playoutCompressedMs}, 後=${afterToggle.audio.playoutCompressedMs})`,
  ).toBeLessThanOrEqual(20);
  expect(
    afterToggle.audio.playoutConcealedMs,
    `入れ直した直後の補間の表示が 0 起点になっていない (前=${beforeToggle.audio.playoutConcealedMs}, 後=${afterToggle.audio.playoutConcealedMs})`,
  ).toBeLessThanOrEqual(20);
  // 前の再生で計器に溜まった量より、入れ直した直後の表示が少ない (前の累積を持ち越さない)
  const afterTotal = afterToggle.audio.playoutCompressedMs + afterToggle.audio.playoutConcealedMs;
  expect(
    afterTotal,
    `入れ直した直後の表示が前の再生の累積を持ち越している (前=${beforeTotal}, 後=${afterTotal})`,
  ).toBeLessThan(beforeTotal);
  // 入れ直した後も音は鳴り続ける
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playoutTiming.playedFrames;
      },
      {
        message: "入れ直した後に音を鳴らし続けるのを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);
});
