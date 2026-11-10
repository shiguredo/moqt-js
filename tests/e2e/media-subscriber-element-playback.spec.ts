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
 *   遅着として扱われ、ジッタバッファの目標遅延が伸びる。パルスを飛ばした識別子は映像の標本から
 *   外す (音声はパルスを送っていないため、もともと標本にならない)
 * - 出力時計: AudioContext の時計が performance.now() より遅れた量 (L) を測り、読みの揺らぎを
 *   引いた分を余裕として遅延から引く。乱れの無い回は L が揺らぎの内に収まり、余裕は 0 になる
 * - 破棄: 時計の遅れの累計が、予約を backlog の上限まで積み上げ得る量に達した後の破棄だけを許す
 * - 測り直し: 実行環境に依存しない判定はどの回でも確かめる。乱れで崩れ得る判定 (標本の数、
 *   破棄、表示の数、遅延の上限) が成り立たず、かつその回が乱れていたときだけ、MAX_ATTEMPTS 回まで
 *   測り直す。乱れの無い回では測り直さずに判定する
 *
 * 時計が止まった回は、止まった量の累計だけ上限が緩む。その回では、停止からの回復の速さ、停止の
 * 後に遅延が積み上がる退行、停止の後に時計が動いている間の破棄は検出できない (乱れの無い回で
 * 検出する)。
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
 * 供給の遅れの許容 (ミリ秒)
 *
 * これを超えて遅れた push は飛ばす。遅れには、前の回の製品の呼び出しの所要時間も入る。
 * 乱れの無い回の供給の遅れの最大は、ローカルで 10 ms 前後、CI では 29 ms の回もあった
 * (製品の呼び出しが 37 ms かかった回)。飛ばしても、パルスでなければ判定は変わらない
 */
const REAL_TIME_TOLERANCE_MS = 30;

/** 1 フレームの長さ (ミリ秒)。ブラウザー側の 48 kHz の 960 サンプルと一致させる */
const FRAME_MS = 20;

/** パルス (識別子) の間隔 (ミリ秒)。ブラウザー側の 10 フレームごとと一致させる */
const PULSE_INTERVAL_MS = 200;

/**
 * 時計の遅れの読みの揺らぎ (ミリ秒)
 *
 * 乱れの無い回の L の最大は、CI の Chromium で 12 ms 前後、CI の WebKit で 7 ms 以下、
 * ローカルの WebKit で 14 ms だった。これを超えた L だけを余裕にし、超えた回を乱れた回とする
 */
const CLOCK_JITTER_MS = 25;

/** 判定に使う標本の数の下限 */
const REQUIRED_SAMPLES = 12;

/** 測定の回数の上限 (乱れた回の測り直しを含む) */
const MAX_ATTEMPTS = 3;

/** ブラウザーの描画周期とキャプチャー分岐を含む回帰検出の上限。超低遅延の保証値ではない */
const AGE_LIMIT_MS = 150;

/**
 * 判定に使う識別子
 *
 * 始動と pause 区間を除外し、再開後の区間も含めて遅延の蓄積を検出する。最大 17 個であり、
 * 遅延の p95 は最大値と同じ標本を指す (全標本が上限を下回ることを求める)
 */
const STABLE_IDS = new Set(
  Array.from({ length: 24 }, (_, index) => index + 1).filter(
    (id) => id >= 6 && id !== 11 && id !== 12,
  ),
);

/** ブラウザー側の本体へ渡す値 */
interface ElementPlaybackArguments {
  /** 音声の最小遅延 (ミリ秒) */
  readonly minDelayMs: number;
  /** 供給の遅れの許容 (ミリ秒)。`REAL_TIME_TOLERANCE_MS` */
  readonly realTimeToleranceMs: number;
  /** index 160 (識別子 17 のパルス) の直前にメインスレッドを止める時間 (ミリ秒)。0 なら止めない */
  readonly mainThreadStallMs: number;
}

