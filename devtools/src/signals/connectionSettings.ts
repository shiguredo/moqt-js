import { computed, signal } from "@preact/signals";
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
import {
  decodeC4mBase64,
  decodeC4mTokenInfo,
  extractC4mBase64,
  removeC4mParameter,
} from "../utils/c4m";
import { isResolution } from "../utils/codec";
import { KEYFRAME_INTERVAL_OPTIONS } from "../utils/keyframeInterval";
import { parseMsfFragmentFromInput } from "../utils/msfFragment";
import { isDebugPanelOpen } from "./debug";

/** namespace の初期値に使う文字 (a-zA-Z0-9) */
const NAMESPACE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * namespace の初期値に使う 16 文字のランダムな文字列 (a-zA-Z0-9)
 */
function randomNamespaceSuffix(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) {
    // 62 文字への写像。剰余の偏りは namespace の用途では問題にしない
    suffix += NAMESPACE_ALPHABET.charAt(byte % NAMESPACE_ALPHABET.length);
  }
  return suffix;
}

// 接続設定。MOQT URI の初期値は空にする (画面には参考値を placeholder で出す)
export const url = signal("");
// Save を押した MOQT URI。Forget するまで OPFS に残す。null は覚えていない
export const savedServerUrl = signal<string | null>(null);
// MOQT URI の Fragment Identifier (draft-ietf-moq-transport-21 §6.1.1)
// MOQT URI 欄に `#` 以降があれば、その値を映す (先頭の `#` は付けない)。
// 画面では読み取り専用で、変更するときは MOQT URI 欄を編集する。
export const fragment = signal("");
// MOQT URI 欄の fragment を URI Fragment 欄へ映しているかどうか
// true の間は MOQT URI から fragment が消えたら連動して消す
const fragmentFromRelayUri = signal(false);
/**
 * Namespace の初期値
 *
 * 複数の devtools が同じ relay に繋がっても namespace が衝突しないよう、ページごとに
 * ランダムな接尾辞を付ける。共有するときは Copy URL や Save で持ち出す
 */
export const namespace = signal(`moqt/devtools/${randomNamespaceSuffix()}`);
/**
 * msf fragment が指定する Track Namespace のフィールド列
 *
 * MOQT URI / URI Fragment の入力の中の msf fragment から導出する (refreshMsfFragmentSettings)。
 * null は msf fragment が無い状態を表す。値がある間は Namespace の欄を編集できず、接続には
 * このフィールド列をそのまま使う (msf fragment の namespace をユーザーの編集で変えて、
 * 認可された namespace から外れないようにする)。
 */
const msfNamespaceFields = signal<string[] | null>(null);
/**
 * msf fragment により namespace が固定されているかどうか
 *
 * true の間は Connection Settings の Namespace 欄を読み取り専用にする
 */
export const namespaceLocked = computed(() => msfNamespaceFields.value !== null);
// namespace 設定を Track Namespace のフィールドへ分解したもの。空のフィールドは落とす。
// 接続処理と画面表示 (Full Track Name の組み立て) が同じ分解を使う。
// msf fragment があるときはそのフィールド列をそのまま使う (Namespace の欄は `/` 区切りの
// 文字列であり、フィールド自身に `/` を含む namespace を往復できないため)
export const namespaceArray = computed(() => {
  const fields = msfNamespaceFields.value ?? namespace.value.split("/");
  return fields.filter((field) => field.length > 0);
});
/**
 * 音声トラックの役割を表す既定のトラック名
 *
 * c4m の moqt クレームから track name を取り込むとき、許可された名前がこの名前と一致する
 * ときだけ音声トラックの欄へ反映する (c4m のスコープは track の役割を持たないため、
 * 名前が一致するものだけを役割へ対応づける)。値は src/createMedia/settings.ts の
 * DEFAULT_AUDIO_TRACK_NAME と同じにする
 */
