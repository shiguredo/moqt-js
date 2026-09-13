import { signal } from "@preact/signals";
import type { Session, Publisher, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { EncoderWrapper } from "../utils/EncoderWrapper";

// Publisher の状態
export const pubSession = signal<Session | null>(null);
export const publisher = signal<Publisher | null>(null);
export const catalogPublisher = signal<Publisher | null>(null);
export const catalog = signal<Catalog | null>(null);
export const encoder = signal<EncoderWrapper | null>(null);
export const mediaStream = signal<MediaStream | null>(null);
export const isPreviewActive = signal(false);
// 停止処理中フラグ（二重実行防止）
export const isStopping = signal(false);

// Forward State の追跡 (draft-ietf-moq-transport-21 Section 3.1)
export const forwardState = signal<boolean | null>(null);

// Publisher のステータス
export const pubStatus = signal<StatusType>("disconnected");
export const pubStatusMessage = signal("配信開始待ち");
export const pubCodec = signal("");

// Publisher の統計値
export const framesEncoded = signal(0);
export const keyFramesEncoded = signal(0);
export const objectsSent = signal(0);
export const pubCurrentGroup = signal(Date.now());
export const bytesSent = signal(0);

// エンコードパイプラインの統計値
export const chunksEncoded = signal(0);
export const encodeErrors = signal(0);
export const encoderState = signal("unconfigured");
export const objectsWithExtensions = signal(0);

// 内部状態
export const frameReader = signal<ReadableStreamDefaultReader<VideoFrame> | null>(null);
export const videoStreamCleanup = signal<(() => void) | null>(null);
export const keyframeInterval = signal(3600);
export const pubCurrentObjectId = signal(0);
