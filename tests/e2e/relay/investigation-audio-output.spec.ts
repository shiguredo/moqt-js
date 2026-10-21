import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { loadavg } from "node:os";
import { join } from "node:path";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { RELAY_TEST_TIMEOUT_MS, createTestNamespace, requireRelayUri } from "./support";
import { DEVTOOLS_URL } from "../urls";

// 実リレー経由の「購読音声の出力波形」を収録する調査専用の spec である。
//
// 目的は、利用者が報告した 2 つの症状を波形として実測することである。
//
// - プチプチノイズ: 受信した音声の出力に、サンプルの不連続 (波形の飛び) やデジタル無音の
//   穴がどれくらい入るか
// - 最後が聞こえない: 配信側 / 購読側の停止操作の時刻に対して、最後に音が出たのはいつか。
//   予約済みで鳴らなかった音が何 ms 切り捨てられたか
//
// 値の判定はしない。計測した結果を investigation-logs/relay-2026-10-20/ へ書く。
// 測定の待ち時間 (1 テストあたり 60 秒以上) を CI へ持ち込まないため、
// `MOQT_INVESTIGATION=1` のときだけ動かす。既定では skip する。
//
// 動かし方 (docs/AUDIO_PLAYOUT_LATENCY.md の方法と同じく、devtools とテストページの
// webServer は playwright.config.ts が自動で起動する):
//
//   MOQT_INVESTIGATION=1 npx vp exec playwright test --project=relay \
//     tests/e2e/relay/investigation-audio-output.spec.ts
//
// 計測の仕組み:
//
// - 購読側 devtools の Subscriber は `AudioContext` を作り、`createMediaStreamDestination()`
//   のトラックを `<audio>` の `srcObject` にして鳴らす (devtools/src/hooks/useSubscriber.ts)。
//   この `AudioContext.prototype.createMediaStreamDestination` を addInitScript で包み、
//   返ってきた destination の stream から `createMediaStreamSource` で取り出して
//   AudioWorklet でサンプル列を集める。gain 0 で `context.destination` へ繋ぎ、処理を回す。
//   出力デバイスへは流さない (gain 0)。製品コードは変更しない。
// - 配信側 devtools の Publisher は `AudioEncoder.prototype.encode` を包み、符号化された
//   AudioData の timestamp / duration / 呼ばれた壁時計を記録する。停止時に capture されて
//   encode されなかった末尾 (未送信の末尾) を推定するためである。
// - 停止は 3 通りをそれぞれ別のテストで測る: publisher の stop-sending /
//   publisher の close-session / subscriber の Stop。
//
// 時間の対応付け:
//
// AudioWorklet のサンプルは 512 サンプルごとに main thread へ送られ、その到着時に
// `Date.now()` を記録する。Node 側の停止操作時刻も `Date.now()` であり、同じマシンの同じ
// 時計である。ただし出力デバイスへ出るまでに `AudioContext.outputLatency` (ヘッドレスでは
// 25 ms 前後) があるため、「耳に届いた時刻」は到着時刻にその分を足した値として扱う。
// 解析では両方 (足さない値 / 足した値) を出す。

/** 出力先 (このディレクトリは .gitignore に登録済み。生データはコミットしない) */
const OUTPUT_DIR = join(process.cwd(), "investigation-logs", "relay-2026-10-20");

/** 連続収録の長さ (秒)。MOQT_INVESTIGATION_SECONDS で変えられる */
const CAPTURE_SECONDS = Number(process.env.MOQT_INVESTIGATION_SECONDS ?? "60");

/** 停止前の定常状態を収録する長さ (秒) */
const STOP_STEADY_SECONDS = Number(process.env.MOQT_INVESTIGATION_STOP_STEADY_SECONDS ?? "12");

/** 停止操作の後に収録を続ける長さ (秒) */
const STOP_AFTER_SECONDS = 5;

/** 停止操作の後に購読者の統計を読む間隔 (ミリ秒) */
const STOP_POLL_MS = 250;

/** 統計を採る間隔 (ミリ秒) */
const STATS_INTERVAL_MS = 500;

/** 音声の Object が届いて鳴り始めるまでに待つ上限 (ミリ秒) */
const AUDIO_ARRIVAL_TIMEOUT_MS = 30_000;

/** AudioWorklet のタップが使えるようになるまで待つ上限 (ミリ秒) */
const TAP_READY_TIMEOUT_MS = 10_000;

/** pcm を 1 回の evaluate で取り出すサンプル数 (5 秒分) */
const PCM_BATCH_SAMPLES = 240_000;

test.use({
  // 音声の再生と出力を実時間で回す。ヘッドレスの既定のまま使う
  // (偽マイクは使わない。配信側は devtools のダミー音声 = 440 Hz 正弦波)
  launchOptions: {
    channel: "chromium",
  },
});

/** ページ側のタップ状態 (window.__moqtAudioTap) の型 */
interface PageTap {
  id: number;
  ready: boolean;
  error: string | null;
  active: boolean;
  sampleRate: number;
  chunks: number;
  chunkMeta: {
    startFrame: number;
    length: number;
    audioClockMs: number;
    wallMs: number;
  }[];
  inputChannelCount: number | null;
  outputLatencyMs: number | null;
  baseLatencyMs: number | null;
  contextState: string | null;
  activatedAtMs: number | null;
}

/** ページから取り出したタップの中身 */
interface TapCapture {
  tap: PageTap;
  pcm: Buffer;
  totalSamples: number;
}

/**
 * 購読側の音声出力を AudioWorklet でタップする仕込みを入れる (ページを開く前に呼ぶ)
 *
 * `AudioContext.prototype.createMediaStreamDestination` を包み、作られた destination の
 * stream から AudioWorklet でサンプル列を集める。製品コードには手を入れない。
 * 複数の AudioContext が作られる (配信側のダミー音声と購読側の再生) ため、タップは
 * destination ごとに作り、どれを録るかは購読側の `<audio>` の srcObject で決める。
 */
