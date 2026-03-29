import { signal } from "@preact/signals";
import type { CameraDevice, CodecType, VideoSourceType } from "../types";
import { isDebugPanelOpen } from "./debug";

// Connection settings
export const url = signal("https://127.0.0.1:4443/moqt");
export const namespace = signal("room/123");
export const trackName = signal("video");
export const codec = signal<CodecType>("vp8");

// Certificate hash for self-signed certificates (base64 encoded SHA-256 hash)
export const certificateHash = signal("");

// Video settings
export const videoSource = signal<VideoSourceType>("dummy");
export const cameraDevices = signal<CameraDevice[]>([]);
export const selectedCameraDeviceId = signal<string>("");
export const resolution = signal("1280x720");
export const framerate = signal(30);
export const bitrate = signal(2000000);
export const keyframeInterval = signal(3600);

// Publish settings
// MAX_CACHE_DURATION: Relay がオブジェクトをキャッシュして良い最大時間（ミリ秒）
// draft-ietf-moq-transport-17 Section 9.2.1.3
// デフォルト: 600000ms (10分)
export const maxCacheDuration = signal(600000);

// Subscribe settings
// Catalog 取得時のタイムアウト（ミリ秒）
// デフォルト: 5000ms (5秒)
export const catalogSubscriptionTimeout = signal(5000);

// WebCodecs Worker settings
// true: Dedicated Worker で Encoder/Decoder を実行（デフォルト）
// false: メインスレッドで実行
export const useDedicatedWorker = signal(true);

// Settings disabled state
export const settingsDisabled = signal(false);

/**
 * カメラデバイス一覧を取得する
 */
export async function fetchCameraDevices(): Promise<void> {
  try {
    // カメラデバイスを取得するには一時的にカメラにアクセスする必要がある
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    for (const track of stream.getTracks()) {
      track.stop();
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${device.deviceId.substring(0, 8)}`,
      }));
    cameraDevices.value = videoDevices;

    // 選択されたデバイスが一覧にない場合は最初のデバイスを選択
    if (videoDevices.length > 0) {
      const selectedExists = videoDevices.some(
        (device) => device.deviceId === selectedCameraDeviceId.value,
      );
      if (!selectedExists) {
        selectedCameraDeviceId.value = videoDevices[0].deviceId;
      }
    }
  } catch (error) {
    console.error("Failed to fetch camera devices:", error);
    cameraDevices.value = [];
  }
}

/**
 * Base64 encoded string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 現在の設定をクエリパラメータ文字列として生成する
 */
export function buildQueryString(): string {
  const params = new URLSearchParams();

  params.set("url", url.value);

  if (namespace.value) {
    params.set("namespace", namespace.value);
  }
  if (trackName.value) {
    params.set("trackName", trackName.value);
  }
  if (codec.value) {
    params.set("codec", codec.value);
  }
  if (certificateHash.value) {
    params.set("certificateHash", certificateHash.value);
  }
  if (videoSource.value) {
    params.set("videoSource", videoSource.value);
  }
  if (selectedCameraDeviceId.value) {
    params.set("cameraDeviceId", selectedCameraDeviceId.value);
  }
  if (resolution.value) {
    params.set("resolution", resolution.value);
  }
  if (framerate.value) {
    params.set("framerate", String(framerate.value));
  }
  if (bitrate.value) {
    params.set("bitrate", String(bitrate.value));
  }
  if (keyframeInterval.value) {
    params.set("keyframeInterval", String(keyframeInterval.value));
  }
  if (maxCacheDuration.value >= 0) {
    params.set("maxCacheDuration", String(maxCacheDuration.value));
  }

  if (isDebugPanelOpen.value) {
    params.set("debug", "1");
  }

  return params.toString();
}

/**
 * URL のクエリパラメータから設定を初期化する
 */
export function initFromUrl(): void {
  const params = new URLSearchParams(window.location.search);

  const urlParam = params.get("url");
  if (urlParam) {
    url.value = urlParam;
  }

  const namespaceParam = params.get("namespace");
  if (namespaceParam) {
    namespace.value = namespaceParam;
  }

  const trackNameParam = params.get("trackName");
  if (trackNameParam) {
    trackName.value = trackNameParam;
  }

  const codecParam = params.get("codec");
  if (codecParam && ["vp8", "vp9", "av1", "h264", "h265"].includes(codecParam)) {
    codec.value = codecParam as CodecType;
  }

  const certificateHashParam = params.get("certificateHash");
  if (certificateHashParam) {
    certificateHash.value = certificateHashParam;
  }

  const videoSourceParam = params.get("videoSource");
  if (videoSourceParam && ["dummy", "camera"].includes(videoSourceParam)) {
    videoSource.value = videoSourceParam as VideoSourceType;
  }

  const cameraDeviceIdParam = params.get("cameraDeviceId");
  if (cameraDeviceIdParam) {
    selectedCameraDeviceId.value = cameraDeviceIdParam;
  }

  const resolutionParam = params.get("resolution");
  if (resolutionParam) {
    resolution.value = resolutionParam;
  }

  const framerateParam = params.get("framerate");
  if (framerateParam) {
    const parsed = Number.parseInt(framerateParam, 10);
    if (!Number.isNaN(parsed)) {
      framerate.value = parsed;
    }
  }

  const bitrateParam = params.get("bitrate");
  if (bitrateParam) {
    const parsed = Number.parseInt(bitrateParam, 10);
    if (!Number.isNaN(parsed)) {
      bitrate.value = parsed;
    }
  }

  const keyframeIntervalParam = params.get("keyframeInterval");
  if (keyframeIntervalParam) {
    const parsed = Number.parseInt(keyframeIntervalParam, 10);
    if (!Number.isNaN(parsed)) {
      keyframeInterval.value = parsed;
    }
  }

  const maxCacheDurationParam = params.get("maxCacheDuration");
  if (maxCacheDurationParam) {
    const parsed = Number.parseInt(maxCacheDurationParam, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      maxCacheDuration.value = parsed;
    }
  }

  const debugParam = params.get("debug");
  if (debugParam === "1") {
    isDebugPanelOpen.value = true;
  }
}
