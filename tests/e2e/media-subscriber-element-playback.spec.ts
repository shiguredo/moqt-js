/**
 * 高レベル API の音声と映像を同じ video 要素へ接続する。
 * 入力の識別子を音声の振幅と映像の画素へ埋め、内部の同期統計に頼らず観測する。
 * 音声は MediaStream の分岐点、映像は要素の表示通知で測る。スピーカーとの同期測定ではない。
 *
 * 遅延の判定は、実行環境が実時間に追従することを前提にする。CI の仮想マシンではこの前提が
 * 崩れることがある (実測: AudioContext の時計が数百 ms から 1 秒を超えて止まる、メインスレッドの
 * timer が 1 秒を超えて遅れる。映像を流さない構成でも起きるため、このテストの負荷ではない)。
 * 製品は止まった分を圧縮で時間をかけて取り戻す (`docs/AV_SYNC_DECISIONS.md` の
 * 「3. 回復を遅らせず、実適用量を反映する」。遅着した音を遅れだけで捨てず、予約の余裕を超えて
 * 削らない)。その間の遅れは製品が足した遅延ではないため、外部の測定で次のように切り分ける。
 *
 * - 供給: 予定から REAL_TIME_TOLERANCE_MS を超えて遅れた push は送らずに飛ばす。まとめて送ると
 *   遅着として扱われ、ジッタバッファの目標遅延が伸びる。パルスを飛ばした識別子は標本から外す
 * - 出力時計: AudioContext の時計が performance.now() より遅れた量 (L) を測り、読みの刻みを
 *   引いた分を標本ごとに上限へ足す。乱れの無い実行では L は刻みの内に収まり、足す量は 0 になる
 * - 破棄: 時計が止まって予約が backlog の上限まで積み上がり得たときの破棄だけを許す
 *
 * 時計が止まった回は、止まった量の累計だけ上限が緩む。その回では停止からの回復の速さと、
 * 停止の後に遅延が積み上がる退行は検出できない (乱れの無い回で検出する)。
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
 * 実時間からの外れの許容 (ミリ秒)
 *
 * 供給がこの値を超えて遅れた push は飛ばし、時計の遅れがこの値を超えた回は乱れた回として
 * 扱う。乱れの無い実行での供給の遅れの最大は 10 ms 程度であり (CI とローカルの実測)、
 * それより十分大きくとる
 */
const REAL_TIME_TOLERANCE_MS = 30;

/** 1 フレームの長さ (ミリ秒)。48 kHz の 960 サンプル */
const FRAME_MS = 20;

/** パルス (識別子) の間隔 (ミリ秒)。10 フレームごとに 1 つ */
const PULSE_INTERVAL_MS = 200;

/**
 * 時計の遅れの読みの刻み (ミリ秒)
 *
 * `AudioContext.currentTime` は出力の IO バッファの単位でまとめて進む。WebKit は音声の
 * MediaStreamTrack を再生しているとき IO バッファを 1024 フレーム (48 kHz で 21.3 ms) にする
 * (WebCore の MediaSessionManagerCocoa.mm)。そのため読みは真の値から最大 1 刻み小さく出る
 */
const CLOCK_JITTER_MS = 25;

/** 判定に使う標本の数の下限 */
const REQUIRED_SAMPLES = 12;

/** 測定の回数の上限 (乱れた回の測り直しを含む) */
const MAX_ATTEMPTS = 3;

/** ブラウザの描画周期とキャプチャー分岐を含む回帰検出の上限。超低遅延の保証値ではない */
const AGE_LIMIT_MS = 150;

/** 始動と pause 区間を除外し、再開後の区間も含めて遅延の蓄積を検出する */
const STABLE_IDS = new Set(
  Array.from({ length: 24 }, (_, index) => index + 1).filter(
    (id) => id >= 6 && id !== 11 && id !== 12,
  ),
);

/** ブラウザ側の本体へ渡す値 */
interface ElementPlaybackArguments {
  /** 音声の最小遅延 (ミリ秒) */
  readonly minDelayMs: number;
  /** 実時間からの外れの許容 (ミリ秒)。`REAL_TIME_TOLERANCE_MS` */
  readonly realTimeToleranceMs: number;
  /** index 155 の供給の前にメインスレッドを止める時間 (ミリ秒)。0 なら止めない */
  readonly mainThreadStallMs: number;
}

/**
 * 実ブラウザで再生し、生の観測を返す
 *
 * 判定に使う値は呼び出し側で求める。本体はブラウザへ渡されるため、外側の変数を参照しない。
 */