async function installAudioOutputTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // AudioWorklet の処理 (文字列から Blob URL を作って addModule する)
    //
    // 512 サンプル (48 kHz で 10.7 ms) ごとに main thread へ送る。これより大きくすると
    // AudioContext を閉じたときにバッファに残って失われる末尾が増え、停止時の切り捨てを
    // 測れなくなる。小さすぎると main thread のメッセージ処理が増えて計測を歪める。
    const TAP_PROCESSOR_SOURCE = `
      class MoqtTapProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.chunk = new Float32Array(512);
          this.filled = 0;
          this.framesSeen = 0;
        }
        flush() {
          if (this.filled === 0) return;
          const samples = this.chunk.slice(0, this.filled);
          this.port.postMessage({
            audioClockMs: currentTime * 1000,
            startFrame: this.framesSeen - this.filled,
            samples,
          }, [samples.buffer]);
          this.filled = 0;
        }
        process(inputs) {
          const mono = inputs[0] && inputs[0][0];
          if (!mono) return true;
          for (let index = 0; index < mono.length; index += 1) {
            if (this.filled === this.chunk.length) this.flush();
            this.chunk[this.filled] = mono[index];
            this.filled += 1;
          }
          this.framesSeen += mono.length;
          return true;
        }
      }
      registerProcessor("moqt-audio-tap", MoqtTapProcessor);
    `;

    interface Tap {
      id: number;
      context: AudioContext;
      destination: MediaStreamAudioDestinationNode;
      node: AudioWorkletNode | null;
      gain: GainNode | null;
      ready: boolean;
      error: string | null;
      active: boolean;
      sampleRate: number;
      inputChannelCount: number | null;
      chunks: { startFrame: number; samples: Float32Array }[];
      chunkMeta: { startFrame: number; length: number; audioClockMs: number; wallMs: number }[];
      activatedAtMs: number | null;
      concat: Float32Array | null;
    }

    const state: { taps: Tap[] } = { taps: [] };
    (window as unknown as { __moqtAudioTap: { taps: Tap[]; take(): unknown } }).__moqtAudioTap = {
      taps: state.taps,
      take: () => undefined,
    };

    /** タップを 1 つ作る (destination ごと) */
    const createTap = (
      context: AudioContext,
      destination: MediaStreamAudioDestinationNode,
    ): void => {
      const tap: Tap = {
        id: state.taps.length,
        context,
        destination,
        node: null,
        gain: null,
        ready: false,
        error: null,
        active: false,
        sampleRate: context.sampleRate,
        inputChannelCount: null,
        chunks: [],
        chunkMeta: [],
        activatedAtMs: null,
        concat: null,
      };
      state.taps.push(tap);
      const sourceUrl = URL.createObjectURL(
        new Blob([TAP_PROCESSOR_SOURCE], { type: "application/javascript" }),
      );
      context.audioWorklet
        .addModule(sourceUrl)
        .then(() => {
          URL.revokeObjectURL(sourceUrl);
          // MediaStreamAudioDestinationNode の出力を同じ context へ戻す。直接 destination へ
          // 繋ぐと音が二重になるため、gain 0 を挟んで処理だけを回す
          const source = context.createMediaStreamSource(destination.stream);
          const node = new AudioWorkletNode(context, "moqt-audio-tap", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
          });
          const gain = context.createGain();
          gain.gain.value = 0;
          source.connect(node);
          node.connect(gain);
          gain.connect(context.destination);
          node.port.onmessage = (event: MessageEvent) => {
            const data = event.data as {
              audioClockMs: number;
              startFrame: number;
              samples: Float32Array;
            };
            if (!tap.active) {
              return;
            }
            tap.chunks.push({ startFrame: data.startFrame, samples: data.samples });
            tap.chunkMeta.push({
              startFrame: data.startFrame,
              length: data.samples.length,
              audioClockMs: data.audioClockMs,
              // main thread が受け取った時刻。サンプルが処理された直後の値である
              wallMs: Date.now(),
            });
          };
          tap.node = node;
          tap.gain = gain;
          tap.ready = true;
        })
        .catch((error: unknown) => {
          tap.error = error instanceof Error ? error.message : String(error);
        });
    };

    // AudioContext.prototype.createMediaStreamDestination を包む。メソッドの参照をそのまま
    // 保持すると this を失うため、上書きする前にプロパティ記述子から元の実装を取り出す
    const originalCreateDescriptor = Object.getOwnPropertyDescriptor(
      AudioContext.prototype,
      "createMediaStreamDestination",
    );
    const originalCreate = originalCreateDescriptor?.value as
      | ((this: AudioContext) => MediaStreamAudioDestinationNode)
      | undefined;
    if (originalCreate === undefined) {
      throw new Error("createMediaStreamDestination is not available");
    }
    AudioContext.prototype.createMediaStreamDestination = function createMediaStreamDestination(
      this: AudioContext,
    ): MediaStreamAudioDestinationNode {
      const destination = originalCreate.call(this);
      createTap(this, destination);
      return destination;
    };
  });
}