const DEFAULT_AUDIO_TRACK_NAME = "audio";
/** 映像トラックの役割を表す既定のトラック名。値は DEFAULT_VIDEO_TRACK_NAME と同じにする */
const DEFAULT_VIDEO_TRACK_NAME = "video";
// 配信するトラックの名前。catalog の track name になり、同じ namespace の中で一意でなければ
// ならない (draft-ietf-moq-msf-01 §5.2.3)。既定値は src/createMedia/settings.ts の
// DEFAULT_VIDEO_TRACK_NAME / DEFAULT_AUDIO_TRACK_NAME と同じにする
export const videoTrackName = signal(DEFAULT_VIDEO_TRACK_NAME);
export const audioTrackName = signal(DEFAULT_AUDIO_TRACK_NAME);
// 映像トラックのコーデック。音声は audioCodec
export const codec = signal<CodecType>("vp9");

// 自己署名証明書用の証明書ハッシュ (Base64 でエンコードした SHA-256 ハッシュ)
export const certificateHash = signal("");

// 映像設定
export const videoSource = signal<VideoSourceType>("dummy");
export const cameraDevices = signal<CameraDevice[]>([]);
export const selectedCameraDeviceId = signal<string>("");
export const resolution = signal("1280x720");
export const framerate = signal(30);
export const bitrate = signal(2000000);
// キーフレーム間隔 (秒)。既定は 10 秒。長い間隔にすると、後から購読した相手が次の
// キーフレームまで復号を始められず、relay の cache 上限も超えやすい。単位は秒であり、
// framerate を変えても実際の間隔は変わらない。共有モジュール (utils/keyframeInterval.ts) の
// DEFAULT_KEYFRAME_INTERVAL は無効な間隔を正規化するときの既定値 (2 秒) で、moqt-devtools の
// この signal の既定には使わない (webcodecs-devtools は同定数を画面の既定にしている)
export const keyframeInterval = signal(10);

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

// Catalog 設定
// 目標遅延 (ms)。null は未指定で、catalog に targetLatency を載せない
// draft-ietf-moq-msf-01 §5.2.8 (targetLatency): 同じ render group と alternate group の
// track は同一の値でなければならない MUST のため、音声と映像の両方の track に同じ値を載せる。
// 0 ms は「符号化から表示まで遅らせない」という有効な指定であり、null (未指定) と区別する
export const targetLatency = signal<number | null>(null);
// 同時レンダリンググループ。null は未指定で、catalog に renderGroup を載せない
// draft-ietf-moq-msf-01 §5.2.11 (renderGroup): 同じ group の track は同時に描画する SHOULD。
// 0 は有効な指定であり、null (未指定) と区別する
export const renderGroup = signal<number | null>(null);

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
//       吸収する (デフォルト。src/playoutBuffer.ts)
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
 * c4m から取り込んだトークンのデコード結果 (画面表示用)
 *
 * draft-ietf-moq-c4m-01 Section 2.1: moqt クレームと主要な CWT クレームを取り出す
 * (署名検証はしない)。トークンが無い場合とデコードできない場合は null
 */
export const c4mTokenInfo = computed(() => {
  const base64 = authorizationTokenBase64.value;
  if (base64.length === 0) {
    return null;
  }
  return decodeC4mTokenInfo(base64) ?? null;
});
/**
 * c4m から取り込んだトークンが許可する exact な track name (画面表示とトラック名の反映に使う)
 *
 * トークンを解除すると空になる
 */
export const c4mTrackNames = computed(() => c4mTokenInfo.value?.trackNames ?? []);
/**
 * c4m のトークンで音声トラック名が固定されているかどうか
 *
 * トークンが exact で `audio` を許可している間は、ユーザーの編集で認可されていない名前に
 * 変えられないように Audio の Track Name 欄を読み取り専用にする。トークンを解除すると
 * 編集できる
 */
