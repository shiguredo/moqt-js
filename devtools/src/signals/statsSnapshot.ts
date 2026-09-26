import type { Catalog, SessionStatistics } from "moqt-js";
import type { PanelHttpVersion } from "../utils/httpVersion";
import type { PlaybackTimingSnapshot } from "../utils/playbackTimingStats";
import type { PublishTimingSnapshot } from "../utils/publishTimingStats";
import type { StatusType } from "../types";
import {
  audioMeterLevel,
  audioMeterPeakDbfs,
  audioMeterRmsDbfs,
  audioPublisher,
  bytesSent,
  catalog,
  chunksEncoded,
  encodeErrors,
  encoderState,
  forwardState,
  framesEncoded,
  httpVersion,
  keyFramesEncoded,
  newGroupRequestsReceived,
  objectsSent,
  objectsWithExtensions as pubObjectsWithExtensions,
  pubCodec,
  pubCurrentGroup,
  pubSession,
  pubStatus,
  pubStatusMessage,
  publishTimingStats,
} from "./publisher";
import { type AvSyncSnapshot, type SubscriberInstance } from "./subscriber";
import { url } from "./connectionSettings";

/**
 * 統計のスナップショット
 *
 * `window.moqtDevTools` (テスト用 API) とデバッグパネルの「Copy for LLM」が同じ統計を
 * 別々に組み立てていると、統計を足したときにどちらかへ足し忘れる。変換をここ 1 箇所に
 * 置き、両方ともこのスナップショットから読む。
 * 画面のパネル (`PublisherPanel` / `SubscriberPanel`) は今も signal を直接読む
 * (表示の粒度がスナップショットと合わないため)。画面の統合は別途行う。
 *
 * 値が無いことは null で表す。0 や false は値があるため null へ潰さない。
 */

/**
 * Publisher の音声の状態
 *
 * 音声トラックは映像とは別の `session.publish` を持つため (`signals/publisher.ts` の
 * `audioPublisher`)、映像の統計とは分けて持つ。
 */
export interface PublisherAudioStats {
  /** 音声トラックの PUBLISH が確立しているか */
  publishing: boolean;
  /** 配信側の音声メーターの peak / RMS (dBFS)。まだ測っていないときは null */
  meterPeakDbfs: number | null;
  meterRmsDbfs: number | null;
  /** 直近に送った Object の LOC Audio Level (-dBov) と voice activity */
  lastSentLevel: number | null;
  lastSentVoiceActivity: boolean | null;
}

/** Publisher の統計 */
export interface PublisherStats {
  status: StatusType;
  /** 画面に出す状態の説明 */
  statusMessage: string;
  serverUrl: string;
  /** 確立した WebTransport が HTTP/2 か HTTP/3 か。未接続、または判別できないときは null */
  httpVersion: PanelHttpVersion | null;
  /** Forward State。未確立のときは null (draft-ietf-moq-transport-21 Section 3.1) */
  forwardState: boolean | null;
  codec: string;
  encoderState: string;
  framesEncoded: number;
  keyFramesEncoded: number;
  /** 符号化した Chunk 数 (framesEncoded はキーフレーム要求などの影響を受ける) */
  chunksEncoded: number;
  /** 符号化のエラー数 */
  encodeErrors: number;
  objectsSent: number;
  objectsWithExtensions: number;
  bytesSent: number;
  currentGroup: number;
  /** 受けた新しい Group の要求 (NEW_GROUP_REQUEST) の数 */
  newGroupRequests: number;
  /** 符号化 (読んでから encoder の出力まで) と送信 (出力から sendObject の完了まで) の時間 */
  publishTiming: PublishTimingSnapshot;
  audio: PublisherAudioStats;
  /** 制御ストリームとデータストリームの統計。未接続のときは null */
  sessionStatistics: SessionStatistics | null;
  /** 送信している Catalog。まだ送っていないときは null */
  catalog: Catalog | null;
}

