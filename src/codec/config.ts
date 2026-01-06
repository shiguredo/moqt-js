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
    description,
  };

  switch (codec) {
    case "vp8":
      return { codec: "vp8", ...baseConfig };
    case "vp9":
      return { codec: "vp09.00.10.08", ...baseConfig };
    case "av1":
      return { codec: "av01.0.04M.08", ...baseConfig };
    case "h264":
      return { codec: "avc1.42001f", ...baseConfig };
    case "h265":
      return { codec: "hvc1.1.6.L93.B0", ...baseConfig };
    default:
      return { codec: "vp8", ...baseConfig };
  }
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
 * オーディオデコーダー設定を取得する
 */
export function getAudioDecoderConfig(
  codec: AudioCodecType,
  sampleRate: number = DEFAULT_AUDIO_SAMPLE_RATE,
  channels: number = DEFAULT_AUDIO_CHANNELS,
): AudioDecoderConfig {
  switch (codec) {
    case "opus":
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
      };
    case "aac":
      return {
        codec: "mp4a.40.2",
        sampleRate,
        numberOfChannels: channels,
      };
    default:
      return {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
      };
  }
}

/**
 * コーデックがサポートされているか確認する
 */
export async function isVideoEncoderSupported(
  codec: VideoCodecType,
  width: number,
  height: number,
): Promise<boolean> {
  try {
    const config = getVideoEncoderConfig(codec, width, height, 1000000, 30);
    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * コーデックがサポートされているか確認する
 */
export async function isVideoDecoderSupported(
  codec: VideoCodecType,
  width: number,
  height: number,
): Promise<boolean> {
  try {
    const config = getVideoDecoderConfig(codec, width, height);
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * オーディオコーデックがサポートされているか確認する
 */
export async function isAudioEncoderSupported(codec: AudioCodecType): Promise<boolean> {
  try {
    const config = getAudioEncoderConfig(codec, 128000);
    const support = await AudioEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * オーディオコーデックがサポートされているか確認する
 */
export async function isAudioDecoderSupported(codec: AudioCodecType): Promise<boolean> {
  try {
    const config = getAudioDecoderConfig(codec);
    const support = await AudioDecoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}
