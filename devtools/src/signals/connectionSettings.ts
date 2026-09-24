import { signal } from "@preact/signals";
import {
  type AuthorizationToken,
  AuthorizationTokenAliasType,
  type CertificateHash,
  toHttpVersionLabel,
} from "moqt-js";
import type {
  AudioCodecType,
  AudioSourceType,
  CameraDevice,
  CodecType,
  VideoSourceType,
} from "../types";
import { base64ToArrayBuffer } from "../utils/base64";
import { extractC4mBase64 } from "../utils/c4m";
import { isResolution } from "../utils/codec";
import { isDebugPanelOpen } from "./debug";

export { toHttpVersionLabel };

// 接続設定
export const url = signal("moqt://127.0.0.1:4443/");
// moqt URI の Fragment Identifier (draft-ietf-moq-transport-21 §6.1.1)
// 入力形式は `type:value` (先頭の `#` は付けない)。空文字列なら fragment を付けない。
export const fragment = signal("");
export const namespace = signal("room/123");
export const trackName = signal("video");
export const codec = signal<CodecType>("vp8");

// 自己署名証明書用の証明書ハッシュ (Base64 でエンコードした SHA-256 ハッシュ)
export const certificateHash = signal("");

// 映像設定
export const videoSource = signal<VideoSourceType>("dummy");
export const cameraDevices = signal<CameraDevice[]>([]);
export const selectedCameraDeviceId = signal<string>("");
export const resolution = signal("1280x720");
export const framerate = signal(30);
export const bitrate = signal(2000000);
export const keyframeInterval = signal(3600);

// 音声設定
//
// 既定は "none" にする。音声トラックを足すと catalog のトラック数が変わり、
// 既存の相互運用の実測 (映像だけの catalog) が変わってしまうため。
// マイクからの取得は扱わない ("dummy" のみ)。
export const audioSource = signal<AudioSourceType>("none");
export const audioCodec = signal<AudioCodecType>("opus");
export const audioBitrate = signal(64000);
export const audioSampleRate = signal(48000);
export const audioChannels = signal(2);

// 配信設定
// MAX_CACHE_DURATION: Relay がオブジェクトをキャッシュして良い最大時間（ミリ秒）
// draft-ietf-moq-transport-21 Section 10.3 (MAX CACHE DURATION)
// デフォルト: 600000ms (10分)
export const maxCacheDuration = signal(600000);

// 購読設定
// Catalog 取得時のタイムアウト（ミリ秒）
// デフォルト: 5000ms (5秒)
export const catalogSubscriptionTimeout = signal(5000);

// WebCodecs Worker 設定
// true: Dedicated Worker で Encoder/Decoder を実行（デフォルト）
// false: メインスレッドで実行
export const useDedicatedWorker = signal(true);

// 設定の無効化状態
export const settingsDisabled = signal(false);

// 現在のセッションの WebTransport.reliability。初期値は "pending"。
// 接続確立時に Session.reliability を反映する。
export const reliability = signal<string>("pending");

// Authorization Token (SETUP オプション 0x03)
// draft-ietf-moq-transport-21 §9.1.4 (AUTHORIZATION TOKEN Setup Option)
// SETUP では DELETE / USE_ALIAS は仕様上禁止 (§9.1.4)。
// REGISTER (0x1) または USE_VALUE (0x3) のみ。
export type AuthorizationTokenAliasTypeUi = "useValue" | "register";
export const authorizationTokenAliasType = signal<AuthorizationTokenAliasTypeUi>("useValue");
// REGISTER 時のみ使用する Token Alias (10 進文字列で保持)
export const authorizationTokenAlias = signal<string>("0");
// Token Type (10 進文字列で保持、デフォルト 0 = out-of-band)
// c4m から取り込んだときは CAT を表す "1" が入る (applyC4mFromUrl)
export const authorizationTokenType = signal<string>("0");
// Token Value (UTF-8 テキスト)。空の場合は送出しない。
export const authorizationTokenValue = signal<string>("");
// MSF URL の c4m パラメータ (Base64 encoded C4M token) から読み込んだトークン。
// 空文字列以外の場合は Token Value より優先し、Base64 を復号した生バイト列を送る。
// draft-ietf-moq-msf-01 §11.1.1 / draft-ietf-moq-c4m-01 §2
export const authorizationTokenBase64 = signal<string>("");

