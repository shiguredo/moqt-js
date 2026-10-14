import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";

// moqt-devtools の publisher と subscriber を実リレーへつなぎ、配信した音声が購読側で
// 「崩れずに鳴る」ことを値で確かめる。
//
// きっかけは手元のマイクでの実測 (2026-10-14) である。音声は届いて再生されていたが、
// 受信した音声がほぼ無音 (peak -85 dBFS / rms -97 dBFS) であり、聴感ではノイズと
// 途切れが出ていた。マイクのレベルに依存せずに判定するため、Chromium の偽マイク
// (--use-file-for-fake-audio-capture) に 16 kHz モノラルのサイン波を読ませる。手元の
// マイクの形式 (16 kHz モノラル) と、そこへ 48 kHz ステレオを要求する設定の組み合わせを
// 再現したうえで、届いた音の「レベル」と「波形の尖り具合 (peak - rms)」を見る。
//
// サイン波の peak - rms は 3.0 dB である (peak = 振幅、rms = 振幅 / √2)。ノイズが乗る、
// サンプルレートを取り違える、補間 (concealment) が入る、間引いて詰める (time-stretch) と、
// この差は広がるか、レベルが落ちる。聴感の「ノイズ」を値で捕まえるための判定である。
//
// もう 1 つ、配信の途中から購読する (relay の cache から配られる) 場合の復旧を確かめる。
// 手元の実測では、購読のやり直しの後に A/V の基準が共有されないまま残り (unsharedReason:
// hold)、受信側の追いつきが 3.2 秒を飛ばしていた。

/** 偽マイクに読ませる WAV (16 kHz モノラル)。手元のマイクと同じ形式にする */
const FAKE_MIC_WAV = join(tmpdir(), `moqt-js-fake-mic-16k-mono-${process.pid.toString()}.wav`);

/** 偽マイクのサイン波の振幅 (0..1)。-6 dBFS になる */
const TONE_AMPLITUDE = 0.5;

/** 偽マイクのサイン波の周波数 (Hz) */
const TONE_FREQUENCY_HZ = 440;

/** サイン波の peak - rms (dB) */
const TONE_CREST_DB = 20 * Math.log10(Math.SQRT2);

/** 16 bit PCM のモノラル WAV を組み立てる (ヘッダーとサンプル) */
function buildToneWav(options: {
  sampleRate: number;
  seconds: number;
  frequencyHz: number;
  amplitude: number;
}): Buffer {
  const frames = Math.floor(options.sampleRate * options.seconds);
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // モノラル
  buffer.writeUInt32LE(options.sampleRate, 24);
  buffer.writeUInt32LE(options.sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index++) {
    const value =
      options.amplitude *
      Math.sin((2 * Math.PI * options.frequencyHz * index) / options.sampleRate);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2);
  }
  return buffer;
}

writeFileSync(
  FAKE_MIC_WAV,
  buildToneWav({
    sampleRate: 16_000,
    seconds: 4,
    frequencyHz: TONE_FREQUENCY_HZ,
    amplitude: TONE_AMPLITUDE,
  }),
);

test.use({
  launchOptions: {
    channel: "chromium",
    args: [
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
    ],
  },
  permissions: ["microphone", "camera"],
});

/**
 * devtools のページ
 *
 * 既定は playwright.config.ts の webServer (port 5173) が配信する開発サーバー。
 * `MOQT_DEVTOOLS_URL` を渡すと、配信済みの devtools (例:
 * https://moqt-devtools.shiguredo.app/index.html) をそのまま確かめられる
 */
/**
 * 配信する音声のサンプルレート (Hz)
 *
 * 手元のマイクは 16 kHz モノラルで取れる (要求は 48 kHz ステレオ)。その形式でも回せるように
 * 環境変数で切り替える。既定は要求と同じ 48 kHz
 */
const AUDIO_SAMPLE_RATE = process.env.MOQT_TEST_AUDIO_SAMPLE_RATE ?? "48000";

/** 配信する音声のチャンネル数。手元のマイクの形式 (1) でも回せるように環境変数で切り替える */
const AUDIO_CHANNELS = process.env.MOQT_TEST_AUDIO_CHANNELS ?? "2";

const DEVTOOLS_URL = process.env.MOQT_DEVTOOLS_URL ?? "http://localhost:5173/index.html";

/** テスト全体の上限 */
const TEST_TIMEOUT_MS = RELAY_TEST_TIMEOUT_MS * 3;

/** 音声の Object が届いて鳴り始めるまでに待つ上限 (ミリ秒) */
const AUDIO_ARRIVAL_TIMEOUT_MS = 30_000;

/** 音が鳴ってから判定するまでの待ち (ミリ秒)。メーターの窓が埋まるのを待つ */
const MEASURE_MS = 3_000;

/** 推移を観測する間隔 (ミリ秒) */
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * 購読のやり直しの後、A/V の基準の共有が戻るのを待つサンプル数 (1 秒間隔)
 *
 * `PLAYOUT_BASE_UNSHARED_HOLD_MS` (30 秒) より短くする。保持が解除されないままなら、
 * この待ちで分かる
 */
const SHARE_RECOVERY_SAMPLES = 25;

/** 長時間の配信を観測する長さ (ミリ秒) */
const SOAK_MS = 60_000;

/** 購読をやめてやり直す回数 */
const RESTART_CYCLES = 6;

/** やり直した後、live の音声へ戻るのを待つ上限 (ミリ秒) */
const RESTART_RECOVERY_TIMEOUT_MS = 20_000;