async function observeElementPlayback({
  moduleUrl,
  minDelayMs,
  realTimeToleranceMs,
  mainThreadStallMs,
}: PlayoutBrowserModules & ElementPlaybackArguments) {
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
  // audio は識別子ごとの [分岐点の処理時刻, 処理した時点の時計の遅れ]、
  // displays は識別子ごとの [表示予定時刻, その時点までの時計の遅れの最大]
  const audio = new Map<number, [number, number]>(),
    displays = new Map<number, [number, number]>();
  const droppedPulseIds: number[] = [],
    drops: { index: number; reason: string; lagMs: number }[] = [],
    skipped: number[] = [],
    skippedPulseIds: number[] = [],
    unexpected: { index: number; status: string }[] = [];
  let callback = 0,
    displayedFrames = 0,
    outputLagMaxMs = 0,
    playError = "",
    played = 0,
    productCallMaxMs = 0,
    pushed = 0,
    supplyLateMaxMs = 0;
  const recordPlayError = (error: unknown): void => {
    playError = String(error);
  };
  const widths = new Set<number>();
  let source: MediaStreamAudioSourceNode | null = null,
    tap: AudioWorkletNode | null = null;
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
    // 「AudioContext の時計 - performance.now()」の読みの最大。読みは真の値から最大 1 刻み
    // 小さく出るため、最大は真の値に近づく。時計が止まると読みだけが下がり、差が遅れになる
    let driftMax = -Infinity;
    const outputLag = (): number => {
      const drift = context.currentTime * 1000 - performance.now();
      driftMax = Math.max(driftMax, drift);
      return driftMax - drift;
    };
    await context.resume();
    await context.audioWorklet.addModule(module);
    tap = new AudioWorkletNode(context, "signal-probe");
    // 要素と同じ音声トラックを分岐して観測する。出力先の差し替えや API の置換はしない。
    source = context.createMediaStreamSource(stream);
    source.connect(tap).connect(context.destination);
    tap.port.onmessage = (event: MessageEvent<{ id: number; frame: number }>) => {
      if (!audio.has(event.data.id)) {
        // 処理時刻は capture 側の時刻であり、デバイスの出力時計として扱わない。onset の後に
        // 時計が止まると処理時刻も同じだけ後ろへずれるため、同じ時点の遅れを一緒に残す
        audio.set(event.data.id, [
          performance.now() + (event.data.frame / context.sampleRate - context.currentTime) * 1000,
          outputLag(),
        ]);
      }
    };
    const record: VideoFrameRequestCallback = (_now, metadata) => {
      displayedFrames++;
      widths.add(video.videoWidth);
      reader.drawImage(video, 0, 0, 1, 1);
      const id = Math.round((reader.getImageData(0, 0, 1, 1).data[0] ?? 0) / 8);
      // 映像の表示時刻は、それまでに予約した音声の位置へ合わせて決まる。止まった分の回復は
      // 音声と同じく時間がかかるため、その時点までの遅れの最大を余裕にする
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
      // pause、再開、解像度変更は、供給を飛ばすかどうかに関わらず必ず行う。
      if (index === 100) video.pause();
      if (index === 110) void video.play().catch(recordPlayError);
      if (index === 120) canvas.width = 32;
      if (index === 155) {
        // 供給を飛ばす経路を毎回通すため、実際にメインスレッドを止める。
        const until = performance.now() + mainThreadStallMs;
        while (performance.now() < until) {
          // 止めている間は何もしない
        }
      }
      // 製品が時計を読む前の遅れを、破棄を時計の遅れで説明できるかの判定に使う。
      const lagMs = outputLag();
      outputLagMaxMs = Math.max(outputLagMaxMs, lagMs);
      const lateMs = performance.now() - scheduledAt;
      const id = Math.floor(index / 10) + 1;
      // 200 ms ごとの 20 ms パルスと同時に画面の識別子を更新する。
      const pulse = index % 10 === 0;
      // 遅れた分をまとめて送ると遅着として扱われ、目標遅延が伸びる。供給の前提が
      // 崩れた区間は送らずに飛ばし、媒体の欠落として扱わせる
      if (lateMs > realTimeToleranceMs) {
        skipped.push(index);
        if (pulse) skippedPulseIds.push(id);
        continue;
      }
      supplyLateMaxMs = Math.max(supplyLateMaxMs, lateMs);
      pushed++;
      const timestamp = epoch + index * 20000;
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: 960,
        timestamp,
        data: new Float32Array(960).fill(pulse ? 0.1 + id * 0.02 : 0),
      });
      // 飛ばした push が製品の処理の止まりによるものかを後から見分けるため、所要時間を残す
      const callStartedAt = performance.now();
      control.playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
      const decision = control.playout.pushAudio(data);
      data.close();
      if (decision.status === "error") throw decision.error;
      if (decision.status === "played") played++;
      else if (decision.status === "dropped") {
        drops.push({ index, reason: decision.reason, lagMs });
        if (pulse) droppedPulseIds.push(id);
      } else unexpected.push({ index, status: decision.status });
      drawing.fillStyle = `rgb(${id * 8}, 0, 0)`;
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      control.playout.trackVideoDecodeInput(timestamp, {
        timestampKind: "wallClock",
        location: { group: BigInt(index), object: 0n },
      });
      control.playout.pushVideo(new VideoFrame(canvas, { timestamp }));
      productCallMaxMs = Math.max(productCallMaxMs, performance.now() - callStartedAt);
    }
    await control.playout.drainAudio();
    await playing;
    const tracks = stream.getTracks();
    const state = { paused: video.paused, mediaTime: video.currentTime };
    await subscriber.close();
    return {
      minDelayMs,
      mainThreadStallMs,
      origin,
      played,
      pushed,
      skipped,
      skippedPulseIds,
      drops,
      droppedPulseIds,
      unexpected,
      backlogMs: (AUDIO_PLAYOUT_BACKLOG_SECONDS as number) * 1000,
      supplyLateMaxMs,
      outputLagMaxMs,
      productCallMaxMs,
      playError,
      displayedFrames,
      widths: [...widths],
      ...state,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      ended: tracks.every((track) => track.readyState === "ended"),
      audio: [...audio].map(([id, [processedAt, lagMs]]) => ({ id, processedAt, lagMs })),
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

/** 識別子ごとの遅延の標本 */
interface AgeSample {
  /** 識別子 */
  readonly id: number;
  /** 理想の予定時刻からの遅延 (ミリ秒) */
  readonly ageMs: number;
  /** 外部で測った時計の遅れから上限へ足す量 (ミリ秒) */
  readonly allowanceMs: number;
}

/**
 * 値の分布を要約する
 *
 * 標本が 20 未満のとき、p95 は最大値と同じ要素を指す。
 */
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
 * 遅延が膨らむため、両方の標本から外す。パルスを破棄した識別子は音声の標本から外す
 * (破棄が時計の遅れで説明できない場合は、別に失敗させる)。
 */
function evaluateObservation(observation: Observation) {
  const audioExcluded = new Set([...observation.skippedPulseIds, ...observation.droppedPulseIds]);
  const videoExcluded = new Set(observation.skippedPulseIds);
  const ideal = (id: number): number => observation.origin + (id - 1) * PULSE_INTERVAL_MS;
  // 読みの刻みの内の遅れは足さない。乱れの無い回の判定を元と同じ強さに保つ
  const allowance = (lagMs: number): number => Math.max(0, lagMs - CLOCK_JITTER_MS);
  const audio: AgeSample[] = observation.audio
    .filter(({ id }) => STABLE_IDS.has(id) && !audioExcluded.has(id))
    .map(({ id, processedAt, lagMs }) => ({
      id,
      ageMs: processedAt - ideal(id),
      allowanceMs: allowance(lagMs),
    }));
  const video: AgeSample[] = observation.displays
    .filter(({ id }) => STABLE_IDS.has(id) && !videoExcluded.has(id))
    .map(({ id, displayAt, lagMs }) => ({
      id,
      ageMs: displayAt - ideal(id),
      allowanceMs: allowance(lagMs),
    }));
  const audioAge = new Map(audio.map(({ id, ageMs }) => [id, ageMs]));
  // backlog で捨てるのは、予約の終端が「目標遅延 + backlog」を超えたときである
  // (src/playout/audioPlayout.ts の schedule)。時計が止まっている間は push のたびに予約が
  // 1 フレームずつ積み上がるため、捨てるには止まった量が backlog から 1 フレームを引いた量を
  // 超えている必要がある。読みは刻みの分だけ小さく出ることがあるため、その分を引く
  const dropLagFloorMs = observation.backlogMs - FRAME_MS - CLOCK_JITTER_MS;
  const { audio: _audio, displays: _displays, ...raw } = observation;
  return {
    summary: {
      ...raw,
      // その回の実行環境が実時間から外れていたか (測り直してよいかの判定に使う)
      disturbed:
        observation.skipped.length > 0 ||
        observation.drops.length > 0 ||
        observation.outputLagMaxMs > REAL_TIME_TOLERANCE_MS,
      dropLagFloorMs,
      unexplainedDrops: observation.drops.filter(
        ({ reason, lagMs }) => reason !== "backlog" || lagMs < dropLagFloorMs,
      ),
      audioTrackAgeMs: summarize(audio.map(({ ageMs }) => ageMs)),
      videoDisplayAgeMs: summarize(video.map(({ ageMs }) => ageMs)),
      audioJudgedAgeMs: summarize(audio.map(({ ageMs, allowanceMs }) => ageMs - allowanceMs)),
      videoJudgedAgeMs: summarize(video.map(({ ageMs, allowanceMs }) => ageMs - allowanceMs)),
      observationDeltaMs: summarize(
        video.flatMap(({ id, ageMs }) => {
          const audioAgeMs = audioAge.get(id);
          return audioAgeMs === undefined ? [] : [ageMs - audioAgeMs];
        }),
      ),
    },
    samples: { audio, video },
  };
}

const CASES = [
  { minDelayMs: 10, mainThreadStallMs: 0, label: "" },
  { minDelayMs: 50, mainThreadStallMs: 0, label: "" },
  // 供給を飛ばして識別子を外す経路を、CI の乱れに頼らず毎回通す
  { minDelayMs: 10, mainThreadStallMs: 200, label: "、メインスレッドが 200 ms 止まっても" },
];

for (const { minDelayMs, mainThreadStallMs, label } of CASES) {
  test(`音声と映像を video 要素で継続再生し${label}、再開と解像度変更を処理する ${minDelayMs} ms`, async ({
    page,
  }, testInfo) => {
    // 1 回の測定は 7 秒前後かかる。乱れた回の測り直しを含めて収まる長さにする
    test.setTimeout(90_000);
    const attempts: ReturnType<typeof evaluateObservation>[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await openPlayoutPage(page);
      const evaluation = evaluateObservation(
        await evaluatePlayout(page, observeElementPlayback, {
          minDelayMs,
          realTimeToleranceMs: REAL_TIME_TOLERANCE_MS,
          mainThreadStallMs,
        }),
      );
      attempts.push(evaluation);
      const { summary } = evaluation;
      const insufficient =
        summary.audioTrackAgeMs.samples < REQUIRED_SAMPLES ||
        summary.videoDisplayAgeMs.samples < REQUIRED_SAMPLES;
      // 測り直すのは、標本が足りず、かつその回の実行環境が実時間から外れていたときだけである。
      // 乱れの無い回の標本の欠落は製品の不具合として扱い、測り直さない
      if (!insufficient || !summary.disturbed) break;
    }
    await testInfo.attach("MediaStream と video 要素の観測", {
      body: JSON.stringify(attempts, null, 2),
      contentType: "application/json",
    });
    console.log("MediaStream と video 要素の観測", JSON.stringify(attempts));
    const last = attempts.at(-1);
    assert.ok(last !== undefined, "1 回以上測定すること");
    const result = last.summary;
    const summary = JSON.stringify(result);
    assert.ok(
      result.audioTrackAgeMs.samples >= REQUIRED_SAMPLES &&
        result.videoDisplayAgeMs.samples >= REQUIRED_SAMPLES,
      `判定に使う標本が音声と映像の両方で ${REQUIRED_SAMPLES} 以上あること (乱れた回は ${MAX_ATTEMPTS} 回まで測る): ${summary}`,
    );
    assert.equal(result.playError, "", "再生を開始できること");
    assert.equal(result.audioTracks, 1, "音声トラックが 1 つあること");
    assert.equal(result.videoTracks, 1, "映像トラックが 1 つあること");
    assert.deepEqual(result.unexpected, [], `再生と破棄以外の結果が無いこと: ${summary}`);
    assert.deepEqual(
      result.unexplainedDrops,
      [],
      `時計の遅れで説明できない破棄が無いこと: ${summary}`,
    );
    if (mainThreadStallMs > 0)
      assert.ok(
        result.skippedPulseIds.length > 0,
        `メインスレッドを止めた区間のパルスを飛ばして標本から外すこと: ${summary}`,
      );
    assert.equal(result.paused, false, "再開した後に再生を続けること");
    assert.ok(result.mediaTime > 3, `再生位置が進むこと: ${summary}`);
    // 元の判定 (240 フレームの投入で 140 フレームを超える表示) の比率を、飛ばした分を除いた
    // 投入の数へ当てはめる
    assert.ok(
      result.displayedFrames > (result.pushed * 140) / 240,
      `フレームを捨てて遅延を小さく見せないこと: ${result.displayedFrames} / ${result.pushed}`,
    );
    assert.ok(
      result.widths.includes(16) && result.widths.includes(32),
      "解像度変更後も表示すること",
    );
    assert.ok(
      (result.audioJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS,
      `音声の遅延 (時計の遅れを引いた値) の p95 が ${AGE_LIMIT_MS} ms 未満であること: ${summary}`,
    );
    assert.ok(
      (result.videoJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS,
      `映像の遅延 (時計の遅れを引いた値) の p95 が ${AGE_LIMIT_MS} ms 未満であること: ${summary}`,
    );
    assert.equal(result.ended, true, "終了時にトラックを止めること");
  });
}