/**
 * 設定値から `AuthorizationToken` を組み立てる。
 *
 * - c4m から読み込み済みの Base64 トークンがあれば、復号した生バイト列を使う。
 * - 無ければ Token Value を UTF-8 として使う。空の場合は `undefined` を返し SETUP Option を送出しない。
 * - Token Alias / Token Type は 10 進文字列をパースする。パース失敗時は `undefined` を返す。
 *
 * draft-ietf-moq-transport-21 §9.20.3 / §9.1.4
 */
export function buildAuthorizationToken(): AuthorizationToken | undefined {
  const base64Value = authorizationTokenBase64.value.trim();
  let tokenValueBytes: Uint8Array;
  if (base64Value.length > 0) {
    tokenValueBytes = new Uint8Array(base64ToArrayBuffer(base64Value));
  } else {
    const value = authorizationTokenValue.value;
    if (value.length === 0) {
      return undefined;
    }
    tokenValueBytes = new TextEncoder().encode(value);
  }

  const tokenTypeStr = authorizationTokenType.value.trim();
  const tokenType = tokenTypeStr.length === 0 ? 0n : safeParseBigInt(tokenTypeStr);
  if (tokenType === undefined) {
    return undefined;
  }

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
 * URL または URI Fragment の c4m パラメータを Authorization Token に反映する。
 *
 * draft-ietf-moq-msf-01 §11.1.1: c4m は Base64 encoded C4M token。
 * draft-ietf-moq-c4m-01 §7.1 Table 4: Token Type 0x01 は CAT。
 * §7.1.1: 0x01 の Token Payload は CBOR エンコードされた CWT として直列化した CAT。
 * draft-ietf-moq-transport-21 §8.9: Token Type 0 は表に無い型であり out-of-band で
 * 交渉するもので、CAT として扱われない。そのため 0x01 を設定する。
 * SETUP の AUTHORIZATION_TOKEN (0x03) では USE_VALUE (0x3) で送るため、Alias Type は
 * useValue のままとする (§9.1.4: SETUP で DELETE / USE_ALIAS を受けたら PROTOCOL_VIOLATION)。
 *
 * @param input Server URL もしくは URI Fragment の入力値
 * @returns c4m を反映した場合は true、c4m が無い / 不正な場合は false
 */
export function applyC4mFromUrl(input: string): boolean {
  const base64 = extractC4mBase64(input);
  if (base64 === undefined) {
    return false;
  }
  authorizationTokenBase64.value = base64;
  // 取り込んだ c4m を優先するため、手入力の Token Value はクリアする
  authorizationTokenValue.value = "";
  authorizationTokenAliasType.value = "useValue";
  authorizationTokenType.value = "1";
  return true;
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
    // 分割代入で先頭要素を取り出す (noUncheckedIndexedAccess で index access は
    // 型上 undefined を含むため、分割代入で回避する)
    const [firstVideoDevice] = videoDevices;
    if (firstVideoDevice !== undefined) {
      const selectedExists = videoDevices.some(
        (device) => device.deviceId === selectedCameraDeviceId.value,
      );
      if (!selectedExists) {
        selectedCameraDeviceId.value = firstVideoDevice.deviceId;
      }
    }
  } catch (error) {
    console.error("Failed to fetch camera devices:", error);
    cameraDevices.value = [];
  }
}

/**
 * `connect()` に渡す MOQT URI を現在の設定から構築する。
 * draft-ietf-moq-transport-21 §6.1.1 (Fragment Identifiers) に従い
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
  if (audioSource.value) {
    params.set("audioSource", audioSource.value);
  }
  if (audioCodec.value) {
    params.set("audioCodec", audioCodec.value);
  }
  if (audioBitrate.value) {
    params.set("audioBitrate", String(audioBitrate.value));
  }
  if (audioSampleRate.value) {
    params.set("audioSampleRate", String(audioSampleRate.value));
  }
  if (audioChannels.value) {
    params.set("audioChannels", String(audioChannels.value));
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

// 音声の選択式設定の許可リスト。ConnectionSettings の select はこの定数から生成し、
// URL の検証も同じ定数を使う (選択肢に無い値を URL が受理すると、select の表示が
// 空になって表示と実際の設定が食い違う)

/** 音声の入力元の選択肢 */
export const AUDIO_SOURCES: readonly AudioSourceType[] = ["none", "dummy"];

