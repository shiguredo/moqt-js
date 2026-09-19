import { signal } from "@preact/signals";
import type { Session, Publisher, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { EncoderWrapper } from "../utils/EncoderWrapper";

// Publisher の状態
export const pubSession = signal<Session | null>(null);
export const publisher = signal<Publisher | null>(null);
export const catalogPublisher = signal<Publisher | null>(null);
export const catalog = signal<Catalog | null>(null);
// Catalog を最後に送った Group ID。Catalog を送り直すたびに進める。
//
// 同じ Location を 2 度送ると購読側で重複として扱われるため、送り直しは新しい Group で
// 行う。draft-ietf-moq-msf-01 §6.1 は Group ID の一意性と単調増加を MUST とし、
// publisher の再起動時には以前に publish したどの Group ID よりも大きい値から始める
// ことを MUST とするため、映像トラック (pubCurrentGroup) と同じく Unix epoch ミリ秒を
// 開始値にする。実際の開始値は startPublishing が設定する。
export const catalogGroup = signal(Date.now());
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