/**
 * 実ブラウザーで再生し、生の観測を返す
 *
 * 判定に使う値は呼び出し側で求める。本体はブラウザーへ渡されるため、外側の変数を参照しない。
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
  const { AUDIO_PLAYOUT_BACKLOG_SECONDS } = (await import(
    new URL("./playout/audioPlayout.ts", moduleUrl).href
  )) as typeof import("../../src/playout/audioPlayout");
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
  // 識別子ごとの観測。音声は分岐点の処理時刻とその時点の時計の遅れ、映像は表示予定時刻と
  // その時点までの時計の遅れの最大
  const audio = new Map<number, { processedAt: number; lagMs: number }>(),
    displays = new Map<number, { displayAt: number; lagMaxMs: number }>();
  // 供給: テストが送らなかった index (意図して止めた間に予定があったものは分ける) と、
  // そのうちパルスの識別子
  const intentionallyWithheldIndexes: number[] = [],
    withheldIndexes: number[] = [],
    withheldPulseIds: number[] = [];
  // 製品の結果: backlog による音声の破棄と、再生と破棄以外の結果
  const drops: { index: number; reason: string; lagMs: number }[] = [],
    unexpected: { index: number; status: string }[] = [];
  // 診断用の最大値と数
  let outputLagMaxMs = 0,
    pushStepMaxMs = 0,
    pushed = 0,
    supplyLateMaxMs = 0;
  let callback = 0,
    displayedFrames = 0,
    playError = "",
    stalledUntil = -Infinity;
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
    // 「AudioContext の時計 - performance.now()」の読みの最大。読みは真の値から揺らいで
    // 小さく出ることがあるため、最大は真の値に近づく。時計が止まると読みだけが下がり、
    // 最大との差が遅れ (L) になる
    let driftMax = -Infinity;
    const outputLag = (): number => {
      const drift = context.currentTime * 1000 - performance.now();
      driftMax = Math.max(driftMax, drift);
      outputLagMaxMs = Math.max(outputLagMaxMs, driftMax - drift);
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
        audio.set(event.data.id, {
          processedAt:
            performance.now() +
            (event.data.frame / context.sampleRate - context.currentTime) * 1000,
          lagMs: outputLag(),
        });
      }
    };
    const record: VideoFrameRequestCallback = (_now, metadata) => {
      displayedFrames++;
      widths.add(video.videoWidth);
      reader.drawImage(video, 0, 0, 1, 1);
      const id = Math.round((reader.getImageData(0, 0, 1, 1).data[0] ?? 0) / 8);
      // 映像の表示時刻は、それまでに予約した音声の位置へ合わせて決まる。止まった分の回復は
      // 音声と同じく時間がかかるため、その時点までの遅れの最大を余裕にする
      outputLag();
      if (id > 0 && !displays.has(id))
        displays.set(id, { displayAt: metadata.expectedDisplayTime, lagMaxMs: outputLagMaxMs });
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
      if (index === 160 && mainThreadStallMs > 0) {
        // 供給を飛ばして識別子を外す経路を毎回通すため、実際にメインスレッドを止める。
        // 識別子 17 のパルスと前半のフレームは送らず、後半のフレームだけを送るため、映像では
        // 識別子 17 が後のフレームで初めて表示される。識別子 16 のパルスは 200 ms 前に送っている
        const until = performance.now() + mainThreadStallMs;
        while (performance.now() < until) {
          // 止めている間は何もしない
        }
        stalledUntil = performance.now();
      }
      // 製品が時計を読む前の遅れを、破棄を時計の遅れで説明できるかの判定に使う。
      const lagMs = outputLag();
      const lateMs = performance.now() - scheduledAt;
      const id = Math.floor(index / 10) + 1;
      // 200 ms ごとの 20 ms パルスと同時に画面の識別子を更新する。
      const pulse = index % 10 === 0;
      // 遅れた分をまとめて送ると遅着として扱われ、目標遅延が伸びる。供給の前提が
      // 崩れた区間は送らずに飛ばし、媒体の欠落として扱わせる
      if (lateMs > realTimeToleranceMs) {
        // 意図して止めた間に予定があった index は、実行環境の乱れに数えない
        (scheduledAt < stalledUntil ? intentionallyWithheldIndexes : withheldIndexes).push(index);
        if (pulse) withheldPulseIds.push(id);
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
      // 次の回の供給の遅れに入る、1 回の供給の処理 (製品の呼び出しと映像のフレームの生成を
      // 含む) の所要時間を診断用に残す
      const stepStartedAt = performance.now();
      control.playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
      const decision = control.playout.pushAudio(data);
      data.close();
      if (decision.status === "error") throw decision.error;
      if (decision.status === "dropped") drops.push({ index, reason: decision.reason, lagMs });
      else if (decision.status !== "played")
        unexpected.push({ index, status: `audio ${decision.status}` });
      drawing.fillStyle = `rgb(${id * 8}, 0, 0)`;
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      control.playout.trackVideoDecodeInput(timestamp, {
        timestampKind: "wallClock",
        location: { group: BigInt(index), object: 0n },
      });
      const shown = control.playout.pushVideo(new VideoFrame(canvas, { timestamp }));
      if (shown.status !== "queued") unexpected.push({ index, status: `video ${shown.status}` });
      pushStepMaxMs = Math.max(pushStepMaxMs, performance.now() - stepStartedAt);
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
      pushed,
      withheldIndexes,
      intentionallyWithheldIndexes,
      withheldPulseIds,
      drops,
      unexpected,
      backlogMs: AUDIO_PLAYOUT_BACKLOG_SECONDS * 1000,
      supplyLateMaxMs,
      outputLagMaxMs,
      pushStepMaxMs,
      playError,
      displayedFrames,
      widths: [...widths],
      ...state,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      ended: tracks.every((track) => track.readyState === "ended"),
      audio: [...audio].map(([id, observed]) => ({ id, ...observed })),
      displays: [...displays].map(([id, observed]) => ({ id, ...observed })),
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
  /** 外部で測った時計の遅れから求めた余裕 (ミリ秒)。判定ではこれを遅延から引く */
  readonly allowanceMs: number;
}

