import { signal } from "@preact/signals";
import {
  type AuthorizationToken,
  AuthorizationTokenAliasType,
  type CertificateHash,
} from "moqt-js";
import type {
  AudioCodecType,
  AudioDelivery,
  AudioSourceType,
  DevtoolsMode,
  MicrophoneDevice,
  CameraDevice,
  CodecType,
  VideoSourceType,
} from "../types";
import { toAudioOutputDevices, type AudioOutputDevice } from "../utils/audioOutput";
import { base64ToArrayBuffer } from "../utils/base64";
import { extractC4mBase64 } from "../utils/c4m";
import { isResolution } from "../utils/codec";
import { isDebugPanelOpen } from "./debug";

// 接続設定
export const url = signal("moqt://127.0.0.1:4443/");
// Save を押した Relay URI。Forget するまで OPFS に残す。null は覚えていない
export const savedServerUrl = signal<string | null>(null);
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
// キーフレーム間隔 (frames)。既定は framerate 30 の 2 秒ぶんにして、ライブラリの
// 既定 (framerate の 2 倍) と揃える。長い間隔にすると、後から購読した相手が次の
// キーフレームまで復号を始められず、relay の cache 上限も超えやすい
export const keyframeInterval = signal(60);

// 音声設定
//
// 既定は "dummy" (画面では WebAudio)。映像の Canvas と同じく、開いた時点で生成した
// 音を送る。音声なしは "none" を選ぶ (URL では audioSource=none)。
export const audioSource = signal<AudioSourceType>("dummy");
// 音声 Object の送り方。既定は subgroup。datagram のときだけ URL に載せる
export const audioDelivery = signal<AudioDelivery>("subgroup");
export const audioCodec = signal<AudioCodecType>("opus");
export const audioBitrate = signal(64000);
export const audioSampleRate = signal(48000);
export const audioChannels = signal(2);
// 音声入力デバイスの一覧と、選んだデバイス (audioSource が "microphone" のとき使う)
export const microphoneDevices = signal<MicrophoneDevice[]>([]);
export const selectedMicrophoneDeviceId = signal<string>("");
// 再生先の音声出力デバイス。空文字はブラウザの既定。
// Publisher と Subscriber、および Subscriber だけのページで使う
export const audioOutputDevices = signal<AudioOutputDevice[]>([]);
export const selectedAudioOutputDeviceId = signal<string>("");
// マイクの音にかけるブラウザの音声処理。既定はブラウザの既定と同じ有効
export const audioEchoCancellation = signal(true);
export const audioNoiseSuppression = signal(true);
export const audioAutoGainControl = signal(true);

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

// 購読した映像の jitter buffer 設定
// true: 復号したフレームを LOC TIMESTAMP (壁時計) の間隔どおりに表示し、到着の揺らぎを
//       吸収する (デフォルト。utils/playoutBuffer.ts)
// false: 届いたタイミングのまま表示する
export const jitterBufferEnabled = signal(true);

// 設定の無効化状態
export const settingsDisabled = signal(false);

// 表示モード。URL クエリ `mode` で起動時に 1 回だけ決め、ページの中で切り替えない。
// 別のモードのページはヘッダーの副題のリンクから新しいタブで開く
export const mode = signal<DevtoolsMode>("both");

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
 * @param input Relay URI もしくは URI Fragment の入力値
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
 * 音声入力デバイスの一覧を取る
 *
 * カメラと同じく、デバイスのラベルを得るため一時的にマイクへアクセスする。
 * 選んだデバイスが一覧に無ければ先頭のデバイスを選ぶ
 */
