import { signal, computed } from "@preact/signals";
import { createDummyVideoStream, type DummyVideoGenerator } from "./utils/dummyVideo";

// デバイス情報
export interface MediaDevice {
  deviceId: string;
  label: string;
}

// 映像ソースタイプ
export type VideoSourceType = "dummy" | "camera";

// 映像ソース設定
export const videoSource = signal<VideoSourceType>("dummy");
export const videoDevices = signal<MediaDevice[]>([]);
export const selectedVideoDeviceId = signal("");

// デバイス取得エラー
export const deviceError = signal("");

// エンコーダー設定
export const videoCodec = signal("vp09.00.10.08");
export const resolution = signal("960x540");
export const framerate = signal(30);
export const bitrate = signal(2_000_000);
export const keyframeInterval = signal(3600);

// Worker モード
export type WorkerMode = "none" | "dedicated";
export const encoderWorkerMode = signal<WorkerMode>("none");
export const decoderWorkerMode = signal<WorkerMode>("none");

// 解像度から幅と高さを取得する
export const width = computed(() => {
  const [w] = resolution.value.split("x").map(Number);
  return w;
});

export const height = computed(() => {
  const [, h] = resolution.value.split("x").map(Number);
  return h;
});

// エンコーダー/デコーダーの状態
export type CodecStatus = "unconfigured" | "configured" | "closed";

export const encoderStatus = signal<CodecStatus>("unconfigured");
export const decoderStatus = signal<CodecStatus>("unconfigured");

// エラーメッセージ
export const encoderError = signal("");
export const decoderError = signal("");

// 統計情報
export interface CodecStats {
  frameCount: number;
  keyFrameCount: number;
  totalBytes: number;
  lastFrameTimestamp: number;
  averageBitrate: number;
}

export const encoderStats = signal<CodecStats>({
  frameCount: 0,
  keyFrameCount: 0,
  totalBytes: 0,
  lastFrameTimestamp: 0,
  averageBitrate: 0,
});

export const decoderStats = signal<CodecStats>({
  frameCount: 0,
  keyFrameCount: 0,
  totalBytes: 0,
  lastFrameTimestamp: 0,
  averageBitrate: 0,
});

// フレームログ
export interface FrameLog {
  timestamp: number;
  type: "key" | "delta";
  size: number;
  duration: number;
}

export const encodedFrames = signal<FrameLog[]>([]);
export const decodedFrames = signal<FrameLog[]>([]);

// エンコーダー/デコーダーインスタンス
let videoEncoder: VideoEncoder | null = null;
let videoDecoder: VideoDecoder | null = null;

// Worker インスタンス
let encoderWorker: Worker | null = null;
let decoderWorker: Worker | null = null;

// ダミー映像ジェネレーター
let dummyVideoGenerator: DummyVideoGenerator | null = null;

// MediaStream
export const mediaStream = signal<MediaStream | null>(null);
export const isCapturing = signal(false);

// 開始時刻
let startTime = 0;

// 設定が無効かどうか
export const settingsDisabled = computed(() => isCapturing.value);

/**
 * デバイス一覧を取得する
 */
