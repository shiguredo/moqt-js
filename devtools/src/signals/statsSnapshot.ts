import type { SessionStatistics } from "moqt-js";
import type { PanelHttpVersion } from "../utils/httpVersion";
import type { PlayoutTimingSnapshot } from "../utils/playoutTimingStats";
import type { PublishTimingSnapshot } from "../utils/publishTimingStats";
import type { AudioPlayoutTimingSnapshot } from "../../../src/playout/audioPlayoutTimingStats.ts";
import type { AudioTimestampOffsetStats } from "../../../src/audioTimestampClock.ts";
import type { AudioPublishCatchUpStats } from "../../../src/audioPublishCatchUp.ts";
import type { AudioReceiveCatchUpStats } from "../../../src/playout/audioReceiveCatchUp.ts";
import type { AudioDelayFeedbackSnapshot } from "../../../src/playout/audioDelayFeedback.ts";
import type { HostDelaySnapshot } from "../utils/hostDelayTracker.ts";
import type { PreconditionWarning } from "../utils/preconditionWarnings.ts";
import type { StatusType } from "../types";
import {
  audioBytesSent,
  audioChunksEncoded,
  audioDatagramObjectsSent,
  audioEncodeErrors,
  audioMeterLevel,
  audioMeterPeakDbfsLeft,
  audioMeterPeakDbfsRight,
  audioMeterRmsDbfsLeft,
  audioMeterRmsDbfsRight,
  audioObjectsSent,
  audioCatchUp,
  audioPublisher,
  audioTimestampClock,
  bytesSent,
  catalog,
  chunksEncoded,
  encodeErrors,
  encoderState,
  eventMessagesSent,
  eventPublisher,
  forwardState,
  framesEncoded,
  httpVersion,
  keyFramesEncoded,
  newGroupRequestsReceived,
  objectsSent,
  objectsWithExtensions as pubObjectsWithExtensions,
  preconditionWarnings,
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
 * JSON へ直列化できる値
 *
 * スナップショットは `window.moqtDevTools` から JSON として取り出せる必要がある。
 * bigint は `JSON.stringify` で例外になるため、文字列にしてから持つ。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSON へ直列化できる値へ変換する
 *
 * Catalog の Media Timeline Template は `[bigint, bigint]` を含む。`largestLocation` と
 * 同じく、取り出す側が JSON にできるよう bigint は文字列にする。JSON に無い値
 * (undefined / 関数 / シンボル) は落とす。
 */
function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) {
        continue;
      }
      result[key] = toJsonValue(child);
    }
    return result;
  }
  return null;
}

/**
 * Publisher の音声の状態
 *
 * 音声トラックは映像とは別の `session.publish` を持つため (`signals/publisher.ts` の
 * `audioPublisher`)、映像の統計とは分けて持つ。
 */
export interface PublisherAudioStats {
  /** 音声トラックの PUBLISH が確立しているか */
  publishing: boolean;
  /** 符号化した音声 Chunk の数と、符号化のエラー数 */
  chunksEncoded: number;
  encodeErrors: number;
  /** 送った音声 Object の数とバイト数。datagramObjectsSent は objectsSent の内数 */
  objectsSent: number;
  datagramObjectsSent: number;
  bytesSent: number;
  /** 配信側の音声メーターの peak / RMS (dBFS)。まだ測っていないときは null */
  meterPeakDbfs: number | null;
  meterRmsDbfs: number | null;
  /** 第 2 チャンネル (右) の peak / RMS。モノラルでは null */
  meterPeakDbfsRight: number | null;
  meterRmsDbfsRight: number | null;
  /** 直近に送った Object の LOC Audio Level (-dBov) と voice activity */
  lastSentLevel: number | null;
  lastSentVoiceActivity: boolean | null;
  /**
   * 音声の TIMESTAMP を壁時計へ合わせるための観測
   *
   * 「読み出した壁時計 - `AudioData.timestamp`」の現在値・最小・最大と 10 秒 / 60 秒の傾き。
   * 一定なら傾きが 0、ドリフトなら傾きが 0 から離れ、段差なら最小と最大の差が開く
   */
  timestampOffset: AudioTimestampOffsetStats | null;
  /**
   * 遅れが上限を超えたときに古いフレームを捨てて live へ追いついた量
   *
   * 捨てた数と長さ、観測した遅れと健全時の遅れ (床)、追いつきの最中かどうかを出す。
   * 方針は "drop" (既定) か "keep" (間引きしたくない用途)
   */
  catchUp: AudioPublishCatchUpStats;
}

