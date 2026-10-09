/**
 * MediaSubscriber の単体テスト
 *
 * processCatalogPayload / filterPendingCatalogObjects / isVideoKeyFrameObject /
 * resolveAuthorizationToken の純関数ロジック、映像 Object のキーフレーム判定が
 * VideoDecoder と videoStats に伝わること (handleVideoObject)、復号フレーム破棄の
 * 所有権 (handleVideoDecodedData / handleAudioDecodedData)、Catalog 取得失敗後の
 * hygiene、extractTrackInfo の role なし解決と未解決通知、Track Property の
 * VIDEO_CONFIG / AUDIO_CONFIG の初期 configure への反映と保留キュー、音声と映像の
 * 表示時刻 (targetLatency の解決、共有の時間軸、AudioContext の時計との換算)、
 * 停止と終端のライフサイクル (stop / close の解放と単発性、start の受け付けと失敗時の
 * 巻き戻し、解放が先行したときの中止) を検証する。
 */

import { test, assert } from "vite-plus/test";
import { MediaSubscriberImpl } from "./createMediaSubscriber";
import type { MediaConnectSettings } from "./createMedia/connect";
import type { FetchOptions, Session, SubscribeOptions } from "./session";
import type { Subscriber, RequestUpdateOptions } from "./subscriber";
import type {
  AudioReceiverStats,
  MediaReceiverStats,
  MediaSubscriberCallbacks,
  MediaSubscriberState,
  VideoReceiverStats,
} from "./codec/types";
import { TrackPropertyId } from "./properties";
import type { Fetcher } from "./fetcher";
import {
  encodeCatalog,
  encodeCatalogDelta,
  type Catalog,
  type CatalogDelta,
  type CatalogTrack,
} from "./msf";
import {
  catalogFetchFilter,
  filterPendingCatalogObjects,
  isVideoKeyFrameObject,
  processCatalogPayload,
  resolveAuthorizationToken,
} from "./createMediaSubscriber";
import * as LOC from "./loc";
import type { VideoFrameMarking } from "./loc";
import { type MoqtObject } from "./dataStream";
import type { SubgroupStreamEnd } from "./session";
import { GROUP_SWITCH_HOLD_MS, type GroupSwitchGate } from "./groupSwitchGate";
import type { VideoDecodeOrder } from "./videoDecodeOrder";
import type { AuthorizationToken, Location } from "./message";
import {
  useValueToken,
  waitForUnhandledRejectionDetection,
  withUnhandledRejectionWatch,
} from "./testSupport/helpers";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AudioClockBridge,
  type AudioClockMapping,
  type AudioPlayoutScheduler,
} from "./audioPlayout";
import {
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  MAX_PLAYOUT_DELAY_MS,
  PlaybackTimeline,
} from "./playbackTimeline";

/** テスト用の最小フルカタログ */
function makeCatalog(tracks: Catalog["tracks"] = []): Catalog {
  return {
    version: "draft-01",
    tracks,
  };
}

test("processCatalogPayload: フルカタログは current を置換する", () => {
  // 既存カタログがある状態で独立フルを受け取ると置換する
  const current = makeCatalog([{ name: "old", packaging: "loc", isLive: true }]);
  const next = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(current, encodeCatalog(next));

  assert.equal(result.kind, "full");
  assert.deepStrictEqual(result.catalog, next);
});

test("processCatalogPayload: null からのフルカタログは置換する", () => {
  // 初回受信は current=null からのフル置換
  const next = makeCatalog([{ name: "audio", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(null, encodeCatalog(next));

  assert.equal(result.kind, "full");
  assert.deepStrictEqual(result.catalog, next);
});

test("processCatalogPayload: delta を applyCatalogDelta で適用する", () => {
  // 既存フルに add operation の delta を適用する
  const current = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(current, encodeCatalogDelta(delta));

  assert.equal(result.kind, "delta");
  assert.deepStrictEqual(result.catalog, {
    version: "draft-01",
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  });
});

test("processCatalogPayload: current=null の delta は ignored になる", () => {
  // フル未受信時の delta はサイレント無視（error にしない）
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(null, encodeCatalogDelta(delta));

  assert.equal(result.kind, "ignored");
  assert.equal(result.catalog, null);
});

test("processCatalogPayload: apply 失敗時は current を維持して error を返す", () => {
  // isComplete=true 確定後の add は §5.1.3 で reject される
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    isComplete: true,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(current, encodeCatalogDelta(delta));

  assert.equal(result.kind, "error");
  assert.deepStrictEqual(result.catalog, current);
  assert.ok(result.kind === "error" && result.error instanceof Error);
  if (result.kind === "error") {
    assert.match(result.error.message, /cannot add tracks after isComplete=true/);
  }
});

test("processCatalogPayload: decode 失敗時は current を維持して error を返す", () => {
  // 不正 JSON は decode 失敗として error になる
  const current = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(current, new TextEncoder().encode("not-json"));

  assert.equal(result.kind, "error");
  assert.deepStrictEqual(result.catalog, current);
  assert.ok(result.kind === "error" && result.error instanceof Error);
  if (result.kind === "error") {
    // JSON.parse 由来の SyntaxError が伝播する
    assert.ok(result.error instanceof SyntaxError || /JSON|Unexpected/i.test(result.error.message));
  }
});

test("processCatalogPayload: current=null の decode 失敗も error を返す", () => {
  // catalog 未受信時の不正 payload も error（catalog は null 維持）
  const result = processCatalogPayload(null, new TextEncoder().encode("not-json"));

  assert.equal(result.kind, "error");
  assert.equal(result.catalog, null);
  assert.ok(result.kind === "error" && result.error instanceof Error);
});

// ============================================================================
// filterPendingCatalogObjects（FETCH と live の二重配信除去）
// ============================================================================

/** テスト用の Catalog オブジェクトを構築する */
function makeCatalogObject(groupId: bigint, objectId: bigint): MoqtObject {
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
const keyFrameMarking: VideoFrameMarking = {
  isIndependent: true,
  isDiscardable: false,
  isBaseLayerSync: true,
  temporalLayerId: 0,
  spatialLayerId: 0,
};
// デルタフレームでは isBaseLayerSync も false (publisher はキーフレーム判定を渡す)
const deltaFrameMarking: VideoFrameMarking = {
  ...keyFrameMarking,
  isIndependent: false,
  isBaseLayerSync: false,
};

test("filterPendingCatalogObjects: 空配列は空を返す", () => {
  assert.deepEqual(filterPendingCatalogObjects([], { group: 0n, object: 0n }), []);
});

test("filterPendingCatalogObjects: FETCH で配信済みと同一 Location を除去する", () => {
  // FETCH 側で既に適用済みのオブジェクトが live でも届いた場合 (二重配信) は除外する
  const pending = [makeCatalogObject(0n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 0n, object: 0n });
  assert.deepEqual(result, []);
});

test("filterPendingCatalogObjects: より古い Group のオブジェクトを除去し新しい Group は残す", () => {
  const pending = [makeCatalogObject(0n, 5n), makeCatalogObject(2n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 0n });
  assert.deepEqual(result, [makeCatalogObject(2n, 0n)]);
});

test("filterPendingCatalogObjects: 同一 Group で FETCH 配信済み以下の Object を除去する", () => {
  const pending = [makeCatalogObject(1n, 0n), makeCatalogObject(1n, 2n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 2n });
  assert.deepEqual(result, []);
});

test("filterPendingCatalogObjects: より新しい Group のオブジェクトは残す", () => {
  const pending = [makeCatalogObject(2n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 0n });
  assert.deepEqual(result, [makeCatalogObject(2n, 0n)]);
});

test("filterPendingCatalogObjects: 同一 Group で FETCH 配信済みより新しい Object は残す", () => {
  const pending = [makeCatalogObject(1n, 3n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 2n });
  assert.deepEqual(result, [makeCatalogObject(1n, 3n)]);
});

// ============================================================================
// isVideoKeyFrameObject（draft-ietf-moq-loc-04 §2.2 / §2.3.2.2 / §4.2）
// ============================================================================

/**
 * draft-ietf-moq-loc-04 §2.2 / §2.3.2.2 と draft-ietf-moq-msf-01 §6.2 / §4.1:
 * VIDEO_FRAME_MARKING は任意の Property であり、draft-ietf-moq-msf-01 も要求しない。無い場合は
 * Group 先頭の Object ID 0 (Group ID は IDR 境界で +1 され、Object ID は Group
 * 先頭で 0 に戻る) をキーフレームとして扱い、それ以外はデルタにする。
 */
test("isVideoKeyFrameObject: Frame Marking が無ければ Object ID 0 をキーフレームにする", () => {
  assert.isTrue(isVideoKeyFrameObject(0n, undefined));
  assert.isFalse(isVideoKeyFrameObject(1n, undefined));
  assert.isFalse(isVideoKeyFrameObject(30n, undefined));
});

/**
 * Frame Marking がある場合はその isIndependent を優先する
 * (Object ID 0 でも delta と言えば delta、Object ID 0 以外でも key と言えば key)。
 */
test("isVideoKeyFrameObject: Frame Marking がある場合は isIndependent を優先する", () => {
  assert.isTrue(isVideoKeyFrameObject(0n, keyFrameMarking));
  assert.isFalse(isVideoKeyFrameObject(0n, deltaFrameMarking));
  assert.isTrue(isVideoKeyFrameObject(3n, keyFrameMarking));
  assert.isFalse(isVideoKeyFrameObject(3n, deltaFrameMarking));
});

// ============================================================================
// resolveAuthorizationToken（draft-ietf-moq-msf-01 §5.2.42 / §11.4.2 / §11.4.4）
// ============================================================================

test("resolveAuthorizationToken: authInfo 未指定は認可不要で undefined", async () => {
  assert.equal(await resolveAuthorizationToken(undefined), undefined);
});

test("resolveAuthorizationToken: 空の authInfo は認可不要で undefined", async () => {
  assert.equal(await resolveAuthorizationToken({}), undefined);
});

test("resolveAuthorizationToken: authInfo あり・コールバック未提供は throw（§11.4.4）", async () => {
  // トークン欠落時のエラーが呼び出し元に伝わることを検証する
  let error: unknown;
  try {
    await resolveAuthorizationToken({ "privacy-pass": {} });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("no getAuthorizationToken callback was provided"));
});

test("resolveAuthorizationToken: コールバックが undefined を返すと throw（§11.4.4）", async () => {
  let error: unknown;
  try {
    await resolveAuthorizationToken({ cat: {} }, () => undefined);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("getAuthorizationToken returned no token"));
});

test("resolveAuthorizationToken: コールバックが返したトークンを解決する", async () => {
  const token = useValueToken();
  const resolved = await resolveAuthorizationToken({ "privacy-pass": {} }, () => token);
  assert.equal(resolved, token);
});

test("resolveAuthorizationToken: 非同期コールバックにも対応する", async () => {
  const token = useValueToken();
  const resolved = await resolveAuthorizationToken({ cat: {} }, async () => token);
  assert.equal(resolved, token);
});

// draft-ietf-moq-msf-01 §11.4.3: コールバックが無い場合は、SETUP Option (0x03) として
// 送ったトークン (MOQT URI の msf fragment の c4m など) を既定のトークンとして使う
test("resolveAuthorizationToken: コールバックが無ければ SETUP のトークンを使う", async () => {
  const token = useValueToken();
  const resolved = await resolveAuthorizationToken({ cat: {} }, undefined, token);
  assert.equal(resolved, token);
});

// 明示のコールバックは SETUP のトークンより優先する (§11.4.2: 取得方法は呼び出し側が決める)
test("resolveAuthorizationToken: コールバックは SETUP のトークンより優先する", async () => {
  const callbackToken = useValueToken();
  const setupToken = useValueToken();
  const resolved = await resolveAuthorizationToken({ cat: {} }, () => callbackToken, setupToken);
  assert.equal(resolved, callbackToken);
});

// コールバックが undefined を返した場合は、SETUP のトークンがあってもエラーにする
// (§11.4.4: トークンを取得できない場合の失敗を握らない)
test("resolveAuthorizationToken: コールバックが undefined を返したら SETUP のトークンでも throw", async () => {
  let error: unknown;
  try {
    await resolveAuthorizationToken({ cat: {} }, () => undefined, useValueToken());
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("getAuthorizationToken returned no token"));
});

// authInfo が無ければ認可は不要であり、SETUP のトークンも付与しない (§5.2.42)
test("resolveAuthorizationToken: authInfo が無ければ SETUP のトークンを使わない", async () => {
  assert.equal(await resolveAuthorizationToken(undefined, undefined, useValueToken()), undefined);
  assert.equal(await resolveAuthorizationToken({}, undefined, useValueToken()), undefined);
});

/**
 * 初期 configure (Track Property の config) の検証用の制御口
 *
 * SUBSCRIBE_OK の trackProperties を注入し、configure に渡る description と decode に
 * 渡る Object を観測する。VideoDecoderWrapper は動作にブラウザの VideoDecoder を
 * 必要とするため、記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
interface SubscriberInitialConfigControl {
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
  videoSubscriber: { trackProperties?: { id: bigint; data?: Uint8Array }[] } | null;
  audioSubscriber: { trackProperties?: { id: bigint; data?: Uint8Array }[] } | null;
  // configure は codec / 解像度 / サンプルレートを Catalog の track info から解決するため注入する
  videoTrackInfo: CatalogTrack | null;
  audioTrackInfo: CatalogTrack | null;
  handleVideoObject(obj: MoqtObject): void;
  handleAudioObject(obj: MoqtObject): void;
  applyInitialVideoConfig(): Promise<void>;
  applyInitialAudioConfig(): Promise<void>;
}

/** 再構成 (fire-and-forget) の完了を待つ */
async function waitForConfigured(control: SubscriberInitialConfigControl): Promise<void> {
  for (let i = 0; i < 10 && !control.videoDecoderConfigured; i++) {
    await Promise.resolve();
  }
}

/** payload の先頭バイトで Object を識別する (到着順の検証用) */
function makeIdentifiedObject(objectId: bigint, marker: number): MoqtObject {
  return {
    groupId: 1n,
    objectId,
    status: 0,
    payload: new Uint8Array([marker]),
  };
}

/**
 * draft-ietf-moq-loc-04 Table 1 / §2.3.2.1:
 * VIDEO_CONFIG は Track Property でも届く。SUBSCRIBE_OK の Track Property を初期 configure に
 * 反映し、その完了までに届いた Object を保留して復号に渡す (最初の Object を捨てない)。
 */
test("applyInitialVideoConfig: Track Property の VIDEO_CONFIG が初期 configure に渡り保留中の Object が復号される", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const configured: Uint8Array[] = [];
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async (_codec, _width, _height, description) => {
      configured.push(description === undefined ? new Uint8Array(0) : new Uint8Array(description));
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  // subscribeMediaTracks が購読要求より前に有効化する状態を再現する
  // (有効化の配線は subscribeMediaTracks のテストで固定し、ここでは保留キューと
  //  解放の挙動だけを検証する)
  control.videoInitialConfigPending = true;
  control.videoSubscriber = {
    trackProperties: [
      {
        id: LOC.LOCPropertyId.VIDEO_CONFIG,
        data: new Uint8Array([1, 2, 3]),
      },
    ],
  };

  // 保留中に届いた Object は decode に渡らず、到着順で保持される
  control.handleVideoObject(makeIdentifiedObject(0n, 0x11));
  control.handleVideoObject(makeIdentifiedObject(1n, 0x22));
  assert.deepEqual(decoded, []);

  await control.applyInitialVideoConfig();

  // 初期 configure に Track Property の config が渡る
  assert.equal(configured.length, 1);
  assert.deepEqual(Array.from(configured[0] ?? []), [1, 2, 3]);
  // 保留していた Object が到着順に復号される (再構成で捨てられない)
  assert.deepEqual(decoded, [0x11, 0x22]);
});

/**
 * draft-ietf-moq-loc-04 Table 1 / §2.3.2.1:
 * subscribeMediaTracks は購読確立直後 (SUBSCRIBE_OK の trackProperties 取得後) に
 * 初期 configure を適用する。最小の Session 代役で subscribe の戻り値を与え、
 * 配線 (setupDecoders が有効化した保留 → 購読直後の適用 → 解放) を固定する。
 */
test("subscribeMediaTracks: SUBSCRIBE_OK の Track Property を購読直後に初期 configure へ適用する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "av1" },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl & {
    session: {
      subscribe(
        namespace: string[],
        trackName: string,
        callbacks: { object: (obj: MoqtObject) => void },
      ): Promise<{ trackProperties: { id: bigint; data?: Uint8Array }[] }>;
    } | null;
    videoTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  const configured: Uint8Array[] = [];
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async (_codec, _width, _height, description) => {
      configured.push(description === undefined ? new Uint8Array(0) : new Uint8Array(description));
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  // 購読確立前に配送された Object を購読直後に流す (保留に積まれることを確認する)
  control.session = {
    subscribe: async (_namespace, _trackName, callbacks) => {
      // 購読要求より前に保留が有効化されている (購読確立前の配送も取りこぼさない)
      assert.isTrue(control.videoInitialConfigPending);
      callbacks.object(makeIdentifiedObject(0n, 0x77));
      return {
        trackProperties: [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([3, 3]) }],
      } as unknown as { trackProperties: { id: bigint; data?: Uint8Array }[] };
    },
  };

  await control.subscribeMediaTracks(control.sessionGeneration);

  // 購読直後に Track Property の config が適用され、保留していた Object が復号される
  assert.equal(configured.length, 1);
  assert.deepEqual(Array.from(configured[0] ?? []), [3, 3]);
  assert.deepEqual(decoded, [0x77]);
  assert.isFalse(control.videoInitialConfigPending);
});

/**
 * draft-ietf-moq-loc-04 Table 1 / §2.3.3.1:
 * subscribeMediaTracks は音声でも購読確立直後に初期 configure を適用する。
 * 映像側と同じ配線 (購読要求前の保留有効化 → 購読直後の適用 → 到着順の解放) を固定する。
 */
test("subscribeMediaTracks: 音声も SUBSCRIBE_OK の Track Property を購読直後に適用する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl & {
    session: {
      subscribe(
        namespace: string[],
        trackName: string,
        callbacks: { object: (obj: MoqtObject) => void },
      ): Promise<{ trackProperties: { id: bigint; data?: Uint8Array }[] }>;
    } | null;
    audioTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  const configured: Uint8Array[] = [];
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async (_codec, _sampleRate, _channels, description) => {
      configured.push(description === undefined ? new Uint8Array(0) : new Uint8Array(description));
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.audioDecoderConfigured = true;
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48000,
    channelConfig: "2",
  };
  control.session = {
    subscribe: async (_namespace, _trackName, callbacks) => {
      // 購読要求より前に保留が有効化されている
      assert.isTrue(control.audioInitialConfigPending);
      callbacks.object(makeIdentifiedObject(0n, 0x88));
      return {
        trackProperties: [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([6, 6]) }],
      } as unknown as { trackProperties: { id: bigint; data?: Uint8Array }[] };
    },
  };

  await control.subscribeMediaTracks(control.sessionGeneration);

  assert.equal(configured.length, 1);
  assert.deepEqual(Array.from(configured[0] ?? []), [6, 6]);
  assert.deepEqual(decoded, [0x88]);
  assert.isFalse(control.audioInitialConfigPending);
});

/**
 * subscribeMediaTracks の購読オプションを捕捉する制御口
 *
 * 音声トラックを 1 本だけ購読し、`session.subscribe` に渡された options を記録する。
 * `authInfo` を渡すと認可が必要な track になる (§5.2.42)。
 */
function createMediaTrackSubscribeCapture(authInfo?: CatalogTrack["authInfo"]): {
  control: SubscriberInitialConfigControl & {
    session: Session | null;
    audioTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  captured: Array<SubscribeOptions | undefined>;
} {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl & {
    session: Session | null;
    audioTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  control.audioDecoder = {
    configure: async () => {},
    decode: () => {},
  };
  control.audioDecoderConfigured = true;
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48000,
    channelConfig: "2",
    ...(authInfo === undefined ? {} : { authInfo }),
  };
  const captured: Array<SubscribeOptions | undefined> = [];
  control.session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>): Promise<Subscriber> => {
      captured.push(args[3]);
      return { trackProperties: [] } as unknown as Subscriber;
    },
  } as unknown as Session;
  return { control, captured };
}

/**
 * draft-ietf-moq-msf-01 §5.2.42 / §11.4.3:
 * authInfo を持つ track の SUBSCRIBE には、SETUP Option (0x03) として送ったトークンを付与する。
 * getAuthorizationToken コールバックが無い場合の既定のトークンになる。
 */
test("subscribeMediaTracks: authInfo を持つ track に SETUP のトークンを付与する", async () => {
  const { control, captured } = createMediaTrackSubscribeCapture({ cat: {} });
  const token = useValueToken();
  (
    control.session as unknown as { setupAuthorizationToken: AuthorizationToken | undefined }
  ).setupAuthorizationToken = token;

  await control.subscribeMediaTracks(control.sessionGeneration);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.authorizationToken, token);
});

// authInfo を持たない track は認可が不要なため、SETUP のトークンを付与しない (§5.2.42)
test("subscribeMediaTracks: authInfo を持たない track には SETUP のトークンを付与しない", async () => {
  const { control, captured } = createMediaTrackSubscribeCapture();
  (
    control.session as unknown as { setupAuthorizationToken: AuthorizationToken | undefined }
  ).setupAuthorizationToken = useValueToken();

  await control.subscribeMediaTracks(control.sessionGeneration);

  assert.equal(captured.length, 1);
  assert.isUndefined(captured[0]?.authorizationToken);
});

// authInfo があり SETUP にもトークンが無い場合は、購読前にエラーにする (§11.4.4)
test("subscribeMediaTracks: authInfo があり SETUP にもトークンが無ければ throw する", async () => {
  const { control } = createMediaTrackSubscribeCapture({ cat: {} });

  let error: unknown;
  try {
    await control.subscribeMediaTracks(control.sessionGeneration);
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("no getAuthorizationToken callback was provided"));
});

/**
 * draft-ietf-moq-loc-04 §2.3.2.1:
 * 初期 configure で適用済みの config と同じ config を持つ Object では再構成しない。
 */
test("applyInitialVideoConfig: 適用後に同じ config の Object では再構成しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  let configureCount = 0;
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {
      configureCount++;
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  control.videoInitialConfigPending = true;
  const config = new Uint8Array([9, 9]);
  control.videoSubscriber = {
    trackProperties: [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: config }],
  };

  await control.applyInitialVideoConfig();
  assert.equal(configureCount, 1);

  // Object Property に config が無い Object は Track Property の config を使うため再構成しない
  control.handleVideoObject(makeIdentifiedObject(0n, 0x33));
  assert.equal(configureCount, 1);
  assert.deepEqual(decoded, [0x33]);
});

/**
 * draft-ietf-moq-loc-04 §2.3.2.1:
 * 初期 configure の適用に失敗した場合は onError を通知し、後続の Object で再試行して復号を続ける。
 */
test("applyInitialVideoConfig: 適用失敗は onError を通知し後続の Object で再試行する", async () => {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  let configureCount = 0;
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {
      configureCount++;
      // 1 回目だけ失敗させる (初期 configure の失敗)
      if (configureCount === 1) {
        throw new Error("configure failed");
      }
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  control.videoInitialConfigPending = true;
  const config = new Uint8Array([7, 7]);
  control.videoSubscriber = {
    trackProperties: [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: config }],
  };

  control.handleVideoObject(makeIdentifiedObject(0n, 0x44));
  await control.applyInitialVideoConfig();

  // 失敗は onError で通知される
  assert.ok(errors[0] instanceof Error);
  assert.isTrue(errors[0].message.includes("configure failed"));
  // 保留分の解放で再構成が 1 回起動し、その Object は再構成のため捨てられる
  assert.equal(configureCount, 2);
  assert.deepEqual(decoded, []);
  // 再構成した decoder はキーフレームから始める。捨てた Object 0 を参照する Object 1 は
  // 復号せず (参照先の欠落)、次の Group の先頭 (キーフレーム) から復号を続ける
  await waitForConfigured(control);
  control.handleVideoObject(makeIdentifiedObject(1n, 0x55));
  assert.equal(configureCount, 2);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.getStats().video?.missingReferenceFramesDropped, 1);
  control.handleVideoObject({ ...makeIdentifiedObject(0n, 0x66), groupId: 2n });
  assert.deepEqual(decoded, [0x66]);
});

/**
 * draft-ietf-moq-loc-04 Table 1 / §2.3.3.1:
 * 音声側も Track Property の AUDIO_CONFIG を初期 configure に反映し、保留中の Object を復号する。
 */
test("applyInitialAudioConfig: Track Property の AUDIO_CONFIG が初期 configure に渡り保留中の Object が復号される", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const configured: Uint8Array[] = [];
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async (_codec, _sampleRate, _channels, description) => {
      configured.push(description === undefined ? new Uint8Array(0) : new Uint8Array(description));
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.audioDecoderConfigured = true;
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "opus" };
  control.audioInitialConfigPending = true;
  control.audioSubscriber = {
    trackProperties: [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([4, 5]) }],
  };

  control.handleAudioObject(makeIdentifiedObject(0n, 0x66));
  await control.applyInitialAudioConfig();

  assert.equal(configured.length, 1);
  assert.deepEqual(Array.from(configured[0] ?? []), [4, 5]);
  assert.deepEqual(decoded, [0x66]);
});

/**
 * 再構成は reject しない契約であり、同期 throw し得る codec / channels の解決も
 * onError に 1 回届ける。解決できない codec は setupDecoders が先に検査するため現行の
 * 値では到達しないが、`void` 呼び出し側に未処理の rejection を残さないための防御である。
 * cast で解決できない codec を注入して駆動する。
 */