export async function fetchDevices(): Promise<void> {
  deviceError.value = "";

  try {
    // デバイスを取得するには一時的にメディアにアクセスする必要がある
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    // 映像入力デバイス
    const videoInputs = devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${device.deviceId.substring(0, 8)}`,
      }));
    videoDevices.value = videoInputs;

    if (videoInputs.length > 0 && !selectedVideoDeviceId.value) {
      selectedVideoDeviceId.value = videoInputs[0].deviceId;
    }
  } catch (error) {
    const message = (error as Error).message;
    deviceError.value = message;
    console.error("Failed to fetch devices:", error);
  }
}

/**
 * タイムスタンプをフォーマットする
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/**
 * バイト数をフォーマットする
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * ビットレートをフォーマットする
 */
export function formatBitrate(bps: number): string {
  if (bps < 1000) {
    return `${bps} bps`;
  }
  if (bps < 1_000_000) {
    return `${(bps / 1000).toFixed(2)} kbps`;
  }
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

/**
 * Worker をクリーンアップする
 */
function cleanupEncoderWorker(): void {
  if (encoderWorker) {
    encoderWorker.postMessage({ type: "close" });
    encoderWorker.terminate();
    encoderWorker = null;
  }
}

function cleanupDecoderWorker(): void {
  if (decoderWorker) {
    decoderWorker.postMessage({ type: "close" });
    decoderWorker.terminate();
    decoderWorker = null;
  }
}

/**
 * エンコーダーを設定する
 */
export async function configureEncoder(): Promise<void> {
  // 既存のエンコーダー/Worker をクリーンアップ
  if (videoEncoder) {
    videoEncoder.close();
    videoEncoder = null;
  }
  cleanupEncoderWorker();

  encoderError.value = "";

  try {
    const config: VideoEncoderConfig = {
      codec: videoCodec.value,
      width: width.value,
      height: height.value,
      framerate: framerate.value,
      bitrate: bitrate.value,
    };

    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error("エンコーダー設定がサポートされていません");
    }

    const mode = encoderWorkerMode.value;

    if (mode === "none") {
      // メインスレッドで実行
      videoEncoder = new VideoEncoder({
        output: handleEncodedChunk,
        error: (error) => {
          encoderError.value = error.message;
          encoderStatus.value = "closed";
        },
      });
      videoEncoder.configure(config);
      encoderStatus.value = "configured";
    } else if (mode === "dedicated") {
      // DedicatedWorker を使用
      encoderWorker = new Worker(new URL("./workers/encoder.worker.ts", import.meta.url), {
        type: "module",
      });

      encoderWorker.onmessage = (e) => {
        if (e.data.type === "configured") {
          encoderStatus.value = "configured";
        } else if (e.data.type === "encoded") {
          handleEncodedChunkFromWorker(e.data);
        } else if (e.data.type === "error") {
          encoderError.value = e.data.message;
          encoderStatus.value = "closed";
        }
      };

      encoderWorker.postMessage({ type: "init", config });
    }

    // デコーダーも設定する
    await configureDecoder();
  } catch (error) {
    encoderError.value = (error as Error).message;
    encoderStatus.value = "closed";
  }
}

/**
 * デコーダーを設定する
 */
async function configureDecoder(): Promise<void> {
  // 既存のデコーダー/Worker をクリーンアップ
  if (videoDecoder) {
    videoDecoder.close();
    videoDecoder = null;
  }
  cleanupDecoderWorker();

  decoderError.value = "";

  try {
    const config: VideoDecoderConfig = {
      codec: videoCodec.value,
      codedWidth: width.value,
      codedHeight: height.value,
    };

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error("デコーダー設定がサポートされていません");
    }

    const mode = decoderWorkerMode.value;

    if (mode === "none") {
      // メインスレッドで実行
      videoDecoder = new VideoDecoder({
        output: handleDecodedFrame,
        error: (error) => {
          decoderError.value = error.message;
          decoderStatus.value = "closed";
        },
      });
      videoDecoder.configure(config);
      decoderStatus.value = "configured";
    } else if (mode === "dedicated") {
      // DedicatedWorker を使用
      decoderWorker = new Worker(new URL("./workers/decoder.worker.ts", import.meta.url), {
        type: "module",
      });

      decoderWorker.onmessage = (e) => {
        if (e.data.type === "configured") {
          decoderStatus.value = "configured";
        } else if (e.data.type === "decoded") {
          handleDecodedFrame(e.data.frame);
        } else if (e.data.type === "error") {
          decoderError.value = e.data.message;
          decoderStatus.value = "closed";
        }
      };

      decoderWorker.postMessage({ type: "init", config });
    }
  } catch (error) {
    decoderError.value = (error as Error).message;
    decoderStatus.value = "closed";
  }
}

/**
 * Worker からのエンコード結果を処理する共通関数
 */
function processEncodedData(
  chunkType: "key" | "delta",
  size: number,
  data: ArrayBuffer,
  timestamp: number,
  duration: number,
): void {
  const isKeyFrame = chunkType === "key";
  const now = Date.now();

  // 統計を更新
  const stats = encoderStats.value;
  const elapsed = (now - startTime) / 1000;
  const newTotalBytes = stats.totalBytes + size;
  const averageBitrate = elapsed > 0 ? (newTotalBytes * 8) / elapsed : 0;

  encoderStats.value = {
    frameCount: stats.frameCount + 1,
    keyFrameCount: stats.keyFrameCount + (isKeyFrame ? 1 : 0),
    totalBytes: newTotalBytes,
    lastFrameTimestamp: now,
    averageBitrate,
  };

  // フレームログを追加
  const frameLog: FrameLog = {
    timestamp: now,
    type: isKeyFrame ? "key" : "delta",
    size,
    duration,
  };

  const frames = encodedFrames.value;
  if (frames.length >= 100) {
    encodedFrames.value = [...frames.slice(-99), frameLog];
  } else {
    encodedFrames.value = [...frames, frameLog];
  }

  // デコーダーに渡す
  sendToDecoder(chunkType, data, timestamp, duration);
}

/**
 * エンコードされたチャンクを処理する (メインスレッド用)
 */
function handleEncodedChunk(chunk: EncodedVideoChunk): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  processEncodedData(
    chunk.type,
    chunk.byteLength,
    data.buffer,
    chunk.timestamp,
    chunk.duration ?? 0,
  );
}

/**
 * Worker からのエンコード結果を処理する
 */
function handleEncodedChunkFromWorker(workerData: {
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number;
}): void {
  processEncodedData(
    workerData.chunkType,
    workerData.data.byteLength,
    workerData.data,
    workerData.timestamp,
    workerData.duration,
  );
}

/**
 * デコーダーにデータを送信する
 */
function sendToDecoder(
  chunkType: "key" | "delta",
  data: ArrayBuffer,
  timestamp: number,
  duration: number,
): void {
  const mode = decoderWorkerMode.value;

  if (mode === "none") {
    // メインスレッドのデコーダーを使用
    if (videoDecoder && decoderStatus.value === "configured") {
      const chunk = new EncodedVideoChunk({
        type: chunkType,
        timestamp,
        duration,
        data,
      });
      videoDecoder.decode(chunk);
    }
  } else if (mode === "dedicated" && decoderWorker) {
    // DedicatedWorker に送信
    const buffer = data.slice(0);
    decoderWorker.postMessage(
      {
        type: "decode",
        data: buffer,
        chunkType,
        timestamp,
        duration,
      },
      [buffer],
    );
  }
}

/**
 * デコードされたフレームを処理する
 */
function handleDecodedFrame(frame: VideoFrame): void {
  const now = Date.now();

  // 統計を更新
  const stats = decoderStats.value;
  const elapsed = (now - startTime) / 1000;
  const frameSize = frame.allocationSize();
  const newTotalBytes = stats.totalBytes + frameSize;
  const averageBitrate = elapsed > 0 ? (newTotalBytes * 8) / elapsed : 0;

  decoderStats.value = {
    frameCount: stats.frameCount + 1,
    keyFrameCount: stats.keyFrameCount,
    totalBytes: newTotalBytes,
    lastFrameTimestamp: now,
    averageBitrate,
  };

  // フレームログを追加
  const frameLog: FrameLog = {
    timestamp: now,
    type: "delta",
    size: frameSize,
    duration: frame.duration ?? 0,
  };

  const frames = decodedFrames.value;
  if (frames.length >= 100) {
    decodedFrames.value = [...frames.slice(-99), frameLog];
  } else {
    decodedFrames.value = [...frames, frameLog];
  }

  // キャンバスに描画
  const canvas = document.getElementById("decoded-canvas") as HTMLCanvasElement | null;
  if (canvas) {
    const context = canvas.getContext("2d");
    if (context) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      context.drawImage(frame, 0, 0);
    }
  }

  frame.close();
}

/**
 * キャプチャを開始する
 */
export async function startCapture(): Promise<void> {
  if (isCapturing.value) {
    return;
  }

  if (encoderStatus.value !== "configured") {
    await configureEncoder();
  }

  if (encoderStatus.value !== "configured") {
    return;
  }

  try {
    let stream: MediaStream;

    if (videoSource.value === "dummy") {
      // ダミー映像を使用
      dummyVideoGenerator = createDummyVideoStream(width.value, height.value, framerate.value);
      stream = dummyVideoGenerator.stream;
    } else {
      // カメラを使用
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: selectedVideoDeviceId.value
            ? { exact: selectedVideoDeviceId.value }
            : undefined,
          width: { ideal: width.value },
          height: { ideal: height.value },
          frameRate: { ideal: framerate.value },
        },
        audio: false,
      });
    }

    mediaStream.value = stream;
    isCapturing.value = true;
    startTime = Date.now();

    // ビデオ要素に表示
    const video = document.getElementById("source-video") as HTMLVideoElement | null;
    if (video) {
      video.srcObject = stream;
      await video.play();
    }

    // フレームをキャプチャしてエンコード
    const track = stream.getVideoTracks()[0];
    if (track) {
      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();

      const processFrame = async () => {
        if (!isCapturing.value) {
          reader.releaseLock();
          return;
        }

        try {
          const { value: frame, done } = await reader.read();
          if (done) {
            return;
          }

          if (encoderStatus.value === "configured") {
            const keyFrame = encoderStats.value.frameCount % keyframeInterval.value === 0;
            const mode = encoderWorkerMode.value;

            if (mode === "none" && videoEncoder) {
              // メインスレッドで実行
              videoEncoder.encode(frame, { keyFrame });
              frame.close();
            } else if (mode === "dedicated" && encoderWorker) {
              // DedicatedWorker に送信
              encoderWorker.postMessage({ type: "encode", frame, keyFrame }, [frame]);
            } else {
              frame.close();
            }
          } else {
            frame.close();
          }

          void processFrame();
        } catch {
          // キャプチャが停止された場合
        }
      };

      void processFrame();
    }
  } catch (error) {
    encoderError.value = (error as Error).message;
  }
}

/**
 * キャプチャを停止する
 */
export function stopCapture(): void {
  if (!isCapturing.value) {
    return;
  }

  isCapturing.value = false;

  // ダミー映像ジェネレーターを停止
  if (dummyVideoGenerator) {
    dummyVideoGenerator.stop();
    dummyVideoGenerator = null;
  }

  if (mediaStream.value) {
    for (const track of mediaStream.value.getTracks()) {
      track.stop();
    }
    mediaStream.value = null;
  }

  const video = document.getElementById("source-video") as HTMLVideoElement | null;
  if (video) {
    video.srcObject = null;
  }
}

/**
 * エンコーダーをリセットする
 */
export function resetEncoder(): void {
  stopCapture();

  // メインスレッドのエンコーダー/デコーダーをクローズ
  if (videoEncoder) {
    videoEncoder.close();
    videoEncoder = null;
  }

  if (videoDecoder) {
    videoDecoder.close();
    videoDecoder = null;
  }

  // Worker をクリーンアップ
  cleanupEncoderWorker();
  cleanupDecoderWorker();

  encoderStatus.value = "unconfigured";
  decoderStatus.value = "unconfigured";
  encoderError.value = "";
  decoderError.value = "";

  encoderStats.value = {
    frameCount: 0,
    keyFrameCount: 0,
    totalBytes: 0,
    lastFrameTimestamp: 0,
    averageBitrate: 0,
  };

  decoderStats.value = {
    frameCount: 0,
    keyFrameCount: 0,
    totalBytes: 0,
    lastFrameTimestamp: 0,
    averageBitrate: 0,
  };

  encodedFrames.value = [];
  decodedFrames.value = [];

  // Decoded Output のキャンバスをクリア
  const canvas = document.getElementById("decoded-canvas") as HTMLCanvasElement | null;
  if (canvas) {
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

/**
 * フレームログをクリアする
 */
export function clearFrameLogs(): void {
  encodedFrames.value = [];
  decodedFrames.value = [];
}
