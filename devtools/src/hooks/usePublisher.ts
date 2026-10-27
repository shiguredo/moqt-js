import {
  connect,
  LOC,
  CATALOG_TRACK_NAME,
  catalogAuthInfoForSetupToken,
  createCatalog,
  encodeCatalog,
  encodeEventTimeline,
  createCompleteCatalog,
  createVideoFrameSource,
  createAudioFrameSource,
  isAudioFrameSourceAvailable,
  type AudioFrameSource,
  type AuthInfo,
  type Catalog,
  type CatalogTrack,
  type DebugMessage,
  type EventTimelineEntry,
  type Publisher,
  type Session,
} from "moqt-js";
import {
  getCatalogCodec,
  getEncoderConfig,
  isSameCodecDescription,
  parseResolution,
} from "../utils/codec";
import type {
  AudioCodecType,
  AudioDelivery,
  AudioSourceType,
  CodecType,
  PublishStopMode,
  VideoSourceType,
} from "../types";
import { createDummyVideoStream } from "../webcodecs-devtools/utils/dummyVideo";
import { createDummyAudioStream } from "../webcodecs-devtools/utils/dummyAudio";
import { readAllAudioSamples } from "../utils/audioLevel";
import { AudioLevelTimeline } from "../utils/audioLevelTimeline";
import { AudioTimestampClock } from "../../../src/audioTimestampClock";
import { AudioPublishCatchUp } from "../../../src/audioPublishCatchUp";
import { selectCodecDescription } from "../../../src/createMediaPublisher";
import {
  advanceEncodeGeneration,
  recordEncodeGeneration,
  shouldSendEncodedChunk,
  type EncodeState,
} from "../../../src/encodeGeneration";
import { startPublisherAudioMeter, stopPublisherAudioMeter } from "./publisherAudioMeter";
import { AudioEncoderWrapper } from "../../../src/codec/AudioEncoder.ts";
import type { AudioEncodedChunkData } from "../../../src/codec/types.ts";
import { getAudioEncoderConfig } from "../../../src/codec/config.ts";
import { probeAudioEncoderConfig } from "../../../src/codec/configSupport.ts";
import {
  allocateAudioObject,
  allocateInitialGroupId,
  assertCatalogLatencyOptions,
  noteGroupId,
  PRIORITY_AUDIO,
  PRIORITY_VIDEO_DELTA,
  PRIORITY_VIDEO_KEY,
} from "../../../src/createMediaPublisher.ts";
import { formatFullTrackName } from "../../../src/fullTrackName.ts";
import { addLog } from "../signals/debugLog";
import { logDebugMessage } from "./debugMessageLog";
import { EncoderWrapper, type EncodedChunkData } from "../utils/EncoderWrapper";
import { WallClockMapper } from "../../../src/mediaClock.ts";
import { EMPTY_PUBLISH_TIMING, PublishTimingStats } from "../utils/publishTimingStats";
import { shouldDropFrame } from "../utils/encodeQueueBackpressure";
import {
  type AudioFormat,
  buildMicrophoneConstraints,
  resolveCapturedAudioFormat,
} from "../utils/microphone";
import {
  CATALOG_REPUBLISH_MAX_INTERVAL_MS,
  catalogRepublishIntervalMs,
} from "../../../src/catalogRepublish.ts";
import { shouldSendAudioAsDatagram } from "../utils/audioDelivery";
import { shouldRequestKeyFrame } from "../utils/keyframeInterval";
import {
  appendMessageEventEntry,
  buildMessageEventEntry,
  MESSAGES_EVENT_TYPE,
  EVENT_TRACK_NAME,
} from "../utils/eventTimeline";
import {
  assertTrackNames,
  resolveAudioAdvertisement,
  resolveVideoAdvertisement,
} from "../utils/publishTracks";
import { browserIsChromium, resolvePanelHttpVersion } from "../utils/httpVersion";
import { publishAuthorizationTokenOptions } from "../utils/trackAuthorization";
import * as settings from "../signals/connectionSettings";
import * as pub from "../signals/publisher";
import * as sub from "../signals/subscriber";

export function handleDebugMessage(message: DebugMessage): void {
  logDebugMessage("[publisher]", message);
}

/**
 * 符号化と送信の時間の統計を画面へ反映する間隔 (ミリ秒)
 *
 * encoder の出力ごとに統計を求めると、分布を求める並べ替えが配信 fps の回数だけ走る。
 * 画面の更新には 0.5 秒ごとで足りる
 */
const PUBLISH_TIMING_UPDATE_INTERVAL_MS = 500;

/**
 * 配信を始めるときに、映像の配信の状態を作り直す (前の配信の対応や記録を持ち越さない)
 *
 * TIMESTAMP の壁時計への換算、符号化と送信の時間の記録、キーフレームの間隔の数え方と
 * 新しい Group の要求を初期化する。
 */
function resetVideoPublishState(): void {
  pub.videoWallClock.value = new WallClockMapper();
  pub.publishTimingStats.value = new PublishTimingStats();
  pub.publishTiming.value = EMPTY_PUBLISH_TIMING;
  pub.publishTimingUpdatedAtMs.value = 0;
  pub.lastKeyFrameTimestampUs.value = null;
  pub.newGroupRequested.value = false;
  pub.newGroupRequestsReceived.value = 0;
}

/**
 * 映像トラックの PUBLISH が確立した (session.publish が返った) ことを signal に反映する
 *
 * 配信を始めている途中の状態 (isStarting) を終える。以降は pubSession があることで
 * 接続設定を使っていると判定する (pub.hasActivePublisher)。Subscriber の isStarting が
 * 映像トラックの購読の確立で下りるのとそろえる。
 */
function markVideoPublisherEstablished(publisherInstance: Publisher): void {
  pub.forwardState.value = publisherInstance.forwardState;
  pub.publisher.value = publisherInstance;
  pub.isStarting.value = false;
}

/** 配信するトラックの Catalog を組み立てるための入力 */
export interface PublisherCatalogOptions {
  /** 映像トラックを配信するときの設定。省略時 (映像の入力が None) は映像トラックを載せない */
  video?: PublisherVideoCatalogOptions;
  /** 音声トラックを配信するときの設定。省略時は音声トラックを載せない */
  audio?: PublisherAudioCatalogOptions;
  /**
   * 符号化から表示までの wallclock の差 (ms)
   *
   * draft-ietf-moq-msf-01 §5.2.8 (targetLatency)。
   * 指定すると音声と映像の両方の track に同じ値を載せる (同じ render group と alternate
   * group の track は同一の値でなければならない MUST)。未指定のときは載せず、購読側が
   * 表示の遅れを選ぶ (§5.2.8 の MAY)。0 ms は有効値である。
   */
  targetLatency?: number;
  /**
   * 同時レンダリンググループ
   *
   * draft-ietf-moq-msf-01 §5.2.11 (renderGroup)。
   * 指定すると音声と映像の両方の track に同じ値を載せる (同じ group の track は同時に
   * 描画する SHOULD)。0 は有効値である。
   */
  renderGroup?: number;
  /**
   * 認可が必要なことを視聴側に示す Authorization Info
   *
   * draft-ietf-moq-msf-01 §5.2.42 (authInfo)。
   * 指定すると音声、映像、event timeline のすべての track に載せる。未指定のときは載せない。
   */
  authInfo?: AuthInfo;
}

/** 配信する映像トラックの Catalog を組み立てるための入力 */
export interface PublisherVideoCatalogOptions {
  trackName: string;
  codec: CodecType;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
}