/** 受け取った音が「鳴っている」とみなす下限 (dBFS)。無音 (実測 -85 dBFS) と分ける */
const AUDIBLE_PEAK_DBFS = -30;

/**
 * 受け取った音がサイン波のままと言える peak - rms の範囲 (dB)
 *
 * サイン波は 3.0 dB である。窓 (50 ms) と経路の揺らぎを見込んで ±2 dB を許す。ノイズが
 * 乗ったり補間が入ると 8 dB 以上へ広がる
 */
const TONE_CREST_TOLERANCE_DB = 2;

/** devtools の publisher の統計 (必要な部分) */
interface DevtoolsPublisherStats {
  status: string;
  objectsSent: number;
  framesEncoded: number;
  warnings: readonly unknown[];
  audio: {
    objectsSent: number;
    chunksEncoded: number;
    lastSentLevel: number | null;
    meterPeakDbfs: number | null;
    meterRmsDbfs: number | null;
    catchUp: {
      catchingUp: boolean;
      catchUpStarts: number;
      droppedMs: number;
      sendLagMs: number | null;
      maxSendLagMs: number | null;
      sendQueueMs: number;
      sendQueueFrames: number;
      pendingMs: number;
    };
  };
  catalog: {
    tracks: { name: string; codec?: string; samplerate?: number; channelConfig?: string }[];
  } | null;
}

/** devtools の subscriber の統計 (必要な部分) */
interface DevtoolsSubscriberStats {
  id: string;
  status: string;
  warnings: readonly unknown[];
  framesDecoded: number;
  catchUpPending: boolean;
  catchUpFramesSkipped: number;
  audio: {
    objectsReceived: number;
    chunksDecoded: number;
    playbackEnabled: boolean;
    peakDbfs: number | null;
    rmsDbfs: number | null;
    playoutRebases: number;
    playoutCompressedMs: number;
    playoutConcealedMs: number;
    playoutConcealments: number;
    playoutCatchUp: {
      catchUpStarts: number;
      skippedMs: number;
      catchingUp: boolean;
      lagMs: number;
      floorMs: number;
      maxLagMs: number;
    };
    receiveDelayMs: number;
    maxReceiveDelayMs: number;
    playoutTiming: {
      playedMs: number;
      missedFrames: number;
      missedByReason: Record<string, { count: number; ms: number }>;
      startDelayMs: { p50: number | null; p95: number | null; max: number | null } | null;
    };
  };
  avSync: {
    delays: {
      sharingBases: boolean;
      unsharedReason: string;
      baseDifferenceMs: number | null;
      audioDelayFeedback: {
        targetMs: number;
        jitterTargetMs: number;
        appliedMs: number;
        reason: string;
        ceilingMs: number | null;
        adjustments: number;
        latenessP50Ms: number | null;
        startDelayP50Ms: number | null;
        slackP50Ms: number | null;
      };
    };
  };
}

/** 統計を読む */
async function readPublisher(page: Page): Promise<DevtoolsPublisherStats> {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: { getPublisher(): DevtoolsPublisherStats } })
      .moqtDevTools;
    return api.getPublisher();
  });
}

/** 統計を読む */
async function readSubscriber(page: Page): Promise<DevtoolsSubscriberStats> {
  return page.evaluate(() => {
    const api = (
      window as unknown as { moqtDevTools: { getSubscribers(): DevtoolsSubscriberStats[] } }
    ).moqtDevTools;
    const subscriber = api.getSubscribers()[0];
    if (subscriber === undefined) {
      throw new Error("購読者がまだ作られていない");
    }
    return subscriber;
  });
}

/** 受け取った音の peak - rms (dB)。値が無ければ null */
function crestDb(peakDbfs: number | null, rmsDbfs: number | null): number | null {
  if (peakDbfs === null || rmsDbfs === null) {
    return null;
  }
  return peakDbfs - rmsDbfs;
}

/** 判定に使う値の 1 行 (失敗メッセージとログに残す) */
function summarizeSubscriber(stats: DevtoolsSubscriberStats): string {
  const { audio, avSync } = stats;
  const missed = Object.entries(audio.playoutTiming.missedByReason)
    .filter(([, value]) => value.count > 0)
    .map(([reason, value]) => `${reason}=${value.count}`)
    .join("/");
  const crest = crestDb(audio.peakDbfs, audio.rmsDbfs);
  return [
    `status=${stats.status}`,
    `objects=${audio.objectsReceived}`,
    `decoded=${audio.chunksDecoded}`,
    `peakDbfs=${audio.peakDbfs === null ? "-" : audio.peakDbfs.toFixed(1)}`,
    `rmsDbfs=${audio.rmsDbfs === null ? "-" : audio.rmsDbfs.toFixed(1)}`,
    `crestDb=${crest === null ? "-" : crest.toFixed(1)}`,
    `playedMs=${audio.playoutTiming.playedMs.toFixed(0)}`,
    `missedFrames=${audio.playoutTiming.missedFrames}${missed === "" ? "" : `(${missed})`}`,
    `rebases=${audio.playoutRebases}`,
    `compressedMs=${audio.playoutCompressedMs}`,
    `concealedMs=${audio.playoutConcealedMs}`,
    `concealments=${audio.playoutConcealments}`,
    `catchUpStarts=${audio.playoutCatchUp.catchUpStarts}`,
    `catchUpPending=${audio.playoutCatchUp.catchingUp}`,
    `skippedMs=${audio.playoutCatchUp.skippedMs.toFixed(0)}`,
    `catchUpLagMs=${audio.playoutCatchUp.lagMs.toFixed(0)}`,
    `receiveDelayMs=${audio.receiveDelayMs.toFixed(0)}`,
    `maxReceiveDelayMs=${audio.maxReceiveDelayMs.toFixed(0)}`,
    `startDelayMs=${audio.playoutTiming.startDelayMs?.p50 === null ? "-" : (audio.playoutTiming.startDelayMs?.p50 ?? "-")}`,
    `videoFrames=${stats.framesDecoded}`,
    `videoCatchUpPending=${stats.catchUpPending}`,
    `sharingBases=${avSync.delays.sharingBases}`,
    `unsharedReason=${avSync.delays.unsharedReason}`,
    `warnings=${stats.warnings.length}`,
  ].join(", ");
}

