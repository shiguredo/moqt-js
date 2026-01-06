/**
 * MOQT Demo - Publisher & Subscriber
 *
 * Combined demo showcasing both publishing and subscribing functionality
 * using getUserMedia and WebCodecs for encoding/decoding.
 */

import {
  connect,
  LOC,
  type Session,
  type Publisher,
  type Subscriber,
  type MoqtObject,
} from "moqt-js";

// ============================================================================
// DOM Elements
// ============================================================================

// Connection settings
const urlInput = document.getElementById("url") as HTMLInputElement;
const namespaceInput = document.getElementById("namespace") as HTMLInputElement;
const trackNameInput = document.getElementById("trackName") as HTMLInputElement;
const codecSelect = document.getElementById("codec") as HTMLSelectElement;

// Video settings
const videoSourceSelect = document.getElementById("videoSource") as HTMLSelectElement;
const resolutionSelect = document.getElementById("resolution") as HTMLSelectElement;
const framerateSelect = document.getElementById("framerate") as HTMLSelectElement;
const bitrateSelect = document.getElementById("bitrate") as HTMLSelectElement;
const keyframeIntervalSelect = document.getElementById("keyframeInterval") as HTMLSelectElement;

// Publisher elements
const previewBtn = document.getElementById("previewBtn") as HTMLButtonElement;
const publishBtn = document.getElementById("publishBtn") as HTMLButtonElement;
const stopPublishBtn = document.getElementById("stopPublishBtn") as HTMLButtonElement;
const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const pubStatusBadge = document.getElementById("pubStatusBadge") as HTMLSpanElement;
const pubStatus = document.getElementById("pubStatus") as HTMLDivElement;
const pubCodecBadge = document.getElementById("pubCodecBadge") as HTMLDivElement;
const framesEncodedEl = document.getElementById("framesEncoded") as HTMLSpanElement;
const objectsSentEl = document.getElementById("objectsSent") as HTMLSpanElement;
const pubCurrentGroupEl = document.getElementById("pubCurrentGroup") as HTMLSpanElement;
const bytesSentEl = document.getElementById("bytesSent") as HTMLSpanElement;

// Subscriber elements
const subscribeBtn = document.getElementById("subscribeBtn") as HTMLButtonElement;
const stopSubscribeBtn = document.getElementById("stopSubscribeBtn") as HTMLButtonElement;
const remoteCanvas = document.getElementById("remoteCanvas") as HTMLCanvasElement;
const subStatusBadge = document.getElementById("subStatusBadge") as HTMLSpanElement;
const subStatus = document.getElementById("subStatus") as HTMLDivElement;
const subCodecBadge = document.getElementById("subCodecBadge") as HTMLDivElement;
const framesDecodedEl = document.getElementById("framesDecoded") as HTMLSpanElement;
const objectsReceivedEl = document.getElementById("objectsReceived") as HTMLSpanElement;
const subCurrentGroupEl = document.getElementById("subCurrentGroup") as HTMLSpanElement;
const bytesReceivedEl = document.getElementById("bytesReceived") as HTMLSpanElement;

// Canvas context
const ctx = remoteCanvas.getContext("2d")!;

// ============================================================================
// Codec Configuration
// ============================================================================

type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

function getEncoderConfig(
  codec: CodecType,
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): VideoEncoderConfig {
  switch (codec) {
    case "vp8":
      return { codec: "vp8", width, height, bitrate, framerate };
    case "vp9":
      return { codec: "vp09.00.10.08", width, height, bitrate, framerate };
    case "av1":
      return { codec: "av01.0.04M.08", width, height, bitrate, framerate };
    case "h264":
      return {
        codec: "avc1.42001f",
        width,
        height,
        bitrate,
        framerate,
        avc: { format: "annexb" },
      };
    case "h265":
      return {
        codec: "hvc1.1.6.L93.B0",
        width,
        height,
        bitrate,
        framerate,
        hevc: { format: "annexb" },
      };
    default:
      return { codec: "vp8", width, height, bitrate, framerate };
  }
}