/** 配信側の AudioEncoder.encode を包み、符号化された末尾を記録する仕込みを入れる */
async function installPublisherEncodeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (typeof AudioEncoder === "undefined") {
      return;
    }
    const state = {
      encodeCalls: 0,
      encodedFrames: 0,
      firstTimestampUs: null as number | null,
      lastTimestampUs: null as number | null,
      lastDurationUs: null as number | null,
      lastNumberOfFrames: null as number | null,
      firstEncodeWallMs: null as number | null,
      lastEncodeWallMs: null as number | null,
      encodedMs: 0,
    };
    (window as unknown as { __moqtEncodeProbe: typeof state }).__moqtEncodeProbe = state;
    // 元の実装はプロパティ記述子から取り出す (メソッドの参照を保持すると this を失う)
    const originalEncodeDescriptor = Object.getOwnPropertyDescriptor(
      AudioEncoder.prototype,
      "encode",
    );
    const originalEncode = originalEncodeDescriptor?.value as
      | ((this: AudioEncoder, data: AudioData) => void)
      | undefined;
    if (originalEncode === undefined) {
      return;
    }
    AudioEncoder.prototype.encode = function encode(this: AudioEncoder, data: AudioData): void {
      const wallMs = Date.now();
      state.encodeCalls += 1;
      const numberOfFrames = data.numberOfFrames;
      if (typeof numberOfFrames === "number") {
        state.encodedFrames += numberOfFrames;
      }
      state.firstEncodeWallMs ??= wallMs;
      state.lastEncodeWallMs = wallMs;
      state.firstTimestampUs ??= data.timestamp;
      state.lastTimestampUs = data.timestamp;
      state.lastDurationUs = data.duration;
      state.lastNumberOfFrames = numberOfFrames ?? null;
      if (typeof data.duration === "number") {
        state.encodedMs += data.duration / 1000;
      }
      return originalEncode.call(this, data);
    };
  });
}

/** 購読側の `<audio>` に繋がっているタップを有効にし、準備できるまで待つ */
async function activateSubscriberTap(page: Page): Promise<PageTap> {
  // 再生用の stream と一致するタップを有効にする。タップは AudioContext が作られるたびに
  // できるため、<audio> の srcObject と destination.stream の同一性で選ぶ
  await page.evaluate(() => {
    interface TapLike {
      destination: MediaStreamAudioDestinationNode;
      active: boolean;
      activatedAtMs: number | null;
      chunks: unknown[];
      chunkMeta: unknown[];
      concat: unknown;
    }
    const state = (window as unknown as { __moqtAudioTap: { taps: TapLike[] } }).__moqtAudioTap;
    const element = document.querySelector<HTMLAudioElement>(
      '[data-testid="subscriber-audio-element"]',
    );
    const stream = element?.srcObject;
    if (!(stream instanceof MediaStream)) {
      throw new Error("subscriber audio element has no MediaStream");
    }
    const tap = state.taps.find((candidate) => candidate.destination.stream === stream);
    if (tap === undefined) {
      throw new Error("no audio tap for subscriber playback stream");
    }
    tap.chunks = [];
    tap.chunkMeta = [];
    tap.concat = null;
    tap.active = true;
    tap.activatedAtMs = Date.now();
  });
  // AudioWorklet の addModule が終わるまで待つ (終わっていないとサンプルが欠ける)
  const startedAtMs = Date.now();
  for (;;) {
    const tap = await readTapSummary(page);
    if (tap.ready) {
      return tap;
    }
    if (tap.error !== null) {
      throw new Error(`audio tap could not be installed: ${tap.error}`);
    }
    if (Date.now() - startedAtMs > TAP_READY_TIMEOUT_MS) {
      throw new Error(`audio tap was not ready within ${String(TAP_READY_TIMEOUT_MS)} ms`);
    }
    await page.waitForTimeout(100);
  }
}

/** タップの要約を読む (サンプル列は含めない) */
async function readTapSummary(page: Page): Promise<PageTap> {
  return page.evaluate(() => {
    interface TapLike {
      id: number;
      ready: boolean;
      error: string | null;
      active: boolean;
      sampleRate: number;
      chunks: unknown[];
      chunkMeta: { startFrame: number; length: number; audioClockMs: number; wallMs: number }[];
      inputChannelCount: number | null;
      outputLatencyMs: number | null;
      baseLatencyMs: number | null;
      contextState: string | null;
      activatedAtMs: number | null;
      context: AudioContext;
    }
    const state = (window as unknown as { __moqtAudioTap: { taps: TapLike[] } }).__moqtAudioTap;
    const tap = state.taps.find((candidate) => candidate.active);
    if (tap === undefined) {
      throw new Error("no active audio tap");
    }
    return {
      id: tap.id,
      ready: tap.ready,
      error: tap.error,
      active: tap.active,
      sampleRate: tap.sampleRate,
      chunks: tap.chunks.length,
      chunkMeta: tap.chunkMeta.map((meta) => ({ ...meta })),
      inputChannelCount: tap.inputChannelCount,
      outputLatencyMs: tap.context.outputLatency * 1000,
      baseLatencyMs: tap.context.baseLatency * 1000,
      contextState: tap.context.state,
      activatedAtMs: tap.activatedAtMs,
    };
  });
}

/** タップに溜まったサンプル列を 1 本の Float32Array にまとめてページ側へ置く */
async function concatTapSamples(page: Page): Promise<{ totalSamples: number; sampleRate: number }> {
  return page.evaluate(() => {
    interface TapLike {
      chunks: { startFrame: number; samples: Float32Array }[];
      concat: Float32Array | null;
      sampleRate: number;
      active: boolean;
    }
    const state = (window as unknown as { __moqtAudioTap: { taps: TapLike[] } }).__moqtAudioTap;
    const tap = state.taps.find((candidate) => candidate.active);
    if (tap === undefined) {
      throw new Error("no active audio tap");
    }
    let total = 0;
    for (const chunk of tap.chunks) {
      total += chunk.samples.length;
    }
    const concat = new Float32Array(total);
    let offset = 0;
    for (const chunk of tap.chunks) {
      concat.set(chunk.samples, offset);
      offset += chunk.samples.length;
    }
    tap.concat = concat;
    return { totalSamples: total, sampleRate: tap.sampleRate };
  });
}