/**
 * 鳴っている音が live かどうか (キャッシュや復号の溜まりを鳴らしていないか) を判定する
 *
 * 音を一定のトーンにすると、遅れて鳴っていても値だけでは分からない。受信の遅れ
 * (到着 - 送られた TIMESTAMP) と、受信側の追いつきが観測している遅れ (`lagMs`)、
 * 鳴り始めの遅れ (`startDelayMs`) を並べて見る
 */
function expectLive(stats: DevtoolsSubscriberStats, label: string): void {
  expect(
    stats.audio.receiveDelayMs,
    `${label}: 受信の遅れが大きい (live ではなく遅れて鳴っている) (${summarizeSubscriber(stats)})`,
  ).toBeLessThan(300);
  expect(
    stats.audio.playoutCatchUp.lagMs,
    `${label}: 受信側の追いつきが見ている遅れが大きい (${summarizeSubscriber(stats)})`,
  ).toBeLessThan(300);
  expect(
    stats.audio.playoutTiming.startDelayMs?.p50 ?? Number.POSITIVE_INFINITY,
    `${label}: 鳴り始めの遅れが大きい (${summarizeSubscriber(stats)})`,
  ).toBeLessThan(1_000);
}

/** 鳴っている音の質のサンプル 1 点 */
interface AudioQualitySample {
  /** サンプルの時刻 (ミリ秒、テストの時計) */
  readonly atMs: number;
  /** peak (dBFS) */
  readonly peakDbfs: number | null;
  /** peak - rms (dB) */
  readonly crestDb: number | null;
  readonly skippedMs: number;
  readonly rebases: number;
  readonly missedFrames: number;
  readonly catchUpStarts: number;
  readonly receiveDelayMs: number;
  readonly playedMs: number;
}

/**
 * 鳴っている音を一定時間サンプリングする
 *
 * 音が途切れる (フレームが抜ける) と、50 ms のメーターの窓に無音が入り、peak - rms が
 * 広がる。サイン波なら 3 dB のままである。窓ごとの値を並べて、途切れが一過性か続くのかを
 * 見分ける
 */
async function monitorAudio(
  page: Page,
  durationMs: number,
  intervalMs = 200,
): Promise<AudioQualitySample[]> {
  const samples: AudioQualitySample[] = [];
  const endMs = Date.now() + durationMs;
  while (Date.now() < endMs) {
    const stats = await readSubscriber(page);
    samples.push({
      atMs: Date.now(),
      peakDbfs: stats.audio.peakDbfs,
      crestDb: crestDb(stats.audio.peakDbfs, stats.audio.rmsDbfs),
      skippedMs: stats.audio.playoutCatchUp.skippedMs,
      rebases: stats.audio.playoutRebases,
      missedFrames: stats.audio.playoutTiming.missedFrames,
      catchUpStarts: stats.audio.playoutCatchUp.catchUpStarts,
      receiveDelayMs: stats.audio.receiveDelayMs,
      playedMs: stats.audio.playoutTiming.playedMs,
    });
    await page.waitForTimeout(intervalMs);
  }
  return samples;
}

/** サンプルの要約 (失敗メッセージとログに残す) */
function summarizeQuality(samples: readonly AudioQualitySample[], label: string): string {
  const peaks = samples.map((sample) => sample.peakDbfs ?? -100);
  const crests = samples.map((sample) => sample.crestDb ?? 0).sort((a, b) => a - b);
  const silent = peaks.filter((peak) => peak < AUDIBLE_PEAK_DBFS).length;
  const distorted = crests.filter(
    (crest) => Math.abs(crest - TONE_CREST_DB) > TONE_CREST_TOLERANCE_DB,
  ).length;
  const last = samples[samples.length - 1];
  const first = samples[0];
  const median = crests.length === 0 ? null : (crests[Math.floor(crests.length / 2)] ?? null);
  return [
    `${label}: サンプル数=${samples.length}`,
    `無音のサンプル=${silent}`,
    `波形が崩れたサンプル=${distorted}`,
    `crest の中央値=${median === null ? "-" : median.toFixed(1)} dB`,
    `peak の最小=${Math.min(...peaks).toFixed(1)} dBFS`,
    `receiveDelayMs=${last?.receiveDelayMs.toFixed(0) ?? "-"}`,
    `skippedMs の増加=${first === undefined || last === undefined ? "-" : (last.skippedMs - first.skippedMs).toFixed(0)}`,
    `rebases の増加=${first === undefined || last === undefined ? "-" : String(last.rebases - first.rebases)}`,
    `missedFrames の増加=${first === undefined || last === undefined ? "-" : String(last.missedFrames - first.missedFrames)}`,
    `catchUpStarts の増加=${first === undefined || last === undefined ? "-" : String(last.catchUpStarts - first.catchUpStarts)}`,
    `playedMs=${first === undefined || last === undefined ? "-" : (last.playedMs - first.playedMs).toFixed(0)}`,
  ].join(", ");
}