function getDecoderConfig(codec: CodecType, width: number, height: number): VideoDecoderConfig {
  switch (codec) {
    case "vp8":
      return { codec: "vp8", codedWidth: width, codedHeight: height };
    case "vp9":
      return { codec: "vp09.00.10.08", codedWidth: width, codedHeight: height };
    case "av1":
      return { codec: "av01.0.04M.08", codedWidth: width, codedHeight: height };
    case "h264":
      return { codec: "avc1.42001f", codedWidth: width, codedHeight: height };
    case "h265":
      return { codec: "hvc1.1.6.L93.B0", codedWidth: width, codedHeight: height };
    default:
      return { codec: "vp8", codedWidth: width, codedHeight: height };
  }
}

function parseResolution(value: string): { width: number; height: number } {
  const [w, h] = value.split("x").map(Number);
  return { width: w, height: h };
}

// ============================================================================
// Dummy Video Generator
// ============================================================================

interface DummyVideoGenerator {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  stop: () => void;
}

function createDummyVideoStream(
  width: number,
  height: number,
  framerate: number,
): DummyVideoGenerator {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }

  let counter = 0;
  const startTime = Date.now();
  const baseHue = Math.floor(Math.random() * 360);
  let animationPhase = 0;
  let animationId: number | null = null;

  function drawFrame(): void {
    if (!ctx) {
      return;
    }

    // 背景をグラデーションで描画
    const saturation = 70 + Math.sin(animationPhase * 0.7) * 5;
    const lightness1 = 50 + Math.sin(animationPhase * 0.5) * 5;
    const lightness2 = 40 + Math.sin(animationPhase * 0.5) * 5;
    const hue = baseHue + Math.sin(animationPhase) * 10;

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${String(hue)}, ${String(saturation)}%, ${String(lightness1)}%)`);
    gradient.addColorStop(
      1,
      `hsl(${String(hue + 15)}, ${String(saturation)}%, ${String(lightness2)}%)`,
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // タイトル
    ctx.fillStyle = "white";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("MOQT DevTools", canvas.width / 2, 20);

    // カウンターを中央に大きく表示
    ctx.font = "bold 64px monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(counter.toString(), canvas.width / 2, canvas.height / 2);

    // 経過時間を下部に表示
    const elapsed = Date.now() - startTime;
    ctx.font = "18px Arial";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${String(elapsed)}ms elapsed`, canvas.width / 2, canvas.height - 50);

    // 解像度表示
    ctx.fillText(
      `${String(width)}x${String(height)} @ ${String(framerate)}fps`,
      canvas.width / 2,
      canvas.height - 20,
    );

    // アニメーションフェーズを進める
    animationPhase += 0.02;
    counter++;
  }

  // 初回描画
  drawFrame();

  // 指定フレームレートで更新
  const interval = Math.floor(1000 / framerate);
  animationId = window.setInterval(drawFrame, interval);

  // captureStream でストリーム取得
  const stream = canvas.captureStream(framerate);

  return {
    stream,
    canvas,
    stop: (): void => {
      if (animationId !== null) {
        clearInterval(animationId);
        animationId = null;
      }
    },
  };
}

// ============================================================================
// Publisher State
// ============================================================================

let pubSession: Session | null = null;
let publisher: Publisher | null = null;
let encoder: VideoEncoder | null = null;
let mediaStream: MediaStream | null = null;
let frameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let videoStreamCleanup: (() => void) | null = null;
let keyframeInterval = 3600;
let isPreviewActive = false;

// Publisher statistics
let framesEncoded = 0;
let objectsSent = 0;
let pubCurrentGroup = Date.now();
let pubCurrentObjectId = 0;
let bytesSent = 0;

// ============================================================================
// Subscriber State
// ============================================================================

let subSession: Session | null = null;
let subscriber: Subscriber | null = null;
let decoder: VideoDecoder | null = null;
let decoderConfigured = false;

// Subscriber statistics
let framesDecoded = 0;
let objectsReceived = 0;
let subCurrentGroup = 0;
let bytesReceived = 0;

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setPubStatus(status: "disconnected" | "connected" | "error", message: string) {
  pubStatus.textContent = message;

  // Reset classes
  pubStatus.className = "mb-4 px-4 py-2 rounded-lg text-sm";

  if (status === "connected") {
    pubStatus.classList.add("bg-green-50", "text-green-700");
    pubStatusBadge.textContent = "Connected";
    pubStatusBadge.className =
      "px-2 py-1 text-xs font-medium rounded-full bg-green-400/30 text-white";
  } else if (status === "error") {
    pubStatus.classList.add("bg-red-50", "text-red-700");
    pubStatusBadge.textContent = "Error";
    pubStatusBadge.className =
      "px-2 py-1 text-xs font-medium rounded-full bg-red-400/30 text-white";
  } else {
    pubStatus.classList.add("bg-slate-100", "text-slate-600");
    pubStatusBadge.textContent = "Ready";
    pubStatusBadge.className = "px-2 py-1 text-xs font-medium rounded-full bg-white/20 text-white";
  }
}