export const audioTrackNameLocked = computed(() =>
  c4mTrackNames.value.includes(DEFAULT_AUDIO_TRACK_NAME),
);
/** c4m のトークンで映像トラック名が固定されているかどうか (audioTrackNameLocked と同じ規則) */
export const videoTrackNameLocked = computed(() =>
  c4mTrackNames.value.includes(DEFAULT_VIDEO_TRACK_NAME),
);

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
    // c4m は標準 Base64 と base64url のどちらでも URL に載る。復号できない場合は
    // 送るトークンが無いものとして扱う (取り込み時に検証済みだが、signal は直接
    // 書き換えられるためここでも検証する)
    const decoded = decodeC4mBase64(base64Value);
    if (decoded === undefined) {
      return undefined;
    }
    tokenValueBytes = decoded;
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
 * あわせて、取り込んだトークンの moqt クレームが許可する track name を配信のトラック名へ
 * 反映する (applyTrackNamesFromC4m)。
 *
 * @param input MOQT URI もしくは URI Fragment の入力値
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
  applyTrackNamesFromC4m();
  return true;
}

/**
 * c4m から取り込んだトークンを解除する (Token Type は呼び出し側が決める)
 *
 * moqt-js の `connect()` は MOQT URI の msf fragment の c4m を復号して SETUP の
 * Authorization Token として送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
 * 画面で取り込みを解除しても URL に c4m が残っていると送信が止まらないため、
 * MOQT URI と URI Fragment の両方から c4m パラメータを取り除く。
 *
 * Token Type は触らない。手入力した Token Type を残す経路 (Token Type の編集) があるため、
 * 呼び出し側が決める。
 */
export function discardImportedC4mToken(): void {
  authorizationTokenBase64.value = "";
  url.value = removeC4mParameter(url.value);
  fragment.value = removeC4mParameter(fragment.value);
}

/**
 * c4m から取り込んだトークンを解除し、Token Type を既定の 0 に戻す
 *
 * 取り込んだ c4m の Token Type は CAT (0x01) であり、手入力の UTF-8 トークンを
 * CAT として送らないようにする (draft-ietf-moq-c4m-01 §7.1.1: 0x01 の Payload は
 * CBOR エンコードされた CWT)。
 */
export function clearImportedC4mToken(): void {
  discardImportedC4mToken();
  authorizationTokenType.value = "0";
}

/**
 * c4m の moqt クレームが許可する track name を配信のトラック名へ反映する
 *
 * 署名の検証は行わない (送信するトークンは relay が検証する。ここでは URL のパラメータから
 * 設定を埋めるだけ)。c4m のスコープは track の役割を持たないため、既定のトラック名
 * (audio / video) と exact で一致するものだけを反映する。catalog と events の名前は
 * devtools の固定値であり、欄が無いため対象外にする。
 *
 * draft-ietf-moq-c4m-01 Section 2.1: moqt クレームの scope は track の `bin-match` を持ち、
 * 完全一致はバイト列で表す。prefix / suffix は名前を 1 つに定めないため使わない。
 */
function applyTrackNamesFromC4m(): void {
  const trackNames = c4mTrackNames.value;
  if (trackNames.includes(DEFAULT_AUDIO_TRACK_NAME)) {
    audioTrackName.value = DEFAULT_AUDIO_TRACK_NAME;
  }
  if (trackNames.includes(DEFAULT_VIDEO_TRACK_NAME)) {
    videoTrackName.value = DEFAULT_VIDEO_TRACK_NAME;
  }
}

/**
 * MOQT URI / URI Fragment の入力から msf fragment の namespace を取り込む
 *
 * draft-ietf-moq-msf-01 §11.1.2: msf fragment の track-identifier の `--` より左が
 * Track Namespace のフィールド列 (`-` 区切り) である。msf fragment がある間は namespace を
 * その値に固定する (msfNamespaceFields)。msf fragment が無い入力と解析できない入力では
 * 固定を解除する (入力途中の値で固定が残らないようにする)。
 *
 * URI Fragment 欄に値があればそれを使い、無ければ MOQT URI の fragment を使う
 * (MOQT URI の fragment は URI Fragment 欄へ映しているため、通常はどちらも同じ値になる。
 * MOQT URI に fragment が無いときの手入力が Fragment 欄にだけある状態を拾う)。
 */
