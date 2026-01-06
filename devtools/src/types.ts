export type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

export type VideoSourceType = "dummy" | "camera";

export type StatusType = "disconnected" | "connected" | "error";

export interface CameraDevice {
  deviceId: string;
  label: string;
}
