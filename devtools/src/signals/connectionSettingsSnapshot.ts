import type {
  AudioCodecType,
  AudioDelivery,
  AudioSourceType,
  CodecType,
  DevtoolsMode,
  VideoSourceType,
} from "../types";
import { maskC4mValue } from "../utils/c4m";
import type { AuthorizationTokenAliasTypeUi } from "./connectionSettings";
import * as settings from "./connectionSettings";

/**
 * 接続設定のスナップショット
 *
 * 接続設定の signal は接続と URL への書き出し (`buildQueryParams`) が使うほか、
 * デバッグパネルの「Copy for LLM」も設定の一覧をテキストにする。同じ一覧を
 * 2 箇所で手書きすると、設定を足したときにどちらかへ足し忘れる。
 * テキスト用の一覧はこの 1 箇所にまとめる。
 *
 * 認可トークンの値は入れない。コピーしたテキストは外部 (LLM など) へ渡す前提のため、
 * Token Value と c4m の Base64 は載せず、設定されているかどうかと種別だけを持つ。
 * Relay URI と URI Fragment の中の c4m は伏せ字にする (`utils/c4m.ts` の `maskC4mValue`)。
 */
export interface ConnectionSettingsSnapshot {
  /** Relay URI。c4m (Base64 encoded C4M token) は伏せ字にして入る */
  url: string;
  /** URI Fragment (type:value)。c4m は伏せ字にして入る */
  fragment: string;
  /** 表示モード。既定は both */
  mode: DevtoolsMode;
  namespace: string;
  /** 映像トラック名。catalog の映像トラックの名前になる */
  videoTrackName: string;
  /** 音声トラック名。catalog の音声トラックの名前になる (既定は audio) */
  audioTrackName: string;
  codec: CodecType;
  videoSource: VideoSourceType;
  /** 選んだカメラの deviceId。既定は空文字列 (ブラウザが選ぶ) */
  cameraDeviceId: string;
  resolution: string;
  framerateFps: number;
  /** ビットレート (bps) */
  bitrateBps: number;
  /** キーフレーム間隔 (frames) */
  keyframeIntervalFrames: number;
  /** リレーへ要求するキャッシュ時間 (ms) */
  maxCacheDurationMs: number;
  audioSource: AudioSourceType;
  audioDelivery: AudioDelivery;
  audioCodec: AudioCodecType;
  /** 音声のビットレート (bps) */
  audioBitrateBps: number;
  /** 音声のサンプルレート (Hz) */
  audioSampleRateHz: number;
  /** 音声のチャンネル数 */
  audioChannels: number;
  /** 選んだ音声入力の deviceId。既定は空文字列 */
  microphoneDeviceId: string;
  /** 選んだ音声出力の deviceId。既定は空文字列 (音声の再生は購読側で切り替える) */
  audioOutputDeviceId: string;
  audioEchoCancellation: boolean;
  audioNoiseSuppression: boolean;
  audioAutoGainControl: boolean;
  /** 目標遅延 (ms)。未指定は null (指定が無いことを 0 と区別する) */
  targetLatencyMs: number | null;
  /** renderGroup。未指定は null */
  renderGroup: number | null;
  /** Catalog の購読がタイムアウトするまで (ms) */
  catalogSubscriptionTimeoutMs: number;
  /** Certificate Hash (Base64)。未設定は空文字列。証明書の公開情報のため伏せない */
  certificateHash: string;
  /** 認可トークンを送るかどうか。値そのものは持たない */
  authorizationTokenConfigured: boolean;
  /** Token Type (10 進文字列) */
  authorizationTokenType: string;
  /** SETUP での Alias Type。useValue または register */
  authorizationTokenAliasType: AuthorizationTokenAliasTypeUi;
  /** REGISTER のときに使う Token Alias (10 進文字列) */
  authorizationTokenAlias: string;
  /** c4m からトークンを取り込んだかどうか。値そのものは持たない */
  authorizationTokenFromC4m: boolean;
  /** 符号化を Dedicated Worker で行うかどうか */
  useDedicatedWorker: boolean;
  /** jitter buffer を有効にするかどうか */
  jitterBufferEnabled: boolean;
}

/** 現在の接続設定をスナップショットへ変換する */
export function buildConnectionSettingsSnapshot(): ConnectionSettingsSnapshot {
  return {
    // Relay URI と URI Fragment のどちらにも c4m (認可トークン) を書けるため、
    // テキストへ出す値の時点で伏せる
    url: maskC4mValue(settings.url.value),
    fragment: maskC4mValue(settings.fragment.value),
    mode: settings.mode.value,
    namespace: settings.namespace.value,
    videoTrackName: settings.videoTrackName.value,
    audioTrackName: settings.audioTrackName.value,
    codec: settings.codec.value,
    videoSource: settings.videoSource.value,
    cameraDeviceId: settings.selectedCameraDeviceId.value,
    resolution: settings.resolution.value,
    framerateFps: settings.framerate.value,
    bitrateBps: settings.bitrate.value,
    keyframeIntervalFrames: settings.keyframeInterval.value,
    maxCacheDurationMs: settings.maxCacheDuration.value,
    audioSource: settings.audioSource.value,
    audioDelivery: settings.audioDelivery.value,
    audioCodec: settings.audioCodec.value,
    audioBitrateBps: settings.audioBitrate.value,
    audioSampleRateHz: settings.audioSampleRate.value,
    audioChannels: settings.audioChannels.value,
    microphoneDeviceId: settings.selectedMicrophoneDeviceId.value,
    audioOutputDeviceId: settings.selectedAudioOutputDeviceId.value,
    audioEchoCancellation: settings.audioEchoCancellation.value,
    audioNoiseSuppression: settings.audioNoiseSuppression.value,
    audioAutoGainControl: settings.audioAutoGainControl.value,
    targetLatencyMs: settings.targetLatency.value,
    renderGroup: settings.renderGroup.value,
    catalogSubscriptionTimeoutMs: settings.catalogSubscriptionTimeout.value,
    certificateHash: settings.certificateHash.value,
    authorizationTokenConfigured:
      settings.authorizationTokenValue.value.length > 0 ||
      settings.authorizationTokenBase64.value.length > 0,
    authorizationTokenType: settings.authorizationTokenType.value,
    authorizationTokenAliasType: settings.authorizationTokenAliasType.value,
    authorizationTokenAlias: settings.authorizationTokenAlias.value,
    authorizationTokenFromC4m: settings.authorizationTokenBase64.value.length > 0,
    useDedicatedWorker: settings.useDedicatedWorker.value,
    jitterBufferEnabled: settings.jitterBufferEnabled.value,
  };
}
