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
import type { AudioDelivery, AudioPublishOptions, VideoPublishOptions } from "../codec/types";

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
  /**
   * サンプルレート
   *
   * 解決した時点では要求値 (省略時は既定値) であり、音声の取り出し経路を作った時点で
   * 実際に流れる値で解決し直す (withCapturedAudioFormat)。
   */
  sampleRate: number;
  /** チャンネル数。解決時は要求値であり、使い道は `sampleRate` と同じ */
  channels: number;
  /** 音声 Object の送り方 */
  delivery: AudioDelivery;
}

/**
 * 音声の取り出し経路が実際に流す形式
 *
 * `AudioFrameSource` の `sampleRate` / `channels` と同義であり、取り出し方を
 * 知らない層へ渡すために形を絞ったもの
 */
export interface CapturedAudioFormat {
  /** 実際に流れる `AudioData` のサンプルレート */
  readonly sampleRate: number;
  /** 実際に流れる `AudioData` のチャンネル数 */
  readonly channels: number;
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
 *
 * `sampleRate` と `channels` は取り出し経路への要求であり、解決した時点では確定しない。
 * 取り出し経路が返した形式は withCapturedAudioFormat で写す。
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
    // 既定は Subgroup。datagram を指定できるかはセッションの reliability に依存するため、
    // ここでは解決するだけで判定しない (createMediaPublisher の start が判定する)
    delivery: options.delivery ?? "subgroup",
  };
}

/**
 * 取り出した音声の形式で、Catalog と AudioEncoder が使う設定を解決し直す
 *
 * 取り出し経路が実際に流す形式はブラウザが決める (src/audioSource.ts)。Chromium の
 * `AudioEncoder` は `AudioData` の `sampleRate` / `numberOfChannels` が configure の
 * 値と違うと、リサンプルもチャンネル変換もせずにエラーにする (Chromium の実装に依存する
 * 挙動であり、将来変わり得る)。そのため Catalog の `samplerate` / `channelConfig` と
 * エンコーダーの `sampleRate` / `numberOfChannels` には、要求値ではなく取り出した値を使う
 * (両者は必ず一致していなければならない)。
 *
 * draft-ietf-moq-msf-01 §5.2.28 (samplerate) / §5.2.29 (channelConfig) は、audio codec の
 * track に両プロパティを伴わせる MUST を定める。草案の改訂で節番号と規定が変わる可能性が
 * ある。宣言と実際に流れる形式が食い違うと、購読側は宣言と異なる設定で復号することになる。
 *
 * 要求値は取り出し経路への要求としてだけ使う (Web Audio 経路ではその値が形式に
 * なるが、MediaStreamTrackProcessor 経路ではマイクの形式が優先される)。引数の設定は
 * 書き換えず、写した結果を新しい値として返す。
 */
export function withCapturedAudioFormat(
  settings: ResolvedAudioPublishSettings,
  captured: CapturedAudioFormat,
): ResolvedAudioPublishSettings {
  return {
    ...settings,
    sampleRate: captured.sampleRate,
    channels: captured.channels,
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
