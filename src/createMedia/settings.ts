/**
 * createMedia 系の設定解決
 *
 * トラック名の既定値は配信 (createMediaPublisher) と購読 (createMediaSubscriber) で
 * 同じ規約を使うため、ここを正本とする。
 *
 * Catalog に載せる値とエンコーダーへ渡す値は一致していなければならない。
 * 一致しないと受信側が Catalog の宣言と異なる設定で復号することになる。
 * 解決を 1 箇所に集約し、Catalog 生成とエンコーダー設定の両方が同じ結果を使う。
 *
 * 映像の解像度は MediaStreamTrack の設定にも依存するため、解決時点の
 * トラック設定を引数で受け取る (呼び出し側で 1 度だけ読む)。
 */

import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_FRAMERATE,
  getAudioEncoderConfig,
  getVideoEncoderConfig,
} from "../codec/config";
import type { AudioPublishOptions, VideoPublishOptions } from "../codec/types";

/** 音声トラック名の既定値 */
export const DEFAULT_AUDIO_TRACK_NAME = "audio";

/** 映像トラック名の既定値 */
export const DEFAULT_VIDEO_TRACK_NAME = "video";

/** 解決済みの音声配信設定 */
export interface ResolvedAudioPublishSettings {
  /** 公開するトラック名 */
  trackName: string;
  /** コーデック種別 */
  codec: AudioPublishOptions["codec"];
  /** Catalog に載せる codec 文字列 (WebCodecs の codec 文字列) */
  codecString: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

/** 解決済みの映像配信設定 */
export interface ResolvedVideoPublishSettings {
  /** 公開するトラック名 */
  trackName: string;
  /** コーデック種別 */
  codec: VideoPublishOptions["codec"];
  /** Catalog に載せる codec 文字列 (WebCodecs の codec 文字列) */
  codecString: string;
  bitrate: number;
  width: number;
  height: number;
  framerate: number;
}

/**
 * 音声配信設定を解決する
 */
export function resolveAudioPublishSettings(
  options: AudioPublishOptions,
): ResolvedAudioPublishSettings {
  const sampleRate = options.sampleRate ?? DEFAULT_AUDIO_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_AUDIO_CHANNELS;
  const config = getAudioEncoderConfig(options.codec, options.bitrate, sampleRate, channels);

  return {
    trackName: options.trackName ?? DEFAULT_AUDIO_TRACK_NAME,
    codec: options.codec,
    codecString: config.codec,
    bitrate: options.bitrate,
    sampleRate,
    channels,
  };
}

/**
 * 映像配信設定を解決する
 *
 * @param options - 映像配信オプション
 * @param track - 解像度の既定値を取得するトラック (未指定なら 640x480)
 */
export function resolveVideoPublishSettings(
  options: VideoPublishOptions,
  track: MediaStreamTrack | undefined,
): ResolvedVideoPublishSettings {
  const settings = track?.getSettings();
  const width = options.width ?? settings?.width ?? 640;
  const height = options.height ?? settings?.height ?? 480;
  const framerate = options.framerate ?? DEFAULT_VIDEO_FRAMERATE;
  const config = getVideoEncoderConfig(options.codec, width, height, options.bitrate, framerate);

  return {
    trackName: options.trackName ?? DEFAULT_VIDEO_TRACK_NAME,
    codec: options.codec,
    codecString: config.codec,
    bitrate: options.bitrate,
    width,
    height,
    framerate,
  };
}