/** まとめたサンプル列の一部を base64 の Float32 (little endian) で取り出す */
async function readTapPcmRange(page: Page, offset: number, count: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    (range: { offset: number; count: number }) => {
      interface TapLike {
        concat: Float32Array | null;
        active: boolean;
      }
      const state = (window as unknown as { __moqtAudioTap: { taps: TapLike[] } }).__moqtAudioTap;
      const tap = state.taps.find((candidate) => candidate.active);
      if (tap === undefined || tap.concat === null) {
        throw new Error("no concatenated audio tap samples");
      }
      const slice = tap.concat.subarray(range.offset, range.offset + range.count);
      const bytes = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
      let binary = "";
      const step = 0x8000;
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(index, Math.min(index + step, bytes.length))),
        );
      }
      return btoa(binary);
    },
    { offset, count },
  );
  return Buffer.from(base64, "base64");
}

/** タップのサンプル列を全部取り出し、Float32 の生データとして返す */
async function collectTapCapture(page: Page): Promise<TapCapture> {
  const meta = await readTapSummary(page);
  const { totalSamples } = await concatTapSamples(page);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < totalSamples; offset += PCM_BATCH_SAMPLES) {
    const count = Math.min(PCM_BATCH_SAMPLES, totalSamples - offset);
    parts.push(await readTapPcmRange(page, offset, count));
  }
  return {
    tap: { ...meta, chunks: meta.chunkMeta.length },
    pcm: Buffer.concat(parts),
    totalSamples,
  };
}

/** 16 bit PCM モノラルの WAV を組み立てる */
function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  // Float32 (little endian) の生データを 16 bit PCM へ変換する
  const frames = Math.floor(pcm.length / 4);
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // モノラル
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    const value = pcm.readFloatLE(index * 4);
    const clamped = Math.max(-1, Math.min(1, value));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
  }
  return buffer;
}

/** 生データ (Float32) と WAV を書く */
function writeCapture(name: string, capture: TapCapture): void {
  writeFileSync(join(OUTPUT_DIR, `${name}.f32.raw`), capture.pcm);
  writeFileSync(join(OUTPUT_DIR, `${name}.wav`), buildWav(capture.pcm, capture.tap.sampleRate));
}

/** 購読側の統計から計測に使う値だけを取り出す */
async function readStats(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    interface Api {
      getPublisher(): {
        status: string;
        statusMessage: string;
        framesEncoded: number;
        chunksEncoded: number;
        objectsSent: number;
        audio: {
          objectsSent: number;
          chunksEncoded: number;
          datagramObjectsSent: number;
          encodeErrors: number;
          publishing: boolean;
        };
      };
      getSubscribers(): {
        id: string;
        status: string;
        statusMessage: string;
        audio: {
          objectsReceived: number;
          datagramObjectsReceived: number;
          chunksDecoded: number;
          playbackEnabled: boolean;
          playoutCompressedMs: number;
          playoutConcealedMs: number;
          playoutConcealments: number;
          playoutDrops: number;
          playoutRebases: number;
          playoutTiming: {
            playedFrames: number;
            playedMs: number;
            missedFrames: number;
            missedMs: number;
            missedByReason: Record<string, { count: number; ms: number }>;
            stretchUnavailableFrames: number;
            startDelayMs: { p50: number | null; p95: number | null; max: number | null } | null;
            slackMs: { p50: number | null; p95: number | null; max: number | null } | null;
            latenessMs: { p50: number | null; p95: number | null; max: number | null } | null;
          };
          playoutCatchUp: {
            catchUpStarts: number;
            catchingUp: boolean;
            lagMs: number;
            floorMs: number;
            maxLagMs: number;
            skippedMs: number;
          };
        };
        avSync: {
          skewMs: number | null;
          delays: {
            audio: {
              baseDelayMs: number | null;
              jitterDelayMs: number | null;
              syncExtraDelayMs: number;
              presentationDelayMs: number | null;
            };
            video: {
              baseDelayMs: number | null;
              jitterDelayMs: number | null;
              syncExtraDelayMs: number;
              presentationDelayMs: number | null;
            };
            audioDelayFeedback: {
              targetMs: number;
              jitterTargetMs: number;
              appliedMs: number;
              reason: string;
            };
          };
        };
      }[];
    }
    const api = (window as unknown as { moqtDevTools: Api }).moqtDevTools;
    const publisher = api.getPublisher();
    const subscriber = api.getSubscribers()[0];
    return {
      publisher: {
        status: publisher.status,
        statusMessage: publisher.statusMessage,
        framesEncoded: publisher.framesEncoded,
        chunksEncoded: publisher.chunksEncoded,
        objectsSent: publisher.objectsSent,
        audio: publisher.audio,
      },
      subscriber:
        subscriber === undefined
          ? null
          : {
              id: subscriber.id,
              status: subscriber.status,
              statusMessage: subscriber.statusMessage,
              audio: subscriber.audio,
              avSync: subscriber.avSync,
            },
    };
  });
}

/** 統計を一定間隔で採り続け、配列に積む */
async function sampleStats(
  page: Page,
  seconds: number,
  samples: { wallMs: number; stats: unknown }[],
): Promise<void> {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < seconds * 1_000) {
    samples.push({ wallMs: Date.now(), stats: await readStats(page) });
    await page.waitForTimeout(STATS_INTERVAL_MS);
  }
}

/** 実行環境の条件 (時刻・load average・リレーのホスト名) を記録する */
function environmentInfo(moqtUri: string): Record<string, unknown> {
  // URI にはトークンが入り得るため、ホスト名だけを残す
  const host = (() => {
    try {
      return new URL(moqtUri).hostname;
    } catch {
      return "unknown";
    }
  })();
  return {
    startedAt: new Date().toISOString(),
    node: hostname(),
    loadAverage: loadavg(),
    relayHost: host,
    captureSeconds: CAPTURE_SECONDS,
    stopSteadySeconds: STOP_STEADY_SECONDS,
    stopAfterSeconds: STOP_AFTER_SECONDS,
  };
}