/** Publisher の event timeline の状態 */
export interface PublisherEventStats {
  /** event timeline トラックの PUBLISH が確立しているか */
  publishing: boolean;
  /** event timeline に送ったメッセージの数 */
  messagesSent: number;
}

/** Publisher の統計 */
export interface PublisherStats {
  status: StatusType;
  /** 画面に出す状態の説明 */
  statusMessage: string;
  serverUrl: string;
  /** 確立した WebTransport が HTTP/2 か HTTP/3 か。未接続、または判別できないときは null */
  httpVersion: PanelHttpVersion | null;
  /** 購読が paused かどうか。未確立のときは null (draft-ietf-moq-transport-22 §3.1.1) */
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
  /** event timeline (audio / video 以外のデータ) の状態 */
  event: PublisherEventStats;
  /**
   * A/V 同期と再生の判断が前提から外れている状態 (外れていなければ空)
   *
   * 判定は `utils/preconditionWarnings.ts` が既にある計器の値から行う。どうなったら
   * 何を見直すかは docs/AV_SYNC_DECISIONS.md が持つ
   */
  warnings: readonly PreconditionWarning[];
  /** 制御ストリームとデータストリームの統計。未接続のときは null */
  sessionStatistics: SessionStatistics | null;
  /** 送信している Catalog (bigint は文字列)。まだ送っていないときは null */
  catalog: JsonValue | null;
}