export function refreshMsfFragmentSettings(): void {
  const fragmentValue = fragment.value.trim();
  const parsed =
    fragmentValue.length > 0
      ? parseMsfFragmentFromInput(fragmentValue)
      : parseMsfFragmentFromInput(url.value);
  if (parsed === undefined) {
    msfNamespaceFields.value = null;
    return;
  }
  msfNamespaceFields.value = parsed.trackNamespace;
  // Namespace の欄と Copy for LLM / Copy URL の表示にも msf fragment の値を出す
  namespace.value = parsed.trackNamespace.join("/");
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
 * MOQT URI の入力から fragment を取り出す (draft-ietf-moq-transport-21 §6.1.1)
 *
 * `#` 以降が `type:value` の形のときだけ fragment として返す。形になっていない `#` 以降は
 * fragment ではないため null を返す。
 */
function extractRelayUriFragment(input: string): string | null {
  const hashIndex = input.indexOf("#");
  if (hashIndex === -1) {
    return null;
  }
  const fragmentValue = input.slice(hashIndex + 1);
  // fragment type identifier は ASCII 小文字 / 数字 / ハイフン (draft-ietf-moq-transport-21 §6.1.1)
  return /^[a-z0-9-]+:/.test(fragmentValue) ? fragmentValue : null;
}

/**
 * MOQT URI 欄の入力を反映する
 *
 * MOQT URI は fragment を含めたまま保持する (貼り付けた URL から fragment が消えないように
 * する)。URI Fragment 欄には MOQT URI の fragment を映し、あわせて取り込んだ c4m を
 * Authorization Token へ反映し、msf fragment の namespace を固定する。
 *
 * MOQT URI から fragment が消えたときは、URL から映していた fragment も消す
 * (msf fragment を消して namespace の固定を解除できるようにする)。手入力の fragment
 * (MOQT URI に fragment が無いときに URI Fragment 欄へ入れた値) は消さない。
 */
export function applyRelayUriInput(input: string): void {
  url.value = input;
  const fragmentValue = extractRelayUriFragment(input);
  if (fragmentValue !== null) {
    fragment.value = fragmentValue;
    fragmentFromRelayUri.value = true;
  } else if (fragmentFromRelayUri.value) {
    fragment.value = "";
    fragmentFromRelayUri.value = false;
  }
  applyC4mFromUrl(input);
  refreshMsfFragmentSettings();
}

/**
 * URL クエリの url / fragment を url / fragment の signal へ反映する
 *
 * c4m の取り込みは Authorization Token のクエリパラメータより後で行うため、ここでは
 * url / fragment の反映だけを行う。
 */
function splitRelayUriParams(urlParam: string | null, fragmentParam: string | null): void {
  if (urlParam) {
    // MOQT URI は fragment を含めたまま戻す
    url.value = urlParam;
  }

  // MOQT URI の fragment を URI Fragment 欄へ映す。クエリに url が無いときは、
  // 入力欄の値 (Save で覚えていた MOQT URI や URL 全体) も同じ規則で映す
  const fragmentValue = extractRelayUriFragment(url.value);
  if (fragmentValue !== null) {
    fragment.value = fragmentValue;
    fragmentFromRelayUri.value = true;
  }

  if (fragmentParam) {
    // クエリの fragment は MOQT URI の fragment より優先する (共有リンクの値)
    fragment.value = fragmentParam;
    fragmentFromRelayUri.value = false;
  }
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
  // トラック名は映像と音声で別のキーにする。旧 URL の trackName は映像トラック名として
  // 読むだけにし (initFromUrl)、書き出しは videoTrackName / audioTrackName にする
  if (videoTrackName.value) {
    params.set("videoTrackName", videoTrackName.value);
  }
  if (audioTrackName.value) {
    params.set("audioTrackName", audioTrackName.value);
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
  // targetLatency / renderGroup は指定があるときだけ載せる。
  // 0 は有効値のため、0 かどうかではなく未指定 (null) かどうかで判定する
  if (targetLatency.value !== null) {
    params.set("targetLatency", String(targetLatency.value));
  }
  if (renderGroup.value !== null) {
    params.set("renderGroup", String(renderGroup.value));
  }
  // Catalog Timeout は他の数値の設定と同じく常に載せる。Subscriber のページを URL で
  // 渡したときに既定値へ戻らないようにする
  params.set("catalogSubscriptionTimeout", String(catalogSubscriptionTimeout.value));
  // Copy URL は設定をそのまま渡す共有リンクのため、認可トークンの値も載せる。
  // デバッグパネルの「Copy for LLM」は外部へ貼る前提のため、この値と c4m を伏せる
  // (devtools/src/signals/debugExport.ts の maskC4mValue)
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
 * 目標遅延の選択肢 (ミリ秒)
 *
 * ここで選んだ値は catalog に載る宣言であり、購読側が表示の遅れにそのまま使うとは限らない。
 * 購読側は `MAX_PLAYOUT_DELAY_MS` (500 ms) と、表示待ちのキューが吸収できる長さ
 * ((キューの上限 - `PLAYOUT_QUEUE_HEADROOM_FRAMES` (4 枚)) × フレーム間隔) の小さい方へ
 * 切り下げる (`src/playbackTimeline.ts` の `presentationDelayCapMs` / `playoutQueueCapMs`)。
 *
 * - ライブラリの購読はキューが `JITTER_BUFFER_MAX_QUEUED_FRAMES` (24 枚) 固定で 20 枚分に
 *   なるため、30 fps (約 33 ms 間隔) では 20 枚分が約 667 ms になり 500 ms がそのまま
 *   使われるが、60 fps (約 17 ms) では jitter buffer が有効でも約 333 ms に切り下げられる
 * - devtools で jitter buffer を無効にした購読はキューが `MAX_PENDING_FRAMES` (12 枚) に
 *   なって 8 枚分になるため、30 fps でも約 267 ms に切り下げられる
 *
 * 切り下げられた分は購読側の統計の `targetLatencyLimitedMs` で分かる。主な候補は切り下げの
 * 影響が小さい 200 ms 以下にする。
 */
export const TARGET_LATENCY_OPTIONS = [0, 50, 100, 200, 500] as const;

/** 同時レンダリンググループの選択肢 (§5.2.11 の宣言に使う値。0 は有効な指定) */
export const RENDER_GROUP_OPTIONS = [0, 1] as const;

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
 * select と URL クエリの選択式の数値設定を、許可リストで検証して値に写す
 *
 * select の値と URL クエリの値は同じ規則で検証する。空文字は select の「未指定」であり
 * null にする (`Number("")` は 0 になるため、0 が有効値の targetLatency / renderGroup では
 * 未指定と区別できない)。許可リストに無い値と、整数の表記になっていない値 (`50.0` / `1e2`
 * など。値としては等しくても select が作る表記ではない) は受理せず、`current` をそのまま
 * 返す。先頭に 0 が付いた表記 (`"050"`) は値 50 として受理するが、許可リストの値に一致する
 * ため実害は無い (select の表示は 50 になる)。URL の不正な値を受け入れると select の表示が
 * 空になり、表示と実際の設定が食い違う。
 *
 * ConnectionSettings の select の onChange と `initFromUrl` の両方がこれを使うため、
 * 画面から変えたときと URL から復元したときで同じ値になる。
 *
 * @param value - select の値、または URL クエリの値
 * @param options - 受理する値の許可リスト (select の選択肢と同じ定数)
 * @param current - 受理できない値を渡されたときに保つ現在の値
 * @returns 変換した値。空文字は未指定の null
 */
export function resolveOptionNumber(
  value: string,
  options: readonly number[],
  current: number | null,
): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return current;
  }
  const parsed = Number(trimmed);
  return options.includes(parsed) ? parsed : current;
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
 * URL クエリの数値を許可リストで検証し、選択式設定の signal に反映する
 *
 * 値の解釈は select の onChange と同じ `resolveOptionNumber` に任せる。空文字 (select の
 * 「未指定」) は未指定に、許可リストに無い値と整数の表記でない値は現在の値のままにするため、
 * 不正な URL で表示と実際の設定が食い違わない。
 */
function applyOptionNumber(
  params: URLSearchParams,
  name: string,
  options: readonly number[],
  target: { value: number | null },
): void {
  const param = params.get(name);
  if (param === null) {
    return;
  }
  target.value = resolveOptionNumber(param, options, target.value);
}

/**
 * URL のクエリパラメータから設定を初期化する
 *
 * c4m の取り込みは Authorization Token のクエリパラメータより後に適用する。
 * c4m を持つ URL と Authorization Token のクエリパラメータを同時に持つ URL では
 * c4m を優先し、クエリの Token Type / Token Value / Token Alias Type を置き換える。
 * fragment に有効な c4m がある場合は url の c4m より優先し、fragment の c4m が不正な
 * 場合と c4m を持たない入力では何も変更しない (url の c4m が残る)。
 * url に fragment が含まれる場合は、MOQT URI 欄はそのままに fragment を URI Fragment 欄へ
 * 映して復元する (Copy URL も同じ 2 つの値として書き出せる)。
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
  // fragment に c4m が無い場合でも url の c4m を取り込むため、個別に順に適用する。
  // URL に fragment が含まれる場合は、画面で確認できるよう URI Fragment 欄へ分ける
  // (分割だけをここで行い、c4m の取り込みは本文の最後で行う)
  const urlParam = params.get("url");
  const fragmentParam = params.get("fragment");
  splitRelayUriParams(urlParam, fragmentParam);

  const namespaceParam = params.get("namespace");
  if (namespaceParam) {
    namespace.value = namespaceParam;
  }

  // msf fragment の namespace は namespace クエリより優先する (URL の msf fragment が
  // 接続先の namespace を決めるため)。URL の msf fragment と fragment クエリのどちらを
  // 見るかは refreshMsfFragmentSettings が buildConnectUrl と同じ規則で決める
  refreshMsfFragmentSettings();

  // 共有済みの URL の trackName は映像トラック名として読み続ける (互換)。
  // 新しい URL は videoTrackName を使う
  const videoTrackNameParam = params.get("videoTrackName") ?? params.get("trackName");
  if (videoTrackNameParam) {
    videoTrackName.value = videoTrackNameParam;
  }

  const audioTrackNameParam = params.get("audioTrackName");
  if (audioTrackNameParam) {
    audioTrackName.value = audioTrackNameParam;
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

  // キーフレーム間隔は ConnectionSettings の select と同じ許可リストで検証する
  // (検証の規則は applyOptionNumber と同じく resolveOptionNumber に任せる)。選択肢に無い値を
  // 受け入れると select の表示が空になり、表示と実際の設定が食い違う。0 / 負値 / 非整数を
  // 通すと、剰余によるキーフレームの要求が一度も出なくなる。この signal は null を持てない
  // ため、未指定 (空文字) のときは初期値のまま残す
  const keyframeIntervalParam = params.get("keyframeInterval");
  if (keyframeIntervalParam !== null) {
    const resolvedKeyframeInterval = resolveOptionNumber(
      keyframeIntervalParam,
      KEYFRAME_INTERVAL_OPTIONS,
      keyframeInterval.value,
    );
    if (resolvedKeyframeInterval !== null) {
      keyframeInterval.value = resolvedKeyframeInterval;
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

  // targetLatency / renderGroup は ConnectionSettings の select と同じ許可リストで検証する。
  // 選択肢に無い値を受け入れると select の表示が空になり、表示と実際の設定が食い違う。
  // 0 は有効値のため、空文字 (select の「未指定」) は 0 ではなく未指定として反映する
  applyOptionNumber(params, "targetLatency", TARGET_LATENCY_OPTIONS, targetLatency);
  applyOptionNumber(params, "renderGroup", RENDER_GROUP_OPTIONS, renderGroup);

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
  // c4m が無い入力では何も変更しない (applyC4mFromUrl が false を返す)。
  // MOQT URI は fragment を含んだまま復元するため、fragment 欄にだけある手入力の c4m も見る
  if (urlParam) {
    applyC4mFromUrl(urlParam);
  } else {
    // クエリに url が無いときは、入力欄の値 (Save で覚えていた MOQT URI) も見る。
    // その URL に msf fragment と c4m があれば namespace の固定 (initFromUrl の
    // refreshMsfFragmentSettings) と Authorization Token の取り込みをそろえる
    applyC4mFromUrl(url.value);
    applyC4mFromUrl(fragment.value);
  }
  if (fragmentParam) {
    applyC4mFromUrl(fragmentParam);
  }
}