/** 配信と購読を始める (both モードの devtools ページ) */
async function startBoth(
  page: Page,
  moqtUri: string,
  namespace: string,
  publishStop: string,
  extraParams?: Record<string, string>,
): Promise<void> {
  const params = new URLSearchParams({
    url: moqtUri,
    namespace,
    mode: "both",
    // ヘッドレスの Chromium で符号化できるコーデックにする (既定は vp9)
    codec: "vp8",
    resolution: "640x360",
    bitrate: "1000000",
    // 配信側は 440 Hz の正弦波 (+ 2 秒周期の振幅エンベロープ) を作るダミー音声にする
    audioSource: "dummy",
    audioSampleRate: "48000",
    audioChannels: "2",
    // 購読側は音声を鳴らし、jitter buffer を有効にする (どちらも既定だが明示する)
    playAudio: "1",
    jitterBuffer: "1",
    publishStop,
  });
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    params.set(key, value);
  }
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await expect(page.getByTestId("moqt-uri")).toHaveValue(moqtUri);
  await expect(page.getByTestId("publisher-stop-mode")).toHaveValue(publishStop);

  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const stats = (await readStats(page)) as {
          publisher: { audio: { objectsSent: number } };
        };
        return stats.publisher.audio.objectsSent;
      },
      { message: "配信側が音声 Object を送り始めるのを待つ", timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  await page.getByTestId("subscriber-subscribe-button").click();

  // 受信した音声の再生を有効にする。トグルの aria-pressed が有効状態を表す
  // (押すと停止になるため、無効なときだけ押す)
  const toggle = page.getByTestId("subscriber-audio-playback-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
}

/** 音声が届いて復号・再生が始まるまで待つ */
async function waitForAudio(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = (await readStats(page)) as {
          subscriber: { audio: { playbackEnabled: boolean; chunksDecoded: number } } | null;
        };
        const audio = stats.subscriber?.audio;
        return audio !== undefined && audio.playbackEnabled && audio.chunksDecoded > 20;
      },
      { message: "購読側が音声を復号して鳴らし始めるのを待つ", timeout: AUDIO_ARRIVAL_TIMEOUT_MS },
    )
    .toBe(true);
}

/** 配信側の encode 計器を読む */
async function readEncodeProbe(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    return (window as unknown as { __moqtEncodeProbe?: unknown }).__moqtEncodeProbe ?? null;
  });
}

/** 実行環境の情報をファイルへ書く (最初のテストの前に 1 回) */
function writeEnvironment(moqtUri: string): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const info = environmentInfo(moqtUri);
  writeFileSync(join(OUTPUT_DIR, "environment.json"), `${JSON.stringify(info, null, 2)}\n`);
  console.log(
    `計測の条件: 開始 ${String(info.startedAt)}, load average ${JSON.stringify(info.loadAverage)}, ` +
      `リレー ${String(info.relayHost)}, 収録 ${String(CAPTURE_SECONDS)} 秒`,
  );
}

// 連続収録: 停止しない状態の出力波形を 60 秒採る。プチプチノイズ (サンプルの不連続・
// デジタル無音の穴) を波形から数えるための生データになる。判定はしない
test("調査: 購読音声の出力波形を連続収録する", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 6);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);

  await installAudioOutputTap(page);
  await installPublisherEncodeProbe(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace, "publish-done");
  await waitForAudio(page);
  const tapInfo = await activateSubscriberTap(page);
  // タップの node が繋がってから採る (最初の数 ms は捨てる)
  await page.waitForTimeout(500);
  console.log(
    `タップを有効にした: sampleRate=${String(tapInfo.sampleRate)}, outputLatency=${String(tapInfo.outputLatencyMs)} ms`,
  );

  const statsSamples: { wallMs: number; stats: unknown }[] = [];
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < CAPTURE_SECONDS * 1_000) {
    statsSamples.push({ wallMs: Date.now(), stats: await readStats(page) });
    await page.waitForTimeout(STATS_INTERVAL_MS);
  }

  const capture = await collectTapCapture(page);
  const encodeProbe = await readEncodeProbe(page);
  writeCapture("capture-continuous", capture);
  writeFileSync(
    join(OUTPUT_DIR, "capture-continuous.json"),
    `${JSON.stringify(
      {
        // 収録の開始 (最初のサンプル) と終了 (最後のサンプル) の壁時計
        firstChunkWallMs: capture.tap.chunkMeta[0]?.wallMs ?? null,
        lastChunkWallMs: capture.tap.chunkMeta[capture.tap.chunkMeta.length - 1]?.wallMs ?? null,
        captureWallSeconds: (Date.now() - startedAtMs) / 1_000,
        tap: capture.tap,
        totalSamples: capture.totalSamples,
        encodeProbe,
        statsSamples,
      },
      null,
      0,
    )}\n`,
  );
  console.log(
    `連続収録を書いた: ${String(capture.totalSamples)} サンプル / ${String(capture.tap.sampleRate)} Hz ` +
      `(${(capture.totalSamples / capture.tap.sampleRate).toFixed(2)} 秒), チャンク ${String(capture.tap.chunks)} 個`,
  );
});

