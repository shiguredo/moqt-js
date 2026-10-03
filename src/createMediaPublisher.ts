/**
 * 高レベル MediaPublisher API
 *
 * MediaStream を使用した簡単なメディア配信機能を提供する
 */

import { connectMediaSession, type MediaConnectSettings } from "./createMedia/connect";
import type { PublishOptions, Session } from "./session";
import { isErrorNotifiedByPublisher, type Publisher, type SendObjectParams } from "./publisher";
import * as LOC from "./loc";
import { WallClockMapper } from "./mediaClock";
import {
  CATALOG_TRACK_NAME,
  catalogAuthInfoForSetupToken,
  createCatalog,
  createInitialGroupId,
  encodeCatalog,
  type Catalog,
  type CatalogTrack,
} from "./msf";
import { AudioEncoderWrapper } from "./codec/AudioEncoder";
import type { AudioEncodedChunkData } from "./codec/types";
import { VideoEncoderWrapper } from "./codec/VideoEncoder";
import { DEFAULT_KEYFRAME_INTERVAL_SECONDS } from "./codec/config";
import {
  resolveAudioPublishSettings,
  resolveVideoPublishSettings,
  type ResolvedAudioPublishSettings,
  type ResolvedVideoPublishSettings,
} from "./createMedia/settings";
import type {
  AudioPublishOptions,
  AudioStats,
  MediaPublisher,
  MediaPublisherCallbacks,
  MediaPublisherOptions,
  MediaPublisherState,
  MediaStats,
  VideoPublishOptions,
  VideoStats,
} from "./codec/types";
import {
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type VideoFrameSource,
} from "./frameSource";

// デフォルト設定

// Publisher Priority (docs/HIGH_LEVEL_API.md の Priority 表に記載)
// draft-ietf-moq-transport-22 §5.1.1: 0-255 の符号無し整数で、数値が小さいほど
// 高優先である (最高優先は 0)。単体テストから値を固定するため export する
// (パッケージ公開 API には含めない)。

/** カタログ Object の優先度 (届かないと購読が始まらないため最高優先) */
export const PRIORITY_CATALOG = 0;

/** 映像キーフレームの優先度 (後続フレームのデコードに必須のため最高優先。カタログと同じ 0) */
export const PRIORITY_VIDEO_KEY = 0;

/** 音声オブジェクトの優先度 (音声は途切れると違和感が大きいためデルタフレームより高優先) */
export const PRIORITY_AUDIO = 64;

/** 映像デルタフレームの優先度 (破棄されても次のキーフレームで回復可能。draft-ietf-moq-transport-22 §10.4 の既定と同じ) */
export const PRIORITY_VIDEO_DELTA = 128;

// 同一プロセス内で割り当てた初期 Group ID の最大値
// (draft-ietf-moq-msf-01 §6.1: 再起動時の開始 Group ID は
// 同一 track の過去の全 Group ID を上回らなければならない)
// 音声・映像の両 track で共有し、安全側 (大きめ) に倒す。
let lastAllocatedInitialGroupId = 0;

/**
 * 初期 Group ID を割り当てる (MSF 生成に単調ガードを付けた Publisher 側の割当て)
 *
 * draft-ietf-moq-msf-01 §6.1 に基づき `createInitialGroupId` (Unix epoch
 * ミリ秒起点) を使う。`Date.now()` は `MAX_SAFE_INTEGER` に収まるため
 * Publisher 側の `number` 型に変換する。同一プロセス内の前回値を
 * 下回らないよう前回 + 1 との最大値を取る。プロセス跨ぎは壁時計に委ねる。
 * `candidate` は有限数のみ受け付け、非有限値は拒否する。
 *
 * 単体テストから固定値で駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export function allocateInitialGroupId(candidate = Number(createInitialGroupId())): number {
  if (!Number.isFinite(candidate)) {
    throw new Error(`initial group id candidate must be finite, got ${candidate}`);
  }
  const next = Math.max(candidate, lastAllocatedInitialGroupId + 1);
  lastAllocatedInitialGroupId = next;
  return next;
}

// グループ管理・キーフレーム判定
//
// 送信側の Group ID / Object ID の払い出しと、キーフレームのタイミング判定を
// 状態を持たない関数に切り出したもの。MediaPublisherImpl は状態を保持して
// これらを呼ぶだけになる。
// 単体テストから固定値で駆動するため export する (パッケージ公開 API には含めない)。

/** 音声の Group / Object 管理状態 */
export interface AudioGroupState {
  /** 現在の Group ID */
  groupId: number;
  /** Group を開始済みか (初回フレームは Group を進めない) */
  started: boolean;
}

/** 映像の Group / Object 管理状態 */
export interface VideoGroupState {
  /** 現在の Group ID */
  groupId: number;
  /** 次に送る Object ID */
  objectId: number;
  /** Group を開始済みか (初回のキーフレームは Group を進めない) */
  started: boolean;
}

/** Group / Object の払い出し結果 */
export interface GroupObjectAllocation<State> {
  /** 次のフレームへ引き継ぐ状態 */
  state: State;
  /** このオブジェクトを送る Group ID */
  groupId: number;
  /** このオブジェクトの Object ID */
  objectId: number;
  /** 新しい Group を開始したか (送信済み最大 Group ID の追跡に使う) */
  groupAdvanced: boolean;
}

/**
 * 音声フレーム 1 件分の Group / Object を払い出す純関数
 *
 * LOC draft-ietf-moq-loc-04 §4.1 (Application with one audio track) は、音声 chunk
 * 1 つを Object 1 つ・Group 1 つに対応させ、GroupID を chunk ごとに増やして
 * ObjectID を 0 にする例を示している。本関数はその例に従い、フレームごとに新しい
 * Group を開始して Object ID を常に 0 にする。初回フレームは割当済みの初期 Group ID
 * をそのまま使う (映像と同じ規則)。Group を進めたかを返し、呼び出し側が送信済みの
 * 最大 Group ID を追跡できるようにする (draft-ietf-moq-msf-01 §6.1)。
 *
 * この節番号・規則は draft 由来であり将来の draft 改版で変わる可能性がある。
 *
 * @param state - 現在の Group / Object 管理状態
 * @returns 払い出した Group ID / Object ID と次の状態
 */
export function allocateAudioObject(
  state: AudioGroupState,
): GroupObjectAllocation<AudioGroupState> {
  // 初回フレームは Group を進めず、2 回目以降はフレームごとに Group を進める
  const groupAdvanced = state.started;
  const groupId = groupAdvanced ? state.groupId + 1 : state.groupId;
  return {
    state: { groupId, started: true },
    groupId,
    objectId: 0,
    groupAdvanced,
  };
}

/**
 * 映像フレーム 1 件分の Group / Object を払い出す純関数
 *
 * キーフレームで新しい Group を開始し、Object ID を 0 に戻す。初回のキーフレームは
 * 割当て済みの初期 Group ID をそのまま使う (初回オブジェクトは加算せず初期値を送る)。
 * 実運用経路は初回をキーフレームで要求するため、差分フレームが先行した場合の初回
 * キーフレームは初期値 + 1 になる。Group を進めたかを返し、呼び出し側が送信済みの
 * 最大 Group ID を追跡できるようにする (draft-ietf-moq-msf-01 §6.1)。
 *
 * @param state - 現在の Group / Object 管理状態
 * @param isKeyFrame - 送信するフレームがキーフレームか
 * @returns 払い出した Group ID / Object ID と次の状態
 */
export function allocateVideoObject(
  state: VideoGroupState,
  isKeyFrame: boolean,
): GroupObjectAllocation<VideoGroupState> {
  const groupAdvanced = isKeyFrame && state.started;
  const groupId = groupAdvanced ? state.groupId + 1 : state.groupId;
  const objectId = isKeyFrame ? 0 : state.objectId;
  return {
    // 差分フレームでも「Group を開始済み」にする (以降のキーフレームで Group を進める)
    state: { groupId, objectId: objectId + 1, started: true },
    groupId,
    objectId,
    groupAdvanced,
  };
}

