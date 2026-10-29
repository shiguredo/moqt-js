import {
  catalogFetchFilter,
  connect,
  LOC,
  decodeCatalogMessage,
  decodeEventTimeline,
  getAudioTracks,
  getVideoTracks,
  resolveInitData,
  CATALOG_TRACK_NAME,
  supportsDynamicGroups,
  type Catalog,
  type MoqtObject,
  type DebugMessage,
  type CatalogTrack,
  type Session,
  type Subscriber,
  type Property,
  type Location,
  type AuthorizationToken,
  type PublishDoneInfo,
  isPublishDoneErrorStatus,
  // 音声と映像の再生の経路はライブラリの共通の入口を使う (組み立てを 2 か所へ置かない)
  VideoDecodeOrder,
  priorObjectIdGapOf,
  GroupSwitchGate,
  CatchUpGate,
  createMediaPlayout,
  type MediaPlayout,
  type MediaPlayoutAudioDecodeInput,
  type MediaPlayoutAudioStats,
  type MediaPlayoutVideoDecodeInput,
  // 復号へ渡した TIMESTAMP の種類 (音声と映像で共通)
  type PlayoutTimestampKind,
  // 音声の再生の観測 (計器) は、購読ごとに signal へ反映する 1 つのインスタンスを使うため
  // devtools が持つ。組み立て (時間軸への記録・目標の決定・予約) は再生の入口
  // (MediaPlayout) が行い、この計器を渡す
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AudioPlayoutTimingStats,
  EMPTY_AUDIO_PLAYOUT_TIMING,
  // 受信側の追いつきの観測値は、再生の入口の統計から読む。まだ観測が無いときの既定値だけを
  // ここでも使う
  EMPTY_AUDIO_RECEIVE_CATCH_UP,
  // 音声の再生予算の内訳を signal に持つための型
  type AudioPlayoutDelayStats,
} from "moqt-js";
import { addLog } from "../signals/debugLog";
import { type CandidateSelection } from "../utils/candidateSelection.ts";
import type { TrackEndState } from "../types";
import { logDebugMessage } from "./debugMessageLog";
import { DecoderWrapper } from "../utils/DecoderWrapper";
import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder.ts";
import {
  isVideoKeyFrameObject,
  resolveNewGroupRequestValue,
  resolvePublishDoneError,
} from "../../../src/createMediaSubscriber.ts";
import {
  DEFAULT_AUDIO_SAMPLE_RATE,
  requiresAudioSpecificConfig,
  resolveAudioChannelCount,
  resolveAudioContextSampleRate,
} from "../../../src/codec/config.ts";
import { isSameCodecDescription, parseAudioCodec } from "../utils/codec";
import {
  appendWaveform,
  readAudioSamples,
  summarizeAudioLevel,
  waveformSampleCount,
} from "../utils/audioLevel";
import {
  subtractAudioPlayoutCumulative,
  type AudioPlayoutCumulative,
} from "../utils/audioPlayoutCumulative";
import { base64ToArrayBuffer } from "../utils/base64";
import {
  EMPTY_PLAYOUT_TIMING,
  PLAYOUT_TIMING_WINDOW_MS,
  PlayoutTimingStats,
  formatPublishDoneStatusCode,
  formatStreamResetCode,
} from "../utils/playoutTimingStats";
import { detectAvSyncTransition, type AvSyncState } from "../utils/avSyncTransition.ts";
import { EMPTY_HOST_DELAY, HostDelayTracker } from "../utils/hostDelayTracker.ts";
import {
  SubscriberPreDecodeDelay,
  type SubscriberPreDecodeDelayOverflow,
} from "./subscriberPreDecodeDelay.ts";
// targetLatency の解決規則はライブラリと共有する純関数が持つ (規則を 2 か所に書かない)
import { effectiveTargetLatencyMs, resolveSharedTargetLatencyMs } from "../../../src/msf/tracks.ts";
import { browserIsChromium, resolvePanelHttpVersion } from "../utils/httpVersion";
import { formatFullTrackName } from "../../../src/fullTrackName.ts";
import {
  AUDIO_RECEIVE_ORDER_WINDOW,
  AudioReceiveOrderTracker,
} from "../utils/audioReceiveOrder.ts";
import { subscribeAuthorizationTokenOptions } from "../utils/trackAuthorization";
import * as settings from "../signals/connectionSettings";
import * as sub from "../signals/subscriber";
import * as pub from "../signals/publisher";
import { useRef, useEffect } from "preact/hooks";
import {
  createAudioPlaybackController,
  type AudioPlaybackController,
} from "./audioPlaybackController.ts";
import { playoutToKeepAfterStop } from "./audioPlaybackLifecycle.ts";
import {
  SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE,
  SubscriberAudioStop,
} from "./subscriberAudioStop.ts";
import { useSignalEffect } from "@preact/signals";
import type { RefObject } from "preact";

/**
 * Catalog から購読する音声トラックを取り出す
 *
 * 音声トラックを持たない catalog (映像だけを広告する publisher) では `undefined` を
 * 返す。呼び出し側はこれを見て音声の購読を開始せず、映像だけを継続する。
 * ブラウザ API に依存しないため、この分岐はここで検証できる。
 */
export function resolveAudioTrack(catalog: Catalog): CatalogTrack | undefined {
  return getAudioTracks(catalog)[0];
}

/**
 * Catalog から購読する映像トラックと音声トラック
 *
 * どちらか一方は必ずある。映像が無いときは音声だけを購読する
 */
export type CatalogMediaTracks =
  | { video: CatalogTrack; audio: CatalogTrack | undefined }
  | { video: undefined; audio: CatalogTrack };

/**
 * Catalog から購読する映像トラックと音声トラックを取り出す
 *
 * draft-ietf-moq-msf-01 の catalog は映像トラックを必須としないため、音声だけを広告する
 * publisher も購読できるようにする。どちらのトラックも無い catalog は購読できないため
 * throw する。ブラウザ API に依存しないため、この分岐はここで検証できる。
 */
export function resolveCatalogMediaTracks(catalog: Catalog): CatalogMediaTracks {
  const video = getVideoTracks(catalog)[0];
  const audio = resolveAudioTrack(catalog);
  if (video !== undefined) {
    return { video, audio };
  }
  if (audio !== undefined) {
    return { video, audio };
  }
  throw new Error(
    `no video or audio track in catalog: tracks=${JSON.stringify(catalog.tracks.map((track) => track.name))}`,
  );
}

/**
 * Catalog から購読する event timeline トラックを取り出す
 *
 * devtools は audio / video 以外のデータを流す例として event timeline を購読する。
 * packaging が "eventtimeline" の最初のトラックだけを対象にする (draft-ietf-moq-msf-01
 * §5.2.4)。event timeline を広告しない publisher では undefined を返し、購読しない。
 * ブラウザ API に依存しないため、この分岐はここで検証できる
 */
export function resolveEventTimelineTrack(catalog: Catalog): CatalogTrack | undefined {
  return catalog.tracks.find((track) => track.packaging === "eventtimeline");
}

/** 追いつき中の判定に使う、映像と音声の境界 */
interface CatchUpGates {
  video: CatchUpGate;
  audio: CatchUpGate;
}

/** 購読するトラックのエラーを受けるコールバック */
interface TrackErrorCallbacks {
  error: (error: Error) => void;
}

/**
 * トラックの終了通知から、表示するトラックの終了状態を決める
 *
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE) / §12.4 (Publish Done Codes): 終了の理由は
 * Status Code が表す。エラーを示す Status Code はエラーとして残す。
 */
export function resolveTrackEndState(publishDone: PublishDoneInfo): TrackEndState {
  return {
    isError: isPublishDoneErrorStatus(publishDone.statusCode),
    statusLabel: formatPublishDoneStatusCode(publishDone.statusCode),
    reasonPhrase: publishDone.reasonPhrase,
  };
}

/**
 * トラックの終了を購読の状態へ反映する
 *
 * 終わったトラックだけを「終了」にし、他のトラックの状態は変えない (理由は handleTrackEnd)。
 */
export function applyTrackEnd(
  instance: sub.SubscriberInstance,
  track: "video" | "audio",
  publishDone: PublishDoneInfo,
): void {
  const state = resolveTrackEndState(publishDone);
  if (track === "video") {
    instance.videoTrackEnd.value = state;
    return;
  }
  instance.audioTrackEnd.value = state;
}

/** 終了の動詞 (エラーを示す Status Code なら理由が誤りであることも示す) */
function trackEndVerb(state: TrackEndState): string {
  return state.isError ? "ended with error" : "ended";
}

/** 終了状態を「Status Code の名前と値: Reason Phrase」の 1 行にする */
function formatTrackEndReason(state: TrackEndState): string {
  return state.reasonPhrase === ""
    ? state.statusLabel
    : `${state.statusLabel}: ${state.reasonPhrase}`;
}

/**
 * 終了したトラックを「どのトラックが何の理由で終わったか」の 1 行にする
 *
 * トラックが 1 本終わると、パネルは「購読中だが何も届かない」状態になる。どのトラックが何の
 * 理由で終わったかを必ず表示する。映像と音声の両方が終わった場合は両方出す。
 */
export function formatTrackEndText(
  audio: TrackEndState | null,
  video: TrackEndState | null,
): string {
  // 音声と映像を並べるときは audio → video の順にする (CODEBASE.md の表示規約)
  const parts: string[] = [];
  if (audio !== null) {
    parts.push(`audio ${trackEndVerb(audio)}: ${formatTrackEndReason(audio)}`);
  }
  if (video !== null) {
    parts.push(`video ${trackEndVerb(video)}: ${formatTrackEndReason(video)}`);
  }
  return parts.join(", ");
}

/**
 * 購読が確立したときの Status の文言
 *
 * 既に終わったトラックがあれば、その状態を文言そのものにする。購読の確立とトラックの終了は
 * 前後し得るため、確立時の文言で終了の表示を消さない。パネルは 1 行で省略するため、終わった
 * トラックの状態を先頭に出す (「Subscribed」を前置しない)。
 */
export function subscribedStatusMessage(instance: sub.SubscriberInstance): string {
  const text = formatTrackEndText(instance.audioTrackEnd.value, instance.videoTrackEnd.value);
  return text === "" ? "Subscribed" : text;
}

/**
 * status / statusMessage を更新してよいか
 *
 * stopSubscribing 進行中 (isStopping) と、後始末を通った後 (session が null) の遅延
 * コールバックでは上書きしない。
 */
export function canApplyStatusUpdate(instance: sub.SubscriberInstance): boolean {
  return !instance.isStopping.value && instance.session.value !== null;
}

/** エラーを示す Status Code で終わったトラックがあるか */
function hasTrackEndError(instance: sub.SubscriberInstance): boolean {
  return (
    (instance.videoTrackEnd.value?.isError ?? false) ||
    (instance.audioTrackEnd.value?.isError ?? false)
  );
}

/**
 * 購読が確立したときの表示にする
 *
 * 既に終わったトラックがあれば、その理由を文言に残し、エラーを示す Status Code で終わった
 * トラックがあれば status も error のままにする (購読の確立とトラックの終了は前後し得る)。
 */
export function applySubscribedStatus(instance: sub.SubscriberInstance): void {
  instance.status.value = hasTrackEndError(instance) ? "error" : "connected";
  instance.statusMessage.value = subscribedStatusMessage(instance);
}

/**
 * 終了したトラックを Status の文言へ反映する
 *
 * 購読とセッションは維持されるため status は connected (エラー status のトラックがあれば
 * error) のままとする。トラックの終了で後始末しないため、パネルが何も届かない状態になる。
 */
export function refreshTrackEndStatus(instance: sub.SubscriberInstance): void {
  if (!canApplyStatusUpdate(instance)) {
    return;
  }
  applySubscribedStatus(instance);
}

/**
 * 画面の「Catching up」の表示を、映像と音声の境界と終了状態から決める
 *
 * 境界を越えていないトラックがあれば追いつき中とする。ただし、境界の無いトラック (購読の
 * 時点で Object が無い) と、PUBLISH_DONE で終わったトラックは完了として扱う。
 */
/** 同じ音声 Object を 2 回受け取ったときに、2 回目を捨てるために覚える数 (src と同じ) */
const AUDIO_RECENT_OBJECT_IDS_MAX = AUDIO_RECEIVE_ORDER_WINDOW;

export function applyCatchUpPending(instance: sub.SubscriberInstance, gates: CatchUpGates): void {
  // 終わったトラックは境界を越える Object が来ないため、完了していなくても追いつき中としない。
  // SUBSCRIBE_OK と PUBLISH_DONE が同じチャンクで届くと終了の後に境界が設定されるため、
  // 終了の時点で畳むだけでは足りない
  instance.catchUpPending.value =
    (!gates.video.catchUpCompleted && instance.videoTrackEnd.value === null) ||
    (!gates.audio.catchUpCompleted && instance.audioTrackEnd.value === null);
}

/**
 * 追いつきの判定を待たずにそのトラックを終えたものとして扱う
 *
 * 位置が分からない Object を再生したときと、トラックが PUBLISH_DONE で終わったときに使う。
 * どちらも境界を越える Object が来ないため、判定を待ち続けると「Catching up」が Stop まで残る。
 */
function foldCatchUpGate(
  instance: sub.SubscriberInstance,
  gate: CatchUpGate,
  gates: CatchUpGates,
): void {
  // 完了済みのトラックは表示に出さないため、何もしなくてよい
  if (gate.catchUpCompleted) {
    return;
  }
  gate.markPositionUnknown();
  applyCatchUpPending(instance, gates);
}

/**
 * トラックの終了 (PUBLISH_DONE) を購読へ反映する
 *
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE): publisher は購読の最後のメッセージとして
 * PUBLISH_DONE を送る。これはトラック単位の購読の終了であり、セッションの終了ではない。
 * セッションは明示的に閉じるまで維持し (§6.6 Termination の CONNECTION_CLOSE /
 * CLOSE_WEBTRANSPORT_SESSION)、他の購読への影響を考慮する ("Implementations need to consider
 * the impact on other outstanding subscriptions before making this choice.")。したがってここ
 * では後始末をしない。終わったトラックの状態と表示だけを変える。
 *
 * 停止した購読の終了は次の購読の signal に触らない (createAttemptGuard を参照)。
 *
 * @returns 今の購読の終了だったか (停止した購読の終了では何もせず false を返す)
 */
export function handleTrackEnd(
  instance: sub.SubscriberInstance,
  track: "video" | "audio",
  publishDone: PublishDoneInfo,
  gates: CatchUpGates,
  isCurrentAttempt: () => boolean,
): boolean {
  const message = track === "video" ? "video stream ended" : "audio stream ended";
  if (!isCurrentAttempt()) {
    // 停止した購読に遅れて届いた終了も、Debug パネルのイベントとしては残す (セッションの close を
    // stop 主導でも記録するのと同じ方針)。signal は次の購読のものなので触らない
    logPublishDoneEnd(instance.id, message, publishDone);
    return false;
  }
  applyTrackEnd(instance, track, publishDone);
  // 終わったトラックの追いつきの判定は待たない (待つと「Catching up」が Stop まで残る)
  foldCatchUpGate(instance, track === "video" ? gates.video : gates.audio, gates);
  refreshTrackEndStatus(instance);
  logPublishDoneEnd(instance.id, message, publishDone);
  return true;
}

/**
 * PUBLISH_DONE による購読の終了を Debug パネルへ記録する
 *
 * レベルはエラー status かどうかで決まる。停止した購読に遅れて届いた終了も残す (セッションの
 * close を stop 主導でも記録するのと同じ方針)。signal を触るかは呼び出し側が決める。
 *
 * テストから呼べるよう export する (パッケージ公開 API ではない)。
 */
export function logPublishDoneEnd(
  subscriberId: string,
  message: string,
  publishDone: PublishDoneInfo,
): void {
  // レベルは画面の表示と同じ判定から取る (判定源を増やさない)
  const state = resolveTrackEndState(publishDone);
  addLog(state.isError ? "error" : "info", `[${subscriberId}] ${message}`, {
    statusCode: state.statusLabel,
    reasonPhrase: state.reasonPhrase,
  });
}

/**
 * canvas の幅の上限 (px)
 *
 * 4K のような大きなフレームで canvas の実寸をそのまま使うと、1 枚あたりの描画
 * コストが大きくなり、60 / 120 fps の表示がかくつく。表示は CSS で拡縮されるため、
 * canvas はこの幅に抑えて描く。
 */
const MAX_CANVAS_WIDTH = 1280;

/**
 * jitter buffer が無効なときの表示待ちフレームのキューの上限 (枚)
 *
 * 到着と復号のゆらぎを吸収するために保持する。実回線では受信チャンクに複数の
 * Object がまとまって入り、復号もまとめて完了することがあるため、数枚では
 * あふれてフレームが落ちる。表示周期 (60 Hz で約 16 ms) より配信周期が長ければ
 * キューは自然に減るため、通常の遅延は小さいままである。上限を超えた分は古い方から
 * 捨てる (配信 fps が表示 fps を超える場合と cache replay の追い上げ中は、常に
 * 最新側へ追いつく)。
 */
const MAX_PENDING_FRAMES = 12;

/**
 * 復号の出力で TIMESTAMP の種類と位置を引くために覚えておく数の上限
 *
 * 再生の入口 (MediaPlayout) の `decodeInputs.maxTracked` に渡す。decoder に渡してから
 * 出力されるまでの間だけ覚える。出力されなかった (decoder のエラーで捨てられたなど) 分が
 * 残り続けないよう、上限を超えたら古い方から忘れる。
 *
 * relay の cache から追いつく途中は decoder へまとめて渡すため、上限は追いつく分の数より
 * 大きくする。30 fps の映像 90 秒で 2700 枚、20 ms ごとの音声 90 秒で 4500 個であり、
 * 余裕をみて 8192 にする。上限を超えた分は位置が分からないため、cache から届いた分でも
 * 描画と再生をしてしまう (そこまで溜まるのは復号が追いつかない場合である)
 */
const MAX_TRACKED_DECODE_INPUTS = 8192;

/**
 * 受信から表示までの時間の統計を signal へ反映する間隔 (ミリ秒)
 *
 * 記録はフレームごとに行うが、signal への反映をフレームごとにすると再描画が
 * 表示の負荷になり、測る対象 (表示の止まり) を自分で悪化させる。
 */
const PLAYOUT_TIMING_PUBLISH_INTERVAL_MS = 500;

/**
 * Catalog の `videoTrack` から `VideoDecoderConfig` を組み立てる。
 * canonical 形式 (avc1 / hvc1) で必要な description は MSF Catalog の Initialization Data
 * (Base64) から復元する。
 * draft-ietf-moq-msf-01 では `initData` (旧 §5.1.20) が `Catalog.initDataList` (§5.1.7) +
 * `CatalogTrack.initRef` (§5.2.13) の参照に分離されたため、`resolveInitData` 経由で取得する。
 * draft-ietf-moq-loc-04 §2.1.2 の用途は変わらない。
 *
 * ブラウザ API に依存しないため、Catalog からの codec 解決の契約はここで検証できる。
 */