test("handleAudioObject: 再構成の codec 解決が throw しても onError に 1 回届く", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], audio: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberInitialConfigControl;
    let configureCount = 0;
    control.audioDecoder = {
      configure: async () => {
        configureCount++;
      },
      decode: () => {},
    };
    control.audioDecoderConfigured = true;
    // 解決できない codec を注入する (parseAudioCodec が同期 throw する)
    control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "bogus" };

    // Object Property の AUDIO_CONFIG が直前と違うため再構成の分岐に入る
    control.handleAudioObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0xaa]),
      properties: LOC.encodeAudioProperties({
        timestamp: 0n,
        config: new Uint8Array([1, 2, 3]),
      }),
    });

    await waitForUnhandledRejectionDetection();

    // 同期 throw は onError に 1 回だけ届き、configure へは進まない
    assert.equal(errors.length, 1);
    assert.isTrue((errors[0]?.message ?? "").includes("unsupported audio codec"));
    assert.equal(configureCount, 0);
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 再構成の失敗通知 (onError) が throw しても、再構成の経路は reject しない。
 * 通知の失敗を伝える経路が他に無いため握り潰す。呼び出し側 (handleAudioObject) は
 * `void` で呼ぶため、reject を残すと未処理の rejection になる。
 */
test("handleAudioObject: 再構成の onError が throw しても未処理の rejection にならない", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const notificationFailure = new Error("onError failure");
    const notified: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], audio: {} },
      {
        onError: (error) => {
          notified.push(error);
          throw notificationFailure;
        },
      },
    );
    const control = subscriber as unknown as SubscriberInitialConfigControl;
    let configureCount = 0;
    control.audioDecoder = {
      configure: async () => {
        configureCount++;
      },
      decode: () => {},
    };
    control.audioDecoderConfigured = true;
    // 解決できない codec を注入する (parseAudioCodec が同期 throw する)
    control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "bogus" };

    // Object Property の AUDIO_CONFIG が直前と違うため再構成の分岐に入る
    control.handleAudioObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0xaa]),
      properties: LOC.encodeAudioProperties({
        timestamp: 0n,
        config: new Uint8Array([1, 2, 3]),
      }),
    });

    await waitForUnhandledRejectionDetection();

    // 通知は codec の解決失敗の 1 回だけで、通知の失敗が未処理の rejection として残らないこと
    assert.equal(notified.length, 1);
    assert.isTrue((notified[0]?.message ?? "").includes("unsupported audio codec"));
    assert.equal(configureCount, 0);
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 映像側の再構成も同じ契約であり、同期 throw し得る codec の解決を onError に 1 回届ける。
 * cast で解決できない codec を注入して駆動する。
 */
test("handleVideoObject: 再構成の codec 解決が throw しても onError に 1 回届く", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberInitialConfigControl;
    let configureCount = 0;
    control.videoDecoder = {
      configure: async () => {
        configureCount++;
      },
      decode: () => {},
    };
    control.videoDecoderConfigured = true;
    // 解決できない codec を注入する (parseVideoCodec が同期 throw する)
    control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "bogus" };

    // Object Property の VIDEO_CONFIG が直前と違うため再構成の分岐に入る
    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0xaa]),
      properties: LOC.encodeVideoProperties({
        timestamp: 0n,
        config: new Uint8Array([1, 2, 3]),
      }),
    });

    await waitForUnhandledRejectionDetection();

    assert.equal(errors.length, 1);
    assert.isTrue((errors[0]?.message ?? "").includes("unsupported video codec"));
    assert.equal(configureCount, 0);
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 映像側の再構成も、失敗通知 (onError) が throw しても reject しない。
 * 呼び出し側 (handleVideoObject) は `void` で呼ぶため、reject を残すと
 * 未処理の rejection になる。
 */
test("handleVideoObject: 再構成の onError が throw しても未処理の rejection にならない", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const notificationFailure = new Error("onError failure");
    const notified: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], video: {} },
      {
        onError: (error) => {
          notified.push(error);
          throw notificationFailure;
        },
      },
    );
    const control = subscriber as unknown as SubscriberInitialConfigControl;
    let configureCount = 0;
    control.videoDecoder = {
      configure: async () => {
        configureCount++;
      },
      decode: () => {},
    };
    control.videoDecoderConfigured = true;
    // 解決できない codec を注入する (parseVideoCodec が同期 throw する)
    control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "bogus" };

    // Object Property の VIDEO_CONFIG が直前と違うため再構成の分岐に入る
    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0xaa]),
      properties: LOC.encodeVideoProperties({
        timestamp: 0n,
        config: new Uint8Array([1, 2, 3]),
      }),
    });

    await waitForUnhandledRejectionDetection();

    // 通知は codec の解決失敗の 1 回だけで、通知の失敗が未処理の rejection として残らないこと
    assert.equal(notified.length, 1);
    assert.isTrue((notified[0]?.message ?? "").includes("unsupported video codec"));
    assert.equal(configureCount, 0);
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 映像 Object の判定・統計・デコードの検証用の制御口
 *
 * handleVideoObject を直接駆動し、キーフレーム判定が VideoDecoderWrapper と
 * videoStats に伝わることを検証する。VideoDecoderWrapper は configure にブラウザの
 * VideoDecoder を必要とし node 環境では構成できないため、記録用の最小オブジェクトを
 * 注入する (モジュール置換は行わない)。
 */
interface SubscriberVideoObjectControl {
  videoDecoder: {
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  videoDecoderConfigured: boolean;
  handleVideoObject(obj: MoqtObject): void;
}

/**
 * 映像 Object を作る (Properties は VIDEO_FRAME_MARKING のワイヤ)
 */
function makeVideoObject(objectId: bigint, properties?: Uint8Array): MoqtObject {
  return {
    groupId: 1n,
    objectId,
    status: 0,
    payload: new Uint8Array([0xaa]),
    ...(properties === undefined ? {} : { properties }),
  };
}

/**
 * draft-ietf-moq-loc-04 §2.2 / §2.3.2.2:
 * VIDEO_FRAME_MARKING が無い Object 列でも Group 先頭がキーフレームとして
 * VideoDecoder に渡り、videoStats の keyFramesReceived に数えられる。
 */
test("handleVideoObject: Frame Marking が無ければ Group 先頭を key としてデコードする", () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberVideoObjectControl;
  const decoded: { type: string; timestamp: number }[] = [];
  control.videoDecoder = {
    decode: (_payload, type, timestamp) => {
      decoded.push({ type, timestamp });
    },
  };
  control.videoDecoderConfigured = true;
  // Track Properties は使わない (Object の Properties だけで判定する)

  control.handleVideoObject(makeVideoObject(0n));
  control.handleVideoObject(makeVideoObject(1n));
  control.handleVideoObject(makeVideoObject(2n));

  assert.deepEqual(decoded, [
    { type: "key", timestamp: 0 },
    { type: "delta", timestamp: 0 },
    { type: "delta", timestamp: 0 },
  ]);
  const stats = subscriber.getStats().video;
  assert.isNotNull(stats);
  assert.equal(stats?.framesReceived, 3);
  assert.equal(stats?.keyFramesReceived, 1);
  // 1 件あたり payload 1 バイト (Properties は付けない)
  assert.equal(stats?.bytesReceived, 3);
});

/**
 * Frame Marking がある場合はそれを優先し、Object ID 0 でもキーフレームとして扱わない。
 *
 * draft-ietf-moq-transport-22 Section 2.3: Group の Object は他の Group の Object に依存
 * しないことが求められる (SHOULD NOT)。Group の先頭が delta の場合、参照するフレームは
 * Group の外にあり、復号していないため decoder へ渡さない。キーフレームとして扱えば
 * 復号されるため、渡らないことで delta として扱ったことを確かめる。
 */
test("handleVideoObject: Frame Marking がある場合は Object ID 0 でもキーフレームにしない", () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberVideoObjectControl;
  const decoded: { type: string; timestamp: number }[] = [];
  control.videoDecoder = {
    decode: (_payload, type, timestamp) => {
      decoded.push({ type, timestamp });
    },
  };
  control.videoDecoderConfigured = true;

  const deltaWire = LOC.encodeVideoProperties({
    timestamp: 33_333n,
    frameMarking: deltaFrameMarking,
  });
  control.handleVideoObject(makeVideoObject(0n, deltaWire));

  assert.deepEqual(decoded, []);
  assert.equal(subscriber.getStats().video?.keyFramesReceived, 0);
  assert.equal(subscriber.getStats().video?.missingReferenceFramesDropped, 1);
});

/**
 * 受信した映像 Object を Group の切り替えで保留する経路の検証用の制御口
 *
 * object / subgroupEnd コールバックから呼ばれる受け口を直接駆動する。
 */
interface SubscriberVideoGateControl extends SubscriberVideoObjectControl {
  receiveVideoObject(obj: MoqtObject): void;
  receiveVideoSubgroupEnd(end: SubgroupStreamEnd): void;
}

/** Group と Object ID を指定した Subgroup の stream の映像 Object (Frame Marking 無し) */
function makeStreamVideoObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    subgroupId: 0n,
    objectId,
    status: 0,
    payload: new Uint8Array([Number(groupId * 16n + objectId)]),
  };
}

/** 映像の保留を検証する購読を作り、復号に渡した Object の payload を記録する */
function createVideoGateSubscriber(): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberVideoGateControl;
  decoded: number[];
} {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberVideoGateControl;
  const decoded: number[] = [];
  control.videoDecoder = {
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
  };
  control.videoDecoderConfigured = true;
  return { subscriber, control, decoded };
}

/**
 * draft-ietf-moq-transport-22 Section 2.1: Object は順不同で届きうる。後から購読した直後
 * などに、次の Group の先頭 (キーフレーム) が前の Group の最後の Object より先に届くことが
 * ある。前の Group の stream が終わるまで次の Group の Object を保留し、前の Group の末尾を
 * 先に復号する (保留しないと、前の Group の末尾を古い Group として捨てる)
 */
test("receiveVideoObject: 前の Group の stream が終わるまで次の Group の Object を保留する", () => {
  const { subscriber, control, decoded } = createVideoGateSubscriber();

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(1n, 1n));
  // Group 2 の先頭が Group 1 の最後の Object より先に届く
  control.receiveVideoObject(makeStreamVideoObject(2n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(1n, 2n));
  assert.deepEqual(decoded, [0x10, 0x11, 0x12]);
  control.receiveVideoSubgroupEnd({ groupId: 1n, subgroupId: 0n, reason: "fin" });

  assert.deepEqual(decoded, [0x10, 0x11, 0x12, 0x20]);
  assert.equal(subscriber.getStats().video?.staleFramesDropped, 0);
});

// 前の Group の stream が上限の時間を過ぎても終わらなければ、保留した Object を復号する
test("receiveVideoObject: 前の Group の stream が終わらなくても上限の時間で保留を解く", async () => {
  const { control, decoded } = createVideoGateSubscriber();

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(2n, 0n));
  assert.deepEqual(decoded, [0x10]);

  await new Promise((resolve) => {
    setTimeout(resolve, GROUP_SWITCH_HOLD_MS + 30);
  });
  assert.deepEqual(decoded, [0x10, 0x20]);
});

/**
 * 復号フレーム破棄の検証用の制御口
 *
 * 復号ハンドラを直接駆動し、所有権方針どおりに閉じられることを検証する。
 * VideoFrame / AudioData / AudioContext はブラウザ専用 API であり
 * node 環境に実物がないため、記録用の最小オブジェクトを注入する
 * (モジュール置換は行わない)。
 */
interface SubscriberFrameControl {
  videoWriter: { write: (frame: unknown) => Promise<void> } | null;
  audioContext: AudioContext | null;
  audioDestination: MediaStreamAudioDestinationNode | null;
  handleVideoDecodedData(data: { frame: VideoFrame }): void;
  handleAudioDecodedData(data: { data: AudioData }): void;
}

/**
 * 破棄記録付きのテスト用フレーム
 */
function createRecordingFrame(): { frame: VideoFrame; isClosed: () => boolean } {
  let closed = false;
  const frame = {
    close: () => {
      closed = true;
    },
  } as unknown as VideoFrame;
  return { frame, isClosed: () => closed };
}

test("handleVideoDecodedData: 書き込み失敗時に VideoFrame を閉じる", async () => {
  // 書き込み失敗でリークしないことの検証。失敗の通知はしない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: async () => {
      throw new Error("write failed");
    },
  };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });
  // 非同期 catch の完了を microtask の flush で待つ (タイマー不使用)
  await Promise.resolve();
  await Promise.resolve();

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleVideoDecodedData: 書き込み成功時は VideoFrame を閉じない", async () => {
  // 成功時は Generator 所有のため閉じない方針の検証。失敗の通知はしない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: async () => {},
  };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });
  // 非同期 catch の完了を microtask の flush で待つ (タイマー不使用)
  await Promise.resolve();
  await Promise.resolve();

  assert.isFalse(isClosed());
  assert.equal(errors.length, 0);
});

/**
 * 映像デコーダーのエラー通知の検証用の制御口
 *
 * error コールバックは setupDecoders が VideoDecoderWrapper に組むため、その中身を
 * private 経由で直接駆動する。decoder は configure にブラウザの VideoDecoder を要する
 * ため、reset() だけを持つ最小オブジェクトを注入する (モジュール置換は行わない)。
 */
interface SubscriberVideoErrorControl {
  videoDecoder: { reset(): Promise<boolean> } | null;
  videoDecodeOrder: VideoDecodeOrder;
  handleVideoDecoderError(error: Error): void;
}

/**
 * video decoder の error コールバックは reset() の結果を見ない。
 * reset() は例外を投げない Promise<boolean> を返し、false のときは Worker と
 * VideoDecoder の破棄まで reset() の中で完結するため、呼び出し側は打ち切りも再通知も
 * しない (再通知すると恒久エラーで通知が反復する)。エラー 1 件につき通知 1 回と、
 * false を返す reset() で通知が増えないことを固定する。
 */
test("handleVideoDecoderError: reset() が false でも onError は増えない", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberVideoErrorControl;
    let resetCount = 0;
    control.videoDecoder = {
      reset: async () => {
        resetCount++;
        // 再初期化できない場合は false を返し、打ち切りは reset() の中で完結する
        return false;
      },
    };
    // 復号順の判定を進めておく (エラーで初期化されることを観測できる状態にする)
    assert.isTrue(
      control.videoDecodeOrder.admit({
        groupId: 5n,
        objectId: 0n,
        isKeyFrame: true,
        priorObjectIdGap: 0n,
      }).decode,
    );
    assert.isFalse(
      control.videoDecodeOrder.admit({
        groupId: 1n,
        objectId: 0n,
        isKeyFrame: true,
        priorObjectIdGap: 0n,
      }).decode,
    );
    const failure = new Error("decoder failed");

    control.handleVideoDecoderError(failure);

    // 復帰は 1 回だけ試し、戻り値 (false) は見ない
    assert.equal(resetCount, 1);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], failure);
    // 復号順の判定も初期化され、古い Group でも次のキーフレームから復号できる
    assert.isTrue(
      control.videoDecodeOrder.admit({
        groupId: 1n,
        objectId: 0n,
        isKeyFrame: true,
        priorObjectIdGap: 0n,
      }).decode,
    );

    await waitForUnhandledRejectionDetection();

    // false の reset() で通知は増えず、未処理の rejection も残らない
    assert.equal(errors.length, 1);
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 失敗通知 (onError) が throw しても、通知の失敗で復帰 (reset() と復号順の初期化) を
 * 止めない。通知はエラー 1 件につき 1 回であり、通知の失敗を伝える経路が他に無いため
 * 握り潰す。止めるとデコーダーが復帰しないまま以降の Object を復号できなくなる。
 */
test("handleVideoDecoderError: onError が throw しても reset() と復号順の初期化を行う", () => {
  const notificationFailure = new Error("onError failure");
  const notified: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: (error) => {
        notified.push(error);
        throw notificationFailure;
      },
    },
  );
  const control = subscriber as unknown as SubscriberVideoErrorControl;
  let resetCount = 0;
  control.videoDecoder = {
    reset: async () => {
      resetCount++;
      return false;
    },
  };
  // 復号順の判定を進めておく (エラーで初期化されることを観測できる状態にする)
  assert.isTrue(
    control.videoDecodeOrder.admit({
      groupId: 5n,
      objectId: 0n,
      isKeyFrame: true,
      priorObjectIdGap: 0n,
    }).decode,
  );
  assert.isFalse(
    control.videoDecodeOrder.admit({
      groupId: 1n,
      objectId: 0n,
      isKeyFrame: true,
      priorObjectIdGap: 0n,
    }).decode,
  );

  // 通知が throw しても例外は漏れず、復帰と復号順の初期化は続く
  const failure = new Error("decoder failed");
  control.handleVideoDecoderError(failure);

  assert.equal(notified.length, 1);
  assert.strictEqual(notified[0], failure);
  assert.equal(resetCount, 1);
  assert.isTrue(
    control.videoDecodeOrder.admit({
      groupId: 1n,
      objectId: 0n,
      isKeyFrame: true,
      priorObjectIdGap: 0n,
    }).decode,
  );
});

test("handleAudioDecodedData: 音声変換失敗時に onError 通知し AudioData を閉じる", () => {
  // 変換全体の throw でリークせず通知することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.audioContext = {
    createBuffer: () => {
      throw new Error("createBuffer failed");
    },
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closed = false;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 0,
    close: () => {
      closed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(errors.length, 1);
  assert.isTrue(closed);
});

test("handleVideoDecodedData: 出力先不在時はフレームを閉じる", () => {
  // writer 不在の既存正常系が維持されることの検証。
  // 早期 return 経路のため onError 通知はなく、write も呼ばれない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 出力先不在時はフレームを閉じる", () => {
  // context 不在の既存正常系が維持されることの検証。
  // 早期 return 経路のため onError 通知はない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  let audioClosed = false;
  const audioData = {
    close: () => {
      audioClosed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.isTrue(audioClosed);
  assert.equal(errors.length, 0);
});

test("handleVideoDecodedData: 書き込みの同期 throw 時も VideoFrame を閉じる", () => {
  // write 自体の同期 throw では catch 節に届かないため、外側 try/catch で閉じる
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: () => {
      throw new Error("sync write failed");
    },
  } as unknown as { write: (frame: unknown) => Promise<void> };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 音声変換成功時は AudioData を閉じて通知しない", () => {
  // 成功時も finally でちょうど 1 回閉じ、onError しないことの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  // 目標の表示時刻を AudioContext.currentTime の秒へ換算するため、実装は
  // getOutputTimestamp と currentTime を読む (未開始の状態を表す 0/0 と 0 を返す)
  control.audioContext = {
    currentTime: 0,
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    createBuffer: () => ({
      copyToChannel: () => {},
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {},
    }),
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closeCount = 0;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 1,
    copyTo: () => {},
    close: () => {
      closeCount++;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(closeCount, 1);
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 音声再生開始の失敗時も onError 通知し AudioData を閉じる", () => {
  // 変換全体 (createBuffer〜start) の裏付けとして start 失敗経路を検証する
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.audioContext = {
    createBuffer: () => ({
      copyToChannel: () => {},
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {
        throw new Error("start failed");
      },
    }),
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closed = false;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 1,
    copyTo: () => {},
    close: () => {
      closed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(errors.length, 1);
  assert.isTrue(closed);
});

/**
 * Catalog 取得失敗後の hygiene 検証用の制御口
 *
 * subscribeCatalog を短い実時間 timeout で駆動し、失敗後の扱いを検証する。
 */
interface SubscriberCatalogControl {
  session: Session | null;
  // start の開始時に捕捉する世代番号 (解放が先行していないかの検査の基準)
  sessionGeneration: number;
  catalogFetchInProgress: boolean;
  pendingCatalogObjects: MoqtObject[];
  catalogFetchLastLocation: Location | null;
  catalogResolve: ((catalog: Catalog) => void) | null;
  catalogTimer: ReturnType<typeof setTimeout> | null;
  catalogReceiveFailed: boolean;
  subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
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
function createCatalogTestSession(
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
function makeVideoCatalog(): Catalog {
  return makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
}

/**
 * 実時間待機用のヘルパー (タイマー副作用待ち)
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

test("タイムアウト reject 後に遅延オブジェクトが届いても catalog は更新されない", async () => {
  // 失敗後の遅延 catalog が receivedCatalog 更新と onCatalog 発火を起こさないこと。
  // 10 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchObject, calls } = createCatalogTestSession({});
  control.session = session;

  let thrown: unknown = null;
  try {
    await control.subscribeCatalog(control.sessionGeneration, 10);
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /catalog receive timeout/);
  // SUBSCRIBE 後に FETCH の順序で呼ばれていること
  assert.deepEqual(calls, ["subscribe", "fetch"]);
  // フェーズ状態が掃除されていること
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.isTrue(control.catalogReceiveFailed);

  // 遅延オブジェクトが届いても更新・発火しないこと
  const lateObject = { ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) };
  liveObject(lateObject);
  fetchObject(lateObject);
  assert.isNull(subscriber.catalog);
  assert.equal(catalogs.length, 0);
  // FETCH 側の Location 記録も復活しないこと
  assert.isNull(control.catalogFetchLastLocation);
});

test("session.subscribe throw 後に即時掃除されタイマー副作用がない", async () => {
  // throw 直後にフェーズ状態が掃除され、後続のタイマー発火で副作用がないこと
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const subscribeError = new Error("subscribe failed");
  const { session } = createCatalogTestSession({ subscribeError });
  control.session = session;

  let thrown: unknown = null;
  try {
    await control.subscribeCatalog(control.sessionGeneration, 10);
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, subscribeError);
  // 即時掃除されていること
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);

  // タイマー発火待ち後も副作用がないこと。
  // 30 ms は timeout (10 ms) を上回る実時間待機 (fake timers 禁止のため実時間で駆動する)
  await sleep(30);
  assert.isFalse(control.catalogFetchInProgress);
  assert.isFalse(control.catalogReceiveFailed);
  assert.isNull(subscriber.catalog);
});

test("成功時は catalog が解決されタイマーが解除される", async () => {
  // 成功パスで timer が残らないことと、非空 catalog 適用の陽性対照。
  // 遅延注入テストのペイロードが適用可能であることの裏付けにもなる
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  // subscribe / fetch 登録の完了を microtask の flush で待つ (タイマー不使用)
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;

  assert.isNotNull(subscriber.catalog);
  assert.equal(subscriber.catalog?.tracks.length, 1);
  assert.equal(catalogs.length, 1);
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.isFalse(control.catalogReceiveFailed);
});

test("catalogFetchFilter: LARGEST_OBJECT の Group の先頭 Object から要求する", () => {
  // catalog track は Group の先頭 Object が独立した catalog を持つため
  // (draft-ietf-moq-msf-01 §5)、最新 Group の先頭から要求すれば完全な catalog が
  // 得られる。LARGEST_OBJECT の Object ID が 0 以外でも先頭から要求する
  assert.deepEqual(catalogFetchFilter({ group: 7n, object: 3n }), {
    startGroup: 7n,
    startObject: 0n,
  });
});

test("catalogFetchFilter: Group 0 ではフィルタを付けない", () => {
  // 2 フィールドの 0:0 (Location Filter Type 0x02) は絶対位置 {0, 0} の指定であり
  // (draft-ietf-moq-transport-22 §9.20.9)、フィルタ無しの要求範囲 {0, 0} から
  // Largest Object までと一致する。同じ範囲を明示する意味がないため付けない
  assert.isUndefined(catalogFetchFilter({ group: 0n, object: 5n }));
});

test("catalogFetchFilter: LARGEST_OBJECT が不明ならフィルタを付けない", () => {
  // SUBSCRIBE_OK が LARGEST_OBJECT を載せない場合は、従来どおり
  // {0, 0} から Largest Object までを要求する
  assert.isUndefined(catalogFetchFilter(null));
});

test("subscribeCatalog: LARGEST_OBJECT の Group を FETCH の開始位置にする", async () => {
  // 開始位置を最新 Group の先頭にすると、relay の object cache が覆える範囲
  // (cache が持つ最新 Group) と一致する。catalog track の Group ID は Unix epoch
  // ミリ秒から始まることが多く、{0, 0} 起点の要求は cache で覆えない
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, subscribeOptions, fetchOptions } =
    createCatalogTestSession({
      subscribeLargestLocation: { group: 7n, object: 3n },
    });
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  // subscribe / fetch 登録の完了を microtask の flush で待つ (タイマー不使用)
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  assert.deepEqual(fetchOptions()?.filter, { startGroup: 7n, startObject: 0n });
  // live の catalog 購読は Next Object (Location Filter Type 0x05) で開始する。
  // 0:0 の 2 フィールドに戻すと絶対位置 {0, 0} の指定になり、トラック先頭から
  // 全 Object を受信してしまう
  assert.deepEqual(subscribeOptions()?.filter, { nextObject: true });

  // 解決させて timer を残さない
  liveObject({
    ...makeCatalogObject(7n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;
});

test("subscribeCatalog: LARGEST_OBJECT が無ければフィルタ無しで FETCH する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, fetchOptions } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  assert.isUndefined(fetchOptions()?.filter);

  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;
});

/**
 * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
 * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
 * catalog の authInfo (§5.2.42) は catalog を受信するまで分からないため、SETUP Option (0x03)
 * として送ったトークン (MOQT URI の msf fragment の c4m を含む) を catalog の
 * SUBSCRIBE と FETCH にも付与する。
 */
test("subscribeCatalog: SETUP に載せたトークンを SUBSCRIBE と FETCH に付与する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, subscribeOptions, fetchOptions } =
    createCatalogTestSession({});
  const token = useValueToken();
  // 実セッションは initialize() で SETUP のトークンを保持する
  (
    session as unknown as { setupAuthorizationToken: AuthorizationToken | undefined }
  ).setupAuthorizationToken = token;
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  assert.equal(subscribeOptions()?.authorizationToken, token);
  assert.equal(fetchOptions()?.authorizationToken, token);

  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;
});

// SETUP にトークンを送っていない場合は、catalog にもトークンを付与しない
test("subscribeCatalog: SETUP にトークンが無ければ SUBSCRIBE と FETCH に付与しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, subscribeOptions, fetchOptions } =
    createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  assert.isUndefined(subscribeOptions()?.authorizationToken);
  assert.isUndefined(fetchOptions()?.authorizationToken);

  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;
});

/**
 * requestKeyframe の値検証用の制御口
 */
interface SubscriberKeyframeControl {
  currentState: MediaSubscriberState;
  videoSubscriber: Subscriber | null;
  requestKeyframe(): Promise<void>;
}

test("requestKeyframe は最新 Group ID + 1 を送信する", async () => {
  // 固定値でなく largestLocation の live 値を参照することの検証。
  // 送信間に値を書き換えて 2 回送り、snapshot でなく都度参照と分かるようにする
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberKeyframeControl;
  control.currentState = "active";
  const sent: (RequestUpdateOptions | undefined)[] = [];
  const videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    largestLocation: { group: 41n, object: 3n },
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent.push(args[0]);
    },
  };
  control.videoSubscriber = videoSubscriber as unknown as Subscriber;

  await control.requestKeyframe();
  videoSubscriber.largestLocation = { group: 100n, object: 0n };
  await control.requestKeyframe();

  assert.equal(sent[0]?.newGroupRequest, 42n);
  assert.equal(sent[1]?.newGroupRequest, 101n);
});

test("requestKeyframe は情報なし時は 0 を送信する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberKeyframeControl;
  control.currentState = "active";
  let sent: RequestUpdateOptions | undefined;
  control.videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    largestLocation: null,
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent = args[0];
    },
  } as unknown as Subscriber;

  await control.requestKeyframe();

  assert.equal(sent?.newGroupRequest, 0n);
});

/**
 * role なしトラック解決の検証用の制御口
 */
interface SubscriberTrackControl {
  receivedCatalog: Catalog | null;
  audioTrackInfo: CatalogTrack | null;
  videoTrackInfo: CatalogTrack | null;
  extractTrackInfo(): void;
}

function makeRoleLessCatalog(): Catalog {
  return makeCatalog([
    { name: "audio", packaging: "loc", isLive: true },
    { name: "video", packaging: "loc", isLive: true },
  ]);
}

test("extractTrackInfo: role 省略カタログで名前一致のトラックが特定される", () => {
  // role 絞り込みが空でもカタログ全体の名前一致で解決することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    {
      namespace: ["live"],
      audio: { trackName: "audio" },
      video: { trackName: "video" },
    },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: role 省略カタログでデフォルト名のトラックが特定される", () => {
  // trackName 省略時はデフォルト名で探すことの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: 未解決時は onError が呼ばれ他方メディアは継続する", () => {
  // 名前不一致で null のまま残り、throw せず通知することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: { trackName: "missing-audio" }, video: { trackName: "video" } },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.isNull(control.audioTrackInfo);
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /audio track 'missing-audio' not found in catalog/);
});