/** 停止 3 通りの共通処理: 定常状態を収録し、停止操作をまたいで末尾を収録する */
async function runStopMeasurement(
  page: Page,
  moqtUri: string,
  stopMode: "stop-sending" | "close-session" | "subscriber-stop",
): Promise<void> {
  // close-session と stop-sending は publisher の Stop の止め方を URL で決める
  const publishStop = stopMode === "subscriber-stop" ? "publish-done" : stopMode;
  await installAudioOutputTap(page);
  await installPublisherEncodeProbe(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  await startBoth(page, moqtUri, namespace, publishStop);
  await waitForAudio(page);
  await activateSubscriberTap(page);
  await page.waitForTimeout(500);

  // 停止前の定常状態
  const statsSamples: { wallMs: number; stats: unknown }[] = [];
  await sampleStats(page, STOP_STEADY_SECONDS, statsSamples);
  const beforeStop = await readStats(page);

  // 停止操作。date は Node の時計で、ページの Date.now と同じマシンの時計である
  const stopTarget =
    stopMode === "subscriber-stop"
      ? page.getByTestId("subscriber-stop-button")
      : page.getByTestId("publisher-stop-button");
  await expect(stopTarget).toBeEnabled();
  // 最後の encode などを stop の直前に読んでおく
  const encodeBeforeStop = await readEncodeProbe(page);
  const stopClickAtMs = Date.now();
  await stopTarget.click();
  const stopClickDoneMs = Date.now();

  // 停止の直後から統計を細かく採る (切断と recordStopped の反映を待つ)
  const afterSamples: { wallMs: number; stats: unknown }[] = [];
  const afterStartedAtMs = Date.now();
  while (Date.now() - afterStartedAtMs < STOP_AFTER_SECONDS * 1_000) {
    afterSamples.push({ wallMs: Date.now(), stats: await readStats(page) });
    await page.waitForTimeout(STOP_POLL_MS);
  }
  const afterStop = await readStats(page);
  const encodeAfterStop = await readEncodeProbe(page);

  const capture = await collectTapCapture(page);
  writeCapture(`stop-${stopMode}`, capture);
  writeFileSync(
    join(OUTPUT_DIR, `stop-${stopMode}.json`),
    `${JSON.stringify(
      {
        stopMode,
        stopClickAtMs,
        stopClickDoneMs,
        firstChunkWallMs: capture.tap.chunkMeta[0]?.wallMs ?? null,
        lastChunkWallMs: capture.tap.chunkMeta[capture.tap.chunkMeta.length - 1]?.wallMs ?? null,
        tap: capture.tap,
        totalSamples: capture.totalSamples,
        steadySeconds: STOP_STEADY_SECONDS,
        encodeBeforeStop,
        encodeAfterStop,
        beforeStop,
        afterStop,
        statsSamples,
        afterSamples,
      },
      null,
      0,
    )}\n`,
  );
  const afterSubscriber = (
    afterStop as {
      subscriber: {
        audio: { playoutTiming: { missedByReason: Record<string, { count: number; ms: number }> } };
      } | null;
    }
  ).subscriber;
  console.log(
    `停止 ${stopMode}: 最後のチャンク ${String(capture.tap.chunkMeta[capture.tap.chunkMeta.length - 1]?.wallMs ?? null)} ms, ` +
      `停止操作 ${String(stopClickAtMs)} ms, 予約済みで鳴らなかった音 ` +
      JSON.stringify(afterSubscriber?.audio.playoutTiming.missedByReason ?? null),
  );
}

// publisher の Stop で「何も送らずに配信だけ止める」場合。セッションは開いたまま残る
test("調査: publisher の stop-sending で末尾がどう切れるかを測る", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);
  await runStopMeasurement(page, moqtUri, "stop-sending");
});

// publisher の Stop で PUBLISH_DONE を送らずにセッションを閉じる場合
test("調査: publisher の close-session で末尾がどう切れるかを測る", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);
  await runStopMeasurement(page, moqtUri, "close-session");
});

// 購読側の Stop の場合。予約済みで未再生の音が AudioContext の close で切り捨てられる
test("調査: 購読側の Stop で末尾がどう切れるかを測る", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);
  await runStopMeasurement(page, moqtUri, "subscriber-stop");
});

/** 購読側 Stop の 1 回分の観測 (Lead 依頼: 切断量と目標遅延) */
interface SubscriberStopRecord {
  round: number;
  stopClickAtMs: number;
  stopClickDoneMs: number;
  /** Stop の完了 (status が disconnected になった) までの時間 (ミリ秒) */
  stopDurationMs: number;
  beforeStop: unknown;
  afterStop: unknown;
  /** 停止直前の目標遅延 (appliedMs / feedbackTargetMs / jitterTargetMs) */
  targetBefore: unknown;
  /** 停止直前後で増えた「予約済みで鳴らなかった音」 */
  stoppedAdded: { count: number; ms: number };
  /** 停止時の missedMs / playedMs */
  missedMs: { before: number | null; after: number | null };
  playedMs: { before: number | null; after: number | null };
  /** drain の結果 (鳴らせた量・切った量・待ち時間・flush 件数) */
  lastDrain: unknown;
}