function setSubStatus(status: "disconnected" | "connected" | "error", message: string) {
  subStatus.textContent = message;

  // Reset classes
  subStatus.className = "mb-4 px-4 py-2 rounded-lg text-sm";

  if (status === "connected") {
    subStatus.classList.add("bg-blue-50", "text-blue-700");
    subStatusBadge.textContent = "Connected";
    subStatusBadge.className =
      "px-2 py-1 text-xs font-medium rounded-full bg-blue-400/30 text-white";
  } else if (status === "error") {
    subStatus.classList.add("bg-red-50", "text-red-700");
    subStatusBadge.textContent = "Error";
    subStatusBadge.className =
      "px-2 py-1 text-xs font-medium rounded-full bg-red-400/30 text-white";
  } else {
    subStatus.classList.add("bg-slate-100", "text-slate-600");
    subStatusBadge.textContent = "Ready";
    subStatusBadge.className = "px-2 py-1 text-xs font-medium rounded-full bg-white/20 text-white";
  }
}

function updatePubStats() {
  framesEncodedEl.textContent = framesEncoded.toString();
  objectsSentEl.textContent = objectsSent.toString();
  pubCurrentGroupEl.textContent = pubCurrentGroup.toString();
  bytesSentEl.textContent = formatBytes(bytesSent);
}

function updateSubStats() {
  framesDecodedEl.textContent = framesDecoded.toString();
  objectsReceivedEl.textContent = objectsReceived.toString();
  subCurrentGroupEl.textContent = subCurrentGroup.toString();
  bytesReceivedEl.textContent = formatBytes(bytesReceived);
}

function disableSettings(disabled: boolean): void {
  urlInput.disabled = disabled;
  namespaceInput.disabled = disabled;
  trackNameInput.disabled = disabled;
  codecSelect.disabled = disabled;
  videoSourceSelect.disabled = disabled;
  resolutionSelect.disabled = disabled;
  framerateSelect.disabled = disabled;
  bitrateSelect.disabled = disabled;
  keyframeIntervalSelect.disabled = disabled;
}

// ============================================================================
// Video Source Helper
// ============================================================================

interface VideoStreamResult {
  stream: MediaStream;
  width: number;
  height: number;
  cleanup: () => void;
}

