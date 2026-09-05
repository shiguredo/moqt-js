import { signal } from "@preact/signals";
import type { Session, Publisher, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { EncoderWrapper } from "../utils/EncoderWrapper";

// Publisher state
export const pubSession = signal<Session | null>(null);
export const publisher = signal<Publisher | null>(null);
export const catalogPublisher = signal<Publisher | null>(null);
export const catalog = signal<Catalog | null>(null);
export const encoder = signal<EncoderWrapper | null>(null);
export const mediaStream = signal<MediaStream | null>(null);
export const isPreviewActive = signal(false);
// 停止処理中フラグ（二重実行防止）
export const isStopping = signal(false);

// Forward State (draft-ietf-moq-transport-20 Section 5.1)
export const forwardState = signal<boolean | null>(null);

// Publisher status
export const pubStatus = signal<StatusType>("disconnected");
export const pubStatusMessage = signal("Ready to publish");
export const pubCodec = signal("");

// Publisher statistics
export const framesEncoded = signal(0);
export const keyFramesEncoded = signal(0);
export const objectsSent = signal(0);
export const pubCurrentGroup = signal(Date.now());
export const bytesSent = signal(0);

// Encoding pipeline statistics
export const chunksEncoded = signal(0);
export const encodeErrors = signal(0);
export const encoderState = signal("unconfigured");
export const objectsWithExtensions = signal(0);

// Internal state
export const frameReader = signal<ReadableStreamDefaultReader<VideoFrame> | null>(null);
export const videoStreamCleanup = signal<(() => void) | null>(null);
export const keyframeInterval = signal(3600);
export const pubCurrentObjectId = signal(0);