// Lead 依頼 1: 購読側 Stop で切られる「予約済みで鳴らなかった音」を 3 回測る。
// 20 秒受信してから Stop を押し、停止直前の目標遅延と、直後の missedByReason.stopped /
// missedMs / playedMs を採る。値の判定はしない。
test("調査: 購読側の Stop の切断量を 3 回測る", async ({ browser }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 8);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);

  const records: SubscriberStopRecord[] = [];
  for (let round = 1; round <= 3; round += 1) {
    const page = await browser.newPage();
    try {
      await installAudioOutputTap(page);
      const namespace = formatTrackNamespace(createTestNamespace());
      await startBoth(page, moqtUri, namespace, "publish-done");
      await waitForAudio(page);
      await activateSubscriberTap(page);
      // 20 秒受信する (タップの有効化直後の過渡を除いてから 20 秒)
      await page.waitForTimeout(1_000);
      const steadyStartedAtMs = Date.now();
      while (Date.now() - steadyStartedAtMs < 20_000) {
        await page.waitForTimeout(1_000);
      }
      const beforeStop = await readStats(page);
      const stopClickAtMs = Date.now();
      await page.getByTestId("subscriber-stop-button").click();
      const stopClickDoneMs = Date.now();
      // drain を含む停止の完了を待つ (status が disconnected になるまで)
      const stopWaitStartedAtMs = Date.now();
      let stopCompletedAtMs = stopWaitStartedAtMs;
      for (;;) {
        const subscriber = (
          (await readStats(page)) as {
            subscriber: { status: string; statusMessage: string } | null;
          }
        ).subscriber;
        // 停止の完了は statusMessage が "Ready to subscribe" に戻った時点である。
        // status は停止の入口で "disconnected" になるため完了の判定には使えない
        if (subscriber === null || subscriber.statusMessage === "Ready to subscribe") {
          stopCompletedAtMs = Date.now();
          break;
        }
        if (Date.now() - stopWaitStartedAtMs > 5_000) {
          stopCompletedAtMs = Date.now();
          break;
        }
        await page.waitForTimeout(20);
      }
      const stopDurationMs = stopCompletedAtMs - stopClickAtMs;
      // teardown の unsubscribe と recordStopped の反映を待つ
      await page.waitForTimeout(1_500);
      const afterStop = await readStats(page);

      const beforeSubscriber = (
        beforeStop as {
          subscriber: {
            audio: {
              playoutTiming: { missedMs: number; playedMs: number };
            };
            avSync: { delays: { audioDelayFeedback: unknown } };
          } | null;
        }
      ).subscriber;
      const afterSubscriber = (
        afterStop as {
          subscriber: {
            audio: {
              playoutTiming: {
                missedMs: number;
                playedMs: number;
                missedByReason: Record<string, { count: number; ms: number }>;
                lastDrain: unknown;
              };
            };
          } | null;
        }
      ).subscriber;
      const stoppedBefore = beforeSubscriber?.audio.playoutTiming.missedMs ?? 0;
      const stoppedAfter = afterSubscriber?.audio.playoutTiming.missedMs ?? 0;
      const record: SubscriberStopRecord = {
        round,
        stopClickAtMs,
        stopClickDoneMs,
        stopDurationMs,
        beforeStop,
        afterStop,
        targetBefore: beforeSubscriber?.avSync.delays.audioDelayFeedback ?? null,
        stoppedAdded: {
          count:
            (afterSubscriber?.audio.playoutTiming.missedByReason.stopped.count ?? 0) -
            (
              beforeStop as {
                subscriber: {
                  audio: { playoutTiming: { missedByReason: Record<string, { count: number }> } };
                };
              }
            ).subscriber.audio.playoutTiming.missedByReason.stopped.count,
          ms:
            (afterSubscriber?.audio.playoutTiming.missedByReason.stopped.ms ?? 0) -
            (
              beforeStop as {
                subscriber: {
                  audio: { playoutTiming: { missedByReason: Record<string, { ms: number }> } };
                };
              }
            ).subscriber.audio.playoutTiming.missedByReason.stopped.ms,
        },
        missedMs: {
          before: beforeSubscriber?.audio.playoutTiming.missedMs ?? null,
          after: afterSubscriber?.audio.playoutTiming.missedMs ?? null,
        },
        playedMs: {
          before: beforeSubscriber?.audio.playoutTiming.playedMs ?? null,
          after: afterSubscriber?.audio.playoutTiming.playedMs ?? null,
        },
        lastDrain: afterSubscriber?.audio.playoutTiming.lastDrain ?? null,
      };
      records.push(record);
      console.log(
        `購読側 Stop ${String(round)} 回目: 完了まで ${stopDurationMs.toFixed(0)} ms / ` +
          `目標遅延 applied=${String((record.targetBefore as { appliedMs: number } | null)?.appliedMs)} ms / ` +
          `jitterTarget=${String((record.targetBefore as { jitterTargetMs: number } | null)?.jitterTargetMs)} ms, ` +
          `予約済みで鳴らなかった音 ${String(record.stoppedAdded.count)} 件 / ${record.stoppedAdded.ms.toFixed(1)} ms, ` +
          `lastDrain=${JSON.stringify(record.lastDrain)}, ` +
          `missedMs ${String(record.missedMs.before)} → ${String(record.missedMs.after)}, ` +
          `playedMs ${String(record.playedMs.before)} → ${String(record.playedMs.after)}`,
      );
      void stoppedBefore;
      void stoppedAfter;
    } finally {
      // 次回の計測に前のページの負荷を持ち越さない
      await page.context().close();
    }
  }

  writeFileSync(
    join(OUTPUT_DIR, "subscriber-stop-repeat.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`,
  );
});