test("extractTrackInfo: role ありカタログの名前不一致は先頭を採用する", () => {
  // 非空時の先頭採用残置 (後方互換) の明示的な pin
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: { trackName: "missing" } },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeCatalog([
    { name: "audio", packaging: "loc", isLive: true, role: "audio" },
  ]);

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.equal(errors.length, 0);
});

// ============================================================================
// 音声と映像の表示時刻（draft-ietf-moq-msf-01 §5.2.8 / §5.2.11、
// draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2、src/playbackTimeline.ts）
// ============================================================================

/**
 * 音声と映像の同期の検証用の制御口
 *
 * 表示時刻の計算は src/playbackTimeline.ts が持ち、createMediaSubscriber 側は
 * catalog の targetLatency の解決、共有の時間軸への記録、AudioContext の時計との換算を担う。
 * AudioContext / AudioData / VideoFrame はブラウザ専用 API であり node 環境に実物がないため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
interface SubscriberAvSyncControl {
  readonly playbackTimeline: PlaybackTimeline;
  audioTrackInfo: CatalogTrack | null;
  videoTrackInfo: CatalogTrack | null;
  audioContext: AudioContext | null;
  audioDestination: MediaStreamAudioDestinationNode | null;
  // 映像の表示時刻の検証で使う書き込み先 (実装は write だけを呼ぶ)
  videoWriter: WritableStreamDefaultWriter<VideoFrame> | null;
  // Object から復号へ渡す時刻を確かめるため、デコーダも制御口に含める
  audioDecoder: {
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  audioDecoderConfigured: boolean;
  audioTimestampKinds: Map<number, "wallClock" | "mediaTime">;
  videoTimestampKinds: Map<number, "wallClock" | "mediaTime">;
  audioWallClockSeen: boolean;
  videoWallClockSeen: boolean;
  // トラックを解決できているかを検証するため、extractTrackInfo が読む入力も制御口に含める
  receivedCatalog: Catalog | null;
  // 再生の統計を駆動するための制御口 (実装は readonly の 1 インスタンス)
  readonly audioPlayout: AudioPlayoutScheduler;
  extractTrackInfo(): void;
  createOutputStream(): void;
  handleAudioObject(obj: MoqtObject): void;
  handleAudioDecodedData(data: { data: AudioData }): void;
  handleVideoDecodedData(data: { frame: VideoFrame }): void;
}

// テストで使う targetLatency と許容幅
// 目標の表示時刻の計算に再生遅延の下限 (80 ms) ではなく targetLatency を使わせる値
const AV_SYNC_TARGET_LATENCY_MS = 120;
// 上限 (MAX_PLAYOUT_DELAY_MS) を超える targetLatency (切り下げの検証用)
const AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS = MAX_PLAYOUT_DELAY_MS + 100;
// ミリ秒の換算の丸め (Number の倍精度はミリ秒で 0.25 ms 程度) と実時間の進行を吸収する幅
const AV_SYNC_TOLERANCE_MS = 5;
/**
 * 表示時刻の到来を待つ上限 (ミリ秒)
 *
 * 表示時刻は `performance.now()` の軸で決まるため実時間を待つ必要がある。待ち続けて
 * テストが止まらないように上限を置く
 */
const AV_SYNC_WAIT_TIMEOUT_MS = 2_000;
/**
 * 観測の時刻 (`performance.timeOrigin + performance.now()`、ミリ秒) の壁時計の TIMESTAMP
 *
 * この値を持つのと同じ時刻で観測すると基準の遅れ (受信側と送信側の時計のずれ) が 0 になり、
 * 表示時刻が「観測の時刻 + 表示の遅れ」になる。映像の表示時刻の検証で使う。
 *
 * @param observedWallClockMs - 観測に使う時刻 (ミリ秒)
 */
function wallClockTimestampMicrosOf(observedWallClockMs: number): number {
  return Math.round(observedWallClockMs * 1_000);
}

/**
 * 対応の `contextTime` を時刻の基準にした、壁時計の TIMESTAMP (Unix epoch マイクロ秒)
 *
 * この TIMESTAMP を対応と同じ時刻で観測すると、基準の遅れ (受信側と送信側の時計のずれ) が
 * 音声の出力遅延の分だけ負になり、表示時刻が「TIMESTAMP + 表示の遅れ」として読める。
 *
 * @param mapping - `getOutputTimestamp()` が返す対応
 */
function wallClockTimestampMicrosFor(mapping: AudioClockMapping): number {
  return Math.round(mapping.contextTime * 1_000_000);
}

/**
 * 音声の時計の基準にする時刻 (`performance.now()` のミリ秒)
 *
 * `getOutputTimestamp()` の `performanceTime` は `performance.now()` と同じ原点の時刻である
 * (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 * テストはこの 1 点を基準に、対応の値と `AudioContext.currentTime` を組み立てる。
 */
function avSyncReferenceMs(): number {
  return performance.now();
}

/**
 * `getOutputTimestamp()` が返す対応が持つ、音声の出力遅延 (ミリ秒)
 *
 * 実物は数十 ms である (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 * テストではこの値の対応を作り、`AudioContext.currentTime` と組み合わせて目標の表示時刻を
 * AudioContext の秒へ換算させる
 */
const AV_SYNC_AUDIO_DEVICE_DELAY_MS = 100;

/**
 * `getOutputTimestamp()` が返す対応 (基準の時刻から作る)
 *
 * 差 (`contextTime` - `performanceTime` / 1000) は音声の出力遅延であり、数十 ms である。
 *
 * @param referenceMs - 基準の時刻 (`performance.now()` のミリ秒)
 */
function audioClockMappingAt(referenceMs: number): AudioClockMapping {
  return {
    // 差 (contextTime * 1000 - performanceTime) がそのまま音声の出力遅延になる
    contextTime: referenceMs / 1_000 + AV_SYNC_AUDIO_DEVICE_DELAY_MS / 1_000,
    performanceTime: referenceMs,
  };
}

/** 音声の壁時計の TIMESTAMP を観測済みにする (avSync を出せる条件を満たす) */
function markWallClockObserved(control: SubscriberAvSyncControl): void {
  control.audioWallClockSeen = true;
  control.videoWallClockSeen = true;
}

/**
 * catalog を解決して共有の targetLatency を決める
 *
 * extractTrackInfo が音声と映像の track info を解決し、その値から targetLatency を
 * 1 つ決めて時間軸へ渡す経路をそのまま駆動する。
 */
function resolveSharedTargetLatency(
  control: SubscriberAvSyncControl,
  catalog: Catalog,
): MediaReceiverStats {
  control.receivedCatalog = catalog;
  control.extractTrackInfo();
  return (control as unknown as { getStats(): MediaReceiverStats }).getStats();
}

/** targetLatency の検証に使う track の宣言 */
interface TargetLatencyTrackOptions {
  isLive: boolean;
  targetLatency?: number;
  renderGroup?: number;
  altGroup?: number;
}

/** 宣言どおりの CatalogTrack を作る (exactOptionalPropertyTypes のため値がある場合だけ載せる) */
function makeTargetLatencyTrack(name: string, options: TargetLatencyTrackOptions): CatalogTrack {
  return {
    name,
    packaging: "loc",
    isLive: options.isLive,
    ...(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency }),
    ...(options.renderGroup === undefined ? {} : { renderGroup: options.renderGroup }),
    ...(options.altGroup === undefined ? {} : { altGroup: options.altGroup }),
  };
}

/** 音声と映像の track を持つ最小カタログ (role は省略し、名前一致で解決させる) */
function makeAudioVideoCatalog(
  audio: TargetLatencyTrackOptions,
  video: TargetLatencyTrackOptions,
): Catalog {
  return makeCatalog([
    makeTargetLatencyTrack("audio", audio),
    makeTargetLatencyTrack("video", video),
  ]);
}

/**
 * 音声と映像の両方を購読している MediaSubscriber を作る
 *
 * 目標の表示時刻は「音声と映像の両方を購読している」ときだけ使うため、
 * 同期の検証はこの購読で行う。
 */
function createAvSyncSubscriber(): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberAvSyncControl;
  errors: Error[];
} {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  return { subscriber, control: subscriber as unknown as SubscriberAvSyncControl, errors };
}

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 両方のトラックに `targetLatency` があり、同じ `renderGroup` で値も同じなら、
 * その値をそのまま使う。
 */
test("targetLatency: 両方にあって同じ値ならその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(stats.avSync?.targetLatencyLimitedMs, 0);
  // 解決の経路が 1 つの値を使うことの陽性対照 (時間軸へ渡っていることを読む)
  assert.equal(control.playbackTimeline.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(stats.avSync?.skewMs, null);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 同じ `renderGroup` のトラックが異なる `targetLatency` を持つのは MUST 違反であり、
 * `onError` で通知する。使う値は大きい方にする (小さい方の要求より早く出さない)。
 */
test("targetLatency: 同じ renderGroup で異なる値なら onError を通知して大きい方を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: largerMs, renderGroup: 1 },
    ),
  );

  // 違反の通知は 1 回だけ
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /targetLatency differs between tracks in the same render group/);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
  assert.equal(control.playbackTimeline.targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 異なる `renderGroup` のトラックは同じ値でなければならない MUST の対象ではないため、
 * 通知しない。値が 1 つに決まることは同じなので大きい方を使う。
 */
test("targetLatency: renderGroup も altGroup も無いか異なるときは通知しない", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: largerMs, renderGroup: 2 },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 異なる `renderGroup` でも `altGroup` が同じなら同じ値でなければならない MUST の
 * 対象であるため、通知する。
 */
test("targetLatency: altGroup が同じで異なる値なら onError を通知する", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, altGroup: 3 },
    ),
  );

  assert.equal(errors.length, 1);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 片方にしか `targetLatency` が無いときは、もう片方は遅延を選んでよい (MAY) ため、
 * あるほうの値を使って揃える。
 */
test("targetLatency: 片方にだけあるときはその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(control.playbackTimeline.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * `renderGroup` が異なっても `altGroup` が同じなら同じ値でなければならない MUST の
 * 対象であるため、通知する。`renderGroup` が同じで `altGroup` が異なる場合も同じである。
 */
test("targetLatency: 片方の group だけが同じで異なる値なら onError を通知する", () => {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberAvSyncControl;
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;

  // renderGroup が異なり altGroup が同じ (altGroup の MUST に触れる)
  const statsViaAltGroup = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, renderGroup: 2, altGroup: 3 },
    ),
  );
  assert.equal(errors.length, 1);
  assert.equal(statsViaAltGroup.avSync?.targetLatencyMs, largerMs);

  // renderGroup が同じで altGroup が異なる (renderGroup の MUST に触れる)
  const statsViaRenderGroup = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, renderGroup: 1, altGroup: 4 },
    ),
  );
  assert.equal(errors.length, 2);
  assert.equal(statsViaRenderGroup.avSync?.targetLatencyMs, largerMs);
});

/** 上のテストの逆 (音声にだけある場合) も同じ扱いになる */
test("targetLatency: 音声にだけあるときもその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: true },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(control.playbackTimeline.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * `isLive` が false のトラックの `targetLatency` は無視する MUST。片方が false なら
 * 使える値はもう片方だけになり、両方が false なら `targetLatency` を使わない。
 */
test("targetLatency: isLive が false のトラックの値は無視する", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  // 映像だけ isLive が false のため、音声の値が使われる (無視しなければ大きい方を選ぶ)
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: false, targetLatency: largerMs },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

test("targetLatency: 両方 isLive が false なら targetLatency を使わない", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: false, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: false, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync?.targetLatencyMs);
  assert.isNull(control.playbackTimeline.targetLatencyMs);
});

/**
 * 完了条件: 表示の遅れの上限 (`MAX_PLAYOUT_DELAY_MS` とキューが吸収できる長さの小さい方) を
 * 超える `targetLatency` は切り下げ、切り下げた分を統計に出す (同期は保たれる)。
 * 上限は基準の遅れではなく「表示の遅れ - 基準の遅れ」に掛かるため、ここでは学習が無い
 * (フレーム間隔が不明な) 状態の `MAX_PLAYOUT_DELAY_MS` が上限になる。
 */
test("targetLatency: 上限を超える値は切り下げて切り下げた分を統計に出す", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      {
        isLive: true,
        targetLatency: AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS,
        renderGroup: 1,
      },
      {
        isLive: true,
        targetLatency: AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS,
        renderGroup: 1,
      },
    ),
  );

  assert.equal(errors.length, 0);
  // 使っている値は宣言のままで、表示の遅れに掛ける分だけが切り下がる
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS);
  assert.equal(
    stats.avSync?.targetLatencyLimitedMs,
    AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS - MAX_PLAYOUT_DELAY_MS,
  );
});

/**
 * `avSync` を出せない条件を固定する。片方だけの購読では揃える相手がいないため出さず、
 * トラックがカタログで解決できていないときも出さない。
 */
test("avSync: 音声だけの購読では null になる", () => {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberAvSyncControl;
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeCatalog([
      makeTargetLatencyTrack("audio", {
        isLive: true,
        targetLatency: AV_SYNC_TARGET_LATENCY_MS,
      }),
    ]),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync);
});

test("avSync: トラックがカタログで解決できていないときは null になる", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  // 映像のトラックがカタログに無い
  const stats = resolveSharedTargetLatency(
    control,
    makeCatalog([
      makeTargetLatencyTrack("audio", {
        isLive: true,
        targetLatency: AV_SYNC_TARGET_LATENCY_MS,
      }),
    ]),
  );

  // 解決できなかったことは onError で通知される (null は値の型で表す)
  assert.equal(errors.length, 1);
  assert.isNull(control.videoTrackInfo);
  assert.isNull(stats.avSync);
});

/**
 * 壁時計の TIMESTAMP を観測していないトラックがあると、表示時刻を決められない
 * (音声の timestamp がメディア時刻になる) ため `avSync` を出さない。トラックの解決と
 * 片方の観測だけでは出ないことを固定する。
 */
test("avSync: 壁時計の TIMESTAMP を観測していないときは null になる", () => {
  const { control, errors } = createAvSyncSubscriber();
  // 映像だけ観測済みにする
  control.videoWallClockSeen = true;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync);
});

/**
 * 音声の予約のときに測った値
 *
 * 実装は `getOutputTimestamp()` を読んだ時点の `performance.now()` で目標の表示時刻を
 * 求める (src/createMediaSubscriber.ts の handleAudioDecodedData)。テスト側でも
 * `getOutputTimestamp()` の中で同じ時点の値を測るため、実時間の進行に依存しない。
 */
interface AudioReservation {
  /** `getOutputTimestamp()` を読んだ時点の `performance.now()` (ミリ秒) */
  readAtMs: number;
  /** その時点で実装が使う目標の表示時刻 (`performance.now()` のミリ秒) */
  presentationMs: number;
  /** その時点の `AudioContext.currentTime` (秒) */
  currentTimeSeconds: number;
  /** `start(when)` に渡った値 (秒)。目標を過ぎて捨てられた音では空になる */
  startedAtSeconds: number[];
  /** `createBuffer` へ渡った長さ (サンプル数)。隙間の補間を含む */
  bufferFrames: number[];
  /** 音声の出力遅延 (ミリ秒)。`getOutputTimestamp()` の対応から求める */
  deviceDelayMs: number;
}

/**
 * 予約時刻の期待値 (ミリ秒)。目標の表示時刻と音声の出力遅延の和になる
 *
 * @param reservation - 予約のときに測った値
 */
function expectedStartMs(reservation: AudioReservation): number {
  return reservation.presentationMs + reservation.deviceDelayMs;
}

/**
 * 「目標の表示時刻 + 音声の出力遅延」と予約時刻の許容幅 (ミリ秒)
 *
 * 目標の表示時刻は `performance.now()` の軸で決まるため、実装が目標を求めてから
 * `start(when)` を呼ぶまでの実時間の進行 (数ミリ秒から数十ミリ秒) だけ予約時刻が先になる。
 * 目標の表示時刻を測る位置をずらしても変わらない値で確かめるため、この幅を持たせる
 */
const AV_SYNC_START_TOLERANCE_MS = 50;

/**
 * 音声を 1 つ鳴らし、予約のときに測った値と `start(when)` を記録する
 *
 * 音声の出力 (AudioContext / MediaStreamAudioDestinationNode) と track info は
 * ブラウザ専用 API であり node 環境に実物がないため、既存の検証と同じく記録用の
 * 最小オブジェクトを注入する (モジュール置換は行わない)。
 *
 * `currentTime` は予約の間ずっと同じ値を返す (実装は 1 つの音につき 1 回だけ読む)。値は
 * 目標の表示時刻より少し前になるようにする。目標の表示時刻は `performance.now()` の軸で
 * 決まるため、実時間の進行に任せると目標を過ぎて音が捨てられ得るためである。
 *
 * @param control - 駆動する MediaSubscriber
 * @param timestampMicros - AudioData の timestamp
 * @param mapping - この予約のときの `getOutputTimestamp()`。null なら未開始 (0/0)
 * @param currentTimeSeconds - この予約のときの `AudioContext.currentTime` (秒)。
 *   省略時は目標の表示時刻から組み立てる
 */
function playAudioFrame(
  control: SubscriberAvSyncControl,
  timestampMicros: number,
  mapping: AudioClockMapping | null,
  currentTimeSeconds?: number,
): AudioReservation {
  // 音声のトラックが解決できている状態にする (購読が揃っていることの条件)
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  // 未開始の対応は 0/0 を返す (実物と同じ)
  const effectiveMapping: AudioClockMapping = mapping ?? { contextTime: 0, performanceTime: 0 };
  // 「今」は 1 点で測る (測る位置が違うと目標の表示時刻との差がぶれる)
  const nowMs = performance.now();
  const reservation: AudioReservation = {
    readAtMs: nowMs,
    presentationMs: 0,
    // `currentTime` は対応の `contextTime` と同じ座標であり、対応を取った後も進む。
    // 明示されないときは下で対応から組み立てる
    currentTimeSeconds: currentTimeSeconds ?? 0,
    startedAtSeconds: [],
    bufferFrames: [],
    // 対応が無い (未開始) ときは音声の出力遅延も無い
    deviceDelayMs:
      mapping === null
        ? 0
        : effectiveMapping.contextTime * 1_000 - effectiveMapping.performanceTime,
  };
  control.audioContext = {
    get currentTime() {
      return reservation.currentTimeSeconds;
    },
    getOutputTimestamp: () => {
      reservation.presentationMs =
        control.playbackTimeline.presentationPerformanceMs("audio", timestampMicros) ?? 0;
      return effectiveMapping;
    },
    createBuffer: (_channels: number, frames: number) => {
      reservation.bufferFrames.push(frames);
      return { copyToChannel: () => {} };
    },
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: (when: number) => {
        reservation.startedAtSeconds.push(when);
      },
    }),
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  if (currentTimeSeconds === undefined) {
    // 目標の表示時刻があるときは、その少し前 (不感帯の半分) を「今」にする。目標の時刻を
    // 過ぎず、並べすぎの上限にも届かない位置になる。目標が無いとき (目標を使わない音) は
    // 到着基準の並べ方になるため、対応から求めた時刻にその遅れを足す
    const contextTimeSeconds =
      effectiveMapping.contextTime + (nowMs - effectiveMapping.performanceTime) / 1_000;
    const targetSeconds = control.playbackTimeline.presentationPerformanceMs(
      "audio",
      timestampMicros,
    );
    reservation.currentTimeSeconds =
      targetSeconds === null
        ? Math.max(contextTimeSeconds, nowMs / 1_000) + AUDIO_PLAYOUT_DELAY_SECONDS
        : targetSeconds / 1_000 - AUDIO_CLOCK_DEADBAND_MS / 2_000;
  }

  control.handleAudioDecodedData({
    data: {
      numberOfChannels: 1,
      sampleRate: 48_000,
      numberOfFrames: 960,
      timestamp: timestampMicros,
      copyTo: () => {},
      close: () => {},
    } as unknown as AudioData,
  });
  return reservation;
}

// 完了条件: 音が 1 つ抜けたときは、前の音の終わりから次の音の開始までの隙間を
// 直前の音の時間伸長で埋めて予約する (無音のまま残さない)
test("handleAudioDecodedData: 音が抜けた分の隙間を補間して予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  // 目標を使わない (壁時計の TIMESTAMP を持たない) 到着基準の並べ方にする
  const first = playAudioFrame(control, 0, null, 10);
  assert.equal(first.bufferFrames.length, 1, "最初の音だけを予約すること");
  // 40 ms 後の timestamp の音が届く (20 ms の音が 1 つ抜けている)
  const second = playAudioFrame(control, 40_000, null, 10.02);
  // 1 つ目は隙間の補間、2 つ目は届いた音である
  assert.equal(second.bufferFrames.length, 2, "補間と音の 2 つを予約すること");
  assert.equal(second.startedAtSeconds.length, 2);
  // 補間は 20 ms 分 (48 kHz で 960 サンプル) を作る
  assert.equal(second.bufferFrames[0], 960, "補間の長さが隙間と同じであること");
  // 補間は前の音の終わり (10.10) から、届いた音の開始 (10.12) までを埋める
  assert.closeTo(second.startedAtSeconds[0] ?? 0, 10.1, 1e-9);
  assert.closeTo(second.startedAtSeconds[1] ?? 0, 10.12, 1e-9);
  assert.equal(errors.length, 0);
});

// 完了条件: 音声の再生の統計が getStats から読める。時間はミリ秒で返る
test("getStats: 音声の再生の統計を返す", () => {
  const { control } = createAvSyncSubscriber();
  // 最初の音と、40 ms 後の音 (20 ms の音が 1 つ抜けている) を鳴らす
  playAudioFrame(control, 0, null, 10);
  const second = playAudioFrame(control, 40_000, null, 10.02);
  assert.equal(second.startedAtSeconds.length, 2);
  const stats = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.isNotNull(stats);
  // 補間を 1 回 (20 ms) 行い、取り直しも捨てもしていない
  assert.equal(stats?.playoutRebases, 0);
  assert.equal(stats?.playoutDrops, 0);
  assert.equal(stats?.playoutConcealments, 1);
  assert.closeTo(stats?.playoutConcealedMs ?? 0, 20, 1e-6);
  assert.closeTo(stats?.playoutCompressedMs ?? 0, 0, 1e-6);
  // 到着基準の並べ方では遅れ (詰めの対象) を持たない
  assert.equal(stats?.playoutLatenessMs, 0);
});