/** 音声コーデックの選択肢 */
export const AUDIO_CODECS: readonly AudioCodecType[] = ["opus", "aac"];

/** 音声ビットレートの選択肢 */
export const AUDIO_BITRATES = [32000, 64000, 96000, 128000];

/** 音声サンプルレートの選択肢 */
export const AUDIO_SAMPLE_RATES = [8000, 16000, 24000, 48000];

/** 音声チャンネル数の選択肢。ダミー音声が作れる 1 (mono) と 2 (stereo) だけ */
export const AUDIO_CHANNELS = [1, 2];

/**
 * 音声の入力元として受理できる値かを判定する
 *
 * URL クエリの検証と UI の select の両方で同じ許可リストを使う。
 */
export function isAudioSourceType(value: string): value is AudioSourceType {
  return AUDIO_SOURCES.some((source) => source === value);
}

/**
 * 音声コーデックとして受理できる値かを判定する
 */
export function isAudioCodecType(value: string): value is AudioCodecType {
  return AUDIO_CODECS.some((codec) => codec === value);
}

/**
 * URL のクエリパラメータから音声設定を初期化する
 *
 * 入力元とコーデックは列挙値、数値は ConnectionSettings の select と同じ選択肢
 * (AUDIO_BITRATES / AUDIO_SAMPLE_RATES / AUDIO_CHANNELS) で検証する。
 * 選択肢に無い値を受け入れると select の表示が空になり、表示と実際の設定が食い違う。
 */
function initAudioSettingsFromUrl(params: URLSearchParams): void {
  const audioSourceParam = params.get("audioSource");
  if (audioSourceParam !== null && isAudioSourceType(audioSourceParam)) {
    audioSource.value = audioSourceParam;
  }

  const audioCodecParam = params.get("audioCodec");
  if (audioCodecParam !== null && isAudioCodecType(audioCodecParam)) {
    audioCodec.value = audioCodecParam;
  }

  const audioBitrateParam = params.get("audioBitrate");
  if (audioBitrateParam !== null && AUDIO_BITRATES.includes(Number(audioBitrateParam))) {
    audioBitrate.value = Number(audioBitrateParam);
  }

  const audioSampleRateParam = params.get("audioSampleRate");
  if (audioSampleRateParam !== null && AUDIO_SAMPLE_RATES.includes(Number(audioSampleRateParam))) {
    audioSampleRate.value = Number(audioSampleRateParam);
  }

  const audioChannelsParam = params.get("audioChannels");
  if (audioChannelsParam !== null && AUDIO_CHANNELS.includes(Number(audioChannelsParam))) {
    audioChannels.value = Number(audioChannelsParam);
  }
}

/**
 * URL のクエリパラメータから設定を初期化する
 *
 * c4m の取り込みは Authorization Token のクエリパラメータより後に適用する。
 * c4m を持つ URL と Authorization Token のクエリパラメータを同時に持つ URL では
 * c4m を優先し、クエリの Token Type / Token Value / Token Alias Type を置き換える
 * (url より fragment の c4m を優先する)。c4m が無い入力ではクエリの値をそのまま使う。
 *
 * @param search 検索文字列 (`window.location.search`)
 */
export function initFromUrl(search: string): void {
  const params = new URLSearchParams(search);

  // url / fragment の c4m はクエリの Authorization Token より後に適用して優先させる。
  // fragment に c4m が無い場合でも url の c4m を取り込むため、個別に順に適用する
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
  // 解像度は "WIDTHxHEIGHT" のみ受け付ける。検証せずに保持すると
  // parseResolution が例外を投げ、getUserMedia まで失敗理由が伝わらない。
  if (resolutionParam !== null && isResolution(resolutionParam)) {
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

  initAudioSettingsFromUrl(params);

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

  // c4m を持つ URL では取り込んだトークンを優先する
  // (クエリの Token Type / Token Value / Token Alias Type を置き換える)。
  // url → fragment の順に適用し、fragment の c4m を最優先にする。
  // c4m が無い入力では何も変更しない (applyC4mFromUrl が false を返す)
  if (urlParam) {
    applyC4mFromUrl(urlParam);
  }
  if (fragmentParam) {
    applyC4mFromUrl(fragmentParam);
  }
}
