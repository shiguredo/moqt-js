/**
 * MediaSubscriber のテストで共有する fixture とヘルパー
 *
 * 分割したテストファイル (createMediaSubscriber.*.test.ts) が 2 ファイル以上で使う
 * 制御口・ヘルパー・fixture を置く。vitest の `test.include`
 * (`src/**\/*.{test,prop}.ts`) に一致しない名前であり、ライブラリのビルド entry
 * (src/index.ts) からも到達しないため、配布物には含まれない。
 */
import { MediaSubscriberImpl } from "../createMediaSubscriber";
import { playoutInternalsOf } from "./mediaPlayoutInternals";
import { type SubscriberAudioOutput } from "./mediaSubscriberInternals";
import { PreDecodeDelayStage } from "../playout/preDecodeDelayStage";
import type { MediaPlayout } from "../playout/mediaPlayout";
import type { FetchOptions, Session, SubscribeOptions } from "../session";
import type { Subscriber } from "../subscriber";
import type {
  AudioDelivery,
  AudioReceiverStats,
  MediaSubscriberCallbacks,
  MediaSubscriberOptions,
  MediaSubscriberState,
  VideoReceiverStats,
} from "../codec/types";
import type { Fetcher } from "../fetcher";
import { type Catalog, type CatalogTrack } from "../msf";
import type { VideoFrameMarking } from "../loc";
import { type MoqtObject } from "../dataStream";
import type { SubgroupStreamEnd } from "../session";
import { type GroupSwitchGate } from "../groupSwitchGate";
import type { VideoDecodeOrder } from "../videoDecodeOrder";
import type { Location } from "../message";

/** テスト用の最小フルカタログ */
export function makeCatalog(tracks: Catalog["tracks"] = []): Catalog {
  return {
    version: "draft-01",
    tracks,
  };
}

/** テスト用の Catalog オブジェクトを構築する */
export function makeCatalogObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: 0,
    payload: new Uint8Array(),
  };
}

// キーフレームとデルタの VIDEO_FRAME_MARKING
// (RFC 9626 §3.1 の I ビットと B ビットは別のビットであり、publisher と同じく
//  どちらにもキーフレーム判定を渡す)
export const keyFrameMarking: VideoFrameMarking = {
  isIndependent: true,
  isDiscardable: false,
  isBaseLayerSync: true,
  temporalLayerId: 0,
  spatialLayerId: 0,
};

// デルタフレームでは isBaseLayerSync も false (publisher はキーフレーム判定を渡す)
export const deltaFrameMarking: VideoFrameMarking = {
  ...keyFrameMarking,
  isIndependent: false,
  isBaseLayerSync: false,
};

/**
 * 初期 configure (Track Property の config) の検証用の制御口
 *
 * SUBSCRIBE_OK の trackProperties を注入し、configure に渡る description と decode に
 * 渡る Object を観測する。VideoDecoderWrapper は動作にブラウザの VideoDecoder を
 * 必要とするため、記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
export interface SubscriberInitialConfigControl {
  videoDecoder: {
    configure(
      codec: unknown,
      width: unknown,
      height: unknown,
      description?: Uint8Array,
    ): Promise<void>;
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  audioDecoder: {
    configure(
      codec: unknown,
      sampleRate: unknown,
      channels: unknown,
      description?: Uint8Array,
    ): Promise<void>;
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  videoDecoderConfigured: boolean;
  audioDecoderConfigured: boolean;
  videoInitialConfigPending: boolean;
  audioInitialConfigPending: boolean;
  // 初期 configure の完了まで保留するキュー (件数とバイト数の上限つき) と、その計数。
  // 音声のキューは到着経路も一緒に持つ
  pendingAudioObjects: Array<{ object: MoqtObject; delivery: string }>;
  pendingVideoObjects: MoqtObject[];
  pendingAudioQueueState: { bytes: number; overflowNotified: boolean };
  pendingVideoQueueState: { bytes: number; overflowNotified: boolean };
  videoSubscriber: { trackProperties?: { id: bigint; data?: Uint8Array }[] } | null;
  audioSubscriber: { trackProperties?: { id: bigint; data?: Uint8Array }[] } | null;
  // configure は codec / 解像度 / サンプルレートを Catalog の track info から解決するため注入する
  videoTrackInfo: CatalogTrack | null;
  audioTrackInfo: CatalogTrack | null;
  handleVideoObject(obj: MoqtObject): void;
  handleAudioObject(obj: MoqtObject, delivery?: string): void;
  /** 受信の入口 (重複の判定を行う。配信側の冗長化で同じ Object が 2 回届く) */
  receiveAudioObject(obj: MoqtObject, delivery?: string): void;
  applyInitialVideoConfig(): Promise<void>;
  applyInitialAudioConfig(): Promise<void>;
}