// 完了条件: 詰めと遅れの統計もミリ秒換算で返る (非 0 の値で固定する)
test("getStats: 詰めと遅れの統計をミリ秒で返す", () => {
  const { control } = createAvSyncSubscriber();
  // 目標ちょうどに届き、今 + 余裕からしか鳴らせない音を作る (遅れ 10 ms を詰める)
  const decision = control.audioPlayout.schedule(10, 0, 0.02, {
    targetStartSeconds: 10,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") {
    return;
  }
  control.audioPlayout.confirmStretch(decision.compressSeconds);
  assert.isAbove(decision.compressSeconds, 0);
  assert.isAbove(control.audioPlayout.lateness, 0);
  const stats = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.closeTo(stats?.playoutCompressedMs ?? 0, decision.compressSeconds * 1_000, 1e-6);
  assert.closeTo(stats?.playoutLatenessMs ?? 0, control.audioPlayout.lateness * 1_000, 1e-6);
  // 基準の取り直しと捨てを 1 回ずつ作り、写像も非 0 で固定する
  const arrival = {
    targetStartSeconds: null,
    enforceTarget: false,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  };
  control.audioPlayout.schedule(100, 0, 0.02, arrival);
  control.audioPlayout.schedule(200, 20_000, 0.02, arrival);
  control.audioPlayout.schedule(300, 0, 0.02, {
    targetStartSeconds: 300.5,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  const updated = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.isAbove(updated?.playoutRebases ?? 0, 0);
  assert.equal(updated?.playoutRebases, control.audioPlayout.rebases);
  assert.isAbove(updated?.playoutDrops ?? 0, 0);
  assert.equal(updated?.playoutDrops, control.audioPlayout.drops);
});

/**
 * 完了条件: 音声の予約時刻は、共有の時間軸が決めた目標の表示時刻
 * (`Timestamp + 基準の遅れ + max(targetLatency, 再生遅延)`) を
 * `getOutputTimestamp` の `{ contextTime, performanceTime }` で `AudioContext.currentTime` の
 * 秒へ換算した値になる。実物と同じく `contextTime` と `performanceTime` を一致させ、
 * 予約のたびに取り直しても対応が変わらない状態で確かめる。
 */
test("handleAudioDecodedData: 対応が無いときは目標の表示時刻を換算できない", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  // getOutputTimestamp が未開始 (0/0) のときは対応が無いため、目標の表示時刻を
  // AudioContext の秒へ換算できない (音声の出力遅延も無い)
  const reservation = playAudioFrame(control, wallClockTimestamp, null);

  assert.equal(reservation.deviceDelayMs, 0);
  assert.isAbove(reservation.presentationMs, 0);
  // 対応が無いので、この音は到着基準 (今 + 再生の遅れ) で予約される
  assert.equal(reservation.startedAtSeconds.length, 1);
  const startedAtMs = (reservation.startedAtSeconds[0] ?? 0) * 1_000;
  const playoutDelayMs = control.playbackTimeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS;
  assert.isAbove(startedAtMs, reservation.currentTimeSeconds * 1_000);
  assert.isAtMost(
    startedAtMs,
    reservation.currentTimeSeconds * 1_000 + playoutDelayMs + AV_SYNC_START_TOLERANCE_MS,
  );
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 音声の予約時刻は、共有の時間軸が決めた目標の表示時刻
 * (`Timestamp + 基準の遅れ + max(targetLatency, 再生遅延)`) を
 * `getOutputTimestamp` の `{ contextTime, performanceTime }` で `AudioContext.currentTime` の
 * 秒へ換算した値になる。
 */
test("handleAudioDecodedData: 目標の表示時刻を getOutputTimestamp で換算して予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  const reservation = playAudioFrame(control, wallClockTimestamp, mapping);

  assert.equal(reservation.startedAtSeconds.length, 1);
  // 予約時刻は「目標の表示時刻 + 音声の出力遅延」を AudioContext の秒にした値になる
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
  // 目標の表示時刻には共有の時間軸の式 (max(targetLatency, 再生遅延)) が効いていること
  assert.equal(control.playbackTimeline.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(control.playbackTimeline.playoutDelayMs, AUDIO_PLAYOUT_DELAY_FLOOR_MS);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: `targetLatency` が上限 (`MAX_PLAYOUT_DELAY_MS` = 500 ms) に近いときも音を捨てない。
 *
 * 並べすぎの上限は「表示に使う遅れ (`max(targetLatency, 再生遅延)`) + 余裕」から決まる。
 * 揺らぎから求めた再生遅延 (80 ms) だけを上限にすると、目標が 300 ms より先にある音を
 * すべて捨てて無音になる。
 */
test("handleAudioDecodedData: targetLatency が 500 ms でも目標の時刻に予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: MAX_PLAYOUT_DELAY_MS },
    { isLive: true, targetLatency: MAX_PLAYOUT_DELAY_MS },
  );
  control.extractTrackInfo();
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  // 「今」を目標の表示時刻の 500 ms 前にする (目標との距離が表示に使う遅れと等しい)
  const targetPerfMs =
    control.playbackTimeline.presentationPerformanceMs("audio", wallClockTimestamp) ?? 0;
  const targetSeconds = (targetPerfMs + AV_SYNC_AUDIO_DEVICE_DELAY_MS) / 1_000;
  const reservation = playAudioFrame(
    control,
    wallClockTimestamp,
    mapping,
    targetSeconds - MAX_PLAYOUT_DELAY_MS / 1_000,
  );

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1, "音を捨てないこと");
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
});

/**
 * 完了条件: `getOutputTimestamp()` の対応が予約のたびに変わっても、差が
 * `AUDIO_CLOCK_DEADBAND_MS` 未満なら前の対応を使い、予約時刻が跳ねない。
 */
test("handleAudioDecodedData: 対応の差が不感帯未満なら前の対応を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const firstMapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(firstMapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  // 1 つ目の予約で時計の対応を作る (復号の出力の種類は 1 つの音につき 1 回だけ引かれる)
  playAudioFrame(control, wallClockTimestamp, firstMapping);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  // 2 つ目の対応は、1 つ目と同じ出力遅延で `AUDIO_CLOCK_DEADBAND_MS` の 3 分の 1 だけ
  // ずらす (実物の読み取りの揺れに相当する)。予約の直前に取り直す
  const jitterMs = AUDIO_CLOCK_DEADBAND_MS / 3;
  const secondReferenceMs = avSyncReferenceMs();
  const jitteredMapping: AudioClockMapping = {
    contextTime: secondReferenceMs / 1_000 + (AV_SYNC_AUDIO_DEVICE_DELAY_MS + jitterMs) / 1_000,
    performanceTime: secondReferenceMs,
  };
  // 1 つ目と同じ装置の遅延であること (差は `AUDIO_CLOCK_DEADBAND_MS` の内側)
  const firstDeviceDelayMs = firstMapping.contextTime * 1_000 - firstMapping.performanceTime;
  const jitteredDeviceDelayMs =
    jitteredMapping.contextTime * 1_000 - jitteredMapping.performanceTime;
  playAudioFrame(control, wallClockTimestamp, jitteredMapping);

  // 差が不感帯の内側であること (取り直しても対応を動かさない条件)
  assert.isBelow(Math.abs(jitteredDeviceDelayMs - firstDeviceDelayMs), AUDIO_CLOCK_DEADBAND_MS);
  // 前の対応のまま (揺れた分は換算に乗らない)
  const bridgeOffsetMs = (
    control as unknown as { audioClockBridge: { currentOffsetMs: number | null } }
  ).audioClockBridge.currentOffsetMs;
  assert.isNotNull(bridgeOffsetMs);
  assert.closeTo(bridgeOffsetMs ?? 0, firstDeviceDelayMs, AV_SYNC_TOLERANCE_MS);
  assert.isBelow(Math.abs((bridgeOffsetMs ?? 0) - jitteredDeviceDelayMs), AUDIO_CLOCK_DEADBAND_MS);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: `getOutputTimestamp()` が未開始 (contextTime と performanceTime が 0) のときは
 * `currentTime` と `performance.now()` の差で代用する。代用は `onError` を通知せず、
 * 統計の `audioClockFallback` に出る。
 */
test("handleAudioDecodedData: getOutputTimestamp が 0/0 でもエラーにせず代用中を統計に出す", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const wallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", wallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", wallClockMs, wallClockTimestamp);
  control.audioTimestampKinds.set(wallClockTimestamp, "wallClock");

  // AudioContext は動いている (currentTime が 0 より大きい) が、getOutputTimestamp は
  // まだ 0/0 を返す状態にする。代用の対応は「currentTime - performance.now()」である
  const fallbackCurrentTimeSeconds = performance.now() / 1_000;
  const reservation = playAudioFrame(control, wallClockTimestamp, null, fallbackCurrentTimeSeconds);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 代用の対応 (currentTime - performance.now()) で換算した目標の時刻に鳴る
  const fallbackOffsetMs = reservation.currentTimeSeconds * 1_000 - reservation.readAtMs;
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    reservation.presentationMs + fallbackOffsetMs,
    AV_SYNC_TOLERANCE_MS,
  );
  // 代用中は統計に出る (購読が揃っていれば読める)
  markWallClockObserved(control);
  assert.isTrue(subscriber.getStats().avSync?.audioClockFallback);
  assert.equal(errors.length, 0);
});

/**
 * draft-ietf-moq-loc-04 §2.3.1.2:
 * TIMESCALE がある TIMESTAMP はメディア時刻であり壁時計ではないため、目標の表示時刻を
 * 使わず到着基準の並べ方にフォールバックする (`start(when)` は今 + 再生の遅れになる)。
 */
test("handleAudioDecodedData: TIMESCALE がある TIMESTAMP は到着基準になる", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  // 復号の出力は decoder に渡した timestamp で届く。Object から駆動して対応を確かめる
  const decodedTimestamps: number[] = [];
  control.audioDecoder = {
    decode: (_payload, _type, timestamp) => {
      decodedTimestamps.push(timestamp);
    },
  };
  control.audioDecoderConfigured = true;
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);

  // TIMESCALE がある TIMESTAMP はメディア時刻 (1 秒 = 1000 の目盛り)
  const timescale = 1_000n;
  const mediaTimestamp = 1_500n;
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: mediaTimestamp, timescale }),
  });

  // decoder にはマイクロ秒へ換算した値が渡る (§2.3.1.2)
  const decodedTimestamp = Number(LOC.toDecoderMicroseconds(mediaTimestamp, timescale));
  assert.deepEqual(decodedTimestamps, [decodedTimestamp]);

  const reservation = playAudioFrame(control, decodedTimestamp, mapping);

  // 目標を使わないため、基準は「最初の音の到着 (今) + 再生の遅れ」になる
  assert.equal(reservation.startedAtSeconds.length, 1);
  // currentTime は固定値であるため、予約時刻は「currentTime + 再生の遅れ」になる
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    reservation.currentTimeSeconds * 1_000 + AUDIO_PLAYOUT_DELAY_SECONDS * 1_000,
    AV_SYNC_TOLERANCE_MS,
  );
  // 壁時計の TIMESTAMP を観測していないため同期の推定は出さない
  assert.isNull(subscriber.getStats().avSync);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 共有の時間軸が音声を観測していない (壁時計の TIMESTAMP を持たない) ときも、
 * 到着基準の再生の遅れは下限 `AUDIO_PLAYOUT_DELAY_FLOOR_MS` を下回らない。
 *
 * 共有の再生遅延は音声を観測したときにだけ下限が入る (src/playbackTimeline.ts)。音声を
 * 観測していないと揺らぎから求めた小さい値になり、そのまま並べると到着の揺らぎを吸収
 * できずに音が途切れる。
 */
test("handleAudioDecodedData: 音声を観測していなくても再生の遅れが下限を下回らない", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.audioDecoderConfigured = true;
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  // 映像だけを観測する (音声の復号の出力は観測しない)。共有の再生遅延には音声の下限が
  // 入らず、揺らぎ 0 の映像の値になる
  control.playbackTimeline.observe(
    "video",
    performance.timeOrigin + performance.now(),
    wallClockTimestampMicrosFor(mapping),
  );
  // 音声を観測していないため、音声の jitter buffer の遅延は決まらない (映像の遅れは音声へ
  // 影響しない。src/playbackTimeline.ts)
  assert.isNull(
    control.playbackTimeline.playoutDelayMs,
    "音声を観測していないため音声の遅れは決まらないこと",
  );

  // 目標の表示時刻を使わない音 (Timescale のある TIMESTAMP) として鳴らす
  const decodedTimestamp = 1_500_000;
  control.audioTimestampKinds.set(decodedTimestamp, "mediaTime");
  const reservation = playAudioFrame(control, decodedTimestamp, mapping, 1_000);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 到着基準の再生の遅れは下限 (80 ms) になる
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    reservation.currentTimeSeconds * 1_000 + AUDIO_PLAYOUT_DELAY_SECONDS * 1_000,
    AV_SYNC_TOLERANCE_MS,
  );
});

/**
 * draft-ietf-moq-loc-04 §2.3.1.1:
 * TIMESCALE が無い TIMESTAMP は Unix epoch マイクロ秒の壁時計であるため、目標の表示時刻を
 * 使う。TIMESCALE の有無で扱いが変わることを上のテストと対にして固定する。
 */
test("handleAudioDecodedData: TIMESCALE が無い TIMESTAMP は目標の表示時刻を使う", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  const decodedTimestamps: number[] = [];
  control.audioDecoder = {
    decode: (_payload, _type, timestamp) => {
      decodedTimestamps.push(timestamp);
    },
  };
  control.audioDecoderConfigured = true;
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // TIMESTAMP は観測の時刻そのものにする (基準の遅れが 0 になり、目標の表示時刻が
  // 「観測の時刻 + 表示の遅れ」になる)
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const observedWallClockMs = performance.timeOrigin + performance.now();
  const wallClockTimestamp = Math.round(observedWallClockMs * 1_000);
  control.playbackTimeline.observe("audio", observedWallClockMs, wallClockTimestamp);
  control.playbackTimeline.observe("video", observedWallClockMs, wallClockTimestamp);

  // TIMESCALE を付けない TIMESTAMP は壁時計として扱われる
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: BigInt(wallClockTimestamp) }),
  });

  const decodedTimestamp = wallClockTimestamp;
  assert.deepEqual(decodedTimestamps, [decodedTimestamp]);

  // 復号の出力の種類は 1 つの音につき 1 回だけ引かれる (予約のたびに登録し直す)
  control.audioTimestampKinds.set(decodedTimestamp, "wallClock");
  const reservation = playAudioFrame(control, decodedTimestamp, mapping);
  // 壁時計の TIMESTAMP を観測済みになる (同期の推定を出せる条件)
  assert.isTrue(control.audioWallClockSeen);

  // 壁時計の TIMESTAMP を使っている (同期の推定を出せる条件が立つ)
  // 壁時計の TIMESTAMP なので、目標の表示時刻を AudioContext の秒へ換算して予約する
  // (到着基準との差は予約時刻が再生の遅れの下限より先かどうかで分かる)
  assert.equal(reservation.startedAtSeconds.length, 1);
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
  // 壁時計の TIMESTAMP を使っているため、時計の代用はしていない
  assert.isNotNull(subscriber.getStats());
  assert.isTrue(control.audioWallClockSeen);
  assert.equal(errors.length, 0);
});

/**
 * 映像の表示時刻の検証用の制御口
 */
/** 映像の表示時刻の検証で使う制御口 (書き込み先は基底の videoWriter を使う) */
type SubscriberVideoTimelineControl = SubscriberAvSyncControl;

/** 記録用の VideoFrame (timestamp を持ち、閉じられたかどうかを記録する) */
function createTimestampedRecordingFrame(timestamp: number): {
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
 * write に渡ったフレームを記録する書き込み先
 *
 * MediaStreamTrackGenerator はブラウザ専用 API であり node 環境に実物がないため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
function createRecordingVideoWriter(): {
  writer: WritableStreamDefaultWriter<VideoFrame>;
  written: VideoFrame[];
} {
  const written: VideoFrame[] = [];
  const writer = {
    write: async (frame: VideoFrame) => {
      written.push(frame);
    },
  } as unknown as WritableStreamDefaultWriter<VideoFrame>;
  return { writer, written };
}

/**
 * 表示周期 (`requestAnimationFrame`) の予約を捕まえておく入れ物
 *
 * 実装は表示時刻を過ぎたフレームをその場で書き、残っていれば表示周期で次を選ぶ。
 * node 環境に表示周期は無いため、予約されたコールバックをテスト側で実行する
 * (フレームの選択と書き込みは実装を通す)。
 */
let pendingAnimationFrame: FrameRequestCallback | null = null;
let animationFrameCount = 0;

/** コールバックを呼ばずに予約だけを捕まえる (表示周期を作り直さない) */
function installAnimationFrameRecorder(): void {
  const globalWithAnimationFrame = globalThis as unknown as {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  };
  // node 環境には表示周期が無いため、テストの間だけ差し替え、後で元に戻す
  restoreAnimationFrame();
  originalAnimationFrame = globalWithAnimationFrame.requestAnimationFrame;
  globalWithAnimationFrame.requestAnimationFrame = (callback) => {
    pendingAnimationFrame = callback;
    animationFrameCount++;
    return 0;
  };
}

/** 差し替えた表示周期を元に戻す (テストの終了時に呼ぶ) */
function restoreAnimationFrame(): void {
  const globalWithAnimationFrame = globalThis as unknown as {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  };
  if (originalAnimationFrame === undefined) {
    delete globalWithAnimationFrame.requestAnimationFrame;
  } else {
    globalWithAnimationFrame.requestAnimationFrame = originalAnimationFrame;
  }
  originalAnimationFrame = undefined;
}

// 差し替える前の表示周期 (元に戻すために持つ)
let originalAnimationFrame: ((callback: FrameRequestCallback) => number) | undefined;

/** 予約された表示周期のコールバックを 1 回実行する */
function runPendingAnimationFrame(): VideoFrame[] {
  const callback = pendingAnimationFrame;
  pendingAnimationFrame = null;
  if (callback === null) {
    return [];
  }
  callback(performance.now());
  return [];
}

/** 表示周期の予約を消す (前のテストの持ち越しを防ぐ) */
function clearPendingAnimationFrame(): void {
  pendingAnimationFrame = null;
  animationFrameCount = 0;
}

/**
 * 復号したフレームを 1 つ積み、表示時刻に応じた選択を駆動する
 *
 * @param control - 駆動する MediaSubscriber
 * @param timestampMicros - 復号したフレームの TIMESTAMP (壁時計、Unix epoch マイクロ秒)
 * @param videoWriter - 書いたフレームを記録する書き込み先
 */
function driveVideoTimeline(
  control: SubscriberAvSyncControl,
  timestampMicros: number,
  videoWriter: WritableStreamDefaultWriter<VideoFrame>,
): void {
  // 映像のトラックが解決できている状態にする (購読が揃っていることの条件)
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  control.videoWriter = videoWriter;
  control.videoTimestampKinds.set(timestampMicros, "wallClock");
  const frame = createTimestampedRecordingFrame(timestampMicros);
  control.handleVideoDecodedData({ frame: frame.frame });
}

/**
 * 実時間を待つ (表示時刻の到来待ち)
 *
 * 表示時刻は `performance.now()` の軸で決まるため、表示時刻を過ぎたフレームが
 * `write` されることを確かめるには実時間を進める必要がある。上限を付けて待ち、
 * 進まなかったことをテストの失敗として返す (停止しない)。
 */
async function waitForDueMs(targetMs: number): Promise<number> {
  let elapsedMs = 0;
  while (elapsedMs < AV_SYNC_WAIT_TIMEOUT_MS) {
    if (performance.now() >= targetMs) {
      return elapsedMs;
    }
    const stepMs = Math.min(5, AV_SYNC_WAIT_TIMEOUT_MS - elapsedMs);
    await new Promise((resolve) => {
      setTimeout(resolve, stepMs);
    });
    elapsedMs += stepMs;
  }
  return elapsedMs;
}

/**
 * 完了条件: 映像の表示時刻は `Timestamp + 表示の遅れ` の式で決まり、表示時刻を過ぎた
 * フレームだけが `videoWriter.write` に渡る。表示時刻が来ていないフレームは書かない。
 *
 * 表示時刻は `performance.now()` の軸で決まるため、書き込みは表示時刻の到来を実時間で
 * 待って確かめる。値そのものは時間軸の式 (表示時刻 - TIMESTAMP = 表示の遅れ) と突き合わせる。
 */
test("handleVideoDecodedData: 表示時刻を過ぎたフレームだけを書く", async () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // 基準の遅れを 0 にして、表示時刻を「観測時刻 + 表示の遅れ」にする
  const observedWallClockMs = performance.timeOrigin + performance.now();
  const timestampMicros = wallClockTimestampMicrosOf(observedWallClockMs);
  control.playbackTimeline.observe("audio", observedWallClockMs, timestampMicros);
  control.playbackTimeline.observe("video", observedWallClockMs, timestampMicros);

  const presentationMs = control.playbackTimeline.presentationPerformanceMs(
    "video",
    timestampMicros,
  );
  const presentationDelayMs = control.playbackTimeline.presentationDelayMs;
  assert.isNotNull(presentationMs);
  assert.isNotNull(presentationDelayMs);
  // 表示の遅れが targetLatency になること (基準の遅れは 0)
  assert.closeTo(presentationDelayMs ?? 0, AV_SYNC_TARGET_LATENCY_MS, AV_SYNC_TOLERANCE_MS);

  const { writer, written } = createRecordingVideoWriter();
  clearPendingAnimationFrame();
  installAnimationFrameRecorder();
  try {
    // 表示時刻がまだ来ていないため、この選択では書かず、表示周期に次の選択を予約する
    driveVideoTimeline(control, timestampMicros, writer);
    assert.equal(written.length, 0);
    assert.equal(animationFrameCount, 1);

    // 表示時刻が来たら、予約された表示周期の選択が書く
    await waitForDueMs(presentationMs ?? 0);
    assert.isAtLeast(performance.now(), presentationMs ?? 0);
    runPendingAnimationFrame();
    assert.equal(written.length, 1);
    assert.equal(written[0]?.timestamp, timestampMicros);
  } finally {
    clearPendingAnimationFrame();
    restoreAnimationFrame();
  }
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 同じ TIMESTAMP の音声と映像が同じ表示時刻から予約されること。音声の
 * `start(when)` は `getOutputTimestamp()` の対応で `AudioContext` の秒へ換算され、映像の
 * 表示時刻は `performance.now()` のミリ秒で決まる。同じ時間軸に同じ TIMESTAMP を
 * 同じ時刻で観測させ、2 つの式が同じ表示の遅れ (TIMESTAMP からの差) を導くことを確かめる。
 *
 * TIMESTAMP は「まだ表示時刻を過ぎていない」値にする。上限で切り下げても表示時刻が
 * 未来に残るため、音声は捨てられず、映像も `write` されずにキューに残る。
 */
test("handleAudioDecodedData と handleVideoDecodedData: 同じ TIMESTAMP は同じ表示の遅れになる", () => {
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {},
  );
  const control = subscriber as unknown as SubscriberVideoTimelineControl;
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
  // 同じ TIMESTAMP を同じ時刻で観測する (基準の遅れと再生遅延が 1 つに決まる)
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const sharedTimestampMicros = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  control.playbackTimeline.observe("audio", observedWallClockMs, sharedTimestampMicros);
  control.playbackTimeline.observe("video", observedWallClockMs, sharedTimestampMicros);
  markWallClockObserved(control);

  // 音声: 目標の表示時刻を AudioContext の秒へ換算する
  control.audioTimestampKinds.set(sharedTimestampMicros, "wallClock");
  const recording = playAudioFrame(control, sharedTimestampMicros, mapping);
  assert.equal(recording.startedAtSeconds.length, 1);
  const audioPresentationMs =
    (recording.startedAtSeconds[0] ?? 0) * 1_000 -
    (mapping.contextTime * 1_000 - mapping.performanceTime);

  // 映像: 同じ TIMESTAMP のフレームの表示時刻を式から求める
  const videoPresentationMs = control.playbackTimeline.presentationPerformanceMs(
    "video",
    sharedTimestampMicros,
  );
  assert.isNotNull(videoPresentationMs);

  // 表示時刻がまだ来ていないフレームは書かない (キューに残る)
  const { writer: videoWriter, written: videoWritten } = createRecordingVideoWriter();
  clearPendingAnimationFrame();
  installAnimationFrameRecorder();
  try {
    driveVideoTimeline(control, sharedTimestampMicros, videoWriter);
    assert.equal(videoWritten.length, 0);
  } finally {
    clearPendingAnimationFrame();
    restoreAnimationFrame();
  }

  // 2 つの式が導く表示の遅れ (TIMESTAMP からの差) が一致する。表示時刻は
  // 「TIMESTAMP + 基準の遅れ + 表示の遅れ」であり、基準の遅れは観測の時刻で決まる
  const audioDelayMs = audioPresentationMs - sharedTimestampMicros / 1_000;
  const videoDelayMs = (videoPresentationMs ?? 0) - sharedTimestampMicros / 1_000;
  assert.closeTo(audioDelayMs, videoDelayMs, AV_SYNC_TOLERANCE_MS);
  // 予約時刻は「目標の表示時刻 + 音声の出力遅延」になっている
  assert.closeTo(
    (recording.startedAtSeconds[0] ?? 0) * 1_000,
    recording.presentationMs + recording.deviceDelayMs,
    AV_SYNC_START_TOLERANCE_MS,
  );
});

// ============================================================================
// stop / close のライフサイクル（解放と再 start）
// ============================================================================

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
interface SubscriberLifecycleControl {
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
  audioDestination: MediaStreamAudioDestinationNode | null;
  audioContext: AudioContext | null;
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
  // 映像の表示を止めるフラグ。解放で初期値 (false) に戻る
  videoPlayoutStopped: boolean;
  // 復号順の判定 (解放で初期化する)
  videoDecodeOrder: VideoDecodeOrder;
  // AudioContext の時計と performance.now() の対応 (解放で消す)
  audioClockBridge: AudioClockBridge;
  audioStats: Pick<AudioReceiverStats, "framesReceived" | "bytesReceived">;
  videoStats: VideoReceiverStats;
  handleSessionClose(generation: number): Promise<void>;
}

/**
 * 接続の完了を制御するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続の完了 (await の解決) をテストが
 * 決められるようにする。接続後の購読 / カタログ / 解放の扱いは実装のまま駆動する。
 */
interface SubscriberConnectControl {
  openSession(settings: MediaConnectSettings): Promise<Session>;
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
function createRecordingSubscriber(onUnsubscribe: () => void): Subscriber {
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
function injectLifecycleResources(
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
  control.audioDestination = {
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
  control.audioContext = {
    close: async () => {
      counts.audioContextCloses++;
      counts.order.push("audioContext.close()");
    },
  } as unknown as AudioContext;
  control.outputStream = {} as MediaStream;
  return counts;
}

/**
 * 解放の順序の期待値
 *
 * 購読を止めてから復号器と出力を閉じ、音声の出力先を止めてから AudioContext を閉じ、
 * 最後に session を閉じる (順序が入れ替わると、閉じた相手へ書き込む窓ができる)。
 */
const LIFECYCLE_DISPOSAL_ORDER = [
  "catalogSubscriber.unsubscribe()",
  "audioSubscriber.unsubscribe()",
  "videoSubscriber.unsubscribe()",
  "audioDecoder.close()",
  "videoDecoder.close()",
  "videoWriter.close()",
  "videoTrackGenerator.stop()",
  "audioDestination.track.stop()",
  "audioContext.close()",
  "session.close()",
];

/**
 * 解放で初期値に戻ることを確認するため、実行時状態に停止前の値を入れる
 *
 * catalog の受信待ち (catalogResolve / catalogReject) と受信タイマーも初期値に戻る対象で
 * あり、値が残っていないことを見るためにここで入れる。受信待ちの打ち切り (await が
 * 解放で終わること) はここでは検証せず、別のテストが担う。
 */
function fillStopRuntimeState(control: SubscriberLifecycleControl): void {
  control.receivedCatalog = makeVideoCatalog();
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true };
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true };
  control.catalogResolve = () => {};
  control.catalogReject = () => {};
  control.catalogFetchInProgress = true;
  control.pendingCatalogObjects = [makeIdentifiedObject(0n, 0x01)];
  control.catalogFetchLastLocation = { group: 1n, object: 0n };
  // 解放で clearTimeout されるタイマー (取り残しを検出できるようにする)
  control.catalogTimer = setTimeout(() => {}, 1000);
  control.catalogReceiveFailed = true;
  control.audioDecoderConfigured = true;
  control.videoDecoderConfigured = true;
  control.lastAppliedVideoConfig = new Uint8Array([1]);
  control.lastAppliedAudioConfig = new Uint8Array([2]);
  // 映像の表示を止めるフラグ (解放で false に戻る)
  control.videoPlayoutStopped = true;
  // 前世代で復号した Object (解放で初期化しないと、再 start で同じ位置の
  // キーフレームを stale として捨ててしまう)
  control.videoDecodeOrder.admit({
    groupId: 5n,
    objectId: 0n,
    isKeyFrame: true,
    priorObjectIdGap: 0n,
  });
  // 前の AudioContext の時計の対応 (解放で消す。影響は AudioClockBridge.reset の
  // JSDoc を参照)。代用 (fallback) の印も一緒に消えることを見るため、対応なしで作る
  control.audioClockBridge.update(null, 12.5, 4_000);
}

/**
 * 完了条件: AudioContext を作り直したら時計の対応を初期化する。createOutputStream は
 * 新しい AudioContext を作るため、前の AudioContext の対応を残さない (残す影響は
 * AudioClockBridge.reset の JSDoc を参照)。
 *
 * AudioContext / MediaStream は node 環境に実物が無いブラウザ専用 API であり、
 * createOutputStream はグローバルから作る。この 2 つだけを差し替えて (モジュール置換は
 * 行わない) 駆動し、同期の createOutputStream の実行中に限定して元に戻す。
 */
test("createOutputStream: AudioContext を作り直すと時計の対応を初期化する", () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    createOutputStream(): void;
  };
  // 音声の track が解決できている状態にする (AudioContext を作る分岐に入る)
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
  };
  // 前の AudioContext の対応を入れておく (作り直しで消えることを見る)
  control.audioClockBridge.update({ contextTime: 500, performanceTime: 400_000 }, 500, 400_000);
  assert.equal(control.audioClockBridge.currentOffsetMs, 100_000);

  // 差し替えた AudioContext が受け取った値 (実装がこの分岐を通った印)
  const createdOptions: AudioContextOptions[] = [];
  const target = globalThis as unknown as { AudioContext: unknown; MediaStream: unknown };
  const originalAudioContext = target.AudioContext;
  const originalMediaStream = target.MediaStream;
  target.AudioContext = class {
    readonly state = "running";
    constructor(options: AudioContextOptions) {
      createdOptions.push(options);
    }
    createMediaStreamDestination(): MediaStreamAudioDestinationNode {
      return {
        stream: { getAudioTracks: () => [] },
      } as unknown as MediaStreamAudioDestinationNode;
    }
  };
  target.MediaStream = class {
    addTrack(): void {}
  };
  try {
    control.createOutputStream();
  } finally {
    target.AudioContext = originalAudioContext;
    target.MediaStream = originalMediaStream;
  }

  // track の sampleRate で AudioContext を作っていること
  assert.equal(createdOptions.length, 1);
  assert.equal(createdOptions[0]?.sampleRate, 48_000);
  // 時計の対応が初期化され、次の予約で取り直すこと
  assert.isNull(control.audioClockBridge.currentOffsetMs);
  assert.isFalse(control.audioClockBridge.usingFallback);
  assert.isNull(control.audioClockBridge.toAudioSeconds(5_000));
});