async function getVideoStream(
  source: "dummy" | "camera",
  width: number,
  height: number,
  framerate: number,
): Promise<VideoStreamResult> {
  if (source === "dummy") {
    const generator = createDummyVideoStream(width, height, framerate);
    return {
      stream: generator.stream,
      width,
      height,
      cleanup: (): void => {
        generator.stop();
        for (const track of generator.stream.getTracks()) {
          track.stop();
        }
      },
    };
  }

  // Camera (getUserMedia)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: framerate },
    },
    audio: false,
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("Failed to get video track from camera");
  }

  const settings = videoTrack.getSettings();
  return {
    stream,
    width: settings.width ?? width,
    height: settings.height ?? height,
    cleanup: (): void => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

// ============================================================================
// Publisher Functions
// ============================================================================

async function startPublishing(): Promise<void> {
  try {
    setPubStatus("disconnected", "Connecting...");
    publishBtn.disabled = true;
    previewBtn.disabled = true;
    disableSettings(true);

    const namespace = namespaceInput.value.split("/").filter((s) => s.length > 0);
    const trackName = trackNameInput.value;
    const codec = codecSelect.value as CodecType;
    const videoSource = videoSourceSelect.value as "dummy" | "camera";
    const { width, height } = parseResolution(resolutionSelect.value);
    const framerate = Number(framerateSelect.value);
    const bitrate = Number(bitrateSelect.value);
    keyframeInterval = Number(keyframeIntervalSelect.value);

    // Connect to MOQT server
    pubSession = await connect(urlInput.value, {
      close: () => {
        setPubStatus("disconnected", "Disconnected");
        cleanupPublisher();
      },
      error: (error) => {
        setPubStatus("error", `Error: ${error.message}`);
        cleanupPublisher();
      },
    });

    setPubStatus("connected", "Connected, setting up encoder...");

    // Use existing preview stream or create new one
    let actualWidth: number;
    let actualHeight: number;

    if (isPreviewActive && mediaStream) {
      // Use existing preview stream
      actualWidth = width;
      actualHeight = height;
    } else {
      // Create new video stream
      const videoStreamResult = await getVideoStream(videoSource, width, height, framerate);
      mediaStream = videoStreamResult.stream;
      videoStreamCleanup = videoStreamResult.cleanup;
      actualWidth = videoStreamResult.width;
      actualHeight = videoStreamResult.height;

      // Display local video
      localVideo.srcObject = mediaStream;
    }

    // Get video track
    const videoTrack = mediaStream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error("Failed to get video track");
    }

    // Preview is no longer just preview, it's now publishing
    isPreviewActive = false;
    previewBtn.textContent = "Preview";

    // Create publisher
    publisher = await pubSession.publish(namespace, trackName, {
      error: (error) => {
        console.error("Publisher error:", error);
        setPubStatus("error", `Publish error: ${error.message}`);
      },
    });

    setPubStatus("connected", `Publishing to ${namespace.join("/")}/${trackName}`);

    // Check MediaStreamTrackProcessor availability
    if (typeof MediaStreamTrackProcessor === "undefined") {
      throw new Error("MediaStreamTrackProcessor is not supported in this browser");
    }

    // Create encoder config and check support
    const encoderConfig = getEncoderConfig(codec, actualWidth, actualHeight, bitrate, framerate);

    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      throw new Error(`Codec not supported: ${encoderConfig.codec}`);
    }
    console.log("Encoder config supported:", support.config);

    // Create video encoder
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        handleEncodedChunk(chunk, metadata);
      },
      error: (error) => {
        console.error("Encoder error:", error);
        setPubStatus("error", `Encoder error: ${error.message}`);
      },
    });

    // Configure encoder
    encoder.configure(encoderConfig);

    // Verify encoder state after configure
    if (encoder.state !== "configured") {
      throw new Error(`Encoder failed to configure. State: ${encoder.state}`);
    }
    console.log("Encoder configured successfully. State:", encoder.state);

    // Show codec badge
    pubCodecBadge.textContent = `${codec.toUpperCase()} ${actualWidth}x${actualHeight}`;
    pubCodecBadge.classList.remove("hidden");

    // Process video frames using MediaStreamTrackProcessor
    const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    frameReader = trackProcessor.readable.getReader();
    console.log("Frame reader created");

    // Reset stats
    framesEncoded = 0;
    objectsSent = 0;
    pubCurrentGroup = Date.now();
    pubCurrentObjectId = 0;
    bytesSent = 0;
    updatePubStats();

    // Read and encode frames
    void processFrames();

    stopPublishBtn.disabled = false;
  } catch (error) {
    console.error("Connection error:", error);
    setPubStatus("error", `Failed: ${(error as Error).message}`);
    cleanupPublisher();
    publishBtn.disabled = false;
    disableSettings(false);
  }
}

async function processFrames() {
  if (!frameReader || !encoder) {
    console.error("processFrames: frameReader or encoder is null", { frameReader, encoder });
    return;
  }

  console.log("processFrames: starting frame processing loop");
  console.log("Encoder state:", encoder.state);

  try {
    while (encoder.state === "configured") {
      const { value: frame, done } = await frameReader.read();
      if (done) {
        console.log("processFrames: reader done");
        break;
      }

      if (encoder.encodeQueueSize <= 2) {
        encoder.encode(frame, { keyFrame: framesEncoded % keyframeInterval === 0 });
        framesEncoded++;
        updatePubStats();
      }
      frame.close();
    }
    console.log("processFrames: loop exited. Encoder state:", encoder.state);
  } catch (error) {
    console.error("Frame processing error:", error);
    console.error("Encoder state at error:", encoder?.state);
  }
}

function handleEncodedChunk(
  chunk: EncodedVideoChunk,
  metadata: EncodedVideoChunkMetadata | undefined,
) {
  if (!publisher || publisher.state !== "active") return;

  // New group on keyframe
  if (chunk.type === "key") {
    pubCurrentGroup++;
    pubCurrentObjectId = 0;
  }

  // Pack with LOC format
  const payload = LOC.packVideo(chunk, metadata);
  bytesSent += payload.length;

  // Send object
  publisher.sendObject({
    groupId: pubCurrentGroup,
    objectId: pubCurrentObjectId++,
    payload,
    priority: chunk.type === "key" ? 255 : 128,
  });

  objectsSent++;
  updatePubStats();
}

