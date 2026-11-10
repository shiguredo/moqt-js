/**
 * 高レベル API の音声と映像を同じ video 要素へ接続する。
 * 入力の識別子を音声の振幅と映像の画素へ埋め、内部の同期統計に頼らず観測する。
 * 音声は MediaStream の分岐点、映像は要素の表示通知で測る。スピーカーとの同期測定ではない。
 *
 * 遅延の判定は、実行環境が実時間に追従することを前提にする。CI の仮想マシンではこの前提が
 * 崩れることがある (実測: AudioContext の時計が 1 回で 100〜400 ms 止まる、メインスレッドの
 * timer が最大 940 ms 遅れる。映像を流さない構成でも起きるため、このテストの負荷ではない)。
 * 製品は止まった分を圧縮で時間をかけて取り戻す (docs/AV_SYNC_DECISIONS.md の「回復を遅らせず、
 * 実適用量を反映する」。遅着した音を遅れだけで捨てず、予約の余裕を超えて削らない)。
 * その間の遅れは製品が足した遅延ではないため、外部の測定で次のように切り分ける。
 *
 * - 供給: 予定から SUPPLY_LATE_LIMIT_MS を超えて遅れた push は送らずに飛ばす。まとめて送ると
 *   遅着として扱われ、ジッタバッファの目標遅延が伸びる。パルスを飛ばした識別子は標本から外す
 * - 出力時計: 最初の push からの AudioContext の時計の遅れ (L) を測り、標本ごとに上限へ足す。
 *   乱れの無い実行では L はほぼ 0 であり、判定の強さは変わらない
 * - 破棄: 止まった分が backlog の上限を超えたときの破棄だけを許す
 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage, type PlayoutBrowserModules } from "./playoutTestPage";

test.use({
  launchOptions: async ({ browserName }, provide) => {
    await provide(
      browserName === "chromium"
        ? { channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] }
        : {},
    );
  },
});

/**
 * 供給の遅れの上限 (ミリ秒)
 *
 * 乱れの無い実行の最大は 10 ms 程度である (CI とローカルの実測)。これを超えた push は
 * 飛ばす。飛ばさずに送る遅れはジッタバッファが吸収する範囲に収める
 */
const SUPPLY_LATE_LIMIT_MS = 30;

/** 1 フレームの長さ (ミリ秒)。48 kHz の 960 サンプル */
const FRAME_MS = 20;

/**
 * 時計の遅れの測定の揺らぎ (ミリ秒)
 *
 * `AudioContext.currentTime` は描画の単位でしか進まないため、同じ時点でも遅れの読みが
 * 数 ms 動く (乱れの無い実行の実測で 10 ms 未満)
 */
const CLOCK_JITTER_MS = 10;

/** 判定に使う識別子の数の下限 */
const REQUIRED_SAMPLES = 12;

/** 供給の前提が崩れて識別子が足りないときに測り直す回数の上限 */
const MAX_ATTEMPTS = 3;

/** ブラウザーの描画周期とキャプチャー分岐を含む回帰検出の上限。超低遅延の保証値ではない */
const AGE_LIMIT_MS = 150;

/** 始動と pause 区間を除外し、再開後の区間も含めて遅延の蓄積を検出する */
const STABLE_IDS = Array.from({ length: 24 }, (_, index) => index + 1).filter(
  (id) => id >= 6 && id !== 11 && id !== 12,
);

/**
 * 実ブラウザで再生し、生の観測を返す
 *
 * 判定は呼び出し側で行う。本体はブラウザへ渡されるため、外側の変数を参照しない。
 */