/** 配信と購読を始める (both モードのページ) */

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
    // 偽マイクをマイク経路で取る (devtools の既定と同じ経路)。手元の設定と同じく、
    // 16 kHz モノラルの入力へ 48 kHz ステレオを要求する
    audioSource: "microphone",
    audioSampleRate: AUDIO_SAMPLE_RATE,
    audioChannels: AUDIO_CHANNELS,
  });
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);

  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const stats = await readPublisher(page);
        return stats.objectsSent;
      },
      {
        message: "配信側が Object を送り始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);

  await page.getByTestId("subscriber-subscribe-button").click();
  const playbackToggle = page.getByTestId("subscriber-audio-playback-toggle");
  if (!(await playbackToggle.isChecked())) {
    await playbackToggle.click();
  }
}

/** 音声が届いて鳴るまで待つ */
async function waitForAudio(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.playbackEnabled && stats.audio.chunksDecoded > 10;
      },
      { message: "購読側が音声を復号して鳴らし始めるのを待つ", timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBe(true);
}

test("配信した音声が、レベルと波形を保ったまま購読側で鳴る", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);
  await page.waitForTimeout(MEASURE_MS);

  const publisher = await readPublisher(page);
  const subscriber = await readSubscriber(page);
  console.log(`配信側の観測: ${JSON.stringify(publisher.catalog?.tracks ?? null)}`);
  console.log(
    `配信側の音声: peakDbfs=${publisher.audio.meterPeakDbfs}, rmsDbfs=${publisher.audio.meterRmsDbfs}, ` +
      `lastSentLevel=${publisher.audio.lastSentLevel}`,
  );
  console.log(`購読側の観測: ${summarizeSubscriber(subscriber)}`);

  // 送る側の入力は 16 kHz モノラルで取れている (要求は 48 kHz ステレオ)。実際の形式は
  // catalog に出る
  const audioTrack = publisher.catalog?.tracks.find((track) => track.name === "audio");
  expect(audioTrack, "catalog に音声トラックが無い").toBeDefined();
  const publisherCrest = crestDb(publisher.audio.meterPeakDbfs, publisher.audio.meterRmsDbfs);
  console.log(`配信側の波形の尖り (peak - rms): ${publisherCrest?.toFixed(1) ?? "-"} dB`);

  // 届いた音が鳴っている (無音ではない)
  expect(
    subscriber.audio.peakDbfs ?? -100,
    `受信した音声が無音に近い (${summarizeSubscriber(subscriber)})`,
  ).toBeGreaterThan(AUDIBLE_PEAK_DBFS);

  // 届いた音がサイン波のまま (ノイズや補間で崩れていない)
  const subscriberCrest = crestDb(subscriber.audio.peakDbfs, subscriber.audio.rmsDbfs);
  expect(subscriberCrest, `受信した音声の peak - rms が読めない`).not.toBeNull();
  expect(
    Math.abs((subscriberCrest ?? 0) - TONE_CREST_DB),
    `受信した音声の波形が崩れている (peak - rms が ${subscriberCrest?.toFixed(1)} dB。` +
      `サイン波は ${TONE_CREST_DB.toFixed(1)} dB。${summarizeSubscriber(subscriber)})`,
  ).toBeLessThan(TONE_CREST_TOLERANCE_DB);

  // レベルの目安: 入力 (-6 dBFS) と受信の peak が大きく離れていない
  expect(
    (subscriber.audio.peakDbfs ?? -100) - (publisher.audio.meterPeakDbfs ?? 0),
    `入力と受信のレベルが離れている (${summarizeSubscriber(subscriber)})`,
  ).toBeGreaterThan(-12);

  // 鳴っている (playedMs が観測の時間に近い)
  expect(
    subscriber.audio.playoutTiming.playedMs,
    `鳴った長さが足りない (${summarizeSubscriber(subscriber)})`,
  ).toBeGreaterThan(1_000);
  // 鳴らなかった音が無い (購読直後の 1 フレームは復号の出力が目標より前に来ることがある)
  expect(
    subscriber.audio.playoutTiming.missedFrames,
    `鳴らなかった音が多い (${summarizeSubscriber(subscriber)})`,
  ).toBeLessThanOrEqual(2);
  expect(
    subscriber.audio.playoutTiming.missedByReason.backlog?.count ?? 0,
    `並べすぎで鳴らなかった音がある (${summarizeSubscriber(subscriber)})`,
  ).toBe(0);
  // 音を飛ばしていない
  expect(
    subscriber.audio.playoutCatchUp.skippedMs,
    `受信側の追いつきが音を飛ばしている (${summarizeSubscriber(subscriber)})`,
  ).toBeLessThan(500);
  // A/V の基準が共有されている
  expect(
    subscriber.avSync.delays.sharingBases,
    `A/V の基準が共有されていない (${summarizeSubscriber(subscriber)})`,
  ).toBe(true);
  // 前提から外れた状態が無い
  expect(subscriber.warnings.length, `警告が出ている (${summarizeSubscriber(subscriber)})`).toBe(0);
  // 鳴っているのは live の音 (キャッシュや溜まった分ではない)
  expectLive(subscriber, "定常");

  // 時間方向に見る。途切れ (フレームが抜けて窓に無音が入る) が続かないこと
  const baselineQuality = await monitorAudio(page, 6_000);
  console.log(`定常の音の質: ${summarizeQuality(baselineQuality, "定常")}`);
  expect(
    baselineQuality.filter((sample) => (sample.peakDbfs ?? -100) < AUDIBLE_PEAK_DBFS).length,
    `定常で音が途切れている: ${summarizeQuality(baselineQuality, "定常")}`,
  ).toBe(0);
});