// Lead 依頼: preDecodeDelayMs を指定した購読を停止したとき、復号前の段の保持分が
// flush され、drain の間 (最大 300 ms) 鳴ることを確かめる。停止で切られた量と lastDrain を
// 記録する。値の判定はしない。
test("調査: pre-decode 遅延ありで購読を止めたときの drain", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);
  await installAudioOutputTap(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  // 2 秒の復号前遅延。5 秒受信すると段に約 2 秒分の音声が保持されている
  await startBoth(page, moqtUri, namespace, "publish-done", { preDecodeDelayMs: "2000" });
  await waitForAudio(page);
  await activateSubscriberTap(page);
  await page.waitForTimeout(5_000);
  const beforeStop = await readStats(page);
  const stopClickAtMs = Date.now();
  await page.getByTestId("subscriber-stop-button").click();
  // drain を含む停止の完了を待つ (statusMessage が "Ready to subscribe" に戻るまで)
  const stopWaitStartedAtMs = Date.now();
  let stopCompletedAtMs = stopWaitStartedAtMs;
  for (;;) {
    const subscriber = (
      (await readStats(page)) as {
        subscriber: { status: string; statusMessage: string } | null;
      }
    ).subscriber;
    if (subscriber === null || subscriber.statusMessage === "Ready to subscribe") {
      stopCompletedAtMs = Date.now();
      break;
    }
    if (Date.now() - stopWaitStartedAtMs > 5_000) {
      stopCompletedAtMs = Date.now();
      break;
    }
    await page.waitForTimeout(20);
  }
  const stopDurationMs = stopCompletedAtMs - stopClickAtMs;
  await page.waitForTimeout(1_000);
  const afterStop = await readStats(page);
  const afterPlayoutTiming = (
    afterStop as {
      subscriber: { audio: { playoutTiming: unknown } } | null;
    }
  ).subscriber?.audio.playoutTiming;
  console.log(
    `pre-decode 遅延ありの Stop: 完了まで ${stopDurationMs.toFixed(0)} ms / ` +
      `playoutTiming=${JSON.stringify(afterPlayoutTiming)}`,
  );
  writeFileSync(
    join(OUTPUT_DIR, "subscriber-stop-predecode-delay.json"),
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), stopDurationMs, beforeStop, afterStop },
      null,
      2,
    )}\n`,
  );
});

// Lead 依頼: タップ経路の対照実験。ネットワークを介さず、同じ AudioContext の中で
// 440 Hz の連続音を MediaStreamAudioDestinationNode へ流し、同じ AudioWorklet タップで録る。
// ここで無音 (exact zero) や波形の飛びが出なければ、リレー収録の無音区間はタップ経路
// (MediaStreamAudioSourceNode のループバック) ではなく、鳴らす側の入力 (playout) の穴である。
test("調査: タップ経路の対照実験として連続 440 Hz を録る", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 2);
  await installAudioOutputTap(page);
  await page.goto(DEVTOOLS_URL);
  const started = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    // 包んだ createMediaStreamDestination がタップを作る
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    // ダミー音声と同じ振幅帯 (0.2〜0.3) にする
    const gain = context.createGain();
    gain.gain.value = 0.25;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    await context.resume();
    interface TapLike {
      destination: MediaStreamAudioDestinationNode;
      active: boolean;
      activatedAtMs: number | null;
      chunks: unknown[];
      chunkMeta: unknown[];
      concat: Float32Array | null;
    }
    const state = (window as unknown as { __moqtAudioTap: { taps: TapLike[] } }).__moqtAudioTap;
    const tap = state.taps.find((candidate) => candidate.destination.stream === destination.stream);
    if (tap === undefined) {
      throw new Error("no audio tap for control destination");
    }
    tap.chunks = [];
    tap.chunkMeta = [];
    tap.concat = null;
    tap.active = true;
    tap.activatedAtMs = Date.now();
    (window as unknown as { __controlOscillator: OscillatorNode }).__controlOscillator = oscillator;
    return { sampleRate: context.sampleRate, state: context.state };
  });
  console.log(
    `対照実験を始めた: sampleRate=${String(started.sampleRate)}, context.state=${started.state}`,
  );
  await page.waitForTimeout(15_000);
  const capture = await collectTapCapture(page);
  writeCapture("control-loopback", capture);
  writeFileSync(
    join(OUTPUT_DIR, "control-loopback.json"),
    `${JSON.stringify(
      {
        firstChunkWallMs: capture.tap.chunkMeta[0]?.wallMs ?? null,
        lastChunkWallMs: capture.tap.chunkMeta[capture.tap.chunkMeta.length - 1]?.wallMs ?? null,
        captureWallSeconds: 15,
        tap: capture.tap,
        totalSamples: capture.totalSamples,
        statsSamples: [],
      },
      null,
      0,
    )}\n`,
  );
  console.log(
    `対照実験を書いた: ${String(capture.totalSamples)} サンプル, チャンク ${String(capture.tap.chunks)} 個`,
  );
});

// Lead 依頼 2: publisher を publish-done で止めたときの encode 末尾を測る。
// 停止直前の publisher 統計 (framesEncoded / audio.chunksEncoded / objectsSent) と、
// AudioEncoder.encode を包んで数えた入力フレーム数・最後の AudioData の timestamp を採る。
test("調査: publisher の publish-done で止めたときの encode 末尾を測る", async ({ page }) => {
  test.skip(process.env.MOQT_INVESTIGATION !== "1", "MOQT_INVESTIGATION=1 のときだけ動かす");
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 3);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }
  writeEnvironment(moqtUri);

  await installAudioOutputTap(page);
  await installPublisherEncodeProbe(page);
  const namespace = formatTrackNamespace(createTestNamespace());
  // 符号化を main thread で行う (useDedicatedWorker=0)。AudioEncoder.prototype.encode を
  // 包んで入力フレームを数えるためである。devtools の既定は Dedicated Worker での符号化であり、
  // Worker の中の encode は main thread からは包めない (実測: 包めても呼び出しが見えない)。
  await startBoth(page, moqtUri, namespace, "publish-done", { useDedicatedWorker: "0" });
  await waitForAudio(page);
  await activateSubscriberTap(page);
  await page.waitForTimeout(1_000);

  // 定常状態を 15 秒受信する
  const steadyStartedAtMs = Date.now();
  while (Date.now() - steadyStartedAtMs < 15_000) {
    await page.waitForTimeout(1_000);
  }
  const beforeStop = await readStats(page);
  const encodeBeforeStop = await readEncodeProbe(page);
  const stopClickAtMs = Date.now();
  await page.getByTestId("publisher-stop-button").click();
  const stopClickDoneMs = Date.now();
  await page.waitForTimeout(3_000);
  const afterStop = await readStats(page);
  const encodeAfterStop = await readEncodeProbe(page);

  const capture = await collectTapCapture(page);
  writeCapture("stop-publish-done", capture);
  writeFileSync(
    join(OUTPUT_DIR, "stop-publish-done.json"),
    `${JSON.stringify(
      {
        stopMode: "publish-done",
        stopClickAtMs,
        stopClickDoneMs,
        firstChunkWallMs: capture.tap.chunkMeta[0]?.wallMs ?? null,
        lastChunkWallMs: capture.tap.chunkMeta[capture.tap.chunkMeta.length - 1]?.wallMs ?? null,
        tap: capture.tap,
        totalSamples: capture.totalSamples,
        encodeBeforeStop,
        encodeAfterStop,
        beforeStop,
        afterStop,
      },
      null,
      0,
    )}\n`,
  );
  console.log(
    `publish-done 停止: 停止直前の publisher 統計 ${JSON.stringify(
      (
        beforeStop as {
          publisher: {
            framesEncoded: number;
            objectsSent: number;
            audio: { chunksEncoded: number };
          };
        }
      ).publisher,
    )}, encode 記録 ${JSON.stringify(encodeAfterStop)}`,
  );
});
