/**
 * production ビルド検証用の最小アプリ
 *
 * 目的は「利用側 Vite の production ビルド + moqt-js の既定 useWorker」で worker が
 * 起動することを自動テストで再現することである。このファイルは
 * tests/e2e/production/vite.config.ts と組で動き、moqt-js は src alias ではなく
 * tests/e2e/node_modules の workspace リンク経由で dist/index.js を解決する。
 *
 * ここから公開 API (createMediaPublisher) を呼ぶ経路と、ビルド成果物が参照する
 * worker スクリプトを実際の Worker として起動する経路の 2 つを用意する。
 * 前者は実リレーが要るため TEST_MOQT_URI がある実行だけで使い、後者は
 * リレー不要で常に使う (壊れた worker はどちらの経路でもロードに失敗する)。
 *
 * モックやスタブは使わない。Worker は本物の DedicatedWorker、応答は worker 自身が
 * 実装するプロトコル ({type: "init"} に対する "configured" / "error") を使う。
 */
import { createMediaPublisher, createMediaPlayout, version, type MediaPublisher } from "moqt-js";

/**
 * worker プローブの応答
 *
 * "message" は worker スクリプトが評価されて init へ応答したこと、
 * "error" は worker を起動できなかったこと、 "timeout" はどちらも起きなかったことを表す。
 * "error" の `phase` は、Worker の生成自体が同期で失敗した ("construct") のか、
 * 生成はできたがスクリプトのロードに失敗した ("load") のかを区別する
 * (ロード失敗は ErrorEvent の message が空になることがあり、失敗の種類を message から
 * 判別できないため)。
 */
export type WorkerProbeResult =
  | { kind: "message"; data: unknown }
  | { kind: "error"; phase: "construct" | "load"; message: string }
  | { kind: "timeout"; message: string };

/**
 * worker プローブの待ち時間
 *
 * 成功・失敗のどちらも worker 側の応答で決まるため、この値は「どちらも起きない」場合に
 * テストをハングさせず日本語の失敗理由を残すためだけに使う。
 */
const WORKER_PROBE_TIMEOUT_MS = 10_000;

/** エラーをメッセージへ変換する */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") {
      return message;
    }
  }
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * worker の URL を失敗理由へ載せられる長さに短くする
 *
 * data URL は worker スクリプト全体を抱えて長いため、先頭だけを残す
 * (どの成果物で失敗したかは先頭の種別だけで判別できる)。
 * 型は string だが、実際には undefined が渡る経路があるため受け付ける。
 */
function summarizeWorkerUrl(url: string | undefined): string {
  if (url === undefined || url === "") {
    return "(URL 無し)";
  }
  if (url.length <= 64) {
    return url;
  }
  return `${url.slice(0, 64)}... (${url.length} 文字)`;
}

/**
 * ロード失敗の ErrorEvent を失敗理由の文言にする
 *
 * ErrorEvent のフィールドは、実際には undefined が入る経路がある (MIME タイプの相違で
 * ロードに失敗した場合、filename / lineno / colno が埋まらない)。
 * この関数はどのような event でも例外を投げない。ハンドラ内で例外を投げると
 * finish() が呼ばれず、プローブがタイムアウトまで何も返さなくなるためである。
 */
function describeWorkerLoadFailure(event: ErrorEvent): string {
  try {
    // 空文字の message は「理由が無い」ではなく「取得できなかった」であるため、次を試す
    const candidates = [event.message, event.error?.message];
    const detail =
      candidates.find((candidate) => typeof candidate === "string" && candidate !== "") ??
      "(message 無し)";
    const position = `${summarizeWorkerUrl(event.filename)}:${event.lineno ?? 0}:${event.colno ?? 0}`;
    return `${detail} (${position})`;
  } catch (error) {
    return `(失敗理由を記述できなかった: ${toErrorMessage(error)})`;
  }
}