test("配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する", async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  const namespace = formatTrackNamespace(createTestNamespace());

  // 先に配信だけを始め、cache に音声と映像が溜まった状態を作る
  const publisherPage = await browser.newPage();
  try {
    const params = new URLSearchParams({
      url: moqtUri,
      namespace,
      mode: "publisher",
      codec: "vp8",
      resolution: "640x360",
      bitrate: "1000000",
      audioSource: "microphone",
      audioSampleRate: AUDIO_SAMPLE_RATE,
      audioChannels: AUDIO_CHANNELS,
    });
    await publisherPage.goto(`${DEVTOOLS_URL}?${params.toString()}`);
    await publisherPage.getByTestId("publisher-publish-button").click();
    await expect
      .poll(
        async () => {
          const stats = await readPublisher(publisherPage);
          return stats.objectsSent;
        },
        {
          message: "配信側が Object を送り始めるのを待つ",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);
    // cache に溜まる分だけ待つ (cache から配られた音を飛ばして live へ戻ることを見る)
    await publisherPage.waitForTimeout(6_000);

    // 後から購読だけを始める。relay は SUBSCRIBE の応答に latest の位置を返し、それ以降と
    // cache の分が届く
    const subscriberPage = await browser.newPage();
    try {
      const subscriberParams = new URLSearchParams({
        url: moqtUri,
        namespace,
        mode: "subscriber",
        codec: "vp8",
        audioSampleRate: AUDIO_SAMPLE_RATE,
        audioChannels: AUDIO_CHANNELS,
      });
      await subscriberPage.goto(`${DEVTOOLS_URL}?${subscriberParams.toString()}`);
      await subscriberPage.getByTestId("subscriber-subscribe-button").click();
      const playbackToggle = subscriberPage.getByTestId("subscriber-audio-playback-toggle");
      if (!(await playbackToggle.isChecked())) {
        await playbackToggle.click();
      }

      // 後から購読しても音声が届いて鳴る
      await expect
        .poll(
          async () => {
            const stats = await readSubscriber(subscriberPage);
            return stats.audio.objectsReceived > 0 && stats.audio.chunksDecoded > 0;
          },
          {
            message: "後から購読した側へ音声の Object が届くのを待つ",
            timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
          },
        )
        .toBe(true);
      await subscriberPage.waitForTimeout(MEASURE_MS);

      const subscriber = await readSubscriber(subscriberPage);
      console.log(`後から購読した側の観測: ${summarizeSubscriber(subscriber)}`);

      // 映像も届いて、追いつきが終わっている (cache から配られた分を飛ばして live へ)
      expect(subscriber.framesDecoded, "後から購読した側へ映像が届いていない").toBeGreaterThan(0);
      expect(
        subscriber.catchUpPending,
        `後から購読した側の追いつきが終わっていない (${summarizeSubscriber(subscriber)})`,
      ).toBe(false);

      // 音声が鳴っている (無音ではない)
      expect(
        subscriber.audio.peakDbfs ?? -100,
        `後から購読した側の音声が無音に近い (${summarizeSubscriber(subscriber)})`,
      ).toBeGreaterThan(AUDIBLE_PEAK_DBFS);
      // 波形が崩れていない
      const subscriberCrest = crestDb(subscriber.audio.peakDbfs, subscriber.audio.rmsDbfs);
      expect(
        Math.abs((subscriberCrest ?? 0) - TONE_CREST_DB),
        `後から購読した側の音声の波形が崩れている (peak - rms が ${subscriberCrest?.toFixed(1)} dB。` +
          `${summarizeSubscriber(subscriber)})`,
      ).toBeLessThan(TONE_CREST_TOLERANCE_DB);
      // cache から配られた分を飛ばした後、追いつきが終わっている
      expect(
        subscriber.audio.playoutCatchUp.catchingUp,
        `後から購読した側の追いつきが続いている (${summarizeSubscriber(subscriber)})`,
      ).toBe(false);
      // A/V の基準が共有されている
      expect(
        subscriber.avSync.delays.sharingBases,
        `後から購読した側で A/V の基準が共有されていない (${summarizeSubscriber(subscriber)})`,
      ).toBe(true);
      // 前提から外れた状態が無い
      expect(
        subscriber.warnings.length,
        `後から購読した側で警告が出ている (${summarizeSubscriber(subscriber)})`,
      ).toBe(0);
      // 後から購読しても、cache から配られた分は鳴らさず live へ戻っている
      expectLive(subscriber, "後から購読");
    } finally {
      await subscriberPage.context().close();
    }
  } finally {
    await publisherPage.context().close();
  }
});