/** 配信する音声トラックの Catalog を組み立てるための入力 */
export interface PublisherAudioCatalogOptions {
  trackName: string;
  codec: AudioCodecType;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

/** 設定から `PublisherCatalogOptions` を組み立てるための入力 */
export interface PublisherCatalogSettings {
  /** 映像トラックの設定。映像の入力が None のときは null (映像トラックを載せない) */
  video: PublisherVideoCatalogOptions | null;
  /** 音声トラックの設定。音声を配信できないときは null (音声トラックを載せない) */
  audio: PublisherAudioCatalogOptions | null;
  /** 目標遅延 (ms)。未指定は null (catalog に載せない。draft-ietf-moq-msf-01 §5.2.8) */
  targetLatency: number | null;
  /** 同時レンダリンググループ。未指定は null (catalog に載せない。§5.2.11) */
  renderGroup: number | null;
  /** 認可が必要なことを示す authInfo。載せないときは null (§5.2.42) */
  authInfo: AuthInfo | null;
}

/**
 * 設定から配信するトラックの Catalog の入力を組み立てる純関数
 *
 * 画面と URL の設定は「未指定」を null で表すため、null の項目はキーを落として
 * `buildPublisherCatalog` へ渡す (`exactOptionalPropertyTypes` では optional な
 * フィールドに undefined を入れられない)。targetLatency の 0 ms と renderGroup の 0 は
 * 有効値であり、null のときだけ落とす (0 = 未指定とは扱わない)。
 * ブラウザ API に依存しないため、設定の写像はここで検証できる。
 */
export function buildPublisherCatalogOptions(
  options: PublisherCatalogSettings,
): PublisherCatalogOptions {
  return {
    ...(options.video !== null ? { video: options.video } : {}),
    ...(options.audio !== null ? { audio: options.audio } : {}),
    ...(options.targetLatency !== null ? { targetLatency: options.targetLatency } : {}),
    ...(options.renderGroup !== null ? { renderGroup: options.renderGroup } : {}),
    ...(options.authInfo !== null ? { authInfo: options.authInfo } : {}),
  };
}

/**
 * 配信するトラックの Catalog の入力を現在の設定から組み立てる
 *
 * 画面と URL で変えられる設定を読み、`PublisherCatalogSettings` を経由して
 * `buildPublisherCatalogOptions` へ渡す。未指定 (null) の項目をキーごと落とす判断は
 * `buildPublisherCatalogOptions` に 1 つだけ置き、この関数は設定の読み出しに徹する。
 *
 * 音声のサンプルレートとチャンネル数だけは設定ではなく、実際に取れた音の形式を使う
 * (マイクではデバイスが決めるため、Catalog と AudioEncoder を同じ値にそろえる)。
 *
 * authInfo は、接続の設定から組み立てる SETUP の Authorization Token が C4M のトークン
 * (CAT) のときだけ載せる (catalogAuthInfoForSetupToken)。
 *
 * @param audioFormat - 実際に取れた音の形式。音声を配信しないときは null
 */
export function buildPublisherCatalogOptionsFromSettings(
  audioFormat: AudioFormat | null,
): PublisherCatalogOptions {
  const videoSourceValue = settings.videoSource.value;
  // 解像度は設定の "WIDTHxHEIGHT" から数値にする
  const { width, height } = parseResolution(settings.resolution.value);
  return buildPublisherCatalogOptions({
    // 映像は映像の入力が None でないときだけトラックを載せる
    video:
      videoSourceValue === "none"
        ? null
        : {
            trackName: settings.videoTrackName.value,
            codec: settings.codec.value,
            width,
            height,
            framerate: settings.framerate.value,
            bitrate: settings.bitrate.value,
          },
    // 音声は配信できるときだけトラックを載せる (形式は実際に取れた音の値)
    audio:
      audioFormat === null
        ? null
        : {
            trackName: settings.audioTrackName.value,
            codec: settings.audioCodec.value,
            bitrate: settings.audioBitrate.value,
            sampleRate: audioFormat.sampleRate,
            channels: audioFormat.channels,
          },
    // targetLatency / renderGroup は「未指定」(null) のときだけ catalog に載せない。
    // 0 ms と renderGroup の 0 はどちらも有効値のため、0 かどうかでは判定しない
    targetLatency: settings.targetLatency.value,
    renderGroup: settings.renderGroup.value,
    // CAT で接続した配信の track は、視聴側にも同じ方式のトークンの提示を求める
    authInfo: catalogAuthInfoForSetupToken(settings.buildAuthorizationToken()) ?? null,
  });
}

/**
 * catalog に載せるトラックの宣言
 *
 * 配信で送る catalog の値そのもの。Tracks カード (接続設定) が「送る catalog の値」を
 * 出すためにも使う。画面の表示と配信で送る内容がずれないよう、宣言の組み立ては
 * `buildPublisherTrackDeclarations` の 1 か所に置く。
 */
export interface PublisherTrackDeclarations {
  /** 音声トラックの宣言。音声を配信しないときは null */
  audio: CatalogTrack | null;
  /** 映像トラックの宣言。映像を配信しないときは null */
  video: CatalogTrack | null;
  /** event timeline トラックの宣言。audio / video 以外のデータを流す例として常に載せる */
  event: CatalogTrack;
}

/**
 * 配信する映像トラックと音声トラック、event timeline トラックの宣言を組み立てる
 *
 * codec 文字列は映像が `getCatalogCodec`、音声が `getAudioEncoderConfig` を通し、
 * Encoder に渡す設定と同一の対応表を使う (Catalog の codec 誤記は購読側の Decoder
 * 設定を壊すため、対応表の二重管理を避ける)。
 *
 * 音声トラックに `samplerate` / `channelConfig` / `bitrate` を載せるのは、
 * MSF §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) /
 * §5.2.29 (channelConfig) がいずれも audio codec を指定する track に MUST で
 * 要求するため。
 *
 * targetLatency / renderGroup は音声と映像の両方の track に同じ値を載せる。
 * draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は同一の
 * targetLatency でなければならない MUST。§5.2.11: 同じ renderGroup の track は同時に
 * 描画する SHOULD。未指定のときはキーを載せない (§5.2.8: 宣言が無く isLive が true の
 * ときは購読側が遅延を選んでよい MAY のため、載せないことが購読側のフォールバックになる)。
 * 指定した値が有限数であること (renderGroup はさらに整数であること) の検証は
 * `buildPublisherCatalog` が行う。非有限値は JSON で null になり、購読側が復号できなくなる。
 *
 * event timeline トラックは audio / video 以外のデータを流す例として常に 1 本載せる。
 * packaging / role / mimeType / eventType は §5.2.5 / §8.2 の MUST を満たし、depends には
 * 同時に配信するメディアトラック名をすべて載せる。targetLatency / renderGroup は
 * メディアを描画するトラックではないため載せない。
 *
 * authInfo は指定したときだけ、音声、映像、event timeline のすべての track に載せる
 * (§5.2.42)。視聴側は authInfo のある track の SUBSCRIBE にトークンを付ける (§11.4.1 /
 * §11.4.3)。
 *
 * 検証は行わない。トラック名が空でなく互いに異なること (§5.2.3) と、メディアトラックが
 * 1 つも無い catalog を作らないことは `buildPublisherCatalog` が受け持つ。Tracks カードは
 * 名前が不正な間も警告と並べて宣言を出し続けるため、ここで throw してはならない。
 *
 * ブラウザ API に依存しないため、送信する Catalog の内容はここで検証できる。
 */
export function buildPublisherTrackDeclarations(
  options: PublisherCatalogOptions,
): PublisherTrackDeclarations {
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 指定がある項目だけを載せる。targetLatency の 0 ms と renderGroup の 0 は有効値である
  // ため、0 かどうかではなく指定の有無で判定する
  const latencyFields: Pick<CatalogTrack, "targetLatency" | "renderGroup"> = {
    ...(options.targetLatency !== undefined ? { targetLatency: options.targetLatency } : {}),
    ...(options.renderGroup !== undefined ? { renderGroup: options.renderGroup } : {}),
  };
  // authInfo も同じく、指定があるときだけキーを持たせる
  const authInfoFields: Pick<CatalogTrack, "authInfo"> =
    options.authInfo !== undefined ? { authInfo: options.authInfo } : {};

  let audio: CatalogTrack | null = null;
  if (options.audio) {
    const audioOptions = options.audio;
    audio = {
      name: audioOptions.trackName,
      packaging: "loc",
      isLive: true,
      role: "audio",
      codec: getAudioEncoderConfig(
        audioOptions.codec,
        audioOptions.bitrate,
        audioOptions.sampleRate,
        audioOptions.channels,
      ).codec,
      bitrate: audioOptions.bitrate,
      samplerate: audioOptions.sampleRate,
      channelConfig: String(audioOptions.channels),
      ...latencyFields,
      ...authInfoFields,
    };
  }

  let video: CatalogTrack | null = null;
  if (options.video) {
    const videoOptions = options.video;
    video = {
      name: videoOptions.trackName,
      packaging: "loc",
      isLive: true,
      role: "video",
      codec: getCatalogCodec(videoOptions.codec),
      width: videoOptions.width,
      height: videoOptions.height,
      framerate: videoOptions.framerate,
      bitrate: videoOptions.bitrate,
      ...latencyFields,
      ...authInfoFields,
    };
  }

  // event timeline トラック (§5.2.5 / §8.2)。depends は event timeline が対応する
  // メディアトラック名で、ここでは上で組み立てた audio / video の名前をそのまま使う
  const depends = [audio, video]
    .filter((track): track is CatalogTrack => track !== null)
    .map((track) => track.name);
  const event: CatalogTrack = {
    name: EVENT_TRACK_NAME,
    packaging: "eventtimeline",
    isLive: true,
    role: "eventtimeline",
    eventType: MESSAGES_EVENT_TYPE,
    mimeType: "application/json",
    depends,
    ...authInfoFields,
  };
  return { audio, video, event };
}

/**
 * 配信する映像トラックと音声トラック、event timeline トラックの Catalog を組み立てる
 *
 * draft-ietf-moq-msf-01 §5.1 の full catalog を生成する。映像トラックと音声トラックは
 * どちらか一方だけでもよい (catalog は映像トラックを必須としない)。どちらも無い catalog は
 * 購読できる対象が無いため作らずに throw する。
 *
 * トラックは音声 → 映像 → event timeline の順に積む。画面 (Tracks カード) が音声と
 * 映像をこの順に並べるため、catalog をそのまま表示する Catalog パネルと並びを揃える。
 * 配列の順序に仕様上の意味は無い。
 * トラック名は空でなく、互いに異なることを検証する (§5.2.3)。
 *
 * ブラウザ API に依存しないため、送信した Catalog の内容はここで検証できる。
 */
export function buildPublisherCatalog(options: PublisherCatalogOptions): Catalog {
  // 非有限値は JSON.stringify が null に落とし、購読側の検証
  // (src/msf/catalogTrackValidation.ts) で例外になる。画面と URL の設定は許可リストで
  // 到達しないが、この純関数は直接呼べるため、符号化の前に拒否する。
  // 検証は core と同じ関数を使い、メッセージと境界が 2 か所でずれないようにする
  assertCatalogLatencyOptions(options);

  const { audio, video, event } = buildPublisherTrackDeclarations(options);

  // メディアトラック (映像 / 音声) が 1 つも無いときは catalog を作らない。event timeline の
  // 宣言は常に組み立てるが、単独では購読できる対象が無い
  if (audio === null && video === null) {
    throw new Error("no track to publish: both video and audio are absent");
  }

  const tracks = [audio, video, event].filter((track): track is CatalogTrack => track !== null);

  // 空名と同名は購読側の catalog の検証 (decodeCatalogMessage) で初めて分かる。
  // 自分の catalog を自分で復号できなくなるため、送る前に拒否する
  // (draft-ietf-moq-msf-01 §5.2.3: name は Required、namespace ごとに一意 MUST)
  assertTrackNames(tracks.map((track) => track.name));
  return createCatalog(tracks);
}

/**
 * 音声を配信できるかどうかを判定する
 *
 * MediaStreamTrackProcessor をメインスレッドに持たないブラウザ (Safari / Firefox) でも、
 * Web Audio 経由で AudioData を取り出せるため音声を配信できる (src/audioSource.ts)。
 * どちらの経路も無いブラウザでは音声だけを諦める。配信開始後に throw すると、既に
 * 確立した映像の配信まで巻き込んで止まるため、Catalog を作る前に判定する。
 */
export function resolveAudioPublishable(audioSource: AudioSourceType): boolean {
  return audioSource !== "none" && isAudioFrameSourceAvailable();
}

/**
 * 送る Audio Config を決める純関数
 *
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) の Audio Config は、WebCodecs の
 * `EncodedAudioChunkMetadata.decoderConfig.description` として現れたときにだけ
 * 載せる。同じ値を毎 Object 送ると無駄になるため、直前と異なるときだけ載せる。
 *
 * ただし WebCodecs は description を configure 後の最初の出力にしか付けないため、
 * 後から接続した購読者は Audio Config を受け取れない (音声には keyframe が無い)。
 * 送り直しを要求されたら、保持している値をそのまま載せ直す。
 * ブラウザ API に依存しないため、この判断はここで検証できる。
 *
 * @param previous - 直前に送った Audio Config (未送信なら null)
 * @param description - 今回の chunk が持つ Audio Config (opus では undefined)
 * @param resendRequested - 保持している Audio Config の送り直しを要求されているか
 * @returns 今回載せる config、次回のために保持する値、送り直し要求を残すか
 */
export function resolveAudioConfigToSend(
  previous: Uint8Array | null,
  description: Uint8Array | undefined,
  resendRequested: boolean,
): { config: Uint8Array | undefined; next: Uint8Array | null; resendNext: boolean } {
  if (description !== undefined && !isSameCodecDescription(previous, description)) {
    return { config: description, next: new Uint8Array(description), resendNext: false };
  }
  if (resendRequested && previous !== null) {
    return { config: previous, next: previous, resendNext: false };
  }
  // 保持する値が無いまま要求された場合は、次に description が現れたときに備えて残す
  return { config: undefined, next: previous, resendNext: resendRequested };
}

/** 送信する 1 Object の内容 */
export interface ObjectSendPlan {
  /** この Object を載せる Group ID */
  groupId: number;
  /** この Object の Object ID */
  objectId: number;
  /** 次の Object が載る Group ID */
  nextGroupId: number;
  /** 次の Object の Object ID */
  nextObjectId: number;
  /** 送信する payload (WebCodecs の internal data をそのまま使う) */
  payload: Uint8Array;
  /** LOC Properties をエンコードしたバイト列 */
  properties: Uint8Array;
  /** Publisher Priority */
  priority: number;
  /** キーフレーム (新しい Group を開始した Object) かどうか */
  isKeyFrame: boolean;
}

/**
 * エンコード済み chunk から送信する 1 Object の内容を組み立てる
 *
 * `handleEncodedChunk` から送信処理 (`Publisher.sendObject`) と signal 更新を
 * 除いた純粋部分。Group / Object ID の採番、LOC Properties のエンコード、
 * Priority の決定をここに集約し、ブラウザ API 無しで契約を検証できるようにする。
 *
 * Group / Object ID (draft-ietf-moq-msf-01 §6.1):
 * キーフレームで新しい Group を開始し (Group ID は単調増加)、Object ID を 0 に戻す。
 * デルタフレームは同じ Group の続きとして Object ID を進める。
 *
 * LOC Properties (draft-ietf-moq-loc-04 §2.3.2):
 * TIMESTAMP と VIDEO_FRAME_MARKING を載せる。TIMESTAMP は Timescale を載せないため
 * Unix epoch のマイクロ秒 (壁時計) である (§2.3.1.1)。VideoFrame の timestamp は
 * 取得元ごとに基準が異なるため、呼び出し側が読んだフレームとの対応から壁時計に
 * 換算した値 (`wallClockMicros`、ライブラリの src/mediaClock.ts の WallClockMapper) を
 * そのまま載せる。isDiscardable は WebCodecs が
 * 破棄可能性情報を提供しないため false 固定 (RFC 9626 §3.1 D の「the sender knows」を
 * 守るため)。isBaseLayerSync はソース上のキーフレーム意図マーカとして残すが、
 * temporalLayerId=0 固定のためワイヤ上 B=0 に抑圧される。
 * canonical 形式 (avc1 / hvc1) のときだけ WebCodecs の description を
 * Video Config (ID: 0x0D) として載せる (annexB 形式では description が無い)。
 *
 * @param location - 直前の Object の次の位置 (Group ID と Object ID)
 * @param chunk - エンコード済み chunk
 * @param wallClockMicros - chunk の timestamp を壁時計 (Unix epoch マイクロ秒) に換算した値
 */
export function buildObjectSendPlan(
  location: { groupId: number; objectId: number },
  chunk: EncodedChunkData,
  wallClockMicros: bigint,
): ObjectSendPlan {
  const isKeyFrame = chunk.type === "key";
  const groupId = isKeyFrame ? location.groupId + 1 : location.groupId;
  const objectId = isKeyFrame ? 0 : location.objectId;

  // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
  const payload = chunk.data;

  const properties = LOC.encodeVideoProperties({
    timestamp: wallClockMicros,
    frameMarking: {
      isIndependent: isKeyFrame,
      isDiscardable: false,
      isBaseLayerSync: isKeyFrame,
      temporalLayerId: 0,
      spatialLayerId: 0,
    },
    config: chunk.description,
  });

  return {
    groupId,
    objectId,
    nextGroupId: groupId,
    nextObjectId: objectId + 1,
    payload,
    properties,
    // キーフレームは即時配送を優先し、デルタフレームは既定優先度にする。
    // キーフレームは常に新しい Group (= Subgroup) の先頭 Object になるため、
    // この値がその Subgroup の実効優先度になる
    priority: isKeyFrame ? PRIORITY_VIDEO_KEY : PRIORITY_VIDEO_DELTA,
    isKeyFrame,
  };
}

/** 音声 Object の送信計画 (送る copy の数と 1 回あたりのバイト数) */
export interface AudioSendCopyPlan {
  /** datagram で送るか。false のときは subgroup で 1 回だけ送る */
  datagram: boolean;
  /** 同じ音声 Object を送る回数。datagram は冗長度 (1〜3)、subgroup は 1 */
  copies: number;
  /** 1 回送るあたりのバイト数 (payload と properties の長さの合計) */
  bytesPerCopy: number;
}

/**
 * 音声 Object の送信計画を作る
 *
 * 音声は 1 chunk = 1 Object = 1 Group であり (draft-ietf-moq-loc-04 §4.1)、datagram は
 * 再送されない (RFC 9221) ため、配信側は同じ Object を冗長度の数だけ送る。subgroup は
 * Data Stream が再送されるため 1 回だけ送る。datagram を運べないセッション
 * (reliability が "reliable-only") も subgroup で 1 回だけ送る。
 *
 * バイト数は実際に送る copy の数だけ数える。Object 1 件につき 1 回と copy ごとの 1 回を
 * 両方足すと、冗長度 2 で 3 倍になる (帯域の見積もりが過大になる)。送信ループと計器が
 * 同じ計画を読むよう、回数の解決をここに置く。
 *
 * @param options.delivery - 音声の送り方の設定
 * @param options.reliability - 下位 WebTransport の reliability
 * @param options.redundancy - datagram で送る回数 (1〜3。範囲外は 1〜3 に丸める)
 * @param options.payloadBytes - payload の長さ
 * @param options.propertiesBytes - LOC Properties の長さ
 */
export function buildAudioSendCopyPlan(options: {
  readonly delivery: AudioDelivery;
  readonly reliability: string | undefined;
  readonly redundancy: number;
  readonly payloadBytes: number;
  readonly propertiesBytes: number;
}): AudioSendCopyPlan {
  const datagram = shouldSendAudioAsDatagram(options.delivery, options.reliability);
  // datagram 以外 (subgroup) は再送されるため 1 回だけ送る。datagram は冗長度の数だけ
  // 送り、4 以上は帯域を無駄にするため 3 に切る (src/codec/types.ts の AudioPublishOptions)
  const copies = datagram ? Math.min(3, Math.max(1, Math.floor(options.redundancy))) : 1;
  return {
    datagram,
    copies,
    bytesPerCopy: options.payloadBytes + options.propertiesBytes,
  };
}

/**
 * datagram で送った音声 Object の送信の遅れを記録する
 *
 * datagram の書き込みは送信キューの投入そのものであり、完了は返らない (fire-and-forget)。
 * ライブラリ (src/createMediaPublisher.ts の `sendAudioFrameFireAndForget`) と同じく、投入の
 * 直後を完了として記録する。
 *
 * 記録しないと、送信の遅れ (`sendLagMs` / `maxSendLagMs` / `sendQueueMs`) が datagram の経路
 * では常に 0 のままになり、受信側の到着の遅れを「配信側が足した分」と「経路」に分けられない。
 * 実際、この穴のせいで到着の裾の切り分けを別途やり直すことになった (2026-10-16 の調査)。
 * 送信キューの長さは datagram では観測できない (writer の `write()` は投入で解決し、ワイヤに
 * 出た時刻は分からない) ため、`sendQueueMs` は 0 のままになる。測っているのは
 * 「撮ってから投入するまでの遅れ」である。
 *
 * @param catchUp - 記録先 (配信の音声ごとの観測。`src/audioPublishCatchUp.ts`)
 * @param send - 送る Object の情報
 * @param nowMs - 書き込みの直後の時刻 (`performance.now()`、ミリ秒)。完了の時刻にも使う
 */
export function recordAudioDatagramSent(
  catchUp: AudioPublishCatchUp,
  send: {
    /** 送る Object が覆う最初の投入の timestamp (マイクロ秒) */
    readonly timestampMicros: number;
    /** 送る Object の LOC TIMESTAMP (Unix epoch マイクロ秒) */
    readonly locTimestampMicros: bigint;
    /** 音声の長さ (マイクロ秒)。分からなければ null */
    readonly durationMicros: number | null;
  },
  nowMs: number,
): void {
  catchUp.recordSendStart({
    timestampMicros: send.timestampMicros,
    capturedWallClockMs: Number(send.locTimestampMicros) / 1_000,
    durationMs: (send.durationMicros ?? 0) / 1_000,
    nowMs,
  });
  catchUp.recordSendComplete({
    timestampMicros: send.timestampMicros,
    completedWallClockMs: performance.timeOrigin + nowMs,
  });
}

/**
 * 次に符号化するフレームをキーフレームにするかを決める
 *
 * keyframeInterval 秒ごとのキーフレームに加えて、新しい Group の要求 (NEW_GROUP_REQUEST) を
 * 受けていれば次のフレームをキーフレームにして新しい Group を始める
 * (draft-ietf-moq-transport-22 Section 9.20.19: dynamic Groups に対応する publisher は、現在の
 * Group を終えて新しい Group をできるだけ早く始める SHOULD)。キーフレームにしたフレームから
 * 間隔を数え直す。次のフレームまでに届いた複数の要求は 1 枚のキーフレームにまとまる
 *
 * 間隔ごとの判定は共有モジュール (utils/keyframeInterval.ts) の `shouldRequestKeyFrame` に
 * 任せる。無効な間隔は既定値として扱われるため、この関数は throw しない
 *
 * @param lastKeyFrameTimestampUs - 直前のキーフレームの timestamp (マイクロ秒)。まだ
 *   キーフレームにしていない場合は null
 * @param frameTimestampUs - 判定するフレームの timestamp (マイクロ秒)
 * @param keyframeInterval - キーフレームにする間隔 (秒)
 * @param newGroupRequested - 新しい Group の要求を受けて、まだキーフレームにしていないか
 * @returns キーフレームにするかと、このフレームを符号化した後の直前のキーフレームの timestamp
 */
export function decideKeyFrame(
  lastKeyFrameTimestampUs: number | null,
  frameTimestampUs: number,
  keyframeInterval: number,
  newGroupRequested: boolean,
): { keyFrame: boolean; nextLastKeyFrameTimestampUs: number | null } {
  const keyFrame =
    newGroupRequested ||
    shouldRequestKeyFrame(lastKeyFrameTimestampUs, frameTimestampUs, keyframeInterval);
  // キーフレームにしない場合は直前の記録を据え置く。直前の記録が無いフレームは必ず
  // キーフレームになるため、据え置く側で null にはならない
  return {
    keyFrame,
    nextLastKeyFrameTimestampUs: keyFrame ? frameTimestampUs : lastKeyFrameTimestampUs,
  };
}

interface VideoStreamResult {
  stream: MediaStream;
  width: number;
  height: number;
  cleanup: () => void;
}

async function getVideoStream(
  source: Exclude<VideoSourceType, "none">,
  width: number,
  height: number,
  framerate: number,
  deviceId?: string,
): Promise<VideoStreamResult> {
  if (source === "dummy") {
    const generator = createDummyVideoStream(width, height, framerate);
    return {
      stream: generator.stream,
      width,
      height,
      cleanup: (): void => {
        generator.stop();
        for (const track of generator.stream.getTracks()) {
          track.stop();
        }
      },
    };
  }

  // カメラ (getUserMedia)
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: framerate },
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("Failed to get video track from camera");
  }

  const videoSettings = videoTrack.getSettings();
  return {
    stream,
    width: videoSettings.width ?? width,
    height: videoSettings.height ?? height,
    cleanup: (): void => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

/** 配信に使う映像のトラックと、その幅と高さ */
interface VideoInput {
  track: MediaStreamTrack;
  width: number;
  height: number;
}

/**
 * 配信に使う映像のストリームを用意する
 *
 * Preview の映像があればそのまま使い、無ければ新しく取る
 */
async function prepareVideoForPublishing(
  source: Exclude<VideoSourceType, "none">,
  width: number,
  height: number,
  framerate: number,
): Promise<VideoInput> {
  let actualWidth: number;
  let actualHeight: number;
  const hadPreview = pub.isPreviewActive.value && pub.mediaStream.value !== null;

  if (hadPreview) {
    actualWidth = width;
    actualHeight = height;
  } else {
    const cameraDeviceId = source === "camera" ? settings.selectedCameraDeviceId.value : undefined;
    const videoStreamResult = await getVideoStream(
      source,
      width,
      height,
      framerate,
      cameraDeviceId,
    );
    pub.mediaStream.value = videoStreamResult.stream;
    pub.videoStreamCleanup.value = videoStreamResult.cleanup;
    actualWidth = videoStreamResult.width;
    actualHeight = videoStreamResult.height;
  }

  const track = pub.mediaStream.value?.getVideoTracks()[0];
  if (!track) {
    throw new Error("Failed to get video track");
  }
  return { track, width: actualWidth, height: actualHeight };
}

/** 映像のストリーム (Preview や配信で取ったもの) を解放する */
function releaseVideoStream(): void {
  if (pub.videoStreamCleanup.value) {
    pub.videoStreamCleanup.value();
    pub.videoStreamCleanup.value = null;
  }
  pub.mediaStream.value = null;
}

// catalog の送り直し (draft-ietf-moq-msf-01 Section 5)
//
// catalog は relay の cache から落ちる前に新しい Group で送り直す (src/catalogRepublish.ts)。
// publisher はページに 1 つであるため、タイマーと間隔はモジュールで 1 つだけ持つ。
// 配信の停止と後始末で止める
let catalogRepublishTimer: ReturnType<typeof setTimeout> | undefined;
let catalogRepublishInterval = CATALOG_REPUBLISH_MAX_INTERVAL_MS;

/** 予約している catalog の送り直しを取り消す */
function cancelCatalogRepublish(): void {
  if (catalogRepublishTimer !== undefined) {
    clearTimeout(catalogRepublishTimer);
    catalogRepublishTimer = undefined;
  }
}

/**
 * catalog の送り直しを予約し直す
 *
 * catalog を送るたびに呼び、最後に送った時刻から間隔を数える。前の予約は取り消す
 */
function scheduleCatalogRepublish(send: () => Promise<void>): void {
  cancelCatalogRepublish();
  catalogRepublishTimer = setTimeout(() => {
    catalogRepublishTimer = undefined;
    send().catch((error: unknown) => {
      addLog("warn", `[publisher] failed to republish ${CATALOG_TRACK_NAME}`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, catalogRepublishInterval);
}

/**
 * 配信の開始時に catalog の送り直しを始める
 *
 * 間隔は catalog の MAX_CACHE_DURATION から決める (src/catalogRepublish.ts)
 */
function startCatalogRepublish(maxCacheDurationMs: number, send: () => Promise<void>): void {
  catalogRepublishInterval = catalogRepublishIntervalMs(maxCacheDurationMs);
  scheduleCatalogRepublish(send);
}

/**
 * Stop Publish の止め方ごとの、送るメッセージと後始末の段取り
 */
export interface PublishStopPlan {
  /** complete catalog を送るか */
  sendCompleteCatalog: boolean;
  /** 各トラックに PUBLISH_DONE (TRACK_ENDED) を送るか */
  sendPublishDone: boolean;
  /** セッションを閉じるか */
  closeSession: boolean;
  /** セッションを維持したまま、送信の経路を止めるか */
  stopSending: boolean;
  /** event timeline の PUBLISH を外すか (送信を再開させない) */
  detachEventPublisher: boolean;
  /** catalog の PUBLISH を外すか (購読者の FORWARD で送り直しが再開しないようにする) */
  detachCatalogPublisher: boolean;
  /** 停止後に出す Status の文言 */
  statusMessage: string;
}

/**
 * Stop Publish の止め方を、送るメッセージと後始末の段取りにする
 *
 * draft-ietf-moq-transport-22 §7.4 (A subscriber remains subscribed to a Track at a Relay until
 * it unsubscribes, the upstream publisher terminates the subscription, or the subscription
 * expires.): 購読者に届く終了通知は止め方で変わるため、切り分けのために選べるようにする。
 *
 * - `publish-done` (既定): complete catalog と各トラックの PUBLISH_DONE (TRACK_ENDED) を送って
 *   からセッションを閉じる。今までの Stop Publish と同じ
 * - `close-session`: complete catalog も PUBLISH_DONE も送らずにセッションだけを閉じる。
 *   complete catalog を送ると購読者の Catalog パネルが空になり、止め方の差ではなく catalog の
 *   有無で購読者の表示が変わってしまうため送らない
 * - `stop-sending`: 何も送らずに送信の経路だけを止め、セッションと PUBLISH は維持する
 */
export function buildPublishStopPlan(mode: PublishStopMode): PublishStopPlan {
  switch (mode) {
    case "close-session":
      return {
        sendCompleteCatalog: false,
        sendPublishDone: false,
        closeSession: true,
        stopSending: true,
        detachEventPublisher: false,
        detachCatalogPublisher: false,
        statusMessage: "Ready to publish",
      };
    case "stop-sending":
      return {
        sendCompleteCatalog: false,
        sendPublishDone: false,
        closeSession: false,
        stopSending: true,
        detachEventPublisher: true,
        detachCatalogPublisher: true,
        statusMessage: "Stopped sending (session kept)",
      };
    case "publish-done":
      return {
        sendCompleteCatalog: true,
        sendPublishDone: true,
        closeSession: true,
        stopSending: true,
        detachEventPublisher: false,
        detachCatalogPublisher: false,
        statusMessage: "Ready to publish",
      };
    default: {
      // 止め方を足したときに、段取りの決定漏れを型で止める (ここには来ない)
      const exhaustive: never = mode;
      throw new Error(`unknown publish stop mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * 配信を始めるときのトラックごとの開始 Group ID を払い出して設定する
 *
 * draft-ietf-moq-msf-01 §6.1: Group ID は track ごとに一意で単調増加することを MUST とし、
 * 配信を再開したときの開始 Group ID は同一 track で以前に publish したどの Group ID よりも
 * 大きいことを MUST とする。短時間の停止と再開や chunk をまとめて送った後では `Date.now()`
 * が前回の最大値を上回る保証がないため、ライブラリの `allocateInitialGroupId`
 * (単調ガード付きの割当て) を 4 つのトラックで共有する。
 * ガードはプロセス内で共有されるため、払い出した値はトラック間でも重複しない。
 *
 * 4 つのトラックすべてを払い出す。配信しないトラックの分もガードが進むが、値が飛ぶだけで
 * 害は無い。
 *
 * 単体テストから呼ぶため export する (配信の開始以外からは呼ばない)。
 */
export function applyPublishStartGroupIds(): void {
  pub.pubCurrentGroup.value = allocateInitialGroupId();
  pub.pubCurrentAudioGroup.value = allocateInitialGroupId();
  pub.catalogGroup.value = allocateInitialGroupId();
  pub.eventGroup.value = allocateInitialGroupId();
}

/** 配信の接続に使う設定 (接続 URL / Track Namespace / 接続オプション) */
interface PublisherConnectSettings {
  /** 接続に使う MOQT URI (fragment を含む) */
  readonly connectUrl: string;
  /** 接続に使う Track Namespace のフィールド列 */
  readonly namespaceArray: string[];
  /** `connect()` に渡すオプション */
  readonly connectOptions: ReturnType<typeof settings.buildConnectOptions>;
}

/**
 * 配信の接続に使う設定を決める
 *
 * 有効な接続先の候補があれば、その中から 1 つを選ぶ。接続 URL・Track Namespace・
 * Authorization Token は候補の fragment から決め、接続設定の signal は変えない
 * (ほかの接続の設定表示に影響しない)。どの候補を選んだかは、Namespace の検証で接続を
 * 拒否したときにも確かめられるよう、検証より先にパネルへ出して Debug ログにも残す。
 */
function resolvePublisherConnectSettings(): PublisherConnectSettings {
  const target = settings.resolveConnectTarget();
  if (target.selectedServerUrl !== null) {
    addLog("info", "[publisher] selected the connection target from the candidates", {
      url: target.selectedServerUrl,
    });
  }
  pub.pubSelectedServerUrl.value = target.selectedServerUrl;
  return {
    connectUrl: target.connectUrl,
    namespaceArray: settings.resolveConnectNamespace(target),
    connectOptions: settings.buildConnectOptions(settings.resolveConnectAuthorizationToken(target)),
  };
}

export function usePublisher() {
  /**
   * 音声設定に従って音声のストリームを用意し、取れた音の形式を返す
   *
   * `audioSource` が "none" のときは何も作らず null を返す。"dummy" は要求した
   * 形式で 440 Hz の音を作る。"microphone" は選んだデバイスから取り、サンプルレートと
   * チャンネル数はデバイスが決めた実際の値を返す (utils/microphone.ts)
   */
  async function startAudioStream(
    source: AudioSourceType,
    requested: AudioFormat,
  ): Promise<AudioFormat | null> {
    stopAudioStream();
    if (source === "dummy") {
      const generator = createDummyAudioStream(requested.sampleRate, requested.channels);
      pub.audioStream.value = generator.stream;
      pub.audioStreamCleanup.value = (): void => {
        generator.stop();
        for (const track of generator.stream.getTracks()) {
          track.stop();
        }
      };
      await startPublisherAudioMeter(generator.stream, requested);
      // ダミー音声は要求した形式で作るため、取れた形式は要求した値そのものになる
      pub.audioFormat.value = requested;
      return requested;
    }
    if (source === "microphone") {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: buildMicrophoneConstraints({
          deviceId: settings.selectedMicrophoneDeviceId.value,
          sampleRate: requested.sampleRate,
          channels: requested.channels,
          echoCancellation: settings.audioEchoCancellation.value,
          noiseSuppression: settings.audioNoiseSuppression.value,
          autoGainControl: settings.audioAutoGainControl.value,
        }),
      });
      const cleanup = (): void => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      };
      const [track] = stream.getAudioTracks();
      if (track === undefined) {
        cleanup();
        throw new Error("microphone stream has no audio track");
      }
      pub.audioStream.value = stream;
      pub.audioStreamCleanup.value = cleanup;
      await startPublisherAudioMeter(stream, requested);
      // マイクはサンプルレートとチャンネル数をデバイスが決めるため、実際に取れた値を持つ。
      // 取れない項目 (Safari は channelCount 制約を実装しておらず、getSettings も返さない) は
      // 要求値のままにする。実際に流れる形式は取り出し経路が決めるため、
      // prepareAudioForPublishing が AudioFrameSource の値で上書きする
      const captured = resolveCapturedAudioFormat(track.getSettings(), requested);
      pub.audioFormat.value = captured;
      return captured;
    }
    return null;
  }

  /**
   * 配信に使う音声を用意し、配信できれば取れた音の形式を返す (できなければ null)
   *
   * Catalog を作る前に音声のストリームを取る。マイクではサンプルレートとチャンネル数を
   * デバイスが決めるため、実際に取れた値を Catalog と AudioEncoder に使う。
   * 取れた形式の AudioEncoder の設定にブラウザが対応していなければ音声を諦める
   * (Catalog だけ音声トラックを広告すると、購読側は object が来ないまま待ち続ける)。
   * マイクを取れない (許可されないなど) ときも、映像の配信は続けて音声だけを諦める
   * (映像の入力が None のときは、呼び出し側が配信をやめる)。
   *
   * 諦めた理由は必ずログに残す。映像は MediaStreamTrackProcessor が無いブラウザでも
   * HTMLVideoElement で配信できるため、理由が無いと「映像だけの catalog」が何も
   * 告げずに届く (画面では Tracks カードの Advertised が予定を示す)。
   */
  async function prepareAudioForPublishing(
    source: AudioSourceType,
    codec: AudioCodecType,
    bitrate: number,
    requested: AudioFormat,
  ): Promise<AudioFormat | null> {
    if (!resolveAudioPublishable(source)) {
      // 音声を送らない設定 (source が "none") は意図した設定のためログに出さない。
      // 取り出し経路が無いブラウザで音声だけを諦めた場合は、映像だけの catalog が
      // 理由を告げずに届くため、必ず理由を残す
      if (source !== "none") {
        addLog(
          "warn",
          "[publisher] audio publishing requires MediaStreamTrackProcessor or Web Audio AudioWorklet, but neither is available in this browser, publishing without audio",
          { source },
        );
      }
      stopAudioStream();
      return null;
    }
    let format: AudioFormat | null;
    try {
      format = await startAudioStream(source, requested);
    } catch (error) {
      addLog("warn", "[publisher] failed to capture audio, publishing without audio", {
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      stopAudioStream();
      return null;
    }
    if (format === null) {
      return null;
    }
    // 配信に使う取り出し経路を作る。実際の形式 (サンプルレートとチャンネル数) は
    // 経路が決めるため、Catalog と AudioEncoder にはその値を使う。Web Audio 経路では
    // AudioContext と AudioWorkletNode の設定値になり、マイクの形式 (Safari は
    // channelCount 制約を実装しておらず、モノラルで取れることがある) に左右されない
    const audioTrack = pub.audioStream.value?.getAudioTracks()[0];
    if (audioTrack === undefined) {
      addLog("warn", "[publisher] audio stream has no track, publishing without audio", {
        source,
      });
      stopAudioStream();
      return null;
    }
    let frameSource: AudioFrameSource;
    try {
      frameSource = await createAudioFrameSource(audioTrack, format);
    } catch (error) {
      addLog("warn", "[publisher] failed to capture audio frames, publishing without audio", {
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      stopAudioStream();
      return null;
    }
    if (pub.isStopping.value) {
      // 取り出し経路を用意している間に配信の停止が始まった。ここで持ち続けると、
      // 後始末を過ぎた AudioContext が残る
      frameSource.close();
      return null;
    }
    const captured: AudioFormat = {
      sampleRate: frameSource.sampleRate,
      channels: frameSource.channels,
    };
    pub.audioFrameSource.value = frameSource;
    pub.audioFormat.value = captured;
    // 取り出した形式で実際に符号化できるかを、catalog を送る前に確かめる。
    // `AudioEncoder.configure` は未対応の設定でも同期の例外を投げず、非同期の
    // エラーコールバックで知らせる。さらに AAC はプラットフォームのエンコーダーが
    // 対応するサンプルレートとビットレートの下限を持ち、範囲外では
    // isConfigSupported が true を返しても実際の符号化が失敗する (Chrome 155 の
    // macOS で実測。48 kHz ステレオの 64000 bps は EncodingError)。対応の申告だけを
    // 信じると、音声 Object が 1 つも送られないまま catalog だけが音声トラックを
    // 広告する。無音を 1 チャンク実際に符号化して確かめ、失敗したら理由を残して
    // 配信開始を失敗させる (黙って音声を諦めると、利用者は原因を知れない)。
    // 判定規則は src/codec/configSupport.ts を正本とする
    const config = getAudioEncoderConfig(codec, bitrate, captured.sampleRate, captured.channels);
    const probe = await probeAudioEncoderConfig(config);
    if (!probe.supported) {
      stopAudioStream();
      const reason = probe.reason === undefined ? "" : `: ${probe.reason}`;
      throw new Error(
        `audio encoder cannot encode the selected settings: codec=${codec}, codecString=${config.codec}, sampleRate=${captured.sampleRate}, channels=${captured.channels}, bitrate=${bitrate}${reason}`,
      );
    }
    return captured;
  }

  /**
   * 配信に使う音声の取り出し経路を取り出す
   *
   * 取り出し経路は `prepareAudioForPublishing` が用意している。音声を使わない場合は
   * 作成済みのストリームをここで止める。
   */
  function takeAudioFrameSourceForPublishing(audioPublishable: boolean): AudioFrameSource | null {
    if (!audioPublishable) {
      stopAudioStream();
      return null;
    }
    const frameSource = pub.audioFrameSource.value;
    if (!frameSource) {
      throw new Error("Failed to get audio frame source");
    }
    return frameSource;
  }

  /**
   * Preview で音声も取る
   *
   * 配信を始める前に、メーターでマイクが音を拾っているかを確かめられるようにする。
   * 取れないとき (許可されないなど) は警告のログを残し、映像の Preview は続ける
   */
  async function startPreviewAudio(): Promise<void> {
    const source = settings.audioSource.value;
    if (!resolveAudioPublishable(source)) {
      stopAudioStream();
      return;
    }
    try {
      await startAudioStream(source, {
        sampleRate: settings.audioSampleRate.value,
        channels: settings.audioChannels.value,
      });
    } catch (error) {
      addLog("warn", "[publisher] failed to capture audio for preview", {
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      stopAudioStream();
    }
  }

  /** 音声のストリーム (ダミー音声 / マイク) を止める */
  function stopAudioStream(): void {
    // メーターも止め、送った LOC Audio Level の表示も消す
    stopPublisherAudioMeter();
    pub.audioMeterLevel.value = null;
    // 取り出し経路を閉じる。まだ読み出しを始めていない (配信の途中で諦めた) 場合も
    // AudioContext を残さない
    if (pub.audioFrameSource.value) {
      pub.audioFrameSource.value.close();
      pub.audioFrameSource.value = null;
    }
    // 手放したストリームの形式を残さない。Tracks カードは接続設定の値で宣言を出す
    pub.audioFormat.value = null;
    if (pub.audioStreamCleanup.value) {
      pub.audioStreamCleanup.value();
      pub.audioStreamCleanup.value = null;
    }
    pub.audioStream.value = null;
  }

  const startPreview = async (): Promise<void> => {
    try {
      const { width, height } = parseResolution(settings.resolution.value);
      const framerate = settings.framerate.value;
      const source = settings.videoSource.value;
      pub.pubStatus.value = "disconnected";

      if (source === "none") {
        // 映像を送らないときは映像のストリームを取らず、音声だけを確かめる
        pub.pubStatusMessage.value = "Preview: no video";
      } else {
        const deviceId = source === "camera" ? settings.selectedCameraDeviceId.value : undefined;
        const sourceLabel = source === "dummy" ? "Dummy (Canvas)" : "Camera";
        pub.pubStatusMessage.value = `Preview: ${sourceLabel} ${width}x${height} @ ${framerate}fps`;

        const videoStreamResult = await getVideoStream(source, width, height, framerate, deviceId);
        pub.mediaStream.value = videoStreamResult.stream;
        pub.videoStreamCleanup.value = videoStreamResult.cleanup;
      }

      // 音声も Preview から取る (メーターで音を確かめられる)
      await startPreviewAudio();

      pub.isPreviewActive.value = true;
    } catch (error) {
      console.error("Preview error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `Preview failed: ${(error as Error).message}`;
    }
  };

  const stopPreview = (): void => {
    releaseVideoStream();
    pub.isPreviewActive.value = false;
    pub.pubStatus.value = "disconnected";
    pub.pubStatusMessage.value = "Ready to publish";
    // Preview で取った音声 (startPreviewAudio) も止める
    stopAudioStream();
  };

  const togglePreview = (): void => {
    if (pub.isPreviewActive.value) {
      stopPreview();
    } else {
      void startPreview();
    }
  };

  async function processFrames(): Promise<void> {
    // 配信だけを止めた後に開始処理が続いた場合も、フレームを送らない
    if (pub.sendingStopped.value) {
      return;
    }
    const reader = pub.frameReader.value;
    const encoderInstance = pub.encoder.value;
    if (!reader || !encoderInstance) {
      console.error("processFrames: reader or encoder is null", { reader, encoderInstance });
      return;
    }

    try {
      while (encoderInstance.state === "configured") {
        const { value: frame, done } = await reader.read();
        if (done) {
          break;
        }

        // 読んだフレームの timestamp とそのときの壁時計を記録する。撮ってから読むまでの
        // 遅れが最も小さいフレームに合わせて換算する (WallClockMapper)
        pub.videoWallClock.value.observe(
          frame.timestamp,
          performance.timeOrigin + performance.now(),
        );
        // 符号化と送信の時間は読んだ時刻から測る (publishTimingStats.ts)
        pub.publishTimingStats.value.recordRead(frame.timestamp, performance.now());

        if (shouldDropFrame(encoderInstance.encodeQueueSize)) {
          // 閾値を超えたフレームは待たずに破棄する (エンコーダの追従を諦めて遅延を伸ばさない)。
          // 破棄した数は publishTimingStats が数え、統計の encodeQueueDrops はその値から作る
          pub.publishTimingStats.value.recordEncodeQueueDrop(frame.timestamp);
        } else {
          // 新しい Group の要求は、符号化するフレームで消費する (捨てたフレームでは消費しない)
          const decision = decideKeyFrame(
            pub.lastKeyFrameTimestampUs.value,
            frame.timestamp,
            pub.keyframeInterval.value,
            pub.newGroupRequested.value,
          );
          encoderInstance.encode(frame, { keyFrame: decision.keyFrame });
          // 出力が返ったときに、依頼した時点の世代と比べて送信の可否を決める
          recordEncodeGeneration(encodeState.records, encodeState.generation, frame.timestamp);
          pub.lastKeyFrameTimestampUs.value = decision.nextLastKeyFrameTimestampUs;
          if (decision.keyFrame) {
            pub.newGroupRequested.value = false;
          }
          pub.framesEncoded.value++;
        }
        frame.close();
      }
    } catch (error) {
      console.error("Frame processing error:", error);
      console.error("Encoder state at error:", encoderInstance.state);
    }
  }

  function handleEncodedChunk(chunk: EncodedChunkData): void {
    // 送信を止めた後に届いた出力は送らない (Encoder を閉じた後も emit 済みの出力は届き得る)。
    // 対応する記録が無い出力も送らない (配信を始める前の出力、記録を消した後の出力)
    if (!shouldSendEncodedChunk(encodeState.records, encodeState.generation, chunk.timestamp)) {
      return;
    }

    const publisherInstance = pub.publisher.value;
    if (!publisherInstance || publisherInstance.state !== "active") return;

    pub.chunksEncoded.value++;
    const publishTimingStats = pub.publishTimingStats.value;
    const encodedAtMs = performance.now();
    publishTimingStats.recordEncoded(chunk.timestamp, encodedAtMs);
    if (encodedAtMs - pub.publishTimingUpdatedAtMs.value >= PUBLISH_TIMING_UPDATE_INTERVAL_MS) {
      pub.publishTimingUpdatedAtMs.value = encodedAtMs;
      pub.publishTiming.value = publishTimingStats.snapshot(encodedAtMs);
    }

    // フレームを読んだ時点で記録するため、ここで記録が無いことは無い。念のため、無ければ
    // この chunk を読んだ時点とみなす
    const wallClockMicros = pub.videoWallClock.value.toWallClockMicroseconds(
      chunk.timestamp,
      performance.timeOrigin + performance.now(),
    );

    // 送信する Object の内容 (Group / Object ID・payload・LOC Properties・優先度) を組み立てる
    const plan = buildObjectSendPlan(
      { groupId: pub.pubCurrentGroup.value, objectId: pub.pubCurrentObjectId.value },
      chunk,
      wallClockMicros,
    );

    if (plan.isKeyFrame) {
      pub.keyFramesEncoded.value++;
    }

    pub.pubCurrentGroup.value = plan.nextGroupId;
    pub.pubCurrentObjectId.value = plan.nextObjectId;
    if (plan.isKeyFrame) {
      noteGroupId(plan.groupId);
    }

    pub.objectsWithExtensions.value++;

    pub.bytesSent.value += plan.payload.length + plan.properties.length;

    // Object を送信する (送信完了は待たない。完了待ちは stopPublishing の done() で行う)。
    // 完了した時刻を送信の時間として記録する
    void publisherInstance
      .sendObject({
        groupId: plan.groupId,
        objectId: plan.objectId,
        payload: plan.payload,
        properties: plan.properties,
        priority: plan.priority,
      })
      .then(() => {
        publishTimingStats.recordSent(chunk.timestamp, performance.now());
      });

    pub.objectsSent.value++;
  }

  async function processAudioFrames(): Promise<void> {
    // 配信だけを止めた後に開始処理が続いた場合も、音声を送らない
    if (pub.sendingStopped.value) {
      return;
    }
    const reader = pub.audioFrameReader.value;
    const encoder = pub.audioEncoder.value;
    if (!reader || !encoder) {
      console.error("processAudioFrames: reader or encoder is null", { reader, encoder });
      return;
    }

    try {
      while (encoder.state === "configured") {
        const { value: audioData, done } = await reader.read();
        if (done) {
          break;
        }

        // 送る Object の LOC Audio Level は、符号化するサンプルから求める
        // (RFC 6464 Section 3)。符号化へ渡す前にサンプルを時刻つきで記録する
        pub.audioLevelTimeline.value.record(
          audioData.timestamp,
          audioData.duration,
          readAllAudioSamples(audioData),
        );
        const readWallClockMicros = BigInt(
          Math.round((performance.timeOrigin + performance.now()) * 1_000),
        );
        // 読み出した壁時計と `AudioData.timestamp` の差を記録する。音声の LOC TIMESTAMP は
        // この差の最小値へ原点を合わせて作る (src/audioTimestampClock.ts)
        pub.audioTimestampClock.value.record(readWallClockMicros, audioData.timestamp);
        // 読み出しと符号化で溜まった遅れが上限を超えたフレームは、符号化せずに捨てて
        // live へ追いつく (src/audioPublishCatchUp.ts)。映像の encodeQueueSize に
        // よる抑制にあたる仕組みが音声には無く、一度キューが詰まると遅れが固定される。
        // 数フレームの穴は受信側の concealment が埋める
        const encode = pub.audioCatchUp.value.evaluate({
          timestampMicros: audioData.timestamp,
          generation: encodeState.generation,
          readWallClockMicros,
          appliedOffsetMicros: pub.audioTimestampClock.value.appliedMicros,
          durationMicros: audioData.duration,
          nowMs: performance.now(),
        });
        if (encode) {
          encoder.encode(audioData);
        }
        audioData.close();
      }
    } catch (error) {
      console.error("Audio frame processing error:", error);
    }
  }

  /**
   * 音声トラックの publish とエンコーダを用意する
   *
   * 映像とは別の `session.publish` を作り、Group 採番も優先度も独立させる
   * (src/createMediaPublisher.ts の audioPublisher / videoPublisher と同じ構成)。
   * 音声は chunk 1 つが Group 1 つになるため (draft-ietf-moq-loc-04 §4.1)、
   * 映像の Group とは共有できない。
   */
  /**
   * 映像トラックを配信する
   *
   * 映像トラックを PUBLISH し、encoder と映像のフレームの読み出しを用意する。フレームの
   * 読み出しと符号化は呼び出し側が統計を初期化した後に始める (processFrames)
   */
  async function startVideoPublishing(
    session: Session,
    namespaceArray: string[],
    videoInput: VideoInput,
    options: {
      trackName: string;
      codec: CodecType;
      framerate: number;
      bitrate: number;
      maxCacheDuration: number;
      useWorker: boolean;
    },
  ): Promise<void> {
    // Publisher を作成する
    const publisherInstance = await session.publish(
      namespaceArray,
      options.trackName,
      {
        error: (error) => {
          console.error("Publisher error:", error);
          pub.pubStatus.value = "error";
          pub.pubStatusMessage.value = `Publish error: ${error.message}`;
        },
        // draft-ietf-moq-transport-22 §3.1.1:
        // 購読の paused 状態 (FORWARD パラメータ) の変化を追跡する
        onForwardStateChange: (forward) => {
          pub.forwardState.value = forward;
        },
        // draft-ietf-moq-transport-22 Section 9.20.19:
        // 新しい Group の要求を受けたら、次に符号化するフレームをキーフレームにする
        onNewGroupRequest: (newGroupRequest) => {
          pub.newGroupRequestsReceived.value++;
          pub.newGroupRequested.value = true;
          addLog("info", "[publisher] NEW_GROUP_REQUEST received", {
            newGroupRequest: newGroupRequest.toString(),
          });
        },
      },
      {
        maxCacheDuration: BigInt(options.maxCacheDuration),
        // draft-ietf-moq-transport-22 Section 10.6: DYNAMIC_GROUPS=1 を広告し、後から視聴を
        // 始めた購読者が NEW_GROUP_REQUEST で新しい Group を要求できるようにする
        dynamicGroups: true,
        // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
        ...publishAuthorizationTokenOptions(session.setupAuthorizationToken),
      },
    );
    markVideoPublisherEstablished(publisherInstance);

    // 配信ステータスのメッセージは、メディアトラックが揃った後に startPublishing が
    // 確立した全トラックを並べて設定する
    pub.pubStatus.value = "connected";

    // Encoder 設定を作成し、対応状況を確認する
    const encoderConfig = getEncoderConfig(
      options.codec,
      videoInput.width,
      videoInput.height,
      options.bitrate,
      options.framerate,
    );

    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      throw new Error(`Codec not supported: ${encoderConfig.codec}`);
    }

    // EncoderWrapper を作成する
    const encoderInstance = new EncoderWrapper(options.useWorker, {
      output: (chunk) => {
        handleEncodedChunk(chunk);
      },
      error: (error) => {
        console.error("Encoder error:", error);
        pub.encodeErrors.value++;
        pub.encoderState.value = encoderInstance.state;
        pub.pubStatus.value = "error";
        pub.pubStatusMessage.value = `Encoder error: ${error.message}`;
      },
    });
    pub.encoder.value = encoderInstance;
    // 前の配信の記録を持ち越さない (配信ごとの初期化)
    encodeState.records.clear();
    pendingAudioConfig = null;

    // Encoder を設定する
    await encoderInstance.configure(encoderConfig);
    pub.encoderState.value = encoderInstance.state;

    // configure 後の Encoder 状態を検証する
    if (encoderInstance.state !== "configured") {
      throw new Error(`Encoder failed to configure. State: ${encoderInstance.state}`);
    }

    // codec バッジを表示する
    pub.pubCodec.value = `${options.codec.toUpperCase()} ${videoInput.width}x${videoInput.height}`;

    // VideoFrame ソースを作成する
    // MediaStreamTrackProcessor が利用可能な場合はそれを使い、
    // 利用できない場合は requestVideoFrameCallback でフォールバックする
    const videoFrameSource = createVideoFrameSource(videoInput.track);
    pub.frameReader.value = videoFrameSource.readable.getReader();
    // 対応は読んだフレームからとる (processFrames)
    resetVideoPublishState();
  }

  async function startAudioPublishing(
    session: Session,
    namespaceArray: string[],
    audioFrameSource: AudioFrameSource,
    options: {
      // 配信する音声トラックの名前 (catalog の name と同じ値)
      trackName: string;
      useWorker: boolean;
      codec: AudioCodecType;
      bitrate: number;
      sampleRate: number;
      channels: number;
      maxCacheDuration: number;
      // 映像を送らず音声だけを配信するか。このときは音声トラックの PUBLISH の確立で
      // 配信を始めている途中を終え、paused 状態の行に音声トラックの値を出す
      audioOnly: boolean;
    },
  ): Promise<void> {
    const audioPublisherInstance = await session.publish(
      namespaceArray,
      options.trackName,
      {
        error: (error) => {
          console.error("Audio publisher error:", error);
          pub.pubStatus.value = "error";
          pub.pubStatusMessage.value = `Audio publish error: ${error.message}`;
        },
        // 音声には keyframe が無く Audio Config は最初の chunk にしか現れないため、
        // 同じ値を再送しない方針のままだと後から接続した購読者が AAC を復号できない。
        // Catalog の送り直しと同じく、購読が paused でなくなった時点で
        // 保持している Audio Config を次の Object に載せ直す
        onForwardStateChange: (forward) => {
          if (options.audioOnly) {
            pub.forwardState.value = forward;
          }
          if (forward) {
            pub.audioConfigResendRequested.value = true;
          }
        },
      },
      {
        maxCacheDuration: BigInt(options.maxCacheDuration),
        // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
        ...publishAuthorizationTokenOptions(session.setupAuthorizationToken),
      },
    );
    pub.audioPublisher.value = audioPublisherInstance;
    if (options.audioOnly) {
      pub.forwardState.value = audioPublisherInstance.forwardState;
      pub.isStarting.value = false;
    }

    const audioEncoderInstance = new AudioEncoderWrapper(options.useWorker, {
      output: (chunk) => {
        handleAudioEncodedChunk(chunk);
      },
      error: (error) => {
        console.error("Audio encoder error:", error);
        pub.audioEncodeErrors.value++;
        pub.pubStatus.value = "error";
        pub.pubStatusMessage.value = `Audio encoder error: ${error.message}`;
      },
    });
    pub.audioEncoder.value = audioEncoderInstance;
    await audioEncoderInstance.configure(
      options.codec,
      options.bitrate,
      options.sampleRate,
      options.channels,
    );

    // 前の配信のサンプルの記録を持ち越さない
    pub.audioLevelTimeline.value = new AudioLevelTimeline();
    pub.audioTimestampClock.value = new AudioTimestampClock();
    pub.audioCatchUp.value = new AudioPublishCatchUp();
    // 取り出し経路は prepareAudioForPublishing が作っている
    // (MediaStreamTrackProcessor が無いブラウザでは Web Audio 経由になる)
    pub.audioFrameReader.value = audioFrameSource.readable.getReader();
  }

  // WT-H2 で Datagram を選んだときの警告は、配信ごとに 1 回だけ出す
  let loggedAudioDatagramFallback = false;

  // 符号化を依頼した時点の世代と、映像の記録。送信を止めるたびに世代を進めて記録を消し、
  // それ以降に届く出力を捨てる (規則はライブラリと共有する。src/encodeGeneration.ts)
  const encodeState: EncodeState = { generation: 0, records: new Map() };

  // 送らない出力が持っていた Audio Config (まだ送っていない値)。description は configure
  // 後の最初の出力にしか載らないため、送信を止める直前に届いた出力を捨てると、復号に必要な
  // Audio Config を以後の配信で送れなくなる。捨てる出力の値はここに残し、次に送る Object で
  // 載せる (ライブラリの MediaPublisher.pendingAudioConfig と同じ規則)
  let pendingAudioConfig: Uint8Array | null = null;

  // event timeline に載せる履歴。配信を始めるたびに空にする (draft-ietf-moq-msf-01 §8.3)
  let eventHistory: EventTimelineEntry[] = [];

  function handleAudioEncodedChunk(chunk: AudioEncodedChunkData): void {
    // キューに溜まっている音声の長さを測り、この chunk が覆う最初の投入の timestamp を
    // 受け取る。送らない chunk でも測るため、送信の可否より先に記録する
    // (src/audioPublishCatchUp.ts)
    const { timestampMicros, generation: encodedGeneration } =
      pub.audioCatchUp.value.recordEncodedChunk({
        timestampMicros: chunk.timestamp,
        durationMicros: chunk.duration,
        nowMs: performance.now(),
      });
    // 送信を止めた後に届いた出力は送らない。対応する記録が無い出力も送らない
    // 送らない出力でも description は失わない (次に送る Object で載せる)
    if (chunk.description !== undefined && chunk.description.length > 0) {
      pendingAudioConfig = chunk.description;
    }
    if (timestampMicros === null || encodedGeneration !== encodeState.generation) return;
    // フレームを捨てると、符号化の出力の timestamp は投入したフレームの timestamp より
    // 古くなる。LOC TIMESTAMP と Audio Level は、送るサンプルの取得時刻で引く
    const capturedTimestampMicros = timestampMicros;
    const audioPublisherInstance = pub.audioPublisher.value;
    if (!audioPublisherInstance || audioPublisherInstance.state !== "active") return;
    pub.audioChunksEncoded.value++;

    // LOC draft-ietf-moq-loc-04 §4.1 (Application with one audio track):
    // 音声 chunk 1 つ = Object 1 つ = Group 1 つ。2 つ目以降は Group を進め、
    // Object ID は常に 0 にする (ライブラリの allocateAudioObject と同じ規則)
    const allocation = allocateAudioObject({
      groupId: pub.pubCurrentAudioGroup.value,
      started: pub.pubAudioGroupStarted.value,
    });
    pub.pubAudioGroupStarted.value = allocation.state.started;
    pub.pubCurrentAudioGroup.value = allocation.state.groupId;
    if (allocation.groupAdvanced) {
      noteGroupId(allocation.state.groupId);
    }

    // LOC Audio Level (draft-ietf-moq-loc-04 §2.3.3.2) は RFC 6464 §3 に従い、
    // chunk が符号化するサンプル列の RMS から -dBov を求める。符号化へ渡したときに
    // 記録したサンプルのうち、chunk の時間の範囲に重なる分を使う (processAudioFrames)
    const audioLevel = pub.audioLevelTimeline.value.levelFor(
      capturedTimestampMicros,
      chunk.duration,
    );
    // 配信側のメーターに、直近に送った LOC Audio Level を出す
    pub.audioMeterLevel.value = audioLevel;

    // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config): AAC の AudioSpecificConfig は
    // 同じ値を毎 Object 送らない
    const {
      config: audioConfig,
      next: nextAudioConfig,
      resendNext,
    } = resolveAudioConfigToSend(
      pub.lastSentAudioConfig.value,
      selectCodecDescription(chunk.description, pendingAudioConfig),
      pub.audioConfigResendRequested.value,
    );
    pub.lastSentAudioConfig.value = nextAudioConfig;
    pub.audioConfigResendRequested.value = resendNext;
    // 解決に使った保留値は消す (次に同じ値を載せない)
    pendingAudioConfig = null;

    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る (draft-ietf-moq-loc-04 §2.3.1.1)。
    // `AudioData.timestamp` は壁時計ではないため、読み出した壁時計との差の
    // 最小値で原点を合わせる。まだ観測が無いときだけ従来の換算へ落とす
    const locTimestampMicros =
      pub.audioTimestampClock.value.apply(capturedTimestampMicros) ??
      LOC.toUnixEpochMicroseconds(BigInt(capturedTimestampMicros), performance.timeOrigin);
    const properties = LOC.encodeAudioProperties({
      timestamp: locTimestampMicros,
      audioLevel,
      config: audioConfig,
    });

    // Object を送信する (送信完了は待たない。完了待ちは stopPublishing の done() で行う)。
    // Datagram は draft-ietf-moq-transport-22 §11.2。WT-H2 は datagram を運べない
    const sendParams = {
      groupId: allocation.groupId,
      objectId: allocation.objectId,
      payload: chunk.data,
      properties,
      priority: PRIORITY_AUDIO,
    };
    // 送った Object を数える (video の objectsSent / bytesSent と同じ扱い)
    pub.audioObjectsSent.value++;
    // 送る copy の数と 1 回あたりのバイト数を決める。datagram は冗長度の数だけ送り、
    // subgroup は 1 回だけ送る。バイト数は実際に送る copy ごとに数える (Object 1 件に
    // つき 1 回ではない)
    const sendCopyPlan = buildAudioSendCopyPlan({
      delivery: settings.audioDelivery.value,
      reliability: pub.pubSession.value?.reliability,
      redundancy: settings.audioRedundancy.value,
      payloadBytes: chunk.data.length,
      propertiesBytes: properties.length,
    });
    if (sendCopyPlan.datagram) {
      pub.audioDatagramObjectsSent.value++;
      try {
        // 冗長度の数だけ同じ Object を送る。全ての copy が落ちる確率は損失率の冗長度乗に
        // なる (受信側は同じ識別子の Object の 2 回目以降を捨てる)。帯域は音声の分だけ
        // 冗長度倍になる
        //
        // 2 個目以降を後続の Object と一緒に送る案は、まとめて落ちる経路で強い (実測: 5 個
        // 連続で落とす注入で欠落 1.6〜1.8 % → 0.1 %) が、損失を注入しない長時間の観測では
        // 実際の経路の損失は輻輳でまとめて落ちるため、2 個目以降を間隔を空けて送る案を
        // 実装して測った (5 個連続で落とす注入で欠落 1.6〜1.8 % → 0.1 %)。ただし、遅れて
        // 届く復旧の分が遅れの推定を膨らませ、交互に各 3 回の比較で鳴り始めの遅れが
        // 64〜67 ms から 120〜122 ms へ上がった。位置の順序で除く案でも改善しなかったため、
        // 続けて送る (docs/AUDIO_PLAYOUT_LATENCY.md)
        for (let copy = 0; copy < sendCopyPlan.copies; copy++) {
          void audioPublisherInstance.sendDatagram(sendParams);
          pub.audioBytesSent.value += sendCopyPlan.bytesPerCopy;
        }
        // 送信の遅れを記録する。送信の完了を待たず、投入の直後を記録する
        // (recordAudioDatagramSent の JSDoc を参照)。ここを記録しないと、受信側の到着の遅れを
        // 配信側と経路に分けられない
        recordAudioDatagramSent(
          pub.audioCatchUp.value,
          {
            timestampMicros: capturedTimestampMicros,
            locTimestampMicros,
            durationMicros: chunk.duration,
          },
          performance.now(),
        );
      } catch (error) {
        // 送れなかった Object は記録しない (送信キューに入っていない)
        console.error("Failed to send audio datagram:", error);
      }
      return;
    }
    if (
      settings.audioDelivery.value === "datagram" &&
      pub.pubSession.value?.reliability === "reliable-only" &&
      !loggedAudioDatagramFallback
    ) {
      loggedAudioDatagramFallback = true;
      console.warn(
        "Audio datagram is unavailable on reliable-only WebTransport; sending on a subgroup stream",
      );
    }
    // 送信キューに入れてから送信が終わるまでの遅れを測る (src/audioPublishCatchUp.ts)。
    // 音声は 1 Object = 1 Group = 1 ストリームであり (draft-ietf-moq-loc-04 §4.1)、
    // ストリームの生成と書き込みの待ちがそのまま配信側の遅れになる。送信の待ちは
    // 符号化の出力より後ろにあるため、符号化のキューの計器では見えない
    const catchUp = pub.audioCatchUp.value;
    const sendStartedAtMs = performance.now();
    let sendResult: Promise<void>;
    try {
      // 音声は 1 Object = 1 Group なので、この Object で Subgroup を閉じる
      // (draft-ietf-moq-transport-22 §11.3.2)。sendDatagram には渡さない
      // (構造的部分型で通ってしまい、Datagram では読まれないフィールドになるため)
      sendResult = audioPublisherInstance.sendObject({ ...sendParams, endOfSubgroup: true });
    } catch (error) {
      console.error("Failed to send audio object:", error);
      return;
    }
    // subgroup は 1 回だけ送る。送信キューへ投入できた時点で、実際に送った copy の
    // バイト数を数える
    pub.audioBytesSent.value += sendCopyPlan.bytesPerCopy;
    catchUp.recordSendStart({
      timestampMicros: capturedTimestampMicros,
      capturedWallClockMs: Number(locTimestampMicros) / 1_000,
      durationMs: (chunk.duration ?? 0) / 1_000,
      nowMs: sendStartedAtMs,
    });
    const complete = (): void => {
      catchUp.recordSendComplete({
        timestampMicros: capturedTimestampMicros,
        completedWallClockMs: performance.timeOrigin + performance.now(),
      });
    };
    // 送信完了は待たない (完了待ちは stopPublishing の done() で行う)。失敗しても記録を消す
    void sendResult.then(complete, complete);
  }

  // Catalog を新しい Group で送り直す
  //
  // 購読が paused でなくなったときと、catalog が relay の cache から落ちる前
  // (scheduleCatalogRepublish の予約) に呼ぶ。
  // 同じ Location を 2 度送ると購読側で重複として扱われるため、送り直しは Group を
  // 進めて行う (draft-ietf-moq-msf-01 §6.1)。Object ID は Group の先頭 Object の
  // ため 0 にする (§6.2)。Catalog Publisher が active でなければ何もしない
  // (送り直しの予約もしない)。
  const sendCatalogUpdate = async (): Promise<void> => {
    // 配信だけを止めた後は、購読者の FORWARD で送り直しを再開しない
    if (pub.sendingStopped.value) {
      return;
    }
    const catalogPublisherInstance = pub.catalogPublisher.value;
    const currentCatalog = pub.catalog.value;
    if (
      !catalogPublisherInstance ||
      catalogPublisherInstance.state !== "active" ||
      currentCatalog === null
    ) {
      return;
    }
    const groupId = pub.catalogGroup.value + 1;
    pub.catalogGroup.value = groupId;
    noteGroupId(groupId);
    // 次の送り直しを、この送信から数えて予約し直す
    scheduleCatalogRepublish(sendCatalogUpdate);
    await catalogPublisherInstance.sendObject({
      groupId,
      objectId: 0,
      payload: encodeCatalog(currentCatalog),
      // 送信の直後に Subgroup を閉じる理由は sendCatalogObject (ライブラリ側) と同じ
      endOfSubgroup: true,
    });
    addLog(
      "info",
      `[publisher] [SEND] OBJECT (${formatFullTrackName(
        pub.pubConnectedNamespace.value ?? settings.namespaceArray.value,
        CATALOG_TRACK_NAME,
      )}, updated)`,
      {
        source: "publish",
        catalogGroup: groupId,
      },
    );
  };

  /**
   * event timeline トラックを publish する
   *
   * catalog が広告する event timeline トラックを実際に publish する。devtools は
   * audio / video 以外のデータを流す例としてここにメッセージを送る。
   * 失敗しても catalog には載っているため、購読側は購読を始められる (保留になる)
   */
  async function startEventPublishing(
    session: Session,
    namespaceArray: string[],
    maxCacheDuration: number,
  ): Promise<void> {
    // 配信だけを止めた後に開始処理が続いた場合も、event timeline を購読しない
    if (pub.sendingStopped.value) {
      return;
    }
    const eventPublisherInstance = await session.publish(
      namespaceArray,
      EVENT_TRACK_NAME,
      {
        error: (error) => {
          console.error("Event timeline publisher error:", error);
          addLog("error", "[publisher] event timeline publish error", {
            message: error.message,
          });
        },
      },
      {
        maxCacheDuration: BigInt(maxCacheDuration),
        // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
        ...publishAuthorizationTokenOptions(session.setupAuthorizationToken),
      },
    );
    pub.eventPublisher.value = eventPublisherInstance;
  }

  /**
   * event timeline にメッセージを 1 件送る
   *
   * draft-ietf-moq-msf-01 §8.3: Group の先頭 Object には、それまでに蓄積されアクセス
   * 可能な全レコードを載せなければならない (MUST)。devtools はメッセージごとに新しい
   * Group を始め、Object ID 0 にその時点の履歴 (直近 EVENT_HISTORY_LIMIT 件) を載せる。
   * 後から購読を始めた相手も、直近の Group の先頭 Object から履歴を受け取れる
   */
  const sendEventMessage = async (text: string): Promise<void> => {
    const eventPublisherInstance = pub.eventPublisher.value;
    if (!eventPublisherInstance || eventPublisherInstance.state !== "active") return;
    if (text.length === 0) return;

    eventHistory = appendMessageEventEntry(eventHistory, buildMessageEventEntry(text, Date.now()));
    const groupId = pub.eventGroup.value + 1;
    pub.eventGroup.value = groupId;
    noteGroupId(groupId);
    try {
      await eventPublisherInstance.sendObject({
        groupId,
        objectId: 0,
        payload: encodeEventTimeline(eventHistory),
        // 1 メッセージ = 1 Group = 1 Object。送信の直後に Subgroup を閉じる
        // (draft-ietf-moq-transport-22 §11.3.2)。次のメッセージが 30 秒以上来ないと
        // 開いたままになり、次の Object を待つ購読側が DATA_STREAM_TIMEOUT で閉じる (§12.2)
        endOfSubgroup: true,
      });
      pub.eventMessagesSent.value++;
    } catch (error) {
      // 送信に失敗しても配信そのものは続ける。呼び出し側は void で呼ぶため、
      // ここで受け止めてログに残す (unhandled rejection にしない)
      addLog("error", "[publisher] failed to send event timeline message", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const startPublishing = async (): Promise<void> => {
    // 配信を始めている途中として扱う (pub.isStarting)。connect を待つ間に Subscriber を
    // 止めても、接続設定の入力を有効に戻さない
    pub.isStarting.value = true;
    // 前の配信で配信だけを止めていた場合も、新しい配信では送る
    pub.sendingStopped.value = false;
    loggedAudioDatagramFallback = false;
    try {
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = "Connecting...";
      pub.httpVersion.value = null;
      settings.settingsDisabled.value = true;

      // 接続先・Namespace・接続オプションを決める。選んだ候補はパネルに出す
      const { connectUrl, namespaceArray, connectOptions } = resolvePublisherConnectSettings();
      // 配信中のログに出す、接続時に決めた Track Namespace (候補の fragment が決めることがある)
      pub.pubConnectedNamespace.value = namespaceArray;
      const videoTrackNameValue = settings.videoTrackName.value;
      const codecValue = settings.codec.value;
      const videoSourceValue = settings.videoSource.value;
      const { width, height } = parseResolution(settings.resolution.value);
      const framerateValue = settings.framerate.value;
      const bitrateValue = settings.bitrate.value;
      const maxCacheDurationValue = settings.maxCacheDuration.value;
      const audioTrackNameValue = settings.audioTrackName.value;
      const audioSourceValue = settings.audioSource.value;
      const audioCodecValue = settings.audioCodec.value;
      const audioBitrateValue = settings.audioBitrate.value;
      const audioSampleRateValue = settings.audioSampleRate.value;
      const audioChannelsValue = settings.audioChannels.value;
      pub.keyframeInterval.value = settings.keyframeInterval.value;

      // 映像も音声も送らない設定では、配信するトラックが無いため接続しない
      if (videoSourceValue === "none" && audioSourceValue === "none") {
        throw new Error("nothing to publish: both video source and audio source are none");
      }

      // 配信する予定のトラック名を接続の前に検証する (draft-ietf-moq-msf-01 §5.2.3)。
      // 接続してから catalog を組み立てる段で失敗すると、relay に publish だけを作って
      // 止まることになる。広告しないトラックの名前は catalog に出ないため検証しない
      // (画面の Tracks カードの警告と同じ判定を使う。utils/publishTracks.ts)
      const advertisedTrackNames: string[] = [];
      if (resolveVideoAdvertisement(videoSourceValue).advertised) {
        advertisedTrackNames.push(videoTrackNameValue);
      }
      if (resolveAudioAdvertisement(audioSourceValue, isAudioFrameSourceAvailable()).advertised) {
        advertisedTrackNames.push(audioTrackNameValue);
      }
      // event timeline トラックは配信の有無にかかわらず常に広告する。メディアの
      // トラック名との衝突 (同名) もここで拒否する
      advertisedTrackNames.push(EVENT_TRACK_NAME);
      assertTrackNames(advertisedTrackNames);

      // 接続先が決まっていることを確かめる (MOQT URI 欄は候補の表示欄で、手入力は無い)
      const connectTargetError = settings.connectTargetProblem(connectUrl);
      if (connectTargetError !== null) {
        throw new Error(connectTargetError);
      }

      // MOQT サーバーへ接続する
      const session = await connect(
        connectUrl,
        {
          close: (closeInfo) => {
            addLog("warn", `[publisher] webtransport closed`, {
              closeCode: closeInfo.closeCode,
              // WebTransportCloseInfo.reason は optional のため未指定時は空文字にする
              reason: (closeInfo.reason ?? "").slice(0, 1024),
            });
            // 配信の開始に失敗したときは、catch が失敗の理由を status に出した後に
            // ここへ来る (後始末の session.close() で閉じるため)。失敗の理由を
            // 「Disconnected」で上書きすると、利用者に原因が伝わらない
            if (pub.pubStatus.value !== "error") {
              pub.pubStatus.value = "disconnected";
              pub.pubStatusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            }
            cleanupPublisher();
          },
          error: (error) => {
            addLog("error", `[publisher] webtransport error`, {
              name: error.name ?? "Error",
              message: error.message ?? String(error),
            });
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `Error: ${error.message}`;
            cleanupPublisher();
          },
          debug: handleDebugMessage,
        },
        connectOptions,
      );
      pub.pubSession.value = session;
      pub.httpVersion.value = resolvePanelHttpVersion(session.reliability, browserIsChromium());

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = "Connected, publishing catalog...";

      // Catalog を publish
      const catalogPublisherInstance = await session.publish(
        namespaceArray,
        CATALOG_TRACK_NAME,
        {
          error: (error) => {
            console.error("Catalog publisher error:", error);
          },
          // 購読者が付いて Catalog の購読が paused でなくなったら送り直す。
          //
          // draft-ietf-moq-transport-22 §3.1.1: publisher は購読が paused の間 Object を
          // 送らない。relay は購読者が居ない間 FORWARD=0 を伝えるため、配信開始時に送った
          // Catalog は送信が見送られるか、購読者へ届く前に捨てられる。後から視聴を始めた
          // 相手にもトラック構成を知らせるため、paused でなくなった時点で新しい Group と
          // して送り直す
          onForwardStateChange: (forward) => {
            if (forward) {
              void sendCatalogUpdate();
            }
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
          // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH にも MUST 付与する
          ...publishAuthorizationTokenOptions(session.setupAuthorizationToken),
        },
      );
      pub.catalogPublisher.value = catalogPublisherInstance;

      // 音声を配信するかどうかを決め、配信するなら取れた音の形式を得る
      // (prepareAudioForPublishing)。Catalog と AudioEncoder にはこの形式を使う
      const audioFormat = await prepareAudioForPublishing(
        audioSourceValue,
        audioCodecValue,
        audioBitrateValue,
        { sampleRate: audioSampleRateValue, channels: audioChannelsValue },
      );
      const audioPublishable = audioFormat !== null;
      // 映像を送らず音声も用意できなければ、配信するトラックが無い。catalog を送る前にやめる
      // (トラックの無い catalog を広告しない)
      if (videoSourceValue === "none" && !audioPublishable) {
        throw new Error(
          `nothing to publish: video source is none and audio (${audioSourceValue}) is not available`,
        );
      }

      // Catalog を作成して送信
      const createdCatalog = buildPublisherCatalog(
        buildPublisherCatalogOptionsFromSettings(audioFormat),
      );
      const catalogPayload = encodeCatalog(createdCatalog);
      // 映像 / 音声 / Catalog / event timeline の開始 Group ID をここでまとめて払い出す
      // (draft-ietf-moq-msf-01 §6.1。理由は applyPublishStartGroupIds を参照)
      applyPublishStartGroupIds();
      // 購読が paused でなくなった時点で送り直すため、送信前に保持値を確定させる
      pub.catalog.value = createdCatalog;
      // Catalog の送信完了は待たず、stopPublishing の done() で待ち合わせる
      // 送信の直後に Subgroup を閉じる理由は sendCatalogObject (ライブラリ側) と同じ
      void catalogPublisherInstance.sendObject({
        groupId: pub.catalogGroup.value,
        objectId: 0,
        payload: catalogPayload,
        endOfSubgroup: true,
      });
      // catalog が relay の cache から落ちる前に送り直す (draft-ietf-moq-msf-01 Section 5)
      startCatalogRepublish(maxCacheDurationValue, sendCatalogUpdate);
      addLog(
        "info",
        `[publisher] [SEND] OBJECT (${formatFullTrackName(namespaceArray, CATALOG_TRACK_NAME)})`,
        {
          source: "publish",
          catalog: createdCatalog,
        },
      );

      pub.pubStatusMessage.value = "Connected, preparing encoder...";

      // 映像のストリームを用意する。映像の入力が None なら作らず、Preview の映像も手放す
      // (配信しない映像を映し続けない)
      let videoInput: VideoInput | null = null;
      if (videoSourceValue === "none") {
        releaseVideoStream();
      } else {
        videoInput = await prepareVideoForPublishing(
          videoSourceValue,
          width,
          height,
          framerateValue,
        );
      }
      const audioFrameSource = takeAudioFrameSourceForPublishing(audioPublishable);
      // Preview で取った映像と音声は配信に引き継いだ
      pub.isPreviewActive.value = false;

      const useWorker = settings.useDedicatedWorker.value;
      if (videoInput !== null) {
        await startVideoPublishing(session, namespaceArray, videoInput, {
          trackName: videoTrackNameValue,
          codec: codecValue,
          framerate: framerateValue,
          bitrate: bitrateValue,
          maxCacheDuration: maxCacheDurationValue,
          useWorker,
        });
      }

      // 音声トラックを配信する
      if (audioFrameSource && audioFormat !== null) {
        await startAudioPublishing(session, namespaceArray, audioFrameSource, {
          trackName: audioTrackNameValue,
          useWorker,
          codec: audioCodecValue,
          bitrate: audioBitrateValue,
          sampleRate: audioFormat.sampleRate,
          channels: audioFormat.channels,
          maxCacheDuration: maxCacheDurationValue,
          // 映像を送らないときは、音声トラックが配信の確立と paused 状態を表す
          audioOnly: videoInput === null,
        });
      }

      // event timeline トラックを配信する。メディアの配信を壊さないよう、失敗しても
      // 警告に留める (catalog には載っているため、購読側は購読を保留にできる)
      try {
        await startEventPublishing(session, namespaceArray, maxCacheDurationValue);
      } catch (error) {
        addLog("warn", "[publisher] failed to publish event timeline track", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (videoInput === null) {
        // 映像の統計 (符号化と送信の時間など) は前の配信のものを持ち越さない
        resetVideoPublishState();
      }
      // 配信ステータスは接続の段階を示す (トラックの一覧は Catalog パネルが出す)
      pub.pubStatusMessage.value = "Publishing";

      // 統計値をリセットする
      pub.framesEncoded.value = 0;
      pub.keyFramesEncoded.value = 0;
      pub.objectsSent.value = 0;
      pub.pubCurrentObjectId.value = 0;
      pub.bytesSent.value = 0;
      pub.chunksEncoded.value = 0;
      pub.encodeErrors.value = 0;
      pub.objectsWithExtensions.value = 0;
      pub.audioObjectsSent.value = 0;
      pub.audioDatagramObjectsSent.value = 0;
      pub.audioBytesSent.value = 0;
      pub.audioChunksEncoded.value = 0;
      pub.audioEncodeErrors.value = 0;
      pub.pubAudioGroupStarted.value = false;
      // 直前に送った Audio Config と送り直し要求は配信ごとに忘れる。保留値も同じ理由で
      // 忘れる (映像のみの配信ではここが唯一の破棄点であり、残すと前の配信の codec の値を
      // 新しい配信の最初の Object に載せてしまう)
      pub.lastSentAudioConfig.value = null;
      pub.audioConfigResendRequested.value = false;
      pendingAudioConfig = null;
      // event timeline の履歴も配信ごとに初期化する (開始 Group ID は配信の始めに
      // applyPublishStartGroupIds が払い出している)
      eventHistory = [];
      pub.eventMessagesSent.value = 0;

      // フレームを読み出してエンコードする
      if (videoInput !== null) {
        void processFrames();
      }
      if (audioFrameSource) {
        void processAudioFrames();
      }
    } catch (error) {
      console.error("Connection error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `Failed: ${(error as Error).message}`;
      // 接続設定の入力を有効に戻すかは cleanupPublisher が Subscriber の有無を見て決める。
      // 購読中や確立を待っている Subscriber が居れば、入力は無効のまま残す
      cleanupPublisher();
    }
  };

  const stopPublishing = async (): Promise<void> => {
    // 二重実行防止
    if (pub.isStopping.value) {
      return;
    }
    pub.isStopping.value = true;

    // 配信だけを止めた後に Stop を押したときは、何も送らずにセッションを閉じる
    // (close-session と同じ。配信を止めたまま 3 つ目の止め方を作らない)
    const stopMode = pub.sendingStopped.value ? "close-session" : settings.publishStop.value;
    const plan = buildPublishStopPlan(stopMode);
    // 止め方で送るメッセージが変わるため、選んだ止め方をログに残す
    addLog("info", `[publisher] [STOP] ${stopMode}`, {
      sendPublishDone: plan.sendPublishDone,
      sendCompleteCatalog: plan.sendCompleteCatalog,
      closeSession: plan.closeSession,
    });

    // セッションを閉じない止め方では、接続は生きたまま送信だけを止める
    pub.pubStatus.value = plan.closeSession ? "disconnected" : "connected";
    pub.pubStatusMessage.value = plan.closeSession ? "Disconnecting..." : plan.statusMessage;

    // 配信を終えるため catalog の送り直しを止める
    cancelCatalogRepublish();

    try {
      // Complete catalog を送信
      if (
        plan.sendCompleteCatalog &&
        pub.catalogPublisher.value &&
        pub.catalogPublisher.value.state === "active"
      ) {
        const completeCatalog = createCompleteCatalog();
        const completeCatalogPayload = encodeCatalog(completeCatalog);
        // 最後に Catalog を送った Group の次を使う。固定値にすると、購読者の到着に
        // よる Catalog の送り直しと Group ID が衝突し得る (draft-ietf-moq-msf-01 §6.1)。
        const completeCatalogGroup = pub.catalogGroup.value + 1;
        pub.catalogGroup.value = completeCatalogGroup;
        noteGroupId(completeCatalogGroup);
        // Complete catalog の送信完了は直後の done() で待ち合わせる
        void pub.catalogPublisher.value.sendObject({
          groupId: completeCatalogGroup,
          objectId: 0,
          payload: completeCatalogPayload,
        });
        addLog(
          "info",
          `[publisher] [SEND] OBJECT (${formatFullTrackName(
            pub.pubConnectedNamespace.value ?? settings.namespaceArray.value,
            CATALOG_TRACK_NAME,
          )}, complete)`,
          {
            source: "publish",
            catalog: completeCatalog,
          },
        );
        await pub.catalogPublisher.value.done();
      }

      if (plan.sendPublishDone) {
        if (pub.publisher.value && pub.publisher.value.state === "active") {
          await pub.publisher.value.done();
        }

        if (pub.audioPublisher.value && pub.audioPublisher.value.state === "active") {
          await pub.audioPublisher.value.done();
        }

        if (pub.eventPublisher.value && pub.eventPublisher.value.state === "active") {
          await pub.eventPublisher.value.done();
        }
      }
    } finally {
      if (plan.closeSession) {
        cleanupPublisher();
      } else if (plan.stopSending) {
        // セッションと PUBLISH は維持したまま、送信の経路だけを止める。購読者には何も届かない
        // 状態が続く。PUBLISH_DONE を送らない止め方のため、event timeline の購読を外し、
        // 購読者の FORWARD で catalog の送り直しが再開しないよう catalog の PUBLISH も外す
        stopSendingPaths();
        if (plan.detachEventPublisher) {
          pub.eventPublisher.value = null;
        }
        if (plan.detachCatalogPublisher) {
          pub.catalogPublisher.value = null;
        }
        pub.sendingStopped.value = true;
      }
      pub.isStopping.value = false;
      pub.pubStatus.value = plan.closeSession ? "disconnected" : "connected";
      pub.pubStatusMessage.value = plan.statusMessage;
    }
  };

  /**
   * 各 track で開いている Subgroup を閉じる
   *
   * draft-ietf-moq-transport-22 §11.3.2 (Closing Subgroup Streams):
   * 開いている Subgroup が無い track と、既に closed の Publisher では何もしない。
   * 戻り値は reject しないため待たない
   */
  function closePublisherSubgroups(): void {
    for (const publisher of [
      pub.publisher.value,
      pub.audioPublisher.value,
      pub.catalogPublisher.value,
      pub.eventPublisher.value,
    ]) {
      if (publisher !== null) {
        void publisher.closeSubgroup();
      }
    }
  }

  /**
   * 配信の送信経路を止める (セッションは閉じない)
   *
   * フレームの読み出しと encoder を止め、catalog の送り直しも止める。PUBLISH は残るため、
   * 購読者には何も届かない状態が続く (draft-ietf-moq-transport-22 §7.4: 購読は unsubscribe
   * するか、上流の publisher が購読を終えるか、購読の期限が切れるまで残る)。
   */
  function stopSendingPaths(): void {
    // これ以降に届く符号化の出力を捨てる (Encoder を閉じた後も emit 済みの出力は届き得る)
    advanceEncodeGeneration(encodeState);

    // 開いている Subgroup を閉じる (draft-ietf-moq-transport-22 §11.3.2)。セッションと
    // PUBLISH は維持したまま送信だけを止めるため、閉じないと次の Object を待つ購読側が
    // DATA_STREAM_TIMEOUT (0x12) でセッションを閉じうる
    closePublisherSubgroups();

    // catalog の送り直しを止める (切断やエラーでの後始末を含む)
    cancelCatalogRepublish();

    // フレームリーダーをキャンセルする
    if (pub.frameReader.value) {
      void pub.frameReader.value.cancel();
      pub.frameReader.value = null;
    }
    // 次の配信では新しいフレームで対応をとり直す
    pub.videoWallClock.value = new WallClockMapper();

    // Encoder を閉じる
    if (pub.encoder.value) {
      try {
        pub.encoder.value.close();
      } catch {
        // 無視する
      }
      pub.encoder.value = null;
    }
    pub.encoderState.value = "unconfigured";

    // 音声のフレームリーダーをキャンセルする
    if (pub.audioFrameReader.value) {
      void pub.audioFrameReader.value.cancel();
      pub.audioFrameReader.value = null;
    }

    // 音声 Encoder を閉じる
    if (pub.audioEncoder.value) {
      try {
        pub.audioEncoder.value.close();
      } catch {
        // 無視する
      }
      pub.audioEncoder.value = null;
    }

    // 映像ストリームを解放する
    releaseVideoStream();

    // 音声ストリームを解放する
    stopAudioStream();
  }

  const cleanupPublisher = (): void => {
    pub.pubConnectedNamespace.value = null;
    stopSendingPaths();
    // セッションを閉じたため、配信を止めた状態は残さない
    pub.sendingStopped.value = false;

    // セッションを閉じる
    if (pub.pubSession.value) {
      pub.pubSession.value.close().catch(() => {
        // 既にクローズされている場合は無視
      });
      pub.pubSession.value = null;
    }

    pub.publisher.value = null;
    pub.audioPublisher.value = null;
    pub.eventPublisher.value = null;
    pub.catalogPublisher.value = null;
    pub.catalog.value = null;
    // catalogGroup は次回の startPublishing が allocateInitialGroupId で払い出し直す。
    // 送信済みの最大値は単調ガード (noteGroupId) が覚えているため、ここでは触らない。
    pub.pubCodec.value = "";
    pub.forwardState.value = null;
    pub.httpVersion.value = null;
    // 配信を始めている途中だった場合も、後始末で終わる
    pub.isStarting.value = false;

    // 接続設定を使っている Subscriber (購読の確立を待っているものを含む) が居なければ、
    // 接続設定の入力を有効に戻す
    if (!sub.hasActiveSubscriber.value) {
      settings.settingsDisabled.value = false;
    }
  };

  return {
    startPreview,
    stopPreview,
    togglePreview,
    startPublishing,
    stopPublishing,
    sendEventMessage,
  };
}