/** payload の先頭バイトで Object を識別する (到着順の検証用) */
export function makeIdentifiedObject(objectId: bigint, marker: number): MoqtObject {
  return {
    groupId: 1n,
    objectId,
    status: 0,
    payload: new Uint8Array([marker]),
  };
}

/**
 * 映像 Object の判定・統計・デコードの検証用の制御口
 *
 * handleVideoObject を直接駆動し、キーフレーム判定が VideoDecoderWrapper と
 * videoStats に伝わることを検証する。VideoDecoderWrapper は configure にブラウザの
 * VideoDecoder を必要とし node 環境では構成できないため、記録用の最小オブジェクトを
 * 注入する (モジュール置換は行わない)。
 */
export interface SubscriberVideoObjectControl {
  videoDecoder: {
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  videoDecoderConfigured: boolean;
  handleVideoObject(obj: MoqtObject): void;
}

/**
 * 受信した映像 Object を Group の切り替えで保留する経路の検証用の制御口
 *
 * object / subgroupEnd コールバックから呼ばれる受け口を直接駆動する。
 */
export interface SubscriberVideoGateControl extends SubscriberVideoObjectControl {
  receiveVideoObject(obj: MoqtObject): void;
  receiveVideoSubgroupEnd(end: SubgroupStreamEnd): void;
}

/** Group と Object ID を指定した Subgroup の stream の映像 Object (Frame Marking 無し) */
export function makeStreamVideoObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    subgroupId: 0n,
    objectId,
    status: 0,
    payload: new Uint8Array([Number(groupId * 16n + objectId)]),
  };
}

/** 復号前の遅延の段が保持する音声 Object (実装の private 型と同じ形) */
export interface DelayedAudioItem {
  readonly object: MoqtObject;
  readonly delivery: AudioDelivery;
  readonly arrivalWallClockMs: number;
}

/**
 * 復号前の遅延の検証用の制御口
 *
 * `receiveAudioObject` / `receiveVideoObject` を直接駆動し、期限が来るまで復号へ
 * 渡らないこと、期限後に到着順で渡ることを確かめる。デコーダはブラウザ API を
 * 必要とするため、記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
export interface SubscriberPreDecodeDelayControl extends SubscriberVideoGateControl {
  audioDecoder: {
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
    close(): Promise<void>;
  } | null;
  audioDecoderConfigured: boolean;
  // 再生の入口 (MediaPlayout)。復号へ渡した入力の記録はその中が持つ
  readonly playout: MediaPlayout;
  audioPreDecodeStage: PreDecodeDelayStage<DelayedAudioItem> | null;
  videoPreDecodeStage: PreDecodeDelayStage<MoqtObject> | null;
  videoInitialConfigPending: boolean;
  pendingVideoObjects: MoqtObject[];
  currentState: MediaSubscriberState;
  handleAudioDecoderError(error: Error): void;
  handleVideoDecoderError(error: Error): void;
  notifyPreDecodeOverflow(
    kind: "audio" | "video",
    overflow: { dropped: number; delayMs: number },
  ): void;
  receiveAudioObject(obj: MoqtObject, delivery?: AudioDelivery): void;
}

/** 復号前の遅延を持つ購読と、復号へ渡った payload の記録を作る */
export function createPreDecodeDelaySubscriber(delayMs: number): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberPreDecodeDelayControl;
  decodedAudio: number[];
  decodedVideo: number[];
  errors: Error[];
} {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {}, preDecodeDelayMs: delayMs },
    { onError: (error) => errors.push(error) },
  );
  const control = subscriber as unknown as SubscriberPreDecodeDelayControl;
  const decodedAudio: number[] = [];
  const decodedVideo: number[] = [];
  control.audioDecoder = {
    decode: (payload) => {
      decodedAudio.push(payload[0] ?? -1);
    },
    close: async () => {},
  };
  control.audioDecoderConfigured = true;
  // 映像デコーダの型は decode だけを持つため、close() を足した実物の代役を型変換して入れる
  control.videoDecoder = {
    decode: (payload: Uint8Array) => {
      decodedVideo.push(payload[0] ?? -1);
    },
    close: async () => {},
    reset: async () => {},
  } as unknown as SubscriberVideoGateControl["videoDecoder"];
  control.videoDecoderConfigured = true;
  return { subscriber, control, decodedAudio, decodedVideo, errors };
}