test("購読をやり直しても、cache から配られた分を飛ばして live へ復帰する", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);
  // 映像の Group が伸びるまで待つ。sora-moq の cache は「最新 Group の先頭」から replay
  // する (sora_moq_relay.erl の replay_start_position/3) ため、購読をやり直すと映像は
  // キーフレーム (既定のキーフレーム間隔 10 秒) まで戻って配り直される。音声は 1 Object =
  // 1 Group なので 1 個だけである
  await page.waitForTimeout(10_000);
  const before = await readSubscriber(page);
  console.log(`購読のやり直しの前: ${summarizeSubscriber(before)}`);

  // 購読をやめてやり直す
  await page.getByTestId("subscriber-stop-button").click();
  await page.waitForTimeout(3_000);
  await page.getByTestId("subscriber-subscribe-button").click();
  const playbackToggle = page.getByTestId("subscriber-audio-playback-toggle");
  if (!(await playbackToggle.isChecked())) {
    await playbackToggle.click();
  }

  await expect
    .poll(
      async () => {
        const stats = await readSubscriber(page);
        return stats.audio.objectsReceived > before.audio.objectsReceived;
      },
      {
        message: "購読のやり直しの後、音声の Object が届き始めるのを待つ",
        timeout: AUDIO_ARRIVAL_TIMEOUT_MS,
      },
    )
    .toBe(true);
  await page.waitForTimeout(MEASURE_MS);

  const after = await readSubscriber(page);
  console.log(`購読のやり直しの後: ${summarizeSubscriber(after)}`);

  // やり直した後も音が鳴っている
  expect(
    after.audio.peakDbfs ?? -100,
    `やり直しの後の音声が無音に近い (${summarizeSubscriber(after)})`,
  ).toBeGreaterThan(AUDIBLE_PEAK_DBFS);
  const afterCrest = crestDb(after.audio.peakDbfs, after.audio.rmsDbfs);
  expect(
    Math.abs((afterCrest ?? 0) - TONE_CREST_DB),
    `やり直しの後の波形が崩れている (peak - rms が ${afterCrest?.toFixed(1)} dB。` +
      `${summarizeSubscriber(after)})`,
  ).toBeLessThan(TONE_CREST_TOLERANCE_DB);
  // 追いつきが終わっている
  expect(
    after.audio.playoutCatchUp.catchingUp,
    `やり直しの後に追いつきが続いている (${summarizeSubscriber(after)})`,
  ).toBe(false);
  // 飛ばす量は cache の分まで
  expect(
    after.audio.playoutCatchUp.skippedMs - before.audio.playoutCatchUp.skippedMs,
    `やり直しの後の追いつきが飛ばした音が多すぎる (${summarizeSubscriber(after)})`,
  ).toBeLessThan(10_000);
  // A/V の基準が共有されている
  expect(
    after.avSync.delays.sharingBases,
    `やり直しの後に A/V の基準が共有されないまま (${summarizeSubscriber(after)})`,
  ).toBe(true);
  // 前提から外れた状態が無い
  expect(
    after.warnings.length,
    `やり直しの後に警告が出ている (${summarizeSubscriber(after)})`,
  ).toBe(0);
  // やり直した後も live の音を鳴らしている
  expectLive(after, "購読のやり直し後");

  // やり直しの後、映像の追いつき (cache から配られた分を飛ばす) と A/V の基準の共有が
  // 戻るかを時間方向に見る。手元の実測 (2026-10-14) では、ここで基準が共有されないまま
  // (unsharedReason: hold) 16 秒以上残った
  const shareSeries: string[] = [];
  let shared: DevtoolsSubscriberStats | null = null;
  while (shareSeries.length < SHARE_RECOVERY_SAMPLES) {
    const stats = await readSubscriber(page);
    shareSeries.push(
      (stats.avSync.delays.sharingBases ? "shared" : stats.avSync.delays.unsharedReason) +
        `/diff=${stats.avSync.delays.baseDifferenceMs === null ? "-" : stats.avSync.delays.baseDifferenceMs.toFixed(0)}` +
        `/videoCatchUp=${stats.catchUpPending ? "yes" : "no"}` +
        `/videoSkipped=${stats.catchUpFramesSkipped}` +
        `/rebases=${stats.audio.playoutRebases}` +
        `/receiveDelay=${stats.audio.receiveDelayMs.toFixed(0)}`,
    );
    if (stats.avSync.delays.sharingBases && !stats.catchUpPending) {
      shared = stats;
      break;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  console.log(`  やり直し後の推移: ${shareSeries.join(", ")}`);
  expect(
    shared,
    `購読のやり直しの後に A/V の基準の共有と映像の追いつきが戻らない ` +
      `(推移: ${shareSeries.join(", ")} / ${summarizeSubscriber(await readSubscriber(page))})`,
  ).not.toBeNull();

  // 時間方向に見る。やり直した後に途切れが続かないこと (cache から配られた分を飛ばした
  // 直後の窓は崩れてよいが、その後はサイン波のまま鳴り続ける)
  const restartQuality = await monitorAudio(page, 8_000);
  const samples = restartQuality.map(
    (sample) => `${(sample.crestDb ?? 0).toFixed(1)}/${(sample.peakDbfs ?? -100).toFixed(0)}`,
  );
  console.log(`購読のやり直し後の音の質: ${summarizeQuality(restartQuality, "やり直し後")}`);
  console.log(`  窓ごとの crest/peak: ${samples.join(", ")}`);
  expect(
    restartQuality.filter((sample) => (sample.peakDbfs ?? -100) < AUDIBLE_PEAK_DBFS).length,
    `やり直しの後に音が途切れている: ${summarizeQuality(restartQuality, "やり直し後")}`,
  ).toBe(0);
});