function cleanupPublisher(): void {
  // Cancel frame reader
  if (frameReader) {
    void frameReader.cancel();
    frameReader = null;
  }

  // Close encoder
  if (encoder) {
    try {
      encoder.close();
    } catch {
      // Ignore
    }
    encoder = null;
  }

  // Cleanup video stream
  if (videoStreamCleanup) {
    videoStreamCleanup();
    videoStreamCleanup = null;
  }
  mediaStream = null;

  // Reset video element
  localVideo.srcObject = null;

  // Close session
  if (pubSession) {
    void pubSession.close();
    pubSession = null;
  }

  publisher = null;

  // Reset UI
  publishBtn.disabled = false;
  previewBtn.disabled = false;
  stopPublishBtn.disabled = true;
  pubCodecBadge.classList.add("hidden");

  // Enable settings if subscriber is not active
  if (!subSession) {
    disableSettings(false);
  }
}

// ============================================================================
// Preview Functions
// ============================================================================

async function startPreview(): Promise<void> {
  try {
    const videoSource = videoSourceSelect.value as "dummy" | "camera";
    const { width, height } = parseResolution(resolutionSelect.value);
    const framerate = Number(framerateSelect.value);

    const sourceLabel = videoSource === "dummy" ? "Dummy" : "Camera";
    setPubStatus(
      "disconnected",
      `Preview: ${sourceLabel} ${String(width)}x${String(height)} @ ${String(framerate)}fps`,
    );

    // Get video stream
    const videoStreamResult = await getVideoStream(videoSource, width, height, framerate);
    mediaStream = videoStreamResult.stream;
    videoStreamCleanup = videoStreamResult.cleanup;

    // Display local video
    localVideo.srcObject = mediaStream;

    isPreviewActive = true;
    previewBtn.textContent = "Stop";
    // Publish button stays enabled - user can publish while previewing
  } catch (error) {
    console.error("Preview error:", error);
    setPubStatus("error", `Preview failed: ${(error as Error).message}`);
  }
}

function stopPreview(): void {
  if (videoStreamCleanup) {
    videoStreamCleanup();
    videoStreamCleanup = null;
  }
  mediaStream = null;
  localVideo.srcObject = null;

  isPreviewActive = false;
  previewBtn.textContent = "Preview";
  publishBtn.disabled = false;
  setPubStatus("disconnected", "Ready to publish");
}

function togglePreview(): void {
  if (isPreviewActive) {
    stopPreview();
  } else {
    void startPreview();
  }
}

async function stopPublishing() {
  setPubStatus("disconnected", "Disconnecting...");
  stopPublishBtn.disabled = true;

  if (publisher && publisher.state === "active") {
    await publisher.done();
  }

  cleanupPublisher();
  setPubStatus("disconnected", "Ready to publish");
}

// ============================================================================
// Subscriber Functions
// ============================================================================

async function startSubscribing() {
  try {
    setSubStatus("disconnected", "Connecting...");
    subscribeBtn.disabled = true;
    disableSettings(true);

    const namespace = namespaceInput.value.split("/").filter((s) => s.length > 0);
    const trackName = trackNameInput.value;

    // Connect to MOQT server
    subSession = await connect(urlInput.value, {
      close: () => {
        setSubStatus("disconnected", "Disconnected");
        cleanupSubscriber();
      },
      error: (error) => {
        setSubStatus("error", `Error: ${error.message}`);
        cleanupSubscriber();
      },
    });

    setSubStatus("connected", "Connected, setting up decoder...");

    // Create video decoder
    decoder = new VideoDecoder({
      output: (frame) => {
        renderFrame(frame);
      },
      error: (error) => {
        console.error("Decoder error:", error);
        setSubStatus("error", `Decoder error: ${error.message}`);
      },
    });

    setSubStatus("connected", "Subscribing...");

    // Reset stats
    framesDecoded = 0;
    objectsReceived = 0;
    subCurrentGroup = 0;
    bytesReceived = 0;
    decoderConfigured = false;
    updateSubStats();

    // Create subscriber
    subscriber = await subSession.subscribe(namespace, trackName, {
      object: (obj: MoqtObject) => {
        handleObject(obj);
      },
      end: () => {
        console.log("Track ended");
        setSubStatus("disconnected", "Stream ended");
        cleanupSubscriber();
      },
      error: (error) => {
        console.error("Subscriber error:", error);
        setSubStatus("error", `Subscribe error: ${error.message}`);
      },
    });

    setSubStatus("connected", `Subscribed to ${namespace.join("/")}/${trackName}`);
    stopSubscribeBtn.disabled = false;
  } catch (error) {
    console.error("Connection error:", error);
    setSubStatus("error", `Failed: ${(error as Error).message}`);
    cleanupSubscriber();
    subscribeBtn.disabled = false;
    disableSettings(false);
  }
}

