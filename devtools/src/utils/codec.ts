import type { CodecType } from "../types";

export function getEncoderConfig(
  codec: CodecType,
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
      // hevc プロパティは Chrome 独自拡張で TypeScript の型定義に含まれない
      return {
        codec: "hvc1.1.6.L93.B0",
        width,
        height,
        bitrate,
        framerate,
        hevc: { format: "annexb" },
      } as VideoEncoderConfig;
    default:
      return { codec: "vp8", width, height, bitrate, framerate };
  }
}

/**
 * Catalog 用の codec 文字列を返す
 *
 * getEncoderConfig と同一の対応表を使う。
 * 対応表の変更は合わせて行うこと。
 */
export function getCatalogCodec(codec: CodecType): string {
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

// "WIDTHxHEIGHT" 形式。先頭 0 と 0 そのものを弾くため [1-9]\d* とする。
// URL クエリの受理判定 (isResolution) と parseResolution で同じ条件を使う。
const RESOLUTION_PATTERN = /^([1-9]\d*)x([1-9]\d*)$/;

/**
 * "WIDTHxHEIGHT" 形式かを判定する
 *
 * URL クエリパラメータの検証に使う。受理した値を parseResolution が
 * 例外にしないことを保証する。
 */
export function isResolution(value: string): boolean {
  const match = RESOLUTION_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  return Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2]));
}

/**
 * "WIDTHxHEIGHT" 形式の解像度指定をパースする
 *
 * URL クエリパラメータ由来の値も渡るため、形式と正の整数であることを検証する。
 * 検証しないと NaN が getUserMedia の制約まで流れ、失敗理由が分かりにくくなる。
 *
 * @param value - "1280x720" 形式の文字列
 * @returns 幅と高さ
 * @throws 形式が "WIDTHxHEIGHT" でない、または 0 以下の場合
 */
export function parseResolution(value: string): { width: number; height: number } {
  const match = RESOLUTION_PATTERN.exec(value);
  const width = match === null ? Number.NaN : Number(match[1]);
  const height = match === null ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error(`invalid resolution: ${value}, expected WIDTHxHEIGHT (e.g. 1280x720)`);
  }
  return { width, height };
}