/**
 * 復号フレーム破棄の検証用の制御口
 *
 * 復号ハンドラを直接駆動し、所有権方針どおりに閉じられることを検証する。
 * VideoFrame / AudioData / AudioContext はブラウザ専用 API であり
 * node 環境に実物がないため、記録用の最小オブジェクトを注入する
 * (モジュール置換は行わない)。
 */
export interface SubscriberFrameControl {
  videoWriter: { write: (frame: unknown) => Promise<void> } | null;
  audioOutput: SubscriberAudioOutput | null;
  // 再生の入口 (MediaPlayout)。鳴らす先はテストが差し替えて入口へ渡す
  readonly playout: MediaPlayout;
  handleVideoDecodedData(data: { frame: VideoFrame }): void;
  handleAudioDecodedData(data: { data: AudioData }): void;
}

/**
 * Catalog 取得用の最小セッション
 *
 * live / FETCH の object コールバックを捕捉し、遅延オブジェクトを注入できる。
 * subscribe / fetch の引数は実シグネチャで拘束し、返値のみ最小形状にする。
 * SUBSCRIBE_OK の LARGEST_OBJECT は `subscribeLargestLocation` で与え、
 * SUBSCRIBE に載った options は `subscribeOptions`、FETCH に載った options は
 * `fetchOptions` で取り出す。
 */
export function createCatalogTestSession(
  hooks: { subscribeError?: Error; subscribeLargestLocation?: Location } = {},
): {
  session: Session;
  liveObject: (obj: MoqtObject) => void;
  fetchObject: (obj: MoqtObject) => void;
  fetchEnd: () => void;
  subscribeOptions: () => SubscribeOptions | undefined;
  fetchOptions: () => FetchOptions | undefined;
  calls: string[];
} {
  const calls: string[] = [];
  let liveObject: (obj: MoqtObject) => void = () => {};
  let fetchObject: (obj: MoqtObject) => void = () => {};
  let fetchEnd: () => void = () => {};
  let subscribeOptions: SubscribeOptions | undefined;
  let fetchOptions: FetchOptions | undefined;
  const session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>): Promise<Subscriber> => {
      calls.push("subscribe");
      if (hooks.subscribeError) {
        throw hooks.subscribeError;
      }
      subscribeOptions = args[3];
      liveObject = args[2].object;
      // SUBSCRIBE_OK の LARGEST_OBJECT だけを持つ最小の Subscriber を返す
      return {
        largestLocation: hooks.subscribeLargestLocation ?? null,
      } as Subscriber;
    },
    fetch: (...args: Parameters<Session["fetch"]>): Promise<Fetcher> => {
      calls.push("fetch");
      fetchOptions = args[2];
      fetchObject = args[3].object;
      const end = args[3].end;
      if (end) {
        fetchEnd = end;
      }
      // 未決着のままにして FETCH 終了競合を起こさない (意図的な放置)
      return new Promise<never>(() => {});
    },
  } as unknown as Session;
  return {
    session,
    liveObject: (obj) => liveObject(obj),
    fetchObject: (obj) => fetchObject(obj),
    fetchEnd: () => fetchEnd(),
    subscribeOptions: () => subscribeOptions,
    fetchOptions: () => fetchOptions,
    calls,
  };
}

/**
 * 遅延注入テストと成功テストで共用する非空 catalog
 */
export function makeVideoCatalog(): Catalog {
  return makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
}