async function observeElementPlayback({
  moduleUrl,
  minDelayMs,
  supplyLateLimitMs,
}: PlayoutBrowserModules & { minDelayMs: number; supplyLateLimitMs: number }) {
  const { MediaSubscriberImpl } = await import(
    new URL("./createMediaSubscriber.ts", moduleUrl).href
  );
  const { AUDIO_PLAYOUT_BACKLOG_SECONDS } = await import(
    new URL("./playout/audioPlayout.ts", moduleUrl).href
  );
  const subscriber = new MediaSubscriberImpl(
    "https://localhost.invalid",
    {
      namespace: ["element-playback"],
      audio: { minDelayMs },
      video: {},
    },
    {},
  );
  const control = subscriber as unknown as {
    createOutputStream(): Promise<void>;
    audioTrackInfo: object;
    videoTrackInfo: object;
    audioOutput: { context: AudioContext };
    playout: import("../../src/playout/mediaPlayout").MediaPlayout;
  };
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48000,
  };
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
  const video = document.createElement("video");
  video.playsInline = true;
  video.controls = true;
  // 自動再生の許可と音量操作は要素が所有する。無音でも音声トラック自体は流し続ける。
  video.muted = true;
  video.width = 64;
  video.height = 32;
  document.body.append(video);
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const drawing = canvas.getContext("2d");
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const reader = probe.getContext("2d", { willReadFrequently: true });
  if (drawing === null || reader === null) throw new Error("測定用 canvas を作れない");
  // 識別子ごとの [分岐点の処理時刻, AudioContext の時計から換算した時刻]
  const audio = new Map<number, [number, number]>();
  // 識別子ごとの [表示予定時刻, その時点までの時計の遅れの最大]
  const displays = new Map<number, [number, number]>();
  const skipped: number[] = [];
  const drops: { index: number; lagMs: number }[] = [];
  let callback = 0;
  let displayedFrames = 0;
  let played = 0;
  let pushed = 0;
  let playError = "";
  // 最初の push の時点の「AudioContext の時計 - performance.now()」(ミリ秒)
  let driftOrigin: number | null = null;
  let outputLagMaxMs = 0;
  let supplyLateMaxMs = 0;
  const recordPlayError = (error: unknown): void => {
    playError = String(error);
  };
  const widths = new Set<number>();
  let tap: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const module = URL.createObjectURL(
    new Blob(
      [
        `
        class SignalProbe extends AudioWorkletProcessor {
          peak = 0;
          onset = 0;
          quiet = 0;
          process(inputs) {
            const samples = inputs[0]?.[0];
            if (samples) for (let index = 0; index < samples.length; index++) {
              const amplitude = Math.abs(samples[index]);
              if (amplitude > 0.08) {
                if (this.peak === 0) this.onset = currentFrame + index;
                this.peak = Math.max(this.peak, amplitude);
                this.quiet = 0;
              } else if (this.peak > 0 && ++this.quiet >= sampleRate * 0.005) {
                this.port.postMessage({ id: Math.round((this.peak - 0.1) / 0.02), frame: this.onset });
                this.peak = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('signal-probe', SignalProbe);
      `,
      ],
      { type: "text/javascript" },
    ),
  );
  try {
    await control.createOutputStream();
    const stream: MediaStream | null = subscriber.mediaStream;
    if (stream === null) throw new Error("出力 MediaStream がない");
    video.srcObject = stream;
    const playing = video.play().catch(recordPlayError);
    const context = control.audioOutput.context;
    // 最初の push から AudioContext の時計が performance.now() より遅れた量。
    // 描画が止まると currentTime だけが止まり、遅れが段差として残る
    const outputLag = (): number =>
      driftOrigin === null ? 0 : driftOrigin - (context.currentTime * 1000 - performance.now());
    await context.resume();
    await context.audioWorklet.addModule(module);
    tap = new AudioWorkletNode(context, "signal-probe");
    // 要素と同じ音声トラックを分岐して観測する。出力先の差し替えや API の置換はしない。
    source = context.createMediaStreamSource(stream);
    source.connect(tap).connect(context.destination);
    tap.port.onmessage = (event: MessageEvent<{ id: number; frame: number }>) => {
      if (!audio.has(event.data.id)) {
        // 1 つ目は capture 側の処理時刻。デバイスの出力時計として扱わない。
        // 2 つ目は、時計が最初の push から実時間で進んだとみなした時刻であり、
        // 1 つ目との差が、処理した時点までに時計が止まった量 (上限へ足す余裕) になる
        const frameMs = (event.data.frame / context.sampleRate) * 1000;
        audio.set(event.data.id, [
          performance.now() + frameMs - context.currentTime * 1000,
          frameMs - (driftOrigin ?? 0),
        ]);
      }
    };
    const record: VideoFrameRequestCallback = (_now, metadata) => {
      displayedFrames++;
      widths.add(video.videoWidth);
      reader.drawImage(video, 0, 0, 1, 1);
      const id = Math.round((reader.getImageData(0, 0, 1, 1).data[0] ?? 0) / 8);
      // 映像は音声へ合わせて表示されるため、その時点までの時計の遅れの最大を余裕にする
      outputLagMaxMs = Math.max(outputLagMaxMs, outputLag());
      if (id > 0 && !displays.has(id))
        displays.set(id, [metadata.expectedDisplayTime, outputLagMaxMs]);
      callback = video.requestVideoFrameCallback(record);
    };
    callback = video.requestVideoFrameCallback(record);
    const origin = performance.now() + 30;
    const epoch = Math.round((performance.timeOrigin + origin) * 1000);
    for (let index = 0; index < 240; index++) {
      const scheduledAt = origin + index * 20;
      const remaining = scheduledAt - performance.now();
      if (remaining > 0)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      // 再開と解像度変更は供給を飛ばすかどうかに関わらず必ず行う。
      if (index === 100) video.pause();
      if (index === 110) void video.play().catch(recordPlayError);
      if (index === 120) canvas.width = 32;
      driftOrigin ??= context.currentTime * 1000 - performance.now();
      outputLagMaxMs = Math.max(outputLagMaxMs, outputLag());
      const lateMs = performance.now() - scheduledAt;
      // 遅れた分をまとめて送ると遅着として扱われ、目標遅延が伸びる。供給の前提が
      // 崩れた区間は送らずに飛ばし、媒体の欠落として扱わせる
      if (lateMs > supplyLateLimitMs) {
        skipped.push(index);
        continue;
      }
      supplyLateMaxMs = Math.max(supplyLateMaxMs, lateMs);
      pushed++;
      const id = Math.floor(index / 10) + 1;
      const timestamp = epoch + index * 20000;
      // 200 ms ごとの 20 ms パルスと同時に画面の識別子を更新する。
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: 960,
        timestamp,
        data: new Float32Array(960).fill(index % 10 === 0 ? 0.1 + id * 0.02 : 0),
      });
      control.playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
      const decision = control.playout.pushAudio(data);
      data.close();
      if (decision.status === "error") throw decision.error;
      if (decision.status === "played") played++;
      else drops.push({ index, lagMs: outputLag() });
      drawing.fillStyle = `rgb(${id * 8}, 0, 0)`;
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      control.playout.trackVideoDecodeInput(timestamp, {
        timestampKind: "wallClock",
        location: { group: BigInt(index), object: 0n },
      });
      control.playout.pushVideo(new VideoFrame(canvas, { timestamp }));
    }
    await control.playout.drainAudio();
    await playing;
    const tracks = stream.getTracks();
    const state = { paused: video.paused, mediaTime: video.currentTime };
    await subscriber.close();
    return {
      minDelayMs,
      origin,
      played,
      pushed,
      skipped,
      drops,
      backlogMs: (AUDIO_PLAYOUT_BACKLOG_SECONDS as number) * 1000,
      supplyLateMaxMs,
      outputLagMaxMs,
      playError,
      displayedFrames,
      widths: [...widths],
      ...state,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      ended: tracks.every((track) => track.readyState === "ended"),
      audio: [...audio].map(([id, [processedAt, clockAt]]) => ({ id, processedAt, clockAt })),
      displays: [...displays].map(([id, [displayAt, lagMs]]) => ({ id, displayAt, lagMs })),
    };
  } finally {
    video.cancelVideoFrameCallback(callback);
    video.pause();
    video.srcObject = null;
    source?.disconnect();
    tap?.disconnect();
    tap?.port.close();
    await subscriber.close();
    video.remove();
    URL.revokeObjectURL(module);
  }
}

