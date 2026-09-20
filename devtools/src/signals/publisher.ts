import { signal } from "@preact/signals";
import type { Session, Publisher, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { EncoderWrapper } from "../utils/EncoderWrapper";
import type { AudioEncoderWrapper } from "../../../src/codec/AudioEncoder.ts";

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

// 音声トラックの状態
//
// 映像とは別の session.publish を持ち、Group 採番と優先度も独立させる
// (src/createMediaPublisher.ts の audioPublisher / videoPublisher と同じ構成)。
export const audioPublisher = signal<Publisher | null>(null);
export const audioEncoder = signal<AudioEncoderWrapper | null>(null);
export const audioStream = signal<MediaStream | null>(null);
export const audioStreamCleanup = signal<(() => void) | null>(null);
export const audioFrameReader = signal<ReadableStreamDefaultReader<AudioData> | null>(null);

// 音声の Group ID。draft-ietf-moq-loc-04 §4.1 に従い chunk ごとに Group を進める
export const pubCurrentAudioGroup = signal(Date.now());
// 最初の音声 Object を送ったかどうか。初回は割当済みの Group ID をそのまま使う
export const pubAudioGroupStarted = signal(false);
// 直前に送った Audio Config (AAC の AudioSpecificConfig)。同じ値を毎 Object 送らない
export const lastSentAudioConfig = signal<Uint8Array | null>(null);
// Audio Config の送り直し要求。後から接続した購読者のために、保持している値を
// 次の Object に載せ直す (WebCodecs は description を最初の chunk にしか付けない)
export const audioConfigResendRequested = signal(false);