/**
 * ビルド成果物が参照する worker スクリプトを実際の Worker として起動する
 *
 * `url` は spec がビルド成果物 (preview が配信する JS) から取り出した参照そのもので、
 * data URL の場合もビルド済みファイルの URL の場合もある。どちらも本物の
 * `new Worker(url, { type: "module" })` で起動する。
 *
 * 起動後に worker の init プロトコル (`{type: "init", config}`) を送る。応答が返れば
 * スクリプトの評価と init の実行まで到達している。応答が返らないまま onerror が来た
 * 場合はロード失敗である。
 */
function probeWorkerModule(url: string, config: unknown): Promise<WorkerProbeResult> {
  return new Promise<WorkerProbeResult>((resolve) => {
    let settled = false;
    // 生成に失敗した経路では worker が無いまま finish() を通るため、null で初期化する
    // (未代入のまま terminate() を呼ぶと TypeError になり、失敗理由が差し替わってしまう)
    let worker: Worker | null = null;
    const finish = (result: WorkerProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      // プローブの worker は結果が決まった時点で終了させる (後続のテストへ資源を残さない)
      worker?.terminate();
      resolve(result);
    };

    // タイマーは worker の生成より先に用意する (生成が同期で throw する経路でも止める)
    const timer = window.setTimeout(() => {
      finish({
        kind: "timeout",
        message: `${WORKER_PROBE_TIMEOUT_MS} ms 以内に worker から応答もエラーも届かなかった`,
      });
    }, WORKER_PROBE_TIMEOUT_MS);

    try {
      worker = new Worker(url, { type: "module" });
    } catch (error) {
      // URL が不正な場合はここへ来る (生成は同期で失敗し、onerror は発火しない)
      finish({ kind: "error", phase: "construct", message: toErrorMessage(error) });
      return;
    }

    worker.onmessage = (event: MessageEvent) => {
      finish({ kind: "message", data: event.data });
    };
    worker.onerror = (event: ErrorEvent) => {
      // どの成果物で起きたかを追えるように、失敗したスクリプトの位置も文言へ含める
      finish({ kind: "error", phase: "load", message: describeWorkerLoadFailure(event) });
    };
    worker.postMessage({ type: "init", config });
  });
}

/** 配信中 Publisher の観測結果 */
export type PublisherProbeResult =
  | {
      ok: true;
      state: string;
      /** `onError` で通知されたエラー (空配列なら通知なし) */
      errors: string[];
    }
  | { ok: false; error: string };

/** Publisher のハンドル (relay の spec が stop に使う) */
interface PublisherHandle {
  publisher: MediaPublisher;
  dispose: () => void;
  /**
   * `onError` で通知されたエラー
   *
   * 初期化後のエラーは start() の reject には現れず、この通知だけで分かる。spec が
   * 失敗理由を読めるよう、状態取得の戻り値へ含める。
   */
  errors: string[];
}

const publishers = new Map<string, PublisherHandle>();

/**
 * 320x240 の Canvas を塗り続け、`captureStream(30)` の MediaStream を返す
 *
 * カメラを使わないため、CI のヘッドレス Chromium でも映像入力を用意できる。
 */