// 完了条件: 購読をやり直す (AudioContext を作り直す) と、今の遅れは 0 に戻り、
// 詰めの統計は消えない
test("createOutputStream: 再生の基準を消し、統計は残す", () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    createOutputStream(): void;
    getStats(): MediaReceiverStats;
    audioPlayout: AudioPlayoutScheduler;
  };
  // 音声の track が解決できている状態にする (AudioContext を作る分岐に入る)
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
  };
  // 目標を過ぎて届いた音で今の遅れと詰めを作る
  const decision = control.audioPlayout.schedule(10, 0, 0.02, {
    targetStartSeconds: 10,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") {
    return;
  }
  control.audioPlayout.confirmStretch(decision.compressSeconds);
  assert.isAbove(control.audioPlayout.lateness, 0);
  const compressedSeconds = control.audioPlayout.compressed;
  assert.isAbove(compressedSeconds, 0);

  // AudioContext の生成だけを差し替える (モジュール置換は行わない)
  const target = globalThis as unknown as { AudioContext: unknown; MediaStream: unknown };
  const originalAudioContext = target.AudioContext;
  const originalMediaStream = target.MediaStream;
  target.AudioContext = class {
    readonly state = "running";
    createMediaStreamDestination(): MediaStreamAudioDestinationNode {
      return {
        stream: { getAudioTracks: () => [] },
      } as unknown as MediaStreamAudioDestinationNode;
    }
  };
  target.MediaStream = class {
    addTrack(): void {}
  };
  try {
    control.createOutputStream();
  } finally {
    target.AudioContext = originalAudioContext;
    target.MediaStream = originalMediaStream;
  }

  // 基準が消えて今の遅れは 0 になり、統計は残る
  const stats = control.getStats().audio;
  assert.equal(stats?.playoutLatenessMs, 0);
  assert.closeTo(stats?.playoutCompressedMs ?? 0, compressedSeconds * 1_000, 1e-6);
  assert.closeTo(control.audioPlayout.compressed, compressedSeconds, 1e-9);
});

/**
 * resume() が失敗する suspended の AudioContext と MediaStream を差し替える
 *
 * AudioContext / MediaStream は node 環境に実物が無いブラウザ専用 API であり、
 * createOutputStream はグローバルから作る。この 2 つだけを差し替えて (モジュール置換は
 * 行わない) 駆動し、同期の createOutputStream の実行中に限定して元に戻す。
 * 自動再生ポリシーで止まっている (state が "suspended") 状態だけを再現する。
 *
 * @param run - 差し替えた状態で createOutputStream を駆動する本体
 * @returns resume() を呼ばれた回数 (実装がこの分岐を通った印)
 */
function withSuspendedAudioContext(run: () => void): { resumeCount: () => number } {
  let resumeCount = 0;
  const target = globalThis as unknown as { AudioContext: unknown; MediaStream: unknown };
  const originalAudioContext = target.AudioContext;
  const originalMediaStream = target.MediaStream;
  target.AudioContext = class {
    // 自動再生ポリシーで止まっている状態
    readonly state = "suspended";
    resume(): Promise<void> {
      resumeCount++;
      return Promise.reject(new Error("resume failed"));
    }
    createMediaStreamDestination(): MediaStreamAudioDestinationNode {
      return {
        stream: { getAudioTracks: () => [] },
      } as unknown as MediaStreamAudioDestinationNode;
    }
  };
  target.MediaStream = class {
    addTrack(): void {}
  };
  try {
    run();
  } finally {
    target.AudioContext = originalAudioContext;
    target.MediaStream = originalMediaStream;
  }
  return { resumeCount: () => resumeCount };
}

/**
 * 自動再生ポリシー対応の `resume()` が失敗しても未処理の rejection にせず、
 * onError へ 1 回だけ流す。resume() の失敗は他に通知先が無い。
 */
test("createOutputStream: suspended の resume() の失敗は onError に 1 回届く", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], audio: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberLifecycleControl & {
      createOutputStream(): void;
    };
    // 音声の track が解決できている状態にする (AudioContext を作る分岐に入る)
    control.audioTrackInfo = {
      name: "audio",
      packaging: "loc",
      isLive: true,
      codec: "opus",
      samplerate: 48_000,
    };

    const { resumeCount } = withSuspendedAudioContext(() => {
      control.createOutputStream();
    });
    assert.equal(resumeCount(), 1);

    await waitForUnhandledRejectionDetection();

    // 失敗は onError に 1 回だけ届き、未処理の rejection は残らない
    assert.equal(errors.length, 1);
    assert.isTrue((errors[0]?.message ?? "").includes("resume failed"));
    assert.equal(unhandled.length, 0);
  });
});

/**
 * resume() の失敗通知 (onError) が throw しても未処理の rejection にしない。
 * 通知の失敗を伝える経路が他に無いため握り潰す。resume() の返値は `void` で捨てるため、
 * catch ハンドラの失敗を残すと未処理の rejection になる。
 */
test("createOutputStream: resume() の失敗通知が throw しても未処理の rejection にならない", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const notificationFailure = new Error("onError failure");
    const notified: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], audio: {} },
      {
        onError: (error) => {
          notified.push(error);
          throw notificationFailure;
        },
      },
    );
    const control = subscriber as unknown as SubscriberLifecycleControl & {
      createOutputStream(): void;
    };
    // 音声の track が解決できている状態にする (AudioContext を作る分岐に入る)
    control.audioTrackInfo = {
      name: "audio",
      packaging: "loc",
      isLive: true,
      codec: "opus",
      samplerate: 48_000,
    };

    const { resumeCount } = withSuspendedAudioContext(() => {
      control.createOutputStream();
    });
    assert.equal(resumeCount(), 1);

    await waitForUnhandledRejectionDetection();

    // 通知は resume() の失敗の 1 回だけで、通知の失敗が未処理の rejection として残らないこと
    assert.equal(notified.length, 1);
    assert.isTrue((notified[0]?.message ?? "").includes("resume failed"));
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 完了条件: stop は close と同じ解放を行い、解放のあとに参照が残らず、
 * 参照を 1 回ずつ破棄する。state は "stopped" のままで onClose は呼ばない。
 */
test("stop: 全参照を解放し unsubscribe と close を 1 回ずつ呼ぶ", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  // stop は "active" からのみ呼べる
  control.currentState = "active";
  const counts = injectLifecycleResources(control);
  fillStopRuntimeState(control);
  control.audioStats.framesReceived = 7;
  control.videoStats.framesReceived = 9;

  await subscriber.stop();

  // 参照が残らないこと
  assert.isNull(control.session);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.audioSubscriber);
  assert.isNull(control.videoSubscriber);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.videoDecoder);
  assert.isNull(control.videoWriter);
  assert.isNull(control.videoTrackGenerator);
  assert.isNull(control.audioDestination);
  assert.isNull(control.audioContext);
  assert.isNull(control.outputStream);
  // 破棄が 1 回ずつ呼ばれること
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.equal(counts.audioUnsubscribes, 1);
  assert.equal(counts.videoUnsubscribes, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.equal(counts.videoDecoderCloses, 1);
  assert.equal(counts.videoWriterCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.equal(counts.audioTrackStops, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.sessionCloses, 1);
  // 破棄の順序も固定する (購読 → 復号器 → 出力 → AudioContext → session)
  assert.deepEqual(counts.order, LIFECYCLE_DISPOSAL_ORDER);
  // 実行時状態が初期値に戻ること
  assert.isNull(control.receivedCatalog);
  assert.isNull(control.audioTrackInfo);
  assert.isNull(control.videoTrackInfo);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogReject);
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogTimer);
  assert.isFalse(control.catalogReceiveFailed);
  assert.isFalse(control.audioDecoderConfigured);
  assert.isFalse(control.videoDecoderConfigured);
  assert.isNull(control.lastAppliedVideoConfig);
  assert.isNull(control.lastAppliedAudioConfig);
  // 映像の表示を止めるフラグと AudioContext の時計の対応も初期値に戻ること
  // (対応を残す影響は AudioClockBridge.reset の JSDoc を参照)
  assert.isFalse(control.videoPlayoutStopped);
  assert.isNull(control.audioClockBridge.currentOffsetMs);
  assert.isFalse(control.audioClockBridge.usingFallback);
  // 復号順の判定も初期化されること (前世代で復号した Object を引き継ぐと、再 start で
  // 同じ位置のキーフレームを stale として捨てる)
  assert.deepEqual(
    control.videoDecodeOrder.admit({
      groupId: 5n,
      objectId: 0n,
      isKeyFrame: true,
      priorObjectIdGap: 0n,
    }),
    { decode: true },
  );
  // 統計は再 start へ引き継ぐ
  const stats = subscriber.getStats();
  assert.equal(stats.audio?.framesReceived, 7);
  assert.equal(stats.video?.framesReceived, 9);
  // state は "stopped" のままで onClose は呼ばれないこと
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["stopped"]);
  assert.equal(closeCount, 0);
});

/**
 * 完了条件: close は stop と同じ解放を行い、"closed" になったあとの start は拒否される。
 */
test("close: stop と同じ解放を行い以後の start を拒否する", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control);
  fillStopRuntimeState(control);

  await subscriber.close();

  // stop と同じ解放が走ること
  assert.isNull(control.session);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.videoWriter);
  assert.isNull(control.videoTrackGenerator);
  assert.isNull(control.audioDestination);
  assert.isNull(control.audioContext);
  assert.isNull(control.outputStream);
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.equal(counts.audioTrackStops, 1);
  assert.equal(counts.sessionCloses, 1);
  assert.isNull(control.receivedCatalog);
  assert.isNull(control.catalogTimer);
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);

  // 終端後の start は拒否されること
  let thrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "cannot start in state: closed");
  // 拒否では解放も通知も起きない
  assert.equal(counts.sessionCloses, 1);
  assert.equal(closeCount, 1);

  // 二重 close は早期 return で単発のまま終わること
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 解放を catalog の購読解除で止める
 *
 * 解放 (disposeAllResources) は購読の解除から始まり await を挟む。解除の完了をテストが
 * 決められるようにして、close() の同期部分より後で解放の完了より前の窓を作る。この窓は
 * 「解放の途中に届いた Object」と「解放の途中に走った初期 configure の適用」を駆動する
 * ために使う (どちらも解放が decoder の参照を切る前に起きる)。
 *
 * @param control 制御口
 * @returns 解除を完了させて解放を先へ進める関数
 */
function holdDisposalAtCatalogUnsubscribe(control: SubscriberLifecycleControl): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 購読が確立している ("active") 購読だけが解除の対象になる
  control.catalogSubscriber = {
    state: "active",
    unsubscribe: () => held,
  } as unknown as Subscriber;
  return release;
}

/**
 * Track Property だけを持つ購読者を作る (初期 configure の検証用)
 *
 * SubscriberLifecycleControl と SubscriberInitialConfigControl を交差させた制御口では、
 * 購読者の trackProperties が Subscriber の ReadonlyArray と注入用の配列の両方として
 * 要求される。記録用の最小オブジェクトをこの形に整えて渡す (モジュール置換は行わない)。
 * trackProperties は getter にして読み取り回数を数える (閉じた後に初期 configure の適用が
 * Track Property を読まないことを検証できるようにする)。
 *
 * @param trackProperties 購読確立で受け取った Track Property
 * @returns subscriber は購読者、trackPropertyReads は trackProperties を読んだ回数
 */
function createTrackPropertySubscriber(trackProperties: { id: bigint; data?: Uint8Array }[]): {
  subscriber: Subscriber & { trackProperties: { id: bigint; data?: Uint8Array }[] };
  trackPropertyReads: () => number;
} {
  let reads = 0;
  const subscriber = {
    get trackProperties() {
      reads++;
      return trackProperties;
    },
  } as unknown as Subscriber & { trackProperties: { id: bigint; data?: Uint8Array }[] };
  return { subscriber, trackPropertyReads: () => reads };
}

/**
 * 完了条件: 映像の再構成 (VIDEO_CONFIG の変化) の完了前に close() した場合、
 * videoDecoderConfigured が true に戻らず lastAppliedVideoConfig も更新されない。
 *
 * 再構成は configure の await を挟む。解放も購読の解除などで await を挟むため、close() の
 * 同期部分で閉状態になった後に configure が成功し得る。configure の完了をテストが決め、
 * 解放が終わった後に成功させる。閉じた後に configure の結果で状態を戻すと、閉じた購読が
 * 「構成済み」に戻り、以降の Object が統計に数えられて復号へ渡る (復号は捨てられる)。
 */
test("close: 映像の再構成の完了が解放より後でも videoDecoderConfigured と lastAppliedVideoConfig を戻さない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "av01.0.04M.08",
  };
  // configure の完了をテストが決める (解放の完了より後に成功させる)
  let completeConfigure: () => void = () => {};
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: () =>
      new Promise<void>((resolve) => {
        completeConfigure = resolve;
      }),
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  // close() が初期値に戻すことを見るため、適用済みの config を入れておく
  control.lastAppliedVideoConfig = new Uint8Array([1, 1]);

  // 直前と異なる VIDEO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.2.1)
  control.handleVideoObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0x11]),
    properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
  });
  // 再構成中は decode に渡さない
  assert.isFalse(control.videoDecoderConfigured);
  assert.deepEqual(decoded, []);

  // 同じタスクで close する (再構成は configure の await の途中)
  const closing = subscriber.close();
  // 閉状態は解放の await を待たず、close の同期部分で立つ
  assert.isTrue(control.closed);

  // 解放の完了後に configure が成功しても、構成済みと適用済み config は戻らない
  await closing;
  assert.isNull(control.lastAppliedVideoConfig);
  completeConfigure();
  await sleep(0);

  assert.isFalse(control.videoDecoderConfigured);
  assert.isNull(control.lastAppliedVideoConfig);
  assert.deepEqual(decoded, []);
  // 解放で decoder の参照も残らない
  assert.isNull(control.videoDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 音声の再構成 (AUDIO_CONFIG の変化) の完了前に close() した場合、
 * audioDecoderConfigured が true に戻らず lastAppliedAudioConfig も更新されない。
 * 映像と同じ経路を音声でも固定する。
 */
test("close: 音声の再構成の完了が解放より後でも audioDecoderConfigured と lastAppliedAudioConfig を戻さない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  // configure の完了をテストが決める (解放の完了より後に成功させる)
  let completeConfigure: () => void = () => {};
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: () =>
      new Promise<void>((resolve) => {
        completeConfigure = resolve;
      }),
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  // close() が初期値に戻すことを見るため、適用済みの config を入れておく
  control.lastAppliedAudioConfig = new Uint8Array([1, 1]);

  // 直前と異なる AUDIO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.3.1)
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0x22]),
    properties: LOC.encodeAudioProperties({ timestamp: 0n, config: new Uint8Array([8, 8]) }),
  });
  assert.isFalse(control.audioDecoderConfigured);
  assert.deepEqual(decoded, []);

  const closing = subscriber.close();
  assert.isTrue(control.closed);

  await closing;
  assert.isNull(control.lastAppliedAudioConfig);
  completeConfigure();
  await sleep(0);

  assert.isFalse(control.audioDecoderConfigured);
  assert.isNull(control.lastAppliedAudioConfig);
  assert.deepEqual(decoded, []);
  assert.isNull(control.audioDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放の途中で待機中の configure が中止 (reject) しても onError を
 * 通知しない。映像と音声の両方で固定し、閉じていない購読では従来どおり通知することも見る。
 *
 * 実物の復号器は close() で世代を無効化し、待機中の configure を中止する (遅延成功した
 * 旧世代は破棄・reject される)。close() の解放は購読の解除から復号器の破棄まで await を
 * 挟むため、解放の途中で中止が届く。利用者が要求した終了に伴う中止は失敗ではないため
 * 通知しない。注入する復号器の close() が待機中の configure を reject させることで、
 * 実物の世代の無効化による中止を再現する (モジュール置換は行わない)。
 *
 * 中止が実際に起きたこと (aborts) と復号器が破棄されたこと (decoderCloses) を併せて
 * 確かめる。中止が起きなければ onError が 0 回でも通ってしまうためである。
 */
test("close: 解放の途中で configure が中止 (reject) しても onError を通知しない", async () => {
  // 映像: 解放中の復号器の破棄による configure の中止は通知しない
  {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.currentState = "active";
    control.videoTrackInfo = {
      name: "video",
      packaging: "loc",
      isLive: true,
      codec: "vp8",
    };
    // 待機中の configure を中止させる関数 (注入した復号器の close() が呼ぶ)。
    // 実物の復号器は close() で世代を無効化し、待機中の configure を reject する
    let configureCalls = 0;
    let aborts = 0;
    let decoderCloses = 0;
    let abortConfigure: (error: Error) => void = () => {};
    control.videoDecoder = {
      configure: () => {
        configureCalls++;
        return new Promise<void>((_resolve, reject) => {
          abortConfigure = (error) => {
            aborts++;
            reject(error);
          };
        });
      },
      decode: () => {},
      close: () => {
        decoderCloses++;
        abortConfigure(new Error("video decoder configure aborted by close"));
        abortConfigure = () => {};
      },
    };
    control.videoDecoderConfigured = true;
    control.lastAppliedVideoConfig = new Uint8Array([1, 1]);
    // 解放を catalog の購読解除で止め、復号器の破棄 (中止) の時機をテストが決める
    const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

    // 直前と異なる VIDEO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.2.1)
    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x11]),
      properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
    });
    // configure は待機中である (この後に close() して解放の途中で中止させる)
    assert.equal(configureCalls, 1);
    assert.isFalse(control.videoDecoderConfigured);

    const closing = subscriber.close();
    // 閉状態は解放の await を待たず close の同期部分で立つ
    assert.isTrue(control.closed);
    // 解放を進めると復号器が破棄され、待機中の configure が中止される
    releaseDisposal();
    await closing;
    await sleep(0);

    // 中止は起きており (中止が無ければこのテストは何も確かめていない)、復号器も破棄された
    assert.equal(aborts, 1);
    assert.equal(decoderCloses, 1);
    // 購読の終了に伴う中止は失敗として通知しない
    assert.equal(errors.length, 0);
    assert.isFalse(control.videoDecoderConfigured);
    assert.equal(subscriber.state, "closed");
  }

  // 音声: 同じ経路を音声でも固定する
  {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], audio: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.currentState = "active";
    control.audioTrackInfo = {
      name: "audio",
      packaging: "loc",
      isLive: true,
      codec: "opus",
      samplerate: 48_000,
      channelConfig: "2",
    };
    let configureCalls = 0;
    let aborts = 0;
    let decoderCloses = 0;
    let abortConfigure: (error: Error) => void = () => {};
    control.audioDecoder = {
      configure: () => {
        configureCalls++;
        return new Promise<void>((_resolve, reject) => {
          abortConfigure = (error) => {
            aborts++;
            reject(error);
          };
        });
      },
      decode: () => {},
      close: () => {
        decoderCloses++;
        abortConfigure(new Error("audio decoder configure aborted by close"));
        abortConfigure = () => {};
      },
    };
    control.audioDecoderConfigured = true;
    control.lastAppliedAudioConfig = new Uint8Array([1, 1]);
    const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

    // 直前と異なる AUDIO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.3.1)
    control.handleAudioObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x22]),
      properties: LOC.encodeAudioProperties({ timestamp: 0n, config: new Uint8Array([8, 8]) }),
    });
    assert.equal(configureCalls, 1);
    assert.isFalse(control.audioDecoderConfigured);

    const closing = subscriber.close();
    assert.isTrue(control.closed);
    releaseDisposal();
    await closing;
    await sleep(0);

    assert.equal(aborts, 1);
    assert.equal(decoderCloses, 1);
    assert.equal(errors.length, 0);
    assert.isFalse(control.audioDecoderConfigured);
    assert.equal(subscriber.state, "closed");
  }

  // 対照: 閉じていない購読では同じ configure の中止 (失敗) が従来どおり onError へ 1 回届く
  {
    const errors: Error[] = [];
    const subscriber = new MediaSubscriberImpl(
      "moqt://example.com/live",
      { namespace: ["live"], video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.videoTrackInfo = {
      name: "video",
      packaging: "loc",
      isLive: true,
      codec: "vp8",
    };
    let abortConfigure: (error: Error) => void = () => {};
    control.videoDecoder = {
      configure: () =>
        new Promise<void>((_resolve, reject) => {
          abortConfigure = reject;
        }),
      decode: () => {},
      close: () => {},
    };
    control.videoDecoderConfigured = true;
    control.lastAppliedVideoConfig = new Uint8Array([1, 1]);

    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x33]),
      properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
    });
    // 閉じていないため、configure の失敗は onError へ 1 回届く
    abortConfigure(new Error("video decoder configure failed"));
    await sleep(0);

    assert.equal(errors.length, 1);
    assert.isTrue((errors[0]?.message ?? "").includes("video decoder configure failed"));
    assert.isFalse(control.videoDecoderConfigured);
    assert.equal(subscriber.state, "created");
  }
});

