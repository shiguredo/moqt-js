/**
 * コーデック設定ユーティリティ
 */

import type { AudioCodecType, VideoCodecType } from "./types";

// デフォルト値
export const DEFAULT_AUDIO_SAMPLE_RATE = 48000;
export const DEFAULT_AUDIO_CHANNELS = 2;
export const DEFAULT_VIDEO_FRAMERATE = 30;

/**
 * ビデオエンコーダー設定を取得する
 */
export function getVideoEncoderConfig(
  codec: VideoCodecType,
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

/**
 * ビデオデコーダー設定を取得する
 */
export function getVideoDecoderConfig(
  codec: VideoCodecType,
  width: number,
  height: number,
  description?: Uint8Array,
): VideoDecoderConfig {
  const baseConfig = {
    codedWidth: width,
    codedHeight: height,
  };
  const codecString = videoDecoderCodecString(codec);

  // exactOptionalPropertyTypes では optional な description に undefined を渡せないため、
  // 値がある場合だけ載せる
  return description === undefined
    ? { codec: codecString, ...baseConfig }
    : { codec: codecString, ...baseConfig, description };
}

/**
 * 映像デコーダーの codec 文字列を返す
 */
function videoDecoderCodecString(codec: VideoCodecType): string {
  switch (codec) {
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp09.00.10.08";
    case "av1":
      return "av01.0.04M.08";
    case "h264":
      return "avc1.42001f";
    case "h265":
      return "hvc1.1.6.L93.B0";
    default:
      return "vp8";
  }
}

/**
 * サラウンド表記のチャンネル数対応表
 *
 * draft-ietf-moq-msf-01 §5.2.29 は channelConfig を「複雑なチャンネル構成を
 * 記述する柔軟性のために文字列を使う」と定めるだけで、値語彙を定義していない。
 * そのため業界慣用の表記を製品判断でマッピングする。
 *
 * - "5.1": 前方 3 (L/C/R) + 後方 2 (Ls/Rs) + LFE 1 = 6 チャンネル
 * - "7.1": 前方 3 + 側方 2 + 後方 2 + LFE 1 = 8 チャンネル
 *
 * 表に無い複合表記は解決不能として throw する ("quad" や "1.5" のような
 * 非標準表記を暗黙に数値化しない)。
 */
const SURROUND_CHANNEL_COUNTS: ReadonlyMap<string, number> = new Map([
  ["5.1", 6],
  ["7.1", 8],
]);

/**
 * カタログの channelConfig をチャンネル数に解決する
 *
 * draft-ietf-moq-loc-04 §4.1 の名前付き例 mono (→ 1) に対応し、
 * stereo (→ 2) は慣用値として定める。サラウンド系の複合表記は
 * SURROUND_CHANNEL_COUNTS の対応表で解決する。整数文字列は 1 以上の整数
 * (safe integer 範囲内) のみ受理する。
 * 照合は前後空白除去・小文字化して行う。
 * 未指定時は既定チャンネル数を返し、NaN をデコーダに渡さない。
 * 未知の名前・非対応の複合表記・非整数・0 以下・空文字列の明示値は throw する。
 */
export function resolveAudioChannelCount(channelConfig: string | undefined): number {
  if (channelConfig === undefined) {
    return DEFAULT_AUDIO_CHANNELS;
  }
  const normalized = channelConfig.trim().toLowerCase();
  if (normalized === "mono") {
    return 1;
  }
  if (normalized === "stereo") {
    return 2;
  }
  const surroundCount = SURROUND_CHANNEL_COUNTS.get(normalized);
  if (surroundCount !== undefined) {
    return surroundCount;
  }
  if (/^\d+$/.test(normalized)) {
    // 形状検査 (十進整数) を通過した値の範囲検査。safe integer 外は
    // デコーダ側の不明瞭な拒否に委ねずここで throw する
    const count = Number.parseInt(normalized, 10);
    if (count >= 1 && Number.isSafeInteger(count)) {
      return count;
    }
  }
  throw new Error(`unsupported audio channelConfig: ${channelConfig}`);
}

/**
 * オーディオエンコーダー設定を取得する
 */
export function getAudioEncoderConfig(
  codec: AudioCodecType,
  bitrate: number,
  sampleRate: number = DEFAULT_AUDIO_SAMPLE_RATE,
  channels: number = DEFAULT_AUDIO_CHANNELS,
): AudioEncoderConfig {
  switch (codec) {
    case "opus":
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
        bitrate,
      };
    case "aac":
      return {
        codec: "mp4a.40.2",
        sampleRate,
        numberOfChannels: channels,
        bitrate,
      };
    default:
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
        bitrate,
      };
  }
}

/**
 * コーデックが description (AudioSpecificConfig) を必要とするかを返す
 *
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
 * AAC の復号には AudioSpecificConfig が必須である。opus は不要で、渡すと
 * codec delay の適用により復号 timestamp が変わるため運ばない。
 */
export function requiresAudioSpecificConfig(codec: AudioCodecType): boolean {
  return codec === "aac";
}

/**
 * オーディオデコーダー設定を取得する
 */
export function getAudioDecoderConfig(
  codec: AudioCodecType,
  sampleRate: number = DEFAULT_AUDIO_SAMPLE_RATE,
  channels: number = DEFAULT_AUDIO_CHANNELS,
  description?: Uint8Array,
): AudioDecoderConfig {
  switch (codec) {
    case "opus":
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
        // opus は description (OpusHead) を必要としない。渡すと codec delay の適用で
        // 復号 timestamp が変わるため、受け取っても使わない (既存挙動を維持する)
      };
    case "aac":
      // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
      // AAC の復号には AudioSpecificConfig (AudioDecoderConfig.description) が必須。
      // exactOptionalPropertyTypes では undefined を渡せないため、値がある場合だけ載せる
      return description === undefined
        ? { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels }
        : { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, description };
    default:
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
      };
  }
}
