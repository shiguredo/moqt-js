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

export function getDecoderConfig(
  codec: CodecType,
  width: number,
  height: number,
): VideoDecoderConfig {
  switch (codec) {
    case "vp8":
      return { codec: "vp8", codedWidth: width, codedHeight: height };
    case "vp9":
      return { codec: "vp09.00.10.08", codedWidth: width, codedHeight: height };
    case "av1":
      return { codec: "av01.0.04M.08", codedWidth: width, codedHeight: height };
    case "h264":
      return { codec: "avc1.42001f", codedWidth: width, codedHeight: height };
    case "h265":
      return { codec: "hvc1.1.6.L93.B0", codedWidth: width, codedHeight: height };
    default:
      return { codec: "vp8", codedWidth: width, codedHeight: height };
  }
}

export function parseResolution(value: string): { width: number; height: number } {
  const [w, h] = value.split("x").map(Number);
  return { width: w, height: h };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBitrate(bps: number): string {
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1000 * 1000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / (1000 * 1000)).toFixed(1)} Mbps`;
}