/**
 * 完了条件: close() の解放の途中に届いた映像 Object は統計に数えず decode にも渡さない。
 *
 * 解放は購読の解除などで await を挟む。decoder の参照を切る前の窓では復号器の構成済み
 * フラグが true のままのため、閉状態の判定が無ければ先頭ガードを通り、統計を先に進めてから
 * decode を呼ぶ (復号は捨てられる)。映像は Group の保留にも入れない (閉じた購読では
 * 復号されず、保留の期限まで保持されるだけになる)。
 */
test("close: 解放の途中に届いた映像 Object は統計に数えず decode にも渡さない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & { receiveVideoObject(obj: MoqtObject): void };
  control.currentState = "active";
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
  };
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {},
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();
  // 解放の await の中 (decoder の参照を切る前) に届いた Object は捨てる
  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  // 次の Group の Object も Group の保留に入れない
  control.receiveVideoObject(makeStreamVideoObject(2n, 0n));
  // ハンドラを直接駆動した場合 (保留の解放経路) も統計に数えない
  control.handleVideoObject(makeIdentifiedObject(1n, 0x66));

  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.equal(subscriber.getStats().video?.bytesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.isNull(control.videoGroupGate.holdDeadlineMs);

  releaseDisposal();
  await closing;
  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放の途中に届いた音声 Object も統計に数えず decode にも渡さない。
 * 音声は Group の保留が無いため、ハンドラ先頭の閉状態の判定だけで捨てる。
 */
test("close: 解放の途中に届いた音声 Object は統計に数えず decode にも渡さない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async () => {},
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();
  control.handleAudioObject(makeIdentifiedObject(0n, 0x33));

  assert.equal(subscriber.getStats().audio?.framesReceived, 0);
  assert.equal(subscriber.getStats().audio?.bytesReceived, 0);
  assert.deepEqual(decoded, []);

  releaseDisposal();
  await closing;
  assert.equal(subscriber.getStats().audio?.framesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の後に applyInitialVideoConfig が走っても configure を発行しない。
 *
 * 解放は await を挟むため、購読の確立 (session.subscribe) が close() の後に解決すると
 * 初期 configure の適用が閉じた後に走り得る。閉状態の判定が無ければ、decoder の参照が
 * まだ切れていない窓では configure を発行して復号器を作り直してしまう。保留分の解放は
 * 行い、復号はしない (閉じた後に decoder を作らない)。
 */
test("close: 閉じた後に applyInitialVideoConfig が走っても configure を発行しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      reconfigureVideoDecoder(description: Uint8Array): Promise<void>;
    };
  control.currentState = "active";
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
  };
  let configureCount = 0;
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {
      configureCount++;
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();

  // 解放の途中 (decoder の参照がまだ切れていない) に購読確立後の初期 configure が走る
  const trackProperties = [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2, 3]) }];
  const { subscriber: trackSubscriber, trackPropertyReads } =
    createTrackPropertySubscriber(trackProperties);
  control.videoInitialConfigPending = true;
  control.videoSubscriber = trackSubscriber;
  // 保留中に届いた Object は解放で捨てる
  control.handleVideoObject(makeIdentifiedObject(0n, 0x44));
  await control.applyInitialVideoConfig();

  // Track Property を読まず configure も発行せず、保留分だけ解放する
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.videoInitialConfigPending);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.deepEqual(decoded, []);

  // 閉じた後に再構成そのものを呼んでも configure を発行しない (解放の途中で decoder の
  // 参照がまだ切れていないため、閉状態の判定だけが configure を止める)
  await control.reconfigureVideoDecoder(new Uint8Array([7, 7, 7]));
  assert.equal(configureCount, 0);
  assert.isNull(control.lastAppliedVideoConfig);

  releaseDisposal();
  await closing;

  // 解放の完了後に走った場合も Track Property を読まず configure を発行しない
  control.videoInitialConfigPending = true;
  control.videoSubscriber = trackSubscriber;
  await control.applyInitialVideoConfig();
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.videoInitialConfigPending);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の後に applyInitialAudioConfig が走っても configure を発行しない。
 * 映像と同じ経路を音声でも固定する。
 */
test("close: 閉じた後に applyInitialAudioConfig が走っても configure を発行しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      reconfigureAudioDecoder(description: Uint8Array): Promise<void>;
    };
  control.currentState = "active";
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  let configureCount = 0;
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async () => {
      configureCount++;
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();

  // 解放の途中 (decoder の参照がまだ切れていない) に購読確立後の初期 configure が走る
  const trackProperties = [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([4, 5, 6]) }];
  const { subscriber: trackSubscriber, trackPropertyReads } =
    createTrackPropertySubscriber(trackProperties);
  control.audioInitialConfigPending = true;
  control.audioSubscriber = trackSubscriber;
  control.handleAudioObject(makeIdentifiedObject(0n, 0x55));
  await control.applyInitialAudioConfig();

  // Track Property を読まず configure も発行せず、保留分だけ解放する
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.audioInitialConfigPending);
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.deepEqual(decoded, []);

  // 閉じた後に再構成そのものを呼んでも configure を発行しない (解放の途中で decoder の
  // 参照がまだ切れていないため、閉状態の判定だけが configure を止める)
  await control.reconfigureAudioDecoder(new Uint8Array([7, 7, 7]));
  assert.equal(configureCount, 0);
  assert.isNull(control.lastAppliedAudioConfig);

  releaseDisposal();
  await closing;

  // 解放の完了後に走った場合も Track Property を読まず configure を発行しない
  control.audioInitialConfigPending = true;
  control.audioSubscriber = trackSubscriber;
  await control.applyInitialAudioConfig();
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.audioInitialConfigPending);
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放が失敗して終端 ("closed") へ進まなかった場合、閉状態は
 * 復旧の手順 (state が "active" なら stop() を呼んでから start()) の start() の入口で戻る。
 *
 * 解放が失敗したときは state を変えないため、解放の最後の段階 (session の close) で
 * 失敗すると state は "active" のまま残る。この state では start() が cannot start in
 * state で拒否されるため、まず stop() を呼んで "stopped" にしてから再開する。参照は
 * 破棄の前に切り離しているため、stop() の解放は失敗した段階をやり直さず残りの段階だけで
 * 成功する。閉状態を残すと再開した購読がすべての Object と再構成を捨てて復号できなく
 * なるため、start() の入口で戻す。
 */