/** Subscriber の音声の統計 */
export interface SubscriberAudioStats {
  /** 受信した音声 Object の数 (復号に渡す前のものも数える。重複は含まない) */
  objectsReceived: number;
  /**
   * 受信した音声 Object のうち datagram で届いた数
   *
   * draft-ietf-moq-transport-22 §2.1 は同じ Track での Subgroup と Datagram の併用を許す。
   * objectsReceived との差が Subgroup (stream) で届いた数になり、publisher が datagram を
   * 選べたかどうかを確かめられる
   */
  datagramObjectsReceived: number;
  /** 復号した音声 Chunk の数。objectsReceived との差が復号せずに捨てた数になる */
  chunksDecoded: number;
  /**
   * 直近に受信した音声 Object の到着の遅れ (ミリ秒)。受信した壁時計 - LOC TIMESTAMP
   *
   * 配信側が足した遅れ (`PublisherAudioStats.catchUp.sendLagMs`) と対で読む。どちらも
   * 小さければ遅れは受信側の復号と再生にあり、この値だけが大きければ relay と経路にある。
   * 壁時計の TIMESTAMP を持たない Object だけのときは null
   */
  receiveDelayMs: number | null;
  /** 受信した音声 Object の到着の遅れの最大 (ミリ秒)。まだ観測していなければ null */
  maxReceiveDelayMs: number | null;
  /**
   * relay の cache から追いつく途中で、復号したが鳴らさなかった音声 Object の数
   *
   * SUBSCRIBE_OK の LARGEST_OBJECT 以前の位置の Object であり、購読を始めるたびに増える。
   * 再生が有効なときだけ数える
   */
  catchUpObjectsSkipped: number;
  /**
   * datagram の冗長化などで同じ Object を 2 回以上受け取り、復号へ渡さず捨てた数
   *
   * 配信側が同じ Object を複数回送っているか (冗長度が経路上で効いているか) を確かめる。
   * `objectsReceived` は重複を除いた受信 Object 数であり、冗長化の copy はここには含めない
   */
  duplicateObjectsDropped: number;
  /**
   * 受信した音声 Object の Location が、同じ購読で受信済みの最大 Location より
   * 小さかった数
   *
   * Group が異なる Object の順序は保証されない (draft-ietf-moq-transport-22 §2.3.1)。
   * 音声は 1 Object = 1 Group なので、datagram でも subgroup でも順序逆転が起き得る。
   * 実際に起きているかを直接測る。relay の cache から replay された Object
   * (SUBSCRIBE_OK の LARGEST_OBJECT 以下) は順序逆転ではないため数えない。同じ Object の
   * 冗長化 copy も 1 回だけ数える
   */
  outOfOrderObjectsReceived: number;
  /**
   * 順序逆転した Object が、受信済みの最大 Group から何 Group 戻っていたかの最大値
   *
   * 音声は 1 Object = 1 Group なので、Group ID の差がそのまま戻り幅の目安になる。
   * moqt-js の Opus では 1 Object = 20 ms、AAC では約 21.3 ms である。
   * Group ID の差が Number.MAX_SAFE_INTEGER を超える場合はその値で頭打ちにする
   */
  maxOutOfOrderGroupDistance: number;
  /** 音声のデコーダを構成できたか */
  decoderConfigured: boolean;
  /** 受信した音声を音声出力デバイスで再生するか */
  playbackEnabled: boolean;
  /** 復号した音声のレベル (dBFS)。まだ復号していないときは null */
  peakDbfs: number | null;
  rmsDbfs: number | null;
  /** 第 2 チャンネル (右) のレベル。モノラルでは null */
  peakDbfsRight: number | null;
  rmsDbfsRight: number | null;
  /** 直近に受信した Object の LOC Audio Level (-dBov) と voice activity */
  lastLevel: number | null;
  lastVoiceActivity: boolean | null;
  /** 鳴らす時刻を過ぎて届いたなどで基準を取り直した回数 */
  playoutRebases: number;
  /** 遅れが上限を超えて捨てた音の数 */
  playoutDrops: number;
  /**
   * 目標へ戻すために詰めた (時間圧縮した) 音の合計 (ミリ秒)
   *
   * 詰める操作は波形の周期を 1 つ削って繋ぐ (NetEq の accelerate と同じ)。続けて起きると
   * 音が粗くなるため、量を読めるようにする
   */
  playoutCompressedMs: number;
  /** 欠落した区間を、直前の音の末尾を繰り返して補間した合計 (ミリ秒) */
  playoutConcealedMs: number;
  /** 補間した回数 */
  playoutConcealments: number;
  /**
   * 時間圧縮 (粗さ) や無音の穴が続いたときに広げる、目標遅延の実際の上限 (ミリ秒)
   *
   * 明示設定 (`targetLatency`) で決まる上限とは別に、閉ループが圧縮の継続を見て
   * 100 ms から 160 ms へ広げる (`src/playout/audioDelayFeedback.ts` の
   * `appliedCeilingMs`)。値は A/V 同期の snapshot (`avSync.delays.audioDelayFeedback`)
   * から写す
   */
  appliedCeilingMs: number;
  /**
   * 直近 1 秒に時間圧縮で詰めた音の長さ (ミリ秒/秒)
   *
   * 0 より大きい間は声が粗くなる操作が続いている。`playoutCompressedMs` の増分を
   * 1 秒あたりに直した値であり、`audioDelayFeedback` から写す
   */
  compressionMsPerSecond: number;
  /**
   * 音声の目標遅延の閉ループの内訳 (src/playout/audioDelayFeedback.ts)
   *
   * 目標・実際に使う値・明示上限・広げた上限・圧縮の速さを持つ。音声だけを購読するときは
   * `avSync` を作らないため、目標遅延の内訳はここから読む
   */
  audioDelayFeedback: AudioDelayFeedbackSnapshot;
  /**
   * 音声の再生の観測値 (src/playout/audioPlayoutTimingStats.ts)。鳴るはずの時刻 (再生予定時刻)・
   * 届いた時刻・鳴り始める時刻と、予定に対する余裕の分布 (直近 10 秒)、鳴らなかった量
   * (件数と ms) を理由ごとに持つ
   */
  playoutTiming: AudioPlayoutTimingSnapshot;
  /**
   * 受信側の音声の追いつきの観測値 (src/playout/audioReceiveCatchUp.ts)
   *
   * 復号の出力が送られた TIMESTAMP から遅れ続けたときに、復号器を作り直して live へ戻した
   * 量。観測した遅れと健全時の遅れ (床)、遅れの上限、追いつきの最中かどうか、作り直した
   * 回数、飛んだ音の数と長さ (timestamp の跳びから求めた推定) を持つ。判定に使うのは
   * 復号が足している遅れ (decodeLagMs) であり、lagMs は入力の遅れを含む生の値である。
   * 復号器の作り直しは、追いつきを始めたときに購読側が行う
   */
  playoutCatchUp: AudioReceiveCatchUpStats;
  /**
   * メインスレッドの停止 (longtask) と音声の到着の重なりの観測値
   * (devtools/src/utils/hostDelayTracker.ts)
   *
   * 直近の窓の停止の回数と合計 ms、停止区間と到着の間隔が重なった到着の数を持つ。
   * 停止の報告は止まった後に届くため、到着の観測時に停止中だったかを 1 件ずつ記録するの
   * ではなく、記録した停止区間と到着の間隔を統計を出すときに突き合わせる
   */
  hostDelay: HostDelaySnapshot;
}

