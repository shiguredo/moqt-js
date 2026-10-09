/**
 * 高レベル MediaSubscriber API
 *
 * MediaStream を使用した簡単なメディア受信機能を提供する
 */

import { connectMediaSession, type MediaConnectSettings } from "./createMedia/connect";
import { DEFAULT_AUDIO_TRACK_NAME, DEFAULT_VIDEO_TRACK_NAME } from "./createMedia/settings";
import { supportsDynamicGroups } from "./properties";
import { compareLocations } from "./session/params";
import type { Session, SubgroupStreamEnd, SubscribeOptions } from "./session";
import type { Subscriber } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import type { AuthorizationToken, Location, LocationFilter } from "./message";
import * as LOC from "./loc";
import {
  CATALOG_TRACK_NAME,
  applyCatalogDelta,
  decodeCatalogMessage,
  getAudioTracks,
  getTrackByName,
  getVideoTracks,
  type AuthInfo,
  type Catalog,
  type CatalogTrack,
} from "./msf";
// targetLatency の解決規則は devtools と共有するため、公開 API を経由せずに直接 import する
import { effectiveTargetLatencyMs, resolveSharedTargetLatencyMs } from "./msf/tracks";
import { AudioDecoderWrapper } from "./codec/AudioDecoder";
import { VideoDecoderWrapper } from "./codec/VideoDecoder";
import { VideoDecodeOrder, priorObjectIdGapOf } from "./videoDecodeOrder";
import { GroupSwitchGate } from "./groupSwitchGate";
import { AudioClockBridge, AudioPlayoutScheduler, concealmentEndGain } from "./audioPlayout";
import { AudioPlayoutTimingStats, AUDIO_PLAYOUT_TIMING_WINDOW_MS } from "./audioPlayoutTimingStats";
import { compressSamples, concealSamples, type AudioSamples } from "./audioTimeStretch";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES, PlayoutBuffer } from "./playoutBuffer";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, PlaybackTimeline } from "./playbackTimeline";
import { DEFAULT_AUDIO_SAMPLE_RATE, resolveAudioChannelCount } from "./codec/config";
import type {
  AudioCodecType,
  AudioReceiverStats,
  AudioSubscribeOptions,
  AvSyncStats,
  MediaReceiverStats,
  MediaSubscriber,
  MediaSubscriberCallbacks,
  MediaSubscriberOptions,
  MediaSubscriberState,
  VideoCodecType,
  VideoReceiverStats,
  VideoSubscribeOptions,
} from "./codec/types";

/**
 * 復号出力の timestamp の種類を覚えておく上限 (件)
 *
 * 復号されなかったフレームの分が残らないよう、古い方から捨てる
 */
const TIMESTAMP_KIND_MAX_TRACKED = 256;

/**
 * authInfo に応じて Authorization Token を解決する純粋関数
 *
 * draft-ietf-moq-msf-01 §5.2.42: authInfo の存在は subscribe 時に認可トークンが必要であるシグナル。
 * §11.4.3: track に紐づくトークンは、そのトラックに関係する AUTHORIZATION TOKEN パラメータを
 * 受け付けるすべての制御メッセージへ MUST 付与する (SETUP に載せていても免除されない)。
 * §11.4.2: トークン取得は仕様の対象外のため、getAuthorizationToken コールバックで注入する。
 * §11.4.4: トークンを取得できない場合はエラーを呼び出し元に伝播する。
 *
 * トークンの優先順位は次のとおり。
 *
 * 1. getAuthorizationToken コールバック (指定時は必ず使う。undefined を返したらエラー)
 * 2. SETUP Option (0x03) として送ったトークン (`ConnectOptions.authorizationToken`、または
 *    MOQT URI の msf fragment の c4m から解決したもの)
 *
 * @param authInfo track の authInfo（§5.2.42）。空または未指定なら認可不要。
 * @param getAuthorizationToken トークン取得コールバック（§11.4.2、呼び出し側注入）
 * @param setupAuthorizationToken SETUP に載せたトークン（§11.4.3、既定のトークン）
 * @returns 解決したトークン。認可不要なら undefined。
 * @throws authInfo があるのにトークンを得られない場合
 */
export async function resolveAuthorizationToken(
  authInfo: AuthInfo | undefined,
  getAuthorizationToken?: (
    authInfo: AuthInfo,
  ) => AuthorizationToken | undefined | Promise<AuthorizationToken | undefined>,
  setupAuthorizationToken?: AuthorizationToken,
): Promise<AuthorizationToken | undefined> {
  if (!authInfo || Object.keys(authInfo).length === 0) {
    // 認可不要
    return undefined;
  }
  if (getAuthorizationToken) {
    const token = await getAuthorizationToken(authInfo);
    if (!token) {
      throw new Error("track requires authorization but getAuthorizationToken returned no token");
    }
    return token;
  }
  if (setupAuthorizationToken) {
    // SETUP に載せたトークンをそのまま使う (§11.4.3)
    return setupAuthorizationToken;
  }
  throw new Error(
    "track requires authorization (authInfo present) but no getAuthorizationToken callback was provided",
  );
}

// デフォルト設定
const CATALOG_RECEIVE_TIMEOUT = 5000;

/**
 * 解放が先行した start を中止するときのエラー文言
 *
 * 接続で受け取った session を閉じてから throw する経路 (connectToServer) と、
 * 各段階の await の直後の検査 (assertStartNotDisposed) で同じ文言を使う。
 */
const START_ABORTED_DISPOSED = "start aborted: resources were disposed during start";

/**
 * 初期 configure の完了まで保留する Object の上限
 *
 * draft-ietf-moq-loc-04 Table 1: VIDEO_CONFIG / AUDIO_CONFIG は Track Property でも届く。
 * SUBSCRIBE_OK の Track Property を初期 configure に反映するまでの間、届いた Object を
 * 到着順に保留するが、購読が確立しない、または初期 configure がハングする異常時は
 * 保留の区間が伸びる。バイト数は保留する payload と properties の長さの合計を数え、
 * 件数は Object 1 件あたりの固定費 (MoqtObject / Uint8Array / 配列の要素) を抑えるため、
 * 両方に上限を設ける。
 */
export interface PendingObjectQueueOptions {
  /** 保留する Object の件数上限。0 以下で上限なし */
  maxObjects: number;
  /** 保留する Object の payload と properties の長さの合計の上限。0 以下で上限なし */
  maxBytes: number;
}

/**
 * PendingObjectQueueOptions のデフォルト値
 *
 * - maxObjects: 512 件
 * - maxBytes: 1 MiB (`PendingSubgroupBufferOptions.perStreamMaxBytes` と同じ値)
 *
 * 音声と映像は別々のキューを持ち、上限もキューごとに判定する (合計は最大でこの 2 倍)。
 * `MediaSubscriberOptions.pendingObjectQueue` の未指定フィールドはこの値で補完される。
 * 上限の型とあわせてパッケージ公開 API (`src/index.ts`) から参照できる。
 */
export const DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS: PendingObjectQueueOptions = {
  maxObjects: 512,
  maxBytes: 1 << 20,
};

/**
 * 保留キューの可変な状態
 *
 * 件数はキュー (MoqtObject[]) の長さで見る。バイト数と通知済みフラグは配列からは
 * 決まらないためここで持つ。
 */
interface PendingObjectQueueState {
  /** 保留中の Object の payload と properties の長さの合計バイト数 */
  bytes: number;
  /** 上限超過を通知済みか (キューごとに購読期間あたり 1 回だけ通知する) */
  overflowNotified: boolean;
}

/**
 * Catalog Object payload を現在カタログへ適用した結果
 *
 * - `full`: 独立フルカタログで置換
 * - `delta`: `applyCatalogDelta` 成功
 * - `ignored`: フル未受信時の delta（サイレント無視）
 * - `error`: decode / apply 失敗（`catalog` は入力 `current` を維持）
 */
type ProcessCatalogPayloadResult =
  | { kind: "full"; catalog: Catalog }
  | { kind: "delta"; catalog: Catalog }
  | { kind: "ignored"; catalog: Catalog | null }
  | { kind: "error"; catalog: Catalog | null; error: Error };

/**
 * FETCH フェーズ終了時に live バッファから適用すべきオブジェクトを抽出する
 *
 * SUBSCRIBE (Next Object (Location Filter Type 0x05)) と FETCH (フィルタなし) は
 * 独立して評価されるため、
 * 両リクエストの処理時刻の間に publish された Catalog オブジェクトは live と
 * FETCH の両方で届く (draft-ietf-moq-transport-22 §3.3.1。Fetch は「{0, 0} から
 * Largest Object まで」、Next Object 購読は Largest の次から始まるため、処理時刻の
 * ずれだけ範囲が重なる)。FETCH で配信済みの最大 Location 以下のオブジェクトは
 * 適用済みのため除去する (delta の再適用は非冪等であり、add の二重適用は
 * トラックの重複追加になり catalog が破損し得る)。
 *
 * @param pending live SUBSCRIBE でバッファされたオブジェクト
 * @param lastFetchedLocation FETCH で配信された最大 Location
 * @returns 適用対象となるオブジェクト
 */
export function filterPendingCatalogObjects(
  pending: MoqtObject[],
  lastFetchedLocation: Location,
): MoqtObject[] {
  // Location 順序は §8.2 の定義に従う (compareLocations)。
  // FETCH で配信済み (lastFetchedLocation 以下) のものだけを除外する。
  return pending.filter(
    (obj) =>
      compareLocations({ group: obj.groupId, object: obj.objectId }, lastFetchedLocation) > 0,
  );
}

/**
 * 既存 catalog を FETCH するときの開始位置を決める
 *
 * catalog track は Group の先頭 Object (Object ID 0) が独立した catalog を持つ
 * (draft-ietf-moq-msf-01 §5)。したがって最新 Group の先頭から要求すれば完全な
 * catalog が得られる。
 *
 * draft-ietf-moq-transport-22 §3.2: フィルタ無しの FETCH は {0, 0} から
 * Largest Object までを要求する。catalog track の Group ID は publisher の再起動を
 * 跨いだ単調増加 MUST (draft-ietf-moq-msf-01 §6.1) を満たすため Unix epoch
 * ミリ秒から始まることが多く、その場合 {0, 0} 起点の要求範囲は relay の object
 * cache では覆えない。覆えない範囲は上流へ転送されるため、上流が FETCH に応答
 * しない構成では既存 catalog を取得できない。開始位置を最新 Group の先頭にすれば
 * cache が覆える範囲 (cache が持つ最新 Group) と一致する。
 *
 * LARGEST_OBJECT が不明な場合は undefined を返し、呼び出し側はフィルタ無し
 * (従来どおり {0, 0} から Largest Object まで) を要求する。
 *
 * draft-ietf-moq-transport-22 §3.1.4 (Largest Object) のとおり Largest Object は
 * 到着中の Object を指し得る。フィルタ無しの FETCH は §3.2 のとおり開始位置が
 * {0, 0}、終端が Largest Object となり、実際の終端は FETCH_OK の End Location (§9.12)
 * で示される。
 * ここでは受信した Largest Object の Group の先頭を開始位置に置くだけで、終端は
 * 再計算しない (Group 0 のときは {0, 0} 起点と同じ範囲になるためフィルタを省略する)。
 *
 * @param largestLocation SUBSCRIBE_OK で受信した LARGEST_OBJECT (不明なら null)
 * @returns FETCH に載せる Location Filter。undefined はフィルタ無し
 */
export function catalogFetchFilter(largestLocation: Location | null): LocationFilter | undefined {
  if (largestLocation === null) {
    return undefined;
  }
  // 2 フィールドの 0:0 (Location Filter Type 0x02) は絶対位置 {0, 0} の指定であり、
  // フィルタ無しの FETCH の要求範囲 ({0, 0} から Largest Object まで) と一致する。
  // 同じ範囲を明示する意味がないため、そのままフィルタ無しにする
  // (§9.20.9。Next Object は 0x05 であり 0:0 ではない)。
  if (largestLocation.group === 0n) {
    return undefined;
  }
  return { startGroup: largestLocation.group, startObject: 0n };
}

/**
 * 受信した Video Object をキーフレームとして扱うかを判定する
 *
 * draft-ietf-moq-loc-04 §2.3.2.2 の VIDEO_FRAME_MARKING は任意の Property であり
 * (§2.2 は LOC の拡張を optional metadata と定める)、draft-ietf-moq-msf-01 も
 * 要求しない。そのため frameMarking が無い場合は Group 先頭の Object
 * (Object ID 0) をキーフレームとして扱う。
 *
 * Object ID 0 が Group の先頭 Object であることは draft-ietf-moq-msf-01 §6.2 が
 * "Object ID MUST be zero for the first Object within a Group" と MUST で定める。
 * また同 §4.1 は "Samples that belong to the same Group of Pictures (GOP) MUST be
 * placed within the same MOQT Group" と定めるため、Group の先頭は GOP の先頭になる。
 * draft-ietf-moq-loc-04 §4.2 の例は Group ID を IDR 境界で +1 し、Object ID を
 * Group 先頭で 0 に戻したうえで「The first encoded video frame, MOQT Object with
 * ObjectID 0, shall be the Independent (IDR) frame」と示す。§4 は Examples であり
 * 規範要求ではないため、Group 先頭が IDR であることは publisher の採番規約に
 * 依拠する前提として扱う。この節番号・規則は draft 由来であり将来の draft 改版で
 * 変わる可能性がある。
 *
 * frameMarking がある場合は isIndependent を優先する (Object ID 0 でも
 * frameMarking が delta と言えば delta)。
 *
 * テストと moqt-devtools から参照するための export であり、パッケージ公開 API
 * (`src/index.ts`) には含めない (公開 API の判断は別途行う)。
 *
 * @param objectId Object の Object ID (Group 先頭は 0。draft-ietf-moq-msf-01 §6.2)
 * @param frameMarking Object の VIDEO_FRAME_MARKING (無ければ undefined)
 * @returns frameMarking があればその isIndependent、無ければ Object ID が 0 かどうか
 */
export function isVideoKeyFrameObject(
  objectId: bigint,
  frameMarking: LOC.VideoFrameMarking | undefined,
): boolean {
  if (frameMarking !== undefined) {
    return frameMarking.isIndependent;
  }
  return objectId === 0n;
}