export async function fetchMicrophoneDevices(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${device.deviceId.substring(0, 8)}`,
      }));
    microphoneDevices.value = audioDevices;

    const [firstAudioDevice] = audioDevices;
    if (firstAudioDevice !== undefined) {
      const selectedExists = audioDevices.some(
        (device) => device.deviceId === selectedMicrophoneDeviceId.value,
      );
      if (!selectedExists) {
        selectedMicrophoneDeviceId.value = firstAudioDevice.deviceId;
      }
    }
  } catch (error) {
    console.error("Failed to fetch microphone devices:", error);
    microphoneDevices.value = [];
  }
}

/**
 * 音声出力デバイスの一覧を取る
 *
 * selectAudioOutput で出力デバイスの許可を取り、enumerateDevices の audiooutput を
 * 並べる。https://w3c.github.io/mediacapture-output/#dom-mediadevices-selectaudiooutput
 * (この API は将来変わる可能性がある)
 * ピッカーを取り消したときは、今の一覧と選択を残す。
 */
export async function fetchAudioOutputDevices(): Promise<void> {
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: () => Promise<MediaDeviceInfo>;
  };
  try {
    if (typeof mediaDevices.selectAudioOutput === "function") {
      const picked = await mediaDevices.selectAudioOutput();
      selectedAudioOutputDeviceId.value = picked.deviceId;
    }

    const listed = toAudioOutputDevices(await mediaDevices.enumerateDevices());
    audioOutputDevices.value = listed;

    if (
      selectedAudioOutputDeviceId.value !== "" &&
      !listed.some((device) => device.deviceId === selectedAudioOutputDeviceId.value)
    ) {
      const [firstDevice] = listed;
      selectedAudioOutputDeviceId.value = firstDevice?.deviceId ?? "";
    }
  } catch (error) {
    console.error("Failed to fetch audio output devices:", error);
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
 * 現在の設定をクエリパラメータとして組み立てる
 *
 * `targetMode` はこれから作る URL の表示モード。`both` のときは `mode` を載せない
 * (既定値は載せない扱い。jitterBuffer / useDedicatedWorker と同じ)。
 */
function buildQueryParams(targetMode: DevtoolsMode): URLSearchParams {
  const params = new URLSearchParams();

  params.set("url", url.value);

  // both は既定のモードのため載せない。Copy URL で publisher / subscriber の mode を保ち、
  // 副題のリンクでは今の設定のまま対象のモードへ差し替える
  if (targetMode !== "both") {
    params.set("mode", targetMode);
  }

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
  if (audioDelivery.value === "datagram") {
    params.set("audioDelivery", audioDelivery.value);
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
  if (selectedMicrophoneDeviceId.value) {
    params.set("microphoneDeviceId", selectedMicrophoneDeviceId.value);
  }
  if (selectedAudioOutputDeviceId.value) {
    params.set("audioOutputDeviceId", selectedAudioOutputDeviceId.value);
  }
  // 音声処理は既定 (有効) のときは載せず、無効にしたものだけ =0 で載せる
  if (!audioEchoCancellation.value) {
    params.set("audioEchoCancellation", "0");
  }
  if (!audioNoiseSuppression.value) {
    params.set("audioNoiseSuppression", "0");
  }
  if (!audioAutoGainControl.value) {
    params.set("audioAutoGainControl", "0");
  }
  if (maxCacheDuration.value >= 0) {
    params.set("maxCacheDuration", String(maxCacheDuration.value));
  }
  // Catalog Timeout は他の数値の設定と同じく常に載せる。Subscriber のページを URL で
  // 渡したときに既定値へ戻らないようにする
  params.set("catalogSubscriptionTimeout", String(catalogSubscriptionTimeout.value));
  if (authorizationTokenValue.value) {
    params.set("authorizationTokenAliasType", authorizationTokenAliasType.value);
    params.set("authorizationTokenType", authorizationTokenType.value);
    params.set("authorizationTokenValue", authorizationTokenValue.value);
    if (authorizationTokenAliasType.value === "register") {
      params.set("authorizationTokenAlias", authorizationTokenAlias.value);
    }
  }

  // Dedicated Worker は既定で有効のため、無効にしたときだけ載せる
  if (!useDedicatedWorker.value) {
    params.set("useDedicatedWorker", "0");
  }

  // jitter buffer は既定で有効のため、無効にしたときだけ載せる
  if (!jitterBufferEnabled.value) {
    params.set("jitterBuffer", "0");
  }

  if (isDebugPanelOpen.value) {
    params.set("debug", "1");
  }

  return params;
}

/**
 * 現在の設定をクエリパラメータ文字列として生成する
 */
export function buildQueryString(): string {
  return buildQueryParams(mode.value).toString();
}

/**
 * 指定した表示モードのページを開くクエリパラメータ文字列を生成する
 *
 * 現在の接続設定はそのままに `mode` だけを差し替える (`both` では載せない)。
 * ヘッダーの副題のリンクはこれを使い、画面で設定を変えたらリンク先へ反映する
 */
export function buildQueryStringForMode(targetMode: DevtoolsMode): string {
  return buildQueryParams(targetMode).toString();
}

// 選択式設定の許可リスト。ConnectionSettings の select はこの定数から生成し、
// URL の検証も同じ定数を使う (選択肢に無い値を URL が受理すると、select の表示が
// 空になって表示と実際の設定が食い違う)

/** 映像の入力元の選択肢 */
export const VIDEO_SOURCES: readonly VideoSourceType[] = ["none", "dummy", "camera"];

/** 音声の入力元の選択肢 */
export const AUDIO_SOURCES: readonly AudioSourceType[] = ["none", "dummy", "microphone"];

/** 音声 Object の送り方。既定は subgroup で、datagram のときだけ URL に載せる */
export const AUDIO_DELIVERIES: readonly AudioDelivery[] = ["subgroup", "datagram"];

/** 音声コーデックの選択肢 */
export const AUDIO_CODECS: readonly AudioCodecType[] = ["opus", "aac"];

/** 音声ビットレートの選択肢 */
export const AUDIO_BITRATES = [32000, 64000, 96000, 128000];

/** 音声サンプルレートの選択肢 */
export const AUDIO_SAMPLE_RATES = [8000, 16000, 24000, 48000];

/** 音声チャンネル数の選択肢。ダミー音声が作れる 1 (mono) と 2 (stereo) だけ */
export const AUDIO_CHANNELS = [1, 2];

/** 表示モードの選択肢。ヘッダーの副題に並べる順もこの順にする。DevtoolsMode に値を足すときはここにも足す */
export const MODES: readonly DevtoolsMode[] = ["both", "publisher", "subscriber"];

/** Catalog Timeout の選択肢 (ミリ秒) */
export const CATALOG_SUBSCRIPTION_TIMEOUTS = [3000, 5000, 10000, 30000, 60000, 120000, 300000];

/**
 * 表示モードとして受理できる値かを判定する
 *
 * URL クエリの検証と、ヘッダーの副題に並べるモードの列挙で同じ許可リストを使う。
 */
export function isDevtoolsMode(value: string): value is DevtoolsMode {
  return MODES.some((modeValue) => modeValue === value);
}

/**
 * 映像の入力元として受理できる値かを判定する
 *
 * URL クエリの検証と UI の select の両方で同じ許可リストを使う。
 */
export function isVideoSourceType(value: string): value is VideoSourceType {
  return VIDEO_SOURCES.some((source) => source === value);
}

/**
 * 音声の入力元として受理できる値かを判定する
 *
 * URL クエリの検証と UI の select の両方で同じ許可リストを使う。
 */
export function isAudioSourceType(value: string): value is AudioSourceType {
  return AUDIO_SOURCES.some((source) => source === value);
}

/** 音声 Object の送り方として受理できる値かを判定する */
export function isAudioDelivery(value: string): value is AudioDelivery {
  return AUDIO_DELIVERIES.some((delivery) => delivery === value);
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

  const audioDeliveryParam = params.get("audioDelivery");
  if (audioDeliveryParam !== null && isAudioDelivery(audioDeliveryParam)) {
    audioDelivery.value = audioDeliveryParam;
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

  const microphoneDeviceIdParam = params.get("microphoneDeviceId");
  if (microphoneDeviceIdParam) {
    selectedMicrophoneDeviceId.value = microphoneDeviceIdParam;
  }

  const audioOutputDeviceIdParam = params.get("audioOutputDeviceId");
  if (audioOutputDeviceIdParam) {
    selectedAudioOutputDeviceId.value = audioOutputDeviceIdParam;
  }

  // 音声処理は =0 で無効、=1 で有効にする。それ以外の値は無視する
  const applyFlag = (name: string, target: { value: boolean }): void => {
    const param = params.get(name);
    if (param === "0" || param === "1") {
      target.value = param === "1";
    }
  };
  applyFlag("audioEchoCancellation", audioEchoCancellation);
  applyFlag("audioNoiseSuppression", audioNoiseSuppression);
  applyFlag("audioAutoGainControl", audioAutoGainControl);
}

/**
 * URL のクエリパラメータから設定を初期化する
 *
 * c4m の取り込みは Authorization Token のクエリパラメータより後に適用する。
 * c4m を持つ URL と Authorization Token のクエリパラメータを同時に持つ URL では
 * c4m を優先し、クエリの Token Type / Token Value / Token Alias Type を置き換える。
 * fragment に有効な c4m がある場合は url の c4m より優先し、fragment の c4m が不正な
 * 場合と c4m を持たない入力では何も変更しない (url の c4m が残る)。
 *
 * @param search 検索文字列 (`window.location.search`)
 */
export function initFromUrl(search: string): void {
  const params = new URLSearchParams(search);

  // 表示モードは許可リストにある値だけを受理する。無い値や mode の無い URL では
  // both のまま (Publisher と Subscriber の両方を表示する)
  const modeParam = params.get("mode");
  if (modeParam !== null && isDevtoolsMode(modeParam)) {
    mode.value = modeParam;
  }

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
  if (videoSourceParam !== null && isVideoSourceType(videoSourceParam)) {
    videoSource.value = videoSourceParam;
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

  // Catalog Timeout は ConnectionSettings の select と同じ選択肢で検証する。
  // 選択肢に無い値を受け入れると select の表示が空になり、表示と実際の設定が食い違う
  const catalogSubscriptionTimeoutParam = params.get("catalogSubscriptionTimeout");
  if (
    catalogSubscriptionTimeoutParam !== null &&
    CATALOG_SUBSCRIPTION_TIMEOUTS.includes(Number(catalogSubscriptionTimeoutParam))
  ) {
    catalogSubscriptionTimeout.value = Number(catalogSubscriptionTimeoutParam);
  }

  const debugParam = params.get("debug");
  if (debugParam === "1") {
    isDebugPanelOpen.value = true;
  }

  // Dedicated Worker は =0 で無効、=1 で有効にする。それ以外の値は無視する
  const useDedicatedWorkerParam = params.get("useDedicatedWorker");
  if (useDedicatedWorkerParam === "0" || useDedicatedWorkerParam === "1") {
    useDedicatedWorker.value = useDedicatedWorkerParam === "1";
  }

  const jitterBufferParam = params.get("jitterBuffer");
  if (jitterBufferParam === "0" || jitterBufferParam === "1") {
    jitterBufferEnabled.value = jitterBufferParam === "1";
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
