export type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

export type VideoSourceType = "dummy" | "camera";

// 音声の入力元。"dummy" は生成した 440 Hz の音、"microphone" は選んだ音声入力デバイス
export type AudioSourceType = "none" | "dummy" | "microphone";

export type AudioCodecType = "opus" | "aac";

export type StatusType = "disconnected" | "connected" | "error";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}