type Observation = Awaited<ReturnType<typeof observeElementPlayback>>;

/** 標本の遅延 (ミリ秒) と、外部で測った時計の遅れから足す余裕 (ミリ秒) */
interface AgeSample {
  readonly id: number;
  readonly ageMs: number;
  readonly allowanceMs: number;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

/**
 * 生の観測から判定に使う値を求める
 *
 * パルスを飛ばした識別子は、音声には onset が無く、映像はその後のフレームで初めて表示されて
 * 遅延が膨らむため、両方の標本から外す。
 */
function judge(observation: Observation) {
  const skippedIds = new Set(
    observation.skipped.filter((index) => index % 10 === 0).map((index) => index / 10 + 1),
  );
  const judgedIds = new Set(STABLE_IDS.filter((id) => !skippedIds.has(id)));
  const ideal = (id: number): number => observation.origin + (id - 1) * 200;
  const audio: AgeSample[] = observation.audio
    .filter(({ id }) => judgedIds.has(id))
    .map(({ id, processedAt, clockAt }) => ({
      id,
      ageMs: processedAt - ideal(id),
      allowanceMs: processedAt - clockAt,
    }));
  const video: AgeSample[] = observation.displays
    .filter(({ id }) => judgedIds.has(id))
    .map(({ id, displayAt, lagMs }) => ({ id, ageMs: displayAt - ideal(id), allowanceMs: lagMs }));
  const capturedAt = new Map(observation.audio.map(({ id, processedAt }) => [id, processedAt]));
  // backlog で捨てるのは、未回復の遅れが backlog から 1 フレームを引いた量を超えたときだけ
  // である (src/playout/audioPlayout.ts の schedule)。未回復の遅れは外部で測った時計の遅れを
  // 超えないため、それに満たない遅れでの破棄は製品が捨てたものとして扱う
  const dropLagFloorMs = observation.backlogMs - FRAME_MS - CLOCK_JITTER_MS;
  const { audio: _audio, displays: _displays, ...rest } = observation;
  return {
    ...rest,
    availableIds: judgedIds.size,
    dropLagFloorMs,
    unexplainedDrops: observation.drops.filter(({ lagMs }) => lagMs < dropLagFloorMs),
    audioTrackAgeMs: summarize(audio.map(({ ageMs }) => ageMs)),
    videoDisplayAgeMs: summarize(video.map(({ ageMs }) => ageMs)),
    audioJudgedAgeMs: summarize(audio.map(({ ageMs, allowanceMs }) => ageMs - allowanceMs)),
    videoJudgedAgeMs: summarize(video.map(({ ageMs, allowanceMs }) => ageMs - allowanceMs)),
    observationDeltaMs: summarize(
      observation.displays.flatMap(({ id, displayAt }) => {
        const at = capturedAt.get(id);
        return judgedIds.has(id) && at !== undefined ? [displayAt - at] : [];
      }),
    ),
    audioSamples: audio,
    videoSamples: video,
  };
}

for (const minDelayMs of [10, 50]) {
  test(`音声と映像を video 要素で継続再生し、再開と解像度変更を処理する ${minDelayMs} ms`, async ({
    page,
  }, testInfo) => {
    // 1 回の測定は 7 秒前後かかる。供給の前提が崩れたときの測り直しを含めて収まる長さにする
    test.setTimeout(90_000);
    const attempts: ReturnType<typeof judge>[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await openPlayoutPage(page);
      const judged = judge(
        await evaluatePlayout(page, observeElementPlayback, {
          minDelayMs,
          supplyLateLimitMs: SUPPLY_LATE_LIMIT_MS,
        }),
      );
      attempts.push(judged);
      // 測り直すのは、供給を飛ばして判定できる識別子が足りないときだけである。
      // 製品の遅延や表示の失敗では測り直さない
      if (judged.availableIds >= REQUIRED_SAMPLES) break;
    }
    await testInfo.attach("MediaStream と video 要素の観測", {
      body: JSON.stringify(attempts, null, 2),
      contentType: "application/json",
    });
    console.log("MediaStream と video 要素の観測", JSON.stringify(attempts));
    const result = attempts.at(-1);
    assert.ok(result !== undefined);
    const summary = JSON.stringify({ ...result, audioSamples: undefined, videoSamples: undefined });
    assert.ok(
      result.availableIds >= REQUIRED_SAMPLES,
      `供給が ${MAX_ATTEMPTS} 回とも実時間から外れ、判定できる識別子が足りないこと: ${summary}`,
    );
    assert.equal(result.playError, "");
    assert.equal(result.audioTracks, 1);
    assert.equal(result.videoTracks, 1);
    assert.equal(result.played + result.drops.length, result.pushed);
    assert.deepEqual(
      result.unexplainedDrops,
      [],
      `時計の遅れで説明できない破棄が無いこと: ${summary}`,
    );
    assert.equal(result.paused, false);
    assert.ok(result.mediaTime > 3);
    assert.ok(
      result.displayedFrames > (result.pushed * 7) / 12,
      "フレームを捨てて遅延を小さく見せないこと",
    );
    assert.ok(
      result.widths.includes(16) && result.widths.includes(32),
      "解像度変更後も表示すること",
    );
    assert.ok(
      result.audioTrackAgeMs.samples >= REQUIRED_SAMPLES &&
        result.videoDisplayAgeMs.samples >= REQUIRED_SAMPLES,
      summary,
    );
    assert.ok((result.audioJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS, summary);
    assert.ok((result.videoJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS, summary);
    assert.equal(result.ended, true);
  });
}