function createCanvasStream(): { stream: MediaStream; dispose: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d context を取得できなかった");
  }

  const timer = window.setInterval(() => {
    const seconds = Date.now() / 1000;
    context.fillStyle = `rgb(${Math.floor((Math.sin(seconds) + 1) * 127)}, ${Math.floor(
      (Math.sin(seconds + 2) + 1) * 127,
    )}, ${Math.floor((Math.sin(seconds + 4) + 1) * 127)})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 1000 / 30);

  // captureStream は HTMLCanvasElement の標準 API
  const stream = (
    canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
  ).captureStream(30);

  return {
    stream,
    dispose: () => {
      window.clearInterval(timer);
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

/**
 * 公開 API だけで既定の worker 経路を通す
 *
 * `useWorker` は指定しない (既定の true)。start() は接続、PUBLISH の往復、
 * カタログの送信、エンコーダーの configure をこの順に進めるため、成立すれば
 * worker のロードと configure の両方が完了している。実リレーが要るため
 * TEST_MOQT_URI がある実行でだけ使う。
 */
async function startPublisher(options: { url: string; namespace: string[] }): Promise<string> {
  const errors: string[] = [];
  const { stream, dispose } = createCanvasStream();
  let publisher: MediaPublisher;
  try {
    publisher = await createMediaPublisher(
      options.url,
      {
        namespace: options.namespace,
        video: { codec: "vp8", bitrate: 500_000 },
      },
      {
        onError: (error) => {
          errors.push(toErrorMessage(error));
        },
      },
    );
    await publisher.start(stream);
  } catch (error) {
    dispose();
    throw error;
  }

  const id = `publisher-${publishers.size}`;
  publishers.set(id, { publisher, dispose, errors });
  return id;
}

/** 配信中の Publisher の状態を返す */
function getPublisherState(id: string): PublisherProbeResult {
  const handle = publishers.get(id);
  if (handle === undefined) {
    return { ok: false, error: `未知の Publisher ハンドル: ${id}` };
  }
  return { ok: true, state: handle.publisher.state, errors: [...handle.errors] };
}

/** Publisher を停止する */
async function stopPublisher(id: string): Promise<void> {
  const handle = publishers.get(id);
  if (handle === undefined) {
    return;
  }
  publishers.delete(id);
  try {
    await handle.publisher.close();
  } finally {
    handle.dispose();
  }
}

/** 配布物の AudioWorklet を実 Context に読み込み、PCM の出力まで確認する。 */
async function probeAudioOutput(sampleRate: number): Promise<{ played: number; peak: number }> {
  const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
  let peak = 0;
  const url = URL.createObjectURL(
    new Blob(
      [
        `class Capture extends AudioWorkletProcessor { process(inputs){this.port.postMessage(inputs[0][0]?.slice()??new Float32Array(128));return true;} } registerProcessor('production-audio-capture',Capture);`,
      ],
      { type: "text/javascript" },
    ),
  );
  const playout = createMediaPlayout({ audio: { context, destination: context.destination } });
  try {
    await context.audioWorklet.addModule(url);
    const capture = new AudioWorkletNode(context, "production-audio-capture");
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const value of event.data) peak = Math.max(peak, Math.abs(value));
    };
    capture.connect(context.destination);
    playout.setAudioOutput({ context, destination: capture });
    await context.resume();
    await playout.prepareAudio();
    for (let index = 0; index < 5; index++) {
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfFrames: 960,
        numberOfChannels: 1,
        timestamp: index * 20000,
        data: new Float32Array(960).fill(0.2),
      });
      try {
        playout.trackAudioDecodeInput(data.timestamp, { timestampKind: "mediaTime" });
        const result = playout.pushAudio(data);
        if (result.status === "error") throw result.error;
      } finally {
        data.close();
      }
    }
    await playout.drainAudio();
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    return { played: playout.getStats().audio?.timing.playedFrames ?? 0, peak };
  } finally {
    playout.setAudioOutput(null);
    await context.close();
    URL.revokeObjectURL(url);
  }
}

/** Playwright へ公開するテスト API */
export interface ProductionPageApi {
  /** 読み込んだ moqt-js の版 (dist から来る) */
  moqtVersion: string;
  probeAudioOutput(sampleRate: number): Promise<{ played: number; peak: number }>;
  probeWorkerModule(url: string, config: unknown): Promise<WorkerProbeResult>;
  startPublisher(options: { url: string; namespace: string[] }): Promise<string>;
  getPublisherState(id: string): PublisherProbeResult;
  stopPublisher(id: string): Promise<void>;
}

window.__moqtProduction = {
  moqtVersion: version,
  probeAudioOutput,
  probeWorkerModule,
  startPublisher,
  getPublisherState,
  stopPublisher,
};

declare global {
  interface Window {
    __moqtProduction: ProductionPageApi;
  }
}

const statusElement = document.getElementById("status");
if (statusElement !== null) {
  statusElement.textContent = "ready";
}