test("購読のやり直しを繰り返しても、毎回 live の音声へ戻る", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);
  await page.waitForTimeout(2_000);

  // 購読をやめてやり直すのを繰り返す。やり直すたびに sora-moq は SUBSCRIBE_OK の
  // LARGEST_OBJECT まで cache から配り直し、購読側はそれを飛ばして live へ戻る。
  // 途中で replay が止まる、音が戻らない、live へ戻らない状態が出ないかを見る
  const report: string[] = [];
  for (let cycle = 1; cycle <= RESTART_CYCLES; cycle++) {
    const before = await readSubscriber(page);
    await page.getByTestId("subscriber-stop-button").click();
    // 切っている長さを回ごとに変える (1 秒 / 3 秒)。cache に溜まる量を変える
    await page.waitForTimeout(cycle % 2 === 1 ? 1_000 : 3_000);
    const resumeStartedMs = Date.now();
    await page.getByTestId("subscriber-subscribe-button").click();
    const playbackToggle = page.getByTestId("subscriber-audio-playback-toggle");
    if (!(await playbackToggle.isChecked())) {
      await playbackToggle.click();
    }

    // 音声が届いて鳴り、live に戻るまで待つ
    let recovered: DevtoolsSubscriberStats | null = null;
    while (Date.now() - resumeStartedMs < RESTART_RECOVERY_TIMEOUT_MS) {
      const stats = await readSubscriber(page);
      if (
        stats.audio.objectsReceived > before.audio.objectsReceived &&
        (stats.audio.peakDbfs ?? -100) > AUDIBLE_PEAK_DBFS &&
        stats.audio.playbackEnabled &&
        stats.audio.receiveDelayMs < 300
      ) {
        recovered = stats;
        break;
      }
      await page.waitForTimeout(250);
    }
    const after = recovered ?? (await readSubscriber(page));
    report.push(
      `回${cycle} (${Date.now() - resumeStartedMs} ms で復帰): ` +
        `objects=${after.audio.objectsReceived - before.audio.objectsReceived}, ` +
        `peakDbfs=${after.audio.peakDbfs === null ? "-" : after.audio.peakDbfs.toFixed(1)}, ` +
        `receiveDelayMs=${after.audio.receiveDelayMs.toFixed(0)}, ` +
        `maxReceiveDelayMs=${after.audio.maxReceiveDelayMs.toFixed(0)}, ` +
        `rebases=${after.audio.playoutRebases}, ` +
        `catchUpStarts=${after.audio.playoutCatchUp.catchUpStarts}, ` +
        `skippedMs=${after.audio.playoutCatchUp.skippedMs.toFixed(0)}, ` +
        `videoSkipped=${after.catchUpFramesSkipped}, ` +
        `sharingBases=${after.avSync.delays.sharingBases}/${after.avSync.delays.unsharedReason}, ` +
        `warnings=${after.warnings.length}`,
    );
    expect(
      recovered,
      `回${cycle} で live の音声へ戻らない (${RESTART_RECOVERY_TIMEOUT_MS} ms 待った): ` +
        summarizeSubscriber(after),
    ).not.toBeNull();
    // やり直しの後もサイン波のまま鳴っている (cache から配られた分を飛ばした境目だけ崩れてよい)
    expect(
      after.audio.playoutCatchUp.catchingUp,
      `回${cycle} で追いつきが続いている: ${summarizeSubscriber(after)}`,
    ).toBe(false);
    expect(
      after.warnings.length,
      `回${cycle} で警告が出ている: ${summarizeSubscriber(after)}`,
    ).toBe(0);
  }
  console.log(`購読のやり直しの繰り返し:\n  ${report.join("\n  ")}`);
});

