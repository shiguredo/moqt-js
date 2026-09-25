import { computed, signal } from "@preact/signals";
import type { Session, Publisher, Catalog, LOC } from "moqt-js";
import type { StatusType } from "../types";
import type { EncoderWrapper } from "../utils/EncoderWrapper";
import { WallClockMapper } from "../../../src/mediaClock.ts";
import {
  EMPTY_PUBLISH_TIMING,
  PublishTimingStats,
  type PublishTimingSnapshot,
} from "../utils/publishTimingStats";
import type { AudioEncoderWrapper } from "../../../src/codec/AudioEncoder.ts";
import { AudioLevelTimeline } from "../utils/audioLevelTimeline";

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
// 配信を始めてから、配信するトラック (映像があれば映像、無ければ音声) の PUBLISH が確立する
// (session.publish が返る) か後始末を終えるまで true。startPublishing は connect の後に pubSession を設定するため、
// connect を待つ間は pubSession が null のまま接続設定を使っている。この間を覆う
export const isStarting = signal(false);

/**
 * Publisher が接続設定を使っているか
 *
 * session があるか、配信を始めている途中なら使っている。Subscriber を止めたときや、Subscriber
 * の開始の失敗や切断で後始末するときに、接続設定の入力を有効に戻してよいかの判定に使う
 * (resetSubscriberState)。
 */
export const hasActivePublisher = computed(() => pubSession.value !== null || isStarting.value);

// Forward State の追跡 (draft-ietf-moq-transport-21 Section 3.1)
export const forwardState = signal<boolean | null>(null);

// Publisher のステータス
export const pubStatus = signal<StatusType>("disconnected");
export const pubStatusMessage = signal("Ready to publish");
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
// 読んだ映像フレームの timestamp とそのときの壁時計から、映像の LOC TIMESTAMP を壁時計に
// 換算する (ライブラリの src/mediaClock.ts の WallClockMapper)。配信を始めるたびに作り直す
export const videoWallClock = signal(new WallClockMapper());
// 送信する映像フレームの符号化と送信の時間 (publishTimingStats.ts)。配信を始めるたびに作り直す
export const publishTimingStats = signal(new PublishTimingStats());
// 画面に出す符号化と送信の時間。encoder の出力を受けたとき、一定の間隔で反映する
export const publishTiming = signal<PublishTimingSnapshot>(EMPTY_PUBLISH_TIMING);
// 最後に publishTiming へ反映した時刻 (`performance.now()`)。画面の表示には使わない
export const publishTimingUpdatedAtMs = signal(0);
// 直前のキーフレームから符号化したフレーム数 (キーフレームの間隔を数える)
export const framesSinceKeyFrame = signal(0);
// 新しい Group の要求 (NEW_GROUP_REQUEST) を受けて、まだキーフレームにしていないか
export const newGroupRequested = signal(false);
// 受けた新しい Group の要求の数 (配信の開始からの累積)
export const newGroupRequestsReceived = signal(0);
export const videoStreamCleanup = signal<(() => void) | null>(null);
// キーフレーム間隔 (frames)。既定は connectionSettings と同じ 2 秒ぶん
export const keyframeInterval = signal(60);
export const pubCurrentObjectId = signal(0);

// 音声トラックの状態
//
// 映像とは別の session.publish を持ち、Group 採番と優先度も独立させる
// (src/createMediaPublisher.ts の audioPublisher / videoPublisher と同じ構成)。
export const audioPublisher = signal<Publisher | null>(null);

/**
 * 配信しているか (トラックの PUBLISH が確立しているか)
 *
 * 映像トラックの PUBLISH があれば配信している。映像の入力が None のときは音声トラックだけを
 * 配信するため、音声トラックの PUBLISH があるときも配信しているとみなす
 */
export const isPublishing = computed(
  () => publisher.value !== null || audioPublisher.value !== null,
);
export const audioEncoder = signal<AudioEncoderWrapper | null>(null);
export const audioStream = signal<MediaStream | null>(null);
export const audioStreamCleanup = signal<(() => void) | null>(null);
export const audioFrameReader = signal<ReadableStreamDefaultReader<AudioData> | null>(null);
// 符号化へ渡した音声のサンプルの記録。送る Object の LOC Audio Level を求める
// (utils/audioLevelTimeline.ts)。音声の配信を始めるたびに作り直す
export const audioLevelTimeline = signal(new AudioLevelTimeline());
// 配信側の音声メーター。取っている音の peak / RMS (dBFS) と直近の波形は Preview 中から
// 更新する (hooks/publisherAudioMeter.ts)。LOC Audio Level は直近に送った Object の値
export const audioMeterPeakDbfs = signal<number | null>(null);
export const audioMeterRmsDbfs = signal<number | null>(null);
export const audioMeterWaveform = signal<Float32Array | null>(null);
export const audioMeterLevel = signal<LOC.AudioLevel | null>(null);

// 音声の Group ID。draft-ietf-moq-loc-04 §4.1 に従い chunk ごとに Group を進める
export const pubCurrentAudioGroup = signal(Date.now());
// 最初の音声 Object を送ったかどうか。初回は割当済みの Group ID をそのまま使う
export const pubAudioGroupStarted = signal(false);
// 直前に送った Audio Config (AAC の AudioSpecificConfig)。同じ値を毎 Object 送らない
export const lastSentAudioConfig = signal<Uint8Array | null>(null);
// Audio Config の送り直し要求。後から接続した購読者のために、保持している値を
// 次の Object に載せ直す (WebCodecs は description を最初の chunk にしか付けない)
export const audioConfigResendRequested = signal(false);