/**
 * 映像のキーフレーム間隔 (秒) を解決する純関数
 *
 * `keyframeInterval` は秒で指定する。0 より大きい有限数のみ受理する。フレーム数では
 * なく時間で指定するのは、フレーム数の間隔が framerate に依存するためである
 * (30 fps の 300 フレームは 10 秒だが、60 fps では 5 秒になる)。判定はフレームの
 * timestamp の差で行うため、実際のフレームレートが設定とずれても指定した秒数を守る。
 *
 * 0 に特別な意味を持たせる根拠が MSF / LOC / WebCodecs に無い (draft-ietf-moq-msf-01
 * §5.2.24 の `maxGopDuration` はミリ秒指定の別概念であり、WebCodecs の `keyFrame: false`
 * はキーフレームにするかを UA に委ねる意味である) ため、0 を「毎フレームキーフレーム」と
 * 解釈すると帯域を大きく浪費する。
 *
 * `keyframeInterval` 未指定時は `DEFAULT_KEYFRAME_INTERVAL_SECONDS` (2 秒) を使う。
 * 節番号は draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある。
 *
 * @param video - 映像配信オプション (映像を配信しない場合は undefined)
 * @returns キーフレームを送る間隔 (秒。0 より大きい有限数)
 */
export function resolveKeyframeInterval(video: VideoPublishOptions | undefined): number {
  const specifiedInterval = video?.keyframeInterval;
  if (specifiedInterval !== undefined) {
    if (!Number.isFinite(specifiedInterval) || specifiedInterval <= 0) {
      throw new Error(
        `keyframeInterval must be a finite number of seconds > 0, got ${specifiedInterval}`,
      );
    }
    return specifiedInterval;
  }

  return DEFAULT_KEYFRAME_INTERVAL_SECONDS;
}

/**
 * 映像トラックの PUBLISH の設定
 *
 * draft-ietf-moq-transport-22 §10.6 (DYNAMIC GROUPS) / §9.20.19 (NEW GROUP REQUEST Parameter):
 * DYNAMIC_GROUPS=1 を広告し、購読者が NEW_GROUP_REQUEST で新しい Group を要求できるように
 * する。後から視聴を始めた購読者は Group の先頭 (キーフレーム) を受け取るまで映像を出せない
 * ため、要求を受けたら次に encode するフレームをキーフレームにして新しい Group を始める
 * (`PublishCallbacks.onNewGroupRequest` から `requestKeyframe()` を呼ぶ)。
 */
export const VIDEO_PUBLISH_OPTIONS: Readonly<PublishOptions> = { dynamicGroups: true };

/**
 * 映像フレームがキーフレームのタイミングかを判定する純関数
 *
 * 直前のキーフレームからの経過時間が間隔以上ならキーフレームにする。先頭のフレーム
 * (直前のキーフレームが無い) と、timestamp が巻き戻ったフレーム (映像の入力が
 * 差し替わった) もキーフレームにする。`requestKeyframe()` は直前のキーフレームの
 * timestamp を消すため、要求の後に次に encode するフレームは必ずキーフレームになる
 * (encode せず破棄したフレームは判定しないため、要求は消費されず次の encode する
 * フレームへ移る)。
 *
 * @param lastKeyFrameTimestampUs - 直前のキーフレームの timestamp (マイクロ秒)。
 *   まだキーフレームを送っていない場合は null
 * @param frameTimestampUs - 判定するフレームの timestamp (マイクロ秒)
 * @param keyframeInterval - キーフレームを送る間隔 (秒。0 より大きい有限数。値域は
 *   `resolveKeyframeInterval` が検証する)
 * @returns キーフレームのタイミングなら true
 */
export function shouldSendKeyFrame(
  lastKeyFrameTimestampUs: number | null,
  frameTimestampUs: number,
  keyframeInterval: number,
): boolean {
  if (lastKeyFrameTimestampUs === null || frameTimestampUs < lastKeyFrameTimestampUs) {
    return true;
  }
  return frameTimestampUs - lastKeyFrameTimestampUs >= keyframeInterval * 1_000_000;
}

// codec description の送出判断
//
// WebCodecs が返す description (extradata) を LOC の Video Config / Audio Config
// として送出するかの判断を、状態を持たない関数に切り出したもの。

/**
 * 2 つの codec description が同じ値かを判定する純関数
 *
 * WebCodecs の `EncodedVideoChunkMetadata` / `EncodedAudioChunkMetadata` の
 * `decoderConfig.description` (LOC の Video Config / Audio Config の元になる
 * extradata) は、configure 直後を除いて同じ値が繰り返し渡る。変化したときだけ
 * 載せるかの判断に使う。
 *
 * @param previous - 直前に送った description (未送信なら null)
 * @param description - 今回の description
 * @returns 同じ値なら true
 */
function isSameCodecDescription(previous: Uint8Array | null, description: Uint8Array): boolean {
  if (previous === null || previous.length !== description.length) {
    return false;
  }
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== description[i]) {
      return false;
    }
  }
  return true;
}

/** Audio Config の送出判断の結果 */
export interface AudioConfigResolution {
  /** 今回の Object に載せる config (載せない場合は undefined) */
  config: Uint8Array | undefined;
  /** 次回のために保持する値 */
  next: Uint8Array | null;
  /** 送り直し要求を次の Object へ残すか */
  resendNext: boolean;
}

/**
 * 送信する Audio Config を解決する純関数
 *
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config): AAC の復号に必須の
 * AudioSpecificConfig は `AudioDecoderConfig.description` に対応する。Chromium の
 * `AudioEncoder` は configure 後の最初の出力の metadata にしか description を付けず
 * (実装依存であり将来変わり得る)、音声にはキーフレームが無いため、配信開始後に
 * 接続した購読者へ届けるには送り直しが要る。
 *
 * 送り直しは forwardState が 0 から 1 になった時点 (購読者の出現を
 * draft-ietf-moq-transport-22 §7.6 の REQUEST_UPDATE の FORWARD パラメータで
 * 知った時点) に要求され、保持している値を次の Object に 1 度だけ載せ直す。
 * 載せた時点で要求は解消し、保持値は消さない (消すと次の要求に応えられない)。
 * forwardState が 1 のまま購読者が接続した場合は変化が起きないため送り直されない
 * (購読者が居ない間に relay が forwardState を 0 にするかは §7.2 により relay の
 * 裁量であり、1 のまま維持する relay では 1 人目の購読者でも送り直されない)。
 * 本リポジトリの購読実装 (`createMediaSubscriber`) は同じ description では decoder を
 * 再構成しないため、この再送は自前の購読経路に対して冪等である。
 *
 * 単体テストから固定値で駆動するため export する (パッケージ公開 API には含めない)。
 *
 * @param previous - 直前に送った Audio Config (未送信なら null)
 * @param description - 今回の chunk が持つ Audio Config (opus は undefined。
 *   空の description は設定として意味を持たないため値なしとして扱う)
 * @param resendRequested - 保持している Audio Config の送り直しを要求されているか
 * @returns 今回載せる config、次回のために保持する値、送り直し要求を残すか
 */
export function resolveAudioConfigToSend(
  previous: Uint8Array | null,
  description: Uint8Array | undefined,
  resendRequested: boolean,
): AudioConfigResolution {
  // 新しい値が現れたときは、送り直し要求の有無にかかわらずそれを載せる
  if (
    description !== undefined &&
    description.length > 0 &&
    !isSameCodecDescription(previous, description)
  ) {
    return { config: description, next: new Uint8Array(description), resendNext: false };
  }
  // 送り直し要求には保持値で応える (同じ値でも 1 度だけ載せ直す)
  if (resendRequested && previous !== null) {
    return { config: previous, next: previous, resendNext: false };
  }
  // 保持値が無いまま要求された場合は、要求だけを残す (載せる値が無い)
  return { config: undefined, next: previous, resendNext: resendRequested };
}

/**
 * Catalog に載せる targetLatency / renderGroup の指定を検証する
 *
 * `JSON.stringify` は非有限値 (NaN / Infinity) を `null` に落とす。購読側の検証
 * (src/msf/catalogTrackValidation.ts) は `typeof value !== "number"` で例外にするため、
 * 自分の出力を自分で復号できない catalog を送ることになる。符号化の前に拒否して守る。
 * renderGroup の整数性は decode 側で見ないため、encode 側が整数性を守る唯一の防波堤になる。
 * 0 は targetLatency (0 ms) と renderGroup のどちらも有効値であるため、検証では弾かない。
 *
 * 単体テストと devtools から同じ検証を使うため export する
 * (パッケージ公開 API には含めない)。
 *
 * @param options - 検証する指定。未指定 (undefined) の項目は検証しない
 */
