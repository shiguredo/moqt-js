export type CodecType = "vp8" | "vp9" | "av1" | "h264" | "h265";

// URL クエリ `mode` で選ぶ表示モード。"both" は Publisher と Subscriber の両方、
// "publisher" / "subscriber" は片方だけを表示する
export type DevtoolsMode = "both" | "publisher" | "subscriber";

// 映像の入力元。"none" は映像を送らず音声だけを配信する、"dummy" は Canvas で描いた映像、
// "camera" は選んだカメラ。画面の表示名は Dummy (Canvas) / Camera (gUM)。URL の値は dummy のまま
export type VideoSourceType = "none" | "dummy" | "camera";

// 音声の入力元。"dummy" は Web Audio で作った 440 Hz の音 (映像の Canvas と対になる)、
// "microphone" は選んだ音声入力デバイス。画面の表示名は Dummy (WebAudio)。URL の値は dummy のまま
export type AudioSourceType = "none" | "dummy" | "microphone";

// 音声 Object の送り方。既定は datagram。subgroup はストリームで送る。
// datagram は draft-ietf-moq-transport-22 §11.2 で、reliable-only (WT-H2) では使えない
export type AudioDelivery = "subgroup" | "datagram";

// Stop Publish の止め方。publisher の止め方によって購読者に届く終了通知が変わるため、
// 切り分けのために選べるようにする
// - "publish-done": 各トラックに PUBLISH_DONE (TRACK_ENDED) を送ってからセッションを閉じる (既定)
// - "close-session": PUBLISH_DONE を送らずにセッションだけを閉じる
// - "stop-sending": 何も送らずに配信だけを止める (セッションは維持する)
export type PublishStopMode = "publish-done" | "close-session" | "stop-sending";

export type AudioCodecType = "opus" | "aac";

export type StatusType = "disconnected" | "connected" | "error";

/** 購読しているトラックの終了状態 (画面の表示に使う) */
export interface TrackEndState {
  /** エラーを示す Status Code で終わったか */
  isError: boolean;
  /** Status Code の表示 (名前と 16 進の値。例: "TRACK_ENDED (0x2)") */
  statusLabel: string;
  /** PUBLISH_DONE の Reason Phrase (空文字列あり) */
  reasonPhrase: string;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}