export function buildVideoDecoderConfig(
  videoTrack: CatalogTrack,
  catalog: Catalog,
): VideoDecoderConfig {
  if (!videoTrack.codec) {
    throw new Error("video track codec is not specified in catalog");
  }
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    // width / height は Catalog の任意フィールドのため、値がある場合だけ載せる
    // (exactOptionalPropertyTypes では optional な codedWidth / codedHeight に
    //  undefined を代入できない)
    ...(videoTrack.width !== undefined ? { codedWidth: videoTrack.width } : {}),
    ...(videoTrack.height !== undefined ? { codedHeight: videoTrack.height } : {}),
  };
  const initData = resolveInitData(catalog, videoTrack);
  if (initData !== undefined) {
    decoderConfig.description = base64ToArrayBuffer(initData);
  }
  return decoderConfig;
}

/**
 * Subscriber インスタンスの統計フィールドを初期値へリセットする。
 * `startSubscribing` 開始時に decode カウンタや位置情報をクリアする。
 */
export function resetSubscriberStats(instance: sub.SubscriberInstance): void {
  instance.framesDecoded.value = 0;
  instance.keyFramesDecoded.value = 0;
  instance.objectsReceived.value = 0;
  instance.currentGroup.value = 0;
  instance.currentSubGroup.value = 0;
  instance.bytesReceived.value = 0;
  instance.objectsWithExtensions.value = 0;
  instance.chunksCreated.value = 0;
  instance.chunksDecoded.value = 0;
  instance.chunksSkipped.value = 0;
  instance.catchUpFramesSkipped.value = 0;
  instance.staleFramesDropped.value = 0;
  instance.missingReferenceFramesDropped.value = 0;
  instance.decodeErrors.value = 0;
  instance.playoutTiming.value = EMPTY_PLAYOUT_TIMING;
  // 同期の推定も前の購読の値を持ち越さない (映像の購読を始めると作り直す)
  instance.avSync.value = sub.EMPTY_AV_SYNC;
  // 前提から外れた状態の警告も前の購読の値を持ち越さない
  instance.preconditionWarnings.value = [];
  instance.largestLocation.value = null;
  instance.audioObjectsReceived.value = 0;
  instance.audioDatagramObjectsReceived.value = 0;
  instance.audioChunksDecoded.value = 0;
  instance.audioReceiveDelayMs.value = null;
  instance.audioMaxReceiveDelayMs.value = null;
  instance.audioCatchUpObjectsSkipped.value = 0;
  // 順序逆転と重複の計器も購読ごとに数え直す (前の購読の値を次の購読へ持ち越さない)
  instance.duplicateObjectsDropped.value = 0;
  instance.outOfOrderObjectsReceived.value = 0;
  instance.maxOutOfOrderGroupDistance.value = 0;
  instance.audioLastLevel.value = null;
  instance.audioPeakDbfsLeft.value = null;
  instance.audioPeakDbfsRight.value = null;
  instance.audioRmsDbfsLeft.value = null;
  instance.audioRmsDbfsRight.value = null;
  instance.audioWaveformLeft.value = null;
  instance.audioWaveformRight.value = null;
  instance.audioPlayoutRebases.value = 0;
  instance.audioPlayoutDrops.value = 0;
  // 音を加工した量 (時間圧縮と補間) は 500 ms の反映でしか更新しないため、購読を始めた
  // 時点で戻さないと前の購読の値が次の購読の最初まで残る
  instance.audioPlayoutCompressedMs.value = 0;
  instance.audioPlayoutConcealedMs.value = 0;
  instance.audioPlayoutConcealments.value = 0;
  instance.audioPlayoutTiming.value = EMPTY_AUDIO_PLAYOUT_TIMING;
  instance.audioHostDelay.value = EMPTY_HOST_DELAY;
  instance.audioDelay.value = sub.EMPTY_AUDIO_DELAY;
  instance.audioPlayoutCatchUp.value = EMPTY_AUDIO_RECEIVE_CATCH_UP;
  // 購読より長く生きる Context の状態・レート・出力遅延は、再生中なら保持する。
  // 消すと次の statechange まで観測できない。イベントの回数だけ購読ごとに数え直す。
  if (!instance.audioPlaybackEnabled.value) {
    instance.audioContextState.value = null;
    instance.audioContextSampleRate.value = null;
    instance.audioContextBaseLatencyMs.value = null;
    instance.audioContextOutputLatencyMs.value = null;
  }
  instance.audioContextStateChanges.value = 0;
}

/**
 * 受信 Object から `EncodedVideoChunk` に渡す内容を決める
 *
 * publisher 側の Object 送信 (`usePublisher` の `buildObjectSendPlan`) が付与した
 * TIMESTAMP と VIDEO_FRAME_MARKING を読み、chunk の type と timestamp に変換する。
 * キーフレーム判定は `isVideoKeyFrameObject` に委譲する (同じ規則を二重実装しない)。
 * VIDEO_FRAME_MARKING は任意の Property であり、無い場合は Group 先頭の
 * Object ID 0 をキーフレームとして扱う。Properties が無い / 空の Object も
 * Object ID だけで判定し、timestamp は 0 にする。
 *
 * `timestampKind` は TIMESTAMP の種類である。draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2 に
 * より、Timescale が無ければ Unix epoch マイクロ秒の壁時計 (`wallClock`)、あれば
 * メディア時刻 (`mediaTime`) である。TIMESTAMP が無ければ `none`。再生時間の統計は
 * `wallClock` のときだけ送信から受信までの遅延を求める。
 *
 * TIMESCALE は Track と Object の両方に置ける (同 §2.3.1.2) ため、`trackProperties`
 * (SUBSCRIBE_OK の Track Properties) も見て解決する (Object 優先、Track はフォールバック。
 * 音声側の `LOC.resolveAudioProperties` と同じ形)。Track に TIMESCALE を載せる publisher の
 * 映像を壁時計と誤判定し、同期の推定が無効な値になるのを避ける。
 *
 * ブラウザ API に依存しないため、LOC 復号の契約はここで検証できる。
 */
export function buildVideoChunkPlan(
  trackProperties: ReadonlyArray<Property> | undefined,
  obj: MoqtObject,
): {
  type: "key" | "delta";
  timestamp: number;
  timestampKind: PlayoutTimestampKind;
} {
  let timestamp = 0;
  let timestampKind: PlayoutTimestampKind = "none";
  let frameMarking: LOC.VideoFrameMarking | undefined;

  if (obj.properties !== undefined && obj.properties.length > 0) {
    const locProperties = LOC.resolveVideoProperties(trackProperties, obj.properties);

    // TIMESTAMP から timestamp を取得する。EncodedVideoChunk の timestamp はマイクロ秒の
    // ため、Timescale があれば換算する (§2.3.1.2。音声と同じ換算)
    if (locProperties.timestamp !== undefined) {
      timestamp = Number(
        LOC.toDecoderMicroseconds(locProperties.timestamp, locProperties.timescale),
      );
      timestampKind = locProperties.timescale === undefined ? "wallClock" : "mediaTime";
    }

    frameMarking = locProperties.frameMarking;
  }

  return {
    type: isVideoKeyFrameObject(obj.objectId, frameMarking) ? "key" : "delta",
    timestamp,
    timestampKind,
  };
}

/**
 * 購読の object コールバックで受け取った映像 Object と、受け取った時刻
 *
 * 映像 Object は Group の切り替えの保留 (`GroupSwitchGate`) を通ってから処理するため、
 * 処理する時刻は受け取った時刻より遅れうる。到着の統計は受け取った時刻で求める
 * (`recordVideoArrival`)
 */
export interface ReceivedVideoObject {
  readonly object: MoqtObject;
  /** object コールバックで受け取った時刻 (`performance.now()`) */
  readonly receivedAtMs: number;
}

/**
 * 復号前の遅延の段が保持する音声 Object
 *
 * 到着時刻は受信の遅れ (`audio.receiveDelayMs`) と入力の遅れを、復号時ではなく到着時点の
 * 値で測るために持つ。遅延の分だけ受信の遅れが大きく見えると、受信側の追いつきの判定が
 * 誤る。
 */
interface DelayedAudioObject {
  readonly object: MoqtObject;
  readonly viaDatagram: boolean;
  /** object コールバックで受け取った時刻 (`performance.now()`) */
  readonly receivedAtMs: number;
}

/** Object が占めるバイト数 (受信統計と同じ定義) */
function objectBufferedBytes(obj: MoqtObject): number {
  return obj.payload.byteLength + (obj.properties?.byteLength ?? 0);
}

/**
 * 受け取った映像 Object を統計に記録する (object コールバックで、保留に渡す前に呼ぶ)
 *
 * 到着時刻は object コールバックで受け取った時刻であり、Group の切り替えで保留した
 * 時間を含めない。保留は受信側の処理であり、経路 (relay と回線) の到着の遅れではない。
 *
 * - 位置 (Group ID / Object ID / Prior Object ID Gap) と Subgroup ID を、止まりの原因と
 *   受信の欠けのために記録する
 * - TIMESTAMP があれば、到着の揺らぎのために記録する。壁時計のときは送信から受信までの
 *   遅延も求める
 *
 * LOC の Properties を読めない Object は、位置だけを記録する (復号の失敗は handleObject が
 * 数える)。
 *
 * @param timeOriginMs - `performance.timeOrigin`。受け取った時刻を壁時計に換算する
 * @param trackProperties - SUBSCRIBE_OK の Track Properties。TIMESTAMP の種類
 *   (壁時計かメディア時刻か) は TIMESCALE が Track と Object のどちらにあっても決まる
 *   (draft-ietf-moq-loc-04 §2.3.1.2) ため、Object の Properties と合わせて解決する
 */
export function recordVideoReceived(
  stats: PlayoutTimingStats,
  received: ReceivedVideoObject,
  timeOriginMs: number,
  trackProperties: ReadonlyArray<Property> | undefined,
): void {
  const obj = received.object;
  let plan: ReturnType<typeof buildVideoChunkPlan> | null = null;
  let priorObjectIdGap = 0n;
  try {
    plan = buildVideoChunkPlan(trackProperties, obj);
    priorObjectIdGap = priorObjectIdGapOf(obj.properties);
  } catch {
    // 位置だけを記録する
  }
  const timestampMicros = plan === null || plan.timestampKind === "none" ? null : plan.timestamp;
  stats.recordObjectReceived(
    { groupId: obj.groupId, objectId: obj.objectId, priorObjectIdGap },
    obj.subgroupId,
    timestampMicros,
    received.receivedAtMs,
  );
  if (plan === null || timestampMicros === null) {
    return;
  }
  stats.recordArrival(
    received.receivedAtMs,
    timestampMicros,
    plan.timestampKind === "wallClock" ? timeOriginMs + received.receivedAtMs : null,
  );
}

/**
 * `SubscriberInstance` が保持する外部リソース (映像と音声の `decoder` / `catalog` 購読 /
 * 音声トラックの購読 / `session`) を fire-and-forget で解除し、canvas を初期色で塗り潰す。
 *
 * WebTransport が close コールバックを同期 dispatch する実装で teardownSubscriber が
 * 再入する可能性があるため、`session.value = null` を `sessionInstance.close()` より
 * 先に立てる順序を維持する (session.value が残ったまま再入すると teardown が二重に走る)。
 *
 * canvas 塗り潰しは decoder の停止と一体で行うことで「停止した decoder の最終フレームが
 * 残る」表示不整合を避けるため本関数内に置く。
 */
