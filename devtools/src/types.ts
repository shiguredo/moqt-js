export type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

// URL クエリ `mode` で選ぶ表示モード。"both" は Publisher と Subscriber の両方、
// "publisher" / "subscriber" は片方だけを表示する
export type DevtoolsMode = "both" | "publisher" | "subscriber";

// 映像の入力元。"none" は映像を送らず音声だけを配信する、"dummy" は Canvas で描いた映像、
// "camera" は選んだカメラ。画面の表示名は Canvas / Camera (gUM)。URL の値は dummy のまま
export type VideoSourceType = "none" | "dummy" | "camera";

// 音声の入力元。"dummy" は Web Audio で作った 440 Hz の音 (映像の Canvas と対になる)、
// "microphone" は選んだ音声入力デバイス。画面の表示名は WebAudio。URL の値は dummy のまま
export type AudioSourceType = "none" | "dummy" | "microphone";

// 音声 Object の送り方。既定は subgroup (ストリーム)。datagram は
// draft-ietf-moq-transport-21 §11.2。reliable-only (WT-H2) では使えない
export type AudioDelivery = "subgroup" | "datagram";

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