test("長時間の配信で、送信の遅れと受信の遅れが悪化しない", async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace);
  await waitForAudio(page);

  // 手元の実測 (2026-10-14) では、配信側の送信が 2.1 秒詰まり (maxSendLagMs)、受信側の
  // 追いつきが 3.2 秒を飛ばし、A/V の基準が共有されないまま残った。時間とともに遅れが
  // 育つのか、途中で詰まるのかを、1 秒ごとに観測して見る
  const series: string[] = [];
  let worstSendLagMs = 0;
  let worstReceiveDelayMs = 0;
  const endMs = Date.now() + SOAK_MS;
  while (Date.now() < endMs) {
    const publisher = await readPublisher(page);
    const subscriber = await readSubscriber(page);
    worstSendLagMs = Math.max(worstSendLagMs, publisher.audio.catchUp.maxSendLagMs ?? 0);
    worstReceiveDelayMs = Math.max(worstReceiveDelayMs, subscriber.audio.maxReceiveDelayMs);
    series.push(
      `t=${((Date.now() - (endMs - SOAK_MS)) / 1000).toFixed(0)}s` +
        ` sendLag=${publisher.audio.catchUp.sendLagMs === null ? "-" : publisher.audio.catchUp.sendLagMs.toFixed(0)}` +
        `/max=${publisher.audio.catchUp.maxSendLagMs === null ? "-" : publisher.audio.catchUp.maxSendLagMs.toFixed(0)}` +
        `/queue=${publisher.audio.catchUp.sendQueueMs.toFixed(0)}` +
        `/obj=${publisher.audio.objectsSent}` +
        ` | recvDelay=${subscriber.audio.receiveDelayMs.toFixed(0)}` +
        `/max=${subscriber.audio.maxReceiveDelayMs.toFixed(0)}` +
        `/rebases=${subscriber.audio.playoutRebases}` +
        `/skip=${subscriber.audio.playoutCatchUp.skippedMs.toFixed(0)}` +
        `/missed=${subscriber.audio.playoutTiming.missedFrames}` +
        `/peak=${subscriber.audio.peakDbfs === null ? "-" : subscriber.audio.peakDbfs.toFixed(1)}`,
    );
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  const finalPublisher = await readPublisher(page);
  const finalSubscriber = await readSubscriber(page);
  console.log(
    `長時間の観測 (5 秒ごと):\n  ${series.filter((_, index) => index % 5 === 0).join("\n  ")}`,
  );
  const feedback = finalSubscriber.avSync.delays.audioDelayFeedback;
  console.log(
    `目標遅延の学習: target=${feedback.targetMs}, jitter=${feedback.jitterTargetMs}, ` +
      `applied=${feedback.appliedMs}, reason=${feedback.reason}, ceiling=${feedback.ceilingMs}, ` +
      `adjustments=${feedback.adjustments}, latenessP50=${feedback.latenessP50Ms}, ` +
      `startDelayP50=${feedback.startDelayP50Ms}, slackP50=${feedback.slackP50Ms}`,
  );
  console.log(
    `警告: ${finalSubscriber.warnings.map((warning) => JSON.stringify(warning)).join(", ")}`,
  );
  console.log(`配信側の棄却: droppedMs=${finalPublisher.audio.catchUp.droppedMs}`);
  console.log(
    `長時間の結果: 送った Object=${finalPublisher.audio.objectsSent}, ` +
      `送信の遅れの最大=${worstSendLagMs.toFixed(0)} ms, ` +
      `受信の遅れの最大=${worstReceiveDelayMs.toFixed(0)} ms, ` +
      `購読=${summarizeSubscriber(finalSubscriber)}`,
  );

  // 送信の遅れが育っていない (手元の実測は 2146 ms だった)
  expect(
    worstSendLagMs,
    `配信側の送信の遅れが大きい (最大 ${worstSendLagMs.toFixed(0)} ms)`,
  ).toBeLessThan(1_000);
  // 受信の遅れが育っていない (手元の実測は 2157 ms だった)
  expect(
    worstReceiveDelayMs,
    `受信の遅れが大きい (最大 ${worstReceiveDelayMs.toFixed(0)} ms)`,
  ).toBeLessThan(1_000);
  // 劣化操作 (時間圧縮と補間) が小さいこと。実測 (2026-10-14、60 秒) は、不感帯 20 ms で
  // 圧縮 796〜818 ms (60 秒の 1.4%。修正前は 2727 ms)、不感帯 10 ms で 1691〜1911 ms である。
  // ここは退行を止めるための上限であり、目標は 0 に近づけることである
  expect(
    finalSubscriber.audio.playoutCompressedMs,
    `受信側の時間圧縮が多い (60 秒で ${finalSubscriber.audio.playoutCompressedMs} ms。` +
      `声では粗さとして聞こえる)`,
  ).toBeLessThan(2_500);
  expect(
    finalSubscriber.audio.playoutConcealedMs,
    `受信側の補間が多い (${summarizeSubscriber(finalSubscriber)})`,
  ).toBeLessThan(200);
  // 鳴り始めの遅れが低いこと (実測 114 ms。目標遅延 100 ms に揃っている)
  expect(
    finalSubscriber.audio.playoutTiming.startDelayMs?.p50 ?? Number.POSITIVE_INFINITY,
    `鳴り始めの遅れが大きい (${summarizeSubscriber(finalSubscriber)})`,
  ).toBeLessThan(200);
  // 音を飛ばしていない
  expect(
    finalSubscriber.audio.playoutCatchUp.skippedMs,
    `受信側の追いつきが音を飛ばしている (${summarizeSubscriber(finalSubscriber)})`,
  ).toBeLessThan(500);
  // 基準の取り直しが無い
  expect(
    finalSubscriber.audio.playoutRebases,
    `受信側が基準を取り直している (${summarizeSubscriber(finalSubscriber)})`,
  ).toBe(0);
  // 前提から外れた状態が無い
  expect(
    finalSubscriber.warnings.length,
    `購読側に警告が出ている (${summarizeSubscriber(finalSubscriber)})`,
  ).toBe(0);
  expect(finalPublisher.warnings.length, "配信側に警告が出ている").toBe(0);
  // 配信側が劣化させた量。棄却は符号化の手前で音を飛ばすため、1 回ごとにクリックとして
  // 聞こえる (1 フレーム 8 ms を 20 ms のパケットの途中で捨てている)。60 秒で 1000 ms 未満を
  // 上限に置き、目標は 0 に近づけることである
  console.log(
    `配信側の劣化: droppedMs=${finalPublisher.audio.catchUp.droppedMs}, ` +
      `catchUpStarts=${finalPublisher.audio.catchUp.catchUpStarts}, ` +
      `catchingUp=${finalPublisher.audio.catchUp.catchingUp}`,
  );
  expect(
    finalPublisher.audio.catchUp.droppedMs,
    `配信側が捨てた音が多い (60 秒で ${finalPublisher.audio.catchUp.droppedMs} ms。` +
      `1 回ごとにクリックとして聞こえる)`,
  ).toBeLessThan(1_000);
  // 鳴り続けている
  expect(
    finalSubscriber.audio.peakDbfs ?? -100,
    `観測の最後で音が鳴っていない (${summarizeSubscriber(finalSubscriber)})`,
  ).toBeGreaterThan(AUDIBLE_PEAK_DBFS);
});