/** Subscriber の Messages (event timeline) の統計 */
export interface SubscriberEventStats {
  /**
   * 受信した event timeline の Object の数
   *
   * Group の先頭 Object にその時点の履歴が載るため、表示している履歴の件数とは別
   */
  objectsReceived: number;
  /** 表示している履歴の件数 */
  entries: number;
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
  /**
   * relay の cache から追いつく途中で、復号したが描かなかったフレーム数
   *
   * SUBSCRIBE_OK の LARGEST_OBJECT 以前の位置のフレームであり、購読を始めるたびに増える
   */
  catchUpFramesSkipped: number;
  /** relay の cache から追いつく途中かどうか (映像と音声の両方が境界を越えるまで true) */
  catchUpPending: boolean;
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
   * 受信から表示までの時間の統計 (utils/playoutTimingStats.ts)。分布は直近 10 秒、
   * 止まりと表示キューのあふれは購読開始からの累積。latencyMs は送信側の壁時計の
   * LOC TIMESTAMP を基準にするため、別のマシンでは時計のずれを含む
   */
  playoutTiming: PlayoutTimingSnapshot;
  /**
   * 音声と映像の同期の推定値 (同期ずれ・表示の遅れ・目標遅延・切り下げた分・時計の代用)。
   * 未購読、jitter buffer が無効、音声だけの購読では既定値
   */
  avSync: AvSyncSnapshot;
  /**
   * A/V 同期と再生の判断が前提から外れている状態 (外れていなければ空)
   *
   * 判定は `utils/preconditionWarnings.ts` が既にある計器の値から行う。どうなったら
   * 何を見直すかは docs/AV_SYNC_DECISIONS.md が持つ
   */
  warnings: readonly PreconditionWarning[];
  audio: SubscriberAudioStats;
  event: SubscriberEventStats;
  /**
   * 受信した event timeline の entry (audio / video 以外のデータ)
   *
   * data の構造は catalog の eventType が定義する (draft-ietf-moq-msf-01 §5.2.5)。
   * bigint は文字列にして、JSON として取り出せる形で持つ
   */
  eventMessages: JsonValue;
  /** 最大の Location */
  largestLocation: { group: string; object: string } | null;
  /** 制御ストリームとデータストリームの統計。未接続のときは null */
  sessionStatistics: SessionStatistics | null;
  /** 受信した Catalog (bigint は文字列)。まだ受信していないときは null */
  catalog: JsonValue | null;
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
      chunksEncoded: audioChunksEncoded.value,
      encodeErrors: audioEncodeErrors.value,
      objectsSent: audioObjectsSent.value,
      datagramObjectsSent: audioDatagramObjectsSent.value,
      bytesSent: audioBytesSent.value,
      meterPeakDbfs: audioMeterPeakDbfsLeft.value,
      meterRmsDbfs: audioMeterRmsDbfsLeft.value,
      meterPeakDbfsRight: audioMeterPeakDbfsRight.value,
      meterRmsDbfsRight: audioMeterRmsDbfsRight.value,
      lastSentLevel: audioLevel?.level ?? null,
      lastSentVoiceActivity: audioLevel?.voiceActivity ?? null,
      timestampOffset: audioTimestampClock.value.snapshot(),
      // 遅れが上限を超えたときに捨てて live へ追いついた量 (src/audioPublishCatchUp.ts)
      catchUp: audioCatchUp.value.snapshot(),
    },
    event: {
      publishing: eventPublisher.value !== null,
      messagesSent: eventMessagesSent.value,
    },
    // 前提から外れた状態 (signals/preconditionWatch.ts が 1 秒ごとに更新する)
    warnings: preconditionWarnings.value,
    sessionStatistics: session === null ? null : session.getStatistics(),
    catalog: catalog.value === null ? null : toJsonValue(catalog.value),
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
  // 目標遅延の閉ループの観測値は A/V 同期の snapshot が持つ。音声の表示へ写して、
  // 圧縮が続いているか (上限を広げているか) を音声の節だけで読めるようにする
  const audioDelayFeedback = sub.audioDelayFeedback.value;
  return {
    id: sub.id,
    status: sub.status.value,
    statusMessage: sub.statusMessage.value,
    httpVersion: sub.httpVersion.value,
    codec: sub.codec.value,
    dynamicGroupsSupported: sub.dynamicGroupsSupported.value,
    newGroupRequestEnabled: sub.newGroupRequestEnabled.value,
    framesDecoded: sub.framesDecoded.value,
    catchUpFramesSkipped: sub.catchUpFramesSkipped.value,
    catchUpPending: sub.catchUpPending.value,
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
    playoutTiming: sub.playoutTiming.value,
    avSync: sub.avSync.value,
    // 前提から外れた状態 (signals/preconditionWatch.ts が 1 秒ごとに更新する)
    warnings: sub.preconditionWarnings.value,
    // level 0 (最大音量) と voiceActivity false (無音) は値があるため null に潰さない
    audio: {
      objectsReceived: sub.audioObjectsReceived.value,
      datagramObjectsReceived: sub.audioDatagramObjectsReceived.value,
      chunksDecoded: sub.audioChunksDecoded.value,
      receiveDelayMs: sub.audioReceiveDelayMs.value,
      maxReceiveDelayMs: sub.audioMaxReceiveDelayMs.value,
      catchUpObjectsSkipped: sub.audioCatchUpObjectsSkipped.value,
      duplicateObjectsDropped: sub.duplicateObjectsDropped.value,
      outOfOrderObjectsReceived: sub.outOfOrderObjectsReceived.value,
      maxOutOfOrderGroupDistance: sub.maxOutOfOrderGroupDistance.value,
      decoderConfigured: sub.audioDecoderConfigured.value,
      playbackEnabled: sub.audioPlaybackEnabled.value,
      peakDbfs: sub.audioPeakDbfsLeft.value,
      rmsDbfs: sub.audioRmsDbfsLeft.value,
      peakDbfsRight: sub.audioPeakDbfsRight.value,
      rmsDbfsRight: sub.audioRmsDbfsRight.value,
      lastLevel: audioLevel?.level ?? null,
      lastVoiceActivity: audioLevel?.voiceActivity ?? null,
      playoutRebases: sub.audioPlayoutRebases.value,
      playoutDrops: sub.audioPlayoutDrops.value,
      playoutCompressedMs: sub.audioPlayoutCompressedMs.value,
      playoutConcealedMs: sub.audioPlayoutConcealedMs.value,
      playoutConcealments: sub.audioPlayoutConcealments.value,
      // 閉ループが広げた目標遅延の上限と、直近 1 秒に詰めた長さ
      // (audioDelayFeedback の snapshot から写す。音声だけの購読でも読める)
      appliedCeilingMs: audioDelayFeedback.appliedCeilingMs,
      compressionMsPerSecond: audioDelayFeedback.compressionMsPerSecond,
      // 目標遅延の閉ループの内訳 (目標・実際に使う値・明示上限・広げた上限・圧縮の速さ)
      audioDelayFeedback,
      playoutTiming: sub.audioPlayoutTiming.value,
      playoutCatchUp: sub.audioPlayoutCatchUp.value,
      // メインスレッドの停止と音声の到着の重なり (devtools/src/utils/hostDelayTracker.ts)
      hostDelay: sub.audioHostDelay.value,
    },
    event: {
      objectsReceived: sub.eventObjectsReceived.value,
      entries: sub.eventMessages.value.length,
    },
    eventMessages: toJsonValue(sub.eventMessages.value),
    largestLocation: convertLargestLocation(sub.largestLocation.value),
    sessionStatistics: session === null ? null : session.getStatistics(),
    catalog: sub.catalog.value === null ? null : toJsonValue(sub.catalog.value),
  };
}