/** Subscriber の音声の統計 */
export interface SubscriberAudioStats {
  /** 受信した音声 Object の数 (復号に渡す前のものも数える) */
  objectsReceived: number;
  /** 復号した音声 Chunk の数。objectsReceived との差が復号せずに捨てた数になる */
  chunksDecoded: number;
  /** 音声のデコーダを構成できたか */
  decoderConfigured: boolean;
  /** 受信した音声を音声出力デバイスで再生するか */
  playbackEnabled: boolean;
  /** 復号した音声のレベル (dBFS)。まだ復号していないときは null */
  peakDbfs: number | null;
  rmsDbfs: number | null;
  /** 直近に受信した Object の LOC Audio Level (-dBov) と voice activity */
  lastLevel: number | null;
  lastVoiceActivity: boolean | null;
  /** 鳴らす時刻を過ぎて届いたなどで基準を取り直した回数 */
  playoutRebases: number;
  /** 遅れが上限を超えて捨てた音の数 */
  playoutDrops: number;
}

/** Subscriber の統計 */
export interface SubscriberStats {
  id: string;
  status: StatusType;
  /** 画面に出す状態の説明 */
  statusMessage: string;
  /** 確立した WebTransport が HTTP/2 か HTTP/3 か。未接続、または判別できないときは null */
  httpVersion: PanelHttpVersion | null;
  codec: string;
  /** Track Properties に DYNAMIC_GROUPS=1 が含まれているかどうか */
  dynamicGroupsSupported: boolean;
  /** NEW_GROUP_REQUEST を初回接続時に要求するかどうか */
  newGroupRequestEnabled: boolean;
  framesDecoded: number;
  keyFramesDecoded: number;
  objectsReceived: number;
  currentGroup: number;
  currentSubGroup: number;
  bytesReceived: number;
  objectsWithExtensions: number;
  /** 受信した Object から作った EncodedVideoChunk の数 */
  chunksCreated: number;
  /** デコーダへ渡した Chunk の数 */
  chunksDecoded: number;
  /** デコーダを構成できず復号しなかった Chunk の数 */
  chunksSkipped: number;
  /** Group の順序と欠落で復号せずに捨てた映像フレーム数 (古い Group、重複、遅着) */
  staleFramesDropped: number;
  /** 参照するフレームが欠けてキーフレームを待つ間のフレーム数 */
  missingReferenceFramesDropped: number;
  /** 映像と音声のデコーダのエラー数 */
  decodeErrors: number;
  decoderState: string;
  decoderConfigured: boolean;
  /**
   * 受信から表示までの時間の統計 (utils/playbackTimingStats.ts)。分布は直近 10 秒、
   * 止まりと表示キューのあふれは購読開始からの累積。latencyMs は送信側の壁時計の
   * LOC TIMESTAMP を基準にするため、別のマシンでは時計のずれを含む
   */
  playbackTiming: PlaybackTimingSnapshot;
  /**
   * 音声と映像の同期の推定値 (同期ずれ・表示の遅れ・目標遅延・切り下げた分・時計の代用)。
   * 未購読、jitter buffer が無効、音声だけの購読では既定値
   */
  avSync: AvSyncSnapshot;
  audio: SubscriberAudioStats;
  /** 最大の Location */
  largestLocation: { group: string; object: string } | null;
  /** 制御ストリームとデータストリームの統計。未接続のときは null */
  sessionStatistics: SessionStatistics | null;
  /** 受信した Catalog。まだ受信していないときは null */
  catalog: Catalog | null;
}