/**
 * 値の分布を要約する
 *
 * 件数が 20 以下のとき、p95 は最大値と同じ要素を指す。
 */
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

/**
 * 生の観測から判定に使う値を求める
 *
 * パルスを飛ばした識別子は、映像ではその後のフレームで初めて表示されて遅延が膨らむため、
 * 映像の標本から外す。
 */
function evaluateObservation(observation: Observation) {
  const withheld = new Set(observation.withheldPulseIds);
  const ideal = (id: number): number => observation.origin + (id - 1) * PULSE_INTERVAL_MS;
  // 揺らぎの内の遅れは余裕にしない。乱れの無い回の判定を元と同じ強さに保つ
  const allowance = (lagMs: number): number => Math.max(0, lagMs - CLOCK_JITTER_MS);
  const audio: AgeSample[] = observation.audio
    .filter(({ id }) => STABLE_IDS.has(id))
    .map(({ id, processedAt, lagMs }) => ({
      id,
      ageMs: processedAt - ideal(id),
      allowanceMs: allowance(lagMs),
    }));
  const displayed = observation.displays.filter(({ id }) => STABLE_IDS.has(id));
  const video: AgeSample[] = displayed
    .filter(({ id }) => !withheld.has(id))
    .map(({ id, displayAt, lagMaxMs }) => ({
      id,
      ageMs: displayAt - ideal(id),
      allowanceMs: allowance(lagMaxMs),
    }));
  const audioAge = new Map(audio.map(({ id, ageMs }) => [id, ageMs]));
  // backlog で捨てるのは、予約の終端が「目標遅延 + backlog」を超えたときである
  // (src/playout/audioPlayout.ts の schedule)。時計が止まっている間は push のたびに予約が
  // 1 フレームずつ積み上がるため、捨てるには止まった量が backlog から 1 フレームを引いた量を
  // 超えている必要がある。読みは揺らぎの分だけ小さく出ることがあるため、その分を引く
  const dropLagFloorMs = observation.backlogMs - FRAME_MS - CLOCK_JITTER_MS;
  const { audio: _audio, displays: _displays, ...raw } = observation;
  return {
    summary: {
      ...raw,
      // その回の実行環境が実時間から外れていたか。意図して止めた分は数えない
      disturbed:
        observation.withheldIndexes.length > 0 || observation.outputLagMaxMs > CLOCK_JITTER_MS,
      // 映像の標本から外した識別子のうち、実際に表示されていたもの
      excludedVideoIds: displayed.filter(({ id }) => withheld.has(id)).map(({ id }) => id),
      dropLagFloorMs,
      unexplainedDrops: observation.drops.filter(
        ({ reason, lagMs }) => reason !== "backlog" || lagMs < dropLagFloorMs,
      ),
      audioAgeMs: summarize(audio.map(({ ageMs }) => ageMs)),
      videoAgeMs: summarize(video.map(({ ageMs }) => ageMs)),
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

type Evaluation = ReturnType<typeof evaluateObservation>;

/** 実行環境に依存しない判定のうち、成り立たなかったものを返す */
function invariantFailures(summary: Evaluation["summary"]): string[] {
  return [
    summary.playError === "" ? null : `再生を開始できない: ${summary.playError}`,
    summary.audioTracks === 1 ? null : "音声トラックが 1 つではない",
    summary.videoTracks === 1 ? null : "映像トラックが 1 つではない",
    summary.unexpected.length === 0 ? null : "再生、表示待ち、破棄以外の結果がある",
    summary.paused ? "再開した後に止まっている" : null,
    summary.mediaTime > 3 ? null : `再生位置が進んでいない: ${summary.mediaTime}`,
    summary.widths.includes(16) && summary.widths.includes(32)
      ? null
      : "解像度変更の前後を表示していない",
    summary.ended ? null : "終了時にトラックが止まっていない",
    summary.mainThreadStallMs === 0 || summary.intentionallyWithheldIndexes.length > 0
      ? null
      : "メインスレッドを止めた区間の供給を飛ばしていない",
  ].filter((failure) => failure !== null);
}

/** 実行環境の乱れで崩れ得る判定のうち、成り立たなかったものを返す */
function timingFailures(summary: Evaluation["summary"]): string[] {
  const { audioAgeMs, videoAgeMs, audioJudgedAgeMs, videoJudgedAgeMs } = summary;
  return [
    audioAgeMs.count >= REQUIRED_SAMPLES ? null : `音声の標本が足りない: ${audioAgeMs.count}`,
    videoAgeMs.count >= REQUIRED_SAMPLES ? null : `映像の標本が足りない: ${videoAgeMs.count}`,
    summary.unexplainedDrops.length === 0 ? null : "時計の遅れで説明できない破棄がある",
    // 元の判定 (240 フレームの投入で 140 フレームを超える表示) の比率を、飛ばした分を除いた
    // 投入の数へ当てはめる。フレームを捨てて遅延を小さく見せないことを確かめる
    summary.displayedFrames > (summary.pushed * 140) / 240
      ? null
      : `表示したフレームが少ない: ${summary.displayedFrames} / ${summary.pushed}`,
    (audioJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS
      ? null
      : `音声の遅延 (余裕を引いた値) の p95 が ${AGE_LIMIT_MS} ms 以上: ${audioJudgedAgeMs.p95}`,
    (videoJudgedAgeMs.p95 ?? Infinity) < AGE_LIMIT_MS
      ? null
      : `映像の遅延 (余裕を引いた値) の p95 が ${AGE_LIMIT_MS} ms 以上: ${videoJudgedAgeMs.p95}`,
    summary.mainThreadStallMs === 0 || summary.excludedVideoIds.length > 0
      ? null
      : "メインスレッドを止めた区間の識別子を映像の標本から外していない",
  ].filter((failure) => failure !== null);
}

/**
 * 実行する条件
 *
 * `label` はテスト名の「継続再生し」の直後に入れる語句で、空でなければ「、」から始める。
 */
const CASES = [
  { minDelayMs: 10, mainThreadStallMs: 0, label: "" },
  { minDelayMs: 50, mainThreadStallMs: 0, label: "" },
  // 供給を飛ばして識別子を外す経路を、CI の乱れに頼らず毎回通す
  { minDelayMs: 10, mainThreadStallMs: 170, label: "、メインスレッドが 170 ms 止まっても" },
];

for (const { minDelayMs, mainThreadStallMs, label } of CASES) {
  test(`音声と映像を video 要素で継続再生し${label}、再開と解像度変更を処理する ${minDelayMs} ms`, async ({
    page,
  }, testInfo) => {
    // 既定の 30 秒は 1 回の測定を前提にしている。1 回は CI で 6〜8 秒だが、停止で延びても
    // 収まるよう、測定 1 回あたり 30 秒を見込む
    test.setTimeout(MAX_ATTEMPTS * 30_000);
    const attempts: Evaluation[] = [];
    try {
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
        assert.deepEqual(
          invariantFailures(summary),
          [],
          `実行環境に依存しない判定がどの回でも成り立つこと: ${JSON.stringify(summary)}`,
        );
        // 測り直すのは、乱れた回で、乱れで崩れ得る判定が成り立たなかったときだけである
        if (!summary.disturbed || timingFailures(summary).length === 0) break;
      }
    } finally {
      await testInfo.attach("MediaStream と video 要素の観測", {
        body: JSON.stringify(attempts, null, 2),
        contentType: "application/json",
      });
      console.log("MediaStream と video 要素の観測", JSON.stringify(attempts));
    }
    const last = attempts.at(-1);
    assert.ok(last !== undefined, "1 回以上測定すること");
    const { summary } = last;
    assert.deepEqual(
      timingFailures(summary),
      [],
      `${summary.disturbed ? `${MAX_ATTEMPTS} 回とも実行環境が実時間から外れていた。` : ""}乱れで崩れ得る判定がすべて成り立つこと: ${JSON.stringify(summary)}`,
    );
  });
}