/**
 * 実時間待機用のヘルパー (タイマー副作用待ち)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

// テストで使う targetLatency と許容幅
// 目標の表示時刻の計算に再生遅延の下限 (50 ms) ではなく targetLatency を使わせる値
export const AV_SYNC_TARGET_LATENCY_MS = 120;

/**
 * 観測の時刻 (`performance.timeOrigin + performance.now()`、ミリ秒) の壁時計の TIMESTAMP
 *
 * この値を持つのと同じ時刻で観測すると基準の遅れ (受信側と送信側の時計のずれ) が 0 になり、
 * 表示時刻が「観測の時刻 + 表示の遅れ」になる。映像の表示時刻の検証で使う。
 *
 * @param observedWallClockMs - 観測に使う時刻 (ミリ秒)
 */
export function wallClockTimestampMicrosOf(observedWallClockMs: number): number {
  return Math.round(observedWallClockMs * 1_000);
}

/** 記録用の VideoFrame (timestamp を持ち、閉じられたかどうかを記録する) */
export function createTimestampedRecordingFrame(timestamp: number): {
  frame: VideoFrame;
  isClosed: () => boolean;
} {
  let closed = false;
  const frame = {
    timestamp,
    close: () => {
      closed = true;
    },
  } as unknown as VideoFrame;
  return { frame, isClosed: () => closed };
}

/**
 * 表示周期 (`requestAnimationFrame`) の予約を捕まえておく入れ物
 *
 * 実装は表示時刻を過ぎたフレームをその場で書き、残っていれば表示周期で次を選ぶ。
 * node 環境に表示周期は無いため、予約されたコールバックをテスト側で実行する
 * (フレームの選択と書き込みは実装を通す)。
 */
let pendingAnimationFrame: FrameRequestCallback | null = null;

// oxlint-disable-next-line import/no-mutable-exports -- テストが記録の状態を直接読むため
export let animationFrameCount = 0;

/**
 * コールバックを呼ばずに予約だけを捕まえる (表示周期を作り直さない)
 *
 * 予約の取り消し (`cancelAnimationFrame`) も node 環境には無い。表示待ちを捨てる経路
 * (MediaPlayout.clearAll) が予約を取り消すため、記録せずに受けるだけの関数へ差し替える。
 */