/** Publisher の統計を現在の signal から組み立てる */
export function buildPublisherStats(): PublisherStats {
  const session = pubSession.value;
  const audioLevel = audioMeterLevel.value;
  return {
    status: pubStatus.value,
    statusMessage: pubStatusMessage.value,
    serverUrl: url.value,
    httpVersion: httpVersion.value,
    forwardState: forwardState.value,
    codec: pubCodec.value,
    encoderState: encoderState.value,
    framesEncoded: framesEncoded.value,
    keyFramesEncoded: keyFramesEncoded.value,
    chunksEncoded: chunksEncoded.value,
    encodeErrors: encodeErrors.value,
    objectsSent: objectsSent.value,
    objectsWithExtensions: pubObjectsWithExtensions.value,
    bytesSent: bytesSent.value,
    currentGroup: pubCurrentGroup.value,
    newGroupRequests: newGroupRequestsReceived.value,
    // 分布は直近 10 秒のため、呼び出した時点の値を取る
    publishTiming: publishTimingStats.value.snapshot(performance.now()),
    audio: {
      publishing: audioPublisher.value !== null,
      meterPeakDbfs: audioMeterPeakDbfs.value,
      meterRmsDbfs: audioMeterRmsDbfs.value,
      lastSentLevel: audioLevel?.level ?? null,
      lastSentVoiceActivity: audioLevel?.voiceActivity ?? null,
    },
    sessionStatistics: session === null ? null : session.getStatistics(),
    catalog: catalog.value,
  };
}

/**
 * bigint を文字列に変換する
 *
 * `JSON.stringify` は bigint で例外になるため、テスト用 API とコピー用のテキストへ
 * 出す前に文字列にする。
 */
function convertLargestLocation(
  location: { group: bigint; object: bigint } | null,
): { group: string; object: string } | null {
  if (location === null) {
    return null;
  }
  return {
    group: location.group.toString(),
    object: location.object.toString(),
  };
}

/** Subscriber インスタンスの統計をスナップショットへ変換する */
export function buildSubscriberStats(sub: SubscriberInstance): SubscriberStats {
  const session = sub.session.value;
  const audioLevel = sub.audioLastLevel.value;
  return {
    id: sub.id,
    status: sub.status.value,
    statusMessage: sub.statusMessage.value,
    httpVersion: sub.httpVersion.value,
    codec: sub.codec.value,
    dynamicGroupsSupported: sub.dynamicGroupsSupported.value,
    newGroupRequestEnabled: sub.newGroupRequestEnabled.value,
    framesDecoded: sub.framesDecoded.value,
    keyFramesDecoded: sub.keyFramesDecoded.value,
    objectsReceived: sub.objectsReceived.value,
    currentGroup: sub.currentGroup.value,
    currentSubGroup: sub.currentSubGroup.value,
    bytesReceived: sub.bytesReceived.value,
    objectsWithExtensions: sub.objectsWithExtensions.value,
    chunksCreated: sub.chunksCreated.value,
    chunksDecoded: sub.chunksDecoded.value,
    chunksSkipped: sub.chunksSkipped.value,
    staleFramesDropped: sub.staleFramesDropped.value,
    missingReferenceFramesDropped: sub.missingReferenceFramesDropped.value,
    decodeErrors: sub.decodeErrors.value,
    decoderState: sub.decoderState.value,
    decoderConfigured: sub.decoderConfigured.value,
    playbackTiming: sub.playbackTiming.value,
    avSync: sub.avSync.value,
    // level 0 (最大音量) と voiceActivity false (無音) は値があるため null に潰さない
    audio: {
      objectsReceived: sub.audioObjectsReceived.value,
      chunksDecoded: sub.audioChunksDecoded.value,
      decoderConfigured: sub.audioDecoderConfigured.value,
      playbackEnabled: sub.audioPlaybackEnabled.value,
      peakDbfs: sub.audioPeakDbfs.value,
      rmsDbfs: sub.audioRmsDbfs.value,
      lastLevel: audioLevel?.level ?? null,
      lastVoiceActivity: audioLevel?.voiceActivity ?? null,
      playoutRebases: sub.audioPlayoutRebases.value,
      playoutDrops: sub.audioPlayoutDrops.value,
    },
    largestLocation: convertLargestLocation(sub.largestLocation.value),
    sessionStatistics: session === null ? null : session.getStatistics(),
    catalog: sub.catalog.value,
  };
}