export function assertCatalogLatencyOptions(options: {
  targetLatency?: number;
  renderGroup?: number;
}): void {
  const { targetLatency, renderGroup } = options;
  if (targetLatency !== undefined && !Number.isFinite(targetLatency)) {
    throw new Error(`targetLatency must be finite, got ${targetLatency}`);
  }
  if (renderGroup !== undefined) {
    if (!Number.isFinite(renderGroup)) {
      throw new Error(`renderGroup must be finite, got ${renderGroup}`);
    }
    // decode 側は整数性を見ないため、ここが唯一の防波堤になる
    if (!Number.isInteger(renderGroup)) {
      throw new Error(`renderGroup must be an integer, got ${renderGroup}`);
    }
  }
}

/**
 * 解放が先行した start を中止するときのエラー文言
 *
 * 接続で受け取った session を閉じてから throw する経路 (connectToServer) と、
 * 各段階の await の直後の検査 (assertStartNotDisposed) で同じ文言を使う。
 */
const START_ABORTED_DISPOSED = "start aborted: resources were disposed during start";

/**
 * MediaPublisher の実装クラス
 *
 * 単体テストから処理ループを駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export class MediaPublisherImpl implements MediaPublisher {
  private currentState: MediaPublisherState = "created";
  // 進行中の close() の解放と終端遷移。同時に呼ばれた close() はこれを共有し、解放と
  // 終端通知を 1 回に保つ。解放は await を挟むため、state だけを見た単発性の判定では
  // 2 回目の close() が早期 return を通過してしまう
  private closing: Promise<void> | null = null;
  // 進行中の解放 (disposeAllResources)。利用者起点 (stop / close) とピア起点
  // (handleSessionClose) で共有し、相乗りした呼び出しにも解放の成否を伝える。解放は
  // 破棄の前に参照を切り離すため、相乗りした側が自分で解放をやり直すと「破棄するものが
  // 無い成功」になり、進行中の失敗を検知できない
  private disposalInFlight: Promise<void> | null = null;
  // 利用者起点の解放 (stop / close) の回数。ピア起点の close の解放 (handleSessionClose) が
  // 進行中に利用者が stop / close を呼んだかを、解放の前後で比較して判定する
  // (解放中は state が "publishing" などのままであるため、state では判定できない)
  private userDisposalCount = 0;
  private readonly url: string;
  private readonly options: MediaPublisherOptions;
  // Catalog とエンコーダーで同じ値を使うための解決済み設定 (start() で 1 度だけ解決する)
  private resolvedAudio: ResolvedAudioPublishSettings | null = null;
  private resolvedVideo: ResolvedVideoPublishSettings | null = null;
  private readonly callbacks: MediaPublisherCallbacks;

  // 接続関連
  private session: Session | null = null;
  // session close 通知の世代番号。解放 (disposeAllResources) のたびに進み、接続時に捕捉した
  // 値と一致しない通知は自己起点の解放によるものとして捨てる。処理ループの世代とは独立で
  // あり、pause() では進まない (進めると pause のあとのピア起点の close 通知が捨てられる)
  private sessionGeneration = 0;
  private catalogPublisher: Publisher | null = null;
  // 直前に VIDEO_CONFIG として送信した description。
  // draft-ietf-moq-loc-04 §2.3.2.1: description は keyframe でのみ encoder から渡るため、
  // 変化したときだけ載せて全 keyframe への重複送出を避ける。
  private lastSentVideoConfig: Uint8Array | null = null;
  // 直前に AUDIO_CONFIG として送った description。同じ値の重複送出を避けつつ、
  // forwardState が 1 になった時点の送り直しの材料にもする
  private lastSentAudioConfig: Uint8Array | null = null;
  // forwardState が 0 から 1 になった時点で立てる Audio Config の送り直し要求。
  // 次の Object に保持値を 1 度だけ載せ直し、載せた時点で解消する
  private audioConfigResendRequested = false;
  private audioPublisher: Publisher | null = null;
  private videoPublisher: Publisher | null = null;

  // MediaStream 関連
  private mediaStream: MediaStream | null = null;
  private audioTrackProcessor: MediaStreamTrackProcessor<AudioData> | null = null;
  private videoFrameSource: VideoFrameSource | null = null;
  private audioFrameReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  // 読んだ映像フレームの timestamp とそのときの壁時計から、映像の LOC TIMESTAMP を
  // 壁時計に換算する (mediaClock.ts)。フレームの取得元を作るたびに作り直す
  private videoWallClock = new WallClockMapper();

  // エンコーダー
  private audioEncoder: AudioEncoderWrapper | null = null;
  private videoEncoder: VideoEncoderWrapper | null = null;

  // 統計情報
  private audioStats: AudioStats = {
    framesSent: 0,
    bytesSent: 0,
    currentGroupId: 0,
  };
  private videoStats: VideoStats = {
    framesSent: 0,
    droppedFrames: 0,
    keyFramesSent: 0,
    bytesSent: 0,
    currentGroupId: 0,
  };

  // グループ/オブジェクト管理
  private audioGroupId: number;
  private videoGroupId: number;
  private videoObjectId = 0;
  // 直前のキーフレームの timestamp (マイクロ秒)。まだキーフレームを送っていない場合は
  // null。encode したフレームだけで更新し、破棄したフレームでは更新しない
  // (requestKeyframe() で null に戻す)
  private lastKeyFrameTimestampUs: number | null = null;
  // 音声・映像の初回オブジェクト送信済みか (初回は加算せず初期値を送る)
  private audioGroupStarted = false;
  private videoGroupStarted = false;

  // キーフレーム間隔
  private keyframeInterval: number;

  // 処理ループの中断フラグ
  private processingActive = false;

  // 処理ループの世代 (pause / stop / close で加算し、
  // 旧ループの encode と onError 通知を抑止する)
  private processingGeneration = 0;

  // 現在の Catalog
  private currentCatalog: Catalog | null = null;

  constructor(
    url: string,
    options: MediaPublisherOptions,
    callbacks: MediaPublisherCallbacks = {},
  ) {
    this.url = url;
    this.options = options;
    this.callbacks = callbacks;

    // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の
    // 過去の全 Group ID を上回る。新規インスタンスごとに割り当てる。
    // 同一インスタンスの stop → start は値を引き継ぐ。
    // 未使用 track 分は採番しない。
    this.audioGroupId = options.audio ? allocateInitialGroupId() : 0;
    this.videoGroupId = options.video ? allocateInitialGroupId() : 0;
    this.audioStats.currentGroupId = this.audioGroupId;
    this.videoStats.currentGroupId = this.videoGroupId;

    // キーフレーム間隔を計算
    this.keyframeInterval = resolveKeyframeInterval(options.video);
  }

  get state(): MediaPublisherState {
    return this.currentState;
  }

  private setState(newState: MediaPublisherState): void {
    this.currentState = newState;
    this.callbacks.onStateChange?.(newState);
  }

  /**
   * 配信を開始する
   *
   * 接続・Publisher の作成・エンコーダーの設定・処理ループの起動を行い "publishing" に
   * する。各段階の await の直後に解放が先行していないかを検査し、先行していれば
   * それ以上リソースを作らずに失敗する。
   * 開始の契約 (受け付ける state・失敗時の扱い・解放が先行した場合の優先) は
   * src/codec/types.ts の MediaPublisher を参照。
   */
  async start(stream: MediaStream): Promise<void> {
    // close() が解放と終端遷移を進めている間は終端へ動く途中であり、開始を重ねても
    // 途中で "closed" になる。state だけを見た判定では "created" / "stopped" のままなので
    // ここで拒否する
    if (this.closing !== null) {
      throw new Error("cannot start while closing");
    }
    // ピア起点の close の解放が進行中のときも同じである。解放が終端へ進む前に start が
    // 完了すると、そのあと state が "closed" になり、新しい start の資源を解放する経路が
    // 残らない (close() は早期 return、start() / stop() は state で拒否される)
    if (this.disposalInFlight !== null) {
      throw new Error("cannot start while closing");
    }
    if (this.currentState !== "created" && this.currentState !== "stopped") {
      throw new Error(`cannot start in state: ${this.currentState}`);
    }

    this.mediaStream = stream;

    // 実行中に解放が先行したか (ピア起点の close / 利用者の close) を判定するために
    // 捕捉する。各段階の await の直後の検査 (assertStartNotDisposed) がこの値を基準にする
    const startGeneration = this.sessionGeneration;

    // Catalog とエンコーダーが同じ設定を使うように、ここで 1 度だけ解決する
    // (トラック設定を 2 回読むと、その間に変わった値が Catalog とエンコーダーで
    //  食い違う可能性がある)
    this.resolvedAudio = this.options.audio
      ? resolveAudioPublishSettings(this.options.audio)
      : null;
    this.resolvedVideo = this.options.video
      ? resolveVideoPublishSettings(this.options.video, this.mediaStream.getVideoTracks()[0])
      : null;

    try {
      // サーバーに接続
      await this.connectToServer(startGeneration);

      // Publisher を作成
      await this.createPublishers();
      // 解放が先行していれば、これ以上リソースを作らずに失敗する。解放は mediaStream を
      // 切り離すため setupEncoders は素通りするが、解放が進行中 (切り離しの前) でも
      // ここで止める。進めると、作ったエンコーダーとフレームリーダーが巻き戻しまで残る
      this.assertStartNotDisposed(startGeneration);

      // エンコーダーを設定
      await this.setupEncoders();
      // 解放が先行していれば、ここで確保したエンコーダーを残さずに "publishing" に
      // 進まない (setupEncoders の await 中に解放された場合もここで止まる。以降に await は
      // 無く、この検査の後に state を決めるだけである)
      this.assertStartNotDisposed(startGeneration);

      // 処理ループを開始
      this.processingActive = true;
      // 直前のキーフレームの記録は配信ごとに作り直す。再 start で映像の入力が
      // 差し替わっても、最初のフレームが必ずキーフレームになる
      this.lastKeyFrameTimestampUs = null;
      this.startProcessingLoops();

      this.setState("publishing");
    } catch (error) {
      // 確保済みを逆順に巻き戻す。state は変えず再 start 可能にする。
      // 解放が先行していても、参照は既に切り離し済みでこの呼び出しは no-op になり、
      // 進行中の解放があればそちらが引き続き後始末するため、無条件に呼ぶ。
      // 巻き戻し自体の失敗で元の失敗を隠さないよう握り潰す。
      try {
        await this.disposeAllResources();
      } catch {
        // 元のエラーを優先する
      }
      // 通知の抑止 (二重通知の防止) は notifyStartFailure が担う。start() の catch まで
      // 失敗を運ぶ配線は接続の境界 (openSession) を置き換えれば node でも駆動できるため、
      // 配線を変えるときは catalog 送信の reject を catch まで運ぶテストを先に用意すること。
      this.notifyStartFailure(error);
      throw error;
    }
  }

  /**
   * 配信を一時停止する
   *
   * 世代を進めて旧ループを無効化する。 reader の cancel は行わない。
   * cancel はストリームを閉じるため、 resume 時に処理を再開できなくなる
   * (再開にはプロセッサ再構築というブラウザ専用機構が必要になる)。
   * 同一 reader への並行 read() はフレームを排他的に分配するため、
   * 旧ループの encode と onError は世代不一致で抑止される。
   * ただし旧ループ自体の終了は次フレーム到着まで遅延し、その間に取得した
   * 1 フレームは破棄される。また pause 中にキュー滞留した 2 フレーム目以降は
   * resume 後に新ループが stale フレームとして encode する。
   * フレーム到着がない間の待機は残留し、stop / close の cancel で回収される。
   */
  pause(): void {
    if (this.currentState !== "publishing") {
      throw new Error(`cannot pause in state: ${this.currentState}`);
    }

    this.processingActive = false;
    this.processingGeneration++;
    this.setState("paused");
  }

  /**
   * 配信を再開する
   *
   * 現世代のまま処理ループを起動する。 paused からのみ到達する。
   * 旧ループは次フレーム到着時に世代不一致で encode せず終了し、
   * 失敗通知も抑止されるため、 encode と onError の多重化は起きない
   * (read() 待機自体の一時的な並行は残る)。
   * reader は pause で破棄していないため再取得は不要である。
   */
  resume(): void {
    if (this.currentState !== "paused") {
      throw new Error(`cannot resume in state: ${this.currentState}`);
    }

    this.processingActive = true;
    this.startProcessingLoops();
    this.setState("publishing");
  }

  /**
   * 配信を停止する
   *
   * 処理ループの世代を進めて旧ループの encode と onError 通知を抑止し、解放は
   * disposeAllResources() が行う。ピア起点の close の解放が進行中なら runDisposal() で
   * それを共有して完了を待ち、解放のあとに "stopped" にする。解放で閉じる session の
   * close 通知は session の世代番号が一致しないため捨てられる (onClose は通知せず
   * "closed" も経由しない)。
   * 破棄の段階失敗は後続を止めず最後に最初の失敗を throw し、失敗時は旧 state のまま
   * 残るが参照は切り離し済みのため再試行できる。
   * 停止 / 再開の契約は src/codec/types.ts の MediaPublisher を参照。
   * 並行呼び出しは未対応であり直列に呼ぶこと (close() が解放と終端遷移を進めている間は
   * cannot stop while closing で拒否する)。
   */
  async stop(): Promise<void> {
    // close() が解放と終端遷移を進めている間は終端へ動く途中である。state だけを見た
    // 判定では "publishing" / "paused" のままなので、停止を重ねず終端を close() に任せる
    if (this.closing !== null) {
      throw new Error("cannot stop while closing");
    }
    if (this.currentState !== "publishing" && this.currentState !== "paused") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    // 世代を進める。 stop 後の cancel 解決と start 後の新ループが
    // 同一世代を共有しないようにする (旧ループ失敗の誤通知防止)
    this.processingGeneration++;

    // 利用者起点の解放として数える (ピア起点の close の解放と重なった場合はこちらが
    // 停止を決める)
    this.userDisposalCount++;
    // ピア起点の close の解放が進行中ならそれを共有し、その成否を受ける
    await this.runDisposal();

    // 解放中に close() が終端まで進んでいれば "stopped" に戻さない。戻すと close() の
    // 終端性が崩れ、state が "closed" でなくなるため次の close() が早期 return を通過して
    // onClose が 2 回呼ばれる。通常は closing のガード (close() が解放と終端遷移を進めて
    // いる間は cannot stop while closing) で抑えられており、この検査はそれを通過する経路が
    // 将来増えたときの保険である。await のあとに現在値を読み直すため getter の state を使う
    if (this.state !== "closed") {
      this.setState("stopped");
    }
  }

  /**
   * 次に encode するフレームをキーフレームにするよう要求する
   *
   * 直前のキーフレームの記録を消す。破棄したフレームは記録を更新しないため、
   * 要求は次に encode するフレームまで消費されない。
   */
  requestKeyframe(): void {
    if (this.currentState !== "publishing") {
      return;
    }

    // 次に encode するフレームでキーフレームを強制する
    this.lastKeyFrameTimestampUs = null;
  }

  /**
   * リソースを解放する (終端)
   *
   * stop と同じ解放を行い、以後 start 不可の終端とする。解放のあとに
   * "closed" にして onClose を通知する。解放が失敗した場合は state を変えず
   * onClose も呼ばず、元のエラーを throw する (破棄の前に参照を切り離しているため、
   * 失敗した段階はやり直されず、呼び直しが進めるのは残りの段階と終端遷移である)。
   * 進行中の解放 (stop() またはピア起点の close が始めた解放) があればそれを共有して
   * 完了を待つため、その成否がこの close() にも伝わる (解放が失敗すれば終端へ進まず、
   * 同じエラーを throw する)。
   * 同時に呼ばれた close() はこの解放と終端遷移を共有するため、解放も終端の通知
   * (onStateChange の "closed" と onClose) も 1 回だけになる。終端の遷移は冪等であり、
   * 解放をまたいで終端へ進む経路が重なっても 2 回通知しない。close() が解放と終端遷移を
   * 進めている間は start() と stop() を cannot start while closing /
   * cannot stop while closing で拒否する。
   * 終端の契約は src/codec/types.ts の MediaPublisher を参照。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  async close(): Promise<void> {
    // 進行中の解放 (close 自身 / stop / ピア起点の close) があればそれを共有する。解放は
    // await を挟むため、state だけを見た単発性の判定では同時に呼ばれた 2 回目が早期 return を
    // 通過してしまう
    if (this.closing !== null) {
      return this.closing;
    }
    if (this.currentState === "closed") {
      return;
    }

    // 世代を進める。 close 後の cancel 解決と再 start 後の新ループが
    // 同一世代を共有しないようにする (旧ループ失敗の誤通知防止)
    this.processingGeneration++;

    // 利用者起点の解放として数える (ピア起点の close の解放と重なった場合はこちらが終端を
    // 決める)
    this.userDisposalCount++;
    // 解放 (進行中ならそれを共有する) と終端遷移を 1 つの Promise にまとめ、同時に呼ばれた
    // close() と共有する。解放が成功したときだけ終端へ進む
    const closing = this.runDisposal().then(() => {
      this.transitionToClosed();
    });
    this.closing = closing;
    try {
      await closing;
    } finally {
      // 参照を残さない。解放が失敗した場合も、呼び直しが残りの段階と終端遷移を進める
      // (失敗した段階は切り離し済みのためやり直されない)
      this.closing = null;
    }
  }

  /**
   * 進行中の解放を共有して実行する
   *
   * stop / close / ピア起点の close 通知 (handleSessionClose) の解放を 1 つの Promise に
   * まとめる。解放は await を挟み、破棄の前に参照を切り離すため、相乗りした呼び出しが
   * 自分で解放をやり直すと「破棄するものが無い成功」に見え、進行中の解放が失敗しても
   * 検知できない。実行中の Promise を共有することで、相乗りした呼び出しにも成否 (throw) が
   * 伝わる。
   * 解放が終わったら参照を外し、次の呼び出しは新しい解放を始める (失敗した段階は
   * 切り離し済みであり、呼び直しが進めるのは残りの段階と終端遷移である)。
   *
   * @returns 進行中の解放、または新しく始めた解放の完了
   */
  private runDisposal(): Promise<void> {
    this.disposalInFlight ??= this.disposeAllResources().finally(() => {
      this.disposalInFlight = null;
    });
    return this.disposalInFlight;
  }

  /**
   * 統計情報を取得する
   */
  getStats(): MediaStats {
    return {
      audio: this.options.audio ? { ...this.audioStats } : null,
      video: this.options.video ? { ...this.videoStats } : null,
    };
  }

  /**
   * 現在の Catalog を取得する
   */
  getCatalog(): Catalog | null {
    return this.currentCatalog;
  }

  // 内部メソッド

  /**
   * start 失敗の通知
   *
   * 送信の失敗の通知の担い手は publisher 層に固定する。事前検証の違反は publisher 層が
   * error コールバックで通知してから返値を reject するため、通知済みの error
   * (isErrorNotifiedByPublisher) では通知しない。ここで通知し直すと 1 件の失敗で
   * onError が 2 回呼ばれる。catalog 送信の await の reject は createPublishers() を
   * 通って start() の catch に届く (catalog だけ await するため)。
   * 通知を伴わない失敗 (接続失敗、closed の同期 throw など) は 1 回だけ通知する。
   * throw される値は Error に限らないため unknown で受け、Error 以外は文字列化して通知する。
   */
  private notifyStartFailure(error: unknown): void {
    if (isErrorNotifiedByPublisher(error)) {
      return;
    }
    this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  /**
   * サーバーに接続して session を確保する
   *
   * @param startGeneration start の開始時に捕捉した世代番号 (この session の close 通知を
   *   扱うかの判定にも使う)
   * @throws 解放が先行した場合 (受け取った session をその場で閉じてから)
   */
  private async connectToServer(startGeneration: number): Promise<void> {
    // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
    // 値がある場合だけ載せる
    const session = await this.openSession({
      url: this.url,
      ...(this.options.serverCertificateHashes !== undefined
        ? { serverCertificateHashes: this.options.serverCertificateHashes }
        : {}),
      ...(this.options.authorizationToken !== undefined
        ? { authorizationToken: this.options.authorizationToken }
        : {}),
      ...(this.options.pendingSubgroup !== undefined
        ? { pendingSubgroup: this.options.pendingSubgroup }
        : {}),
      onSessionClose: () => {
        // void の同期コールバックであり、解放の完了は待たずに進める。handleSessionClose は
        // 解放の失敗を内部で onError に流すため、ここで回収するのは通知経路 (onError /
        // onStateChange / onClose) が throw した分である。未処理の rejection にしないため
        // 握る
        void this.handleSessionClose(startGeneration).catch((error: unknown) => {
          try {
            this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
          } catch {
            // 通知の失敗を伝える経路がこれ以上無い
          }
        });
      },
      // onSessionError は void を返す必要があるため、block body で undefined を返さないようにする
      onSessionError: (error) => {
        this.callbacks.onError?.(error);
      },
    });

    // 接続の await 中に解放 (ピア起点の close / 利用者の close) が先行していれば、受け取った
    // session をその場で閉じて採用しない。採用すると state は既に "closed" で close() も
    // 早期 return するため、閉じる経路が残らない
    if (this.sessionGeneration !== startGeneration) {
      try {
        await session.close();
      } catch (error) {
        // 中止の理由を伝える妨げにしない。session の参照はここで捨てるため再試行できない
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      throw new Error(START_ABORTED_DISPOSED);
    }

    this.session = session;
  }

  /**
   * 接続して Session を確保する
   *
   * WebTransport を要する唯一の境界であり、単体テストはここを置き換えて接続の完了
   * (await の解決) を制御する (モジュール置換は行わない)。
   */
  private openSession(settings: MediaConnectSettings): Promise<Session> {
    return connectMediaSession(settings);
  }

  /**
   * 実行中に解放が先行していないことを確かめる
   *
   * start は各段階の await の直後にこれを呼ぶ。解放 (disposeAllResources) は世代番号を
   * 進めるが、解放が start の開始より前に始まっている場合は、start が世代番号を捕捉した
   * あとに終端 ("closed") へ進むため、世代番号の比較だけでは検出できない。解放の完了後に
   * start を呼び直すと捕捉値は現在値と一致してしまい、終端を跨いで "publishing" に進む。
   * そのため state が "closed" の場合も中止する。
   * 解放が先行していれば、これ以上リソースを作らず "publishing" にもしない (close() は
   * "created" からでも呼べるため、接続の await 中に解放された session を採用すると
   * state が "closed" のまま "publishing" に進み、解放されないリソースが残る)。
   * 検査までに確保した資源は start の失敗時の巻き戻し (disposeAllResources) が解放する。
   * 接続で受け取った session だけは採用すると閉じる経路が state の終端判定に隠れるため、
   * connectToServer がその場で閉じる。
   *
   * @param startGeneration start の開始時に捕捉した世代番号
   * @throws 解放が先行した場合 (start aborted: resources were disposed during start)
   */
  private assertStartNotDisposed(startGeneration: number): void {
    if (this.sessionGeneration !== startGeneration || this.currentState === "closed") {
      throw new Error(START_ABORTED_DISPOSED);
    }
  }

  /**
   * 終端 ("closed") へ遷移して onClose を通知する (解放の完了後に呼ぶ)
   *
   * 遷移と通知を対にして行う。setState は state を代入してから onStateChange を呼ぶため、
   * 利用者の onStateChange が throw しても state は "closed" になり、その場合も onClose を
   * 通知する (通知の回収経路が close() の早期 return だけであるため)。setState の失敗は
   * 呼び出し元へ伝播する。
   * すでに "closed" なら何もしない。終端の遷移と onClose は 1 回だけでなければならず、
   * 通常は呼び出し元 (close() と handleSessionClose) の単発性の判定で抑えられている。
   * この検査はそれらを通過した経路が将来増えたときの保険である。
   */
  private transitionToClosed(): void {
    if (this.currentState === "closed") {
      return;
    }
    try {
      this.setState("closed");
    } finally {
      this.callbacks.onClose?.();
    }
  }

  /**
   * session の close 通知を処理する
   *
   * 世代番号が現在値と一致する通知だけをピア起点の close として扱う。解放
   * (disposeAllResources) は世代番号を進めるため、stop / close / start 失敗の巻き戻しで
   * 解放した後に届く旧 session の通知はここで捨てる (state も onClose も動かさない。
   * 新しい session を確立した後に旧 session の通知が届く場合も同じ)。
   * 一致する通知では解放してから "closed" にして onClose を通知する (解放せずに終端に
   * すると close() の早期 return で解放経路が消え、session・フレームリーダー・
   * エンコーダー・MediaStream が残ったまま再開も停止もできなくなる)。
   * 解放は runDisposal で進行中のものと共有する。解放を共有する通知が重なった場合は、
   * 終端の判定 (state が "closed" か) で 2 回目の遷移と onClose の通知を防ぐ。
   * 解放の間に利用者起点の解放 (stop / close) が始まった場合は、state と onClose は
   * そちらの経路に任せ、ここでは終端遷移も onClose も行わない (解放中は state が
   * "publishing" などのままであるため、利用者起点の解放の回数で判定する。重なった stop の
   * あとに "closed" へ動かすと stop の事後条件が崩れ、重なった close では onClose が
   * 2 回呼ばれる)。
   * 解放が失敗した場合は state を変えず onError で通知する。この onError が throw しても
   * この経路は reject しない (呼び出し元 (connectToServer) の回収が同じ失敗をもう一度
   * onError へ流し、二重に通知するため)。onSessionClose は void の同期コールバックであり
   * 同じ通知は再送されないため、呼び出し側が close() を呼べば残りの解放を回収できる
   * (解放は失敗した段階より後を回収し、参照は切り離し済みのため同じ段階はやり直されない)。
   * 終端遷移の経路 (onStateChange / onClose) が throw した場合はこの Promise が reject する。
   * 呼び出し元 (connectToServer) が回収し、未処理の rejection にしない。
   *
   * @param generation 通知を受け取った session の世代番号 (start が捕捉し、connectToServer
   *   がクロージャへ渡す値)
   */
  private async handleSessionClose(generation: number): Promise<void> {
    if (generation !== this.sessionGeneration) {
      return;
    }

    // 解放の前後で利用者起点の解放の回数を比較し、重なったかを判定する
    const userDisposalCount = this.userDisposalCount;
    try {
      await this.runDisposal();
    } catch (error) {
      // 解放の失敗を通知する。通知の失敗でこの経路を reject させない
      // (呼び出し元が同じ失敗をもう一度 onError へ流すと二重通知になる)
      try {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // 通知の失敗を伝える経路がこれ以上無い
      }
      return;
    }
    // 解放を共有する通知が重なった場合、先に終端へ進んだ側が state と onClose を決める。
    // 同一世代の通知が 2 つ通る経路は今は無く (解放が世代番号を進めるため 2 つ目は
    // handleSessionClose の先頭で捨てられる)、この判定はそれを通過する経路が将来増えた
    // ときの保険である
    if (this.userDisposalCount !== userDisposalCount || this.currentState === "closed") {
      return;
    }

    this.transitionToClosed();
  }

  private async createPublishers(): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;
    // draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH に MUST 付与する。
    // SETUP に載せたトークン (MOQT URI の msf fragment の c4m を含む) をそのまま使う。
    // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
    // 値がある場合だけ載せる
    const authorizationTokenOptions: PublishOptions =
      this.session.setupAuthorizationToken === undefined
        ? {}
        : { authorizationToken: this.session.setupAuthorizationToken };

    // Catalog パブリッシャー
    // maxCacheDuration を指定してサーバーにキャッシュさせる
    this.catalogPublisher = await this.session.publish(
      namespace,
      CATALOG_TRACK_NAME,
      {
        error: (error) => this.callbacks.onError?.(error),
      },
      {
        maxCacheDuration: 3600000n,
        ...authorizationTokenOptions,
      },
    );

    // 音声パブリッシャー
    const audio = this.resolvedAudio;
    if (audio) {
      this.audioPublisher = await this.session.publish(
        namespace,
        audio.trackName,
        {
          error: (error) => this.callbacks.onError?.(error),
          // 音声にはキーフレームが無く Audio Config は最初の chunk にしか現れないため、
          // 同じ値の再送を抑止したままだと後から接続した購読者が AAC を復号できない。
          // forwardState が 1 になった時点で保持値の送り直しを要求する
          // (判断の詳細は resolveAudioConfigToSend の JSDoc を参照)
          onForwardStateChange: (forward) => {
            if (forward) {
              this.audioConfigResendRequested = true;
            }
          },
        },
        authorizationTokenOptions,
      );
    }

    // 映像パブリッシャー
    const video = this.resolvedVideo;
    if (video) {
      this.videoPublisher = await this.session.publish(
        namespace,
        video.trackName,
        {
          error: (error) => this.callbacks.onError?.(error),
          // draft-ietf-moq-transport-22 §9.20.19: 新しい Group の要求には、次のフレームを
          // キーフレームにして新しい Group を始めることで応える。次のフレームまでに届いた
          // 複数の要求は、フレーム番号を 0 に戻すだけなので 1 つの Group にまとまる
          onNewGroupRequest: () => this.requestKeyframe(),
        },
        { ...VIDEO_PUBLISH_OPTIONS, ...authorizationTokenOptions },
      );
    }

    // Catalog を publish
    await this.publishCatalog();
  }

  /**
   * Catalog を作成して publish する
   *
   * draft-ietf-moq-msf-01 §5: All catalog updates, both independent and delta,
   * MUST be mapped to MOQT sub-group 0. The first Object (with Object ID 0) in
   * any Group in a catalog track MUST hold an independent copy of the catalog.
   *
   * draft-ietf-moq-msf-01 §11.2: An MSF publisher MUST publish a catalog track
   * object before publishing any media track objects.
   */
  private async publishCatalog(): Promise<void> {
    if (!this.catalogPublisher || this.catalogPublisher.state !== "active") {
      return;
    }

    const tracks = this.createCatalogTracks();
    const catalog = createCatalog(tracks, {
      generatedAt: Date.now(),
    });

    // 作成した Catalog を保存
    this.currentCatalog = catalog;

    const payload = encodeCatalog(catalog);

    // Catalog object が WebTransport stream に書き込み完了するまで await する。
    // draft-ietf-moq-transport-22 §9.11: FETCH は object が publish されていなければ
    // INVALID_RANGE で REQUEST_ERROR を返す MUST。fire-and-forget だと publisher.start() の
    // return 後すぐに subscriber が join した場合に race を踏むため、catalog だけは確実に
    // 書き込み完了してから return する。
    // groupId=0, objectId=0 は draft-ietf-moq-msf-01 §5 で MUST 規定 (independent catalog
    // in subgroup 0)。Priority は購読開始の前提になるため最高優先で送る
    await this.catalogPublisher.sendObject({
      groupId: 0,
      objectId: 0,
      payload,
      priority: PRIORITY_CATALOG,
    });
  }

  /**
   * Catalog 用のトラック情報を生成する
   *
   * targetLatency と renderGroup は音声と映像の両方の track に同じ値を載せる。
   * draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は
   * 同一の targetLatency でなければならない MUST。§5.2.11: 同じ renderGroup の track は
   * 同時に描画する SHOULD。値はオプションで 1 つだけ持ち、両方の track に同じ値を載せる。
   * 指定しないときはキーを載せない (§5.2.8: 宣言が無く isLive が true のときは購読側が
   * 遅延を選んでよい MAY のため、載せないことが購読側のフォールバックの経路になる)。
   * 指定した値は有限数であること (renderGroup はさらに整数であること) を検証し、
   * そうでなければ throw する。非有限値は JSON で null になり、購読側が復号できなくなる。
   *
   * SETUP の Authorization Token が C4M のトークン (CAT) のときは、音声と映像の track に
   * authInfo を載せ、視聴側に同じ方式のトークンの提示を求める (draft-ietf-moq-msf-01
   * §5.2.42 / §11.4.1。catalogAuthInfoForSetupToken を参照)。
   */
  private createCatalogTracks(): CatalogTrack[] {
    const tracks: CatalogTrack[] = [];

    // 非有限値と renderGroup の非整数は、購読側が復号できない catalog になるため拒否する
    assertCatalogLatencyOptions(this.options);

    // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
    // 指定がある項目だけを載せる。targetLatency の 0 ms と renderGroup の 0 は有効値である
    // ため、0 かどうかではなく指定の有無で判定する
    const latencyFields: Pick<CatalogTrack, "targetLatency" | "renderGroup"> = {
      ...(this.options.targetLatency !== undefined
        ? { targetLatency: this.options.targetLatency }
        : {}),
      ...(this.options.renderGroup !== undefined ? { renderGroup: this.options.renderGroup } : {}),
    };
    // authInfo も同じく、載せるときだけキーを持たせる
    const authInfo = catalogAuthInfoForSetupToken(this.options.authorizationToken);
    const authInfoFields: Pick<CatalogTrack, "authInfo"> =
      authInfo !== undefined ? { authInfo } : {};

    // Audio トラック
    const audio = this.resolvedAudio;
    if (audio) {
      tracks.push({
        name: audio.trackName,
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: audio.codecString,
        bitrate: audio.bitrate,
        samplerate: audio.sampleRate,
        channelConfig: String(audio.channels),
        ...latencyFields,
        ...authInfoFields,
      });
    }

    // Video トラック
    const video = this.resolvedVideo;
    if (video && this.mediaStream) {
      tracks.push({
        name: video.trackName,
        packaging: "loc",
        isLive: true,
        role: "video",
        codec: video.codecString,
        bitrate: video.bitrate,
        width: video.width,
        height: video.height,
        framerate: video.framerate,
        ...latencyFields,
        ...authInfoFields,
      });
    }

    return tracks;
  }

  private async setupEncoders(): Promise<void> {
    const useWorker = this.options.useWorker ?? true;

    // 音声エンコーダー
    if (this.options.audio && this.mediaStream) {
      const audioTrack = this.mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        this.audioEncoder = new AudioEncoderWrapper(useWorker, {
          output: (chunk) => this.handleAudioEncodedChunk(chunk),
          error: (error) => this.callbacks.onError?.(error),
        });

        // Catalog と同じ解決済み設定を使う (start() で 1 度だけ解決している)
        const audio = this.resolvedAudio;
        if (!audio) {
          throw new Error("audio settings not resolved");
        }
        await this.audioEncoder.configure(
          audio.codec,
          audio.bitrate,
          audio.sampleRate,
          audio.channels,
        );

        if (!isMediaStreamTrackProcessorAvailable()) {
          throw new Error(
            "MediaStreamTrackProcessor is required for audio publishing but is not available in this browser",
          );
        }
        this.audioTrackProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
        this.audioFrameReader = this.audioTrackProcessor.readable.getReader();
      }
    }

    // 映像エンコーダー
    if (this.options.video && this.mediaStream) {
      const videoTrack = this.mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        // Catalog と同じ解決済み設定を使う (start() で 1 度だけ解決している)
        const video = this.resolvedVideo;
        if (!video) {
          throw new Error("video settings not resolved");
        }

        this.videoEncoder = new VideoEncoderWrapper(useWorker, {
          output: (chunk) => this.handleVideoEncodedChunk(chunk),
          error: (error) => this.callbacks.onError?.(error),
        });

        await this.videoEncoder.configure(
          video.codec,
          video.width,
          video.height,
          video.bitrate,
          video.framerate,
        );

        this.videoFrameSource = createVideoFrameSource(videoTrack);
        this.videoFrameReader = this.videoFrameSource.readable.getReader();
        // 対応は読んだフレームからとる (processVideoFrames)
        this.videoWallClock = new WallClockMapper();
      }
    }
  }

  private startProcessingLoops(): void {
    if (this.audioFrameReader && this.audioEncoder) {
      void this.processAudioFrames();
    }
    if (this.videoFrameReader && this.videoEncoder) {
      void this.processVideoFrames();
    }
  }

  private async processAudioFrames(): Promise<void> {
    const reader = this.audioFrameReader;
    const encoder = this.audioEncoder;
    if (!reader || !encoder) return;
    const generation = this.processingGeneration;

    try {
      while (
        this.processingActive &&
        generation === this.processingGeneration &&
        encoder.state === "configured"
      ) {
        const { value: audioData, done } = await reader.read();
        if (done) break;
        if (generation !== this.processingGeneration) {
          // 旧世代ループは encode せず終了する (フレームは破棄前に閉じる)
          audioData.close();
          break;
        }

        encoder.encode(audioData);
        audioData.close();
      }
    } catch (error) {
      // 旧世代ループの失敗は通知しない (多重発火の防止)
      if (this.processingActive && generation === this.processingGeneration) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async processVideoFrames(): Promise<void> {
    const reader = this.videoFrameReader;
    const encoder = this.videoEncoder;
    if (!reader || !encoder) return;
    const generation = this.processingGeneration;

    try {
      while (
        this.processingActive &&
        generation === this.processingGeneration &&
        encoder.state === "configured"
      ) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        if (generation !== this.processingGeneration) {
          // 旧世代ループは encode せず終了する (フレームは破棄前に閉じる)
          frame.close();
          break;
        }

        // 読んだフレームの timestamp とそのときの壁時計を記録する。撮ってから読むまでの
        // 遅れが最も小さいフレームに合わせて換算する (WallClockMapper)
        this.videoWallClock.observe(frame.timestamp, performance.timeOrigin + performance.now());

        try {
          if (encoder.encodeQueueSize <= 2) {
            // キーフレームの判定と直前のキーフレームの更新は、実際に encode する
            // フレームだけで行う。破棄するフレームでも判定と更新を行うと、
            // requestKeyframe() が消した記録を破棄した分だけ進めてしまい、キーフレームの
            // 要求を消費する。要求は次の間隔まで現れなくなる。据え置いた記録で次の
            // フレームが判定を受けるため、繰り越し状態を持たずに要求は次に encode する
            // フレームへ移る
            const isKeyFrame = shouldSendKeyFrame(
              this.lastKeyFrameTimestampUs,
              frame.timestamp,
              this.keyframeInterval,
            );
            encoder.encode(frame, { keyFrame: isKeyFrame });
            // 記録の更新は encode の後ろに置く。encode が同期 throw した場合は encode して
            // いないため記録を進めず、次のフレームが同じ記録で判定を受ける
            if (isKeyFrame) {
              this.lastKeyFrameTimestampUs = frame.timestamp;
            }
          } else {
            // エンコード能力を超えた入力はエンコードせず破棄する (待たない)。
            // 破棄した数を統計に残す
            this.videoStats.droppedFrames++;
          }
        } finally {
          // encode が同期 throw した場合も閉じ忘れないよう finally で閉じる
          // (破棄した場合と encode した場合を合わせて close は 1 回だけ)
          frame.close();
        }
      }
    } catch (error) {
      // 旧世代ループの失敗は通知しない (多重発火の防止)
      if (this.processingActive && generation === this.processingGeneration) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleAudioEncodedChunk(chunk: AudioEncodedChunkData): void {
    if (!this.audioPublisher || this.audioPublisher.state !== "active") return;

    // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
    // encoder が返す description (AAC の AudioSpecificConfig) を AUDIO_CONFIG として送る。
    // 同じ値の重複送出を避けつつ後着の購読者へ送り直す判断は
    // resolveAudioConfigToSend が持つ
    const {
      config: audioConfig,
      next,
      resendNext,
    } = resolveAudioConfigToSend(
      this.lastSentAudioConfig,
      chunk.description,
      this.audioConfigResendRequested,
    );
    this.lastSentAudioConfig = next;
    this.audioConfigResendRequested = resendNext;

    // LOC Properties をエンコード。
    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る
    // (draft-ietf-moq-loc-04 §2.3.1.1。TIMESCALE は付けない)。
    const properties = LOC.encodeAudioProperties({
      timestamp: LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin),
      config: audioConfig,
    });

    // LOC draft-ietf-moq-loc-04 §4.1 (Application with one audio track):
    // 音声 chunk 1 つ = Object 1 つ = Group 1 つ。フレームごとに Group を進める
    const audioAllocation = allocateAudioObject({
      groupId: this.audioGroupId,
      started: this.audioGroupStarted,
    });
    this.audioGroupId = audioAllocation.state.groupId;
    this.audioGroupStarted = audioAllocation.state.started;
    if (audioAllocation.groupAdvanced) {
      // draft-ietf-moq-msf-01 §6.1: 送信済み最大を追跡し、
      // 次インスタンスの開始 Group ID が上回るようにする
      lastAllocatedInitialGroupId = Math.max(lastAllocatedInitialGroupId, this.audioGroupId);
    }

    const payload = chunk.data;
    this.audioStats.framesSent++;
    this.audioStats.bytesSent += payload.length + properties.length;
    this.audioStats.currentGroupId = this.audioGroupId;

    // 音声フレームは fire-and-forget (後続のオブジェクトで上書きされるため落としても良い)
    this.sendFrameFireAndForget(this.audioPublisher, {
      groupId: audioAllocation.groupId,
      objectId: audioAllocation.objectId,
      payload,
      properties,
      priority: PRIORITY_AUDIO,
    });
  }

  private handleVideoEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void {
    if (!this.videoPublisher || this.videoPublisher.state !== "active") return;

    // キーフレームで新しいグループを開始
    // (初回オブジェクトは加算せず初期値を送る。実運用経路は初回を
    // key で要求するため、delta 先行時は初回 key が初期値 + 1 になる)
    const videoAllocation = allocateVideoObject(
      {
        groupId: this.videoGroupId,
        objectId: this.videoObjectId,
        started: this.videoGroupStarted,
      },
      chunk.type === "key",
    );
    this.videoGroupId = videoAllocation.state.groupId;
    this.videoObjectId = videoAllocation.state.objectId;
    if (videoAllocation.groupAdvanced) {
      // draft-ietf-moq-msf-01 §6.1: 送信済み最大を追跡し、
      // 次インスタンスの開始 Group ID が上回るようにする
      lastAllocatedInitialGroupId = Math.max(lastAllocatedInitialGroupId, this.videoGroupId);
    }
    if (chunk.type === "key") {
      this.videoStats.keyFramesSent++;
    }

    // LOC Properties をエンコード。
    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る
    // (draft-ietf-moq-loc-04 §2.3.1.1。TIMESCALE は付けない)。
    // VideoFrame の timestamp は取得元ごとに基準が異なるため、読んだフレームとの
    // 対応から換算する (mediaClock.ts)。
    // isDiscardable は WebCodecs が破棄可能性情報を提供しないため false 固定 (RFC 9626 §3.1 D の
    // 「the sender knows」を守るため)。isBaseLayerSync はソース上のキーフレーム意図マーカとして
    // 残すが、temporalLayerId=0 固定のためワイヤ上 B=0 に抑圧される (詳細は
    // encodeVideoFrameMarking を参照)。
    // draft-ietf-moq-loc-04 §2.3.2.1 (Video Config):
    // encoder が返す description (avcC / hvcC などの extradata) を VIDEO_CONFIG として送る。
    // 受信側は VideoDecoderConfig.description に渡して canonical 形式 (avc1 / hvc1) を
    // 復元できる。description は keyframe の metadata にのみ現れるため、
    // 変化したときだけ載せる。
    let videoConfig: Uint8Array | undefined;
    if (
      chunk.description !== undefined &&
      !isSameCodecDescription(this.lastSentVideoConfig, chunk.description)
    ) {
      videoConfig = chunk.description;
      this.lastSentVideoConfig = new Uint8Array(chunk.description);
    }

    // フレームを読んだ時点で記録するため、ここで記録が無いことは無い。念のため、無ければ
    // この chunk を読んだ時点とみなす
    const properties = LOC.encodeVideoProperties({
      timestamp: this.videoWallClock.toWallClockMicroseconds(
        chunk.timestamp,
        performance.timeOrigin + performance.now(),
      ),
      frameMarking: {
        isIndependent: chunk.type === "key",
        isDiscardable: false,
        isBaseLayerSync: chunk.type === "key",
        temporalLayerId: 0,
        spatialLayerId: 0,
      },
      config: videoConfig,
    });

    const payload = chunk.data;
    this.videoStats.framesSent++;
    this.videoStats.bytesSent += payload.length + properties.length;
    this.videoStats.currentGroupId = this.videoGroupId;

    // 映像フレームは fire-and-forget (後続のオブジェクトで上書きされるため落としても良い)
    this.sendFrameFireAndForget(this.videoPublisher, {
      groupId: videoAllocation.groupId,
      objectId: videoAllocation.objectId,
      payload,
      properties,
      priority: chunk.type === "key" ? PRIORITY_VIDEO_KEY : PRIORITY_VIDEO_DELTA,
    });
    // 送信を試みた時点で「Group を開始済み」にする
    // (次に届くキーフレームから新しい Group を開始する)
    this.videoGroupStarted = videoAllocation.state.started;
  }

  /**
   * フレームを fire-and-forget で送る
   *
   * 落としても良いし、後続の Object で上書きされる。事前検証の違反は Publisher 側が
   * error 通知してから返値を reject するため、呼び出し側は通知せず reject を回収する
   * だけにする (通知すると 1 件の失敗で 2 回通知になる)。
   * 同期 throw は通知を伴わないため 1 回だけ通知する。closed の throw は両ハンドラの
   * 先頭の state ガードで到達しないが、委譲先が同期 throw する場合の防御である。
   */
  private sendFrameFireAndForget(publisher: Publisher, params: SendObjectParams): void {
    try {
      void publisher.sendObject(params).catch(() => {
        // 通知は Publisher 側の責務である (ここで通知すると二重通知になる)
      });
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 確保済みリソースを逆順に巻き戻す
   *
   * stop / close / ピア起点の close 通知 (handleSessionClose) と start 失敗時の巻き戻しで
   * 共用する。stop / close / 通知の経路は runDisposal を通して進行中の解放を共有し、
   * start 失敗時の巻き戻しだけは、参照を切り離し済みの呼び出しから直接呼ばれる。
   * 取得の逆順
   * (reader → source・processor・encoder → Publisher → session) で
   * 破棄し参照を null 化する。reader の cancel は握り潰し内蔵のため
   * guard の外で先行する。それ以外の各段階は参照の切り離しを
   * await の前に行い、一段階の失敗が後続破棄を止めない。
   * 最初の失敗は最後に再 throw する。
   * 二重破棄は冪等操作のみで行う
   * (Publisher の active ガード付き done、encoder・source・session の
   * null 安全な close に依存する)。再 start に引き継ぐのは Catalog・統計・
   * Group ID・オブジェクト ID・フレーム数・Group 開始済みフラグ (音声 / 映像) と、
   * 直前に送った Video Config である。
   * 直前に送った Audio Config と送り直し要求は session に紐づくため破棄する
   * (再 start では購読者が誰も前の Object を受け取っていないため、新しい
   * encoder の最初の description を初出として送り直す必要がある)。
   * 映像の config 再送は音声とは別に扱うため、直前に送った Video Config は
   * 破棄せず再 start 後も同じ値の送出を抑止する。
   * 解放のたびに session の世代番号を進める (この 1 箇所だけ)。これ以降に届く旧
   * session の close 通知は handleSessionClose が世代不一致で捨てる (stop / close /
   * start 失敗の全経路)。
   */
  private async disposeAllResources(): Promise<void> {
    this.processingActive = false;
    this.sessionGeneration++;

    // フレームリーダーをキャンセル
    await this.cancelFrameReaders();

    // 段階破棄の失敗を集め、後続を止めず最後に最初の失敗を投げる
    let firstFailure: Error | null = null;
    const guard = async (task: () => Promise<void> | void): Promise<void> => {
      try {
        await task();
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    };

    // VideoFrameSource とプロセッサを解放する
    const videoFrameSource = this.videoFrameSource;
    this.videoFrameSource = null;
    await guard(() => videoFrameSource?.close());
    this.audioTrackProcessor = null;
    // 次回 start() で上書きされるため保持しない
    this.mediaStream = null;

    // エンコーダーを閉じる
    const audioEncoder = this.audioEncoder;
    this.audioEncoder = null;
    await guard(() => audioEncoder?.close());
    const videoEncoder = this.videoEncoder;
    this.videoEncoder = null;
    await guard(() => videoEncoder?.close());

    // Publisher を終了
    const catalogPublisher = this.catalogPublisher;
    this.catalogPublisher = null;
    await guard(async () => {
      if (catalogPublisher && catalogPublisher.state === "active") {
        await catalogPublisher.done();
      }
    });
    const audioPublisher = this.audioPublisher;
    this.audioPublisher = null;
    await guard(async () => {
      if (audioPublisher && audioPublisher.state === "active") {
        await audioPublisher.done();
      }
    });
    // encoder と Publisher を切り離した後に Audio Config の保持値と送り直し要求を
    // 破棄する (破棄中に届いた出力で再充填されないようにする)
    this.lastSentAudioConfig = null;
    this.audioConfigResendRequested = false;
    const videoPublisher = this.videoPublisher;
    this.videoPublisher = null;
    await guard(async () => {
      if (videoPublisher && videoPublisher.state === "active") {
        await videoPublisher.done();
      }
    });

    // セッションを閉じる
    const session = this.session;
    this.session = null;
    await guard(async () => {
      if (session) {
        await session.close();
      }
    });

    if (firstFailure !== null) {
      const failure: Error = firstFailure;
      throw failure;
    }
  }

  private async cancelFrameReaders(): Promise<void> {
    if (this.audioFrameReader) {
      try {
        await this.audioFrameReader.cancel();
      } catch {
        // 無視
      }
      this.audioFrameReader = null;
    }
    if (this.videoFrameReader) {
      try {
        await this.videoFrameReader.cancel();
      } catch {
        // 無視
      }
      this.videoFrameReader = null;
    }
  }
}

/**
 * MediaPublisher を作成する
 *
 * @param url - MOQT サーバーの URL (例: `moqt://example.com/moqt`)
 * @param options - 配信オプション
 * @param callbacks - コールバック
 * @returns MediaPublisher インスタンス
 */
export async function createMediaPublisher(
  url: string,
  options: MediaPublisherOptions,
  callbacks?: MediaPublisherCallbacks,
): Promise<MediaPublisher> {
  if (!options.audio && !options.video) {
    throw new Error("at least one of audio or video must be specified");
  }

  return new MediaPublisherImpl(url, options, callbacks);
}

// 型のエクスポート
export type {
  MediaPublisher,
  MediaPublisherOptions,
  MediaPublisherCallbacks,
  MediaPublisherState,
  MediaStats,
  AudioStats,
  VideoStats,
  AudioPublishOptions,
  VideoPublishOptions,
};