test("start: close の解放が失敗した後に stop を経て再開したら閉状態を戻す", async () => {
  const failure = new Error("session close failure");
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  control.currentState = "active";
  // 解放の最後の段階 (session の close) で失敗させ、終端へ進めない
  injectLifecycleResources(control, { sessionCloseError: failure });

  let thrown: unknown = null;
  try {
    await subscriber.close();
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, failure);
  // 解放が失敗したため終端へは進んでおらず state は "active" のままである (失敗時は
  // state を変えない) が、閉状態は立っている
  assert.equal(subscriber.state, "active");
  assert.isTrue(control.closed);

  // 復旧の手順: state が "active" のままなので、まず stop() で "stopped" にする。
  // 参照は破棄の前に切り離し済みであり、解放は失敗した段階をやり直さず成功する
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  // stop() は閉状態を戻さない (戻すのは再開の入口である start())
  assert.isTrue(control.closed);

  // 再開の入口で閉状態を戻す (接続は node 環境に WebTransport が無いため失敗させる)
  control.openSession = () => Promise.reject(new Error("connect failed"));
  let startThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    startThrown = error;
  }
  assert.instanceOf(startThrown, Error);
  assert.notMatch((startThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
  assert.isFalse(control.closed);
});

/**
 * 完了条件: stop は "active" 以外では cannot stop in state で throw する
 * ("stopped" での再 stop を含む)。
 */
test("stop: active 以外では cannot stop in state で throw する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  // "active" 以外では解放も起きないこと
  for (const state of ["created", "subscribing", "stopped", "closed"] as const) {
    control.currentState = state;
    let thrown: unknown = null;
    try {
      await subscriber.stop();
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, `cannot stop in state: ${state}`);
  }
  assert.equal(counts.sessionCloses, 0);
  assert.equal(counts.catalogUnsubscribes, 0);

  // "active" からは停止できる
  control.currentState = "active";
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(counts.sessionCloses, 1);

  // "stopped" での再 stop は拒否され、解放をやり直さない
  let repeatThrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    repeatThrown = error;
  }
  assert.instanceOf(repeatThrown, Error);
  assert.equal((repeatThrown as Error).message, "cannot stop in state: stopped");
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: 解放が throw した場合、stop は state を変えず onClose も呼ばず、
 * 元のエラーを throw する。参照は切り離し済みで再試行できる。
 */
test("stop: 解放が失敗したら state と onClose を変えず元のエラーを throw し再試行できる", async () => {
  const failure = new Error("session close failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  // 段階破棄の途中 (session の close) で失敗させる
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  let thrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    thrown = error;
  }

  // 元のエラーがそのまま伝わること
  assert.strictEqual(thrown, failure);
  // state は変わらず onClose も呼ばれないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  // 失敗した段階より後も破棄が続き、参照が残らないこと
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.isNull(control.session);

  // 参照は切り離し済みのため再試行できること
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount, 0);
  // 参照が無いため session の close はやり直さない
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: 解放が成功していれば、終端遷移 ("stopped") で利用者の onStateChange が
 * throw しても stop は失敗しない。
 *
 * setState は state を代入してから onStateChange を呼ぶため、throw しても state は
 * "stopped" になり解放も完了している。通知の失敗を stop の失敗として返すと、解放は
 * 成功しているのに再試行を促す非対称な結果になる。
 */
test("stop: 終端遷移の onStateChange が throw しても stopped になり解放は成功として返る", async () => {
  const stateFailure = new Error("state change failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: () => {
        throw stateFailure;
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control);

  // throw せずに戻ること
  await subscriber.stop();

  // state は代入済みで "stopped" になり、解放も完了していること
  assert.equal(subscriber.state, "stopped");
  assert.equal(counts.sessionCloses, 1);
  assert.isNull(control.session);
  assert.isNull(control.audioContext);
  assert.equal(closeCount, 0);
});

/**
 * 完了条件: 解放は購読が確立している ("active") Subscriber だけを unsubscribe する。
 * stop の時点で MediaSubscriber は "active" であるため通常は確立済みだが、
 * start 失敗時の巻き戻しでは "subscribing" のまま購読が確立している場合がある。
 * その unsubscribe は購読側の状態機械の外にあるため試みず、参照だけ切り離す。
 */
test("stop: 購読が確立していない Subscriber は unsubscribe せず参照だけ切り離す", async () => {
  let unsubscribeCount = 0;
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  // 購読確立前 ("subscribing") の Subscriber を注入する
  control.catalogSubscriber = {
    state: "subscribing",
    unsubscribe: async () => {
      unsubscribeCount++;
    },
  } as unknown as Subscriber;

  await subscriber.stop();

  // unsubscribe は呼ばず、参照は残さないこと
  assert.equal(unsubscribeCount, 0);
  assert.isNull(control.catalogSubscriber);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: 解放の段階失敗は後続を止めず、最後に最初の失敗を throw する。
 * 失敗の注入が最後の段階 (session) だけだと、失敗した段階より後がないため
 * 「後続を止めない」ことを検証できない。最初の段階 (catalog の unsubscribe) で
 * 失敗させ、後続の全段階が走ることを見る。
 */
test("stop: 最初の段階が失敗しても後続の解放を続け最初の失敗を throw する", async () => {
  const failure = new Error("catalog unsubscribe failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control, { catalogUnsubscribeError: failure });

  let thrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    thrown = error;
  }

  // 最初の失敗がそのまま伝わること (後続の失敗ではない)
  assert.strictEqual(thrown, failure);
  // 最初の失敗より後の段階がすべて 1 回走ること
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.equal(counts.audioUnsubscribes, 1);
  assert.equal(counts.videoUnsubscribes, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.equal(counts.videoDecoderCloses, 1);
  assert.equal(counts.videoWriterCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.equal(counts.audioTrackStops, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.sessionCloses, 1);
  // 参照は切り離し済みで、state と onClose は変わらないこと
  assert.isNull(control.session);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.audioContext);
  assert.isNull(control.outputStream);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
});

/**
 * 完了条件: 解放が throw した場合、close は state を変えず onClose も呼ばず、
 * 元のエラーを throw する。参照は切り離し済みで再試行できる。
 */
test("close: 解放が失敗したら state と onClose を変えず元のエラーを throw し再試行できる", async () => {
  const failure = new Error("session close failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  let thrown: unknown = null;
  try {
    await subscriber.close();
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  assert.isNull(control.session);

  // 再試行すると終端まで進むこと
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: "stopped" から start() を呼んでも state ガードで拒否されない。
 * node 環境には WebTransport が無いため接続で失敗し、失敗後は遷移前の
 * "stopped" に戻って再試行できる。
 */
test("start: stopped からは state ガードで拒否されず、失敗後は stopped に戻り再試行できる", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "stopped";
  // 失敗時の巻き戻しで解放が走ることを、確保済みの資源の破棄で確認する
  const counts = injectLifecycleResources(control);

  let thrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    thrown = error;
  }

  assert.instanceOf(thrown, Error);
  // state ガードの拒否ではないこと (接続の失敗)
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 遷移前の "stopped" に戻り、再試行できること
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // 巻き戻しの解放が走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.isNull(control.session);

  // 再試行も state ガードで拒否されないこと
  let retryThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    retryThrown = error;
  }
  assert.instanceOf(retryThrown, Error);
  assert.notMatch((retryThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: start が失敗したときは解放され、state は遷移前の "created" に戻る。
 */
test("start: 失敗したら遷移前の created に戻り再試行できる", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  let thrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    thrown = error;
  }

  assert.instanceOf(thrown, Error);
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 遷移前の "created" に戻ること
  assert.equal(subscriber.state, "created");
  assert.deepEqual(states, ["subscribing", "created"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // 巻き戻しの解放が走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.isNull(control.outputStream);
  assert.isNull(control.receivedCatalog);

  // 再試行も state ガードで拒否されないこと
  let retryThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    retryThrown = error;
  }
  assert.instanceOf(retryThrown, Error);
  assert.notMatch((retryThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "created");
});

/**
 * 完了条件: 失敗時の巻き戻しで利用者の onStateChange が throw しても、元のエラーを
 * throw し onError を通知する。
 *
 * setState は state を代入してから onStateChange を呼ぶため、throw しても state は
 * 遷移前に戻っている。巻き戻しの通知の失敗をそのまま通すと、呼び出し元が受け取るエラーが
 * すり替わり (接続の失敗が消える)、onError の通知にも到達しない。
 */
test("start: 巻き戻しの onStateChange が throw しても元のエラーを throw し onError を通知する", async () => {
  const stateFailure = new Error("state change failure");
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
        // 巻き戻しの遷移 ("created") でだけ throw する (開始の遷移は通す)
        if (state === "created") {
          throw stateFailure;
        }
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  let thrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    thrown = error;
  }

  // 接続の失敗 (元のエラー) がそのまま伝わること (巻き戻しの通知の失敗にすり替わらない)
  assert.instanceOf(thrown, Error);
  assert.notStrictEqual(thrown, stateFailure);
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 元のエラーが onError で通知されること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // state は代入済みで遷移前 ("created") に戻っていること
  assert.equal(subscriber.state, "created");
  assert.deepEqual(states, ["subscribing", "created"]);
  // 巻き戻しの解放も走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.isNull(control.session);
});

/**
 * 完了条件: ピア起点の close が start の実行中 ("subscribing") に届いた場合、
 * "closed" が優先され、start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * start の成功パスは WebTransport と実 WebCodecs を要するため node では駆動できない。
 * 最後の await から戻った時点の処理 (finishStart) を直接駆動し、解放が先行した状態では
 * "active" にせず throw することを固定する。解放 (handleSessionClose) が完了していれば
 * state は "closed" であり、start の catch は state が "closed" のとき巻き戻さない。
 */
test("start: 解放が先行して最後の await から戻ったら active にせず closed を保つ", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    finishStart(startGeneration: number): void;
  };
  // start が "subscribing" になったあとを再現する
  control.currentState = "subscribing";
  const counts = injectLifecycleResources(control);
  // start の開始時に捕捉する世代番号
  const startGeneration = control.sessionGeneration;

  // 最後の await の間にピア起点の close が届き、解放が完了した状態を作る
  await control.handleSessionClose(startGeneration);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);

  // 最後の await から戻った start は "active" にしないこと
  let thrown: unknown = null;
  try {
    control.finishStart(startGeneration);
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放は先行済みで "closed" が保たれること (巻き戻しの余地が無い)
  assert.equal(subscriber.state, "closed");
  assert.equal(counts.sessionCloses, 1);
  assert.deepEqual(states, ["closed"]);

  // 解放が先行していなければ同じ経路で "active" になること
  control.currentState = "subscribing";
  control.finishStart(control.sessionGeneration);
  assert.equal(subscriber.state, "active");
});

/**
 * 完了条件: ピア起点の close が start の実行中に届いた場合、"closed" が優先され、
 * start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * 解放の完了を待たずに start が失敗する場合 (解放が session の close で止まっている間) の
 * 巻き戻しは、終端 ("closed") へ進んでいなければ遷移前の state に戻す。"subscribing" の
 * まま取り残すと start も stop も拒否されて close 以外の出口が無くなるためである。
 * あとから解放を終えたピア起点の経路が "closed" と onClose を決めるため、巻き戻しは
 * 終端の単発性を崩さない。start の接続そのものは node では駆動できないため、接続の失敗で
 * start を終わらせる。start の catch は世代番号で解放の先行を判定するため、start の開始後に
 * 解放を始めて世代番号を進める。
 *
 * 巻き戻しのあとに利用者が再開した start は、解放の時点で世代番号が既に進んでいるため、
 * 解放の有無だけでは終端を跨いだことを判定できない。終端 ("closed") も中止の条件に
 * 入れ、"closed" のあとに "active" へ戻さない (戻すと onClose のあとに受信が続く)。
 */
test("start: 解放が進行中でも失敗時の巻き戻しで遷移前の state に戻り終端は closed になる", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    finishStart(startGeneration: number): void;
  };
  // 停止後 ("stopped") を再現し、start の遷移前の state を "stopped" にする
  control.currentState = "stopped";
  injectLifecycleResources(control);
  // 解放が session の close で止まるようにして、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);
  // この session の close 通知が捕捉する世代番号
  const generation = control.sessionGeneration;

  // start を開始する (同期部分で "subscribing" になり、接続の失敗を待つ)
  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");
  // 接続の失敗が解決する前に、ピア起点の close の解放を開始する (世代番号が進む)
  const closing = control.handleSessionClose(generation);
  await blocked.started;
  // 解放は session の close で止まっており、まだ "closed" になっていないこと
  assert.equal(subscriber.state, "subscribing");
  assert.equal(closeCount, 0);

  // この間に start が失敗したら、巻き戻しで遷移前の "stopped" に戻ること
  // ("subscribing" に固定すると start も stop も拒否されて出口が無くなる)
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);
  assert.equal(closeCount, 0);

  // 巻き戻しのあとに利用者が再開した start を再現する (接続は node では駆動できないため、
  // "subscribing" への遷移と開始時の世代番号の捕捉だけを行う)
  control.currentState = "subscribing";
  const restartedGeneration = control.sessionGeneration;

  // 解放を終わらせるとピア起点の close として "closed" と onClose になること
  // (巻き戻しで戻した state はこの終端遷移で上書きされる)
  blocked.release();
  await closing;
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["subscribing", "stopped", "closed"]);

  // 再開した start の世代番号は解放の時点で既に進んでいるため、解放の検査だけでは終端を
  // 跨いだことを判定できない。終端 ("closed") を検査して "active" へ戻さないこと
  // (start の成功パスは node では駆動できないため、最後の await から戻った時点の処理
  //  (finishStart) を直接駆動する)
  let restartThrown: unknown = null;
  try {
    control.finishStart(restartedGeneration);
  } catch (error) {
    restartThrown = error;
  }
  assert.instanceOf(restartThrown, Error);
  assert.equal(
    (restartThrown as Error).message,
    "start aborted: resources were disposed during start",
  );
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 接続 1 回分の観測口
 */
interface OpenedSubscriberConnection {
  // 実装が onSessionClose に渡した閉包 (接続時点の世代番号を捕捉している)
  notifyClose: () => void;
  // 保留している購読要求 (session.subscribe) が呼ばれた時点で解決する
  subscribing: () => Promise<void>;
  // 保留している購読要求の await を解放する (保留していない場合は何もしない)
  resolveSubscribe: () => void;
  // 保留している session の close が呼ばれた時点で解決する (解放がそこで止まったことの観測)
  sessionClosing: () => Promise<void>;
  // 保留している session の close の await を解放する (保留していない場合は何もしない)
  resolveSessionClose: () => void;
  // この接続の session の close が呼ばれた回数 (解放が session を閉じたか)
  sessionCloseCalls: () => number;
  // 確立した購読の unsubscribe が呼ばれた回数 (start の巻き戻しが解放したか)
  unsubscribeCalls: () => number;
}

/**
 * 接続を差し替えて start() を段階ごとに駆動するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続と購読の完了をテストが決められる
 * ようにする (モジュール置換は行わない)。接続ごとに実装が作る onSessionClose の閉包を
 * そのまま捕捉し、ピア起点の close の解放も駆動できるようにする。カタログの購読は
 * 確立した記録付きの Subscriber を返す。
 *
 * @param callbacks 検証に使うコールバック (onError は呼び出しの記録に使う)
 * @param options holdSubscribe を立てるとカタログの購読 (session.subscribe) の await を
 *   テストが解放するまで保留する (解放が start の await に重なる窓を作る)。
 *   holdSessionClose を立てると session の close の await もテストが解放するまで保留する
 *   (解放が session の close で止まる窓を作る。解放は参照を切り離してから close するため、
 *   止めている間も state は遷移前のままである)。connectFailure を渡すと 2 回目以降の接続を
 *   そのエラーで失敗させる (入口の拒否が外れたときにテストが接続の待ちで止まらないようにする)
 */
function createStartConnectHarness(
  callbacks: MediaSubscriberCallbacks = {},
  options: {
    holdSubscribe?: boolean;
    holdSessionClose?: boolean;
    connectFailure?: Error;
  } = {},
): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberLifecycleControl & SubscriberConnectControl;
  errors: Error[];
  opened: OpenedSubscriberConnection[];
  connectAttempts: () => number;
} {
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      ...callbacks,
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  const opened: OpenedSubscriberConnection[] = [];
  let connectAttempts = 0;
  control.openSession = (settings: MediaConnectSettings) => {
    connectAttempts++;
    // 2 回目以降の接続はテストが決めたエラーで失敗させる (入口の拒否を外したときの観測)
    if (options.connectFailure !== undefined && opened.length > 0) {
      return Promise.reject(options.connectFailure);
    }
    let notifySubscribing: () => void = () => {};
    const subscribing = new Promise<void>((resolve) => {
      notifySubscribing = resolve;
    });
    let releaseSubscribe: () => void = () => {};
    const subscribeGate = options.holdSubscribe
      ? new Promise<void>((resolve) => {
          releaseSubscribe = resolve;
        })
      : null;
    // session の close の保留。解放は session の参照を切り離してから close を await するため、
    // 止めている間も解放は進行中のまま (state は遷移前のまま) になる
    let notifySessionClosing: () => void = () => {};
    const sessionClosing = new Promise<void>((resolve) => {
      notifySessionClosing = resolve;
    });
    let releaseSessionClose: () => void = () => {};
    const sessionCloseGate = options.holdSessionClose
      ? new Promise<void>((resolve) => {
          releaseSessionClose = resolve;
        })
      : null;
    let sessionCloseCalls = 0;
    let unsubscribeCalls = 0;
    const session = {
      subscribe: async (): Promise<Subscriber> => {
        // 保留する購読だけテストが完了を決める
        if (subscribeGate !== null) {
          notifySubscribing();
          await subscribeGate;
        }
        return createRecordingSubscriber(() => {
          unsubscribeCalls++;
        });
      },
      fetch: () => {
        // 解放の検査を通らずに FETCH へ進んだ場合に、黙って進まないよう失敗させる
        throw new Error("must not fetch");
      },
      close: async () => {
        sessionCloseCalls++;
        notifySessionClosing();
        if (sessionCloseGate !== null) {
          await sessionCloseGate;
        }
      },
    } as unknown as Session;
    opened.push({
      notifyClose: () => settings.onSessionClose(),
      subscribing: () => subscribing,
      resolveSubscribe: () => releaseSubscribe(),
      sessionClosing: () => sessionClosing,
      resolveSessionClose: () => releaseSessionClose(),
      sessionCloseCalls: () => sessionCloseCalls,
      unsubscribeCalls: () => unsubscribeCalls,
    });
    return Promise.resolve(session);
  };
  return { subscriber, control, errors, opened, connectAttempts: () => connectAttempts };
}

/**
 * 完了条件: ピア起点の close の解放が進行中のまま利用者が start() を呼び直すと、
 * 入口で cannot start while closing により拒否される。
 *
 * 解放 (disposeAllResources) は世代番号を進める。解放が終端 ("closed") へ進む前に開始を
 * 許すと、開始が捕捉する世代番号は解放が進めた現在値と一致するため段階の検査をすべて通過し、
 * "active" になったあとの解放の終端遷移で state が "closed" になり、開始した購読 / デコーダ /
 * 出力 / session を解放する経路が消える (close() は早期 return、start() / stop() は state で
 * 拒否される)。入口で解放の進行を見て拒否することを固定する。
 *
 * 駆動する順序は次のとおりである。
 * 1. start #1 がカタログの購読 (session.subscribe) の await で止まっている間にピア起点の
 *    close が届き、解放 D1 が session の close で止まる (世代番号は解放の先頭で進む)
 * 2. start #1 は段階の検査で中止し、失敗時の巻き戻し D2 が D1 を待たずに終わって失敗が
 *    確定する (state は開始前の "created" に戻る)
 * 3. 利用者は start #1 の失敗を待ってから直列に start #2 を呼ぶ。state は "created" で
 *    あるため state ガードを通過し、捕捉する世代番号は D1 が進めた現在値と一致する
 * 4. D1 を終わらせると state は "closed" になり onClose が 1 回通知される
 * 5. そのあとに呼び直した start は終端の state により拒否される
 */
test("start: ピア起点の close の解放が進行中のまま呼び直すと入口で拒否される", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const { subscriber, control, errors, opened, connectAttempts } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    // カタログの購読と session の close の両方をテストが解放する (2 つの窓を作る)。
    // 入口の拒否が外れたときに接続の待ちで止まらないよう、2 回目の接続は失敗させる
    { holdSubscribe: true, holdSessionClose: true, connectFailure: new Error("connect failed") },
  );

  await withUnhandledRejectionWatch(async (unhandled) => {
    // 1. start #1 をカタログの購読の await で止める
    const firstStart = subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    await opened[0].subscribing();
    assert.equal(subscriber.state, "subscribing");
    assert.isNotNull(control.session);

    // ピア起点の close の解放 D1 を始め、session の close で止める
    opened[0].notifyClose();
    await opened[0].sessionClosing();
    // D1 は session の参照を切り離してから close を待つ (解放はまだ進行中である)
    assert.isNull(control.session);
    assert.equal(opened[0].sessionCloseCalls(), 1);
    assert.equal(subscriber.state, "subscribing");
    assert.equal(closeCount, 0);

    // 2. start #1 を再開させると段階の検査が中止し、巻き戻し D2 が先に終わって失敗が確定する
    opened[0].resolveSubscribe();
    const firstFailure = await firstStart;
    assert.instanceOf(firstFailure, Error);
    assert.equal(
      (firstFailure as Error).message,
      "start aborted: resources were disposed during start",
    );
    // D2 は切り離し済みの session を触らない (close は D1 の 1 回だけ)
    assert.equal(opened[0].sessionCloseCalls(), 1);
    // D2 は中止までに確立した購読を解除する
    assert.equal(opened[0].unsubscribeCalls(), 1);
    // 解放はまだ終端へ進んでおらず、state のガードは通過できる状態である
    assert.equal(subscriber.state, "created");
    assert.deepEqual(states, ["subscribing", "created"]);
    assert.equal(closeCount, 0);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], firstFailure);

    // 3. 直列に start #2 を呼ぶ。解放 (D1) が進行中であるため、開始の入口で拒否される
    // (解放が終端へ進む前に開始を許すと、開始した資源を解放する経路が残らない)
    const secondFailure = await subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.instanceOf(secondFailure, Error);
    assert.equal((secondFailure as Error).message, "cannot start while closing");
    // 接続も購読も試みないこと (入口で止まる)
    assert.equal(connectAttempts(), 1);
    assert.equal(subscriber.state, "created");
    assert.deepEqual(states, ["subscribing", "created"]);

    // 4. D1 を終わらせると終端 ("closed") と onClose が 1 回だけ通知される
    opened[0].resolveSessionClose();
    await sleep(0);
    assert.equal(subscriber.state, "closed");
    assert.equal(closeCount, 1);
    assert.deepEqual(states, ["subscribing", "created", "closed"]);

    // 5. 解放が終わったあとに呼び直しても、終端 ("closed") を跨ぐため拒否されること
    const thirdFailure = await subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.instanceOf(thirdFailure, Error);
    assert.equal((thirdFailure as Error).message, "cannot start in state: closed");
    assert.equal(connectAttempts(), 1);
    // "active" へ進んでいないこと (onClose のあとに state が動かない)
    assert.equal(subscriber.state, "closed");
    assert.equal(closeCount, 1);
    assert.deepEqual(states, ["subscribing", "created", "closed"]);
    // 入口の拒否は start の catch を通らないため onError は増えない (通知は start #1 の 1 回だけ)
    assert.equal(errors.length, 1);

    // 解放と中止が重なっても未処理の rejection を残さないこと
    await waitForUnhandledRejectionDetection();
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 完了条件: 解放が進行していない正規の start() (stop のあとの再開) は入口で拒否されない。
 *
 * 入口の検査は解放の進行 (disposalInFlight) だけを見る。stop() の解放が終われば解放の
 * Promise は外れるため、"stopped" からの再開は通常どおり開始できなければならない
 * (拒否すると停止した購読を再開する経路が消える)。stop は注入した資源の解放まで実際に
 * 走らせ、接続の境界だけを置き換えて再開が "subscribing" へ進むことを固定する。
 */
test("start: stop の解放が終わったあとの再開は入口の拒否を受けない", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // stop は "active" からのみ呼べる
  control.currentState = "active";
  injectLifecycleResources(control);

  // stop で解放が実際に走り、進行中の解放が残らないこと
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.isNull(control.session);

  // 接続の完了をテストが決める (解決するまで connectToServer は await のまま)
  let connectCalls = 0;
  let completeConnect: (session: Session) => void = () => {};
  control.openSession = () => {
    connectCalls++;
    return new Promise<Session>((resolve) => {
      completeConnect = resolve;
    });
  };

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  // 入口の拒否 (cannot start while closing) を通過して "subscribing" へ進むこと
  assert.equal(subscriber.state, "subscribing");
  assert.equal(connectCalls, 1);

  // 接続待ちの間に close を完了させ、開始は解放の検査で中止させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  const sessionCalls: string[] = [];
  completeConnect({
    subscribe: async () => {
      sessionCalls.push("subscribe");
      throw new Error("must not subscribe");
    },
    close: async () => {
      sessionCalls.push("session.close()");
    },
  } as unknown as Session);

  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  // 解放の検査で中止し、接続で受け取った session はその場で閉じること
  assert.deepEqual(sessionCalls, ["session.close()"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.deepEqual(states, ["stopped", "subscribing", "closed"]);
});

/**
 * 完了条件: ピア起点の close 通知の経路で解放が失敗したとき、その通知 (onError) が throw
 * しても onError を二重に呼ばない。
 *
 * 通知の失敗がこの経路の promise の reject として伝わると、接続側の回収 (connectToServer が
 * 同じ失敗をもう一度 onError へ流す) が 2 回目の通知になる。通知の失敗はこの経路では
 * 握り潰し、解放の失敗の通知を 1 回だけにする。
 */
test("handleSessionClose: 解放の失敗通知が throw しても onError を二重に呼ばない", async () => {
  const failure = new Error("session close failure");
  const notificationFailure = new Error("onError failure");
  let onErrorCalls = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: () => {
        onErrorCalls++;
        throw notificationFailure;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 接続を成功させて session の close 通知のコールバックを捕捉する。購読は解決させず、
  // start を "subscribing" に保って世代番号を進めない (通知を直接駆動できるようにする)
  let notifyClose: () => void = () => {};
  control.openSession = async (settings: MediaConnectSettings) => {
    notifyClose = () => settings.onSessionClose();
    return {
      subscribe: () => new Promise<Subscriber>(() => {}),
      close: async () => {},
    } as unknown as Session;
  };
  // start は購読の確立で止まるため、結果は待たない
  void subscriber.start().catch(() => {});
  await sleep(0);
  assert.isNotNull(control.session);
  assert.equal(subscriber.state, "subscribing");
  // 解放を session の close で失敗させる
  injectLifecycleResources(control, { sessionCloseError: failure });

  // ピア起点の close 通知を駆動する
  notifyClose();
  await sleep(0);

  // 解放の失敗の通知は 1 回だけで、通知の失敗が回収経路をもう一度呼ばないこと
  assert.equal(onErrorCalls, 1);
  assert.equal(subscriber.state, "subscribing");
  assert.isNull(control.session);
});

/**
 * 完了条件: 解放のあとに届いた session close 通知では state と onClose が変わらない。
 * 新しい session を確立したあとに旧 session の通知が届いた場合も無視される。
 * 通知の処理 (handleSessionClose) を世代番号を与えて直接駆動する。
 *
 * 再 start の接続 (connectToServer の世代番号の捕捉) は node では駆動できないため、
 * 新しい session の確立は資源の注入と stop で再現し、世代番号は実装と同じ経路
 * (解放) で進める。
 */
test("handleSessionClose: 解放のあとに届いた通知では state と onClose が変わらない", async () => {
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control);
  // 旧 session が connectToServer で捕捉した世代番号
  const oldGeneration = control.sessionGeneration;

  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 1);

  // 解放のあとに届いた旧 session の通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount, 0);
  // 解放の再実行も起きないこと (参照は既に切り離し済み)
  assert.equal(counts.sessionCloses, 1);

  // 新しい session を確立したあとに旧 session の通知が届く場合も同じこと。
  // 新しい session は接続時に現在の世代番号を捕捉するため、旧 session の捕捉値とは
  // 一致しない。ここでは新しい session の資源を注入して再度 stop し、世代番号を
  // もう 1 つ進める (再 start の接続が捕捉する値が現世代になる)
  control.currentState = "active";
  const nextCounts = injectLifecycleResources(control);
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 2);
  assert.equal(nextCounts.sessionCloses, 1);

  // 旧 session (2 世代前) の遅延通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount, 0);
  assert.equal(nextCounts.sessionCloses, 1);

  // 現世代の通知 (新しい session のピア起点の close) は扱われること
  await control.handleSessionClose(control.sessionGeneration);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: ピア起点の close 通知の経路で解放が throw した場合、state は変わらず
 * エラーがログ (onError) に出て、close() で回収できる。
 */
test("handleSessionClose: 解放が失敗したら state を変えずエラーを通知し close で回収できる", async () => {
  const failure = new Error("session close failure");
  const errors: Error[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  await control.handleSessionClose(control.sessionGeneration);

  // state は変わらず onClose も呼ばないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  // 解放の失敗は onError で通知されること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], failure);
  // 失敗した段階より後も破棄が続き、参照が残らないこと
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.isNull(control.session);

  // close() で回収できること (参照は切り離し済みで再試行できる)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: ピア起点の close 通知 (世代番号が一致する通知) では解放が走ってから
 * "closed" と onClose になり、"closed" のまま解放されない経路が残らない。
 *
 * 解放の全段階が 1 回ずつ走ることは stop のテストが検証する。ここでは順序の検証に
 * 必要な範囲として、onClose が呼ばれた時点で解放対象の参照が切り離し済みであること
 * (解放してから通知していること) に絞る。
 */
test("handleSessionClose: 世代が一致する通知では解放してから closed と onClose になる", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  // onClose の中で見た状態 (解放済みの参照と state) を記録する
  const atClose: string[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
        // onClose の時点の参照をその場で読み直し、解放が先行していることを確かめる
        const inside = subscriber as unknown as SubscriberLifecycleControl;
        atClose.push(
          `state:${inside.currentState}`,
          inside.session === null ? "session:null" : "session:present",
          inside.catalogSubscriber === null
            ? "catalogSubscriber:null"
            : "catalogSubscriber:present",
          inside.audioContext === null ? "audioContext:null" : "audioContext:present",
          inside.audioDestination === null ? "audioDestination:null" : "audioDestination:present",
          inside.outputStream === null ? "outputStream:null" : "outputStream:present",
        );
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  const counts = injectLifecycleResources(control);

  await control.handleSessionClose(control.sessionGeneration);

  // 解放が 1 回走ってから "closed" と onClose になること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);
  // onClose の時点で参照が切り離し済みであること ("closed" を先に立てて解放を
  // 取り残す経路が無い)
  assert.deepEqual(atClose, [
    "state:closed",
    "session:null",
    "catalogSubscriber:null",
    "audioContext:null",
    "audioDestination:null",
    "outputStream:null",
  ]);
});

/**
 * ピア起点の close の解放を session の close で止め、解放が進行中の窓を作る
 *
 * 解放は session を切り離してから close を await するため、止めている間も state は
 * "active" のままである (利用者の stop() / close() が入り込める窓になる)。
 *
 * @param control 駆動する MediaSubscriber
 * @param hooks sessionCloseError を渡すと、止めていた解放を再開したときに session の
 *   close をそのエラーで失敗させる (解放の成否が相乗りした呼び出しへ伝わることの検証に使う)
 * @returns 解放を再開する関数と呼び出し回数、解放の開始を待つ Promise
 */
function startBlockedSessionClose(
  control: SubscriberLifecycleControl,
  hooks: { sessionCloseError?: Error } = {},
): {
  release: () => void;
  closeCalls: () => number;
  started: Promise<void>;
} {
  // 解放を再開させる関数を null 許容の let で持つと型の絞り込みで呼べなくなるため、
  // 呼び出し可能な初期値 (何もしない) を持たせる
  let release: () => void = () => {};
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let closeCalls = 0;
  control.session = {
    close: () => {
      closeCalls++;
      notifyStarted();
      return new Promise<void>((resolve, reject) => {
        release = () => {
          if (hooks.sessionCloseError) {
            reject(hooks.sessionCloseError);
            return;
          }
          resolve();
        };
      });
    },
  } as unknown as Session;
  return { release: () => release(), closeCalls: () => closeCalls, started };
}

/**
 * 完了条件: stop のあと state が "stopped" のままで、ピア起点の close で "closed" に
 * 化けない。ピア起点の close の解放中に利用者の stop() が重なった場合、解放中は state が
 * "active" のままであるため stop() は通り (進行中の解放を共有して完了を待つ)、あとから
 * 解放を終えたピア起点の経路が state と onClose を動かしてはならない。
 */
test("stop: ピア起点の close の解放中に呼ぶと stopped のままで onClose を通知しない", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);
  // この session の close 通知が捕捉する世代番号
  const generation = control.sessionGeneration;

  // ピア起点の close の解放を開始する (解放が止まっている間も state は "active")
  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の窓で利用者が stop() を呼ぶ ("stopped" を決めるのはこちら)。
  // stop() は進行中の解放を共有するため、解放が終わるまで戻らない
  const stopping = subscriber.stop();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  // session の close が stop からやり直されていないこと (参照は切り離し済み)
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると stop が "stopped" にし、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount, 0);
  assert.deepEqual(states, ["stopped"]);
});

/**
 * 完了条件: ピア起点の close の解放中に利用者の close() が重なっても onClose は 1 回だけ
 * 通知される。state を見た判定では、解放中は "active" のままであるため両方の経路が
 * 終端通知に到達してしまう。close() は進行中の解放を共有して完了を待つ。
 */
test("close: ピア起点の close の解放中に呼んでも onClose は 1 回だけ通知される", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);
  const generation = control.sessionGeneration;

  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の窓で利用者が close() を呼ぶ (終端の通知はこちらが行う)。解放が終わるまで
  // 終端へは進まない
  const closingByUser = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると close() が終端まで進み、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([closingByUser, closing]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: 解放を共有する 2 つのピア起点の close 通知が重なっても、終端の遷移と
 * onClose の通知は 1 回だけになる。
 *
 * 1 つ目の通知の解放が session の close で止まっている間に、新しい session の close 通知
 * (再試行した start が確立した session の世代) が届くと、2 つ目の通知は進行中の解放を共有
 * して待つ。解放が終わると両方の通知が終端へ進もうとするため、state を見た終端判定が
 * 無いと "closed" と onClose が 2 回目通知される。
 */
test("handleSessionClose: 解放を共有する 2 つの通知でも終端遷移と onClose は 1 回になる", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  // 1 つ目の通知の解放を session の close で止め、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);

  const first = control.handleSessionClose(control.sessionGeneration);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放が進行中の間に、新しい session の close 通知が届く (解放は共有される)
  control.session = { close: async () => {} } as unknown as Session;
  const second = control.handleSessionClose(control.sessionGeneration);
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);

  // 解放を終わらせると、終端の遷移と onClose は 1 回だけになること
  blocked.release();
  await Promise.all([first, second]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["closed"]);
  assert.equal(blocked.closeCalls(), 1);
});

/**
 * 完了条件: close() を await せずに重ねて呼んでも、解放は 1 回で onClose と
 * onStateChange("closed") は 1 回だけ通知される。
 *
 * 単発性を state だけで判定すると、解放 (disposeAllResources) の await を挟む間に
 * 2 回目の close() が早期 return を通過し、終端遷移と onClose が二重になる。
 * 解放の Promise を共有し、単発性を「呼び出し回数」ではなく「解放の実行回数」に
 * 結び付けていることを、解放を session の close で止めて固定する。
 */
test("close: await せず重ねて呼んでも解放と終端通知は 1 回だけになる", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  // 解放を session の close で止め、2 回目の close() が入り込める窓を作る
  const blocked = startBlockedSessionClose(control);

  // await せずに 2 回呼ぶ (1 回目が解放の await で止まっている間に 2 回目が走る)
  const first = subscriber.close();
  const second = subscriber.close();
  await blocked.started;
  // 解放は 1 回だけ開始され、まだ終端通知は出ていないこと
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(closeCount, 0);

  blocked.release();
  await Promise.all([first, second]);

  // 解放も終端遷移も onClose も 1 回だけであること
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: 終端遷移 (setState) が throw しても onClose を通知する。
 *
 * setState は利用者の onStateChange を呼ぶため throw し得る。state だけ "closed" に
 * 固定されると close() は早期 return するため、通知の回収経路が消える。終端遷移と
 * onClose を対にして、onClose を取り落とさない。
 */
test("handleSessionClose: onStateChange が throw しても onClose を通知する", async () => {
  const failure = new Error("state change failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: () => {
        throw failure;
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);

  let thrown: unknown = null;
  try {
    await control.handleSessionClose(control.sessionGeneration);
  } catch (error) {
    thrown = error;
  }

  // onStateChange の失敗は伝わるが、onClose は通知されること
  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);

  // "closed" のあとの close() は早期 return であり、onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: close でも終端遷移 (setState) が throw したときに onClose を通知する。
 * 通知の回収経路が close() の早期 return しか無いため、この経路でも対にする。
 */
test("close: onStateChange が throw しても onClose を通知する", async () => {
  const failure = new Error("state change failure");
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: () => {
        throw failure;
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);

  let thrown: unknown = null;
  try {
    await subscriber.close();
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);

  // 二重 close は早期 return であり、onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: ピア起点の close が start の実行中 ("subscribing") に届いた場合、
 * "closed" が優先され、start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * start() は接続を要するため node では connect で失敗する。start() が同期部分で
 * "subscribing" に遷移した直後に、connectToServer が捕捉した世代番号で通知を駆動する
 * (解放の完了は start() の失敗を待たない。実際の通知は await の途中で届く)。
 */
test("start: subscribing 中にピア起点の close が届いたら closed を優先する", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  // connectToServer が session を作るときに捕捉する世代番号
  const generation = control.sessionGeneration;

  // node 環境には WebTransport が無いため start は接続で失敗する。
  // 失敗の解決を待たずに通知を駆動するため、先に結果を受け取れるようにしておく
  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  await control.handleSessionClose(generation);

  // ピア起点の close が優先されること
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(
    states.filter((state) => state === "closed"),
    ["closed"],
  );
  // 巻き戻しで "closed" が上書きされないこと
  assert.equal(states[states.length - 1], "closed");

  // start は接続の失敗で終わり、state ガードの拒否ではないこと
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 接続の await 中に close() が先行した場合、接続で受け取った session を
 * その場で閉じて this.session に代入しない。代入すると state は既に "closed" で
 * close() も早期 return するため、閉じる経路が残らない。
 * あわせて、購読 (SUBSCRIBE / FETCH) もカタログ通知 (onCatalog) もリソース作成
 * (出力 MediaStream / AudioContext / デコーダ) も行わない。
 *
 * WebTransport は node に無いため、接続の境界 (openSession) だけを置き換えて完了を
 * 制御する。接続要求を保留したまま close() を完了させ、そのあとで接続を解決させる。
 */
test("start: 接続の await 中に close したら受け取った session を閉じて購読もしない", async () => {
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const catalogs: Catalog[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 接続の完了をテストが決める (解決するまで connectToServer は await のまま)
  let completeConnect: (session: Session) => void = () => {};
  control.openSession = () =>
    new Promise<Session>((resolve) => {
      completeConnect = resolve;
    });

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  // 接続待ちの間に close() を完了させる (解放は session 未代入のまま "closed" へ固定する)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);

  // 接続が解決したら、受け取った session をその場で閉じて採用しないこと
  const sessionCalls: string[] = [];
  completeConnect({
    subscribe: async () => {
      sessionCalls.push("subscribe");
      throw new Error("must not subscribe");
    },
    fetch: async () => {
      sessionCalls.push("fetch");
      throw new Error("must not fetch");
    },
    close: async () => {
      sessionCalls.push("close");
    },
  } as unknown as Session);

  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  // session は代入されず、その場で 1 回だけ閉じられること
  assert.isNull(control.session);
  assert.deepEqual(sessionCalls, ["close"]);
  // 購読もカタログ通知もリソース作成も起きないこと
  assert.equal(catalogs.length, 0);
  assert.isNull(control.outputStream);
  assert.isNull(control.audioContext);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.videoDecoder);
  // 失敗は onError で通知され、state は終端のまま (巻き戻さない) であること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["subscribing", "closed"]);
});

/**
 * 完了条件: カタログの SUBSCRIBE の await 中に解放が先行した場合、FETCH を発行せず
 * カタログの受信待ちもしない。確立した購読は start の失敗時の巻き戻しが解除する。
 *
 * 接続の境界 (openSession) を置き換え、購読要求の解決をテストが決める。
 */
test("start: カタログの購読確立中に close したら FETCH も受信待ちもしない", async () => {
  const errors: Error[] = [];
  const catalogs: Catalog[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  const sessionCalls: string[] = [];
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.openSession = async () =>
    ({
      subscribe: () =>
        new Promise<Subscriber>((resolve) => {
          completeSubscribe = resolve;
        }),
      fetch: async () => {
        sessionCalls.push("fetch");
        throw new Error("must not fetch");
      },
      close: async () => {
        sessionCalls.push("session.close()");
      },
    }) as unknown as Session;

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");
  // カタログの購読要求が出るまで待つ (ここから先は購読の解決をテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  // 購読の確立中に close() を完了させる (session は閉じられ、世代番号が進む)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立したら、解放の検査で中止し FETCH も受信待ちも行わないこと
  let unsubscribes = 0;
  completeSubscribe(
    createRecordingSubscriber(() => {
      unsubscribes++;
    }),
  );
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  assert.deepEqual(sessionCalls, ["session.close()"]);
  // 確立した購読は巻き戻しが解除し、参照も残らないこと
  assert.equal(unsubscribes, 1);
  assert.isNull(control.catalogSubscriber);
  // カタログも受信していないこと
  assert.equal(catalogs.length, 0);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: close は stop と同じ解放を行う。購読の確立中 ("subscribing") の close でも
 * catalog の受信待ちが残らず、start() の await が永久に解決しないことがない。
 */
test("close: subscribing 中の close は catalog の受信待ちを打ち切る", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  const { session } = createCatalogTestSession();
  // 解放で session を閉じるため、最小セッションに close を足す
  (session as unknown as { close: () => Promise<void> }).close = async () => {};
  control.session = session;
  control.currentState = "subscribing";

  // SUBSCRIBE は確立するが catalog は届かない (受信待ちが残る)
  const subscribePromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  assert.isNotNull(control.catalogResolve);
  // 購読の await を解決させ、受信待ちに入れてから close する。解放は購読の await の直後の
  // 検査にも掛かるため、待ちに入る前に解放すると中止の検査で終わってしまう
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  await subscriber.close();

  // 受信待ちが解放で打ち切られ、start 側の await が解決しないままにならないこと
  let thrown: unknown = null;
  try {
    await subscribePromise;
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /catalog receive aborted/);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogReject);
  assert.isNull(control.catalogTimer);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close は stop と同じ解放を行う。解放による catalog の打ち切りは
 * await が付いた待ちだけを対象にするため、session.subscribe の待ちの間に close しても
 * 未処理の rejection にならず、start 側は購読要求の失敗で終わる。
 */
test("close: session.subscribe の待ちの間に close しても購読要求の失敗で終わる", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  let rejectSubscribe: ((error: Error) => void) | null = null;
  control.session = {
    subscribe: () =>
      new Promise((_resolve, reject) => {
        rejectSubscribe = reject;
      }),
    // 実セッションでは close が保留中の購読要求を reject する
    close: async () => {
      rejectSubscribe?.(new Error("session closed"));
    },
  } as unknown as Session;
  control.currentState = "subscribing";

  const subscribePromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読要求の失敗が start 側へ伝わること (catalog の打ち切りは await が付く前の
  // 待ちを対象にしないため、この経路では reject されない)
  let thrown: unknown = null;
  try {
    await subscribePromise;
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /session closed/);
});

/**
 * 完了条件: close は stop と同じ解放を行う。解放中に保留中の FETCH が終了しても、
 * バッファした live オブジェクトのドレインで onCatalog が発火したり catalog 待ちが
 * resolve したりしない。
 *
 * FETCH フェーズ中に届いた full catalog は pendingCatalogObjects にバッファされる。
 * 解放の session close は保留中の FETCH を reject し、その終了処理
 * (finishCatalogFetchPhase) がバッファをドレインするため、解放がフェーズ状態を
 * 先に落としていないと、解放中の onCatalog 発火と catalog 待ちの resolve が起きる。
 */
test("close: 解放中に FETCH が終了してもバッファした live オブジェクトを適用しない", async () => {
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  let rejectFetch: ((error: Error) => void) | null = null;
  // 捕捉したコールバックを null 許容の let で持つと型の絞り込みで呼べなくなるため、
  // 呼び出し可能な初期値 (何もしない) を持たせる
  let liveObject: (obj: MoqtObject) => void = () => {};
  let notifyFetchStarted: () => void = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    notifyFetchStarted = resolve;
  });
  control.session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>) => {
      liveObject = args[2].object;
      // SUBSCRIBE_OK の LARGEST_OBJECT だけを持つ最小の Subscriber
      return { largestLocation: { group: 1n, object: 0n } } as Subscriber;
    },
    fetch: () => {
      // 解放まで終わらない FETCH (実セッションと同じく close で reject される)
      notifyFetchStarted();
      return new Promise<never>((_resolve, reject) => {
        rejectFetch = reject;
      });
    },
    // 実セッションでは close が保留中の FETCH を reject する
    close: async () => {
      rejectFetch?.(new Error("session closed"));
    },
  } as unknown as Session;
  control.currentState = "subscribing";

  const catalogPromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  // FETCH が呼ばれるまで待つ (fetch の登録は subscribe の解決後に行われる)
  await fetchStarted;
  // FETCH フェーズ中に届いた live の full catalog はバッファされる
  liveObject({ ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) });
  assert.equal(control.pendingCatalogObjects.length, 1);

  await subscriber.close();

  // 解放中に FETCH が reject しても、バッファした live オブジェクトを適用しないこと
  assert.equal(catalogs.length, 0);
  assert.isNull(control.catalogResolve);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.equal(subscriber.state, "closed");
  // catalog 待ちは resolve せず、解放による打ち切りで終わること
  let thrown: unknown = null;
  try {
    await catalogPromise;
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /catalog receive aborted/);
});

/**
 * 完了条件: デコーダの configure の await 中に解放が先行した場合、次の段階
 * (映像デコーダ / メディアトラックの購読) へ進まずに中止する。
 *
 * AudioDecoderWrapper は WebCodecs の AudioDecoder を作る。node には無いため、その境界
 * だけを置き換えて configure まで到達させる (useWorker: false にして worker を使わない
 * 直接実行にする)。configure は同期で完了するため、await の解決までの間に close() の
 * 解放 (世代番号を進める) を先行させる。
 */
test("setupDecoders: デコーダの configure の await 中に close したら中止する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
    useWorker: false,
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    setupDecoders(startGeneration: number): Promise<void>;
  };
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  control.currentState = "subscribing";

  // 差し替えた WebCodecs の AudioDecoder (実装が configure まで到達した印も取る)
  const target = globalThis as unknown as { AudioDecoder: unknown };
  const originalAudioDecoder = target.AudioDecoder;
  const configuredCodecs: string[] = [];
  target.AudioDecoder = class {
    readonly state = "configured";
    configure(config: { codec: string }): void {
      configuredCodecs.push(config.codec);
    }
    decode(): void {}
    close(): void {}
  };

  let thrown: unknown = null;
  try {
    const pending = control.setupDecoders(control.sessionGeneration);
    // await の解決の間に解放を先行させる
    await subscriber.close();
    await pending;
  } catch (error) {
    thrown = error;
  } finally {
    target.AudioDecoder = originalAudioDecoder;
  }

  // デコーダは構成されたが、解放が先行したため中止されること
  assert.deepEqual(configuredCodecs, ["opus"]);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放でデコーダは閉じられ、参照も残らないこと
  assert.isNull(control.audioDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: メディアトラックの購読の await 中に解放が先行した場合、初期 configure の適用へ
 * 進まずに中止する。start の失敗時の巻き戻しに相当する解放で、確立した購読が解除される。
 *
 * 購読要求の解決をテストが決め、その間に close() を完了させる。
 */
test("subscribeMediaTracks: 購読の確立中に解放が先行したら初期 configure を適用しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    Pick<SubscriberInitialConfigControl, "audioInitialConfigPending"> & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
      disposeAllResources(): Promise<void>;
    };
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.session = {
    subscribe: () =>
      new Promise<Subscriber>((resolve) => {
        completeSubscribe = resolve;
      }),
    close: async () => {},
  } as unknown as Session;
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  // 購読要求 (session.subscribe) が出るまで待つ (購読の解決はテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // 購読の await 中に解放を先行させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立しても、解放の検査で中止し初期 configure の適用 (購読の Track Property の
  // 読み取り) をしないこと
  let unsubscribes = 0;
  let trackPropertyReads = 0;
  completeSubscribe({
    state: "active",
    get trackProperties() {
      trackPropertyReads++;
      return [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([1, 2]) }];
    },
    unsubscribe: async () => {
      unsubscribes++;
    },
  } as unknown as Subscriber);

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 初期 configure の適用が始まっていないこと
  assert.equal(trackPropertyReads, 0);

  // start の巻き戻しに相当する解放で、確立した購読が解除され参照も残らないこと
  await control.disposeAllResources();
  assert.equal(unsubscribes, 1);
  assert.isNull(control.audioSubscriber);
});

/**
 * 完了条件: start の実行中 ("subscribing") に解放が先行して失敗しても、失敗時の巻き戻しが
 * state を "subscribing" に固定しない。
 *
 * 巻き戻しを「解放が先行したか」だけで止めると、解放が失敗して終端 ("closed") に到達しなかった
 * 場合に "subscribing" が残り、start も stop も拒否されて close 以外の出口が無くなる。
 * 接続の完了をテストが決めて start を "subscribing" に保ち、解放が失敗する close() を
 * 重ねてから接続を失敗させる。
 */
test("start: 開始の途中で解放が失敗しても subscribing に固定されない", async () => {
  const failure = new Error("session close failure");
  const states: MediaSubscriberState[] = [];
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 停止後 ("stopped") を再現し、start の遷移前の state を "stopped" にする
  control.currentState = "stopped";
  // 解放が session の close で失敗するようにする (終端 "closed" へ進めない)
  injectLifecycleResources(control, { sessionCloseError: failure });
  // 接続の完了をテストが決める (解決するまで start は "subscribing" のまま)
  let failConnect: (error: Error) => void = () => {};
  control.openSession = () =>
    new Promise<Session>((_resolve, reject) => {
      failConnect = reject;
    });

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  // 解放が失敗する close() を重ねる
  let closeThrown: unknown = null;
  try {
    await subscriber.close();
  } catch (error) {
    closeThrown = error;
  }
  assert.strictEqual(closeThrown, failure);
  // 解放が失敗したため終端へは進んでいないこと
  assert.equal(subscriber.state, "subscribing");

  // 接続の失敗で start を終わらせると、巻き戻しで遷移前の "stopped" に戻ること
  failConnect(new Error("connect failed"));
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);

  // 再試行が state ガードで拒否されないこと ("subscribing" に固定されていない)
  control.openSession = () => Promise.reject(new Error("connect failed"));
  const retryFailure = await subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.instanceOf(retryFailure, Error);
  assert.notMatch((retryFailure as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: 解放をまたいで stop() と close() が重なっても終端の "closed" が残り、
 * onClose は 1 回だけ通知される。
 *
 * stop() の終端遷移 ("stopped") を無条件に行うと、close() の終端遷移より後に走った場合に
 * state が "closed" から "stopped" へ戻る。close() の早期 return は state だけを見るため、
 * もう一度 close() を呼ぶと onClose が 2 回目通知される。stop の解放を session の close で
 * 止め、close() が進行中の解放の完了を待って終端へ進む順序を固定する。
 */
test("stop: close と重なっても closed のまま onClose は 1 回だけになる", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  // stop の解放を session の close で止め、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);

  // stop を await せずに開始し、解放が止まるまで待つ (state は "active" のまま)
  const stopping = subscriber.stop();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ。close() は進行中の解放を共有して完了を待つため、
  // 解放が終わるまで終端へは進まない
  const closing = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);

  // 止めていた stop の解放を終わらせると close() が終端まで進む
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
  // 解放は 1 回だけで、"stopped" のあとに "closed" が来ること
  assert.equal(blocked.closeCalls(), 1);
  assert.deepEqual(states, ["stopped", "closed"]);

  // "closed" のあとの close() は早期 return であり onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount, 1);

  // 終端後の start() は state ガードで拒否されること
  let thrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "cannot start in state: closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: stop() が始めた解放に close() が相乗りしても、解放の成否が close() に伝わる。
 *
 * 解放は破棄の前に参照を切り離すため、相乗りした呼び出しが自分で解放をやり直すと
 * 「破棄するものが無い成功」に見え、進行中の失敗を検知できない。解放の Promise を共有して
 * いることを、解放を session の close で止めて失敗させることで固定する。
 */
test("close: stop の解放に相乗りしたら解放の失敗が close に伝わる", async () => {
  const failure = new Error("session close failure");
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  // stop の解放を session の close で止め、再開したとき失敗させる
  const blocked = startBlockedSessionClose(control, { sessionCloseError: failure });

  // stop() の解放を開始する (state は "active" のまま止まる)
  const stopping = subscriber.stop().then(
    () => null,
    (error: unknown) => error,
  );
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ (進行中の解放を共有して完了を待つ)
  const closeResult = subscriber.close().then(
    () => null,
    (error: unknown) => error,
  );

  // 解放を失敗させると stop() と close() の両方に失敗が伝わること
  blocked.release();
  const stopFailure = await stopping;
  const closeFailure = await closeResult;
  assert.strictEqual(stopFailure, failure);
  assert.strictEqual(closeFailure, failure);
  // 解放が失敗したため終端へは進まず、onClose も呼ばないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  assert.deepEqual(states, []);
  // 解放は 1 回だけであること (相乗りでやり直さない)
  assert.equal(blocked.closeCalls(), 1);

  // 参照は切り離し済みのため、close() の呼び直しで終端まで進めること
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: stop() が始めた解放に close() が相乗りし、解放が成功した場合は
 * 解放 1 回で "closed" になり onClose は 1 回だけ通知される。
 *
 * close() が相乗りを待たずに自分の解放をやり直すと、参照は切り離し済みのため先に終端へ
 * 進んでしまい、stop() の事後条件と解放の順序が崩れる。
 */
test("close: stop の解放に相乗りして成功したら解放 1 回で closed になる", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);

  const stopping = subscriber.stop();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // close() は進行中の解放を共有するため、止めている間は終端へ進まないこと
  const closing = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);

  // 解放を終わらせると stop の "stopped" のあとに close の "closed" が来ること
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["stopped", "closed"]);
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: ピア起点の close が始めた解放に close() が相乗りしても、解放の成否が
 * close() に伝わる。
 *
 * ピア起点の経路は解放の失敗を onError で通知して戻るため、close() が相乗りしていなければ
 * 利用者は同じ失敗を close() の結果からは受け取れない。
 */
test("close: ピア起点の close の解放に相乗りしたら解放の失敗が close に伝わる", async () => {
  const failure = new Error("session close failure");
  const errors: Error[] = [];
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control, { sessionCloseError: failure });

  // ピア起点の close の解放を開始し、session の close で止める
  const peer = control.handleSessionClose(control.sessionGeneration);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ (進行中の解放を共有して完了を待つ)
  const closeResult = subscriber.close().then(
    () => null,
    (error: unknown) => error,
  );

  // 解放を失敗させるとピア起点の経路は onError で通知し、close() は同じ失敗を throw する
  blocked.release();
  await peer;
  const closeFailure = await closeResult;
  assert.strictEqual(closeFailure, failure);
  assert.deepEqual(errors, [failure]);
  // 解放が失敗したため終端へは進まず、onClose も呼ばないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount, 0);
  assert.equal(blocked.closeCalls(), 1);
});

/**
 * 完了条件: close() の解放中は start() / stop() を呼べない。
 *
 * 解放中は state がまだ "active" などのため、state だけを見た判定では開始や停止が
 * 通過してしまう。解放と終端を待たずに重ねると、開始した start が途中で終端になる。
 * closing (進行中の解放) を見た専用のエラーで fail fast にする。
 */
test("start / stop: close の解放中は while closing で拒否する", async () => {
  let closeCount = 0;
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  // 解放を session の close で止め、解放中の窓を作る
  const blocked = startBlockedSessionClose(control);

  const closing = subscriber.close();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の start() は state ガードではなく closing のガードで拒否されること
  let startThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    startThrown = error;
  }
  assert.instanceOf(startThrown, Error);
  assert.equal((startThrown as Error).message, "cannot start while closing");

  // 解放中の stop() も同様に拒否されること
  let stopThrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    stopThrown = error;
  }
  assert.instanceOf(stopThrown, Error);
  assert.equal((stopThrown as Error).message, "cannot stop while closing");

  // 拒否は解放をやり直さないこと
  assert.equal(blocked.closeCalls(), 1);
  blocked.release();
  await closing;
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 完了条件: デコーダの configure の await 中に解放が先行した場合、次の段階
 * (メディアトラックの購読) へ進まずに中止する。解放のあとに Worker や VideoDecoder を
 * 作らないことを、映像デコーダだけで駆動して固定する (音声側は setupDecoders の
 * 別のテストが担う)。
 *
 * VideoDecoderWrapper は WebCodecs の VideoDecoder を作る。node には無いため、その境界
 * だけを置き換えて configure の対応確認まで到達させる (useWorker: false にして worker を
 * 使わない直接実行にする)。対応確認の解決はテスト側で保留し、その間に close() の解放が
 * Wrapper を閉じるまで進める。解放のあとに作られた Worker や VideoDecoder は誰も破棄しない
 * ため、置き換えた VideoDecoder の生成と close を数えて作られていないことまで固定する。
 */
test("setupDecoders: 映像デコーダの configure の await 中に close したら中止する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "vp8" },
    useWorker: false,
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    setupDecoders(startGeneration: number): Promise<void>;
  };
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
    width: 640,
    height: 480,
  };
  control.currentState = "subscribing";

  // 差し替えた WebCodecs の VideoDecoder (実装が configure まで到達した印も取る)
  const target = globalThis as unknown as { VideoDecoder: unknown };
  const originalVideoDecoder = target.VideoDecoder;
  const configuredCodecs: string[] = [];
  // 実装は configure の直前に対応確認 (isConfigSupported) を通る。そこへ渡る codec も取る
  const probedCodecs: string[] = [];
  // 解放のあとにデコーダーが作られていないことを数える。作られると誰も閉じないため、
  // 解放で参照が切れたことだけでは検出できない
  let createdCodecCount = 0;
  let closedCodecCount = 0;
  // 対応確認の解決をテスト側で制御し、解放がデコーダーを閉じるまで保留させる
  let releaseSupportCheck: () => void = () => {};
  const supportCheckPending = new Promise<void>((resolve) => {
    releaseSupportCheck = resolve;
  });
  target.VideoDecoder = class {
    readonly state = "configured";
    constructor() {
      createdCodecCount += 1;
    }
    // 境界の置き換えとして対応ありを返す (非対応の分岐は実ブラウザの e2e が固定する)
    static async isConfigSupported(config: { codec: string }): Promise<{ supported: boolean }> {
      probedCodecs.push(config.codec);
      // 解放がデコーダーを閉じるまで対応確認を保留する (await の窓をテスト側で作る)
      await supportCheckPending;
      return { supported: true };
    }
    configure(config: { codec: string }): void {
      configuredCodecs.push(config.codec);
    }
    decode(): void {}
    close(): void {
      closedCodecCount += 1;
    }
  };

  let thrown: unknown = null;
  try {
    const pending = control.setupDecoders(control.sessionGeneration);
    // 解放を先行させ、デコーダーを閉じるまで待つ (configure の対応確認は保留のまま)
    await subscriber.close();
    // 保留していた対応確認を解放のあとに解決させる (close() が先行した状態で再開する)
    releaseSupportCheck();
    await pending;
  } catch (error) {
    thrown = error;
  } finally {
    target.VideoDecoder = originalVideoDecoder;
  }

  // 対応確認までは進むが、解放が先行したためデコーダーは作らずに中止されること
  assert.deepEqual(probedCodecs, ["vp8"]);
  assert.equal(createdCodecCount, 0);
  assert.deepEqual(configuredCodecs, []);
  assert.equal(closedCodecCount, 0);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "video decoder configure superseded by newer generation");
  // 解放で参照は切り離され、解放のあとに作られたデコーダーも残らないこと
  assert.isNull(control.videoDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 認可トークンの解決の await 中に解放が先行した場合、購読要求
 * (SUBSCRIBE) を出さずに中止する。映像側を駆動する。
 *
 * 解放は世代番号を進めてから参照を切り離すため、トークンの解決が先に進むと、
 * 検査が無ければ切り離し前の session へ購読要求を出してしまう。
 */
test("subscribeMediaTracks: 映像の認可トークン解決中に解放が先行したら購読要求を出さない", async () => {
  const token = useValueToken();
  let releaseToken: () => void = () => {};
  let notifyTokenStarted: () => void = () => {};
  const tokenStarted = new Promise<void>((resolve) => {
    notifyTokenStarted = resolve;
  });
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "vp8" },
    getAuthorizationToken: () => {
      notifyTokenStarted();
      return new Promise<AuthorizationToken | undefined>((resolve) => {
        releaseToken = () => resolve(token);
      });
    },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  const subscribeCalls: string[] = [];
  control.session = {
    subscribe: async () => {
      subscribeCalls.push("subscribe");
      return {} as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  // authInfo がある track は購読前にトークンの解決を要する (draft-ietf-moq-msf-01 §11.4.3)
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
    authInfo: { "privacy-pass": {} },
  };
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await tokenStarted;
  // トークンの解決中に解放を先行させる。解放は session を切り離す前に await を挟むため、
  // ここで世代番号だけが先に進む
  const closing = subscriber.close();
  releaseToken();

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放が先行したため購読要求を出していないこと
  assert.deepEqual(subscribeCalls, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 認可トークンの解決の await 中に解放が先行した場合、購読要求を出さずに中止する。
 * 音声側は映像側より先に購読するため、音声の検査が無ければ解放後に音声の購読要求が出る。
 */
test("subscribeMediaTracks: 音声の認可トークン解決中に解放が先行したら購読要求を出さない", async () => {
  const token = useValueToken();
  let releaseToken: () => void = () => {};
  let notifyTokenStarted: () => void = () => {};
  const tokenStarted = new Promise<void>((resolve) => {
    notifyTokenStarted = resolve;
  });
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
    getAuthorizationToken: () => {
      notifyTokenStarted();
      return new Promise<AuthorizationToken | undefined>((resolve) => {
        releaseToken = () => resolve(token);
      });
    },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    Pick<SubscriberInitialConfigControl, "audioInitialConfigPending"> & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  const subscribeCalls: string[] = [];
  control.session = {
    subscribe: async () => {
      subscribeCalls.push("subscribe");
      return {} as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
    authInfo: { "privacy-pass": {} },
  };
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await tokenStarted;
  // 購読要求より前に保留 (audioInitialConfigPending) が有効化されていること
  assert.isTrue(control.audioInitialConfigPending);
  const closing = subscriber.close();
  releaseToken();

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.deepEqual(subscribeCalls, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 映像トラックの購読確立の await 中に解放が先行した場合、初期 configure の適用へ
 * 進まずに中止する。start の失敗時の巻き戻しに相当する解放で、確立した購読が解除される。
 *
 * 購読要求の解決をテストが決め、その間に close() を完了させる。
 */
test("subscribeMediaTracks: 映像の購読確立中に解放が先行したら初期 configure を適用しない", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "vp8" },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
    disposeAllResources(): Promise<void>;
  };
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.session = {
    subscribe: () =>
      new Promise<Subscriber>((resolve) => {
        completeSubscribe = resolve;
      }),
    close: async () => {},
  } as unknown as Session;
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
  };
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  // 購読要求 (session.subscribe) が出るまで待つ (購読の解決はテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // 購読の await 中に解放を先行させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立しても、解放の検査で中止し初期 configure の適用 (購読の Track Property の
  // 読み取り) をしないこと
  let unsubscribes = 0;
  let trackPropertyReads = 0;
  completeSubscribe({
    state: "active",
    get trackProperties() {
      trackPropertyReads++;
      return [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2]) }];
    },
    unsubscribe: async () => {
      unsubscribes++;
    },
  } as unknown as Subscriber);

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 初期 configure の適用が始まっていないこと
  assert.equal(trackPropertyReads, 0);

  // start の巻き戻しに相当する解放で、確立した購読が解除され参照も残らないこと
  await control.disposeAllResources();
  assert.equal(unsubscribes, 1);
  assert.isNull(control.videoSubscriber);
});

/**
 * 完了条件: 音声の初期 configure の適用 (configure の await) 中に解放が先行した場合、
 * 次の段階 (映像トラックの購読) へ進まずに中止する。
 *
 * VideoDecoderWrapper / AudioDecoderWrapper は WebCodecs のデコーダを作る。この検査は
 * 適用の await の直後にあり、configure の解決をテストが決めないと解放を割り込ませられない。
 * デコーダの境界だけを置き換え、reconfigureAudioDecoder の分岐は実装のまま駆動する。
 */
test("subscribeMediaTracks: 音声の初期 configure 適用中に解放が先行したら中止する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  // 初期 configure の適用を configure の await で止め、解放が入り込める窓を作る
  let releaseConfigure: () => void = () => {};
  let notifyConfigureStarted: () => void = () => {};
  const configureStarted = new Promise<void>((resolve) => {
    notifyConfigureStarted = resolve;
  });
  control.audioDecoder = {
    configure: () => {
      notifyConfigureStarted();
      return new Promise<void>((resolve) => {
        releaseConfigure = resolve;
      });
    },
    decode: () => {},
    close: () => {},
  };
  control.audioTrackInfo = {
    name: "audio",
    packaging: "loc",
    isLive: true,
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  };
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        trackProperties: [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([1, 2]) }],
        unsubscribe: async () => {},
      }) as unknown as Subscriber,
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await configureStarted;
  // 適用の await 中に解放を先行させる
  const closing = subscriber.close();
  releaseConfigure();

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 映像の初期 configure の適用 (configure の await) 中に解放が先行した場合、
 * start を "active" にせず中止する。映像側の検査が無ければ、解放後に初期 configure を
 * 適用したうえで start が成功してしまう。
 */
test("subscribeMediaTracks: 映像の初期 configure 適用中に解放が先行したら中止する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "vp8" },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  // 初期 configure の適用を configure の await で止め、解放が入り込める窓を作る
  let releaseConfigure: () => void = () => {};
  let notifyConfigureStarted: () => void = () => {};
  const configureStarted = new Promise<void>((resolve) => {
    notifyConfigureStarted = resolve;
  });
  control.videoDecoder = {
    configure: () => {
      notifyConfigureStarted();
      return new Promise<void>((resolve) => {
        releaseConfigure = resolve;
      });
    },
    decode: () => {},
    close: () => {},
  };
  control.videoTrackInfo = {
    name: "video",
    packaging: "loc",
    isLive: true,
    codec: "vp8",
  };
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        trackProperties: [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2]) }],
        unsubscribe: async () => {},
      }) as unknown as Subscriber,
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await configureStarted;
  // 適用の await 中に解放を先行させる
  const closing = subscriber.close();
  releaseConfigure();

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: カタログの受信の await が解決した直後に解放が先行した場合、トラック情報の抽出と
 * 出力の作成へ進まずに中止する。
 *
 * カタログ待ちは解放で reject されるため、解放が先行したことを受信の await の直後で
 * 判定できるのは「待ちが解決済みで、await の再開前に解放が入った」場合だけである。
 * FETCH を失敗させて live のフルカタログで待ちを解決し、その直後に close() を呼ぶ。
 */
test("subscribeCatalog: カタログの受信 await の解決直後に解放が先行したら中止する", async () => {
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], video: {} },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
    handleCatalogObject(obj: MoqtObject): void;
  };
  let unsubscribeCount = 0;
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        largestLocation: null,
        unsubscribe: async () => {
          unsubscribeCount++;
        },
      }) as unknown as Subscriber,
    // FETCH を失敗させ、FETCH フェーズを終わらせる (live のバッファをドレインさせる)
    fetch: async () => {
      throw new Error("fetch failed");
    },
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeCatalog(control.sessionGeneration, 60_000);
  // 購読の await を解決させ、カタログの受信待ちに入れる
  await sleep(0);
  assert.isNotNull(control.catalogResolve);

  // フルカタログを受信させ、受信待ちを解決する
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  assert.equal(catalogs.length, 1);
  assert.isNotNull(control.receivedCatalog);

  // 受信の await が再開する前に、close() の同期部分で世代番号を進める
  const closing = subscriber.close();

  let thrown: unknown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放で購読は解除され、参照も残らないこと
  assert.equal(unsubscribeCount, 1);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.equal(subscriber.state, "closed");
});
