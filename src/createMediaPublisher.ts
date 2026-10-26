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
import { mergeFadedPlanes } from "./audioSpliceFade";
import type { AudioSamples } from "./playout/audioTimeStretch";
import { AudioTimestampClock } from "./audioTimestampClock";
import { AudioPublishCatchUp, type AudioPublishCatchUpSendStart } from "./audioPublishCatchUp";
import { catalogRepublishIntervalMs } from "./catalogRepublish";
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
import { DEFAULT_KEYFRAME_INTERVAL_SECONDS, getAudioEncoderConfig } from "./codec/config";
import { probeAudioEncoderConfig } from "./codec/configSupport";
import {
  withCapturedAudioFormat,
  resolveAudioPublishSettings,
  resolveVideoPublishSettings,
  type ResolvedAudioPublishSettings,
  type ResolvedVideoPublishSettings,
} from "./createMedia/settings";
import type {
  AudioDelivery,
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
import { createVideoFrameSource, type VideoFrameSource } from "./frameSource";
import { createAudioFrameSource, type AudioFrameSource } from "./audioSource";
import { recordEncodeGeneration, shouldSendEncodedChunk } from "./encodeGeneration";

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

/**
 * 停止時に取り込みキューから次を待つ時間 (ミリ秒)
 *
 * 音声の取り込みは 10 ms ブロックで届くため、これより短くすると「停止の受付時点で
 * 既にキューにあったフレーム」だけを読み切れる (停止後の新規キャプチャは含めない)。
 * 5 ms は停止の待ち時間への寄与を小さくしつつ、キューに残ったフレームの取り出しを
 * 妨げない長さである
 */
export const AUDIO_TAIL_DRAIN_QUIET_MS = 5;

/**
 * 停止時に追加で読み出す取り込みブロックの上限
 *
 * 1 ブロック 10 ms なので最大 40 ms。停止の受付時にキューへ溜まり得る量の安全弁であり、
 * 通常は 1〜2 ブロックで静穏窓に達する
 */
export const AUDIO_TAIL_DRAIN_MAX_FRAMES = 4;

/** 停止時の末尾 drain (新規読み出しを止めて読み切る) の上限 (ミリ秒) */
export const AUDIO_TAIL_DRAIN_MAX_MS = 50;

/**
 * 停止時の encoder flush と datagram の送信完了を待つ上限 (ミリ秒)
 *
 * encoder や worker が応答しない場合でも停止がハングしないための安全弁である。
 * 上限で打ち切った場合は計器 (`tailFlushTimeoutCount`) に残し、待たずに解放へ進む
 */
export const AUDIO_TAIL_FLUSH_MAX_MS = 150;

/**
 * datagram 配送の停止時に、末尾の datagram を書いてから PUBLISH_DONE を送るまでの猶予
 * (ミリ秒)
 *
 * draft-ietf-moq-transport-22 では datagram と control stream の間に順序保証が無い。
 * 購読者は PUBLISH_DONE を受けた時点で購読を閉じ、後から届いた datagram を捨てるため、
 * 末尾の datagram が PUBLISH_DONE より後に届くと失われる。実リレーの経路の遅れは
 * 17〜23 ms であり、その約 2 倍を待つ。subgroup 配送では `done()` が送信キューを
 * 待つため猶予は要らない
 */
export const AUDIO_TAIL_PUBLISH_DONE_GRACE_MS = 50;

/** 末尾の drain の状態 (停止の受付から flush の完了まで) */
interface AudioTailDrainState {
  /** この時刻を過ぎたら読み出しを止める (`performance.now` 軸のミリ秒) */
  readonly deadlineMs: number;
  /** 追加で読み出すブロックの上限 */
  readonly maxFrames: number;
  /** 読み出したブロックの数 */
  framesRead: number;
  /** 読み出したブロックの範囲 (入力の timestamp と長さ、マイクロ秒) */
  readonly readBlocks: { startMicros: number; endMicros: number }[];
  /** 送信した chunk の数 */
  sentFrames: number;
  /** 送信した chunk の長さの合計 (ミリ秒) */
  sentMs: number;
  /** 送信した chunk が覆った入力の末尾 (マイクロ秒) */
  sentEndMicros: number | null;
  /** 末尾の送信 (datagram の write / subgroup の送信) の完了 */
  readonly sendPromises: Promise<void>[];
  /** ループが drain を終えたことを知らせる */
  readonly done: Promise<void>;
  resolveDone: () => void;
}

/**
 * `reader.read()` を指定時間だけ待つ
 *
 * 時間内に読めなければ `{ kind: "quiet" }` を返し、待つのをやめる。負けた read は
 * そのまま残るため、後からフレームが解決したら閉じて捨てる (停止後に新しく
 * キャプチャされたフレームを送らない)。reader 自体の cancel は解放が行う。
 */
async function readAudioFrameWithin(
  reader: ReadableStreamDefaultReader<AudioData>,
  timeoutMs: number,
): Promise<{ kind: "frame"; value: AudioData } | { kind: "done" } | { kind: "quiet" }> {
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 負けた read が後からフレームを返した場合は所有者不明になるため閉じる
  const readPromise = reader.read().then((result) => {
    if (abandoned && !result.done) {
      result.value.close();
    }
    return result;
  });
  try {
    const timeout = new Promise<{ kind: "quiet" }>((resolve) => {
      timer = setTimeout(() => {
        // 負けた read がこの後にフレームを返したら閉じる
        abandoned = true;
        resolve({ kind: "quiet" });
      }, timeoutMs);
    });
    const result = await Promise.race([
      readPromise.then((read) =>
        read.done ? ({ kind: "done" } as const) : ({ kind: "frame", value: read.value } as const),
      ),
      timeout,
    ]);
    if (result.kind === "quiet") {
      abandoned = true;
    }
    return result;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/** 指定時間だけ待つ (タイマーを 1 本だけ作る) */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Promise を上限時間まで待つ
 *
 * 上限を過ぎた場合は `{ timedOut: true }` を返し、呼び出し側は待つのをやめる。
 * 負けた Promise は捨てる (後から reject しても未処理の rejection にしないため、
 * catch を付けておく)。
 */
async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const result = await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return result;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    // 負けた Promise の rejection を未処理にしない
    void promise.catch(() => {});
  }
}

/**
 * catalog の MAX_CACHE_DURATION (ミリ秒)
 *
 * relay はこの時間を過ぎた Object を cache から配れない (MUST NOT。
 * draft-ietf-moq-transport-22 §10.3)。1 時間とする。
 * 送り直しの間隔の根拠は catalogRepublish.ts にまとめる。
 * 単体テストから値を固定するため export する (パッケージ公開 API には含めない)。
 */
export const CATALOG_MAX_CACHE_DURATION_MS = 3_600_000;

/**
 * catalog を送り直す既定の間隔 (ミリ秒)
 *
 * MAX_CACHE_DURATION の半分を上下限に収めた値 (catalogRepublish.ts を参照)。
 * MAX_CACHE_DURATION (1 時間) では実効値が上限の 30 秒になる。
 * 単体テストから値を固定するため export する (パッケージ公開 API には含めない)。
 */
export const CATALOG_REPUBLISH_DEFAULT_INTERVAL_MS = catalogRepublishIntervalMs(
  CATALOG_MAX_CACHE_DURATION_MS,
);

// 割り当てた開始 Group ID と送信に使った Group ID の最大値 (全トラックで共有)
// (draft-ietf-moq-msf-01 §6.1: 再開時の開始 Group ID は同一 track で以前に publish した
// どの Group ID よりも大きいことが MUST。トラックを跨いで安全側 (大きめ) に倒す)
let maxGroupIdSeen = 0;

/**
 * 初期 Group ID を割り当てる (MSF 生成に単調ガードを付けた Publisher 側の割当て)
 *
 * draft-ietf-moq-msf-01 §6.1 (Group ID は track ごとに一意で単調増加が MUST、再開時の
 * 開始値は同一 track の以前のどの Group ID よりも大きいことが MUST) に基づき
 * `createInitialGroupId` (Unix epoch ミリ秒起点) を使う。`Date.now()` は
 * `MAX_SAFE_INTEGER` に収まるため Publisher 側の `number` 型に変換する。同一プロセス内の
 * 前回値を下回らないよう前回 + 1 との最大値を取る。プロセス跨ぎは壁時計に委ねる。
 * `candidate` は安全整数のみ受け付け、それ以外は拒否する。前回値は `noteGroupId` が
 * 送信済みの Group ID で押し上げることもある (配信中に Group を進めた場合)。
 *
 * 単体テストから固定値で駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export function allocateInitialGroupId(candidate = Number(createInitialGroupId())): number {
  if (!Number.isSafeInteger(candidate)) {
    throw new Error(`initial group id candidate must be a safe integer, got ${candidate}`);
  }
  const next = Math.max(candidate, maxGroupIdSeen + 1);
  // 内部 API 用の防御。候補もガードも安全整数である限り本番の値 (壁時計由来) では到達しない。
  // ガードが 2^53 - 1 に達すると ここで例外になり、以後の払い出しが止まる
  // (重複した Group ID を配り続けるより安全側。到達させるには noteGroupId に
  // Number.MAX_SAFE_INTEGER を渡す必要があり、テストすると共有ガードが汚れる)
  if (!Number.isSafeInteger(next)) {
    throw new Error(`initial group id must be a safe integer, got ${next}`);
  }
  maxGroupIdSeen = next;
  return next;
}

/**
 * 送信した Group ID を単調ガードへ追随させる
 *
 * draft-ietf-moq-msf-01 §6.1 は、配信を再開したときの開始 Group ID が「同一 track で以前に
 * publish したどの Group ID よりも大きいこと」を MUST とする。配信中に Group を進めた値を
 * ここへ渡しておかないと、停止と再開を繰り返したときに開始値が前回の最大値を下回る。
 *
 * ガードはプロセス内の全トラックで共有されるため、どのトラックの経路で呼んでもよい。
 * 単体テストと moqt-devtools から同じ規則を使うため export する
 * (パッケージ公開 API には含めない)。
 *
 * @param groupId - 送信に使う Group ID (Group を進めたときに呼ぶ)
 */
export function noteGroupId(groupId: number): void {
  // 安全整数でないと guard + 1 === guard となり、全トラックが同じ Group ID を払い出し続ける
  // (draft-ietf-moq-msf-01 §6.1 の一意性 MUST に反する)
  if (!Number.isSafeInteger(groupId)) {
    throw new Error(`group id must be a safe integer, got ${groupId}`);
  }
  maxGroupIdSeen = Math.max(maxGroupIdSeen, groupId);
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
 * (`PublishCallbacks.onNewGroupRequest` から `startNewGroup()` を呼ぶ)。
 */
export const VIDEO_PUBLISH_OPTIONS: Readonly<PublishOptions> = { dynamicGroups: true };

/**
 * 映像フレームがキーフレームのタイミングかを判定する純関数
 *
 * 直前のキーフレームからの経過時間が間隔以上ならキーフレームにする。先頭のフレーム
 * (直前のキーフレームが無い) と、timestamp が巻き戻ったフレーム (映像の入力が
 * 差し替わった) もキーフレームにする。`startNewGroup()` は直前のキーフレームの
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
 * `decoderConfig.description` (LOC の Video Config / Audio Config の元になる extradata) は、
 * configure 後の最初の出力と構成変更時に渡る (実装依存。同じ値が繰り返し渡る実装もある)。
 * 変化したときだけ載せるかの判断に使う。
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

/** codec description (Video Config / Audio Config) の送出判断の結果 */
export interface CodecConfigResolution {
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
): CodecConfigResolution {
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
 * 送る Object に載せる codec description を決める純関数
 *
 * `resolveAudioConfigToSend` / `resolveVideoConfigToSend` は空の description を「値なし」と
 * 扱う契約である (length 0 は設定として意味を持たない)。送らなかった出力の description を
 * 保留している場合に空の description が届くと、そのままでは保留値を覆ってしまい、載せる値が
 * 無いまま保留値が消える。ここで同じ規則 (length > 0 のときだけ値として扱う) に正規化する。
 *
 * 単体テストと moqt-devtools から同じ規則を使うため export する
 * (パッケージ公開 API には含めない)。
 *
 * @param description - 今回の出力が持つ description
 * @param pending - 送らなかった出力が持っていた description (無ければ null)
 */
export function selectCodecDescription(
  description: Uint8Array | undefined,
  pending: Uint8Array | null,
): Uint8Array | undefined {
  if (description !== undefined && description.length > 0) return description;
  return pending ?? undefined;
}

/**
 * 送信する Video Config を解決する純関数
 *
 * draft-ietf-moq-loc-04 §2.3.2.1 (Video Config): avcC / hvcC などの extradata は
 * `VideoDecoderConfig.description` に対応する。WebCodecs の `EncodedVideoChunkMetadata`
 * が description を付けるのは、configure 後の最初の出力と構成が変わったときだけである
 * (Chromium の実装。実装依存であり将来変わり得る)。キーフレームごとに再出現しないため、
 * description の再出現を待つと後着の購読者へ送り直せない。
 *
 * 送り直しは forwardState が 0 から 1 になった時点 (購読者の出現を
 * draft-ietf-moq-transport-22 §7.6 の REQUEST_UPDATE の FORWARD パラメータで
 * 知った時点) に要求され、次に届くキーフレームの Object に保持している値を 1 度だけ
 * 載せ直す。キーフレーム以外の Object に保持値を載せると、購読側が GOP の途中で
 * 復号器を再構成することになり、参照フレームも揃わないため、要求はキーフレームまで
 * 保留する。載せた時点で要求は解消し、保持値は消さない (消すと次の要求に応えられない)。
 * forwardState が 1 のまま購読者が接続した場合は変化が起きないため送り直されない
 * (購読者が居ない間に relay が forwardState を 0 にするかは §7.2 により relay の
 * 裁量であり、1 のまま維持する relay では 1 人目の購読者でも送り直されない)。
 * 本リポジトリの購読実装 (`createMediaSubscriber`) は同じ description では decoder を
 * 再構成しないため、この再送は自前の購読経路に対して冪等である。
 *
 * 現状の高レベル API は H.264 / H.265 を annexb 形式で configure するため、Chromium の
 * encoder は description を返さない (parameter sets は bitstream に含まれる)。VP8 / VP9 /
 * AV1 は description を使わないため、この送り直しは canonical 形式 (avc / hev1) の
 * description が届く設定・実装で働く。
 *
 * 単体テストから固定値で駆動するため export する (パッケージ公開 API には含めない)。
 *
 * @param previous - 直前に送った Video Config (未送信なら null)
 * @param description - 今回の chunk が持つ Video Config (VP8 などでは undefined。
 *   空の description は設定として意味を持たないため値なしとして扱う)
 * @param isKeyFrame - 今回の chunk がキーフレームか (送り直しに応える境界)
 * @param resendRequested - 保持している Video Config の送り直しを要求されているか
 * @returns 今回載せる config、次回のために保持する値、送り直し要求を残すか
 */
export function resolveVideoConfigToSend(
  previous: Uint8Array | null,
  description: Uint8Array | undefined,
  isKeyFrame: boolean,
  resendRequested: boolean,
): CodecConfigResolution {
  // 新しい値が現れたときは、送り直し要求の有無にかかわらずそれを載せる
  if (
    description !== undefined &&
    description.length > 0 &&
    !isSameCodecDescription(previous, description)
  ) {
    return { config: description, next: new Uint8Array(description), resendNext: false };
  }
  // 送り直し要求にはキーフレームで応える (同じ値でも 1 度だけ載せ直す)
  if (isKeyFrame && resendRequested && previous !== null) {
    return { config: previous, next: previous, resendNext: false };
  }
  // 載せる値が無い (キーフレーム以外、または保持値が無い) 場合は何も載せず、
  // 要求だけを次の Object へ残す
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
  // 送信済みの catalog の Group ID。初期送信は start のたびに払い出し、送り直しのたびに +1 する。
  // catalog の更新は必ず新しい Group の先頭 Object (Object ID 0) に置き、同じ Location に
  // 別の payload を載せない (draft-ietf-moq-transport-22 §2.1 / §7.1、draft-ietf-moq-msf-01 §5)。
  // §6.1 の単調増加 MUST も満たす。FORWARD=0 で見送った送り直しでは消費しない (音声・映像が
  // encode した分だけ Group を進めるのと同じ扱い)。送信の失敗では消費する
  private catalogGroupId = 0;
  // この start で初期の catalog を送り終えたか。前回 start の currentCatalog は解放で消さない
  // ため、初期送信より前に FORWARD 0→1 が届くと前回の catalog を新しい Group ID で送ってしまい、
  // 直後の初期送信と同じ Location に別の payload が載る。初期送信が済むまでは送り直さない
  private catalogInitialSent = false;
  // catalog を送り直す予約 (MAX_CACHE_DURATION に基づく間隔)。stop / close / ピア起点の
  // close の解放で取り消す
  private catalogRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  // catalog を送り直す間隔 (ミリ秒)。実時間を待つテストが短い間隔へ差し替えられるよう
  // インスタンスフィールドにする (既定は MAX_CACHE_DURATION から導出した値)
  private catalogRepublishInterval = CATALOG_REPUBLISH_DEFAULT_INTERVAL_MS;
  // 直前に VIDEO_CONFIG として送信した description。同じ値の重複送出を避けつつ、
  // forwardState が 1 になった時点の送り直しの材料にもする
  private lastSentVideoConfig: Uint8Array | null = null;
  // forwardState が 0 から 1 になった時点で立てる Video Config の送り直し要求。
  // 映像の description はキーフレームごとには再出現しないため、次のキーフレームの
  // Object に保持値を 1 度だけ載せ直し、載せた時点で解消する
  private videoConfigResendRequested = false;

  // 送らない出力が持っていた Video Config (まだ送っていない値)。理由は pendingAudioConfig
  // と同じ (canonical 形式の description は configure 後の最初の出力にしか載らない)
  private pendingVideoConfig: Uint8Array | null = null;
  // 直前に AUDIO_CONFIG として送った description。同じ値の重複送出を避けつつ、
  // forwardState が 1 になった時点の送り直しの材料にもする
  private lastSentAudioConfig: Uint8Array | null = null;
  // forwardState が 0 から 1 になった時点で立てる Audio Config の送り直し要求。
  // 次の Object に保持値を 1 度だけ載せ直し、載せた時点で解消する
  private audioConfigResendRequested = false;

  // 送らない出力が持っていた Audio Config (まだ送っていない値)
  //
  // description は configure 後の最初の出力 (と構成が変わったとき) にしか載らないため、
  // 配信を止める直前に届いた出力を捨てると、復号に必要な Audio Config を以後の配信で
  // 送れなくなる (AAC は AudioSpecificConfig が必須)。捨てる出力の値はここに残し、
  // 次に送る Object で載せる
  private pendingAudioConfig: Uint8Array | null = null;
  private audioPublisher: Publisher | null = null;
  private videoPublisher: Publisher | null = null;

  // MediaStream 関連
  private mediaStream: MediaStream | null = null;
  private audioFrameSource: AudioFrameSource | null = null;
  private videoFrameSource: VideoFrameSource | null = null;
  private audioFrameReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  // 読んだ映像フレームの timestamp とそのときの壁時計から、映像の LOC TIMESTAMP を
  // 壁時計に換算する (mediaClock.ts)。フレームの取得元を作るたびに作り直す
  private videoWallClock = new WallClockMapper();

  // 音声の TIMESTAMP を壁時計へ合わせる (audioTimestampClock.ts)。マイクや Web Audio の
  // `AudioData.timestamp` は壁時計と同じ時計ではないため、読み出した壁時計との
  // 差の最小値へ原点だけを合わせる。音声の配信を始めるたびに作り直す
  private audioTimestampClock = new AudioTimestampClock();

  // 音声が live から遅れたときに古いフレームを捨てて追いつく (audioPublishCatchUp.ts)。
  // 方針は options で選び、観測は配信を始めるたびに消す
  private audioCatchUp: AudioPublishCatchUp;

  // エンコーダー
  private audioEncoder: AudioEncoderWrapper | null = null;
  private videoEncoder: VideoEncoderWrapper | null = null;

  // 統計情報
  private audioStats: AudioStats = {
    framesSent: 0,
    bytesSent: 0,
    currentGroupId: 0,
    // 実測値は getStats() が読む時点の観測から作る
    // (audioTimestampClock.snapshot() / audioCatchUp.snapshot())
    timestampOffset: null,
    catchUp: null,
    tailFlushedFrames: 0,
    tailFlushedMs: 0,
    tailDroppedFrames: 0,
    tailDroppedMs: 0,
    tailFlushTimeoutCount: 0,
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
  // (startNewGroup() で null に戻す)
  private lastKeyFrameTimestampUs: number | null = null;
  // 音声・映像の初回オブジェクト送信済みか (初回は加算せず初期値を送る)
  private audioGroupStarted = false;
  private videoGroupStarted = false;

  // キーフレーム間隔
  private keyframeInterval: number;

  // 処理ループの中断フラグ
  private processingActive = false;
  /** 周期読み出しのループが生きているか (自然終了を含む。停止時の drain 待ちの判定に使う) */
  private processingLoopRunning = false;

  // 処理ループの世代 (pause / stop / close で加算し、
  // 旧ループの encode と onError 通知を抑止する)
  private processingGeneration = 0;
  // 停止時の末尾 drain の状態。null なら通常の周期読み出し
  private audioTailDrain: AudioTailDrainState | null = null;
  // 末尾の drain の完了 (stop / close が同時に呼ばれたときに共有する)
  private audioTailCompletion: Promise<void> | null = null;
  // 停止の処理中か (二重 stop の防止)
  private stopInProgress = false;
  // datagram 配送の停止で末尾を送ったため、PUBLISH_DONE の前に猶予を待つか
  private pendingAudioTailGrace = false;

  // 映像の符号化を依頼した時点の世代 (入力フレームの timestamp を鍵にする)。
  // WebCodecs は出力の到着順を保証しないため、到着順ではなく timestamp で依頼に対応づける。
  // 配信を止めた時点で閉じた Subgroup へ送らないことと、停止と再開をまたいだ古い出力が
  // 新しい Group の先頭に混ざらないようにするために使う。配信ごとの初期化で消す
  private readonly videoEncodeGenerations = new Map<number, number>();

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

    // 音声の追いつき方は options で選ぶ (省略した場合は "drop"。audioPublishCatchUp.ts)
    this.audioCatchUp = new AudioPublishCatchUp({ policy: options.audioCatchUp ?? "drop" });

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
   * 接続・Publisher の作成・音声の取り出し経路の準備 (形式の確定と対応確認)・catalog の
   * 送信・エンコーダーの設定・処理ループの起動を行い "publishing" にする。各段階の await の
   * 直後に解放が先行していないかを検査し、先行していればそれ以上リソースを作らずに失敗する。
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
    if (this.stopInProgress) {
      throw new Error("cannot start while stopping");
    }
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

      // 音声の送り方がこのセッションで送れるかを、PUBLISH の完了に依存させずに確かめる
      this.assertAudioDeliverySupported();

      // Publisher を作成 (音声・映像の PUBLISH の往復)
      await this.createPublishers();
      // 解放が先行していれば、これ以上リソースを作らずに失敗する。解放は mediaStream を
      // 切り離すため音声の取り出し経路も setupEncoders も素通りするが、解放が進行中
      // (切り離しの前) でもここで止める。進めると、作ったフレームリーダーとエンコーダーが
      // 巻き戻しまで残る
      this.assertStartNotDisposed(startGeneration);

      // 音声の取り出し経路を作り、Catalog とエンコーダーが使う形式を確定する。
      // PUBLISH の往復より後に作る。経路は読まれるまで `AudioData` を溜め続けるため
      // (Web Audio 経路)、先に作ると往復の分が遅れとして捨てられる (audioPublishCatchUp)
      await this.prepareAudioFrameSource();
      this.assertStartNotDisposed(startGeneration);

      // Catalog を publish (取り出した形式を載せる)。draft-ietf-moq-msf-01 §11.2 は
      // media track の Object より前に catalog の Object を publish する MUST を定めるため、
      // 処理ループの起動より前に行う
      await this.publishCatalog();
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
   * 音声の送り方が接続したセッションで使えるかを確かめる
   *
   * reliability が "reliable-only" のセッション (HTTP/2 上の WebTransport、
   * draft-ietf-webtrans-http2) では datagram も再送され、順序も保たれる
   * (draft-ietf-moq-transport-22 §6.2)。その場合 `delivery: "datagram"` は「再送されない
   * 経路で送る」という意味を失うため、黙って受けない。devtools の実装は Subgroup へ戻すが、
   * 高レベル API が宣言された設定を裏で変えると、送り方を計器や購読側の前提から読めなくなる。
   * 指定されたら明示的に拒否する。既定の配送方式も datagram であるため、省略した場合も
   * 同じ理由で拒否する (Subgroup で送るには明示する)
   *
   * 判定は接続の直後に行う (PUBLISH の完了を待つと、relay が PUBLISH を拒否したときに
   * 設定のエラーではなく接続のエラーだけが返る)
   */
  private assertAudioDeliverySupported(): void {
    if (this.resolvedAudio?.delivery !== "datagram") {
      return;
    }
    if (this.session?.reliability === "reliable-only") {
      throw new Error(
        'audio delivery "datagram" requires datagrams, but the session reliability is "reliable-only"; specify delivery: "subgroup" to send audio over subgroups',
      );
    }
  }

  /**
   * 音声の取り出し経路を作り、Catalog とエンコーダーが使う形式を確定し、符号化の対応を確かめる
   *
   * 取り出し経路が実際に流す形式はブラウザが決める (src/audioSource.ts)。要求値のまま
   * Catalog とエンコーダーを構成すると、Chromium の `AudioEncoder` は `AudioData` の形式が
   * 設定と違うときにリサンプルもチャンネル変換もせずエラーにし、符号化が止まる
   * (理由と仕様の根拠は createMedia/settings.ts の withCapturedAudioFormat を参照)。
   * ここで 1 度だけ作って返った値を resolvedAudio へ写し、catalog を publish する前に
   * 確定させる (createCatalogTracks と setupEncoders が同じ値を使う)。
   *
   * 読み出しの reader もここで取る。取り出し経路を作ってから reader を取るまでに await を
   * 挟むと、その間に解放が先行したとき (取り消す reader がまだ無い) に経路が残る。解放は
   * reader の cancel と audioFrameSource の close の両方を行う (disposeAllResources)。
   *
   * 取り出した形式がコーデックで符号化できない場合は、configure も catalog の送信も
   * せずに start() を失敗させる。`AudioEncoder.configure` は未対応の設定でも同期の例外を
   * 投げず非同期のエラーになるため、送ってからでは音声 object が届かないトラックを
   * 宣言した catalog が購読側へ残る。対応の申告 (`isConfigSupported`) だけでは実際に
   * 符号化できるかを保証しないため、無音を 1 チャンク実際に符号化して確かめる
   * (`probeAudioEncoderConfig`)。
   */
  private async prepareAudioFrameSource(): Promise<void> {
    if (!this.options.audio || !this.mediaStream) {
      return;
    }
    const audioTrack = this.mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      return;
    }
    const audio = this.resolvedAudio;
    if (!audio) {
      throw new Error("audio settings not resolved");
    }
    // 取り出し経路が無いブラウザでは音声を黙って諦めない。音声トラックを宣言した catalog を
    // 送った後に object が出せない状態になるため、createAudioFrameSource のエラー
    // (経路が無い旨のメッセージ) として start() を失敗させる (catalog はまだ送っていない)
    const frameSource = await createAudioFrameSource(audioTrack, {
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    });
    this.audioFrameSource = frameSource;
    this.audioFrameReader = frameSource.readable.getReader();
    const captured = withCapturedAudioFormat(audio, {
      sampleRate: frameSource.sampleRate,
      channels: frameSource.channels,
    });
    this.resolvedAudio = captured;
    const config = getAudioEncoderConfig(
      captured.codec,
      captured.bitrate,
      captured.sampleRate,
      captured.channels,
    );
    // 対応の申告だけでは実際に符号化できるかを保証しない。AAC はプラットフォームの
    // エンコーダーが対応する形式とビットレートの下限を持ち、範囲外では
    // isConfigSupported が true を返しても最初の符号化が非同期のエラーになる
    // (Chrome 155 の macOS で実測)。確認しないと、音声 Object が届かないトラックを
    // catalog に宣言したまま配信を始めてしまうため、無音を 1 チャンク実際に符号化する
    const probe = await probeAudioEncoderConfig(config);
    if (!probe.supported) {
      const reason = probe.reason === undefined ? "" : `: ${probe.reason}`;
      throw new Error(
        `audio encoder does not support the captured format: codec=${captured.codec}, codecString=${config.codec}, sampleRate=${captured.sampleRate}, channels=${captured.channels}, bitrate=${captured.bitrate}${reason}`,
      );
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
   *
   * 開いている Subgroup ストリームを閉じる (理由と契約は codec/types.ts の
   * MediaPublisher.pause() を参照)。draft-ietf-moq-transport-22 §11.3.2。
   */
  pause(): void {
    // close() は末尾 flush の間も state を "publishing" のままにするため、世代を進めると
    // 末尾の出力が捨てられる。停止と同じく、終端へ動く途中は拒否する。ピア起点の close は
    // closing を立てずに解放するため disposalInFlight も見る
    if (this.closing !== null || this.disposalInFlight !== null) {
      throw new Error("cannot pause while closing");
    }
    if (this.currentState !== "publishing") {
      throw new Error(`cannot pause in state: ${this.currentState}`);
    }
    // 停止の末尾 flush の間は世代を進めない (進めると末尾の出力が捨てられる)
    if (this.stopInProgress) {
      throw new Error("cannot pause while stopping");
    }

    this.processingActive = false;
    this.processingGeneration++;
    // setState はアプリの onStateChange を同期で呼ぶ。そこで throw されても後始末が
    // 残らないよう、閉じる操作を先に行う
    this.closeSubgroups();
    this.setState("paused");
  }

  /**
   * 配信を再開する
   *
   * 現世代のまま処理ループを起動する。 paused からのみ到達する。
   * 次に encode するフレームをキーフレームにして新しい Group から始める (理由は
   * codec/types.ts の MediaPublisher.resume() を参照)。
   * 旧ループは次フレーム到着時に世代不一致で encode せず終了し、
   * 失敗通知も抑止されるため、 encode と onError の多重化は起きない
   * (read() 待機自体の一時的な並行は残る)。
   * reader は pause で破棄していないため再取得は不要である。
   */
  resume(): void {
    // close() の末尾 flush の間は処理ループを起こさない。ピア起点の close も同じ
    if (this.closing !== null || this.disposalInFlight !== null) {
      throw new Error("cannot resume while closing");
    }
    if (this.currentState !== "paused") {
      throw new Error(`cannot resume in state: ${this.currentState}`);
    }
    // 停止の末尾 flush の間は処理ループを起こさない (停止の受付後のフレームを送らない)
    if (this.stopInProgress) {
      throw new Error("cannot resume while stopping");
    }

    this.processingActive = true;
    // 閉じた Group へ送り直さないよう、次の encode するフレームをキーフレームにして新しい
    // Group を始める (startNewGroup() と同じ効果)。state が "publishing" に戻る前に
    // 行うため、startNewGroup() を呼ぶ順序には依存させない
    this.lastKeyFrameTimestampUs = null;
    this.startProcessingLoops();
    this.setState("publishing");
  }

  /**
   * 開いている Subgroup を閉じる
   *
   * 開いているものが無い track と、既に closed の Publisher では何もしない
   * (`Publisher.closeSubgroup()` の契約)。戻り値は reject しないため待たない
   */
  private closeSubgroups(): void {
    for (const publisher of [this.catalogPublisher, this.audioPublisher, this.videoPublisher]) {
      if (publisher !== null) {
        void publisher.closeSubgroup();
      }
    }
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
    // 末尾 flush を待っている間の二重 stop は受け付けない (並行呼び出しは未対応)
    if (this.stopInProgress) {
      throw new Error("cannot stop while stopping");
    }
    if (this.currentState !== "publishing" && this.currentState !== "paused") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    this.stopInProgress = true;
    try {
      // 末尾 flush: 停止の受付時に確定した範囲 (読んだフレームと encoder の中身) を
      // 符号化して送り切る。世代はこの時点では進めない (進めると末尾の出力が
      // 世代不一致で捨てられる)。ピア起点の解放が進行中なら session が閉じているため
      // 送れないので行わない
      if (this.disposalInFlight === null) {
        await this.finishAudioTail();
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
    } finally {
      this.stopInProgress = false;
    }
  }

  /**
   * 次に encode するフレームで新しい Group を始める (キーフレームにする)
   *
   * 直前のキーフレームの記録を消す。破棄したフレームは記録を更新しないため、
   * 新しい Group は次に encode するフレームから始まる。
   */
  startNewGroup(): void {
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

    // 解放 (進行中ならそれを共有する) と終端遷移を 1 つの Promise にまとめ、同時に呼ばれた
    // close() と共有する。末尾 flush は世代を進める前に行う (進めると末尾の出力が
    // 世代不一致で捨てられる)。closing は待つ前に立てるため、この間に stop() が
    // 入ると cannot stop while closing で拒否される
    const closing = (async (): Promise<void> => {
      if (this.disposalInFlight === null) {
        await this.finishAudioTail();
      }
      // 世代を進める。 close 後の cancel 解決と再 start 後の新ループが
      // 同一世代を共有しないようにする (旧ループ失敗の誤通知防止)
      this.processingGeneration++;
      // 利用者起点の解放として数える (ピア起点の close の解放と重なった場合はこちらが
      // 終端を決める)
      this.userDisposalCount++;
      await this.runDisposal();
      this.transitionToClosed();
    })();
    // 解放 (進行中ならそれを共有する) と終端遷移を 1 つの Promise にまとめ、同時に呼ばれた
    // close() と共有する。解放が成功したときだけ終端へ進む
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
      audio: this.options.audio
        ? {
            ...this.audioStats,
            timestampOffset: this.audioTimestampClock.snapshot(),
            catchUp: this.audioCatchUp.snapshot(),
          }
        : null,
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
   * onError が 2 回呼ばれる。catalog 送信 (publishCatalog) の await の reject は
   * start() の catch に届く (catalog だけ await するため)。
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

  /**
   * Catalog・音声・映像の Publisher を作成する (PUBLISH の往復)
   *
   * catalog の Object の送信は publishCatalog が担う。start() はこの後に音声の取り出し
   * 経路を作り、載せる形式を確定してから publishCatalog を呼ぶ
   */
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
    // maxCacheDuration を指定して relay の cache に残す
    // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の過去の全 Group ID を
    // 上回る。start() のたびに新しく払い出す (音声・映像と同じ規則であり、
    // stop() → start() を跨いでも 0 に戻らない)
    this.catalogGroupId = allocateInitialGroupId();
    // この start の初期送信が済むまで送り直さない (理由は catalogInitialSent の宣言を参照)
    this.catalogInitialSent = false;
    this.catalogPublisher = await this.session.publish(
      namespace,
      CATALOG_TRACK_NAME,
      {
        error: (error) => this.callbacks.onError?.(error),
        // relay は購読者が居ない間 upstream の購読を pause してよい (MAY。
        // draft-ietf-moq-transport-22 §7.6。pause するかは §7.2 の裁量)。paused の間は
        // publisher が Object を送らないため (§3.1.1)、配信の開始時に送った catalog は
        // 後から購読を始めた相手へ届かない。FORWARD が 1 になった時点で送り直す
        // (送り直しの契約と残りの根拠は republishCatalog の JSDoc を参照)
        onForwardStateChange: (forward) => {
          if (forward) {
            this.republishCatalog();
          }
        },
      },
      {
        maxCacheDuration: BigInt(CATALOG_MAX_CACHE_DURATION_MS),
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
          // 複数の要求は、直前のキーフレームの記録を消すだけなので 1 つの Group にまとまる
          onNewGroupRequest: () => this.startNewGroup(),
          // 映像の description は configure 後の最初の出力と構成変更時にしか現れない
          // ため、forwardState が 1 になった時点で保持値の送り直しを要求し、
          // handleVideoEncodedChunk が次のキーフレームの Object に載せ直す
          // (判断の詳細は resolveVideoConfigToSend の JSDoc を参照)
          onForwardStateChange: (forward) => {
            if (forward) {
              this.videoConfigResendRequested = true;
            }
          },
        },
        { ...VIDEO_PUBLISH_OPTIONS, ...authorizationTokenOptions },
      );
    }
  }

  /**
   * Catalog を作成して publish する
   *
   * start() が音声の取り出し経路を作り、載せる形式を確定してから呼ぶ。経路より先に送ると、
   * 宣言した形式と実際に流れる形式が食い違い、購読側が異なる設定で復号することになる。
   * 初期送信のときに publisher が active でなければ、catalog を送らないまま media の Object を
   * 流さずに start() を失敗させる (送れないまま進むと §11.2 の MUST に反する)。
   *
   * draft-ietf-moq-msf-01 §5: All catalog updates, both independent and delta,
   * MUST be mapped to MOQT sub-group 0. The first Object (with Object ID 0) in
   * any Group in a catalog track MUST hold an independent copy of the catalog.
   *
   * draft-ietf-moq-msf-01 §11.2: An MSF publisher MUST publish a catalog track
   * object before publishing any media track objects.
   */
  private async publishCatalog(): Promise<void> {
    // 初期送信の時点で publisher が active でなければ、この start では catalog を 1 度も
    // 送れない (送り直しは catalogInitialSent が立つまで行われない)。catalog の Object より
    // 先に media の Object を送ることは §11.2 の MUST に反するため、送らないまま処理ループを
    // 起動せずに start() を失敗させる (巻き戻しは start() の catch が行う)
    if (!this.catalogPublisher || this.catalogPublisher.state !== "active") {
      throw new Error(
        `cannot publish the catalog: the catalog publisher state is ${this.catalogPublisher?.state ?? "missing"}`,
      );
    }

    const catalog = this.buildCatalog();

    // Catalog object が WebTransport stream に書き込み完了するまで await する。
    // draft-ietf-moq-transport-22 §3.2: FETCH は object が publish されていなければ
    // INVALID_RANGE で FETCH_ERROR を返す MUST。fire-and-forget だと publisher.start() の
    // return 後すぐに subscriber が join した場合に race を踏むため、catalog だけは確実に
    // 書き込み完了してから return する。
    // objectId=0 は draft-ietf-moq-msf-01 §5 で MUST 規定 (独立した catalog は Group の
    // 先頭 Object)。Priority は購読開始の前提になるため最高優先で送る
    await this.sendCatalogObject(catalog, this.catalogGroupId);

    // 初期送信が済んだ。以後の FORWARD 0→1 は送り直しとして扱う
    this.catalogInitialSent = true;

    // 配信の開始から MAX_CACHE_DURATION を過ぎた後で購読を始めた相手にも catalog を
    // 届けるため、cache から落ちる前に定期的に送り直す (間隔の根拠は catalogRepublish.ts)
    this.scheduleCatalogRepublish();
  }

  /**
   * Catalog を組み立てて保持する
   *
   * 送り直しでは組み立て直さず、ここで保持した catalog を使う (トラック構成が変わらない
   * 限り payload は同じでよい。draft-ietf-moq-msf-01 §5 はトラック構成が変わったときと
   * cache から落ちる程度の時間が経過したときに publish する SHOULD とする)。
   * 送り直しでも同じ catalog instance を送るため、generatedAt (§5.1.2 の「この catalog
   * instance を生成した時刻」) は配信の開始時に組み立てた時刻のままになる。
   */
  private buildCatalog(): Catalog {
    const tracks = this.createCatalogTracks();
    const catalog = createCatalog(tracks, {
      generatedAt: Date.now(),
    });

    // 作成した Catalog を保存
    this.currentCatalog = catalog;

    return catalog;
  }

  /**
   * Catalog を Group の先頭 Object として送り、その Subgroup を閉じる
   *
   * 送信は Group の先頭 Object (Object ID 0) に固定する (draft-ietf-moq-msf-01 §5)。
   * 呼び出し元 (publishCatalog / republishCatalog) は同期で状態を見てからここへ入るため、
   * この検査は現状到達しない。将来 await を挟む呼び出し元が増えても「active でなければ
   * 送らない」を送信点で保証するための保険であり、届いた場合は送らずに失敗させる
   * (黙って戻すと、catalog の Object を送らないまま media の Object が流れる)。
   *
   * catalog は delta を送らないため、1 Group に載せる Object は常に 1 つになる
   * (draft-ietf-moq-msf-01 §5 は同じ Group の Object ID 1 以降を delta update とする MUST を
   * 定めるが、本ライブラリは delta を送らない)。この Object を書き終えた時点で Subgroup に
   * 続く Object は無いため、endOfSubgroup を渡してその場で FIN で閉じる
   * (draft-ietf-moq-transport-22 §11.3.2 の MUST)。閉じないと次の送り直し (既定 30 秒後)
   * まで Subgroup が開いたままになる。開いた Subgroup で次の Object を待つ購読側は、
   * §12.2 の DATA_STREAM_TIMEOUT でセッションを閉じうる (同節は STOP_SENDING か購読の終了を
   * MAY とするが、moqt-rs の moq-sub はセッションごと閉じる)。
   */
  private async sendCatalogObject(catalog: Catalog, groupId: number): Promise<void> {
    if (!this.catalogPublisher || this.catalogPublisher.state !== "active") {
      throw new Error(
        `cannot send the catalog: the catalog publisher state is ${this.catalogPublisher?.state ?? "missing"}`,
      );
    }

    await this.catalogPublisher.sendObject({
      groupId,
      objectId: 0,
      payload: encodeCatalog(catalog),
      priority: PRIORITY_CATALOG,
      endOfSubgroup: true,
    });
  }

  /**
   * 保持している Catalog を新しい Group で送り直す
   *
   * FORWARD が 0 から 1 になった時点 (forwardState 変化のコールバック) と、送り直しの
   * 予約の満了時に呼ぶ。Group ID を +1 して Group の先頭 Object として送る
   * (draft-ietf-moq-msf-01 §5 / §6.1。草案の改訂でこれらの規定が変わる可能性がある)。
   * FORWARD が 1 のまま 2 人目以降の購読者が接続した場合は変化が起きないため送り直さない
   * (音声・映像の config の送り直しと同じ制約)。
   * forwardState 変化のコールバックは同期であり送信の完了を待てないため、送信は void で
   * 起動する。実物の session 層の送信失敗は publisher の error コールバック経由で onError に
   * 届き、事前検証の reject には publisher が通知済みの印を付けるため通知しない
   * (start 失敗の通知と同じ扱いであり、1 件の失敗で onError が 2 回呼ばれるのを防ぐ)。
   * ここで通知するのは、契約上あり得る印なしの reject に対する保険である。
   * 通知が throw しても未処理の rejection にしない (handleSessionClose と同じ形)。
   */
  private republishCatalog(): void {
    const catalog = this.currentCatalog;
    const publisher = this.catalogPublisher;
    // 解放が進行中なら送らない (解放は await を挟むため、その間に FORWARD 0→1 が届く窓がある)
    if (catalog === null || publisher === null || this.disposalInFlight !== null) {
      return;
    }
    // ピアが catalog の PUBLISH を cancel すると (STOP_SENDING。draft-ietf-moq-transport-22
    // §3.1.2) publisher は closed になり、配送する相手が居なくなる。送り直しを止め、予約も残さない
    // (docs/HIGH_LEVEL_API.md の「カタログの送り直し」を参照)
    if (publisher.state !== "active") {
      this.clearCatalogRepublishTimer();
      return;
    }
    // この start の初期 catalog を送る前は送り直さない (理由は catalogInitialSent の宣言を参照)。
    // 初期送信は start() が publishCatalog で行い (active でなければ start が失敗する)、
    // publisher が FORWARD=0 で見送った場合は初期送信の完了として扱うため、次の FORWARD 0→1 で
    // 改めて送り直す
    if (!this.catalogInitialSent) {
      return;
    }
    // FORWARD=0 の間は publisher が見送るため、送らない場合は Group ID を消費しない
    // (理由は catalogGroupId の宣言を参照)。予約は維持し、FORWARD が 1 になった時点の
    // 送り直しに備える
    if (!publisher.forwardState) {
      this.scheduleCatalogRepublish();
      return;
    }

    const groupId = this.catalogGroupId + 1;
    this.catalogGroupId = groupId;
    noteGroupId(groupId);
    // 次の送り直しをこの送信から数え直す
    this.scheduleCatalogRepublish();
    void this.sendCatalogObject(catalog, groupId).catch((error: unknown) => {
      if (isErrorNotifiedByPublisher(error)) {
        return;
      }
      try {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // 通知の失敗を伝える経路がこれ以上無い
      }
    });
  }

  /**
   * Catalog の送り直しを予約する
   *
   * 直前の予約があれば取り消して、この時点から数え直す。
   */
  private scheduleCatalogRepublish(): void {
    this.clearCatalogRepublishTimer();
    this.catalogRepublishTimer = setTimeout(() => {
      this.catalogRepublishTimer = null;
      this.republishCatalog();
    }, this.catalogRepublishInterval);
  }

  /**
   * Catalog の送り直しの予約を取り消す
   *
   * 予約を入れ直す前 (scheduleCatalogRepublish) と、解放の開始時、catalog Publisher の
   * 切り離し直後に呼ぶ。切り離し直後の 2 回目は、解放の await 中に start() が await している
   * publishCatalog の続きが走って予約を入れ直す窓を塞ぐ
   */
  private clearCatalogRepublishTimer(): void {
    if (this.catalogRepublishTimer !== null) {
      clearTimeout(this.catalogRepublishTimer);
      this.catalogRepublishTimer = null;
    }
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

    // 前の配信の記録を持ち越さない (配信ごとの初期化)。音声の有無によらず消す。
    // 保留した codec description も解放時に消すが、破棄の後に届いた出力で再充填され得るため
    // ここでも消す (前の配信の値を新しい配信の最初の Object に載せない)
    this.videoEncodeGenerations.clear();
    this.pendingAudioConfig = null;
    this.pendingVideoConfig = null;

    // 音声エンコーダー
    // エンコーダーを作る条件は reader の有無にする。取り出し経路を作ったトラックを
    // もう一度読み直すと、start の途中で呼び出し側が stream から外した場合に
    // 「経路はあるのにエンコーダーが無い」状態になり得る (prepareAudioFrameSource が
    // 経路を作れなかった場合だけ reader が無い)
    if (this.options.audio && this.audioFrameReader !== null) {
      this.audioEncoder = new AudioEncoderWrapper(useWorker, {
        output: (chunk) => this.handleAudioEncodedChunk(chunk),
        error: (error) => this.callbacks.onError?.(error),
      });

      // Catalog と同じ解決済み設定を使う。形式は取り出し経路が返した値であり、
      // start() の prepareAudioFrameSource で確定している
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

      // 前の配信の観測を持ち越さない
      this.audioTimestampClock = new AudioTimestampClock();
      this.audioCatchUp.reset();
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
    // このループが生きている。停止時の drain はこのループが読み切る
    this.processingLoopRunning = true;
    const reader = this.audioFrameReader;
    const encoder = this.audioEncoder;
    if (!reader || !encoder) return;
    const generation = this.processingGeneration;
    // 1 フレーム先読み (棄却の境目をフェードで繋ぐため)
    let pending: AudioData | null = null;
    let pendingHead = false;
    let previousDropped = false;

    try {
      while (
        this.processingActive &&
        generation === this.processingGeneration &&
        encoder.state === "configured"
      ) {
        // 停止時の末尾 drain は、このループ自身が reader から読み切る (停止側からは
        // 読まない)。同じ reader を 2 か所から読むと保留中の read とフレームを
        // 取り合うためである。停止側はループの完了 (done) を待つ
        const tail = this.audioTailDrain;
        let audioData: AudioData | null = null;
        if (tail !== null) {
          // 上限と期限に達したら読み出しを止める (保留分はループを抜けた後に encode する)
          if (tail.framesRead >= tail.maxFrames || performance.now() >= tail.deadlineMs) {
            break;
          }
          // 静穏窓の間に読めたフレームだけを末尾として扱う。負けた read は
          // readAudioFrameWithin が後から閉じて捨てる (停止後の新規キャプチャは範囲外)
          const read = await readAudioFrameWithin(reader, AUDIO_TAIL_DRAIN_QUIET_MS);
          if (read.kind === "frame") {
            audioData = read.value;
          }
        } else {
          // 停止の受付より前に始めた read が残っている場合は、これが返るまで待つ (10 ms
          // 周期で次のフレームが来る)。停止の直前に capture された可能性があるため、
          // この 1 フレームは末尾に含める
          const read = await reader.read();
          if (!read.done) {
            audioData = read.value;
          }
        }
        // フレームが読めなかった (ストリームの終わり・静穏窓の期限) らループを抜ける
        if (audioData === null) {
          break;
        }
        // 停止の末尾 drain の間は、読んだフレームを末尾の範囲として記録する。旧世代の
        // ループ (pause / resume を挟んだ残り) は末尾の範囲外であるため記録しない
        const activeTail = this.audioTailDrain;
        if (activeTail !== null && generation === this.processingGeneration) {
          activeTail.framesRead++;
          activeTail.readBlocks.push({
            startMicros: audioData.timestamp,
            endMicros: audioData.timestamp + audioData.duration,
          });
        }
        if (generation !== this.processingGeneration) {
          // 旧世代ループは encode せず終了する (フレームは破棄前に閉じる)
          audioData.close();
          break;
        }

        // 読み出した壁時計と `AudioData.timestamp` の差を記録する。音声の LOC TIMESTAMP は
        // この差の最小値へ原点を合わせて作る (audioTimestampClock.ts)
        const readWallClockMicros = BigInt(
          Math.round((performance.timeOrigin + performance.now()) * 1_000),
        );
        this.audioTimestampClock.record(readWallClockMicros, audioData.timestamp);

        // 読み出しと符号化で溜まった遅れが上限を超えたフレームは、符号化せずに捨てて
        // live へ追いつく (audioPublishCatchUp.ts)。数フレームの穴は受信側の
        // concealment が埋める
        const encode = this.audioCatchUp.evaluate({
          timestampMicros: audioData.timestamp,
          generation,
          readWallClockMicros,
          appliedOffsetMicros: this.audioTimestampClock.appliedMicros,
          durationMicros: audioData.duration,
          nowMs: performance.now(),
        });
        // 棄却で飛んだ境目は、そのまま符号化へ渡すと波形が飛んでクリックとして聞こえる。
        // 1 フレーム先読みして、捨てる直前のフレームの末尾と捨てた直後のフレームの先頭を
        // フェードで落とす (src/audioSpliceFade.ts)
        if (pending !== null) {
          this.encodeWithSpliceFade(encoder, pending, pendingHead, !encode);
          pending = null;
        }
        if (encode) {
          pending = audioData;
          pendingHead = previousDropped;
          previousDropped = false;
          continue;
        }
        previousDropped = true;
        audioData.close();
      }
      if (pending !== null) {
        // ループを抜けたら保留分を渡す (末尾は落とさない)
        this.encodeWithSpliceFade(encoder, pending, pendingHead, false);
        pending = null;
      }
    } catch (error) {
      // 旧世代ループの失敗は通知しない (多重発火の防止)
      if (this.processingActive && generation === this.processingGeneration) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (generation === this.processingGeneration) {
        // 現世代のループが終わった (正常終了・reader の終わり・エラー)。停止時の drain は
        // もう待つ相手がいないため、finishAudioTail が待たないようにする
        this.processingLoopRunning = false;
        // 停止側 (finishAudioTail) へ読み出しの完了を知らせる。旧世代のループは
        // まだ現世代が読み切っていないため、完了として扱わない
        this.audioTailDrain?.resolveDone();
      }
    }
  }

  /**
   * 棄却で飛んだ境目をフェードで繋いで符号化へ渡す
   *
   * 端を落とすときだけ `AudioData` を作り直す (その他のフレームはそのまま渡す)。
   * `fadeSpliceEdge` はチャンネルごとの配列を扱うため、平面ごとに取り出して戻す
   */
  private encodeWithSpliceFade(
    encoder: AudioEncoderWrapper,
    data: AudioData,
    head: boolean,
    tail: boolean,
  ): void {
    try {
      if (!head && !tail) {
        encoder.encode(data);
        return;
      }
      let planes: AudioSamples[] = [];
      for (let plane = 0; plane < data.numberOfChannels; plane++) {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: plane, format: "f32-planar" });
        planes.push(samples);
      }
      const merged = mergeFadedPlanes(planes, data.sampleRate, { head, tail });
      const replacement = new AudioData({
        format: "f32-planar",
        sampleRate: data.sampleRate,
        numberOfFrames: data.numberOfFrames,
        numberOfChannels: data.numberOfChannels,
        timestamp: data.timestamp,
        data: merged,
      });
      encoder.encode(replacement);
      replacement.close();
    } finally {
      data.close();
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
          // ループ条件のエンコーダーの状態は reader.read() の前にしか評価されないため、
          // 読み取り中に実行時エラーで使えなくなったフレームはここで判定する。encode に渡しても
          // Worker モードでは Worker へ送られず警告が出るだけであり、直接実行モードでは
          // isCodecConfigured が false になって無言で破棄される。破棄として数える
          if (encoder.state === "configured" && encoder.encodeQueueSize <= 2) {
            // キーフレームの判定と直前のキーフレームの更新は、実際に encode する
            // フレームだけで行う。破棄するフレームでも判定と更新を行うと、
            // startNewGroup() が消した記録を破棄した分だけ進めてしまい、キーフレームの
            // 要求を消費する。要求は次の間隔まで現れなくなる。据え置いた記録で次の
            // フレームが判定を受けるため、繰り越し状態を持たずに要求は次に encode する
            // フレームへ移る
            const isKeyFrame = shouldSendKeyFrame(
              this.lastKeyFrameTimestampUs,
              frame.timestamp,
              this.keyframeInterval,
            );
            encoder.encode(frame, { keyFrame: isKeyFrame });
            // 出力が返ったときに、依頼した時点の世代と比べて送信の可否を決める。
            // 依頼の直後に pause した場合、この出力は閉じた Subgroup へ送らない
            recordEncodeGeneration(this.videoEncodeGenerations, generation, frame.timestamp);
            // 記録の更新は encode の後ろに置く。encode が同期 throw した場合は encode して
            // いないため記録を進めず、次のフレームが同じ記録で判定を受ける
            if (isKeyFrame) {
              this.lastKeyFrameTimestampUs = frame.timestamp;
            }
          } else {
            // エンコード能力を超えた入力はエンコードせず破棄する (待たない)。
            // 破棄した数を統計に残す。実行時エラーでエンコーダーが使えなくなったときに
            // 読み取っていたフレームもここに含め、閉じた後は処理ループが終了するため
            // 以後のフレームは読み取らず数えない
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
    // キューに溜まっている音声の長さを測り、この chunk が覆う最初の投入の timestamp を
    // 受け取る。送らない chunk でも測るため、送信の可否より先に記録する
    // (audioPublishCatchUp.ts)
    const { timestampMicros, generation: encodedGeneration } = this.audioCatchUp.recordEncodedChunk(
      {
        timestampMicros: chunk.timestamp,
        durationMicros: chunk.duration,
        nowMs: performance.now(),
      },
    );
    // 符号化を依頼した時点の世代と一致する出力だけを送る (映像と同じ規則)。
    // 対応する記録が無い出力も送らない (配信を始める前の出力、記録を捨てた後の出力)
    // 送らない出力でも description は失わない (次に送る Object で載せる)
    if (chunk.description !== undefined && chunk.description.length > 0) {
      this.pendingAudioConfig = chunk.description;
    }
    if (timestampMicros === null || encodedGeneration !== this.processingGeneration) return;
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
      selectCodecDescription(chunk.description, this.pendingAudioConfig),
      this.audioConfigResendRequested,
    );
    this.lastSentAudioConfig = next;
    this.audioConfigResendRequested = resendNext;
    // 解決に使った保留値は消す (次に同じ値を載せない)
    this.pendingAudioConfig = null;

    // LOC Properties をエンコード。
    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る
    // (draft-ietf-moq-loc-04 §2.3.1.1。TIMESCALE は付けない)。
    // `AudioData.timestamp` は壁時計ではないため、読み出した壁時計との差の
    // 最小値で原点を合わせる。まだ観測が無いときだけ従来の換算へ落とす
    // フレームを捨てると、符号化の出力の timestamp は投入したフレームの timestamp より
    // 古くなる。LOC TIMESTAMP は送るサンプルの取得時刻にする (audioPublishCatchUp.ts)
    const capturedTimestampMicros = timestampMicros;
    const wallClockMicros =
      this.audioTimestampClock.apply(capturedTimestampMicros) ??
      LOC.toUnixEpochMicroseconds(BigInt(capturedTimestampMicros), performance.timeOrigin);
    const properties = LOC.encodeAudioProperties({
      timestamp: wallClockMicros,
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
      noteGroupId(this.audioGroupId);
    }

    // 停止時の末尾 flush で送れた量を数える (送信を試みた時点で数える。失敗は
    // Publisher が onError へ通知する)
    const tail = this.audioTailDrain;
    if (tail !== null) {
      tail.sentFrames++;
      tail.sentMs += (chunk.duration ?? 0) / 1_000;
      const endMicros = timestampMicros + (chunk.duration ?? 0);
      tail.sentEndMicros =
        tail.sentEndMicros === null ? endMicros : Math.max(tail.sentEndMicros, endMicros);
    }
    const payload = chunk.data;
    this.audioStats.framesSent++;
    this.audioStats.bytesSent += payload.length + properties.length;
    this.audioStats.currentGroupId = this.audioGroupId;

    // 音声フレームは fire-and-forget (後続のオブジェクトで上書きされるため落としても良い)。
    // 送信キューに入れてから送信が終わるまでの遅れを測る (audioPublishCatchUp.ts)
    // 音声は 1 chunk = 1 Object = 1 Group であり (allocateAudioObject)、この Object を
    // 書き終えた時点でその Subgroup に続く Object は無い。endOfSubgroup を渡して閉じる
    // (draft-ietf-moq-transport-22 §11.3.2 の MUST)。datagram で送る場合は
    // sendAudioFrameFireAndForget がこのフィールドを渡さない (Datagram の endOfGroup とは
    // 別のもの。§11.2.1)
    this.sendAudioFrameFireAndForget(
      this.audioPublisher,
      {
        groupId: audioAllocation.groupId,
        objectId: audioAllocation.objectId,
        payload,
        properties,
        priority: PRIORITY_AUDIO,
        endOfSubgroup: true,
      },
      {
        timestampMicros: capturedTimestampMicros,
        capturedWallClockMs: Number(wallClockMicros) / 1_000,
        durationMs: (chunk.duration ?? 0) / 1_000,
        nowMs: performance.now(),
      },
      // 送り方は start で解決済みの設定を使う (既定は Datagram。reliable-only の
      // セッションで datagram が指定されていれば start が失敗している)
      this.resolvedAudio?.delivery ?? "datagram",
    );
  }

  private handleVideoEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void {
    // 符号化を依頼した時点の世代と一致する出力だけを送る (規則は src/encodeGeneration.ts)
    // 送らない出力でも description は失わない。保留した値は次に送る Object で載せる
    // (値が変わった出力として扱うため resolveVideoConfigToSend はキーフレームに限らず載せる)。
    // pause() の後は resume() が次の encode をキーフレームにするため、実際に載るのは
    // キーフレームになる
    if (chunk.description !== undefined && chunk.description.length > 0) {
      this.pendingVideoConfig = chunk.description;
    }
    if (
      !shouldSendEncodedChunk(
        this.videoEncodeGenerations,
        this.processingGeneration,
        chunk.timestamp,
      )
    ) {
      return;
    }
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
      noteGroupId(this.videoGroupId);
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
    // 復元できる。description は configure 後の最初の出力と構成変更時にしか現れないため、
    // 同じ値の重複送出を避けつつ後着の購読者へキーフレームで送り直す判断は
    // resolveVideoConfigToSend が持つ
    const {
      config: videoConfig,
      next: nextVideoConfig,
      resendNext: resendVideoConfigNext,
    } = resolveVideoConfigToSend(
      this.lastSentVideoConfig,
      selectCodecDescription(chunk.description, this.pendingVideoConfig),
      chunk.type === "key",
      this.videoConfigResendRequested,
    );
    this.lastSentVideoConfig = nextVideoConfig;
    this.videoConfigResendRequested = resendVideoConfigNext;
    // 解決に使った保留値は消す (次に同じ値を載せない)
    this.pendingVideoConfig = null;

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
   * 音声のフレームを fire-and-forget で送り、送信キューにいた時間を測る
   *
   * `sendFrameFireAndForget()` と同じく戻り値は使わないが、`Publisher.sendObject` の完了で
   * 「撮ってから送信が終わるまで」を記録する (audioPublishCatchUp.ts)。送信の待ちは
   * 符号化の出力より後ろにあるため、符号化のキュー (`pendingMs`) では見えない。音声は
   * 1 Object = 1 Group = 1 ストリームであり (draft-ietf-moq-loc-04 §4.1)、ストリームの
   * 生成と書き込みの待ちがそのまま遅れになる
   *
   * Datagram で送るときは完了を待つ戻り値が無いため、渡した時点で送信のキューから出た
   * ものとして記録する (送信のキュー `sendQueueMs` / `sendQueueFrames` は 0 のままになり、
   * 撮ってから渡すまでの遅れだけが `sendLagMs` に出る)。
   *
   * 同期 throw は送信キューに入っていないため、記録を作らずに通知だけする
   * (記録を作ると、完了が返らない分が残り続ける)
   *
   * @param publisher - 送信に使う音声の Publisher
   * @param params - 送る Object
   * @param send - 送信の遅れの記録に使う、撮った時刻と長さ
   * @param delivery - 音声 Object の送り方 (Subgroup か Datagram)
   */
  private sendAudioFrameFireAndForget(
    publisher: Publisher,
    params: SendObjectParams,
    send: AudioPublishCatchUpSendStart,
    delivery: AudioDelivery,
  ): void {
    let result: Promise<void> | null;
    try {
      if (delivery === "datagram") {
        // SendObjectParams をそのまま渡すと構造的部分型で通ってしまい、Datagram では読まれない
        // フィールド (status / deliveryTimeout / subgroupDeliveryTimeout) を載せても黙って
        // 無視される。意味が同じフィールドだけを明示して渡す
        const datagram = {
          groupId: params.groupId,
          objectId: params.objectId,
          payload: params.payload,
          ...(params.properties === undefined ? {} : { properties: params.properties }),
          ...(params.priority === undefined ? {} : { priority: params.priority }),
        };
        // 冗長度の数だけ同じ Object を送る。全ての copy が落ちる確率は損失率の冗長度乗に
        // なる。受信側は同じ識別子の Object の 2 回目以降を捨てる
        // (src/createMediaSubscriber.ts の `receiveAudioObject`)
        const requestedCopies = this.resolvedAudio?.redundancy ?? 1;
        const copies = Math.min(3, Math.max(1, Math.floor(requestedCopies)));
        const sends: Promise<void>[] = [];
        for (let copy = 0; copy < copies; copy++) {
          sends.push(publisher.sendDatagram(datagram));
        }
        // 停止時の末尾では、書き終えたことを PUBLISH_DONE の前に待てるようにする
        const tail = this.audioTailDrain;
        if (tail !== null) {
          tail.sendPromises.push(...sends);
        }
        result = null;
      } else {
        result = publisher.sendObject(params);
        // subgroup も停止時の末尾では送信の完了を待てるようにする (done() が待つが、
        // 待ちの上限を 1 か所に揃える)
        const tail = this.audioTailDrain;
        if (tail !== null) {
          tail.sendPromises.push(result);
        }
      }
    } catch (error) {
      // Subgroup の同期 throw は closed だけであり通知を伴わないが、Datagram の検証違反は
      // Publisher が error 通知してから throw する。1 件の失敗で 2 回通知しないよう、
      // 通知済みの失敗はここでは握る
      if (!isErrorNotifiedByPublisher(error)) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    this.audioCatchUp.recordSendStart(send);
    const complete = (): void => {
      this.audioCatchUp.recordSendComplete({
        timestampMicros: send.timestampMicros,
        completedWallClockMs: performance.timeOrigin + performance.now(),
      });
    };
    if (result === null) {
      complete();
      return;
    }
    // 失敗しても記録を消す (残すと送信のキューに残っている長さが減らない)
    void result.then(complete, complete);
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
   * Group ID・オブジェクト ID・フレーム数・Group 開始済みフラグ (音声 / 映像) である。
   * 直前に送った Video Config / Audio Config とそれらの送り直し要求は session に
   * 紐づくため破棄する (再 start では購読者が誰も前の Object を受け取っていないため、
   * 新しい encoder の最初の description を初出として送り直す必要がある)。
   * 解放のたびに session の世代番号を進める (この 1 箇所だけ)。これ以降に届く旧
   * session の close 通知は handleSessionClose が世代不一致で捨てる (stop / close /
   * start 失敗の全経路)。
   */
  private async disposeAllResources(): Promise<void> {
    this.processingActive = false;
    this.sessionGeneration++;

    // catalog の送り直しの予約を取り消す。解放の途中で満了すると、破棄中の
    // catalog Publisher へ送ろうとする
    this.clearCatalogRepublishTimer();
    this.catalogInitialSent = false;

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

    // VideoFrameSource と AudioFrameSource を解放する。音声はフレームリーダーの
    // cancel でも後始末されるが、読み出しを始めていない場合のためにここでも閉じる
    const videoFrameSource = this.videoFrameSource;
    this.videoFrameSource = null;
    await guard(() => videoFrameSource?.close());
    const audioFrameSource = this.audioFrameSource;
    this.audioFrameSource = null;
    await guard(() => audioFrameSource?.close());
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
    // 解放の途中 (フレームリーダーの解放の await など) に start() が await している
    // publishCatalog の続きが走ると予約が入り直す。参照を切り離した時点でもう一度取り消す
    // (切り離し後に予約が入っても republishCatalog は publisher の null で送信も再予約もしないが、
    // 使われない予約を残さない)
    this.clearCatalogRepublishTimer();
    await guard(async () => {
      if (catalogPublisher && catalogPublisher.state === "active") {
        await catalogPublisher.done();
      }
    });
    // datagram 配送の停止では、末尾の datagram の write 完了 (finishAudioTail が待つ) の
    // 後に PUBLISH_DONE を送る。stream と datagram の順序保証が無いため、送信完了の後に
    // 猶予を置いてから PUBLISH_DONE を送る
    if (this.pendingAudioTailGrace) {
      this.pendingAudioTailGrace = false;
      await guard(() => delayMs(AUDIO_TAIL_PUBLISH_DONE_GRACE_MS));
    }
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
    this.pendingAudioConfig = null;
    const videoPublisher = this.videoPublisher;
    this.videoPublisher = null;
    await guard(async () => {
      if (videoPublisher && videoPublisher.state === "active") {
        await videoPublisher.done();
      }
    });
    // encoder と Publisher を切り離した後に Video Config の保持値と送り直し要求を
    // 破棄する (破棄中に届いた出力で再充填されないようにする)
    this.lastSentVideoConfig = null;
    this.videoConfigResendRequested = false;
    this.pendingVideoConfig = null;

    // セッションを閉じる
    const session = this.session;
    this.session = null;
    await guard(async () => {
      if (session) {
        await session.close();
      }
    });

    // 停止時の末尾 flush の状態を戻す (再 start は通常の周期読み出しから始める)
    this.audioTailDrain = null;
    this.pendingAudioTailGrace = false;

    if (firstFailure !== null) {
      const failure: Error = firstFailure;
      throw failure;
    }
  }

  /**
   * 停止の受付時の末尾を符号化して送り切る
   *
   * 順序は次のとおり。
   *
   * 1. 周期読み出しのループ自身に、取り込みキューに残っている分を読ませる
   *    (ループ内で `tailDrain` を参照して読み切る。停止側からは読まない)
   * 2. 保留分 (1 フレーム先読み) を含めて encode する (ループを抜けた後の処理)
   * 3. `AudioEncoderWrapper.flush()` で encoder に残った出力を待つ
   * 4. 末尾の送信 (datagram の write と subgroup の送信) の完了を待つ
   *
   * この間は `processingGeneration` を進めない。進めると世代不一致で末尾の出力が
   * 捨てられるためである。「停止の受付時に確定した範囲」= 停止の受付時点の世代の
   * 出力までを送り、flush が終わってから stop / close が世代を進める。
   *
   * 全体の上限は `AUDIO_TAIL_DRAIN_MAX_MS` + `AUDIO_TAIL_FLUSH_MAX_MS`。
   * 上限で打ち切った場合は encoder の残りを送れなかったことになり、
   * `tailFlushTimeoutCount` と `tailDropped*` に残る。
   */
  private finishAudioTail(): Promise<void> {
    const existing = this.audioTailCompletion;
    if (existing !== null) {
      return existing;
    }
    const run = this.runFinishAudioTail();
    this.audioTailCompletion = run;
    const clear = (): void => {
      if (this.audioTailCompletion === run) {
        this.audioTailCompletion = null;
      }
    };
    run.then(clear, clear);
    return run;
  }

  /** `finishAudioTail` の本体 (二重呼び出しは `finishAudioTail` が 1 つにまとめる) */
  private async runFinishAudioTail(): Promise<void> {
    const reader = this.audioFrameReader;
    const encoder = this.audioEncoder;
    if (reader === null || encoder === null) {
      return;
    }
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const state: AudioTailDrainState = {
      deadlineMs: performance.now() + AUDIO_TAIL_DRAIN_MAX_MS,
      maxFrames: AUDIO_TAIL_DRAIN_MAX_FRAMES,
      framesRead: 0,
      readBlocks: [],
      sentFrames: 0,
      sentMs: 0,
      sentEndMicros: null,
      sendPromises: [],
      done,
      resolveDone,
    };
    this.audioTailDrain = state;
    let flushTimedOut = false;
    try {
      // ループ自身が drain を終えて保留分を encode するまで待つ。paused からの停止では
      // ループが既に終了しており、待っても読み切る対象が無いため待たない
      if (this.processingActive && this.processingLoopRunning) {
        const drained = await waitWithTimeout(
          done,
          AUDIO_TAIL_DRAIN_MAX_MS + AUDIO_TAIL_DRAIN_QUIET_MS,
        );
        if (drained.timedOut) {
          // ループが応答しない (想定外)。読み出しの完了は待たずに flush へ進む
          flushTimedOut = true;
        }
      }
      // encoder に残った入力を出力させる。direct は WebCodecs の flush、worker は
      // flush の出力を送ってから flushed を返す順序を待つ (どちらも resolve した時点で
      // 出力はすべてコールバックへ届いている)
      const flushMethod = (encoder as { flush?: () => Promise<void> }).flush;
      let flush: Promise<void>;
      if (typeof flushMethod === "function") {
        try {
          flush = flushMethod.call(encoder);
        } catch (error) {
          // 同期の失敗でも、drain 中に発行した末尾の送信は待つ (下の送信待ちへ続ける)
          this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
          flush = Promise.resolve();
        }
      } else {
        // flush を持たない注入 (テストの記録用エンコーダーなど) は待たない
        flush = Promise.resolve();
      }
      // flush と送信の完了を合わせて上限に収める。残り時間で待つ
      const flushDeadlineMs = performance.now() + AUDIO_TAIL_FLUSH_MAX_MS;
      const flushRemainingMs = (): number => Math.max(0, flushDeadlineMs - performance.now());
      let flushed: { timedOut: false } | { timedOut: true };
      try {
        flushed = await waitWithTimeout(flush, flushRemainingMs());
      } catch (error) {
        // flush の失敗で停止そのものを失敗させない (切った量は計器に残る)
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        flushed = { timedOut: false };
      }
      if (flushed.timedOut) {
        flushTimedOut = true;
      }
      // datagram の write / subgroup の送信の完了を待つ。書いた直後に待っても送信が
      // 未完了なら順序の保証にならないため、必ず完了を待ってから猶予へ進む
      if (state.sendPromises.length > 0) {
        const sent = await waitWithTimeout(
          Promise.all(
            state.sendPromises.map((promise) =>
              promise.then(
                () => undefined,
                () => undefined,
              ),
            ),
          ),
          flushRemainingMs(),
        );
        if (sent.timedOut) {
          flushTimedOut = true;
        }
      }
    } catch (error) {
      // 末尾 flush の失敗で停止そのものを失敗させない (解放は続ける)。切った量は
      // commitAudioTailStats が計器に残す
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.commitAudioTailStats(state, flushTimedOut);
      this.audioTailDrain = null;
    }
  }

  /**
   * 末尾 drain の結果を統計と、PUBLISH_DONE の猶予の要否へ反映する
   *
   * 送れなかった量は「読み出した入力の範囲」と「送信した chunk が覆った範囲」の差で
   * 求める。入力の timestamp は連続しているため、被覆の差がそのまま送れなかった長さに
   * なる
   */
  private commitAudioTailStats(state: AudioTailDrainState, flushTimedOut: boolean): void {
    const sentEndMicros = state.sentEndMicros;
    let droppedFrames = 0;
    let droppedMs = 0;
    for (const block of state.readBlocks) {
      if (sentEndMicros !== null && block.endMicros <= sentEndMicros) {
        continue;
      }
      droppedFrames++;
      const coveredFromMicros =
        sentEndMicros === null ? block.startMicros : Math.max(block.startMicros, sentEndMicros);
      droppedMs += Math.max(0, block.endMicros - coveredFromMicros) / 1_000;
    }
    this.audioStats.tailFlushedFrames += state.sentFrames;
    this.audioStats.tailFlushedMs += state.sentMs;
    this.audioStats.tailDroppedFrames += droppedFrames;
    this.audioStats.tailDroppedMs += droppedMs;
    if (flushTimedOut) {
      this.audioStats.tailFlushTimeoutCount++;
    }
    // Object の配送 (datagram と subgroup) と PUBLISH_DONE の control stream には
    // 到着順の保証が無いため、末尾を送ったときは配送方式にかかわらず PUBLISH_DONE の
    // 前に猶予を待つ
    this.pendingAudioTailGrace = state.sentFrames > 0;
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
  AudioDelivery,
  VideoPublishOptions,
};
