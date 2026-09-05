import { signal } from "@preact/signals";
import {
  type AuthorizationToken,
  AuthorizationTokenAliasType,
  type CertificateHash,
  toHttpVersionLabel,
} from "moqt-js";
import type { CameraDevice, CodecType, VideoSourceType } from "../types";
import { isDebugPanelOpen } from "./debug";

export { toHttpVersionLabel };

// Connection settings
export const url = signal("moqt://127.0.0.1:4443/moqt");
// moqt URI の Fragment Identifier (draft-ietf-moq-transport-20 §3.1.2)
// 入力形式は `type:value` (先頭の `#` は付けない)。空文字列なら fragment を付けない。
export const fragment = signal("");
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
// draft-ietf-moq-transport-20 Section 12.3 (MAX CACHE DURATION)
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

// 現在のセッションの WebTransport.reliability。初期値は "pending"。
// 接続確立時に Session.reliability を反映する。
export const reliability = signal<string>("pending");

// Authorization Token (SETUP Option 0x03)
// draft-ietf-moq-transport-20 §10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
// SETUP では DELETE / USE_ALIAS は仕様上禁止 (§10.2.2)。
// REGISTER (0x1) または USE_VALUE (0x3) のみ。
export type AuthorizationTokenAliasTypeUi = "useValue" | "register";
export const authorizationTokenAliasType = signal<AuthorizationTokenAliasTypeUi>("useValue");
// REGISTER 時のみ使用する Token Alias (10 進文字列で保持)
export const authorizationTokenAlias = signal<string>("0");
// Token Type (10 進文字列で保持、デフォルト 0 = out-of-band)
export const authorizationTokenType = signal<string>("0");
// Token Value (UTF-8 テキスト)。空の場合は送出しない。
export const authorizationTokenValue = signal<string>("");

/**
 * 設定値から `AuthorizationToken` を組み立てる。
 *
 * - Token Value が空の場合は `undefined` を返し SETUP Option を送出しない。
 * - Token Alias / Token Type は 10 進文字列をパースする。パース失敗時は `undefined` を返す。
 *
 * draft-ietf-moq-transport-20 §10.2.2 / §10.3.1.4
 */
export function buildAuthorizationToken(): AuthorizationToken | undefined {
  const value = authorizationTokenValue.value;
  if (value.length === 0) {
    return undefined;
  }
  const tokenTypeStr = authorizationTokenType.value.trim();
  const tokenType = tokenTypeStr.length === 0 ? 0n : safeParseBigInt(tokenTypeStr);
  if (tokenType === undefined) {
    return undefined;
  }
  const tokenValueBytes = new TextEncoder().encode(value);

  if (authorizationTokenAliasType.value === "register") {
    const aliasStr = authorizationTokenAlias.value.trim();
    const tokenAlias = aliasStr.length === 0 ? 0n : safeParseBigInt(aliasStr);
    if (tokenAlias === undefined) {
      return undefined;
    }
    return {
      aliasType: AuthorizationTokenAliasType.REGISTER,
      tokenAlias,
      tokenType,
      tokenValue: tokenValueBytes,
    };
  }
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType,
    tokenValue: tokenValueBytes,
  };
}

/**
 * 10 進文字列を非負の BigInt にパースする。失敗時は `undefined` を返す。
 */
function safeParseBigInt(str: string): bigint | undefined {
  if (!/^[0-9]+$/.test(str)) {
    return undefined;
  }
  try {
    return BigInt(str);
  } catch {
    return undefined;
  }
}

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
 * `connect()` に渡す MOQT URI を現在の設定から構築する。
 * draft-ietf-moq-transport-20 §3.1.2 (Fragment Identifiers) に従い
 * `fragment` が空でなければ `#type:value` を連結する。
 */
export function buildConnectUrl(): string {
  const baseUrl = url.value;
  const fragmentValue = fragment.value.trim();
  if (fragmentValue.length === 0) {
    return baseUrl;
  }
  // baseUrl 末尾に既に fragment があれば差し替える
  const hashIndex = baseUrl.indexOf("#");
  const withoutFragment = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  return `${withoutFragment}#${fragmentValue}`;
}

/**
 * `connect()` に渡すオプション群を現在の設定から構築する。
 * certificateHash と authorizationToken は未設定なら省略する。
 */
export function buildConnectOptions(): {
  serverCertificateHashes?: CertificateHash[];
  authorizationToken?: AuthorizationToken;
} {
  const connectOptions: {
    serverCertificateHashes?: CertificateHash[];
    authorizationToken?: AuthorizationToken;
  } = {};
  if (certificateHash.value) {
    connectOptions.serverCertificateHashes = [
      {
        algorithm: "sha-256",
        value: base64ToArrayBuffer(certificateHash.value),
      },
    ];
  }
  const authToken = buildAuthorizationToken();
  if (authToken) {
    connectOptions.authorizationToken = authToken;
  }
  return connectOptions;
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

  if (fragment.value) {
    params.set("fragment", fragment.value);
  }
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
  if (authorizationTokenValue.value) {
    params.set("authorizationTokenAliasType", authorizationTokenAliasType.value);
    params.set("authorizationTokenType", authorizationTokenType.value);
    params.set("authorizationTokenValue", authorizationTokenValue.value);
    if (authorizationTokenAliasType.value === "register") {
      params.set("authorizationTokenAlias", authorizationTokenAlias.value);
    }
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

  const fragmentParam = params.get("fragment");
  if (fragmentParam) {
    fragment.value = fragmentParam;
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

  const authAliasTypeParam = params.get("authorizationTokenAliasType");
  if (authAliasTypeParam === "useValue" || authAliasTypeParam === "register") {
    authorizationTokenAliasType.value = authAliasTypeParam;
  }
  const authAliasParam = params.get("authorizationTokenAlias");
  if (authAliasParam) {
    authorizationTokenAlias.value = authAliasParam;
  }
  const authTypeParam = params.get("authorizationTokenType");
  if (authTypeParam) {
    authorizationTokenType.value = authTypeParam;
  }
  const authValueParam = params.get("authorizationTokenValue");
  if (authValueParam) {
    authorizationTokenValue.value = authValueParam;
  }
}
