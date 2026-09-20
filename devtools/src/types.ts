export type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

export type VideoSourceType = "dummy" | "camera";

// 音声の入力元。マイクからの取得は扱わないため "none" と "dummy" だけにする。
export type AudioSourceType = "none" | "dummy";

export type AudioCodecType = "opus" | "aac";

export type StatusType = "disconnected" | "connected" | "error";

export interface CameraDevice {
  deviceId: string;
  label: string;
}