export function installAnimationFrameRecorder(): void {
  const globalWithAnimationFrame = globalThis as unknown as {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  // node 環境には表示周期が無いため、テストの間だけ差し替え、後で元に戻す
  restoreAnimationFrame();
  originalAnimationFrame = globalWithAnimationFrame.requestAnimationFrame;
  originalCancelAnimationFrame = globalWithAnimationFrame.cancelAnimationFrame;
  globalWithAnimationFrame.requestAnimationFrame = (callback) => {
    pendingAnimationFrame = callback;
    animationFrameCount++;
    return 0;
  };
  globalWithAnimationFrame.cancelAnimationFrame = () => {};
}

/** 差し替えた表示周期を元に戻す (テストの終了時に呼ぶ) */
export function restoreAnimationFrame(): void {
  const globalWithAnimationFrame = globalThis as unknown as {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  if (originalAnimationFrame === undefined) {
    delete globalWithAnimationFrame.requestAnimationFrame;
  } else {
    globalWithAnimationFrame.requestAnimationFrame = originalAnimationFrame;
  }
  if (originalCancelAnimationFrame === undefined) {
    delete globalWithAnimationFrame.cancelAnimationFrame;
  } else {
    globalWithAnimationFrame.cancelAnimationFrame = originalCancelAnimationFrame;
  }
  originalAnimationFrame = undefined;
  originalCancelAnimationFrame = undefined;
}

// 差し替える前の表示周期 (元に戻すために持つ)
let originalAnimationFrame: ((callback: FrameRequestCallback) => number) | undefined;

let originalCancelAnimationFrame: ((handle: number) => void) | undefined;

/** 予約された表示周期のコールバックを 1 回実行する */
export function runPendingAnimationFrame(): void {
  const callback = pendingAnimationFrame;
  pendingAnimationFrame = null;
  if (callback === null) {
    return;
  }
  callback(performance.now());
}

/** 表示周期の予約を消す (前のテストの持ち越しを防ぐ) */
export function clearPendingAnimationFrame(): void {
  pendingAnimationFrame = null;
  animationFrameCount = 0;
}

/**
 * ライフサイクル検証用の制御口
 *
 * stop / close / start 失敗時の巻き戻しで参照が残らないこと、実行時状態が初期値に
 * 戻ること、session の close 通知が世代番号で捨てられること、AudioContext の作り直し
 * (createOutputStream) で時計の対応を初期化することを検証する。
 * 解放の対象はブラウザ専用 API (WebCodecs / MediaStreamTrackGenerator / AudioContext /
 * MediaStreamAudioDestinationNode) と session / Subscriber であり、node 環境に実物が
 * 無いため記録付きの最小オブジェクトを注入する (モジュール置換は行わない)。
 */
export interface SubscriberLifecycleControl {
  currentState: MediaSubscriberState;
  // 閉状態の専用フラグ (close() の同期部分で立ち、解放の await 中も閉状態を表す)
  closed: boolean;
  // session close 通知の世代番号 (connectToServer が session を作るときに捕捉する値)
  sessionGeneration: number;
  session: Session | null;
  catalogSubscriber: Subscriber | null;
  audioSubscriber: Subscriber | null;
  videoSubscriber: Subscriber | null;
  audioDecoder: { close(): void } | null;
  videoDecoder: { close(): void } | null;
  videoWriter: { close(): Promise<void> } | null;
  videoTrackGenerator: { stop(): void } | null;
  // 音声の出力 (AudioContext と出力先) の組。実装と同じく 1 つにまとめて持つ
  audioOutput: SubscriberAudioOutput | null;
  outputStream: MediaStream | null;
  receivedCatalog: Catalog | null;
  audioTrackInfo: CatalogTrack | null;
  videoTrackInfo: CatalogTrack | null;
  catalogResolve: ((catalog: Catalog) => void) | null;
  catalogReject: ((error: Error) => void) | null;
  catalogFetchInProgress: boolean;
  pendingCatalogObjects: MoqtObject[];
  catalogFetchLastLocation: Location | null;
  catalogTimer: ReturnType<typeof setTimeout> | null;
  catalogReceiveFailed: boolean;
  audioDecoderConfigured: boolean;
  videoDecoderConfigured: boolean;
  lastAppliedVideoConfig: Uint8Array | null;
  lastAppliedAudioConfig: Uint8Array | null;
  // 初期 configure の完了まで保留する Object (解放で破棄する)
  pendingAudioObjects: MoqtObject[];
  pendingVideoObjects: MoqtObject[];
  // 前の Group の stream が開いている間に保留する映像 Object (解放で破棄する)
  videoGroupGate: GroupSwitchGate<MoqtObject>;
  // 復号順の判定 (解放で初期化する)
  videoDecodeOrder: VideoDecodeOrder;
  // 再生の入口 (MediaPlayout)。AudioContext の時計の対応はその中が持つ
  readonly playout: MediaPlayout;
  audioStats: Pick<AudioReceiverStats, "framesReceived" | "bytesReceived">;
  videoStats: VideoReceiverStats;
  handleSessionClose(generation: number): Promise<void>;
}

/** 解放の呼び出し回数 (注入した資源ごとに数える) */
interface LifecycleDisposalCounts {
  catalogUnsubscribes: number;
  audioUnsubscribes: number;
  videoUnsubscribes: number;
  audioDecoderCloses: number;
  videoDecoderCloses: number;
  videoWriterCloses: number;
  videoTrackStops: number;
  audioTrackStops: number;
  audioContextCloses: number;
  sessionCloses: number;
  // 破棄が行われた順序 (呼び出し順の固定用)
  order: string[];
}

/** 破棄記録付きの最小 Subscriber (購読は確立済みの "active" とする) */
export function createRecordingSubscriber(onUnsubscribe: () => void): Subscriber {
  return {
    state: "active",
    unsubscribe: async () => {
      onUnsubscribe();
    },
  } as unknown as Subscriber;
}

/**
 * 解放対象の資源をすべて注入する
 *
 * 解放の段階失敗を検証するため、catalog の unsubscribe と session の close だけは
 * 失敗させられる。それ以外は成功し、呼ばれた回数と順序 (counts.order) を記録する。
 */
export function injectLifecycleResources(
  control: SubscriberLifecycleControl,
  hooks: { catalogUnsubscribeError?: Error; sessionCloseError?: Error } = {},
): LifecycleDisposalCounts {
  const counts: LifecycleDisposalCounts = {
    catalogUnsubscribes: 0,
    audioUnsubscribes: 0,
    videoUnsubscribes: 0,
    audioDecoderCloses: 0,
    videoDecoderCloses: 0,
    videoWriterCloses: 0,
    videoTrackStops: 0,
    audioTrackStops: 0,
    audioContextCloses: 0,
    sessionCloses: 0,
    order: [],
  };

  control.session = {
    close: async () => {
      counts.sessionCloses++;
      counts.order.push("session.close()");
      if (hooks.sessionCloseError) {
        throw hooks.sessionCloseError;
      }
    },
  } as unknown as Session;
  // 最初の段階 (catalog) で失敗させると、後続の段階が止まらないことを検証できる
  control.catalogSubscriber = createRecordingSubscriber(() => {
    counts.catalogUnsubscribes++;
    counts.order.push("catalogSubscriber.unsubscribe()");
    if (hooks.catalogUnsubscribeError) {
      throw hooks.catalogUnsubscribeError;
    }
  });
  control.audioSubscriber = createRecordingSubscriber(() => {
    counts.audioUnsubscribes++;
    counts.order.push("audioSubscriber.unsubscribe()");
  });
  control.videoSubscriber = createRecordingSubscriber(() => {
    counts.videoUnsubscribes++;
    counts.order.push("videoSubscriber.unsubscribe()");
  });
  control.audioDecoder = {
    close: () => {
      counts.audioDecoderCloses++;
      counts.order.push("audioDecoder.close()");
    },
  };
  control.videoDecoder = {
    close: () => {
      counts.videoDecoderCloses++;
      counts.order.push("videoDecoder.close()");
    },
  };
  control.videoWriter = {
    close: async () => {
      counts.videoWriterCloses++;
      counts.order.push("videoWriter.close()");
    },
  };
  control.videoTrackGenerator = {
    stop: () => {
      counts.videoTrackStops++;
      counts.order.push("videoTrackGenerator.stop()");
    },
  };
  // MediaStreamAudioDestinationNode の stream は音声トラックを 1 本持つ
  const audioDestination = {
    stream: {
      getAudioTracks: () => [
        {
          stop: () => {
            counts.audioTrackStops++;
            counts.order.push("audioDestination.track.stop()");
          },
        },
      ],
    },
  } as unknown as MediaStreamAudioDestinationNode;
  const audioContext = {
    close: async () => {
      counts.audioContextCloses++;
      counts.order.push("audioContext.close()");
    },
  } as unknown as AudioContext;
  // 実装と同じ組で持たせ、入口にも同じ組を渡す。音声を構成していない購読 (映像だけ) では
  // 入口に音声が無いため、鳴らす先は渡さない
  const audioOutput = { context: audioContext, destination: audioDestination };
  control.audioOutput = audioOutput;
  if (playoutInternalsOf(control.playout).audio !== null) {
    control.playout.setAudioOutput(audioOutput);
  }
  control.outputStream = {} as MediaStream;
  return counts;
}

/** Promise の失敗を取り出す (async のテストで throw を assert するための定型) */
export async function captureThrown(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * 音声トラックの宣言を作る (共通の値は省略し、違う値だけを渡す)
 *
 * @param overrides - 既定と違う値
 * @returns 音声トラックの宣言
 */
export function makeAudioTrackInfo(overrides: Partial<CatalogTrack> = {}): CatalogTrack {
  return {
    name: "audio",
    packaging: "loc",
    isLive: true,
    ...overrides,
  };
}

/**
 * 映像トラックの宣言を作る (共通の値は省略し、違う値だけを渡す)
 *
 * @param overrides - 既定と違う値
 * @returns 映像トラックの宣言
 */
export function makeVideoTrackInfo(overrides: Partial<CatalogTrack> = {}): CatalogTrack {
  return {
    name: "video",
    packaging: "loc",
    isLive: true,
    ...overrides,
  };
}

/**
 * ライフサイクルのテスト用に、購読を active にして制御口を返す
 *
 * stop / close は "active" からのみ呼べるため、テストの前提をここで揃える。
 *
 * @param subscriber - 購読
 * @returns ライフサイクルの制御口
 */
export function activateLifecycleControl(
  subscriber: MediaSubscriberImpl,
): SubscriberLifecycleControl {
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  return control;
}

/** 復号器の代役を入れて、復号へ渡った payload の先頭バイトを記録する制御口 */
interface RecordingDecoderControl {
  audioDecoder: unknown;
  videoDecoder: unknown;
  audioDecoderConfigured: boolean;
  videoDecoderConfigured: boolean;
}

/**
 * 音声の復号器の代役を入れて、復号へ渡った payload の先頭バイトを記録する
 *
 * @param control - 購読の制御口
 * @returns 復号へ渡った payload の先頭バイトの記録
 */
export function installRecordingAudioDecoder(control: {
  audioDecoder: unknown;
  audioDecoderConfigured: boolean;
}): number[] {
  const decoded: number[] = [];
  (control as RecordingDecoderControl).audioDecoder = {
    configure: async () => {},
    decode: (payload: Uint8Array) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.audioDecoderConfigured = true;
  return decoded;
}

/**
 * 映像の復号器の代役を入れて、復号へ渡った payload の先頭バイトを記録する
 *
 * @param control - 購読の制御口
 * @returns 復号へ渡った payload の先頭バイトの記録
 */
export function installRecordingVideoDecoder(control: {
  videoDecoder: unknown;
  videoDecoderConfigured: boolean;
}): number[] {
  const decoded: number[] = [];
  (control as RecordingDecoderControl).videoDecoder = {
    configure: async () => {},
    decode: (payload: Uint8Array) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  return decoded;
}

/** テストで使う MOQT サーバーの URL (すべての購読で同じものを使う) */
const TEST_SUBSCRIBER_URL = "moqt://example.com/live";

/** `createTestSubscriber` の購読設定 (namespace は既定で `["live"]`) */
export type TestSubscriberOptions = Omit<MediaSubscriberOptions, "namespace"> & {
  readonly namespace?: string[];
};

/** `createTestSubscriber` が作る購読と、その購読の状態の記録 */
export interface TestSubscriber {
  /** 作成した購読 */
  readonly subscriber: MediaSubscriberImpl;
  /** `onStateChange` で届いた状態遷移の記録 */
  readonly states: MediaSubscriberState[];
  /** `onClose` が呼ばれた回数を返す */
  readonly closeCount: () => number;
  /** `onError` で届いた失敗の記録 */
  readonly errors: Error[];
  /** `onCatalog` で届いたカタログの記録 */
  readonly catalogs: Catalog[];
}

/**
 * テスト用の購読を作る
 *
 * URL・namespace・状態遷移と終了の記録を 1 か所にまとめる。`callbacks` を渡すと
 * `onStateChange` / `onClose` 以外の通知を受け取れる (指定した `onStateChange` /
 * `onClose` も、記録のあとに呼ばれる)。
 *
 * @param options - 購読の設定。省略すると namespace だけを指定した購読になる
 * @param callbacks - 購読の通知の受け取り先
 * @returns 購読と記録
 */
export function createTestSubscriber(
  options: TestSubscriberOptions = {},
  callbacks: MediaSubscriberCallbacks = {},
): TestSubscriber {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const catalogs: Catalog[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    TEST_SUBSCRIBER_URL,
    { ...options, namespace: options.namespace ?? ["live"] },
    {
      ...callbacks,
      onStateChange: (state) => {
        states.push(state);
        callbacks.onStateChange?.(state);
      },
      onClose: () => {
        closeCount += 1;
        callbacks.onClose?.();
      },
      onError: (error) => {
        errors.push(error);
        callbacks.onError?.(error);
      },
      onCatalog: (catalog) => {
        catalogs.push(catalog);
        callbacks.onCatalog?.(catalog);
      },
    },
  );
  return { subscriber, states, errors, catalogs, closeCount: () => closeCount };
}