export function closeSubscriberResources(
  instance: sub.SubscriberInstance,
  canvas: HTMLCanvasElement | null,
): void {
  const decoderInstance = instance.decoder.value;
  if (decoderInstance) {
    try {
      decoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  // 音声デコーダも同じく停止する。復号途中の AudioData は decoder 側が捨てる
  const audioDecoderInstance = instance.audioDecoder.value;
  instance.audioDecoder.value = null;
  instance.audioDecoderConfigured.value = false;
  if (audioDecoderInstance) {
    try {
      audioDecoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // catalog 購読を graceful に解除する。 session.close 任せにしない。
  // 制御メッセージのため session.close より先に行う。
  // 二重解除は解除前の null チェックと解除後の null 化で抑止し、
  // 逐次二重は unsubscribe 自体の冪等に委ねる。失敗は握り潰す。
  const catalogSubscriberInstance = instance.catalogSubscriber.value;
  instance.catalogSubscriber.value = null;
  if (catalogSubscriberInstance) {
    void catalogSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // 音声トラックの購読も catalog 購読と同じ順序で解除する
  const audioSubscriberInstance = instance.audioSubscriber.value;
  instance.audioSubscriber.value = null;
  if (audioSubscriberInstance) {
    void audioSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // event timeline トラックの購読も catalog 購読と同じ順序で解除する
  const eventSubscriberInstance = instance.eventSubscriber.value;
  instance.eventSubscriber.value = null;
  if (eventSubscriberInstance) {
    void eventSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // 再入時に sessionInstance が null になっているよう close() より先に立てる。
  const sessionInstance = instance.session.value;
  instance.session.value = null;
  if (sessionInstance) {
    sessionInstance.close().catch(() => {
      // 既にクローズされている場合は無視
    });
  }
}

/**
 * `SubscriberInstance` の状態 signal 群を初期値にリセットし、フックローカル参照
 * (映像 / 音声の Promise チェーン) を巻き戻す。
 *
 * `status` / `statusMessage` / `isStopping` は触らない (停止操作の表示は呼び出し側の責務)。
 *
 * 本関数の末尾で `settingsDisabled` の再有効化を判定する。他の Subscriber と Publisher の
 * どれも接続設定を使っていなければ有効に戻す (購読の確立を待っている Subscriber と、配信を
 * 始めている途中で connect を待っている Publisher も使っているとみなす)。
 * `hasActiveSubscriber` はこのインスタンスの `subscriber` と `isStarting` も数えるため、
 * 両方を下ろしてから判定する (止めたインスタンス自身を数えない)。
 */
export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chains: {
    video: { current: Promise<void> };
    audio: { current: Promise<void> };
  },
): void {
  instance.subscriber.value = null;
  // 確立を待っている購読も後始末で終わる
  instance.isStarting.value = false;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";
  instance.dynamicGroupsSupported.value = false;
  instance.httpVersion.value = null;

  instance.audioSubscriber.value = null;
  instance.audioDecoder.value = null;
  instance.audioDecoderConfigured.value = false;
  instance.audioLastLevel.value = null;
  instance.audioPeakDbfsLeft.value = null;
  instance.audioPeakDbfsRight.value = null;
  instance.audioRmsDbfsLeft.value = null;
  instance.audioRmsDbfsRight.value = null;
  instance.audioWaveformLeft.value = null;
  instance.audioWaveformRight.value = null;
  // 再生トグルは既定 (無効) に戻す。audio graph は呼び出し側が停止する
  instance.audioPlaybackEnabled.value = false;
  // event timeline の購読と受信したメッセージも購読が無い状態に戻す
  instance.eventSubscriber.value = null;
  instance.eventObjectsReceived.value = 0;
  instance.eventMessages.value = [];
  // 同期の推定は購読が無い状態の既定値に戻す
  instance.avSync.value = sub.EMPTY_AV_SYNC;
  // 前提から外れた状態の警告も購読が無い状態に戻す
  instance.preconditionWarnings.value = [];

  instance.largestLocation.value = null;
  // 追いつき中の表示も購読が無い状態に戻す (境界そのものは呼び出し側が消す)
  instance.catchUpPending.value = false;
  // トラックの終了状態も購読が無い状態に戻す (次の購読へ持ち越さない)
  instance.videoTrackEnd.value = null;
  instance.audioTrackEnd.value = null;

  chains.video.current = Promise.resolve();
  // 音声のチェーンも巻き戻す。停止後に残った処理が新しいセッションの signal を
  // 汚さないよう、世代の同一性は各ハンドラ側でも確認する
  chains.audio.current = Promise.resolve();

  if (!sub.hasActiveSubscriber.value && !pub.hasActivePublisher.value) {
    settings.settingsDisabled.value = false;
  }
}

/**
 * startSubscribing の 1 回の購読が、今の購読かを判定する関数を作る
 *
 * 購読を始めるたびに AbortController を作り直す。コールバックは、登録した回の signal が
 * 今の AbortController の signal と同じときだけ今の購読のものである。停止した購読の
 * session の close のコールバックは、close の完了 (relay との往復) の後に届くため、
 * 次の購読を始めた後に届くことがある。そのコールバックで次の購読を後始末しない
 */
export function createAttemptGuard(
  ref: { current: AbortController | null },
  signal: AbortSignal,
): () => boolean {
  return () => ref.current?.signal === signal;
}

// AbortController ベースの中断検知ヘルパー。
// signal.aborted が立っていれば cleanup を呼んでから true を返す。
// cleanup が例外を投げても判定結果は失われないよう握り潰す
// (中断時の後始末は fire-and-forget)。
export function checkAborted(signal: AbortSignal, cleanup: () => void): boolean {
  if (signal.aborted) {
    try {
      cleanup();
    } catch {
      // 中断時の後始末で発生した例外は無視する
    }
    return true;
  }
  return false;
}

export function handleDebugMessage(subscriberId: string, message: DebugMessage): void {
  logDebugMessage(`[${subscriberId}]`, message);
}

/** 購読の接続に使う設定 (接続 URL / Track Namespace / 接続オプション) */
interface SubscriberConnectSettings {
  /** 接続に使う MOQT URI (fragment を含む) */
  readonly connectUrl: string;
  /** 接続に使う Track Namespace のフィールド列 */
  readonly namespaceArray: string[];
  /** `connect()` に渡すオプション */
  readonly connectOptions: ReturnType<typeof settings.buildConnectOptions>;
}

/**
 * 購読の接続に使う設定を決める
 *
 * 有効な接続先の候補があれば、その中から 1 つを選ぶ。接続 URL・Track Namespace・
 * Authorization Token は候補の fragment から決め、接続設定の signal は変えない
 * (ほかの接続の設定表示に影響しない)。購読ごとに選ぶ候補が変わり得るため、どの候補へ
 * 繋いだかはこの購読のインスタンスに残してパネルに表示し、Debug ログにも出す。
 */
function resolveSubscriberConnectSettings(
  subscriberId: string,
  instance: sub.SubscriberInstance,
): SubscriberConnectSettings {
  const target = settings.resolveConnectTarget(instance.candidateSelection.value);
  if (target.selectedServerUrl !== null) {
    addLog("info", `[${subscriberId}] selected the connection target from the candidates`, {
      url: target.selectedServerUrl,
    });
  }
  instance.selectedServerUrl.value = target.selectedServerUrl;
  return {
    connectUrl: target.connectUrl,
    namespaceArray: settings.resolveConnectNamespace(target),
    connectOptions: settings.buildConnectOptions(settings.resolveConnectAuthorizationToken(target)),
  };
}

/**
 * 接続先が決まっていることを確かめる
 *
 * MOQT URI 欄は登録した候補の表示欄で、手入力は無い。候補も共有リンクの接続先も無ければ
 * 接続先が決まらないため、接続の前に理由を出す。
 */
function assertConnectUrl(connectUrl: string, selection: CandidateSelection): void {
  const problem = settings.connectTargetProblem(connectUrl, selection);
  if (problem !== null) {
    throw new Error(problem);
  }
}

// preact 11 では useRef<T>(null) の戻り値が RefObject<T | null> になるため、
// null を許容するシグネチャにしている。実装側は canvasRef.current を
// null チェックしてから利用する。
/**
 * 現在時刻 (performance.now と同じ軸のミリ秒)
 *
 * フックの関数の直下で `performance.now()` を呼ぶと、React Compiler の純粋性の検査に
 * 引っかかる。時刻を読む関数をモジュールの外へ寄せ、呼び出し側の関数を純粋に見せる
 */
function nowMs(): number {
  return performance.now();
}

export function useSubscriber(
  subscriberId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
) {
  // ライブオブジェクトの順次処理用 Promise チェーン (レンダリング間で安定参照)
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // 音声 object の順次処理用 Promise チェーン (映像とは独立させる)
  const audioChainRef = useRef<Promise<void>>(Promise.resolve());
  // 停止時に音声を鳴らし切る処理 (flush → drain → AudioContext.close)。
  // 二重呼び出しは同じ Promise を共有し、AudioContext も 1 回だけ閉じる。
  // 音声の再生のライフサイクル (audioPlaybackController) と、復号の対応付けの両方が使う
  const audioStopRef = useRef(new SubscriberAudioStop());
  // 音声を鳴らす AudioContext のサンプルレート (Hz)。復号器の configure と同じ解決値
  // (`resolveAudioContextSampleRate`) を、音声の購読を始めるときに保存する。AudioContext は
  // 再生のトグルで作られるため、購読の開始までに決めた値を ref 経由で渡す
  // 復号フレームとの不要なリサンプルを避ける。
  const audioContextSampleRateRef = useRef<number>(DEFAULT_AUDIO_SAMPLE_RATE);
  // startSubscribing の中断検知用 AbortController (レンダリング間で安定参照)
  const abortControllerRef = useRef<AbortController | null>(null);
  // 音声と映像の再生の入口。時間軸 (時間軸への記録・表示時刻の決定)、音声の再生
  // (目標の決定・予約・計器への記録)、映像の表示 (表示待ちのキュー・表示周期の
  // 選択・計器への記録)、復号へ渡した入力の対応表をまとめて持つ (moqt-js の
  // src/playout/mediaPlayout.ts)。購読を始めるたびに設定 (jitterBufferEnabled) と catalog の
  // targetLatency に合わせて作り直す。音声と映像の両方をこの 1 つの時間軸へ observe する
  // ことで、同じ式の表示時刻で揃える
  const mediaPlayoutRef = useRef<MediaPlayout | null>(null);
  // 直前の同期の状態 (基準を共有できているかとその理由)。変わったときだけログに残す
  const avSyncStateRef = useRef<AvSyncState | null>(null);
  // relay の cache から追いつく途中かどうかを、SUBSCRIBE_OK の LARGEST_OBJECT を境界に
  // 判定する。映像と音声は別の Track であり、SUBSCRIBE_OK が返す境界も別であるため、
  // Track ごとに 1 つ持つ
  const videoCatchUpGateRef = useRef(new CatchUpGate());
  const audioCatchUpGateRef = useRef(new CatchUpGate());
  // 映像 Object を復号してよいかを Group の順序と欠落から決める (handleObject が使う)。
  // decoder を構成するたびに初期化し、キーフレームから始める
  const videoDecodeOrderRef = useRef(new VideoDecodeOrder());
  // 受信から表示までの時間の統計 (到着・復号・表示で記録する)。購読を始めるたびに
  // 初期化し、PLAYOUT_TIMING_PUBLISH_INTERVAL_MS ごとに signal へ反映する
  const playoutTimingRef = useRef(
    new PlayoutTimingStats(PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin),
  );
  const playoutTimingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 音声の再生の観測 (鳴るはずの時刻・届いた時刻・鳴り始める時刻と、鳴らなかった量)。
  // 音声の購読を始めるたびに初期化し、PLAYOUT_TIMING_PUBLISH_INTERVAL_MS ごとに
  // signal へ反映する (src/playout/audioPlayoutTimingStats.ts)
  const audioPlayoutTimingRef = useRef(
    new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin),
  );
  const audioPlayoutTimingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // メインスレッドの停止 (PerformanceObserver の longtask) と音声の到着の重なりの計器。
  // 音声の購読を始めるたびに作り直し、止めるときに observer を外す
  // (devtools/src/utils/hostDelayTracker.ts)
  const hostDelayTrackerRef = useRef(new HostDelayTracker());
  const hostDelayObserverRef = useRef<PerformanceObserver | null>(null);
  // 前の Group の Subgroup の stream が開いている間、次の Group の映像 Object を保留する
  // (src/groupSwitchGate.ts)。Object は Group ごとに別の stream で届き、前の Group の末尾が
  // 次の Group の先頭より後に届くと、VideoDecodeOrder が古い Group として捨てるため。
  // 購読を始めるたびと停止で初期化する
  const videoGroupGateRef = useRef(new GroupSwitchGate<ReceivedVideoObject>());
  const videoGroupGateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 復号前の再生遅延。購読中に設定を変えられるよう、音声と映像の段をまとめて持つ。
  // 0 のときは段を作らず、既存の経路をそのまま通す
  const preDecodeDelayRef = useRef<SubscriberPreDecodeDelay<
    ReceivedVideoObject,
    DelayedAudioObject
  > | null>(null);
  // 購読中か。停止後に設定を変えても段を作らないために使う
  const preDecodeSubscribedRef = useRef(false);
  // 音声の段から復号チェーンへ流す関数。購読を始めるときに設定し、
  // 停止すると null にする (古い購読の handleAudioObject を呼ばないため)
  const appendAudioPreDecodeRef = useRef<((items: readonly DelayedAudioObject[]) => void) | null>(
    null,
  );
  // flush の間に復号チェーンへ積んだ Object に印を付けるか
  const capturingAudioFlushRef = useRef(false);
  // 音声の再生を始めた時点の累積の計器 (差の求め方は subtractAudioPlayoutCumulative を参照)
  const audioPlayoutStatsBaselineRef = useRef<AudioPlayoutCumulative | null>(null);

  /** 停止 (drain) の flush 用に、復号前の段の保持分を復号へ流す */
  function flushAudioPreDecode(): number {
    // 復号前の段の保持分を flush して復号へ流す。flush の通知は
    // appendAudioPreDecodeRef 経由で復号チェーンへ積まれるため、flush の後に外す
    const delay = preDecodeDelayRef.current;
    capturingAudioFlushRef.current = true;
    let flushed = 0;
    try {
      flushed = delay?.flushAudio() ?? 0;
    } finally {
      capturingAudioFlushRef.current = false;
    }
    appendAudioPreDecodeRef.current = null;
    return flushed;
  }

  // 音声の再生のライフサイクル (開始・停止・切り替え)。audio graph と開始の試行を持つため、
  // フックの再描画では作り直さない (useRef の遅延初期化)。再生の入口・signal・設定・計器は
  // 依存として渡す
  const audioPlaybackControllerRef = useRef<AudioPlaybackController | null>(null);

  // 再生先が変わったら、鳴らしている Context へ反映する。未再生なら次の開始で反映する。
  useSignalEffect(() => {
    const deviceId = settings.selectedAudioOutputDeviceId.value;
    void audioPlaybackControllerRef.current?.setOutputDevice(deviceId).catch((error: unknown) => {
      console.error("Failed to set audio output device:", error);
    });
  });

  /**
   * 音声の再生のライフサイクルを返す (初回の利用時に作る)
   *
   * 描画の間に ref を触らないよう、UI の操作や購読の開始など描画の外から呼ぶ。ここで作ると
   * 再生中の audio graph を参照してしまうため、作るのは最初に使うときだけにする。
   */
  function getAudioPlaybackController(): AudioPlaybackController {
    const existing = audioPlaybackControllerRef.current;
    if (existing !== null) {
      return existing;
    }
    const controller = createAudioPlaybackController({
      subscriberId,
      mediaPlayoutRef,
      audioStopRef,
      flushAudioPreDecode,
      getAudioPlaybackEnabledSignal: () =>
        sub.getSubscriber(subscriberId)?.audioPlaybackEnabled ?? null,
      playAudioEnabled: settings.playAudioEnabled,
      getSelectedAudioOutputDeviceId: () => settings.selectedAudioOutputDeviceId.value,
      // 音声の購読を始めるときに決めた AudioContext のサンプルレート。再生のトグルで
      // AudioContext を作るときに読む
      getAudioContextSampleRate: () => audioContextSampleRateRef.current,
      // AudioContext の状態を signal へ写す。AudioContext を作った直後の初期状態も同じ
      // コールバックで届く。初期状態は statechange ではないため回数に数えない。
      onAudioContextStateChange: (state, contextSampleRate, baseLatencyMs, outputLatencyMs) => {
        const instance = sub.getSubscriber(subscriberId);
        if (instance === undefined) {
          return;
        }
        // 状態が null なら AudioContext がまだ無い。つまり今の通知は作った直後の初期状態
        if (instance.audioContextState.value !== null) {
          instance.audioContextStateChanges.value += 1;
        }
        instance.audioContextState.value = state;
        instance.audioContextSampleRate.value = contextSampleRate;
        instance.audioContextBaseLatencyMs.value = baseLatencyMs;
        instance.audioContextOutputLatencyMs.value = outputLatencyMs;
      },
      // AudioContext を閉じた。閉じた Context の状態を画面に残さない
      onAudioContextClosed: () => {
        const instance = sub.getSubscriber(subscriberId);
        if (instance === undefined) {
          return;
        }
        instance.audioContextState.value = null;
        instance.audioContextSampleRate.value = null;
        instance.audioContextBaseLatencyMs.value = null;
        instance.audioContextOutputLatencyMs.value = null;
      },
      restartAudioPlayoutCumulative: () => {
        // 入口の統計を 1 回だけ読み、基準と表示に共用する
        const instance = sub.getSubscriber(subscriberId);
        const audio = mediaPlayoutRef.current?.getStats().audio ?? null;
        audioPlayoutStatsBaselineRef.current = readAudioPlayoutCumulative(audio);
        if (instance !== undefined) {
          publishAudioPlayoutCumulative(instance, audio);
        }
      },
    });
    audioPlaybackControllerRef.current = controller;
    return controller;
  }

  /**
   * 復号した音を鳴らすかどうかを、再生の入口から渡される入力の情報で決める
   *
   * 記録から位置を引けなかった音は、境界と比べられないため、そのトラックの追いつき中の
   * 表示を終える (判定できないまま「Catching up」を出し続けない)。鳴らす側に倒す
   * (src/catchUpGate.ts)。
   */
  function admitAudioPlayout(input: MediaPlayoutAudioDecodeInput | null): boolean {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      return true;
    }
    // 位置は省略できる (測れなかった値は省略してよい)。位置が無い音は境界と比べられない
    if (input === null || input.location === undefined || input.location === null) {
      markCatchUpUndecided(instance, audioCatchUpGateRef.current);
      return true;
    }
    return admitPlayAudio(instance, input.location);
  }

  /**
   * 復号したフレームを描くかどうかを、再生の入口から渡される入力の情報で決める
   *
   * 記録から位置を引けなかったフレームは、境界と比べられないため、そのトラックの追いつき中の
   * 表示を終える (判定できないまま「Catching up」を出し続けない)。描く側に倒す
   * (src/catchUpGate.ts)。
   */
  function admitVideoPlayout(input: MediaPlayoutVideoDecodeInput | null): boolean {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      return true;
    }
    if (input === null) {
      markCatchUpUndecided(instance, videoCatchUpGateRef.current);
      return true;
    }
    return admitPresentFrame(instance, input.location);
  }

  /**
   * 音声の再生の累積の計器を、入口の統計から取り出す (音声を構成していないときは null)
   *
   * @param audio - `getStats()` を 1 回だけ読んだ値 (`getStats().audio`)
   */
  function readAudioPlayoutCumulative(
    audio: MediaPlayoutAudioStats | null,
  ): AudioPlayoutCumulative | null {
    if (audio === null) {
      return null;
    }
    return {
      compressedMs: audio.compressedMs,
      concealedMs: audio.concealedMs,
      concealments: audio.concealments,
    };
  }

  /**
   * 音声を加工した量 (時間圧縮と補間) を signal へ写す
   *
   * ノイズの切り分けに使う。表示は再生を始めた時点からの差にする
   * (`subtractAudioPlayoutCumulative`)。復号の出力ごとに読むと音声の出力 1 つごとに入口の
   * 統計を組み立て直すことになるため、500 ms の反映に合わせる (音を加工した量は、この周期で
   * 読んでも遅れない)
   */
  function publishAudioPlayoutCumulative(
    instance: sub.SubscriberInstance,
    audio: MediaPlayoutAudioStats | null,
  ): void {
    const cumulative = readAudioPlayoutCumulative(audio);
    if (cumulative === null) {
      return;
    }
    const difference = subtractAudioPlayoutCumulative(
      cumulative,
      audioPlayoutStatsBaselineRef.current,
    );
    instance.audioPlayoutCompressedMs.value = difference.compressedMs;
    instance.audioPlayoutConcealedMs.value = difference.concealedMs;
    instance.audioPlayoutConcealments.value = difference.concealments;
  }

  /**
   * 購読を始めるときに、音声と映像の再生の入口を作り直す
   *
   * 時間軸の有効・無効と targetLatency は呼び出し側が決めた値をそのまま渡す。`video: false`
   * のときは映像の表示の組み立てを含めず、揃える相手がいない音声の並べ方を入口に選ばせる。
   *
   * 表示待ちのキューの上限は、jitter buffer の有効・無効 (`options.jitterBuffer`) から決める
   * (有効のときは入口の既定に任せ、無効のときは共有の時間軸を使わない分だけ小さくする。
   * 引数では受け取らない)。
   *
   * @param options.video - 映像の表示を含めるか
   * @param options.jitterBuffer - jitter buffer (共有の時間軸) を使うか
   * @param options.targetLatencyMs - catalog から解決した表示の遅れの目標 (ミリ秒)
   */
  function createSubscriberMediaPlayout(options: {
    video: boolean;
    jitterBuffer: boolean;
    targetLatencyMs: number | null;
  }): void {
    // 前の購読の映像の表示 (予約した表示と表示待ち) と、復号へ渡した映像入力の対応表を
    // 捨てる
    mediaPlayoutRef.current?.clearVideoQueue();
    // 累積の計器は作り直した入口の値 (0) から数える
    audioPlayoutStatsBaselineRef.current = null;
    const playout = createMediaPlayout({
      jitterBuffer: options.jitterBuffer,
      // jitter buffer が無効のときだけ、到着と復号のゆらぎを吸収するだけの小さな上限を
      // 渡す (有効のときは入口の既定 = JITTER_BUFFER_MAX_QUEUED_FRAMES に任せる)
      ...(options.jitterBuffer ? {} : { maxQueuedFrames: MAX_PENDING_FRAMES }),
      targetLatencyMs: options.targetLatencyMs,
      // 復号の出力で入力が引けなかった音に使う、意図した復号前の遅延。購読中に設定が
      // 変わったときは setIntentionalDelayMs で更新する
      intentionalDelayMs: preDecodeDelayRef.current?.delayMs ?? 0,
      // 復号の出力で位置を引くため、同じ TIMESTAMP の Object が重なったらその TIMESTAMP の
      // 分は忘れる (どちらの位置か決められない)。relay の cache から追いつく分を覚えられる
      // 上限にする
      decodeInputs: {
        forgetOnDuplicate: true,
        maxTracked: MAX_TRACKED_DECODE_INPUTS,
      },
      audio: {
        // 計器は signal へ反映する 1 つのインスタンスを渡す (購読を始めるたびに reset する)
        timing: audioPlayoutTimingRef.current,
        // relay の cache から追いつく途中の音は鳴らさない
        admit: admitAudioPlayout,
      },
      video: options.video
        ? {
            output: {
              // 購読が終わったら描かない (canvas は描くときに引く)
              isAvailable: () => sub.getSubscriber(subscriberId) !== undefined,
              present: (frame, presentationMs) => drawFrame(frame, presentationMs),
            },
            pacing: {
              // canvas へ直接描くため、表示周期を待って 1 枚ずつ描く。まとめて描くと、
              // まとまって届いたフレームが早送りに見える
              drainImmediately: false,
              framesPerDrain: 1,
            },
            timing: {
              recordQueueDrop: (timestamp) => playoutTimingRef.current.recordQueueDrop(timestamp),
              recordLateDrop: (timestamp, presentationMs) =>
                playoutTimingRef.current.recordLateDrop(timestamp, presentationMs),
            },
            // relay の cache から追いつく途中のフレームは描かない
            admit: admitVideoPlayout,
          }
        : null,
    });
    // 再生中の AudioContext があれば、作り直した入口へ鳴らす先を付ける
    getAudioPlaybackController().attachPlaybackToPlayout(playout);
    mediaPlayoutRef.current = playout;
  }

  /**
   * 保留を通った映像 Object を到着順の Promise チェーンに積み、保留が残っていれば
   * 上限で保留を解くタイマーを張り直す
   */
  function enqueueVideoObjects(objects: ReceivedVideoObject[]): void {
    // 段が無い (遅延 0 または停止中) のときは既存の経路でそのまま復号する
    const delay = preDecodeDelayRef.current;
    for (const received of objects) {
      if (delay === null || !delay.pushVideo(received)) {
        appendVideoPreDecode([received]);
      }
    }
    if (videoGroupGateTimerRef.current !== null) {
      clearTimeout(videoGroupGateTimerRef.current);
      videoGroupGateTimerRef.current = null;
    }
    const deadlineMs = videoGroupGateRef.current.holdDeadlineMs;
    if (deadlineMs === null) {
      return;
    }
    videoGroupGateTimerRef.current = setTimeout(
      () => {
        videoGroupGateTimerRef.current = null;
        const expired = videoGroupGateRef.current.expire(performance.now());
        if (expired.length > 0) {
          // 前の Group の stream の終わりを待たずに保留を解いた
          playoutTimingRef.current.recordGroupSwitchHoldExpired();
        }
        enqueueVideoObjects(expired);
      },
      Math.max(0, deadlineMs - nowMs()),
    );
  }

  /** 保留している映像 Object を捨て、Group の切り替えの保留を初期状態に戻す */
  function resetVideoGroupGate(): void {
    if (videoGroupGateTimerRef.current !== null) {
      clearTimeout(videoGroupGateTimerRef.current);
      videoGroupGateTimerRef.current = null;
    }
    videoGroupGateRef.current.reset();
  }

  /** 復号前の段の上限超過をログに残す (購読期間あたりメディアごとに 1 回) */
  function logPreDecodeOverflow(overflow: SubscriberPreDecodeDelayOverflow): void {
    addLog("warn", `[${subscriberId}] pre-decode delay queue overflow`, {
      media: overflow.media,
      delayMs: overflow.delayMs,
      effectiveDelayMs: overflow.effectiveDelayMs,
      dropped: overflow.dropped,
      size: overflow.size,
    });
  }

  /** 復号前の段を返す (初回に作る)。期限の通知先は下の関数を参照する */
  function getPreDecodeDelay(): SubscriberPreDecodeDelay<ReceivedVideoObject, DelayedAudioObject> {
    let delay = preDecodeDelayRef.current;
    if (delay === null) {
      delay = new SubscriberPreDecodeDelay<ReceivedVideoObject, DelayedAudioObject>({
        bytesOfVideo: (received) => objectBufferedBytes(received.object),
        bytesOfAudio: (item) => objectBufferedBytes(item.object),
        onVideoDue: (items) => appendVideoPreDecode(items),
        onAudioDue: (items) => appendAudioPreDecodeRef.current?.(items),
        onOverflow: (overflow) => logPreDecodeOverflow(overflow),
        onDueError: (error) => {
          addLog("error", `[${subscriberId}] failed to drain pre-decode delay queue`, {
            error: String(error),
          });
        },
      });
      preDecodeDelayRef.current = delay;
    }
    return delay;
  }

  /** 映像の復号前の段から復号チェーンへ積む */
  function appendVideoPreDecode(objects: readonly ReceivedVideoObject[]): void {
    for (const received of objects) {
      chainRef.current = chainRef.current.then(() => handleObject(received)).catch(() => {});
    }
  }

  /**
   * 復号前の遅延を変えたときに、表示時刻の基準を取り直す
   *
   * 基準の遅れは「復号の出力の時刻 - TIMESTAMP」の直近 10 秒の最小値であるため、
   * 復号の出力の時刻が遅延の分だけ動いても、古い基準が 10 秒間は残る。古い基準のままだと
   * 表示時刻が実際の復号より遅延の分だけ前になり、映像が表示時刻を過ぎたフレームとして
   * 捨てられる。基準を取り直し、表示待ちのフレームも捨てて、変更後の遅延ですぐに並べ直す。
   * 音声の追いつきの床 (直近の遅れの最小値) も古い遅延のまま残るため、観測を消す。残すと
   * 変更後の最初の復号出力を復号器の詰まりと誤判定する。
   */
  function resetPlayoutTimingForPreDecodeChange(): void {
    // 時間軸の基準・映像の表示待ち・音声の追いつきの観測をまとめて消す
    // (再生の入口の resetPlayout)。音声と映像のどちらも、変更後の遅延ですぐに並べ直す
    mediaPlayoutRef.current?.resetPlayout();
  }

  /**
   * 購読の開始時に、現在の設定で復号前の段を作る
   *
   * 前の購読の段とタイマーは先に破棄する。遅延が 0 のときは段を作らず、受信した Object を
   * 既存の経路でそのまま復号する。
   */
  function initializePreDecodeDelay(): void {
    preDecodeSubscribedRef.current = true;
    getPreDecodeDelay().start(settings.preDecodeDelayMs.value);
  }

  /** 復号前の段、タイマー、音声の復号チェーンへの通知先を破棄する */
  function resetPreDecodeDelay(): void {
    preDecodeSubscribedRef.current = false;
    preDecodeDelayRef.current?.stop();
    appendAudioPreDecodeRef.current = null;
  }

  /**
   * 設定の変更を、進行中の購読の復号前の段へ反映する
   *
   * 購読していないときは何もしない (次の購読の開始時に現在の設定で段を作る)。購読中に
   * 0 から増やしたときは段を作り、減らしたときは保持中の Object の期限を計算し直す。
   * 0 にしたときは保持中の Object を待たずに復号チェーンへ流して段をやめる。
   */
  function applyPreDecodeDelay(value: number): void {
    if (!preDecodeSubscribedRef.current) {
      return;
    }
    const delay = getPreDecodeDelay();
    if (delay.delayMs === value) {
      return;
    }
    if (value > 0 && !delay.isActive) {
      delay.start(value);
    } else {
      delay.setDelayMs(value);
    }
    resetPlayoutTimingForPreDecodeChange();
    // 復号の出力で入力が引けなかった音の追いつきの判定に使う、意図した復号前の遅延も
    // 今の設定へ合わせる (記録から引けた音は実際に保持した時間を使うため影響しない)
    mediaPlayoutRef.current?.setIntentionalDelayMs(value);
  }

  /**
   * 音声と映像で共有する `targetLatency` を決める (ミリ秒)
   *
   * 解決の規則はライブラリと共有する純関数 (src/msf/tracks.ts) が持つ。ここでは同じ
   * render group / alternate group のトラックで値が異なるとき (draft-ietf-moq-msf-01
   * §5.2.8 の MUST 違反) の警告だけを行う (ライブラリは onError で通知する)。
   */
  function resolveTargetLatencyMs(tracks: CatalogMediaTracks): number | null {
    const resolved = resolveSharedTargetLatencyMs(tracks.audio ?? null, tracks.video ?? null);
    if (resolved.conflict) {
      addLog("warn", `[${subscriberId}] targetLatency differs between tracks in the same group`, {
        audio: effectiveTargetLatencyMs(tracks.audio ?? null),
        video: effectiveTargetLatencyMs(tracks.video ?? null),
        used: resolved.value,
      });
    }
    return resolved.value;
  }

  /**
   * 基準を共有できているかが変わったら、内訳と一緒にログへ残す
   *
   * 2 つのトラックを別々の時計として扱い始めた (戻った) 時点が、A/V のずれが広がる
   * 原因になる。判定と本文は純関数 (`utils/avSyncTransition.ts`) が持つ。
   */
  function logAvSyncTransition(snapshot: sub.AvSyncSnapshot): void {
    const transition = detectAvSyncTransition(avSyncStateRef.current, snapshot, subscriberId);
    avSyncStateRef.current = transition.state;
    if (transition.log !== null) {
      addLog(transition.log.level, transition.log.message, transition.log.data);
    }
  }

  /**
   * 統計の記録と表示待ちのキューを初期化し、signal への定期的な反映を始める
   *
   * jitter buffer の有効・無効は購読を始めた時点の設定で決める (購読中は設定を
   * 変更できない)。無効のときは全フレームを TIMESTAMP を使わずに積み、従来どおり
   * 届いた順に 1 枚ずつ表示する。
   *
   * `tracks` は購読する音声と映像のトラックである。catalog の `targetLatency` を解決して
   * 時間軸へ渡し、音声と映像で同じ表示時刻の式を使う (draft-ietf-moq-msf-01 §5.2.8)。
   * 音声だけを購読するときは映像の時間軸を作らないため、この関数は呼ばない
   */
  function startPlayoutTiming(tracks: CatalogMediaTracks): void {
    stopPlayoutTiming();
    playoutTimingRef.current.reset();
    const enabled = settings.jitterBufferEnabled.value;
    // キューの上限が変わるため、時間軸も作り直す (表示の遅れの上限がキューから決まる)。
    // 作り直した時間軸にも同じ targetLatency を渡す (無いときは null でフォールバック)
    createSubscriberMediaPlayout({
      video: true,
      jitterBuffer: enabled,
      targetLatencyMs: resolveTargetLatencyMs(tracks),
    });
    playoutTimingTimerRef.current = setInterval(() => {
      const instance = sub.getSubscriber(subscriberId);
      if (!instance) return;
      // 入口の統計は 1 回だけ読み、この周期で写す値へ配る (組み立てを繰り返さない)
      const stats = mediaPlayoutRef.current?.getStats() ?? null;
      playoutTimingRef.current.recordPlayoutDelay(stats?.video?.playoutDelayMs ?? null);
      instance.playoutTiming.value = playoutTimingRef.current.snapshot(performance.now());
      // 同期の推定も同じ周期で反映する (フレームごとに反映すると再描画が表示の負荷になる)。
      // jitter buffer が無効のときは入口が avSync を null で返すため既定値に落とす。
      // 内訳の変化 (基準を共有できているか) はログへも残す
      const avSync = stats?.avSync ?? sub.EMPTY_AV_SYNC;
      instance.avSync.value = avSync;
      logAvSyncTransition(avSync);
    }, PLAYOUT_TIMING_PUBLISH_INTERVAL_MS);
  }

  /**
   * signal への反映を止め、記録を捨てる。signal には最後に反映した値を残す
   * (他の統計と同じく、停止後も直前の購読の値を表示し、次の購読開始で初期化する)
   */
  function stopPlayoutTiming(): void {
    if (playoutTimingTimerRef.current !== null) {
      clearInterval(playoutTimingTimerRef.current);
      playoutTimingTimerRef.current = null;
    }
    playoutTimingRef.current.reset();
    // 次の購読では状態が変わったときとしてログを出し直す (前の購読の状態を持ち越さない)
    avSyncStateRef.current = null;
  }

  /**
   * 音声の再生の観測の signal への反映を始める (音声の購読を始めるとき)
   *
   * 映像トラックの無い (音声だけの) 購読では映像の時間軸を作らないため、映像の統計の
   * タイマーとは別に持つ。記録は購読を始めるたびに捨てる (前の購読の値を持ち越さない)。
   */
  function startAudioPlayoutTiming(): void {
    stopAudioPlayoutTimingTimer();
    audioPlayoutTimingRef.current.reset();
    // メインスレッドの停止の監視も購読ごとに始め直す (前の購読の停止を持ち越さない)
    startHostDelayTracking();
    audioPlayoutTimingTimerRef.current = setInterval(() => {
      const instance = sub.getSubscriber(subscriberId);
      if (!instance) return;
      const currentMs = nowMs();
      // 出力機器の推定値は running 通知の後にも更新される。初期値の 0 を保持しない。
      const latency = audioPlaybackControllerRef.current?.getOutputLatency() ?? null;
      instance.audioContextBaseLatencyMs.value = latency?.baseLatencyMs ?? null;
      instance.audioContextOutputLatencyMs.value = latency?.outputLatencyMs ?? null;
      // 入口の統計は 1 回だけ読み、この周期で写す値へ配る (組み立てを繰り返さない)
      const audio = mediaPlayoutRef.current?.getStats().audio ?? null;
      instance.audioPlayoutTiming.value = audioPlayoutTimingRef.current.snapshot(currentMs);
      instance.audioHostDelay.value = hostDelayTrackerRef.current.snapshot(currentMs);
      // 再生予算の内訳。音声だけの購読でも A/V 同期の snapshot は作らないため、
      // 再生の入口から直接読む (音声だけでも到着の観測と予約の計器は動かす)
      instance.audioDelay.value = currentAudioDelay(audio);
      publishAudioPlayoutCatchUp(instance, audio);
      // 音声を加工した量 (時間圧縮と補間) も同じ周期で写す (復号の出力ごとには読まない)
      publishAudioPlayoutCumulative(instance, audio);
    }, PLAYOUT_TIMING_PUBLISH_INTERVAL_MS);
  }

  /**
   * 音声の再生の観測の反映を止め、最後の観測値を 1 回反映する
   *
   * 停止の直前に切り捨てられた分 (予約済みで鳴らなかった音) まで画面と「Copy for LLM」に
   * 出したいため、タイマーを止める前に最後の値を反映する。signal には最後に反映した値を
   * 残す (他の統計と同じく、停止後も直前の購読の値を表示する)
   */
  function stopAudioPlayoutTiming(): void {
    stopAudioPlayoutTimingTimer();
    // 停止の監視を先に外し、最後の値を反映した後に届いた停止で統計が変わらないようにする
    stopHostDelayTracking();
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;
    const currentMs = nowMs();
    // 入口の統計は 1 回だけ読み、最後の値を各 signal へ配る
    const audio = mediaPlayoutRef.current?.getStats().audio ?? null;
    instance.audioPlayoutTiming.value = audioPlayoutTimingRef.current.snapshot(currentMs);
    instance.audioHostDelay.value = hostDelayTrackerRef.current.snapshot(currentMs);
    instance.audioDelay.value = currentAudioDelay(audio);
    publishAudioPlayoutCatchUp(instance, audio);
    publishAudioPlayoutCumulative(instance, audio);
  }

  /**
   * メインスレッドの停止 (PerformanceObserver の longtask) の監視を始める
   *
   * 音声の購読を始めるたびに呼ぶ。`PerformanceObserver` が無い環境と、`longtask` を
   * 報告しない環境 (Safari / Firefox など) では何もしない。このとき signal は既定値
   * (0) のままになり、停止の回数が 0 であることと「監視していない」ことは区別できないが、
   * 計器のために音声の経路を変えないことを優先する。
   *
   * 停止区間は `longtask` の `startTime` と `duration` をそのまま渡す。報告は止まった後に
   * 届くため、到着との重なりは `HostDelayTracker.snapshot()` が記録の順序に依らず求める。
   */
  function startHostDelayTracking(): void {
    stopHostDelayTracking();
    hostDelayTrackerRef.current.reset();
    if (typeof PerformanceObserver === "undefined") {
      return;
    }
    // longtask を報告しないブラウザでは observe しても通知が来ない。対応表で先に確かめる
    if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      return;
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          hostDelayTrackerRef.current.recordStall(entry.startTime, entry.duration);
        }
      });
      observer.observe({ type: "longtask" });
      hostDelayObserverRef.current = observer;
    } catch (error) {
      // 監視を始められなくても音声の統計は動かす (計器だけを 0 のままにする)
      console.error(`[${subscriberId}] failed to observe long tasks:`, error);
    }
  }

  /** メインスレッドの停止の監視を止める (購読の停止と、購読のやり直しの前) */
  function stopHostDelayTracking(): void {
    hostDelayObserverRef.current?.disconnect();
    hostDelayObserverRef.current = null;
  }

  /**
   * 音声の再生予算の内訳を、入口の統計から取り出す
   *
   * 音声だけの購読でも A/V 同期の snapshot は作らないため、再生の入口から直接読む
   * (音声だけでも到着の観測と予約の計器は動かす)。出力 lead は jitter buffer を
   * 無効にしても観測される。音声を構成していないときだけ既定値にする
   *
   * @param audio - `getStats()` を 1 回だけ読んだ値 (`getStats().audio`)
   */
  function currentAudioDelay(audio: MediaPlayoutAudioStats | null): AudioPlayoutDelayStats {
    // 再生予算の内訳は、再生の入口の統計 (`getStats().audio.delay`) が持つ
    return audio?.delay ?? sub.EMPTY_AUDIO_DELAY;
  }

  /**
   * 受信側の音声の追いつきの観測値を signal へ写す
   *
   * 観測は再生の入口が持つ。500 ms ごとの反映に合わせる (音を鳴らすたびに写すと、値が
   * 変わっただけで画面が毎秒 50 回描き直される)。音声を再生していない間は鳴らしていない
   * ため、既定値にする
   *
   * @param audio - `getStats()` を 1 回だけ読んだ値 (`getStats().audio`)
   */
  function publishAudioPlayoutCatchUp(
    instance: sub.SubscriberInstance,
    audio: MediaPlayoutAudioStats | null,
  ): void {
    // 再生の有無を読むだけなので、コントローラが未生成なら生成しない
    // (音声を再生しない購読で 500 ms ごとに生成するのを避ける)
    const controller = audioPlaybackControllerRef.current;
    if (controller === null || !controller.hasPlayback()) {
      instance.audioPlayoutCatchUp.value = EMPTY_AUDIO_RECEIVE_CATCH_UP;
      return;
    }
    instance.audioPlayoutCatchUp.value = audio?.catchUp ?? EMPTY_AUDIO_RECEIVE_CATCH_UP;
  }

  /** 音声の再生の観測を signal へ反映するタイマーを止める */
  function stopAudioPlayoutTimingTimer(): void {
    if (audioPlayoutTimingTimerRef.current !== null) {
      clearInterval(audioPlayoutTimingTimerRef.current);
      audioPlayoutTimingTimerRef.current = null;
    }
  }

  /**
   * relay の cache から追いつく途中かどうかの境界を初期化する (購読を始めるたびに呼ぶ)
   *
   * 境界は各 Track の SUBSCRIBE_OK の LARGEST_OBJECT で設定する。この時点では前の購読の
   * 境界を消し、追いつき中ではないものとして扱う
   */
  function resetCatchUpGates(): void {
    videoCatchUpGateRef.current.reset();
    audioCatchUpGateRef.current.reset();
    const instance = sub.getSubscriber(subscriberId);
    if (instance !== undefined) {
      instance.catchUpPending.value = false;
    }
  }

  /** 画面の「Catching up」の表示を更新する (判定は applyCatchUpPending) */
  function refreshCatchUpPending(instance: sub.SubscriberInstance): void {
    applyCatchUpPending(instance, {
      video: videoCatchUpGateRef.current,
      audio: audioCatchUpGateRef.current,
    });
  }

  /**
   * 位置が分からない Object を再生したとき、その Track の追いつき中の表示を終える
   *
   * TIMESTAMP を持たない publisher では位置を引けず、境界と比べられない。判定できないまま
   * 「Catching up」を出し続けないよう、その Track は追いつきを終えたものとして扱う
   * (境界は消さないため、位置が分かる Object の判定は続く)
   */
  function markCatchUpUndecided(instance: sub.SubscriberInstance, gate: CatchUpGate): void {
    foldCatchUpGate(instance, gate, {
      video: videoCatchUpGateRef.current,
      audio: audioCatchUpGateRef.current,
    });
  }

  /**
   * event timeline トラックを購読する
   *
   * 受信した Object を decodeEventTimeline で entry の配列に戻し、表示を置き換える。
   * devtools の publisher は Group の先頭 Object にその時点の全履歴を載せるため、
   * 置き換えで履歴が揃う (draft-ietf-moq-msf-01 §8.3)。data の構造は catalog の
   * eventType (§5.2.5) が定義する
   */
  async function startEventSubscription(
    session: Session,
    namespaceArray: string[],
    eventTrack: CatalogTrack,
    instance: sub.SubscriberInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const eventSubscriberInstance = await session.subscribe(
      namespaceArray,
      eventTrack.name,
      {
        object: (obj: MoqtObject) => {
          // 停止した購読の Object が遅れて届いても、表示を変えない
          if (signal.aborted) return;
          // 受信した Object の数。Group の先頭 Object に履歴が載るため、履歴の件数とは別
          instance.eventObjectsReceived.value++;
          try {
            instance.eventMessages.value = decodeEventTimeline(obj.payload);
          } catch (error) {
            addLog("error", `[${subscriberId}] failed to decode event timeline`, {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
        end: (publishDone) => {
          logPublishDoneEnd(subscriberId, "event timeline stream ended", publishDone);
        },
        error: (error) => {
          addLog("error", `[${subscriberId}] event timeline subscribe error`, {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      },
      {
        // draft-ietf-moq-transport-22 §9.20.6 (RENDEZVOUS TIMEOUT):
        // Catalog が広告する event timeline トラックは、Catalog の到着直後にはまだ
        // publish されていないことがある。relay に購読を保持させる
        rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
        // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track には SETUP に載せたトークンを
        // SUBSCRIBE にも MUST 付与する (SETUP に載せていても免除されない)
        ...subscribeAuthorizationTokenOptions(eventTrack, session.setupAuthorizationToken),
      },
    );

    if (
      checkAborted(signal, () => {
        void eventSubscriberInstance.unsubscribe().catch(() => {});
      })
    ) {
      return;
    }
    instance.eventSubscriber.value = eventSubscriberInstance;
  }

  /**
   * Catalog に event timeline トラックがあれば購読を始める
   *
   * 購読の確立は待たない (映像 / 音声の購読を遅らせない)。失敗してもメディアの視聴は
   * 妨げないため、警告ログだけを残す。Catalog は instance が保持しているもの
   * (受信のたびに置き換わる) を読む
   */
  function startEventSubscriptionIfAdvertised(
    session: Session,
    namespaceArray: string[],
    instance: sub.SubscriberInstance,
    signal: AbortSignal,
  ): void {
    const catalog = instance.catalog.value;
    if (catalog === null) {
      return;
    }
    const eventTrack = resolveEventTimelineTrack(catalog);
    if (eventTrack === undefined) {
      return;
    }
    void startEventSubscription(session, namespaceArray, eventTrack, instance, signal).catch(
      (error: unknown) => {
        addLog("warn", `[${subscriberId}] failed to start event timeline subscription`, {
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /**
   * 音声トラックを購読して復号する
   *
   * catalog の `samplerate` / `channelConfig` から decoder を構成する。受信 object の
   * LOC properties は Track Property と Object Property の両方から解決し、
   * AUDIO_LEVEL を signal へ、AUDIO_CONFIG (AAC) を decoder の description へ渡す。
   *
   * 音声トラックの終わり (PUBLISH_DONE) は `handleTrackEnd` が扱う。`trackCallbacks` を渡すと
   * 音声トラックのエラーを画面のエラー表示にも伝える (渡さないときはログだけを残す)
   */
  async function startAudioSubscription(
    session: Session,
    namespaceArray: string[],
    audioTrack: CatalogTrack,
    instance: sub.SubscriberInstance,
    signal: AbortSignal,
    isCurrentAttempt: () => boolean,
    trackCallbacks?: TrackErrorCallbacks,
  ): Promise<void> {
    if (!audioTrack.codec) {
      throw new Error("audio track codec is not specified in catalog");
    }
    const audioCodec = parseAudioCodec(audioTrack.codec);
    const catalogSampleRate = audioTrack.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
    // AudioContext と復号器の configure を、復号が実際に返すレートへ揃える。Chromium の
    // Opus 復号は configure の sampleRate に関係なく 48 kHz を返すため、Catalog が 44100 の
    // ときに Catalog の値を使うと復号フレームと AudioContext のレートが食い違う
    // (docs/AUDIO_GLITCH_CAUSES.md の A1)。AudioContext は再生の開始時に作るため、
    // 解決値は ref に保存して渡す
    const sampleRate = resolveAudioContextSampleRate(audioCodec, catalogSampleRate);
    audioContextSampleRateRef.current = sampleRate;
    // channelConfig は名前付き値 (mono / stereo) と整数文字列を受け付ける。
    // 解決不能な明示値はここで throw し、NaN をデコーダに渡さない
    const channels = resolveAudioChannelCount(audioTrack.channelConfig);
    const useWorker = settings.useDedicatedWorker.value;

    // output はコンストラクタから同期で呼ばれないため、自身を参照しても TDZ にならない
    const audioDecoderInstance: AudioDecoderWrapper = new AudioDecoderWrapper(useWorker, {
      output: (data) => {
        handleAudioDecoded(data.data, audioDecoderInstance);
      },
      error: (error) => {
        console.error(`[${subscriberId}] Audio decoder error:`, error);
        // 復号器が壊れると未処理の投入の出力は届かない。drain の flush の待ちを残さない
        audioStopRef.current.discardFlushedOutputs();
        instance.decodeErrors.value += 1;
      },
    });
    try {
      await audioDecoderInstance.configure(audioCodec, sampleRate, channels);
    } catch (error) {
      // configure に失敗した場合は Worker を作った後でも残さない
      audioDecoderInstance.close();
      throw error;
    }

    // configure await 中に中断された場合、ローカル参照は instance に未代入のため
    // 中断元から見えない。ここで閉じないと停止済み instance に代入されてリークする
    if (
      checkAborted(signal, () => {
        audioDecoderInstance.close();
      })
    ) {
      return;
    }

    instance.audioDecoder.value = audioDecoderInstance;
    instance.audioDecoderConfigured.value = true;
    // 音声の再生の観測を始める (音声だけの購読でも再生は起きるため、映像の統計とは別に持つ)
    startAudioPlayoutTiming();
    // 復号の通し番号と drain の flush の待ちを購読ごとに初期化する (前の購読の出力を
    // 待ち続けない。停止の開始時には消さない)
    audioStopRef.current.resetDrainTracking();

    // 直前に decoder へ渡した Audio Config。AAC のときだけ使う
    let appliedAudioConfig: Uint8Array | undefined;

    /**
     * 受信した音声 Object を復号へ流す
     *
     * @param viaDatagram - datagram で届いた Object かどうか。経路別の数を出すためだけに
     *   使い、処理は Subgroup と同じにする (音声は Group 1 つ = Object 1 つのため、
     *   datagram でも復号の順序は到着順で足りる)
     * @param receivedAtMs - object コールバックで受け取った時刻。復号前の遅延を挟んでも
     *   受信の遅れを到着時点の値で測るために使う
     */
    // 同じ Object を 2 回受け取ったときに 2 回目を捨てるための最近の識別子。音声は datagram で
    // 届き再送されない (RFC 9221) ため、経路の損失に備えて配信側が同じ Object を 2 回送る
    // ことがある。渡すと同じ音を 2 回鳴らし、媒体時刻が実時間より先へ進む
    const recentAudioObjectIds: string[] = [];
    const recentAudioObjectIdSet = new Set<string>();
    // 受信した音声 Object の順序逆転を測るための、購読ごとの観測器。
    // 音声は 1 Object = 1 Group であり、Group が異なる Object の順序は保証されない
    // (draft-ietf-moq-transport-22 §2.3.1)。復号は到着順のままなので、逆順に届いたかを
    // 計器で読めるようにする。境界の扱いと最近見た Location の窓は観測器が持つ
    const audioReceiveOrder = new AudioReceiveOrderTracker(AUDIO_RECENT_OBJECT_IDS_MAX);

    /**
     * 受信した音声 Object の Location から、順序逆転の計器を更新する
     *
     * 比較は Group ID → Object ID の順である (draft-ietf-moq-transport-22 §8.2 の Location
     * 比較)。同じ Location は重複である。重複は enqueueAudioDecodeDirect が
     * `duplicateObjectsDropped` として数えるため、順序逆転としては数えない。
     */
    const observeAudioReceiveLocation = (
      current: sub.SubscriberInstance,
      location: Location,
    ): void => {
      const observation = audioReceiveOrder.observe(location);
      if (!observation.outOfOrder) {
        return;
      }
      current.outOfOrderObjectsReceived.value += 1;
      if (observation.groupDistance > current.maxOutOfOrderGroupDistance.value) {
        current.maxOutOfOrderGroupDistance.value = observation.groupDistance;
      }
    };

    const handleAudioObject = async (
      obj: MoqtObject,
      viaDatagram: boolean,
      receivedAtMs: number,
      flushed = false,
    ): Promise<void> => {
      const current = getCurrentAudioSubscriber(audioDecoderInstance);
      if (current === null) {
        return;
      }

      current.audioObjectsReceived.value += 1;
      if (viaDatagram) {
        current.audioDatagramObjectsReceived.value += 1;
      }

      try {
        // draft-ietf-moq-loc-04 §2.3 は LOC Public Properties を Object Properties として
        // 運ぶと定めるため、AUDIO_LEVEL は object 単位でしか届かない。載っていない
        // object では null に戻す (前の object の値を持ち越さない)
        const locProperties = LOC.resolveAudioProperties(
          current.audioSubscriber.value?.trackProperties,
          obj.properties,
        );
        current.audioLastLevel.value = locProperties.audioLevel ?? null;

        // 到着の遅れ (受信した壁時計 - LOC TIMESTAMP)。配信側が足した遅れ
        // (audio.catchUp.sendLagMs) と対で読み、遅れが配信側にあるのか relay と経路に
        // あるのかを分ける。壁時計の TIMESTAMP (TIMESCALE なし) のときだけ測れる。
        // 同じ値を、復号が足している遅れを求める入力の遅れとしても使う
        // (src/playout/audioReceiveCatchUp.ts の先頭のコメント)。受信の入口で測った到着時刻を
        // 使うため、復号前の遅延を挟んでも遅延の分が入力の遅れに含まれない
        let inputLagMs: number | null = null;
        if (locProperties.timestamp !== undefined && locProperties.timescale === undefined) {
          const receiveDelayMs =
            performance.timeOrigin + receivedAtMs - Number(locProperties.timestamp) / 1_000;
          current.audioReceiveDelayMs.value = receiveDelayMs;
          const previousMax = current.audioMaxReceiveDelayMs.value;
          current.audioMaxReceiveDelayMs.value =
            previousMax === null ? receiveDelayMs : Math.max(previousMax, receiveDelayMs);
          inputLagMs = receiveDelayMs;
        }

        // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) が定める Audio Config は
        // AudioDecoderConfig の description に対応する。値が変わったときだけ
        // WebCodecs の configure をやり直す (同じ値を渡し続けない)
        if (
          requiresAudioSpecificConfig(audioCodec) &&
          locProperties.config !== undefined &&
          !isSameCodecDescription(appliedAudioConfig, locProperties.config)
        ) {
          const description = new Uint8Array(locProperties.config);
          try {
            // configure は未処理の出力を捨てる。復号の通し番号の対応と drain の flush の
            // 待ちをそのままにすると、以後の対応がずれて drain が早く終わる
            audioStopRef.current.discardFlushedOutputs();
            await audioDecoderInstance.configure(audioCodec, sampleRate, channels, description);
            appliedAudioConfig = description;
          } catch (error) {
            // 適用できなかった config は「適用済み」にしない。同じ config を持つ
            // 後続 object で再試行できるようにする
            console.error(`[${subscriberId}] failed to reconfigure audio decoder:`, error);
            current.decodeErrors.value += 1;
            return;
          }
        }

        if (!current.audioDecoderConfigured.value) {
          return;
        }

        // TIMESTAMP は TIMESCALE の有無に応じてマイクロ秒へ換算する
        // (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)。
        // Timescale がある TIMESTAMP は壁時計ではなくメディア時刻であるため、映像と
        // 同じく、復号の出力で同期の表示時刻に使わない (kind は復号の出力で引く)
        const timestampKind: PlayoutTimestampKind =
          locProperties.timestamp === undefined
            ? "none"
            : locProperties.timescale === undefined
              ? "wallClock"
              : "mediaTime";
        const timestamp =
          locProperties.timestamp === undefined
            ? 0
            : Number(LOC.toDecoderMicroseconds(locProperties.timestamp, locProperties.timescale));

        // 復号の出力で TIMESTAMP の種類と位置を引くために、再生の入口へ記録する
        // (pushAudio が使う)。位置は relay の cache から追いつく途中かどうかの判定に使う。
        // 入力の遅れは、復号が足している遅れ (出力の遅れ - 入力の遅れ) を受信側の追いつきへ
        // 渡すのに使う。
        // TIMESTAMP を持たない音は decoder へ 0 を渡すため、同じ TIMESTAMP の音がすべて
        // 重なり、種類も位置も一意に引けない。それでも呼ぶのは、入口が種類 "none" の記録で
        // 同じ TIMESTAMP に残った古い記録を消すためである (古い記録が残ると、次の復号の
        // 出力が前の音の位置を引いてしまう)
        mediaPlayoutRef.current?.trackAudioDecodeInput(timestamp, {
          timestampKind,
          location: { group: obj.groupId, object: obj.objectId },
          inputLagMs,
          // 復号へ渡すまで実際に保持した時間 (遅延の変更や上限超過の短縮も含む)
          intentionalDelayMs: Math.max(0, performance.now() - receivedAtMs),
        });

        // 復号へ渡した音の通し番号を採番する。停止の flush で流した音は、復号の出力が
        // 届くまで drain の待ちに残る (採番は復号へ渡す直前に同期で行う)
        audioStopRef.current.noteAudioDecode(flushed);
        audioDecoderInstance.decode(
          obj.payload,
          "key",
          timestampKind === "none" ? null : timestamp,
          0,
        );
        current.audioChunksDecoded.value += 1;
      } catch (error) {
        // LOC properties の復号失敗など、この object だけの問題は次で回復し得るため
        // decoder は構成済みのままにする
        console.error(`[${subscriberId}] failed to decode audio object:`, error);
        current.decodeErrors.value += 1;
      }
    };

    // 到着順にデコードする。映像とは独立したチェーンにすることで、映像のデコード待ちが
    // 音声の到着を遅らせないようにする。datagram で届いた Object も同じチェーンへ流す
    // (同じ Track の音声は 1 本の順序で扱う。draft-ietf-moq-transport-22 §11)
    const enqueueAudioDecodeDirect = (
      obj: MoqtObject,
      viaDatagram: boolean,
      receivedAtMs: number,
      flushed = false,
    ): void => {
      audioChainRef.current = audioChainRef.current
        // 到着順に処理する。`await` することで、次の Object の処理を待たせる
        // (復号へ渡す順序が入れ替わらないようにする)
        .then(async () => {
          // 同じ Object の 2 回目は捨てる (配信側の冗長化。src/createMediaSubscriber.ts と同じ)。
          // 保留キューからの再投入と同じ Object が 2 度通るため、受信の入口でだけ判定する
          const objectId = `${obj.groupId.toString()}:${obj.objectId.toString()}`;
          if (recentAudioObjectIdSet.has(objectId)) {
            // 2 回目以降の copy を捨てた。配信側の冗長度が経路上で効いているかを
            // 読めるよう、捨てた数を数える
            const current = getCurrentAudioSubscriber(audioDecoderInstance);
            if (current !== null) {
              current.duplicateObjectsDropped.value += 1;
            }
            return;
          }
          recentAudioObjectIdSet.add(objectId);
          recentAudioObjectIds.push(objectId);
          if (recentAudioObjectIds.length > AUDIO_RECENT_OBJECT_IDS_MAX) {
            const oldest = recentAudioObjectIds.shift();
            if (oldest !== undefined) {
              recentAudioObjectIdSet.delete(oldest);
            }
          }
          await handleAudioObject(obj, viaDatagram, receivedAtMs, flushed);
        })
        .catch((error: unknown) => {
          // handleAudioObject は内部で握るため、ここへ来るのは想定外の失敗だけ
          console.error(`[${subscriberId}] audio object chain failed:`, error);
        });
    };

    // 復号前の段から音声を復号チェーンへ流す。購読の開始時に設定し、停止時に
    // 破棄する。動的な遅延の変更にも使う
    appendAudioPreDecodeRef.current = (items) => {
      // flush の間は、ここから積む Object に印を付ける (drain の完了判定で使う)
      const flushed = capturingAudioFlushRef.current;
      for (const item of items) {
        enqueueAudioDecodeDirect(item.object, item.viaDatagram, item.receivedAtMs, flushed);
      }
    };

    const queueAudioObject = (obj: MoqtObject, viaDatagram: boolean): void => {
      // 停止の処理が始まった後に届いた Object は積まない。復号前の段や復号へ渡すと、
      // drain が終わった後に予約が増え、閉じた AudioContext への予約になる
      if (audioStopRef.current.isStopping) {
        return;
      }
      // 到着時刻は復号前の遅延を挟んでも失わないよう、受信の入口で 1 回だけ測る
      const receivedAtMs = performance.now();
      // 順序逆転の計器を、受信の入口で更新する。復号は到着順のままなので、ここで
      // 観測しないと逆順に届いたことを後段からは分けられない
      const currentAudioSubscriber = getCurrentAudioSubscriber(audioDecoderInstance);
      if (currentAudioSubscriber !== null) {
        observeAudioReceiveLocation(currentAudioSubscriber, {
          group: obj.groupId,
          object: obj.objectId,
        });
      }
      // メインスレッドの停止と、その間に待たされた到着の重なりを数える。到着の時刻は
      // ここで測った値を使う (復号前の遅延を挟んだ後の時刻ではない)
      hostDelayTrackerRef.current.recordArrival(receivedAtMs);
      const delay = preDecodeDelayRef.current;
      if (delay === null || !delay.pushAudio({ object: obj, viaDatagram, receivedAtMs })) {
        enqueueAudioDecodeDirect(obj, viaDatagram, receivedAtMs);
      }
    };

    const audioSubscriberInstance = await session.subscribe(
      namespaceArray,
      audioTrack.name,
      {
        object: (obj: MoqtObject) => {
          queueAudioObject(obj, false);
        },
        // datagram callback を登録しないと、datagram で届いた Object は object callback へ
        // フォールバックする (src/session/incoming.ts)。経路を数えるために登録し、
        // Subgroup と同じ処理へ流す。登録した場合 datagram はこちらにだけ届く
        datagram: (obj: MoqtObject) => {
          queueAudioObject(obj, true);
        },
        end: (publishDone) => {
          // PUBLISH_DONE はトラック単位の購読の終了であり、後始末はしない (handleTrackEnd を参照)
          handleTrackEnd(
            instance,
            "audio",
            publishDone,
            { video: videoCatchUpGateRef.current, audio: audioCatchUpGateRef.current },
            isCurrentAttempt,
          );
        },
        error: (error) => {
          addLog("error", `[${subscriberId}] audio subscribe error`, {
            message: error instanceof Error ? error.message : String(error),
          });
          trackCallbacks?.error(error);
        },
      },
      {
        // draft-ietf-moq-transport-22 §9.20.6 (RENDEZVOUS TIMEOUT):
        // 映像と同じく、publisher が現れるまで relay に購読を保持させる
        rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
        // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track には SETUP に載せたトークンを
        // SUBSCRIBE にも MUST 付与する (SETUP に載せていても免除されない)
        ...subscribeAuthorizationTokenOptions(audioTrack, session.setupAuthorizationToken),
      },
    );

    // subscribe の await 中に停止された場合、ローカル参照は instance に未代入のため
    // 中断元から見えない。ここで unsubscribe して購読を残さない
    if (
      checkAborted(signal, () => {
        void audioSubscriberInstance.unsubscribe().catch(() => {});
      })
    ) {
      return;
    }

    instance.audioSubscriber.value = audioSubscriberInstance;
    // SUBSCRIBE_OK の LARGEST_OBJECT を、音声トラックで relay の cache から追いつく途中か
    // どうかの境界にする。この位置以前の音声 Object は復号しても鳴らさない
    const audioLargestLocation = audioSubscriberInstance.largestLocation;
    audioCatchUpGateRef.current.setBoundary(audioLargestLocation ?? null);
    // 順序逆転の計器にも同じ境界を使う。これ以下の位置は relay の cache から replay された
    // Object であり、順序逆転ではない。境界が決まるまでは cache と live を区別できないため、
    // ここから数え始める
    audioReceiveOrder.markBoundary(audioLargestLocation ?? null);
    if (audioLargestLocation !== undefined && audioLargestLocation !== null) {
      addLog("info", `[${subscriberId}] audio catch up boundary set`, {
        groupId: audioLargestLocation.group.toString(),
        objectId: audioLargestLocation.object.toString(),
      });
    }
    refreshCatchUpPending(instance);
    addLog("info", `[${subscriberId}] subscribed audio track`, {
      trackName: audioTrack.name,
      codec: audioTrack.codec,
      // Catalog の宣言値と、実際に AudioContext と復号器へ使う解決値の両方を残す
      // (opus は Catalog が 44100 でも復号が 48 kHz を返すため、値が異なる)
      sampleRate: catalogSampleRate,
      audioContextSampleRate: sampleRate,
      channels,
    });
  }

  /**
   * 映像トラックの無い catalog で、音声トラックだけを購読する
   *
   * 音声トラックの購読の確立で、購読が確立したとみなす (isStarting を下ろす)。音声の
   * 購読の失敗は、購読の失敗として呼び出し元へ投げる (映像と音声の購読のように、
   * 音声を諦めて続ける対象が無い)。音声トラックの終わりは `handleTrackEnd` が扱い、
   * `trackCallbacks` にはエラーだけを伝える。
   *
   * 映像の時間軸は作らないが、音声の jitter buffer と受信側の追いつきは使う。同期の推定
   * (A/V) は映像が無いため出さない (statistics は `resetSubscriberStats` が既定値に
   * 戻す)
   */
  async function subscribeAudioOnly(
    session: Session,
    namespaceArray: string[],
    audioTrack: CatalogTrack,
    instance: sub.SubscriberInstance,
    signal: AbortSignal,
    trackCallbacks: TrackErrorCallbacks,
  ): Promise<void> {
    // 映像を購読しない経路でも、停止した購読のコールバックが次の購読に触らないよう同じ判定を使う
    const isCurrentAttempt = createAttemptGuard(abortControllerRef, signal);
    instance.statusMessage.value = "Preparing audio decoder...";
    resetSubscriberStats(instance);
    // 映像は購読しないが、音声の jitter buffer と受信側の追いつきは使う。時間軸を作らないと
    // 到着と出力時計の観測、および予約の統計を得られない。音声だけの待ちは 50 ms にする。
    // 同期の推定 (A/V) は映像が無いため出さない。音声の Track だけでも targetLatency は
    // 宣言され得る (draft-ietf-moq-msf-01 §5.2.8)
    const audioOnlyJitterBufferEnabled = settings.jitterBufferEnabled.value;
    createSubscriberMediaPlayout({
      // 揃える相手の映像がいないため、映像の表示の組み立ては含めない
      video: false,
      jitterBuffer: audioOnlyJitterBufferEnabled,
      targetLatencyMs: effectiveTargetLatencyMs(audioTrack),
    });
    await startAudioSubscription(
      session,
      namespaceArray,
      audioTrack,
      instance,
      signal,
      isCurrentAttempt,
      trackCallbacks,
    );
    // startAudioSubscription 内の checkAborted は関数内で return するだけなので、
    // 中断後もここへ来る。teardownSubscriber が確定させた表示を上書きしない
    if (signal.aborted) return;
    instance.isStarting.value = false;
    // 音声トラックの購読が確立した (トラックの一覧は Catalog パネルが出す)
    applySubscribedStatus(instance);
  }

  /**
   * 対象の音声 decoder が現在の購読のものかを確認し、現在のインスタンスを返す
   *
   * 停止・削除・再購読のあとに残ったハンドラが、古いインスタンスの signal を
   * 書き換えたり閉じた decoder を触ったりしないようにするための世代判定。
   */
  function getCurrentAudioSubscriber(
    audioDecoderInstance: AudioDecoderWrapper,
  ): sub.SubscriberInstance | null {
    const current = sub.getSubscriber(subscriberId);
    if (!current || current.audioDecoder.value !== audioDecoderInstance) {
      return null;
    }
    return current;
  }

  /**
   * relay の cache から届いた音声 Object を鳴らさずに捨てるかを決める
   *
   * 境界以前の位置の音は、復号したが鳴らさない。戻り値が true のときは鳴らす (live か、
   * 位置を覚えていない音)。境界を越えたかどうかは、再生が無効のときも画面へ伝える。
   */
  function admitPlayAudio(instance: sub.SubscriberInstance, location: Location): boolean {
    const decision = audioCatchUpGateRef.current.evaluate(location);
    if (decision.live) {
      if (decision.boundaryReached) {
        // 境界を越えた最初の音。ここから live の音を鳴らす
        addLog("info", `[${subscriberId}] catch up complete, playing live audio objects`, {
          groupId: location.group.toString(),
          objectId: location.object.toString(),
          skippedObjects: instance.audioCatchUpObjectsSkipped.value,
        });
        refreshCatchUpPending(instance);
      }
      return true;
    }
    return false;
  }

  /**
   * 復号した AudioData を可視化し、必要なら再生する
   *
   * 所有者はこの decode ハンドラであり、読み出しを終えた後に 1 回だけ `close()` する。
   * 可視化の読み出しも `close()` の前に済ませる。
   */
  function handleAudioDecoded(
    audioData: AudioData,
    audioDecoderInstance: AudioDecoderWrapper,
  ): void {
    // 復号の出力が 1 つ届いた。通し番号を投入順に取り出して、停止の flush の待ちから
    // 外す (待ちの判定は捨てる判定より先に行う)
    audioStopRef.current.noteAudioDecoded();
    const instance = getCurrentAudioSubscriber(audioDecoderInstance);
    if (instance === null) {
      audioData.close();
      return;
    }

    try {
      // 可視化用の読み出しは close() の前に済ませる (所有者はこのハンドラ)。
      // 再生の有無に関わらずレベルと波形を更新する。左右のチャンネルは別々に求める
      const maxSamples = waveformSampleCount(audioData.sampleRate);
      const samplesLeft = readAudioSamples(audioData);
      const levelLeft = summarizeAudioLevel(samplesLeft);
      instance.audioPeakDbfsLeft.value = levelLeft.peakDbfs;
      instance.audioRmsDbfsLeft.value = levelLeft.rmsDbfs;
      instance.audioWaveformLeft.value = appendWaveform(
        instance.audioWaveformLeft.value,
        samplesLeft,
        maxSamples,
      );
      if (audioData.numberOfChannels > 1) {
        const samplesRight = readAudioSamples(audioData, 1);
        const levelRight = summarizeAudioLevel(samplesRight);
        instance.audioPeakDbfsRight.value = levelRight.peakDbfs;
        instance.audioRmsDbfsRight.value = levelRight.rmsDbfs;
        instance.audioWaveformRight.value = appendWaveform(
          instance.audioWaveformRight.value,
          samplesRight,
          maxSamples,
        );
      } else {
        // モノラルのときは右チャンネルを出さない (メーターの右は「-」のまま)
        instance.audioPeakDbfsRight.value = null;
        instance.audioRmsDbfsRight.value = null;
        instance.audioWaveformRight.value = null;
      }
    } catch (error) {
      // 計測に失敗しても再生は試みる (原因の切り分けができるよう別のメッセージにする)
      console.error(`[${subscriberId}] failed to measure decoded audio data:`, error);
    }

    try {
      // 到着 (復号の出力を受け取った) 時刻。鳴らさなかった音の記録に使う
      const arrivalMs = nowMs();

      const playout = mediaPlayoutRef.current;
      if (playout === null) {
        // 購読していないときは復号の出力も届かない。念のため閉じるだけにする
        return;
      }

      // 復号へ渡した入力の記録から TIMESTAMP の種類と位置を引く。relay の cache から届いた
      // 音は鳴らさない (復号は続ける。Audio Config はどの Object にも載りうるため、cache の
      // 分の復号を飛ばすと適用を落とすことがある)。再生が無効なときも判定し、追いついた
      // ことを画面の「Catching up」へ伝える。位置が分からない音は鳴らす側に倒す。
      // 時間軸への記録・目標の決定・予約・計器への記録は再生の入口が行う
      const result = playout.pushAudio(audioData);

      if (result.status === "notAdmitted") {
        // 鳴らす先が無いときは入口が skipped を返すため、ここへ来る音には再生の対象がある。
        // 追いつきの途中で鳴らさなかった音は、画面の再生が有効なときだけ数える
        if (instance.audioPlaybackEnabled.value) {
          instance.audioCatchUpObjectsSkipped.value += 1;
          // 追いつきの途中で鳴らさなかった音も、鳴らなかった量として数える
          audioPlayoutTimingRef.current.recordMiss({
            atMs: arrivalMs,
            reason: "catchUp",
            durationMs: (audioData.numberOfFrames / audioData.sampleRate) * 1_000,
            targetMs: null,
            arrivalMs: null,
          });
        }
        return;
      }
      if (result.status === "skipped") {
        // 音声を再生していない。時間軸へも計器へも記録していない
        return;
      }

      // 捨てた音と基準を取り直した回数を画面の統計へ反映する (計器への記録は入口が済ませる)
      if (result.status === "dropped") {
        instance.audioPlayoutDrops.value += 1;
      }
      // 音を加工した量 (時間圧縮と補間) は、再生の入口の統計を 500 ms の反映
      // (startAudioPlayoutTiming) で写す。音声の出力 1 つごとには読まない
      if (result.rebased) {
        instance.audioPlayoutRebases.value += 1;
      }
      if (result.catchUpStarted) {
        // 受信側の追いつきを始めた。復号器に溜まった古い音は、鳴らさずに捨てるだけでは
        // 減らないため、復号器を作り直して捨てる (src/playout/audioReceiveCatchUp.ts)
        void resetAudioDecoderForCatchUp(audioDecoderInstance, instance);
      }
      if (result.status === "error") {
        console.error(`[${subscriberId}] failed to play audio data:`, result.error);
      }
    } catch (error) {
      // 再生の入口は鳴らす準備の失敗を結果で返す。ここへ来るのは、その前後の想定外の失敗
      // だけである (以前と同じくログに残し、AudioData は閉じる)
      console.error(`[${subscriberId}] failed to play audio data:`, error);
    } finally {
      audioData.close();
    }
  }

  /**
   * 受信側の音声の追いつきのために、音声の復号器を作り直す
   *
   * 復号器の中に溜まった古い音は実時間と同じ速さでしか出てこないため、鳴らさずに捨てる
   * だけでは live へ戻らない。詳しい根拠と実測は src/playout/audioReceiveCatchUp.ts が持つ。
   * 作り直しの失敗は、復号の失敗としてログに残す (この後も復号は続くため、購読そのものは
   * 止めない)
   *
   * @param audioDecoderInstance - 作り直す復号器
   * @param instance - 失敗を数える購読の統計
   */
  async function resetAudioDecoderForCatchUp(
    audioDecoderInstance: AudioDecoderWrapper,
    instance: sub.SubscriberInstance,
  ): Promise<void> {
    try {
      // 復号器の reset は未処理の投入と未到着の出力を捨てる。通し番号の対応と drain の
      // flush の待ちをそのままにすると、以後の対応がずれて drain が早く終わる
      audioStopRef.current.discardFlushedOutputs();
      await audioDecoderInstance.reset();
    } catch (error) {
      console.error(`[${subscriberId}] failed to reset audio decoder for catch-up:`, error);
      instance.decodeErrors.value += 1;
    }
  }

  /**
   * relay の cache から届いた映像フレームを描かずに捨てるかを決める
   *
   * 境界以前の位置のフレームは、参照のために復号したが描かない。戻り値が true のときは描く
   * (live か、位置を覚えていないフレーム)。
   */
  function admitPresentFrame(instance: sub.SubscriberInstance, location: Location): boolean {
    const decision = videoCatchUpGateRef.current.evaluate(location);
    if (decision.live) {
      if (decision.boundaryReached) {
        // 境界を越えた最初のフレーム。ここから live の表示になる
        addLog("info", `[${subscriberId}] catch up complete, presenting live video frames`, {
          groupId: location.group.toString(),
          objectId: location.object.toString(),
          skippedFrames: instance.catchUpFramesSkipped.value,
        });
        refreshCatchUpPending(instance);
      }
      return true;
    }
    return false;
  }

  /**
   * 復号済みフレームを、ライブラリが提供する再生の入口へ渡す
   *
   * jitter buffer が有効で、フレームの TIMESTAMP が壁時計 (Timescale 無し) のときは、
   * TIMESTAMP の間隔どおりの表示時刻に表示し、到着の揺らぎを吸収する
   * (src/playout/buffer.ts)。表示待ちのキュー、表示時刻に合わせた選択、あふれた分と
   * 間に合わなかった分の計器への記録、表示周期の予約は再生の入口 (MediaPlayout) が持つ。
   *
   * jitter buffer が無効のとき、または TIMESTAMP を壁時計として使えないフレームは、
   * 届いた順に 1 周期に 1 枚ずつ表示する。
   *
   * 表示は表示周期に 1 枚に絞る (入口へ渡す pacing)。これをしないと 2 つの問題が起きる。
   * - 120 fps の映像では 1 周期に複数枚の復号が完了し、すべて描画すると表示周期
   *   より多く描くことになってかくつく
   * - cache replay の追い上げ中は復号が表示より速いため、すべて描画すると早送りに
   *   見える
   *
   * relay の cache から届いたフレーム (SUBSCRIBE_OK の LARGEST_OBJECT 以前の位置) は、
   * 位置を入口の admit へ渡して描かない (入口が閉じる)。復号はしているため参照は壊れない
   * (src/catchUpGate.ts)。描かなかったフレームはここで数える。
   */
  const presentFrame = (frame: VideoFrame): void => {
    const instance = sub.getSubscriber(subscriberId);
    const playout = mediaPlayoutRef.current;
    if (instance === undefined || playout === null) {
      // 購読が終わっている。描く先が無いため閉じる
      frame.close();
      return;
    }
    // 表示時刻の決定 (jitter buffer が有効なときだけ壁時計の TIMESTAMP を使う)、時間軸への
    // 記録、表示待ちのキューへの積み込み、表示周期の予約、位置を比べた選別は入口が行う
    const result = playout.pushVideo(frame);
    if (result.status === "notAdmitted") {
      // 描かなかったフレームも数える (境界を越えたときのログと画面が読む)
      instance.catchUpFramesSkipped.value += 1;
    }
  };

  /**
   * フレームを canvas に描く
   *
   * 表示の実績 (同期ずれの推定に使う) の記録は、入口 (MediaPlayout) が描いた結果を
   * 受けて行う。
   *
   * @param presentationMs - jitter buffer の表示時刻。表示時刻を決めずに描くときは null
   * @returns 実際に描いたか。描けなかったときは false (表示の実績として記録しない)
   */
  const drawFrame = (frame: VideoFrame, presentationMs: number | null): boolean => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      frame.close();
      return false;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn(`[${subscriberId}] drawFrame: canvas is null`);
      frame.close();
      return false;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn(`[${subscriberId}] drawFrame: failed to get 2d context`);
      frame.close();
      return false;
    }

    // 大きなフレームは上限幅まで縮めて描く (表示は CSS で拡縮される)
    const scale = Math.min(1, MAX_CANVAS_WIDTH / frame.displayWidth);
    const width = Math.max(1, Math.round(frame.displayWidth * scale));
    const height = Math.max(1, Math.round(frame.displayHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.drawImage(frame, 0, 0, width, height);
    const stall = playoutTimingRef.current.recordDisplay(
      performance.now(),
      frame.timestamp,
      presentationMs,
    );
    frame.close();
    if (stall !== null) {
      // 止まりを原因と一緒にログへ残す (ログの時刻で relay のログと突き合わせる)
      addLog("warn", `[${subscriberId}] display stall`, {
        cause: stall.cause,
        durationMs: Math.round(stall.durationMs),
        groupId: stall.groupId,
        objectId: stall.objectId,
        mediaStepMs: Math.round(stall.mediaStepMs),
      });
    }

    instance.framesDecoded.value += 1;
    return true;
  };

  const handleObject = async (received: ReceivedVideoObject): Promise<void> => {
    const obj = received.object;
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    const decoderInstance = instance.decoder.value;
    if (!decoderInstance) {
      console.warn(`[${subscriberId}] handleObject: decoder is null`);
      return;
    }

    instance.objectsReceived.value += 1;
    instance.bytesReceived.value += obj.payload.length + (obj.properties?.length ?? 0);
    instance.currentGroup.value = Number(obj.groupId);
    instance.currentSubGroup.value = Number(obj.subgroupId ?? 0n);
    instance.decoderState.value = decoderInstance.state;

    // 止まりの原因のために記録するフレームの TIMESTAMP (TIMESTAMP が無い Object では null)
    let timelineTimestamp: number | null = null;
    // 復号せずに捨てたことを記録する
    const recordDiscarded = (): void => {
      if (timelineTimestamp !== null) {
        playoutTimingRef.current.recordDiscarded(timelineTimestamp);
      }
    };

    try {
      // LOC Properties からメタデータを取得
      if (obj.properties && obj.properties.length > 0) {
        instance.objectsWithExtensions.value += 1;
      }
      const plan = buildVideoChunkPlan(instance.subscriber.value?.trackProperties, obj);

      // 保留から出た時刻を記録する (到着は object コールバックで記録済み)
      if (plan.timestampKind !== "none") {
        timelineTimestamp = plan.timestamp;
        playoutTimingRef.current.recordObjectReleased(plan.timestamp, performance.now());
      }

      // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
      const chunk = new EncodedVideoChunk({
        type: plan.type,
        timestamp: plan.timestamp,
        data: obj.payload,
      });

      instance.chunksCreated.value += 1;

      if (!instance.decoderConfigured.value) {
        instance.chunksSkipped.value += 1;
        recordDiscarded();
        return;
      }

      if (decoderInstance.state !== "configured") {
        console.warn(
          `[${subscriberId}] handleObject: decoder not in configured state:`,
          decoderInstance.state,
        );
        instance.decoderState.value = decoderInstance.state;
        instance.chunksSkipped.value += 1;
        recordDiscarded();
        return;
      }

      // draft-ietf-moq-transport-22 Section 2.1: Object は順不同で届きうる。Group ごとに
      // 別の stream で届くため、前の Group の末尾が次の Group の先頭より後に届くことが
      // ある。参照するフレームを復号していない Object は decoder へ渡さない
      const admission = videoDecodeOrderRef.current.admit({
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyFrame: plan.type === "key",
        priorObjectIdGap: priorObjectIdGapOf(obj.properties),
      });
      if (!admission.decode) {
        if (admission.reason === "stale") {
          instance.staleFramesDropped.value += 1;
        } else {
          instance.missingReferenceFramesDropped.value += 1;
        }
        recordDiscarded();
        return;
      }

      if (plan.type === "key") {
        instance.keyFramesDecoded.value += 1;
      }

      playoutTimingRef.current.recordDecodeStart(performance.now(), plan.timestamp);
      // 復号の出力で TIMESTAMP の種類と位置を引くために、再生の入口へ記録する
      // (presentFrame の pushVideo が使う)。位置は relay の cache から追いつく途中かどうかの
      // 判定に使う
      mediaPlayoutRef.current?.trackVideoDecodeInput(plan.timestamp, {
        timestampKind: plan.timestampKind,
        location: { group: obj.groupId, object: obj.objectId },
      });
      decoderInstance.decode(chunk);
      instance.chunksDecoded.value += 1;
    } catch (error) {
      console.error(`[${subscriberId}] handleObject: failed to decode object:`, error);
      instance.decodeErrors.value += 1;
      recordDiscarded();
    }
  };

  // 再生遅延の変更を、今の購読の復号前の段へ即座に反映する。
  // 購読していないときは何もしない (次の購読の開始時に現在の設定で段を作る)。遅延を 0 に
  // したときの flush が handleObject を参照するため、この effect は handleObject の定義後に置く
  useSignalEffect(() => {
    applyPreDecodeDelay(settings.preDecodeDelayMs.value);
  });

  // このインスタンスの status / statusMessage を上書きしてよいかを判定する。
  // 判定そのものは canApplyStatusUpdate に置く (setTimeout のコールバックなど、
  // getSubscriber を通さない経路からも同じ判定を使うため)。
  const shouldApplyStatusUpdate = (): boolean => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return false;
    return canApplyStatusUpdate(instance);
  };

  const startSubscribing = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;
    // 停止処理中のときは新規開始しない (二重実行防止)
    if (instance.isStopping.value) return;

    // 古い controller が残っていれば abort してから新規生成する。
    // isStopping は二重実行防止、AbortController は中断シグナルで責務が異なるため両方残す。
    // ローカル signal 経由で参照し、teardownSubscriber が abortControllerRef.current = null
    // した後も abort 状態を判定できるようにする。
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    // この回の購読が今の購読か。この回が登録するコールバックは、今の購読の間だけ
    // 表示を変えて後始末する (停止した購読のコールバックが次の購読を止めないようにする)
    const isCurrentAttempt = createAttemptGuard(abortControllerRef, signal);
    // 購読するトラック (映像があれば映像、無ければ音声) のエラーの扱い。
    // 終わり (PUBLISH_DONE) は handleTrackEnd が扱う
    const trackCallbacks: TrackErrorCallbacks = {
      error: (error) => {
        if (!isCurrentAttempt()) return;
        if (shouldApplyStatusUpdate()) {
          instance.status.value = "error";
          instance.statusMessage.value = `Subscribe error: ${error.message}`;
        }
      },
    };
    // 購読するトラック (映像があれば映像、無ければ音声) の購読が確立するか後始末を終えるまで、
    // 購読中として扱う (Stop で止められ、Start Subscribing を重ねて押せない。接続設定の入力も
    // 無効のまま保つ)
    instance.isStarting.value = true;
    // 前の購読の追いつきの状態を持ち越さない (境界は各 Track の SUBSCRIBE_OK で設定する)
    resetCatchUpGates();
    // 現在の設定で復号前の段を作る。前の購読の段とタイマーはここで破棄する
    initializePreDecodeDelay();

    try {
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Connecting...";
      instance.httpVersion.value = null;
      settings.settingsDisabled.value = true;

      // 接続先・Namespace・接続オプションを決める。選んだ候補はこの購読のパネルに出す
      const { connectUrl, namespaceArray, connectOptions } = resolveSubscriberConnectSettings(
        subscriberId,
        instance,
      );

      // 接続先が決まっていることを確かめる (MOQT URI 欄は候補の表示欄で、手入力は無い)
      assertConnectUrl(connectUrl, instance.candidateSelection.value);

      // MOQT サーバへ接続する
      const session = await connect(
        connectUrl,
        {
          close: (closeInfo) => {
            // shouldApplyStatusUpdate のガード外で addLog を呼び、stop 主導時にも
            // DebugPanel にイベントを残す。reason は 1024 文字に切って UI 描画負荷を抑える。
            addLog("warn", `[${subscriberId}] webtransport closed`, {
              closeCode: closeInfo.closeCode,
              // WebTransportCloseInfo.reason は optional のため未指定時は空文字にする
              reason: (closeInfo.reason ?? "").slice(0, 1024),
            });
            // 停止した購読の session の close は、close の完了 (relay との往復) の後に
            // 届くため、次の購読を始めた後に届くことがある。この回が今の購読でなければ、
            // 表示も後始末も触らない (次の購読を中断しない)
            if (!isCurrentAttempt()) return;
            // stop 主導中・cleanup 後の遅延発火では status / statusMessage を上書きしない。
            // 今の購読の session が閉じたときは、進んでいる処理を中断するため後始末する。
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "disconnected";
              instance.statusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            }
            teardownSubscriber();
          },
          error: (error) => {
            addLog("error", `[${subscriberId}] webtransport error`, {
              name: error.name ?? "Error",
              message: error.message ?? String(error),
            });
            // close と同じく、停止した購読の session のエラーは次の購読に触らない
            if (!isCurrentAttempt()) return;
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "error";
              instance.statusMessage.value = `Error: ${error.message}`;
            }
            teardownSubscriber();
          },
          debug: (msg) => handleDebugMessage(subscriberId, msg),
        },
        connectOptions,
      );
      // connect 解決前の close 発火は session 自体が未存在のため、ここでの cleanup は
      // await 中に他経路 (stopSubscribing / アンマウント) で teardownSubscriber が呼ばれた場合に限る。
      // 中断元から見えない (instance.session.value 未代入) ので、ローカル session の close は
      // startSubscribing 側の責務。
      if (
        checkAborted(signal, () => {
          session.close().catch(() => {});
        })
      ) {
        return;
      }
      instance.session.value = session;
      instance.httpVersion.value = resolvePanelHttpVersion(
        session.reliability,
        browserIsChromium(),
      );

      // status は subscribe 完了時にのみ "connected" へ遷移する。
      // Catalog 購読中 (最大 5 秒) の途中で "connected" にしないこと。
      instance.statusMessage.value = "Connected, subscribing to catalog...";

      // Catalog を購読して、購読する映像トラックと音声トラックを取り出す
      let tracksFromCatalog: CatalogMediaTracks;

      try {
        // draft-ietf-moq-transport-22 に準拠した Catalog 購読:
        // 1. Next Object (Location Filter Type 0x05) の Location Filter で SUBSCRIBE し、
        //    live の Catalog 更新を受信
        // 2. 独立した FETCH (フィルタなし) で過去の Catalog を取得
        // FETCH が INVALID_RANGE で失敗する場合 (Catalog 未 publish) は
        // live の SUBSCRIBE 経由で Catalog が届くのを待つ
        const catalogPromise = new Promise<Catalog>((resolve, reject) => {
          // SUBSCRIBE と FETCH は独立したリクエストであり、古いフルカタログが
          // live の新しいフルカタログより後に届く可能性がある。instance.catalog を
          // 巻き戻さないよう、適用済みの最大 Location を保持して単調性を保証する。
          // (createMediaSubscriber の filterPendingCatalogObjects と異なり、ここでは
          // 複数リクエスト間の「適用順序の単調性」だけを保証する。full catalog の
          // 置換は冪等のため、重複オブジェクトの除去は不要)
          let lastCatalogLocation: { group: bigint; object: bigint } | null = null;
          // Catalog オブジェクトを処理する共通関数
          const processCatalogObject = (obj: MoqtObject, source: string) => {
            try {
              const message = decodeCatalogMessage(obj.payload);
              // draft-ietf-moq-msf-01 §5.1.6 wire format で deltaUpdate が array 形式の場合は
              // CatalogDelta を返す。devtools subscriber は現在 full catalog のみ処理する
              // (delta apply は createMediaSubscriber 同様、別 issue 対応)。
              if (!("version" in message)) {
                addLog(
                  "info",
                  `[${subscriberId}] [RECV] CatalogDelta (skipped, delta apply not supported)`,
                  {
                    source,
                  },
                );
                return;
              }
              const catalog = message;
              const location: { group: bigint; object: bigint } = {
                group: obj.groupId,
                object: obj.objectId,
              };
              if (
                lastCatalogLocation !== null &&
                (location.group < lastCatalogLocation.group ||
                  (location.group === lastCatalogLocation.group &&
                    location.object <= lastCatalogLocation.object))
              ) {
                addLog("info", `[${subscriberId}] stale or duplicate catalog object skipped`, {
                  source,
                });
                return;
              }
              lastCatalogLocation = location;
              // RECV OBJECT 自体は addLog 経由で残るのでここで重複ログは出さない。
              addLog(
                "info",
                `[${subscriberId}] [RECV] OBJECT (${formatFullTrackName(namespaceArray, CATALOG_TRACK_NAME)})`,
                {
                  source,
                  catalog,
                },
              );
              instance.catalog.value = catalog;
              // 購読するトラックは最初に届いた catalog から決める (後の catalog では解決済み)
              resolve(catalog);
            } catch (error) {
              addLog("error", `[${subscriberId}] failed to decode catalog`, {
                message: error instanceof Error ? error.message : String(error),
              });
              reject(error);
            }
          };

          // Catalog 未 publish 等の FETCH 失敗は live 待ちへフォールバックする
          const onCatalogFetchFailed = (error: unknown): void => {
            addLog("warn", `[${subscriberId}] catalog fetch failed`, {
              message: error instanceof Error ? error.message : String(error),
            });
          };

          // SUBSCRIBE 確立後の処理。
          // startSubscribing 側で signal.aborted を見て return した後に
          // マイクロタスクで .then が回り catalogSubscriber.value が再代入される
          // レースをここで潰す。
          // promise を .then のコールバック内で生成すると promise/no-nesting に
          // 抵触するため、チェーンからは参照渡しで分離する。
          const handleCatalogSubscribed = async (
            catalogSubscriberInstance: Subscriber,
          ): Promise<void> => {
            if (signal.aborted) {
              await catalogSubscriberInstance.unsubscribe().catch(() => {});
              return;
            }
            instance.catalogSubscriber.value = catalogSubscriberInstance;

            // 過去の Catalog を FETCH で取得する。要求範囲は SUBSCRIBE_OK の
            // LARGEST_OBJECT が示す Group の先頭 Object から Largest Object まで
            // とする (catalogFetchFilter を参照)。SUBSCRIBE_OK 受信後に FETCH を
            // 送ることで、Next Object の Largest (L1) が FETCH 処理時の
            // Largest (L2) 以下になることを保証し、(L2, L1] の取りこぼしを防ぐ
            // (createMediaSubscriber と同じ順序)。
            //
            // フィルタ無し ({0, 0} 起点) で要求すると、catalog の Group ID が
            // Unix epoch ミリ秒から始まる publisher では relay の object cache が
            // 覆えず、上流へ転送される。上流の publisher が FETCH に応答しない
            // 場合、後から参加した購読者は catalog を得られない。
            // catalogFetchFilter は LARGEST_OBJECT が不明 / Group 0 のときも
            // 絶対位置 {0, 0} の Location Filter を返すため、LOCATION FILTER を
            // 省略した FETCH は送らない (省略した FETCH は応答が返らないことがある)
            const fetchFilter = catalogFetchFilter(catalogSubscriberInstance.largestLocation);
            await session
              .fetch(
                namespaceArray,
                CATALOG_TRACK_NAME,
                {
                  filter: fetchFilter,
                  // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは FETCH にも
                  // MUST 付与する。catalog の authInfo は catalog を受信するまで分からない
                  // ため、SETUP に載せたトークン (MOQT URI の c4m を含む) をそのまま使う
                  ...(session.setupAuthorizationToken === undefined
                    ? {}
                    : { authorizationToken: session.setupAuthorizationToken }),
                },
                {
                  object: (obj: MoqtObject) => {
                    // FETCH から受信した Catalog オブジェクト
                    processCatalogObject(obj, "fetch");
                  },
                  end: () => {
                    addLog("info", `[${subscriberId}] catalog fetch completed`, {
                      trackName: CATALOG_TRACK_NAME,
                    });
                  },
                  error: (error) => {
                    onCatalogFetchFailed(error);
                  },
                },
              )
              .catch(onCatalogFetchFailed);
          };

          void session
            .subscribe(
              namespaceArray,
              CATALOG_TRACK_NAME,
              {
                object: (obj: MoqtObject) => {
                  // SUBSCRIBE のデータストリームから受信した Catalog オブジェクト
                  processCatalogObject(obj, "subscribe");
                },
                end: (publishDone) => {
                  logPublishDoneEnd(subscriberId, "catalog stream ended", publishDone);
                  // 変更前はエラー status で error コールバックが reject していた。新しい通知では
                  // 終了が end に来るため、同じ扱いをここで行う (FETCH で catalog を取れる場合も、
                  // 購読の確立そのものが失敗しているため待たない)
                  const failure = resolvePublishDoneError(publishDone);
                  if (failure !== null) {
                    reject(failure);
                  }
                },
                error: (error) => {
                  addLog("error", `[${subscriberId}] catalog subscribe error`, {
                    message: error instanceof Error ? error.message : String(error),
                  });
                  reject(error);
                },
              },
              {
                // Next Object (Location Filter Type 0x05) の
                // Location Filter で SUBSCRIBE する。live の Catalog 更新は
                // この SUBSCRIBE で受信し、過去の Catalog は FETCH で取得する
                filter: { nextObject: true },
                // draft-ietf-moq-transport-22 §9.20.6 (RENDEZVOUS TIMEOUT):
                // publisher がまだ居ない場合は relay がこの時間だけ購読を保持し、
                // publisher が現れたら SUBSCRIBE_OK を返す。配信開始前に視聴を
                // 始められるようにするため、Catalog Timeout と同じ値を使う
                rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
                // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは SUBSCRIBE にも
                // MUST 付与する。catalog の authInfo は catalog を受信するまで分からないため、
                // SETUP に載せたトークン (MOQT URI の msf fragment の c4m を含む) をそのまま使う
                ...(session.setupAuthorizationToken === undefined
                  ? {}
                  : { authorizationToken: session.setupAuthorizationToken }),
              },
            )
            .then(handleCatalogSubscribed)
            .catch(reject);
        });

        // Catalog 取得をタイムアウト付きで待機
        const catalogTimeout = settings.catalogSubscriptionTimeout.value;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<Catalog>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`catalog subscription did not complete within ${catalogTimeout}ms`));
          }, catalogTimeout);
        });

        let receivedCatalog: Catalog;
        try {
          receivedCatalog = await Promise.race([catalogPromise, timeoutPromise]);
        } finally {
          // catalog 取得成功時もタイマーを解放する。タイムアウト発火後の
          // clearTimeout は無害。
          clearTimeout(timeoutId);
        }

        tracksFromCatalog = resolveCatalogMediaTracks(receivedCatalog);
        addLog("info", `[${subscriberId}] using codec from catalog`, {
          video: tracksFromCatalog.video?.codec ?? null,
          audio: tracksFromCatalog.audio?.codec ?? null,
        });
      } catch (error) {
        // 元のエラーを cause に保持し、スタックトレースを失わないようにする
        throw new Error(`failed to get catalog: ${(error as Error).message}`, {
          cause: error,
        });
      }

      // Catalog 取得経路は finally で clearTimeout 済みのため追加 cleanup は不要。
      // .then 内側で catalogSubscriber の遅延代入レースは解消済み。
      if (checkAborted(signal, () => {})) return;

      // event timeline トラックがあれば購読する。映像 / 音声の購読を待たせないよう、
      // 確立は待たずに進める (startEventSubscriptionIfAdvertised)
      startEventSubscriptionIfAdvertised(session, namespaceArray, instance, signal);

      // 映像トラックの無い catalog では、映像の decoder と購読を作らず音声だけを購読する
      if (tracksFromCatalog.video === undefined) {
        await subscribeAudioOnly(
          session,
          namespaceArray,
          tracksFromCatalog.audio,
          instance,
          signal,
          trackCallbacks,
        );
        return;
      }
      const videoTrackFromCatalog = tracksFromCatalog.video;
      const actualTrackName = videoTrackFromCatalog.name;

      instance.statusMessage.value = "Preparing decoder...";

      // デコーダーのエラー後に再初期化する。再初期化できなかった場合は、受信のたびに
      // Worker と VideoDecoder を作り直し続けないよう購読を止める。error コールバックは
      // 同期のため、reset() の結果はこの非同期関数の中で await して見る
      const restartDecoderAfterError = async (error: Error): Promise<void> => {
        // 停止した購読では再初期化しない。reset() の configure は await の後に Worker と
        // VideoDecoder を作るため、停止と重なると誰も破棄しないものが残る
        if (signal.aborted) {
          return;
        }
        const restarted = await decoderInstance.reset();
        // 停止した購読の結果で表示と後始末を上書きしない (停止後は reset() が打ち切りで
        // false を返しても、購読は既に teardownSubscriber が終えている)
        if (signal.aborted) {
          return;
        }
        if (restarted) {
          // 復号器を作り直すと参照フレームを失うため、キーフレーム待ちへ戻す。
          // 位置は保ち、復旧中に遅着した古い Group や Object を再び復号しない。
          // 定期間隔が長い配信で自然な次の Group を待つと、映像が数秒間止まる。
          videoDecodeOrderRef.current.requireKeyFrame();
          // draft-ietf-moq-transport-22 §9.20.19: DYNAMIC_GROUPS=1 を広告する Track に限り、
          // REQUEST_UPDATE で新しい Group を要求できる。仕様はドラフトであり変更され得る。
          // 要求は復号器の再構成後に送り、届いたキーフレームを再構成中に捨てないようにする。
          const activeSubscriber = instance.subscriber.value;
          if (activeSubscriber && supportsDynamicGroups(activeSubscriber.trackProperties)) {
            await requestNewGroup();
          }
          return;
        }
        // 再初期化しなかった理由 (予算切れ / 設定無し / close 済み / 対応確認の失敗 /
        // 構成の失敗) は reset() が警告に出している。表示は startSubscribing の外側の
        // catch と同じ形にし、同じ後始末を行う
        instance.status.value = "error";
        instance.statusMessage.value = `Failed: decoder restart failed: ${error.message}`;
        teardownSubscriber();
      };

      const decoderInstance = new DecoderWrapper(settings.useDedicatedWorker.value, {
        output: ({ frame }) => {
          playoutTimingRef.current.recordDecodeOutput(performance.now(), frame.timestamp);
          presentFrame(frame);
        },
        error: (error) => {
          if (signal.aborted) return;
          console.error(`[${subscriberId}] Decoder error:`, error);
          instance.decodeErrors.value += 1;
          // Console だけでなくコピーするログにも残し、長い表示停止と復号失敗を照合できるようにする。
          const location = instance.subscriber.value?.largestReceivedLocation;
          addLog("error", `[${subscriberId}] video decoder error`, {
            message: error.message,
            groupId: location?.group.toString() ?? null,
            objectId: location?.object.toString() ?? null,
          });
          // デコーダーをリセットして次のキーフレームを待つ
          void restartDecoderAfterError(error);
        },
      });

      // デコーダを Catalog から取得した videoTrack で設定する。
      // draft-ietf-moq-msf-01 §5.2.13 (initRef) → §5.1.7 (initDataList) 経路で initData
      // を解決するため、現在保持している catalog signal を渡す。
      const catalogValue = instance.catalog.value;
      if (!catalogValue) {
        throw new Error("catalog is not available when building VideoDecoderConfig");
      }
      const decoderConfig = buildVideoDecoderConfig(videoTrackFromCatalog, catalogValue);
      const codecDisplay = `${videoTrackFromCatalog.codec} ${videoTrackFromCatalog.width}x${videoTrackFromCatalog.height}`;

      // decoder は構成が終わる前でも instance に載せる。configure() の await 中に
      // パネルが削除されると removeSubscriber が instance.decoder を見るが、未代入だと
      // 何も破棄せず、teardownSubscriber も Map から消えた instance では早期 return する
      // ため中断もされない。configure が解決すると Worker と VideoDecoder が残る。
      // 先に載せておけば closeSubscriberResources が instance.decoder 経由で破棄できる。
      // 構成前の受信は handleObject が decoderConfigured で止め、decode() も configured が
      // false の間 early return するため、復号の挙動は変わらない
      instance.decoder.value = decoderInstance;

      await decoderInstance.configure(decoderConfig);
      // 構成した decoder はキーフレームから復号を始める
      videoDecodeOrderRef.current.reset();

      // configure await 中に中断された場合、中断元の teardownSubscriber も
      // instance.decoder 経由で close する。configure が解決してから中断された場合は
      // ここで閉じる。DecoderWrapper.close は同期メソッドで冪等、例外を投げない。
      if (
        checkAborted(signal, () => {
          decoderInstance.close();
        })
      ) {
        return;
      }

      instance.decoderConfigured.value = true;
      instance.decoderState.value = decoderInstance.state;
      instance.codec.value = codecDisplay;

      const newGroupRequestEnabled = instance.newGroupRequestEnabled.value;

      instance.status.value = "connected";
      instance.statusMessage.value = "Subscribing...";
      resetSubscriberStats(instance);
      // 購読する音声と映像のトラックから targetLatency を解決して時間軸へ渡す
      startPlayoutTiming(tracksFromCatalog);
      resetVideoGroupGate();

      // Subscriber オプションを構築する
      const subscribeOptions: {
        newGroupRequest?: bigint;
        rendezvousTimeout?: bigint;
        authorizationToken?: AuthorizationToken;
      } = {
        // draft-ietf-moq-transport-22 §9.20.6 (RENDEZVOUS TIMEOUT):
        // Catalog が広告する映像トラックは Catalog の到着直後にはまだ publish
        // されていないことがある。relay に購読を保持させる
        rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
        // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track には SETUP に載せたトークンを
        // SUBSCRIBE にも MUST 付与する (SETUP に載せていても免除されない)
        ...subscribeAuthorizationTokenOptions(
          videoTrackFromCatalog,
          session.setupAuthorizationToken,
        ),
      };

      // NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
      // draft-ietf-moq-transport-22 §9.20.19: SUBSCRIBE では MAY (foreknowledge 不要、
      // サポート外なら publisher が無視する) ため、DYNAMIC_GROUPS 確認は不要。
      // REQUEST_UPDATE 経路の requestNewGroup では DYNAMIC_GROUPS=1 を確認する。
      if (newGroupRequestEnabled) {
        subscribeOptions.newGroupRequest = 0n;
      }

      const subscriberInstance = await session.subscribe(
        namespaceArray,
        actualTrackName,
        {
          object: (obj: MoqtObject) => {
            // stream の間の到着順は保証されない (draft-ietf-moq-transport-22 Section 2.1)。
            // 前の Group の stream が開いている間は次の Group の Object を保留し
            // (videoGroupGateRef)、前の Group の Object を先に Promise チェーンへ積む。
            // handleObject は Group の順序と欠落を見て、復号してよい Object だけを decoder へ
            // 渡す (VideoDecodeOrder)。保留の上限を過ぎてから届いた前の Group の Object は
            // 捨てる。1 Group を複数の Subgroup に分ける publisher の Object ID の飛びも
            // 欠落として扱い、次のキーフレームまで待つ
            // 受け取った時刻で到着を記録し、時刻を Object と一緒に保留へ渡す
            const received: ReceivedVideoObject = { object: obj, receivedAtMs: performance.now() };
            // TIMESTAMP の種類は Track の TIMESCALE でも変わるため、Track Properties も渡す
            // (SUBSCRIBE_OK の到着前に届いた Object では Object の Properties だけで判定する)
            recordVideoReceived(
              playoutTimingRef.current,
              received,
              performance.timeOrigin,
              instance.subscriber.value?.trackProperties,
            );
            enqueueVideoObjects(
              videoGroupGateRef.current.push(
                received,
                obj.groupId,
                obj.subgroupId,
                received.receivedAtMs,
              ),
            );
          },
          // Subgroup の stream の終わりで、保留していた次の Group の Object を渡す
          subgroupEnd: (end) => {
            // stream の終わり方を記録する。RESET_STREAM は relay が Group の途中で配信を
            // やめたことを示すため、ログにも残す (ログの時刻で relay のログと突き合わせる)
            playoutTimingRef.current.recordSubgroupEnd(
              end.groupId,
              end.subgroupId,
              end.reason,
              end.errorCode ?? null,
              performance.now(),
            );
            if (end.reason === "reset") {
              addLog("warn", `[${subscriberId}] subgroup stream reset`, {
                groupId: end.groupId.toString(),
                subgroupId: end.subgroupId?.toString() ?? null,
                errorCode: formatStreamResetCode(end.errorCode ?? null),
              });
            }
            enqueueVideoObjects(
              videoGroupGateRef.current.endSubgroup(end.groupId, end.subgroupId, performance.now()),
            );
          },
          end: (publishDone) => {
            // PUBLISH_DONE はトラック単位の購読の終了であり、後始末はしない (handleTrackEnd を参照)
            handleTrackEnd(
              instance,
              "video",
              publishDone,
              { video: videoCatchUpGateRef.current, audio: audioCatchUpGateRef.current },
              isCurrentAttempt,
            );
          },
          error: (error) => {
            console.error(`[${subscriberId}] Subscriber error:`, error);
            trackCallbacks.error(error);
          },
        },
        subscribeOptions,
      );

      // subscribe await 中に中断された場合、ローカル subscriberInstance は instance に未代入のため
      // 中断元から見えない。fire-and-forget で unsubscribe する。
      // unsubscribe は state === "closed" でも例外を投げず early return する。
      if (
        checkAborted(signal, () => {
          void subscriberInstance.unsubscribe().catch(() => {});
        })
      ) {
        return;
      }

      const largestLocation = subscriberInstance.largestLocation;

      instance.subscriber.value = subscriberInstance;
      instance.isStarting.value = false;
      // SUBSCRIBE_OK の Track Properties に DYNAMIC_GROUPS=1 が含まれているかを
      // 1 回だけ確定させる。trackProperties は signal ではないため computed では
      // 追跡できず、ここで書き込んで UI ボタンの disable と連動させる。
      instance.dynamicGroupsSupported.value = supportsDynamicGroups(
        subscriberInstance.trackProperties,
      );
      // 映像トラックの購読が確立した (音声はこの後で購読する)
      applySubscribedStatus(instance);
      instance.largestLocation.value = largestLocation ?? null;
      // SUBSCRIBE_OK の LARGEST_OBJECT を、relay の cache から追いつく途中かどうかの境界に
      // する。この位置以前のフレームは復号しても描かない (src/catchUpGate.ts)
      videoCatchUpGateRef.current.setBoundary(largestLocation ?? null);
      if (largestLocation !== undefined && largestLocation !== null) {
        addLog("info", `[${subscriberId}] video catch up boundary set`, {
          groupId: largestLocation.group.toString(),
          objectId: largestLocation.object.toString(),
        });
      }
      refreshCatchUpPending(instance);

      // 音声トラックを購読する
      //
      // catalog に音声トラックが無い publisher (映像だけを広告する実装) では
      // 音声の購読を開始せず、警告を出して映像だけを継続する。音声側の準備に
      // 失敗した場合も映像の視聴は妨げない (相互運用の実測では映像だけでも意味がある)
      const audioTrackFromCatalog = tracksFromCatalog.audio;
      if (audioTrackFromCatalog === undefined) {
        addLog("warn", `[${subscriberId}] no audio track in catalog, continuing with video only`);
        return;
      }

      try {
        instance.statusMessage.value = "Preparing audio decoder...";
        await startAudioSubscription(
          session,
          namespaceArray,
          audioTrackFromCatalog,
          instance,
          signal,
          isCurrentAttempt,
        );
        // startAudioSubscription 内の checkAborted は関数内で return するだけなので、
        // 中断後もここへ来る。teardownSubscriber が確定させた表示を上書きしない
        if (signal.aborted) return;
        // 映像と音声の両方が確立した
        applySubscribedStatus(instance);
      } catch (error) {
        // 中断時は teardownSubscriber が status / statusMessage を確定済み。
        // 映像経路と同じく上書きしない
        if (signal.aborted) return;
        addLog("error", `[${subscriberId}] failed to start audio subscription`, {
          message: error instanceof Error ? error.message : String(error),
        });
        // 中間メッセージを残さず、購読が確立した表示に戻す
        applySubscribedStatus(instance);
      }
    } catch (error) {
      // 中断時は teardownSubscriber が status / statusMessage / settingsDisabled を確定済み。
      // 通常エラーの上書きを避けるため、catch 句先頭で abort を判定して早期 return する。
      if (signal.aborted) return;
      console.error(`[${subscriberId}] Connection error:`, error);
      instance.status.value = "error";
      instance.statusMessage.value = `Failed: ${(error as Error).message}`;
      // teardownSubscriber 内の resetSubscriberState が settingsDisabled 再有効化判定を含むため
      // 重複した再有効化処理は不要。
      teardownSubscriber();
    }
  };

  const stopSubscribing = async (): Promise<void> => {
    // 二重実行防止
    const instance = sub.getSubscriber(subscriberId);
    if (!instance || instance.isStopping.value) {
      return;
    }
    instance.isStopping.value = true;
    // 進行中の startSubscribing を unsubscribe() 完了を待たずに中断する。
    // controller の null 化は teardownSubscriber 側で行う。
    abortControllerRef.current?.abort();
    instance.status.value = "disconnected";
    instance.statusMessage.value = "Disconnecting...";

    try {
      // 購読しているトラック (映像があれば映像、無ければ音声) の購読の解除を待つ。
      // 映像と音声の購読の音声トラックは、後始末 (closeSubscriberResources) で解除する
      const subscriberInstance = instance.subscriber.value ?? instance.audioSubscriber.value;
      if (subscriberInstance && subscriberInstance.state === "active") {
        await subscriberInstance.unsubscribe();
      }
    } finally {
      // 予約済みの音声を鳴らし切ってから後始末する。drain の間は停止中であることを
      // status に出し、ボタンは isStopping で無効のままにする
      instance.statusMessage.value = SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE;
      await getAudioPlaybackController().stopAudioPlayback();
      teardownSubscriber();
      instance.isStopping.value = false;
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Ready to subscribe";
    }
  };

  // 外部接続を含むランタイム状態を全て巻き戻し、再 startSubscribing 可能な初期状態に戻す。
  // close 系 (closeSubscriberResources) と signal リセット系 (resetSubscriberState) を
  // 順に呼ぶ orchestrator。SubscriberInstance を Map から削除しない (= 同じ id で再 setup 可能)。
  const teardownSubscriber = (): void => {
    // 停止の drain の間に入口が作り直されても、作り直した入口を触らないよう参照を固定する
    const stoppingPlayout = mediaPlayoutRef.current;
    // 表示待ちのフレームと復号へ渡した映像入力の対応表はすぐに捨てる。teardown 後に古い
    // フレームを描画しない
    stoppingPlayout?.clearVideoQueue();
    // 受信から表示までの時間の統計の記録を止める
    stopPlayoutTiming();
    // Group の切り替えで保留していた映像 Object を捨てる
    resetVideoGroupGate();
    // 追いつきの境界を消し、画面の「Catching up」も消す
    resetCatchUpGates();
    // 音声を drain してから AudioContext を閉じる。復号前の段の保持分の flush は
    // 音声の再生のライフサイクル (audioPlaybackController) の停止が行うため、段を破棄する
    // より先に呼ぶ。await できない経路 (パネルの削除、アンマウント、セッションの close 通知)
    // なので fire-and-forget にし、AudioContext はこの停止が必ず閉じる
    //
    // 入口の状態 (時間軸・復号へ渡した入力の対応表・表示待ち) は、drain が終わってから
    // 捨てる。drain の前に捨てると、復号前の段から flush した音を鳴らし切るための時間軸の
    // 状態が、鳴らし切る前に消える。計器の累積は購読の統計として残す
    const clearStoppedPlayout = (): void => {
      stoppingPlayout?.clearAll();
      // 停止の drain の間に入口が作り直されていなければ、再生の入口を無い状態に戻す。
      // 戻さないと、停止後に遅れて届いた復号の出力が `playout === null` のガードを通らず、
      // 停止した入口を触ってしまう (作り直されていたら、その入口は触らない)。
      // 判定は playoutToKeepAfterStop が持つ
      mediaPlayoutRef.current = playoutToKeepAfterStop(mediaPlayoutRef.current, stoppingPlayout);
    };
    void getAudioPlaybackController()
      .stopAudioPlayback()
      .then(clearStoppedPlayout, clearStoppedPlayout);
    // 復号前の段とタイマーを破棄する (flush 済み。停止後に復号へ流さない)
    resetPreDecodeDelay();
    // 切り捨てられた分 (予約済みで鳴らなかった音) まで反映してから止める
    stopAudioPlayoutTiming();

    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    // 進行中の startSubscribing を中断する。AbortController.abort は冪等で例外を投げない。
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    closeSubscriberResources(instance, canvasRef.current);
    resetSubscriberState(instance, { video: chainRef, audio: audioChainRef });
  };

  /**
   * REQUEST_UPDATE で NEW_GROUP_REQUEST を送り、publisher へ新しい Group の開始を要求する
   *
   * MOQT にはキーフレームの要求というメッセージは無い。新しい Group の開始を要求し、
   * 映像なら Group の先頭がキーフレームになることでキーフレームが届く
   * (draft-ietf-moq-transport-22 §9.20.19)。
   *
   * @returns REQUEST_UPDATE を送れたら true。購読していない、DYNAMIC_GROUPS=1 が無い、
   *   送信に失敗した場合は false
   */
  const requestNewGroup = async (): Promise<boolean> => {
    const instance = sub.getSubscriber(subscriberId);
    const subscriberInstance = instance?.subscriber.value;
    if (!subscriberInstance || subscriberInstance.state !== "active") {
      console.warn(`[${subscriberId}] requestNewGroup: subscriber not active`);
      return false;
    }

    // draft-ietf-moq-transport-22 §9.20.19:
    // "A subscriber MUST NOT send this parameter in
    //  REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS
    //  Property with value 1."
    // UI ボタンは disable 済みのため通常は通らないが、状態の古いボタン押下に
    // 対する保険として早期 return する。
    if (!supportsDynamicGroups(subscriberInstance.trackProperties)) {
      console.warn(
        `[${subscriberId}] requestNewGroup: track did not include DYNAMIC_GROUPS=1, skipped`,
      );
      return false;
    }

    try {
      // NEW_GROUP_REQUEST パラメータを含む REQUEST_UPDATE を送信
      // draft-ietf-moq-transport-22 §9.20.19 (NEW_GROUP_REQUEST = 0x32)。
      // 値は購読者が知る最大 Group ID + 1 とする。LARGEST_OBJECT の snapshot だけでなく
      // 購読で受信した Object の最大 Location も使う。値が Largest Group 以下だと relay は
      // 上流へ送らず、publisher も新しい Group を始めない (要求が無言で捨てられる)
      const newGroupRequest = resolveNewGroupRequestValue(
        subscriberInstance.largestReceivedLocation,
        subscriberInstance.largestLocation,
      );
      await subscriberInstance.update({ newGroupRequest });
      // REQUEST_UPDATE は認可トークンを載せうるため payload をログに残さない
      // (utils/debugMessageLog.ts)。送った値を残さないと、要求が届いたかを画面から
      // 判断できない
      addLog("info", `[${subscriberId}] requested new group`, {
        newGroupRequest: newGroupRequest.toString(),
      });
      return true;
    } catch (error) {
      console.error(`[${subscriberId}] requestNewGroup: failed`, error);
      return false;
    }
  };

  // アンマウント時のリソース解放 (HMR 等の想定外経路向けの補助)
  useEffect(() => {
    return () => {
      teardownSubscriber();
    };
  }, []);

  /**
   * 受信した音声を再生するかどうかを切り替える (UI から呼ぶ)
   *
   * 音声の再生のライフサイクルは初回の呼び出しで作る (描画の間に ref を触らないため)
   */
  const toggleAudioPlayback = (): Promise<void> =>
    getAudioPlaybackController().toggleAudioPlayback();

  return {
    startSubscribing,
    stopSubscribing,
    requestNewGroup,
    toggleAudioPlayback,
  };
}