function renderFrame(frame: VideoFrame) {
  // Resize canvas if needed
  if (remoteCanvas.width !== frame.displayWidth || remoteCanvas.height !== frame.displayHeight) {
    remoteCanvas.width = frame.displayWidth;
    remoteCanvas.height = frame.displayHeight;
  }

  // Draw frame to canvas
  ctx.drawImage(frame, 0, 0);
  frame.close();

  framesDecoded++;
  updateSubStats();
}

function handleObject(obj: MoqtObject) {
  if (!decoder) return;

  objectsReceived++;
  bytesReceived += obj.payload.length;
  subCurrentGroup = Number(obj.groupId);
  updateSubStats();

  try {
    // Unpack LOC format
    const { chunk, decoderConfig } = LOC.unpackVideo(obj.payload);

    // Configure decoder if we have config
    if (decoderConfig && !decoderConfigured) {
      decoder.configure(decoderConfig);
      decoderConfigured = true;

      // Show codec badge
      subCodecBadge.textContent = `${decoderConfig.codec} ${decoderConfig.codedWidth}x${decoderConfig.codedHeight}`;
      subCodecBadge.classList.remove("hidden");
      console.log("Decoder configured:", decoderConfig);
    }

    // Decode if configured
    if (decoderConfigured || chunk.type === "key") {
      // For keyframes without prior config, try to configure with defaults
      if (!decoderConfigured && chunk.type === "key") {
        const codec = codecSelect.value as CodecType;
        const { width, height } = parseResolution(resolutionSelect.value);
        const defaultConfig = getDecoderConfig(codec, width, height);
        decoder.configure(defaultConfig);
        decoderConfigured = true;

        // Show codec badge
        subCodecBadge.textContent = `${defaultConfig.codec} ${width}x${height}`;
        subCodecBadge.classList.remove("hidden");
      }

      decoder.decode(chunk);
    }
  } catch (error) {
    console.error("Failed to decode object:", error);
  }
}

function cleanupSubscriber() {
  // Close decoder
  if (decoder) {
    try {
      decoder.close();
    } catch {
      // Ignore
    }
    decoder = null;
    decoderConfigured = false;
  }

  // Clear canvas
  ctx.fillStyle = "#1e293b"; // slate-800
  ctx.fillRect(0, 0, remoteCanvas.width, remoteCanvas.height);

  // Close session
  if (subSession) {
    void subSession.close();
    subSession = null;
  }

  subscriber = null;

  // Reset UI
  subscribeBtn.disabled = false;
  stopSubscribeBtn.disabled = true;
  subCodecBadge.classList.add("hidden");

  // Enable settings if publisher is not active
  if (!pubSession) {
    disableSettings(false);
  }
}

async function stopSubscribing() {
  setSubStatus("disconnected", "Disconnecting...");
  stopSubscribeBtn.disabled = true;

  if (subscriber && subscriber.state === "active") {
    await subscriber.unsubscribe();
  }

  cleanupSubscriber();
  setSubStatus("disconnected", "Ready to subscribe");
}

// ============================================================================
// Event Listeners
// ============================================================================

previewBtn.addEventListener("click", togglePreview);
publishBtn.addEventListener("click", startPublishing);
stopPublishBtn.addEventListener("click", stopPublishing);
subscribeBtn.addEventListener("click", startSubscribing);
stopSubscribeBtn.addEventListener("click", stopSubscribing);

// ============================================================================
// Initialization
// ============================================================================

setPubStatus("disconnected", "Ready to publish");
setSubStatus("disconnected", "Ready to subscribe");

// Clear canvas on load
ctx.fillStyle = "#1e293b"; // slate-800
ctx.fillRect(0, 0, remoteCanvas.width, remoteCanvas.height);