/**
 * Catalog Object の payload を純関数で適用する
 *
 * `handleCatalogObject` から切り出した配線用ヘルパー。
 * CatalogDelta の判別は `"deltaUpdate" in message` とする（decode 後の内部マーカーは
 * 常に `deltaUpdate: true`。wire の boolean 形式ではない。draft-ietf-moq-msf-01 §5.1.6）。
 * delta 適用規則（§5.3）は `applyCatalogDelta` に委譲する。
 */
export function processCatalogPayload(
  current: Catalog | null,
  payload: Uint8Array,
): ProcessCatalogPayloadResult {
  try {
    const message = decodeCatalogMessage(payload);
    if ("deltaUpdate" in message) {
      if (current === null) {
        return { kind: "ignored", catalog: null };
      }
      const catalog = applyCatalogDelta(current, message);
      return { kind: "delta", catalog };
    }
    return { kind: "full", catalog: message };
  } catch (cause) {
    return {
      kind: "error",
      catalog: current,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
}

/**
 * WebCodecs 形式の codec 文字列から AudioCodecType に変換する
 */
function parseAudioCodec(codec: string): AudioCodecType {
  if (codec.startsWith("opus")) {
    return "opus";
  }
  if (codec.startsWith("mp4a")) {
    return "aac";
  }
  throw new Error(`unsupported audio codec: ${codec}`);
}

/**
 * WebCodecs 形式の codec 文字列から VideoCodecType に変換する
 */
function parseVideoCodec(codec: string): VideoCodecType {
  if (codec.startsWith("vp8")) {
    return "vp8";
  }
  if (codec.startsWith("vp09") || codec.startsWith("vp9")) {
    return "vp9";
  }
  if (codec.startsWith("avc1") || codec.startsWith("avc3")) {
    return "h264";
  }
  if (codec.startsWith("hvc1") || codec.startsWith("hev1")) {
    return "h265";
  }
  if (codec.startsWith("av01")) {
    return "av1";
  }
  throw new Error(`unsupported video codec: ${codec}`);
}

/**
 * 時刻解決に必要な LOC の部分構造
 *
 * 音声・映像の両プロパティに存在する timestamp / timescale のみを抜き出す。
 * ドメイン固有型 (Video / Audio) の混用を避けるための音声・映像共通の型である。
 */
interface TimestampSource {
  // 受け取る AudioProperties / VideoProperties は「値が無い場合は明示的に undefined」を
  // 取る型のため、`| undefined` を付けて受け側でも同じ表現を許容する
  timestamp?: bigint | undefined;
  timescale?: bigint | undefined;
}

/**
 * 解決済み LOC からデコーダ渡しの時刻 (マイクロ秒数値) を求める
 *
 * TIMESCALE 不在時はそのまま、有る時はマイクロ秒換算して渡す
 * (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)。
 * 音声・映像ハンドラで共有する。
 * TIMESTAMP 欠損時はデコーダ API が number 必須のため 0 を返す (従来通り)。
 */
function decoderTimestampOf(resolved: TimestampSource): number {
  if (resolved.timestamp === undefined) {
    return 0;
  }
  return Number(LOC.toDecoderMicroseconds(resolved.timestamp, resolved.timescale));
}

/**
 * MediaSubscriber の実装クラス
 *
 * 単体テストから復号ハンドラを駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export class MediaSubscriberImpl implements MediaSubscriber {
  private currentState: MediaSubscriberState = "created";
  // 閉状態か。close() の同期部分で立てる。解放 (disposeAllResources) と終端遷移は await を
  // 挟むため、state の "closed" では解放の await 中を判定できない。その間に完了する再構成の
  // 結果と、その間に届く Object を捨てる判定にこのフラグを使う。
  // 解放が失敗して終端 ("closed") へ進まなかった場合は state が "created" / "stopped" の
  // まま残り start() で作り直せるため、start() の入口で戻す
  private closed = false;
  // 進行中の close() の解放と終端遷移。同時に呼ばれた close() はこれを共有し、解放と
  // 終端通知を 1 回に保つ。解放は await を挟むため、state だけを見た単発性の判定では
  // 2 回目の close() が早期 return を通過してしまう
  private closing: Promise<void> | null = null;
  // 進行中の解放 (disposeAllResources)。利用者起点 (stop / close) とピア起点
  // (handleSessionClose) で共有し、相乗りした呼び出しにも解放の成否を伝える。解放は
  // 破棄の前に参照を切り離すため、相乗りした側が自分で解放をやり直すと「破棄するものが
  // 無い成功」になり、進行中の失敗を検知できない
  private disposalInFlight: Promise<void> | null = null;
  private readonly url: string;
  private readonly options: MediaSubscriberOptions;
  private readonly callbacks: MediaSubscriberCallbacks;
  // 保留キューの上限。options.pendingObjectQueue の未指定フィールドは既定値で補完する
  private readonly pendingObjectQueueOptions: PendingObjectQueueOptions;

  // 接続関連
  private session: Session | null = null;
  private catalogSubscriber: Subscriber | null = null;
  private audioSubscriber: Subscriber | null = null;
  private videoSubscriber: Subscriber | null = null;
  // session close 通知の世代番号。解放 (disposeAllResources) のたびに進む
  // (捕捉値と一致しない通知は自己起点の解放によるものとして捨てる)
  private sessionGeneration = 0;
  // 利用者起点の解放 (stop / close) の回数。ピア起点の close の解放 (handleSessionClose) が
  // 進行中に利用者が stop / close を呼んだかを、解放の前後で比較して判定する
  // (解放中は state が "active" のままであるため、state では判定できない)
  private userDisposalCount = 0;

  // Catalog
  private receivedCatalog: Catalog | null = null;
  private catalogResolve: ((catalog: Catalog) => void) | null = null;
  // Catalog 受信待ちの reject。解放時に待ちを打ち切るために持つ
  // (resolve だけでは解放後に start() の await が永久に解決しない)
  private catalogReject: ((error: Error) => void) | null = null;
  // Catalog 受信待ちを await しているか。解放で打ち切るのは await が付いた
  // 待ちだけであり (await が付く前の reject には受け手が無い)、その判定に使う
  private catalogWaiting = false;
  // Catalog FETCH フェーズ中フラグと live SUBSCRIBE バッファ
  private catalogFetchInProgress = false;
  private pendingCatalogObjects: MoqtObject[] = [];
  // Catalog FETCH で配信された最大 Location (live バッファドレイン時の重複除去用)
  private catalogFetchLastLocation: Location | null = null;
  // Catalog 受信タイムアウトのタイマー (解除用に保持する)
  private catalogTimer: ReturnType<typeof setTimeout> | null = null;
  // Catalog 受信失敗済みか。失敗後の遅延オブジェクトを無害化するためのガード
  private catalogReceiveFailed = false;

  // Catalog から取得したトラック情報
  private audioTrackInfo: CatalogTrack | null = null;
  private videoTrackInfo: CatalogTrack | null = null;

  // MediaStream 関連
  private outputStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;
  // 復号した音声を鳴らす時刻を決める。AudioContext を作るたびに基準を作り直す
  private readonly audioPlayout = new AudioPlayoutScheduler();
  // 直前に鳴らした音のサンプルとサンプルレート。欠落した区間の補間を作るために保持する
  private previousAudioChannels: AudioSamples[] | null = null;
  private previousAudioSampleRate = 0;
  // AudioContext の時計と performance.now() の対応。予約のたびに取り直す
  private readonly audioClockBridge = new AudioClockBridge();
  // 音声の再生の観測 (鳴るはずの時刻・届いた時刻・鳴り始める時刻と、鳴らなかった量)。
  // 鳴らなかった音がどこの段で落ちているかを数値で切り分けるために持つ
  // (src/audioPlayoutTimingStats.ts)。購読をやり直しても消えない
  private readonly audioPlayoutTiming = new AudioPlayoutTimingStats(
    AUDIO_PLAYOUT_TIMING_WINDOW_MS,
    performance.timeOrigin,
  );
  // 音声と映像で共有する表示時刻の時間軸。同じ targetLatency と同じ遅れを使う
  private readonly playbackTimeline = new PlaybackTimeline({
    timeOriginMs: performance.timeOrigin,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
  });
  // 復号した映像を LOC TIMESTAMP の間隔で出す。表示周期ごとに select する
  private readonly videoPlayout = new PlayoutBuffer<VideoFrame>(
    JITTER_BUFFER_MAX_QUEUED_FRAMES,
    this.playbackTimeline,
  );
  // 復号出力の timestamp から、壁時計かメディア時刻かを引く。decode に渡した値をキーにする
  private readonly videoTimestampKinds = new Map<number, "wallClock" | "mediaTime">();
  // 音声も同じ対応表を持つ (Timescale がある TIMESTAMP は壁時計ではない)
  private readonly audioTimestampKinds = new Map<number, "wallClock" | "mediaTime">();
  // 音声と映像の両方で壁時計の TIMESTAMP を観測したか (同期の推定を出せるか)
  private audioWallClockSeen = false;
  private videoWallClockSeen = false;
  private videoFrameDrain: number | null = null;
  private videoPlayoutStopped = false;

  // ビデオ出力用
  private videoTrackGenerator: MediaStreamTrackGenerator<VideoFrame> | null = null;
  private videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;

  // デコーダー
  private audioDecoder: AudioDecoderWrapper | null = null;
  private videoDecoder: VideoDecoderWrapper | null = null;

  // デコーダー設定状態
  private audioDecoderConfigured = false;
  private videoDecoderConfigured = false;
  // 直前に VideoDecoder へ渡した description。
  // draft-ietf-moq-loc-04 §2.3.2.1: config が変化したらデコーダを再構成する。
  private lastAppliedVideoConfig: Uint8Array | null = null;
  // 直前に AudioDecoder へ渡した description (AAC の AudioSpecificConfig)。
  // draft-ietf-moq-loc-04 §2.3.3.1: config が変化したらデコーダを再構成する。
  private lastAppliedAudioConfig: Uint8Array | null = null;

  // draft-ietf-moq-loc-04 Table 1: VIDEO_CONFIG / AUDIO_CONFIG は Track Property でも届く。
  // これを初期 configure に反映するまでの間、届いた Object を到着順に保留する (保留中は
  // true)。上限の判定と破棄は holdPendingObject、通常の解放は releasePendingAudioObjects /
  // releasePendingVideoObjects、close などの経路での破棄は disposeAllResources が行う
  private audioInitialConfigPending = false;
  private videoInitialConfigPending = false;
  private pendingAudioObjects: MoqtObject[] = [];
  private pendingVideoObjects: MoqtObject[] = [];
  // 保留キューの計数 (payload と properties の合計バイト数と、上限超過の通知済みフラグ)
  private readonly pendingAudioQueueState: PendingObjectQueueState = {
    bytes: 0,
    overflowNotified: false,
  };
  private readonly pendingVideoQueueState: PendingObjectQueueState = {
    bytes: 0,
    overflowNotified: false,
  };

  // 統計情報 (受信の分。再生の分は getStats のたびに scheduler から読む)
  private audioStats: Pick<AudioReceiverStats, "framesReceived" | "bytesReceived"> = {
    framesReceived: 0,
    bytesReceived: 0,
  };
  private videoStats: VideoReceiverStats = {
    framesReceived: 0,
    keyFramesReceived: 0,
    bytesReceived: 0,
    staleFramesDropped: 0,
    missingReferenceFramesDropped: 0,
  };
  // 映像 Object を復号してよいかを Group の順序と欠落から決める。decoder を構成し直した
  // ときと decoder のエラー後は、キーフレームから始め直すため初期化する
  private readonly videoDecodeOrder = new VideoDecodeOrder();
  // 前の Group の Subgroup の stream が開いている間、次の Group の映像 Object を保留する
  // (groupSwitchGate.ts)。Object は Group ごとに別の stream で届き、前の Group の末尾が
  // 次の Group の先頭より後に届くと、videoDecodeOrder が古い Group として捨てるため
  private readonly videoGroupGate = new GroupSwitchGate<MoqtObject>();
  // 保留の上限で保留を解くタイマー
  private videoGroupGateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    url: string,
    options: MediaSubscriberOptions,
    callbacks: MediaSubscriberCallbacks = {},
  ) {
    this.url = url;
    this.options = options;
    this.callbacks = callbacks;
    this.pendingObjectQueueOptions = {
      ...DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS,
      ...options.pendingObjectQueue,
    };
  }

  get state(): MediaSubscriberState {
    return this.currentState;
  }

  get mediaStream(): MediaStream | null {
    return this.outputStream;
  }

  get catalog(): Catalog | null {
    return this.receivedCatalog;
  }

  private setState(newState: MediaSubscriberState): void {
    this.currentState = newState;
    this.callbacks.onStateChange?.(newState);
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
   * 購読を開始する
   *
   * "created" と "stopped" から呼べる。停止で解放した資源は作り直し、session は
   * 閉じて再接続する (再利用しない)。
   * "subscribing" (開始の途中) の停止は拒否されるため、開始を取り消すには close() を使う
   * (停止と再開の契約は docs/HIGH_LEVEL_API.md の MediaSubscriber を参照)。
   * 解放 (close() とピア起点の close / 停止の解放) が進行している間は
   * cannot start while closing で拒否する (入口の拒否は onError を通知しない)。
   * 失敗時は確保済みを解放して遷移前の state に戻すため再試行できる。解放自体の失敗でも
   * 巻き戻しの onStateChange が throw しても、元の失敗を隠さず onError を通知して元の
   * エラーを throw する。実行中にピア起点の close または利用者の close() が重なった場合は
   * "closed" を優先するため start は失敗し、onError と onClose が続けて呼ばれ得る。
   * 巻き戻しは終端 ("closed") へ進んでいなければ遷移前の state に戻す (解放が先行した
   * 場合も同じ。ピア起点の close は解放のあとに "closed" にするため上書きされず、
   * 解放が途中で失敗した場合も "subscribing" のまま取り残さない)。解放が先行した場合は、
   * 接続で受け取った session を含めてそれ以上購読 / 通知 / リソース作成を進めずに失敗する。
   * 前の close() の解放が失敗して終端 ("closed") へ進まなかった場合は閉状態を戻し、
   * ここから作り直せる (state が "created" / "stopped" のままであるため)。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  async start(): Promise<void> {
    // close() が解放と終端遷移を進めている間は終端へ動く途中であり、開始を重ねても
    // 途中で "closed" になる。state だけを見た判定では "active" のままなので、ここで拒否する
    if (this.closing !== null) {
      throw new Error("cannot start while closing");
    }
    // 解放 (ピア起点の close / stop) が進行中のときも同じである。解放が終端へ進む前に
    // start が完了すると、そのあと state が "closed" になり、開始した資源を解放する経路が
    // 残らない (close() は早期 return、start() / stop() は state で拒否される)
    if (this.disposalInFlight !== null) {
      throw new Error("cannot start while closing");
    }
    if (this.currentState !== "created" && this.currentState !== "stopped") {
      throw new Error(`cannot start in state: ${this.currentState}`);
    }

    // 前の close() が解放に失敗して終端 ("closed") へ進まなかった場合は、state が
    // "created" / "stopped" のまま残りここから作り直せる (解放の失敗時は state を変えず、
    // 呼び直しが残りの段階と終端遷移を進める契約である)。閉状態を残したまま作り直すと、
    // 以降の Object と再構成をすべて捨てて復号できない購読になるため、ここで戻す
    this.closed = false;

    // 失敗時に戻す遷移前の state
    const previousState = this.currentState;
    // 実行中に解放が先行したか (ピア起点の close / 利用者の stop / close) を判定するために
    // 捕捉する。各段階の await の直後の検査 (assertStartNotDisposed) がこの値を基準にする
    const startGeneration = this.sessionGeneration;
    this.setState("subscribing");

    try {
      // サーバーに接続
      await this.connectToServer(startGeneration);

      // Catalog を subscribe して受信を待つ
      await this.subscribeCatalog(startGeneration);

      // Catalog からトラック情報を取得
      this.extractTrackInfo();

      // 出力 MediaStream を作成
      this.createOutputStream();

      // デコーダーを設定
      await this.setupDecoders(startGeneration);

      // メディアトラックを subscribe
      await this.subscribeMediaTracks(startGeneration);

      this.finishStart(startGeneration);
    } catch (error) {
      // 確保済みを巻き戻す。解放が先行していても、参照は既に切り離し済みでこの呼び出しは
      // no-op になり、進行中の解放があればそちらが引き続き後始末するため、無条件に呼ぶ。
      // 巻き戻し自体の失敗で元の失敗を隠さないよう握り潰す。
      try {
        await this.disposeAllResources();
      } catch {
        // 元のエラーを優先する
      }
      // 終端 ("closed") へ進んでいなければ遷移前の state に戻す。解放が先行した場合も
      // 同じで、"subscribing" のまま取り残すと start も stop も拒否されて close 以外の
      // 出口が無くなる。ピア起点の close はこのあと transitionToClosed で "closed" に
      // するため、戻した state は上書きされる (終端と onClose の単発性は崩れない)。
      // setState は state を代入してから onStateChange を呼ぶため、利用者の onStateChange が
      // throw しても state は遷移前に戻っている。通知の失敗で onError の通知と元のエラーの
      // throw を妨げないよう握り潰す
      if (this.state !== "closed") {
        try {
          this.setState(previousState);
        } catch {
          // 元のエラーを優先する (state は代入済みで遷移前に戻っている)
        }
      }
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 購読を停止する
   *
   * "active" からのみ呼べる。それ以外 ("stopped" での再 stop を含む) は
   * cannot stop in state で throw し、解放もしない。開始の途中 ("subscribing") も
   * 拒否されるため、開始を取り消すには close() を使う。
   * close と同じ解放を行い、"stopped" は再 start 可能な完全停止である。
   * session は閉じて再 start 時に再接続し、統計は引き継ぐ。`mediaStream` と
   * `catalog` は解放で無効になるため、再 start の後は新しい `mediaStream` を使う。
   * 解放が失敗した場合は state を変えず onClose も呼ばず、元のエラーを throw する
   * (破棄の前に参照を切り離しているため、失敗した段階はやり直されず、呼び直しが
   * 進めるのは残りの段階と終端遷移である)。
   * ピア起点の close の解放中に呼ばれた場合は進行中の解放を共有して完了を待ち、state を
   * "stopped" にする。あとから解放を終えたピア起点の経路は state も onClose も動かさない。
   * 解放が成功していれば、利用者の onStateChange が throw しても stop は失敗しない
   * (state は代入済みで "stopped" になっており、解放も完了しているため)。
   * ピア起点の close と違い onClose は通知しない。close() が解放と終端遷移を進めている
   * 間は cannot stop while closing で拒否する。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  async stop(): Promise<void> {
    // close() が解放と終端遷移を進めている間は終端へ動く途中である。state だけを見た
    // 判定では "active" のままなので、停止を重ねず終端を close() に任せる
    if (this.closing !== null) {
      throw new Error("cannot stop while closing");
    }
    if (this.currentState !== "active") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    // 利用者起点の解放として数える (ピア起点の close の解放と重なった場合はこちらを優先する)
    this.userDisposalCount++;
    // ピア起点の close の解放が進行中ならそれを共有し、その成否を受ける
    await this.runDisposal();

    // 解放中に close() が終端まで進んでいれば "stopped" に戻さない。戻すと close() の
    // 終端性が崩れ、state が "closed" でなくなるため次の close() が早期 return を通過して
    // onClose が 2 回呼ばれる
    if (this.state !== "closed") {
      // setState は state を代入してから onStateChange を呼ぶ。解放は成功しており state も
      // "stopped" になっているため、通知の失敗で stop を失敗させない (close() の終端遷移と
      // 同じ扱いにする)
      try {
        this.setState("stopped");
      } catch {
        // 通知の失敗を伝える経路が無い (state は代入済み)
      }
    }
  }

  /**
   * キーフレームを要求する
   */
  async requestKeyframe(): Promise<void> {
    if (this.currentState !== "active") {
      return;
    }

    if (!this.videoSubscriber || this.videoSubscriber.state !== "active") {
      return;
    }

    // draft-ietf-moq-transport-22 §9.20.19 (NEW GROUP REQUEST Parameter):
    // "A subscriber MUST NOT send this parameter in REQUEST_UPDATE if the Track
    //  did not include the DYNAMIC_GROUPS Property with value 1.  A subscriber MAY
    //  include this parameter in SUBSCRIBE without foreknowledge of support."
    // MUST の本体は下位の bidiSendRequestUpdate が 1 箇所で担保する。ここは
    // 従来どおりの文言で先にエラーを返すための防御であり、判定の根拠ではない。
    if (!supportsDynamicGroups(this.videoSubscriber.trackProperties)) {
      throw new Error(
        "cannot request keyframe: track did not include DYNAMIC_GROUPS property with value 1",
      );
    }

    // REQUEST_UPDATE で NEW_GROUP_REQUEST を送信
    // draft-ietf-moq-transport-22 §9.20.19 (NEW_GROUP_REQUEST = 0x32)。
    // 値は送信時点の最新 Group ID + 1 (情報なし時は 0) とする。
    // SUBSCRIBE 直後の snapshot は stale のため使わない。
    const largestLocation = this.videoSubscriber.largestLocation;
    const newGroupRequest = largestLocation === null ? 0n : largestLocation.group + 1n;
    await this.videoSubscriber.update({
      newGroupRequest,
    });

    // デコーダーをキーフレーム待ち状態にリセット
    this.videoDecoder?.resetKeyframeWait();
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
   * ピア起点の close の解放中に呼ばれた場合も onClose は 1 回だけ通知され、
   * あとから解放を終えたピア起点の経路は state も onClose も動かさない。
   * 同時に呼ばれた close() はこの解放と終端遷移を共有するため、解放も終端の通知
   * (onStateChange の "closed" と onClose) も 1 回だけになる。終端の遷移は冪等であり、
   * 解放をまたいで終端へ進む経路が重なっても 2 回通知しない。close() が解放と終端遷移を
   * 進めている間は start() と stop() を cannot start while closing /
   * cannot stop while closing で拒否する。
   * stop() との並行呼び出しは未対応であり直列に呼ぶこと。
   * ピア起点の close 通知の経路で解放が失敗した場合も、この close() で回収する。
   * 呼ぶと解放の完了を待たずに閉状態 (closed) になり、解放の await 中に届いた Object は
   * 統計に数えず復号にも渡さず、in-flight の再構成が解放の後に完了しても
   * `*DecoderConfigured` と `lastApplied*Config` を戻さない。解放が失敗して終端へ進まなかった
   * 場合は閉状態を残したままにせず、start() の入口で戻す。
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

    // 利用者起点の解放として数える (ピア起点の close の解放と重なった場合はこちらが終端を決める)
    this.userDisposalCount++;
    // 閉状態にする。解放 (disposeAllResources) は await を挟み、state の "closed" はその後に
    // なるため、解放の await 中に完了する再構成の結果と、その間に届く Object を捨てる判定を
    // このフラグで行う。解放の成否にかかわらず close() を呼んだ時点で閉じる
    this.closed = true;
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
   * 統計情報を取得する
   */
  getStats(): MediaReceiverStats {
    return {
      audio: this.options.audio ? this.audioReceiverStats() : null,
      video: this.options.video ? { ...this.videoStats } : null,
      avSync: this.avSyncStats(),
    };
  }

  /**
   * 音声の統計
   *
   * 受信の統計 (`audioStats`) に、再生の実測 (`AudioPlayoutScheduler`) を足す。基準の
   * 取り直し / 捨てた音 / 補間の回数 / 詰めた合計 / 補間した合計は購読をやり直しても
   * 消えず、今の遅れ (`playoutLatenessMs`) は基準を消すと (購読のやり直し、AudioContext
   * の作り直し) 0 に戻る。時間はミリ秒で返す
   */
  private audioReceiverStats(): AudioReceiverStats {
    return {
      ...this.audioStats,
      playoutRebases: this.audioPlayout.rebases,
      playoutDrops: this.audioPlayout.drops,
      playoutConcealments: this.audioPlayout.concealments,
      playoutCompressedMs: this.audioPlayout.compressed * 1_000,
      playoutConcealedMs: this.audioPlayout.concealed * 1_000,
      playoutLatenessMs: this.audioPlayout.lateness * 1_000,
      // 分布は直近 10 秒のため、呼び出した時点の値を取る
      playoutTiming: this.audioPlayoutTiming.snapshot(performance.now()),
    };
  }

  /**
   * 音声と映像の同期の推定値
   *
   * 片方しか購読していない、トラックが解決できていない、またはどちらかが壁時計の
   * TIMESTAMP を観測していないときは null (映像の表示時刻が決まらない、音声の timestamp が
   * メディア時刻になるため比較できない)。
   */
  private avSyncStats(): AvSyncStats | null {
    if (this.audioTrackInfo === null || this.videoTrackInfo === null) {
      return null;
    }
    if (!this.audioWallClockSeen || !this.videoWallClockSeen) {
      return null;
    }
    return {
      skewMs: this.playbackTimeline.skewMs(),
      presentationDelayMs: this.playbackTimeline.presentationDelayMs,
      targetLatencyMs: this.playbackTimeline.targetLatencyMs,
      targetLatencyLimitedMs: this.playbackTimeline.targetLatencyLimitedMs,
      audioClockFallback: this.audioClockBridge.usingFallback,
      delays: this.playbackTimeline.delayBreakdown,
    };
  }

  // 内部メソッド

  /**
   * 実行中に解放が先行していないことを確かめる
   *
   * start は各段階の await の直後にこれを呼ぶ。解放 (disposeAllResources) は世代番号を
   * 進めるため、start の開始時に捕捉した値との比較で分かる。解放が先行していれば、
   * 購読 / 通知 (onCatalog) / リソース作成をこれ以上進めない。
   * 終端 ("closed") も中止の条件にする。start の失敗時の巻き戻しは "closed" 以外を
   * 遷移前の state に戻すため、ピア起点の close の解放が終わって start より先に終端へ
   * 進んだ場合、世代番号だけでは中止を判定できない (終端のあとに "active" へ戻さない)。
   * 検査までに確保した資源 (購読オブジェクト / デコーダ / 出力) は、start の失敗時の
   * 巻き戻し (disposeAllResources) が解放する。接続で受け取った session だけは採用すると
   * 閉じる経路が state の終端判定に隠れるため、connectToServer がその場で閉じる。
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
   * start の完了検査を通して state を "active" にする
   *
   * 実行中に解放 (disposeAllResources) が先行していれば "active" にしない。解放は
   * 世代番号を進めるため、start の開始時に捕捉した値との比較で判定できる。終端
   * ("closed") へ進んでいる場合も "active" にしない (失敗時の巻き戻しで遷移前の state へ
   * 戻ったあとに再開した start は、解放の時点で世代番号が既に進んでいるため、
   * 世代番号では終端を跨いだことを判定できない)。
   *
   * @param startGeneration start の開始時に捕捉した世代番号
   * @throws 解放が先行した場合 (start aborted: resources were disposed during start)
   */
  private finishStart(startGeneration: number): void {
    this.assertStartNotDisposed(startGeneration);
    this.setState("active");
  }

  /**
   * 確保済みのリソースをすべて解放する
   *
   * stop / close / ピア起点の close 通知 (handleSessionClose) と、start 失敗時の
   * 巻き戻しで共用する。利用者起点とピア起点の解放は runDisposal が 1 つの Promise に
   * まとめる (start の巻き戻しは、進行中の解放を待たずに失敗を返すため直接呼ぶ)。
   * 解放のあとは "created" と同じ実行時状態に戻り、再 start で作り直せる。
   * 破棄する参照は session / catalogSubscriber / audioSubscriber / videoSubscriber /
   * audioDecoder / videoDecoder / videoWriter / videoTrackGenerator / audioDestination /
   * audioContext / outputStream である。参照は破棄の前に切り離すため、段階失敗が
   * あっても切り離し済みの段階はやり直されない (切り離し済みの参照に対する破棄は
   * 行わない)。呼び直しが進めるのは、失敗した段階より後の段階と終端遷移である。
   * 初期値に戻す実行時状態は receivedCatalog / audioTrackInfo / videoTrackInfo /
   * catalogResolve / catalogReject / catalogWaiting / catalogFetchInProgress /
   * pendingCatalogObjects / catalogFetchLastLocation / catalogTimer /
   * catalogReceiveFailed / audioDecoderConfigured / videoDecoderConfigured /
   * lastAppliedVideoConfig / lastAppliedAudioConfig / audioInitialConfigPending /
   * videoInitialConfigPending / videoGroupGateTimer / videoDecodeOrder /
   * videoPlayoutStopped / videoFrameDrain / audioWallClockSeen / videoWallClockSeen /
   * audioTimestampKinds / videoTimestampKinds / 保留中の Object (音声 / 映像 / Group の
   * 切り替え) と上限超過の通知済みフラグ / 表示待ちの映像フレーム (videoPlayout) /
   * 共有の時間軸 (playbackTimeline) / 時計の対応 (audioClockBridge) である。
   * 統計 (audioStats / videoStats) は publisher と同じく再 start へ引き継ぐ。
   * 音声の再生スケジューラ (audioPlayout) は AudioContext と対で作り直すため、
   * ここではなく createOutputStream が初期化する。
   * 破棄の段階失敗は後続を止めず、最後に最初の失敗を throw する。
   * 解放のあとに届く旧 session の close 通知で state と onClose が動くことはない
   * (世代番号を進めるため)。
   */
  private async disposeAllResources(): Promise<void> {
    // 世代番号を進める。これ以降に届く旧 session の close 通知は
    // handleSessionClose が世代不一致で捨てる (stop / close / start 失敗の全経路)
    this.sessionGeneration++;

    // Catalog の受信経路を await より前に止める。session の close は保留中の FETCH を
    // reject し、その終了処理 (finishCatalogFetchPhase) がバッファ済みの live
    // オブジェクトをドレインする。フルカタログが揃っていれば解放中に onCatalog が
    // 発火し、catalog 待ちも resolve してしまう。ドレインは catalogFetchInProgress で
    // 止まり (フェーズ終了の早期 return)、遅れて届く live / FETCH のオブジェクトは
    // catalogReceiveFailed で捨てられる。受信タイムアウトも解除し、解放の途中で
    // タイムアウトの reject が先に届かないようにする。catalogReceiveFailed だけは
    // 解放中の遅延オブジェクトを捨てるラッチとして true にし、後段の初期化節で戻す
    this.catalogFetchInProgress = false;
    this.pendingCatalogObjects = [];
    this.catalogFetchLastLocation = null;
    this.clearCatalogTimer();
    this.catalogReceiveFailed = true;

    // 段階破棄の失敗を集め、後続を止めず最後に最初の失敗を投げる
    let firstFailure: Error | null = null;
    const guard = async (task: () => Promise<void> | void): Promise<void> => {
      try {
        await task();
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    };

    // Subscriber を終了する。購読が確立している ("active") ものだけを対象にする
    // (MediaSubscriber の state とは独立であり、start 失敗の巻き戻しでは
    //  "subscribing" のまま購読が確立している場合がある)
    const catalogSubscriber = this.catalogSubscriber;
    this.catalogSubscriber = null;
    await guard(async () => {
      if (catalogSubscriber !== null && catalogSubscriber.state === "active") {
        await catalogSubscriber.unsubscribe();
      }
    });
    const audioSubscriber = this.audioSubscriber;
    this.audioSubscriber = null;
    await guard(async () => {
      if (audioSubscriber !== null && audioSubscriber.state === "active") {
        await audioSubscriber.unsubscribe();
      }
    });
    const videoSubscriber = this.videoSubscriber;
    this.videoSubscriber = null;
    await guard(async () => {
      if (videoSubscriber !== null && videoSubscriber.state === "active") {
        await videoSubscriber.unsubscribe();
      }
    });

    // デコーダを閉じる
    const audioDecoder = this.audioDecoder;
    this.audioDecoder = null;
    await guard(() => audioDecoder?.close());
    const videoDecoder = this.videoDecoder;
    this.videoDecoder = null;
    await guard(() => videoDecoder?.close());

    // 映像出力を閉じる。MediaStreamTrackGenerator は MediaStreamTrack を継承する
    // ため、track の停止は stop() で行う
    const videoWriter = this.videoWriter;
    this.videoWriter = null;
    await guard(() => videoWriter?.close());
    const videoTrackGenerator = this.videoTrackGenerator;
    this.videoTrackGenerator = null;
    await guard(() => videoTrackGenerator?.stop());

    // 音声出力の track を止める。Web Audio の仕様には MediaStreamAudioDestinationNode の
    // track が AudioContext.close() で終了するという規定が無いため、明示的に停止する
    const audioDestination = this.audioDestination;
    this.audioDestination = null;
    await guard(() => {
      for (const track of audioDestination?.stream.getAudioTracks() ?? []) {
        track.stop();
      }
    });

    // AudioContext を閉じる
    // 予約済みでまだ鳴り始めていない音は、閉じると鳴らないまま切り捨てられる。この分は
    // どの統計にも現れないため、閉じる直前に数える
    this.audioPlayoutTiming.recordStopped(performance.now());
    const audioContext = this.audioContext;
    this.audioContext = null;
    await guard(() => audioContext?.close());

    // session を閉じる (再 start では接続からやり直す)
    const session = this.session;
    this.session = null;
    await guard(async () => {
      if (session !== null) {
        await session.close();
      }
    });

    // 実行時状態を初期値に戻す (統計 (audioStats / videoStats) は引き継ぐ)

    // 保留分と上限超過の通知済みフラグを破棄し、以後は保留せずハンドラの configured
    // ガードで decode しない
    this.audioInitialConfigPending = false;
    this.videoInitialConfigPending = false;
    this.resetPendingObjectQueues();
    // Group の切り替えで保留していた映像 Object も破棄する
    if (this.videoGroupGateTimer !== null) {
      clearTimeout(this.videoGroupGateTimer);
      this.videoGroupGateTimer = null;
    }
    this.videoGroupGate.reset();
    // 復号順の判定も初期化する (setupDecoders の成功パスでも初期化するが、
    // 前世代で最後に許可した Object を持ち越さないようここでも戻す)
    this.videoDecodeOrder.reset();
    // 表示待ちの映像を破棄し、予約した選択を取り消す。次の購読で作り直す
    this.clearVideoPlayout();
    this.videoPlayoutStopped = false;
    // 共有の時間軸と、AudioContext ごとの時計の対応も作り直す (AudioClockBridge.reset の JSDoc を参照)
    this.playbackTimeline.reset();
    this.audioClockBridge.reset();
    // 直前の音の保持も消す (AudioContext を閉じた後に補間を作らない)
    this.previousAudioChannels = null;
    this.previousAudioSampleRate = 0;
    this.audioTimestampKinds.clear();
    this.audioWallClockSeen = false;
    this.videoWallClockSeen = false;
    // Catalog の受信状態を初期値に戻す。受信待ちが残っていれば打ち切る
    // (解放後に await が残ると start() が永久に解決しない)
    this.receivedCatalog = null;
    this.audioTrackInfo = null;
    this.videoTrackInfo = null;
    const catalogReject = this.catalogReject;
    const catalogWaitPending = this.catalogWaiting;
    this.catalogWaiting = false;
    this.catalogResolve = null;
    this.catalogReject = null;
    // フェーズの状態とタイマーは先頭で初期値にしてある。ここではラッチを戻す
    this.catalogReceiveFailed = false;
    if (catalogWaitPending) {
      catalogReject?.(new Error("catalog receive aborted: resources disposed"));
    }
    // デコーダの設定状態を初期値に戻す (閉じた後に decode しない)
    this.audioDecoderConfigured = false;
    this.videoDecoderConfigured = false;
    this.lastAppliedVideoConfig = null;
    this.lastAppliedAudioConfig = null;
    // 出力の参照を切り離す (次の start で新しい MediaStream を作る)
    this.outputStream = null;

    if (firstFailure !== null) {
      const failure: Error = firstFailure;
      throw failure;
    }
  }

  /**
   * session の close 通知を処理する
   *
   * 世代番号が現在値と一致する通知だけをピア起点の close として扱う。解放
   * (disposeAllResources) は世代番号を進めるため、stop / close / start 失敗の
   * 巻き戻しで解放した後に届く旧 session の通知はここで捨てる (state も onClose も
   * 動かさない。新しい session を確立した後に旧 session の通知が届く場合も同じ)。
   * 一致する通知では解放してから "closed" にして onClose を通知する
   * (解放せずに "closed" にすると close の早期 return で解放経路が消える)。
   * 解放は runDisposal で進行中のものと共有する。解放を共有する通知が重なった場合は、
   * 終端の判定 (state が "closed" か) で 2 回目の遷移と onClose の通知を防ぐ。
   * 解放の間に利用者起点の解放 (stop / close) が始まった場合は、state と onClose は
   * そちらの経路に任せ、ここでは終端遷移も onClose も行わない (解放中は state が
   * "active" のままであるため、利用者起点の解放の回数で判定する。重なった stop の
   * あとに "closed" へ動かすと stop の事後条件が崩れ、重なった close では onClose が
   * 2 回呼ばれる)。
   * 解放が失敗した場合は state を変えず onError で通知する。この onError が throw しても
   * この経路は reject しない (呼び出し元 (connectToServer) の回収が同じ失敗をもう一度
   * onError へ流し、二重に通知するため)。onSessionClose は void の同期コールバックであり
   * 同じ通知は再送されないため、呼び出し側が close() を呼んで回収する (解放は失敗した段階
   * より後を回収し、参照は切り離し済みのため同じ段階はやり直されない)。
   * 終端遷移の経路 (onStateChange / onClose) が throw した場合はこの Promise が reject する。
   * 呼び出し元 (connectToServer) が回収し、未処理の rejection にしない。
   *
   * @param generation 通知を受け取った session の世代番号 (start が捕捉し、connectToServer が
   *   クロージャへ渡す値)
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
    // 解放を共有する通知が重なった場合、先に終端へ進んだ側が state と onClose を決める
    if (this.userDisposalCount !== userDisposalCount || this.currentState === "closed") {
      return;
    }

    this.transitionToClosed();
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
        // void の同期コールバックであり、解放の完了は待たずに進める。
        // handleSessionClose は解放の失敗を内部で onError に流すため、ここで回収する
        // のは通知経路 (onError / onStateChange / onClose) が throw した分である。
        // 未処理の rejection にしないため、onError への通知も含めて握る
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

    // 接続の await 中に解放 (stop / close / ピア起点の close) が先行していれば、受け取った
    // session をその場で閉じて採用しない。採用すると state は既に "stopped" / "closed" で
    // close() も早期 return するため、閉じる経路が残らない
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
   * catalog トラックの制御メッセージ (SUBSCRIBE / FETCH) に付与する Authorization Token
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
   * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
   * catalog の authInfo (§5.2.42) は catalog を受信するまで分からないため、SETUP に載せた
   * トークン (MOQT URI の msf fragment の c4m、または `authorizationToken` オプション) を
   * catalog の SUBSCRIBE / FETCH にも付与する。
   */
  private catalogAuthorizationToken(): AuthorizationToken | undefined {
    return this.session?.setupAuthorizationToken;
  }

  /**
   * Catalog を subscribe して受信を待つ
   *
   * 既存の catalog と live の catalog 更新をまとめて受信する。draft-21 で
   * Joining FETCH は削除された (draft-ietf-moq-transport-22 §9.11) ため、
   * 本実装では以下の 2 リクエストで代替する (仕様上の正式な置換は
   * FILL_PARAMETERS (§3.4) であり、実装は別途):
   * 1. SUBSCRIBE (Next Object (Location Filter Type 0x05) の Location Filter) で
   *    live の catalog 更新を受信する
   * 2. 独立した FETCH で既存の catalog を取得する。要求範囲は SUBSCRIBE_OK の
   *    LARGEST_OBJECT が示す Group の先頭 Object から Largest Object までとする
   *    (catalogFetchFilter を参照)。LARGEST_OBJECT が不明な場合だけフィルタ無し
   *    ({0, 0} から Largest Object まで) で要求する
   * FETCH フェーズ中の live オブジェクトはバッファし、FETCH の終了 (end / error)
   * で順に適用する (delta が full より先に適用される順序逆転を防ぐ)。
   * FETCH と live で二重に届いたオブジェクトは filterPendingCatalogObjects で除去する。
   *
   * SUBSCRIBE_OK 受信後に FETCH を送ることが重要: Next Object の Largest (L1) が
   * FETCH 処理時の Largest (L2) 以下になることを保証し、どちらのリクエストにも
   * 届かない (L2, L1] の取りこぼしを防ぐ。リレーが FETCH を先に処理すると
   * L2 < L1 になり得るため、順序を入れ替えてはならない。
   *
   * 異常系契約: 受信タイムアウト後は catalogReceiveFailed で以降の
   * オブジェクトを破棄する。session.subscribe 失敗時は即時掃除して
   * throw する。成功時を含めタイマーは解除する。
   *
   * @param startGeneration start の開始時に捕捉した世代番号 (解放が先行していないかの検査用)
   * @param timeoutMs Catalog 受信タイムアウト (ミリ秒、省略時は CATALOG_RECEIVE_TIMEOUT)
   */
  private async subscribeCatalog(
    startGeneration: number,
    timeoutMs: number = CATALOG_RECEIVE_TIMEOUT,
  ): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;
    const catalogAuthorizationToken = this.catalogAuthorizationToken();

    // Catalog 受信を待つ Promise を作成
    // タイムアウトは「未 resolve」で reject する。FETCH フェーズ中にフルが来ても
    // resolve しない契約のため、`!receivedCatalog` だけではフェーズ未完了時にハングする。
    const catalogPromise = new Promise<Catalog>((resolve, reject) => {
      this.catalogResolve = resolve;
      this.catalogReject = reject;

      this.catalogTimer = setTimeout(() => {
        this.catalogTimer = null;
        if (this.catalogResolve !== null) {
          this.catalogResolve = null;
          this.catalogReject = null;
          // 失敗後に live object が永久バッファされないようフェーズ状態を解除する
          this.catalogFetchInProgress = false;
          this.pendingCatalogObjects = [];
          this.catalogFetchLastLocation = null;
          // 失敗後の遅延オブジェクトを無害化するため失敗を記録する
          this.catalogReceiveFailed = true;
          reject(new Error("catalog receive timeout"));
        }
      }, timeoutMs);
    });

    // FETCH フェーズ用フラグは session.subscribe 呼び出し前に立てる
    // (SUBSCRIBE_OK までの race で live がバッファを迂回するのを防ぐ)
    this.catalogFetchInProgress = true;
    this.pendingCatalogObjects = [];
    this.catalogFetchLastLocation = null;
    this.catalogReceiveFailed = false;

    // Catalog サブスクライバー (live 更新用)
    try {
      this.catalogSubscriber = await this.session.subscribe(
        namespace,
        CATALOG_TRACK_NAME,
        {
          object: (obj) => {
            // FETCH フェーズ中の live SUBSCRIBE オブジェクトはバッファする
            if (this.catalogFetchInProgress) {
              this.pendingCatalogObjects.push(obj);
              return;
            }
            this.handleCatalogObject(obj);
          },
          end: () => {
            // Catalog トラック終了
          },
          error: (error) => this.callbacks.onError?.(error),
        },
        {
          // Next Object (Location Filter Type 0x05): live は現在の最新 catalog の次から受信する
          filter: { nextObject: true },
          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは SUBSCRIBE にも MUST 付与
          ...(catalogAuthorizationToken === undefined
            ? {}
            : { authorizationToken: catalogAuthorizationToken }),
        },
      );
    } catch (error) {
      // session.subscribe 失敗時はタイマー発火を待たず即時掃除する。
      // catalogSubscriber は未登録のため unsubscribe 不要である。
      this.clearCatalogTimer();
      this.catalogResolve = null;
      this.catalogReject = null;
      this.catalogFetchInProgress = false;
      this.pendingCatalogObjects = [];
      this.catalogFetchLastLocation = null;
      throw error;
    }

    // 購読の await 中に解放が先行していれば、FETCH の発行も受信待ちもしない
    // (確保した購読は start の巻き戻しが解放する)
    this.assertStartNotDisposed(startGeneration);

    // 既存 catalog を FETCH で取得する。要求範囲は最新 Group の先頭 Object から
    // Largest Object までとする (catalogFetchFilter を参照)。LARGEST_OBJECT が
    // 不明な場合だけフィルタ無し ({0, 0} から Largest Object まで) で要求する。
    // catalog が未 publish の場合は REQUEST_ERROR (INVALID_RANGE) で reject され、
    // finishCatalogFetchPhase がフェーズを解除して live 待ちに切り替える。
    const fetchFilter = catalogFetchFilter(this.catalogSubscriber.largestLocation);
    void this.session
      .fetch(
        namespace,
        CATALOG_TRACK_NAME,
        {
          ...(fetchFilter === undefined ? {} : { filter: fetchFilter }),
          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは FETCH にも MUST 付与
          ...(catalogAuthorizationToken === undefined
            ? {}
            : { authorizationToken: catalogAuthorizationToken }),
        },
        {
          // FETCH 経由は即時適用。live は object コールバック側でバッファする
          object: (obj: MoqtObject) => {
            // 失敗後の遅延 FETCH は Location 記録も含めて破棄する
            if (this.catalogReceiveFailed) {
              return;
            }
            // FETCH で配信された最大 Location を記録する (ドレイン時の重複除去用)
            const location: Location = { group: obj.groupId, object: obj.objectId };
            const current = this.catalogFetchLastLocation;
            if (current === null || compareLocations(location, current) > 0) {
              this.catalogFetchLastLocation = location;
            }
            this.handleCatalogObject(obj);
          },
          end: () => {
            this.finishCatalogFetchPhase();
          },
          error: (_error: Error) => {
            // FETCH 失敗時もバッファを破棄せずドレインする（Catalog は初回待ちのため）
            this.finishCatalogFetchPhase();
          },
        },
      )
      .catch(() => {
        // fetch() 自体の reject も終了トリガとして扱う
        this.finishCatalogFetchPhase();
      });

    // Catalog を受信するまで待つ
    try {
      // 解放で打ち切る対象にする (await が付いた待ちだけを打ち切る)
      this.catalogWaiting = true;
      await catalogPromise;
    } finally {
      this.catalogWaiting = false;
      this.clearCatalogTimer();
    }

    // 受信の await 中に解放が先行していれば、トラック情報の抽出も出力の作成も行わない
    this.assertStartNotDisposed(startGeneration);
  }

  /**
   * Catalog 受信タイマーを解除する
   */
  private clearCatalogTimer(): void {
    if (this.catalogTimer !== null) {
      clearTimeout(this.catalogTimer);
      this.catalogTimer = null;
    }
  }

  /**
   * Catalog FETCH フェーズを終了する
   *
   * live バッファを順適用（ドレイン）してからフラグを下ろし、
   * その時点でフルカタログがあれば catalogResolve する。
   * FETCH と live で二重に届いたオブジェクトは
   * filterPendingCatalogObjects で除去してから適用する。
   *
   * catalog トラックは 1 Subgroup の in-order 送出 (draft-ietf-moq-msf-01 §5)
   * を前提とし、live バッファは到着順のまま適用する。
   */
  private finishCatalogFetchPhase(): void {
    if (!this.catalogFetchInProgress) {
      return;
    }

    let pending = this.pendingCatalogObjects;
    this.pendingCatalogObjects = [];
    if (this.catalogFetchLastLocation !== null) {
      pending = filterPendingCatalogObjects(pending, this.catalogFetchLastLocation);
    }
    for (const pendingObj of pending) {
      this.handleCatalogObject(pendingObj);
    }

    this.catalogFetchInProgress = false;
    this.tryResolveCatalog();
  }

  /**
   * catalogResolve 契約に従い、未解決ならフルカタログで resolve する
   *
   * FETCH フェーズ中は resolve しない。フェーズ終了後に receivedCatalog が
   * あれば resolve。終了時点で null なら、後続の初回フル適用時に呼ばれる。
   */
  private tryResolveCatalog(): void {
    if (this.catalogFetchInProgress) {
      return;
    }
    if (this.catalogResolve === null || this.receivedCatalog === null) {
      return;
    }
    this.catalogResolve(this.receivedCatalog);
    this.catalogResolve = null;
    this.catalogReject = null;
  }

  /**
   * Catalog からトラック情報を取得する
   */
  private extractTrackInfo(): void {
    const catalog = this.receivedCatalog;
    if (!catalog) {
      throw new Error("catalog not received");
    }

    // Audio トラック情報を取得
    if (this.options.audio) {
      const audioTrackName = this.options.audio.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
      this.audioTrackInfo = this.resolveTrackInfo(
        catalog,
        getAudioTracks(catalog),
        audioTrackName,
        "audio",
      );
    }

    // Video トラック情報を取得
    if (this.options.video) {
      const videoTrackName = this.options.video.trackName ?? DEFAULT_VIDEO_TRACK_NAME;
      this.videoTrackInfo = this.resolveTrackInfo(
        catalog,
        getVideoTracks(catalog),
        videoTrackName,
        "video",
      );
    }

    // 解決した track から targetLatency を決めて共有の時間軸へ渡す (draft-ietf-moq-msf-01 §5.2.8)
    this.playbackTimeline.setTargetLatencyMs(this.resolveSharedTargetLatencyMs());
  }

  /**
   * 音声と映像で使う `targetLatency` を 1 つ決める (ミリ秒)
   *
   * 解決の規則は純関数 (`resolveSharedTargetLatencyMs`) が持ち、ここでは同じ render
   * group / alternate group の track で値が異なるとき (draft-ietf-moq-msf-01 §5.2.8 の
   * MUST 違反) の通知だけを行う。
   */
  private resolveSharedTargetLatencyMs(): number | null {
    const resolved = resolveSharedTargetLatencyMs(this.audioTrackInfo, this.videoTrackInfo);
    if (resolved.conflict) {
      this.callbacks.onError?.(
        new Error(
          `targetLatency differs between tracks in the same render group: audio ${effectiveTargetLatencyMs(this.audioTrackInfo)}, video ${effectiveTargetLatencyMs(this.videoTrackInfo)} (draft-ietf-moq-msf-01 Section 5.2.8)`,
        ),
      );
    }
    return resolved.value;
  }

  /**
   * 要求メディアのトラック情報を解決する
   *
   * `candidates` (role 絞り込み結果) が空の場合のみカタログ全体から
   * 名前一致で探す (role は draft-ietf-moq-msf-01 §5.2.6 の optional
   * フィールド)。全体検索でも見つからなければ `null` のままにし、
   * 先頭トラックは採用しない。`candidates` 非空時の名前不一致は
   * 従来どおり先頭を採用する (後方互換維持)。
   * 未解決時は onError で通知する (throw せず他方メディアは継続する)。
   *
   * @param catalog 解決対象のカタログ (candidates が空の場合の全体検索用)
   * @param candidates role 絞り込み結果の候補配列
   * @param trackName 要求トラック名 (未指定時は呼び出し側で既定名に解決済み)
   * @param kind エラー文言用のメディア種別
   * @returns 解決したトラック情報 (未解決時は null)
   */
  private resolveTrackInfo(
    catalog: Catalog,
    candidates: CatalogTrack[],
    trackName: string,
    kind: "audio" | "video",
  ): CatalogTrack | null {
    const found =
      candidates.find((t) => t.name === trackName) ??
      (candidates.length === 0 ? getTrackByName(catalog, trackName) : candidates[0]) ??
      null;
    if (found === null) {
      this.callbacks.onError?.(new Error(`${kind} track '${trackName}' not found in catalog`));
    }
    return found;
  }

  private createOutputStream(): void {
    this.outputStream = new MediaStream();

    // Audio 出力の設定
    if (this.audioTrackInfo) {
      const sampleRate = this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      this.audioContext = new AudioContext({
        sampleRate,
      });
      this.audioPlayout.reset();
      this.previousAudioChannels = null;
      this.previousAudioSampleRate = 0;
      // AudioContext を作り直したため、再生の基準もすべて作り直す (時計の対応は AudioClockBridge.reset の JSDoc を参照)
      this.playbackTimeline.reset();
      this.audioClockBridge.reset();
      // ブラウザの自動再生ポリシー対応。resume() の失敗は他に通知先が無く、
      // 放置すると未処理の rejection になるため onError へ 1 回流す。
      // 通知の失敗でもこの経路を reject させない (返値の Promise を捨てるため、
      // reject を残すと未処理の rejection になる)
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume().catch((error: unknown) => {
          try {
            this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
          } catch {
            // 通知の失敗を伝える経路がこれ以上無い
          }
        });
      }
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      const audioTrack = this.audioDestination.stream.getAudioTracks()[0];
      if (audioTrack) {
        this.outputStream.addTrack(audioTrack);
      }
    }

    // Video 出力の設定 (MediaStreamTrackGenerator を使用)
    if (this.videoTrackInfo) {
      this.videoTrackGenerator = new MediaStreamTrackGenerator({ kind: "video" });
      this.videoWriter = this.videoTrackGenerator.writable.getWriter();
      this.outputStream.addTrack(this.videoTrackGenerator);
    }
  }

  /**
   * デコーダーを設定する
   *
   * @param startGeneration start の開始時に捕捉した世代番号 (解放が先行していないかの検査用)
   */
  private async setupDecoders(startGeneration: number): Promise<void> {
    const useWorker = this.options.useWorker ?? true;

    // 音声デコーダー
    if (this.audioTrackInfo) {
      this.audioDecoder = new AudioDecoderWrapper(useWorker, {
        output: (data) => this.handleAudioDecodedData(data),
        error: (error) => this.callbacks.onError?.(error),
      });

      // Catalog または options から codec を取得
      let audioCodec: AudioCodecType;
      if (this.options.audio?.codec) {
        audioCodec = this.options.audio.codec;
      } else if (this.audioTrackInfo.codec) {
        audioCodec = parseAudioCodec(this.audioTrackInfo.codec);
      } else {
        throw new Error("audio codec not specified and not found in catalog");
      }

      const sampleRate = this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      // channelConfig は名前付き値 (mono / stereo) と整数文字列を受け付ける。
      // 解決不能な明示値はここで throw し、NaN をデコーダに渡さない
      const channels = resolveAudioChannelCount(this.audioTrackInfo.channelConfig);

      // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
      // この時点では SUBSCRIBE 前であり Track Property を持たないため description 無しで
      // configure する。SUBSCRIBE_OK の AUDIO_CONFIG は subscribeMediaTracks が
      // 購読確立直後に applyInitialAudioConfig で反映する (AAC の復号に必要)。
      await this.audioDecoder.configure(audioCodec, sampleRate, channels);
      // 解放が先行していれば、映像デコーダの作成も購読も進めない
      // (確保したデコーダは start の巻き戻しが閉じる)
      this.assertStartNotDisposed(startGeneration);
      this.audioDecoderConfigured = true;
    }

    // 映像デコーダー
    if (this.videoTrackInfo) {
      this.videoDecoder = new VideoDecoderWrapper(useWorker, {
        output: (data) => this.handleVideoDecodedData(data),
        error: (error) => this.handleVideoDecoderError(error),
      });

      // Catalog または options から codec を取得
      let videoCodec: VideoCodecType;
      if (this.options.video?.codec) {
        videoCodec = this.options.video.codec;
      } else if (this.videoTrackInfo.codec) {
        videoCodec = parseVideoCodec(this.videoTrackInfo.codec);
      } else {
        throw new Error("video codec not specified and not found in catalog");
      }

      const width = this.videoTrackInfo.width ?? 640;
      const height = this.videoTrackInfo.height ?? 480;

      // draft-ietf-moq-loc-04 §2.3.2.1 (Video Config):
      // この時点では SUBSCRIBE 前であり Track Property を持たないため description 無しで
      // configure する。SUBSCRIBE_OK の VIDEO_CONFIG は subscribeMediaTracks が
      // 購読確立直後に applyInitialVideoConfig で反映する (canonical 形式に必要)。
      await this.videoDecoder.configure(videoCodec, width, height);
      // 解放が先行していれば、購読も進めない (確保したデコーダは start の巻き戻しが閉じる)
      this.assertStartNotDisposed(startGeneration);
      this.videoDecodeOrder.reset();
      this.videoDecoderConfigured = true;
    }
  }

  /**
   * track の authInfo に応じて Authorization Token を解決する
   *
   * draft-ietf-moq-msf-01 §5.2.42: authInfo の存在は subscribe 時に認可トークンが必要であるシグナル。
   * §11.4.3: track に紐づくトークンは、そのトラックに関係する AUTHORIZATION TOKEN パラメータを
   * 受け付けるすべての制御メッセージ (SUBSCRIBE / FETCH / REQUEST_UPDATE) へ MUST 付与する。
   * §11.4.2: トークン取得は仕様の対象外のため、getAuthorizationToken コールバックで注入する。
   * §11.4.4: トークンを取得できない場合はエラーを呼び出し元に伝播する。
   *
   * コールバックが無い場合は、SETUP に載せたトークン (`Session.setupAuthorizationToken`) を
   * 既定のトークンとして使う。
   */
  private resolveTrackAuthorizationToken(
    track: CatalogTrack | null,
  ): Promise<AuthorizationToken | undefined> {
    return resolveAuthorizationToken(
      track?.authInfo,
      this.options.getAuthorizationToken,
      this.session?.setupAuthorizationToken,
    );
  }

  /**
   * メディアトラックを subscribe する
   *
   * @param startGeneration start の開始時に捕捉した世代番号 (解放が先行していないかの検査用)
   */
  private async subscribeMediaTracks(startGeneration: number): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;

    // 音声サブスクライバー
    if (this.audioTrackInfo) {
      const trackName = this.audioTrackInfo.name;
      // 購読要求より前に保留を有効化し、購読確立前後に届く Object を落とさない
      // (初期 configure は購読確立直後に適用する)。上限超過の通知はキューごとに
      // 購読期間あたり 1 回だけにするため、前の購読期間の通知済みフラグをここで解除する
      this.audioInitialConfigPending = true;
      this.pendingAudioQueueState.overflowNotified = false;
      // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
      const authorizationToken = await this.resolveTrackAuthorizationToken(this.audioTrackInfo);
      // 解放が先行していれば、購読要求も出さない (解放で session は切り離し済み)
      this.assertStartNotDisposed(startGeneration);
      this.audioSubscriber = await this.session.subscribe(
        namespace,
        trackName,
        {
          object: (obj) => this.handleAudioObject(obj),
          end: () => {
            // トラック終了
          },
          error: (error) => this.callbacks.onError?.(error),
        },
        // exactOptionalPropertyTypes では optional な authorizationToken に undefined を渡せないため、
        // 値がある場合だけ載せる
        authorizationToken === undefined ? {} : { authorizationToken },
      );
      // 購読の await 中に解放が先行していれば、初期 configure の適用も映像側の購読も行わない
      // (確立した購読は start の巻き戻しが解除する)
      this.assertStartNotDisposed(startGeneration);
      // draft-ietf-moq-loc-04 Table 1: AUDIO_CONFIG は Track Property でも届く。
      // 購読確立直後に初期 configure へ反映し、保留していた Object を到着順に処理する
      // (media ごとに行う。音声の適用が映像の SUBSCRIBE_OK 待ちにならないようにする)
      await this.applyInitialAudioConfig();
      // 適用の await 中に解放が先行していれば、映像側の購読も進めない
      this.assertStartNotDisposed(startGeneration);
    }

    // 映像サブスクライバー
    if (this.videoTrackInfo) {
      const trackName = this.videoTrackInfo.name;
      // 購読要求より前に保留を有効化し、購読確立前後に届く Object を落とさない
      // (初期 configure は購読確立直後に適用する)。上限超過の通知はキューごとに
      // 購読期間あたり 1 回だけにするため、前の購読期間の通知済みフラグをここで解除する
      this.videoInitialConfigPending = true;
      this.pendingVideoQueueState.overflowNotified = false;

      // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
      const videoAuthorizationToken = await this.resolveTrackAuthorizationToken(
        this.videoTrackInfo,
      );
      // 解放が先行していれば、購読要求も出さない (解放で session は切り離し済み)
      this.assertStartNotDisposed(startGeneration);
      // exactOptionalPropertyTypes では optional な authorizationToken に undefined を渡せないため、
      // 値がある場合だけ載せる
      const subscribeOptions: SubscribeOptions =
        videoAuthorizationToken === undefined
          ? {}
          : { authorizationToken: videoAuthorizationToken };

      this.videoSubscriber = await this.session.subscribe(
        namespace,
        trackName,
        {
          object: (obj) => {
            this.receiveVideoObject(obj);
          },
          // Subgroup の stream の終わりで、保留していた次の Group の Object を渡す
          subgroupEnd: (end) => {
            this.receiveVideoSubgroupEnd(end);
          },
          end: () => {
            // トラック終了
          },
          error: (error) => this.callbacks.onError?.(error),
        },
        subscribeOptions,
      );
      // 購読の await 中に解放が先行していれば、初期 configure の適用も行わない
      // (確立した購読は start の巻き戻しが解除する)
      this.assertStartNotDisposed(startGeneration);
      // draft-ietf-moq-loc-04 Table 1: VIDEO_CONFIG は Track Property でも届く
      await this.applyInitialVideoConfig();
      // 適用の await 中に解放が先行していれば、start を "active" にしない
      this.assertStartNotDisposed(startGeneration);
    }
  }

  /**
   * SUBSCRIBE_OK の Track Property の AUDIO_CONFIG を初期 configure に反映する
   *
   * draft-ietf-moq-loc-04 §2.3.3.1: AUDIO_CONFIG は Track Property でも届く。
   * 適用に失敗した場合は onError を通知し、lastAppliedAudioConfig は更新しない
   * (audioDecoderConfigured は true のままにし、後続 Object の reconfigure 経路で再試行する)。
   * 成否にかかわらず保留中の Object は到着順に処理する (失敗時は保留していた最初の Object が
   * 再構成で捨てられ、その再構成が成功すれば以降の Object が復号される)。
   * 閉じた購読 (close() の同期部分で立つ closed) では configure を発行せず、保留分の解放だけを
   * 行う (解放は await を挟むため、購読の確立が close() の後に解決すると閉じた後にここへ来る)。
   */
  private async applyInitialAudioConfig(): Promise<void> {
    try {
      // 閉じた後は configure を発行しない (閉じた後に復号器を作り直さない)。解放は await を
      // 挟むため、購読の確立が close() の後に解決すると閉じた後にここへ来る。
      // 保留分の解放は finally が行う (復号はハンドラの閉状態の判定が捨てる)
      if (this.closed) {
        return;
      }
      const config = LOC.resolveAudioProperties(
        this.audioSubscriber?.trackProperties,
        undefined,
      ).config;
      if (config !== undefined && !this.isSameAppliedAudioConfig(config)) {
        await this.reconfigureAudioDecoder(new Uint8Array(config));
      }
    } finally {
      this.releasePendingAudioObjects();
    }
  }

  /**
   * SUBSCRIBE_OK の Track Property の VIDEO_CONFIG を初期 configure に反映する
   *
   * draft-ietf-moq-loc-04 §2.3.2.1: VIDEO_CONFIG は Track Property でも届く。
   * 適用に失敗した場合は onError を通知し、lastAppliedVideoConfig は更新しない
   * (videoDecoderConfigured は true のままにし、後続 Object の reconfigure 経路で再試行する)。
   * 成否にかかわらず保留中の Object は到着順に処理する (失敗時は保留していた最初の Object が
   * 再構成で捨てられ、その再構成が成功すれば以降の Object が復号される)。
   * 閉じた購読 (close() の同期部分で立つ closed) では configure を発行せず、保留分の解放だけを
   * 行う (解放は await を挟むため、購読の確立が close() の後に解決すると閉じた後にここへ来る)。
   */
  private async applyInitialVideoConfig(): Promise<void> {
    try {
      // 閉じた後は configure を発行しない (閉じた後に復号器を作り直さない)。解放は await を
      // 挟むため、購読の確立が close() の後に解決すると閉じた後にここへ来る。
      // 保留分の解放は finally が行う (復号はハンドラの閉状態の判定が捨てる)
      if (this.closed) {
        return;
      }
      const config = LOC.resolveVideoProperties(
        this.videoSubscriber?.trackProperties,
        undefined,
      ).config;
      if (config !== undefined && !this.isSameAppliedVideoConfig(config)) {
        await this.reconfigureVideoDecoder(new Uint8Array(config));
      }
    } finally {
      this.releasePendingVideoObjects();
    }
  }

  /**
   * 初期 configure の完了まで保留するキューへ Object を積む
   *
   * 上限の判定と破棄をこの 1 箇所に閉じる (呼び出し側は保留中かどうかだけを見る)。
   * バイト数は受信統計の bytesReceived と同じ定義 (payload と properties の長さの合計) で
   * 数える (MoqtObject 自体と Object 1 件あたりの固定費は件数の上限が抑える)。
   * 上限を超えた Object は保持せず破棄し、受信統計にも数えない (保留中の Object を
   * 数えていないのと同じ扱いにする)。超過は onError で通知するが、Object ごとに
   * 通知すると呼び出し側のログとエラー処理を圧迫するため、キューごとに購読期間あたり
   * 1 回だけ通知する。通知済みフラグの解除は resetPendingObjectQueues
   * (disposeAllResources の破棄経路) と購読の開始が行う。
   *
   * @param kind どちらの media のキューか (通知の文言に使う)
   * @param obj 保留するか破棄するかを判定する Object
   */
  private holdPendingObject(kind: "audio" | "video", obj: MoqtObject): void {
    const isAudio = kind === "audio";
    const objects = isAudio ? this.pendingAudioObjects : this.pendingVideoObjects;
    const state = isAudio ? this.pendingAudioQueueState : this.pendingVideoQueueState;
    const limit = this.pendingObjectQueueOptions;
    // バイト数は受信統計の bytesReceived と同じ定義 (payload と properties の長さの合計) で
    // 数える。properties を数えないと、payload 0 バイトで properties が大きい Object が
    // バイト上限に触れずに保持され続ける
    const bytes = state.bytes + obj.payload.byteLength + (obj.properties?.byteLength ?? 0);
    // 上限 0 以下は無制限を意味する (ConnectOptions.dataStreamMaxBufferBytes と同じ規約)。
    // 上限ちょうどの保持は許し、超える Object だけを破棄する
    const objectsOver = limit.maxObjects > 0 && objects.length >= limit.maxObjects;
    const bytesOver = limit.maxBytes > 0 && bytes > limit.maxBytes;
    if (objectsOver || bytesOver) {
      if (!state.overflowNotified) {
        state.overflowNotified = true;
        this.callbacks.onError?.(
          new Error(
            // 件数とバイト数は破棄するこの Object を含めた値にする (保持済みの分だけではない)
            `${kind} pending object queue overflow: maxObjects=${limit.maxObjects}, maxBytes=${limit.maxBytes}, objects=${objects.length + 1}, bytes=${bytes}`,
          ),
        );
      }
      return;
    }
    objects.push(obj);
    state.bytes = bytes;
  }

  /**
   * 保留キューと上限超過の通知済みフラグを破棄する
   *
   * 解放 (disposeAllResources) から呼ぶ。購読開始では通知済みフラグだけを解除する
   * (購読開始の時点でキューは空であり、前の購読期間の Object を持ち越さない)。
   */
  private resetPendingObjectQueues(): void {
    this.pendingAudioObjects = [];
    this.pendingVideoObjects = [];
    this.pendingAudioQueueState.bytes = 0;
    this.pendingVideoQueueState.bytes = 0;
    this.pendingAudioQueueState.overflowNotified = false;
    this.pendingVideoQueueState.overflowNotified = false;
  }

  /** 保留中の Audio Object を到着順に処理する */
  private releasePendingAudioObjects(): void {
    this.audioInitialConfigPending = false;
    const pending = this.pendingAudioObjects;
    this.pendingAudioObjects = [];
    this.pendingAudioQueueState.bytes = 0;
    for (const obj of pending) {
      this.handleAudioObject(obj);
    }
  }

  /** 保留中の Video Object を到着順に処理する */
  private releasePendingVideoObjects(): void {
    this.videoInitialConfigPending = false;
    const pending = this.pendingVideoObjects;
    this.pendingVideoObjects = [];
    this.pendingVideoQueueState.bytes = 0;
    for (const obj of pending) {
      this.handleVideoObject(obj);
    }
  }

  /**
   * Catalog オブジェクトを処理する
   *
   * 受信失敗後の遅延オブジェクトは無害化のため破棄する
   * (FETCH / live のコールバック登録に解除手段がないため。
   * FETCH 側の明示ガードは Location 記録の抑止を担い、
   * こちらは catalog 更新と onCatalog 発火の抑止を担う)。
   */
  private handleCatalogObject(obj: MoqtObject): void {
    if (this.catalogReceiveFailed) {
      return;
    }
    const result = processCatalogPayload(this.receivedCatalog, obj.payload);

    if (result.kind === "error") {
      this.callbacks.onError?.(result.error);
      return;
    }

    if (result.kind === "ignored") {
      return;
    }

    // full / delta: 適用後カタログで置換し onCatalog を発火する
    this.receivedCatalog = result.catalog;
    this.callbacks.onCatalog?.(this.receivedCatalog);
    this.tryResolveCatalog();
  }

  private handleAudioObject(obj: MoqtObject): void {
    // 閉じた後は統計も decode も進めない。解放は await を挟むため、state の "closed" だけでは
    // 解放の途中 (decoder の参照を切る前) に届いた Object を判定できない
    if (this.closed) return;
    // 初期 configure (Track Property の AUDIO_CONFIG) の完了まで保留する
    // (上限を超えた Object は holdPendingObject が保持せず破棄する)
    if (this.audioInitialConfigPending) {
      this.holdPendingObject("audio", obj);
      return;
    }
    if (!this.audioDecoder || !this.audioDecoderConfigured) return;

    // LOC から情報を取得
    // Track Property（SUBSCRIBE_OK 由来）と Object Property の両方を探索し、Object を優先する
    const locProperties = LOC.resolveAudioProperties(
      this.audioSubscriber?.trackProperties,
      obj.properties,
    );

    // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
    // Object Property の AUDIO_CONFIG が直前と変わったらデコーダを再構成する
    // (映像経路と同じ扱い)。再構成は非同期のため、完了までは decode に渡さない。
    // 再構成中 (audioDecoderConfigured=false) は先頭の早期 return でここへ到達しない
    if (
      locProperties.config !== undefined &&
      !this.isSameAppliedAudioConfig(locProperties.config)
    ) {
      this.audioDecoderConfigured = false;
      void this.reconfigureAudioDecoder(new Uint8Array(locProperties.config));
    }

    // 再構成中は decode に渡さない (AudioDecoder の configure は非同期)
    if (!this.audioDecoderConfigured) {
      return;
    }

    this.audioStats.framesReceived++;
    this.audioStats.bytesReceived += obj.payload.length + (obj.properties?.length ?? 0);

    const timestamp = decoderTimestampOf(locProperties);
    this.rememberAudioTimestampKind(timestamp, locProperties);

    // デコード
    this.audioDecoder.decode(obj.payload, "key", timestamp, 0);
  }

  /**
   * 復号出力の timestamp から壁時計かどうかを引けるように覚える
   *
   * Timescale が無い TIMESTAMP だけ壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。
   * 無い TIMESTAMP は decoder に 0 を渡すため、種類は覚えず壁時計にしない。
   */
  private rememberAudioTimestampKind(timestamp: number, source: TimestampSource): void {
    if (source.timestamp === undefined) {
      return;
    }
    const kinds = this.audioTimestampKinds;
    kinds.delete(timestamp);
    kinds.set(timestamp, source.timescale === undefined ? "wallClock" : "mediaTime");
    for (const oldest of kinds.keys()) {
      if (kinds.size <= TIMESTAMP_KIND_MAX_TRACKED) {
        break;
      }
      kinds.delete(oldest);
    }
  }

  /**
   * 直前に VideoDecoder へ渡した description と同じかを判定する
   */
  private isSameAppliedVideoConfig(description: Uint8Array): boolean {
    const previous = this.lastAppliedVideoConfig;
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

  /**
   * 直前に AudioDecoder へ渡した description と同じかを判定する
   */
  private isSameAppliedAudioConfig(description: Uint8Array): boolean {
    const previous = this.lastAppliedAudioConfig;
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

  /**
   * Audio Config の変化に合わせてデコーダを再構成する
   *
   * draft-ietf-moq-loc-04 §2.3.3.1: description が変わったら新しい設定で構成し直す。
   * codec / sampleRate / channels はカタログの値を引き続き使う (config のみ更新する)。
   *
   * 閉じた購読 (close() の同期部分で立つ closed) では configure を発行せず、configure の
   * await の間に閉じた場合は成功した結果を捨てる (lastAppliedAudioConfig の更新と
   * audioDecoderConfigured = true を行わない)。解放は await を挟むため、閉じた後に
   * ここへ来る経路がある。
   *
   * 閉じた購読では configure の失敗を onError へ流さない (購読の終了に伴う中止は失敗では
   * ない)。閉状態の判定は catch の先頭で行うため、configure の await の前に閉じた場合だけで
   * なく、await の途中で閉じた場合も通知しない。
   *
   * reject しない契約とする。codec / channels の解決は同期 throw し得るため、同期 throw
   * し得る解決処理を try の外に残さず、configure の失敗と同じく失敗を onError へ 1 回流す。
   * 呼び出し側は `void` で呼ぶため、関数の外へ reject を残すと未処理の rejection になる。
   * onError が throw した場合も通知の失敗を伝える経路が他に無いため握り潰し、この関数を
   * reject させない。
   */
  private async reconfigureAudioDecoder(description: Uint8Array): Promise<void> {
    try {
      // 閉じた後は configure を発行しない (閉じた後に復号器を作り直さない)。解放は await を
      // 挟むため、state の "closed" だけでは解放の途中を判定できない
      if (this.closed) return;
      if (!this.audioDecoder || !this.audioTrackInfo) return;

      let audioCodec: AudioCodecType;
      if (this.options.audio?.codec) {
        audioCodec = this.options.audio.codec;
      } else if (this.audioTrackInfo.codec) {
        audioCodec = parseAudioCodec(this.audioTrackInfo.codec);
      } else {
        return;
      }

      const sampleRate = this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      const channels = resolveAudioChannelCount(this.audioTrackInfo.channelConfig);

      await this.audioDecoder.configure(audioCodec, sampleRate, channels, description);
      // configure の await の間に閉じていれば、成功した configure の結果を捨てる
      // (解放の後に呼ばれると decoder の参照は切れているが、await の前後で閉じたかを
      //  判定しないと閉じた購読が「構成済み」に戻る)
      if (this.closed) return;
      // 成功して初めて「適用済み」とする。失敗時は未適用のまま残し、
      // 同じ config を持つ後続 Object で再試行できるようにする。
      this.lastAppliedAudioConfig = description;
      this.audioDecoderConfigured = true;
    } catch (error) {
      // close() が復号器を破棄すると世代が無効化され、待機中の configure が中止 (reject)
      // する。購読の終了に伴う中止を失敗として利用者に通知しない (利用者が終了を要求した
      // 結果であり、この経路の configure は解放の後に結果を反映しないため対処も要らない)
      if (this.closed) return;
      // 通知の失敗でこの経路を reject させない (呼び出し側は `void` で呼ぶため、
      // reject を残すと未処理の rejection になる)
      try {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // 通知の失敗を伝える経路がこれ以上無い
      }
    }
  }

  /**
   * Video Config の変化に合わせてデコーダを再構成する
   *
   * draft-ietf-moq-loc-04 §2.3.2.1: description が変わったら新しい設定で構成し直す。
   * codec / 解像度はカタログの値を引き続き使う (config のみ更新する)。
   *
   * 閉じた購読 (close() の同期部分で立つ closed) では configure を発行せず、configure の
   * await の間に閉じた場合は成功した結果を捨てる (lastAppliedVideoConfig の更新と
   * videoDecoderConfigured = true を行わない)。解放は await を挟むため、閉じた後に
   * ここへ来る経路がある。
   *
   * 閉じた購読では configure の失敗を onError へ流さない (購読の終了に伴う中止は失敗では
   * ない)。閉状態の判定は catch の先頭で行うため、configure の await の前に閉じた場合だけで
   * なく、await の途中で閉じた場合も通知しない。
   *
   * reject しない契約とする。codec の解決は同期 throw し得るため、同期 throw し得る
   * 解決処理を try の外に残さず、configure の失敗と同じく失敗を onError へ 1 回流す。
   * 呼び出し側は `void` で呼ぶため、関数の外へ reject を残すと未処理の rejection になる。
   * onError が throw した場合も通知の失敗を伝える経路が他に無いため握り潰し、この関数を
   * reject させない。
   */
  private async reconfigureVideoDecoder(description: Uint8Array): Promise<void> {
    try {
      // 閉じた後は configure を発行しない (閉じた後に復号器を作り直さない)。解放は await を
      // 挟むため、state の "closed" だけでは解放の途中を判定できない
      if (this.closed) return;
      if (!this.videoDecoder || !this.videoTrackInfo) return;

      let videoCodec: VideoCodecType;
      if (this.options.video?.codec) {
        videoCodec = this.options.video.codec;
      } else if (this.videoTrackInfo.codec) {
        videoCodec = parseVideoCodec(this.videoTrackInfo.codec);
      } else {
        return;
      }

      const width = this.videoTrackInfo.width ?? 640;
      const height = this.videoTrackInfo.height ?? 480;

      await this.videoDecoder.configure(videoCodec, width, height, description);
      // configure の await の間に閉じていれば、成功した configure の結果を捨てる
      // (解放の後に呼ばれると decoder の参照は切れているが、await の前後で閉じたかを
      //  判定しないと閉じた購読が「構成済み」に戻る)
      if (this.closed) return;
      // 構成し直した decoder はキーフレームから始める
      this.videoDecodeOrder.reset();
      // 成功して初めて「適用済み」とする。失敗時は未適用のまま残し、
      // 同じ config を持つ後続 Object で再試行できるようにする。
      this.lastAppliedVideoConfig = description;
      this.videoDecoderConfigured = true;
    } catch (error) {
      // close() が復号器を破棄すると世代が無効化され、待機中の configure が中止 (reject)
      // する。購読の終了に伴う中止を失敗として利用者に通知しない (利用者が終了を要求した
      // 結果であり、この経路の configure は解放の後に結果を反映しないため対処も要らない)
      if (this.closed) return;
      // 通知の失敗でこの経路を reject させない (呼び出し側は `void` で呼ぶため、
      // reject を残すと未処理の rejection になる)
      try {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // 通知の失敗を伝える経路がこれ以上無い
      }
    }
  }

  /**
   * 受信した映像 Object を、Group の切り替えの保留 (videoGroupGate) を通して処理する
   *
   * draft-ietf-moq-transport-22 Section 2.1: Object は順不同で届きうる。前の Group の
   * stream が開いている間に次の Group の Object が届いたら保留し、前の Group の Object を
   * 先に処理する
   */
  private receiveVideoObject(obj: MoqtObject): void {
    // 閉じた後は Group の保留に入れず復号もしない。保留した Object は閉じた購読では
    // 復号されず、保留の期限まで保持されるだけになる (解放は await を挟むため state では
    // 判定できない)
    if (this.closed) return;
    this.handleVideoObjects(
      this.videoGroupGate.push(obj, obj.groupId, obj.subgroupId, performance.now()),
    );
  }

  /** 映像の Subgroup の stream の終わりで、保留を解いてよくなった Object を処理する */
  private receiveVideoSubgroupEnd(end: SubgroupStreamEnd): void {
    this.handleVideoObjects(
      this.videoGroupGate.endSubgroup(end.groupId, end.subgroupId, performance.now()),
    );
  }

  /** 保留を通った映像 Object を順に処理し、保留が残っていれば上限のタイマーを張り直す */
  private handleVideoObjects(objects: MoqtObject[]): void {
    for (const obj of objects) {
      this.handleVideoObject(obj);
    }
    if (this.videoGroupGateTimer !== null) {
      clearTimeout(this.videoGroupGateTimer);
      this.videoGroupGateTimer = null;
    }
    const deadlineMs = this.videoGroupGate.holdDeadlineMs;
    if (deadlineMs === null) {
      return;
    }
    this.videoGroupGateTimer = setTimeout(
      () => {
        this.videoGroupGateTimer = null;
        this.handleVideoObjects(this.videoGroupGate.expire(performance.now()));
      },
      Math.max(0, deadlineMs - performance.now()),
    );
  }

  private handleVideoObject(obj: MoqtObject): void {
    // 閉じた後は統計も decode も進めない。解放は await を挟むため、state の "closed" だけでは
    // 解放の途中 (decoder の参照を切る前) に届いた Object を判定できない
    if (this.closed) return;
    // 初期 configure (Track Property の VIDEO_CONFIG) の完了まで保留する
    // (上限を超えた Object は holdPendingObject が保持せず破棄する)
    if (this.videoInitialConfigPending) {
      this.holdPendingObject("video", obj);
      return;
    }
    if (!this.videoDecoder || !this.videoDecoderConfigured) return;

    // LOC から情報を取得
    // Track Property（SUBSCRIBE_OK 由来）と Object Property の両方を探索し、Object を優先する
    const locProperties = LOC.resolveVideoProperties(
      this.videoSubscriber?.trackProperties,
      obj.properties,
    );
    const timestamp = decoderTimestampOf(locProperties);
    this.rememberVideoTimestampKind(timestamp, locProperties);
    // VIDEO_FRAME_MARKING が無い publisher の映像も復号できるようにする
    // (Group 先頭をキーフレームとして扱う)。購読が Group の途中から始まった場合は
    // 次の Group 先頭まで VideoDecoderWrapper がキーフレームを待つ。
    // DYNAMIC_GROUPS=1 の Track では requestKeyframe() が NEW_GROUP_REQUEST を送り、
    // publisher が新しい Group を開始すれば先頭から受け取れる
    // (draft-ietf-moq-transport-22 §9.20.19 の SHOULD。DYNAMIC_GROUPS=1 でない
    //  Track では送れず throw する)
    const isKeyFrame = isVideoKeyFrameObject(obj.objectId, locProperties.frameMarking);

    // draft-ietf-moq-loc-04 §2.3.2.1 (Video Config):
    // Object Property の VIDEO_CONFIG が直前と変わったらデコーダを再構成する。
    // 解像度変更や canonical 形式への切替で description が変わった場合に必要。
    // 再構成は非同期のため、失敗は error コールバックへ通知して以降のデコードを止める。
    // 再構成中 (videoDecoderConfigured=false) は先頭の早期 return でここへ到達しない
    if (
      locProperties.config !== undefined &&
      !this.isSameAppliedVideoConfig(locProperties.config)
    ) {
      // 適用済みの更新は configure 成功後に行う。失敗時に更新すると
      // 同じ config が再試行されず、以降の Object をデコードできなくなる。
      this.videoDecoderConfigured = false;
      void this.reconfigureVideoDecoder(new Uint8Array(locProperties.config));
    }

    // 再構成中は decode に渡さない (VideoDecoder の configure は非同期)
    if (!this.videoDecoderConfigured) {
      return;
    }

    this.videoStats.framesReceived++;
    this.videoStats.bytesReceived += obj.payload.length + (obj.properties?.length ?? 0);
    if (isKeyFrame) {
      this.videoStats.keyFramesReceived++;
    }

    // draft-ietf-moq-transport-22 Section 2.1: Object は順不同で届きうる。Group ごとに
    // 別の stream で届くため、前の Group の末尾が次の Group の先頭より後に届くことがある。
    // 参照するフレームを復号していない Object は decoder へ渡さない
    const admission = this.videoDecodeOrder.admit({
      groupId: obj.groupId,
      objectId: obj.objectId,
      isKeyFrame,
      priorObjectIdGap: priorObjectIdGapOf(obj.properties),
    });
    if (!admission.decode) {
      if (admission.reason === "stale") {
        this.videoStats.staleFramesDropped++;
      } else {
        this.videoStats.missingReferenceFramesDropped++;
      }
      return;
    }

    // デコード
    this.videoDecoder.decode(obj.payload, isKeyFrame ? "key" : "delta", timestamp, 0);
  }

  private handleAudioDecodedData(data: { data: AudioData }): void {
    if (!this.audioContext || !this.audioDestination) {
      data.data.close();
      return;
    }

    // AudioData を AudioBuffer に変換して再生
    const audioData = data.data;
    // 鳴らすと決めたが鳴らし始める前に失敗した音を数えるための状態。失敗はこれまで
    // onError にしか現れず、鳴らなかった量として数えられていなかった
    let planned: { arrivalMs: number; targetMs: number | null; durationMs: number } | null = null;
    let played = false;
    try {
      const numberOfChannels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const numberOfFrames = audioData.numberOfFrames;
      // 到着 (復号の出力を受け取った) 時刻。時間軸への記録と観測値の両方に同じ値を使う
      const arrivalMs = performance.now();

      // 復号の出力を共有の時間軸へ記録し、映像と同じ式で目標の時刻を求める
      // (src/playbackTimeline.ts)。壁時計の TIMESTAMP を持たない音は目標を持たず、
      // 到着基準の並べ方にフォールバックする
      const kind = this.audioTimestampKinds.get(audioData.timestamp);
      this.audioTimestampKinds.delete(audioData.timestamp);
      const isWallClock = kind === "wallClock";
      // 直近の音が壁時計の TIMESTAMP を持つか (同期の推定を出せるかの判定に使う)
      this.audioWallClockSeen = isWallClock;
      if (isWallClock) {
        this.playbackTimeline.observe(
          "audio",
          performance.timeOrigin + arrivalMs,
          audioData.timestamp,
        );
      }
      // AudioContext の時計と performance.now() の対応を取り直す。まだ描画が始まって
      // いない (currentTime が 0 で getOutputTimestamp も 0) ときは対応を作らない
      const mapping = this.audioContext.getOutputTimestamp();
      const contextTime = mapping.contextTime ?? 0;
      const performanceTime = mapping.performanceTime ?? 0;
      const hasMapping = contextTime !== 0 || performanceTime !== 0;
      if (hasMapping || this.audioContext.currentTime > 0) {
        this.audioClockBridge.update(
          hasMapping ? { contextTime, performanceTime } : null,
          this.audioContext.currentTime,
          arrivalMs,
        );
      }
      const targetMs = isWallClock
        ? this.playbackTimeline.presentationPerformanceMs("audio", audioData.timestamp)
        : null;
      const targetStartSeconds =
        targetMs === null ? null : this.audioClockBridge.toAudioSeconds(targetMs);
      // 予約に使う今の時刻 (`AudioContext.currentTime`)。鳴り始める時刻を performance 軸へ
      // 換算するときの基準にも使うため、1 回だけ読む
      const contextNowSeconds = this.audioContext.currentTime;
      const durationSeconds = numberOfFrames / sampleRate;
      const decision = this.audioPlayout.schedule(
        contextNowSeconds,
        audioData.timestamp,
        durationSeconds,
        {
          targetStartSeconds,
          // 映像も購読しているときだけ目標を守る。音声だけのときは取り直して連続を優先する
          enforceTarget: this.videoTrackInfo !== null,
          // 音声を観測していないとき (壁時計の TIMESTAMP を持たない / Track の TIMESCALE を
          // 使う) は共有の再生遅延に下限が入らないため、ここで下限を必ず適用する
          delaySeconds:
            Math.max(
              this.playbackTimeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
              AUDIO_PLAYOUT_DELAY_FLOOR_MS,
            ) / 1_000,
          presentationDelaySeconds:
            (this.playbackTimeline.presentationExtraDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS) /
            1_000,
        },
      );
      if (decision.kind === "drop") {
        // 鳴らさなかった音を、理由と長さと一緒に数える。累積のカウンタ (`playoutDrops`) は
        // 件数しか持たず、何ミリ秒分の音が鳴らなかったかが分からない
        this.audioPlayoutTiming.recordMiss({
          atMs: performance.now(),
          reason: decision.reason,
          durationMs: durationSeconds * 1_000,
          targetMs,
          arrivalMs,
        });
        return;
      }
      // 鳴らすと決めたが、鳴らし始める前に失敗したら数える (catch 句)
      planned = { arrivalMs, targetMs, durationMs: durationSeconds };
      // 鳴り始める時刻 (performance 軸)。時計の対応がまだ無いときは、予約に使った
      // (performance.now(), currentTime) の組で換算する (`AudioClockBridge` の代用と
      // 同じ求め方)
      const startMs =
        this.audioClockBridge.toPerformanceMs(decision.startAt) ??
        arrivalMs + (decision.startAt - contextNowSeconds) * 1_000;

      // 目標を過ぎて届いた分は、波形の周期を使って詰める (NetEq の accelerate)。遅れて
      // 届いた音を捨てると音が途切れるため、鳴らす時刻をずらした分だけ詰めて目標へ戻す
      const channels: AudioSamples[] = [];
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames);
        audioData.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
        channels.push(channelData);
      }
      const stretched =
        decision.compressSeconds > 0
          ? compressSamples(channels, sampleRate)
          : { channels, lengthChangeSamples: 0 };
      // 実際に詰められた長さを返す (詰められなかった分は遅れとして残る)
      this.audioPlayout.confirmStretch(-stretched.lengthChangeSamples / sampleRate);

      // 欠落した区間を、直前に鳴らした音の末尾を伸ばして埋める (src/audioTimeStretch.ts)。
      // 実際に補間した長さだけを統計へ返す
      let concealedSeconds = 0;
      if (decision.gapSeconds > 0 && this.previousAudioChannels !== null) {
        // 長い補間ほど末尾の振幅を下げる (繰り返しの音を目立たなくする)
        const endGain = concealmentEndGain(decision.gapSeconds);
        const concealed = concealSamples(
          this.previousAudioChannels,
          this.previousAudioSampleRate,
          decision.gapSeconds,
          endGain,
        );
        const concealedFrames = concealed.channels[0]?.length ?? 0;
        if (concealedFrames > 0) {
          const concealedBuffer = this.audioContext.createBuffer(
            concealed.channels.length,
            concealedFrames,
            this.previousAudioSampleRate,
          );
          for (let channel = 0; channel < concealed.channels.length; channel++) {
            concealedBuffer.copyToChannel(
              concealed.channels[channel] ?? new Float32Array(concealedFrames),
              channel,
            );
          }
          const concealedSource = this.audioContext.createBufferSource();
          concealedSource.buffer = concealedBuffer;
          concealedSource.connect(this.audioDestination);
          concealedSource.start(decision.gapStartSeconds);
          concealedSeconds = concealed.generatedSamples / this.previousAudioSampleRate;
        }
      }
      this.audioPlayout.confirmConcealment(concealedSeconds);

      const frames = stretched.channels[0]?.length ?? numberOfFrames;
      const audioBuffer = this.audioContext.createBuffer(numberOfChannels, frames, sampleRate);

      // 各チャンネルのデータをコピー
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = stretched.channels[channel] ?? new Float32Array(frames);
        audioBuffer.copyToChannel(channelData, channel);
      }

      // AudioBufferSourceNode で、決めた時刻に再生
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioDestination);
      source.start(decision.startAt);
      // 鳴らすと決めた音を記録する。長さは詰めた後 (実際に鳴る長さ) である
      played = true;
      this.audioPlayoutTiming.recordPlay(
        arrivalMs,
        targetMs,
        startMs,
        (frames / sampleRate) * 1_000,
      );

      // 次の音の補間のために、実際に鳴らしたサンプルを保持する
      this.previousAudioChannels = stretched.channels;
      this.previousAudioSampleRate = sampleRate;

      // 実際に鳴らす時刻を実績として記録する (同期ずれの推定に使う)
      if (isWallClock) {
        const presentedMs = this.audioClockBridge.toPerformanceMs(decision.startAt);
        if (presentedMs !== null) {
          this.playbackTimeline.recordPresentation(
            "audio",
            audioData.timestamp,
            BigInt(Math.round((performance.timeOrigin + presentedMs) * 1_000)),
          );
        }
      }
    } catch (error) {
      // 鳴らす準備の途中で失敗した音は、これまで onError にしか現れなかった
      if (planned !== null && !played) {
        this.audioPlayoutTiming.recordMiss({
          atMs: performance.now(),
          reason: "error",
          durationMs: planned.durationMs * 1_000,
          targetMs: planned.targetMs,
          arrivalMs: planned.arrivalMs,
        });
      }
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      audioData.close();
    }
  }

  private handleVideoDecodedData(data: { frame: VideoFrame }): void {
    if (!this.videoWriter || this.videoPlayoutStopped) {
      data.frame.close();
      return;
    }

    // 壁時計の TIMESTAMP だけ表示時刻に使う。write した時点でトラックへ出るため、
    // select が描くと決めるまで書かない (src/playoutBuffer.ts)
    const frame = data.frame;
    const kind = this.videoTimestampKinds.get(frame.timestamp);
    this.videoTimestampKinds.delete(frame.timestamp);
    const wallClockTimestamp = kind === "wallClock" ? frame.timestamp : null;
    // 直近のフレームが壁時計の TIMESTAMP を持つか (同期の推定を出せるかの判定に使う)
    this.videoWallClockSeen = wallClockTimestamp !== null;
    if (wallClockTimestamp !== null) {
      // 映像も共有の時間軸へ記録する。音声と同じ式で表示時刻を決める
      this.playbackTimeline.observe(
        "video",
        performance.timeOrigin + performance.now(),
        wallClockTimestamp,
      );
    }
    const overflow = this.videoPlayout.enqueue(frame, wallClockTimestamp);
    for (const dropped of overflow) {
      dropped.close();
    }
    this.scheduleVideoFrameDrain();
  }

  /**
   * 映像デコーダーのエラーを受けて復帰を試みる
   *
   * 通知は 1 回だけ行い、通知の失敗で復帰を止めない。通知したあとデコーダーを
   * リセットし、リセットした decoder はキーフレームから始めるため復号順の判定も
   * 初期化する。reset() は例外を投げない Promise<boolean> を返し、再初期化できない
   * 場合の打ち切り (Worker と VideoDecoder の破棄、以降の decode() の抑止) まで
   * その中で完結するため、ここでは戻り値を見ない (契約は VideoDecoderWrapper.reset の
   * JSDoc を参照)。
   */
  private handleVideoDecoderError(error: Error): void {
    // 通知の失敗で復帰 (復号順の初期化と reset()) を止めない。通知の失敗を
    // 伝える経路が他に無いため握り潰す
    try {
      this.callbacks.onError?.(error);
    } catch {
      // 通知の失敗を伝える経路がこれ以上無い
    }
    this.videoDecodeOrder.reset();
    // catch は置かない。reject しない契約であり、戻り値も見ない
    void this.videoDecoder?.reset();
  }

  /**
   * 表示時刻を過ぎたフレームを書き、残っていれば次の表示周期でも選ぶ
   *
   * 復号の出力のときだけ選ぶと、次のフレームが届くまで期限を過ぎたフレームが残る。
   * すでに表示時刻を過ぎているフレームは、その場で書く。
   */
  private scheduleVideoFrameDrain(): void {
    this.writeDueVideoFrames();
    if (this.videoPlayout.size === 0 || this.videoFrameDrain !== null || this.videoPlayoutStopped) {
      return;
    }
    this.videoFrameDrain = requestAnimationFrame(() => {
      this.videoFrameDrain = null;
      if (!this.videoWriter || this.videoPlayoutStopped) {
        this.clearVideoPlayout();
        return;
      }
      this.scheduleVideoFrameDrain();
    });
  }

  /** 今の時刻で描けるフレームを順に書く。表示時刻前のフレームはキューに残す */
  private writeDueVideoFrames(): void {
    if (!this.videoWriter || this.videoPlayoutStopped) {
      return;
    }
    for (;;) {
      const selection = this.videoPlayout.select(performance.now());
      for (const late of selection.late) {
        late.close();
      }
      if (selection.draw === null) {
        return;
      }
      this.writeVideoFrame(selection.draw);
      // 実際に書く時刻 (表示時刻) を実績として記録する (同期ずれの推定に使う)
      if (selection.drawPresentationMs !== null) {
        this.playbackTimeline.recordPresentation(
          "video",
          selection.draw.timestamp,
          BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000)),
        );
      }
    }
  }

  /**
   * MediaStreamTrackGenerator にフレームを書く
   *
   * 成功時は Generator 所有のため閉じない。失敗時はここで閉じる。
   */
  private writeVideoFrame(frame: VideoFrame): void {
    if (!this.videoWriter) {
      frame.close();
      return;
    }
    try {
      this.videoWriter.write(frame).catch(() => {
        frame.close();
      });
    } catch {
      frame.close();
    }
  }

  /** 表示待ちの映像を破棄し、予約した選択を取り消す */
  private clearVideoPlayout(): void {
    this.videoPlayoutStopped = true;
    if (this.videoFrameDrain !== null) {
      cancelAnimationFrame(this.videoFrameDrain);
      this.videoFrameDrain = null;
    }
    for (const frame of this.videoPlayout.clear()) {
      frame.close();
    }
    this.videoTimestampKinds.clear();
  }

  /**
   * 復号出力の timestamp から壁時計かどうかを引けるように覚える
   *
   * Timescale が無い TIMESTAMP だけ壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。
   * 無い TIMESTAMP は decoder に 0 を渡すため、種類は覚えず壁時計にしない。
   */
  private rememberVideoTimestampKind(timestamp: number, source: TimestampSource): void {
    if (source.timestamp === undefined) {
      return;
    }
    const kinds = this.videoTimestampKinds;
    kinds.delete(timestamp);
    kinds.set(timestamp, source.timescale === undefined ? "wallClock" : "mediaTime");
    for (const oldest of kinds.keys()) {
      if (kinds.size <= TIMESTAMP_KIND_MAX_TRACKED) {
        break;
      }
      kinds.delete(oldest);
    }
  }
}

/**
 * MediaSubscriber を作成する
 *
 * @param url - MOQT サーバーの URL (例: `moqt://example.com/moqt`)
 * @param options - 購読オプション
 * @param callbacks - コールバック
 * @returns MediaSubscriber インスタンス
 */
export async function createMediaSubscriber(
  url: string,
  options: MediaSubscriberOptions,
  callbacks?: MediaSubscriberCallbacks,
): Promise<MediaSubscriber> {
  if (!options.audio && !options.video) {
    throw new Error("at least one of audio or video must be specified");
  }

  return new MediaSubscriberImpl(url, options, callbacks);
}

// 型のエクスポート
export type {
  MediaSubscriber,
  MediaSubscriberOptions,
  MediaSubscriberCallbacks,
  MediaSubscriberState,
  MediaReceiverStats,
  AudioReceiverStats,
  VideoReceiverStats,
  AvSyncStats,
  AudioSubscribeOptions,
  VideoSubscribeOptions,
};
