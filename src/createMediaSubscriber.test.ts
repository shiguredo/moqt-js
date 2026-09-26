/**
 * MediaSubscriber の単体テスト
 *
 * processCatalogPayload / filterPendingCatalogObjects / isVideoKeyFrameObject /
 * resolveAuthorizationToken の純関数ロジック、映像 Object のキーフレーム判定が
 * VideoDecoder と videoStats に伝わること (handleVideoObject)、復号フレーム破棄の
 * 所有権 (handleVideoDecodedData / handleAudioDecodedData)、Catalog 取得失敗後の
 * hygiene、extractTrackInfo の role なし解決と未解決通知、Track Property の
 * VIDEO_CONFIG / AUDIO_CONFIG の初期 configure への反映と保留キュー、音声と映像の
 * 表示時刻 (targetLatency の解決、共有の時間軸、AudioContext の時計との換算) を検証する。
 */

import { test, assert } from "vite-plus/test";
import { MediaSubscriberImpl } from "./createMediaSubscriber";
import type { FetchOptions, Session } from "./session";
import type { Subscriber, RequestUpdateOptions } from "./subscriber";
import type { MediaReceiverStats, MediaSubscriberState } from "./codec/types";
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
import { GROUP_SWITCH_HOLD_MS } from "./groupSwitchGate";
import type { Location } from "./message";
import { useValueToken } from "./testSupport/helpers";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  type AudioClockMapping,
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
    subscribeMediaTracks(): Promise<void>;
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

  await control.subscribeMediaTracks();

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
    subscribeMediaTracks(): Promise<void>;
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

  await control.subscribeMediaTracks();

  assert.equal(configured.length, 1);
  assert.deepEqual(Array.from(configured[0] ?? []), [6, 6]);
  assert.deepEqual(decoded, [0x88]);
  assert.isFalse(control.audioInitialConfigPending);
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
 * draft-ietf-moq-transport-21 Section 2.3: Group の Object は他の Group の Object に依存
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
 * draft-ietf-moq-transport-21 Section 2.1: Object は順不同で届きうる。後から購読した直後
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
  catalogFetchInProgress: boolean;
  pendingCatalogObjects: MoqtObject[];
  catalogFetchLastLocation: Location | null;
  catalogResolve: ((catalog: Catalog) => void) | null;
  catalogTimer: ReturnType<typeof setTimeout> | null;
  catalogReceiveFailed: boolean;
  subscribeCatalog(timeoutMs?: number): Promise<void>;
}

/**
 * Catalog 取得用の最小セッション
 *
 * live / FETCH の object コールバックを捕捉し、遅延オブジェクトを注入できる。
 * subscribe / fetch の引数は実シグネチャで拘束し、返値のみ最小形状にする。
 * SUBSCRIBE_OK の LARGEST_OBJECT は `subscribeLargestLocation` で与え、
 * FETCH に載った options は `fetchOptions` で取り出す。
 */
function createCatalogTestSession(
  hooks: { subscribeError?: Error; subscribeLargestLocation?: Location } = {},
): {
  session: Session;
  liveObject: (obj: MoqtObject) => void;
  fetchObject: (obj: MoqtObject) => void;
  fetchEnd: () => void;
  fetchOptions: () => FetchOptions | undefined;
  calls: string[];
} {
  const calls: string[] = [];
  let liveObject: (obj: MoqtObject) => void = () => {};
  let fetchObject: (obj: MoqtObject) => void = () => {};
  let fetchEnd: () => void = () => {};
  let fetchOptions: FetchOptions | undefined;
  const session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>): Promise<Subscriber> => {
      calls.push("subscribe");
      if (hooks.subscribeError) {
        throw hooks.subscribeError;
      }
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
    await control.subscribeCatalog(10);
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
    await control.subscribeCatalog(10);
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

  const pending = control.subscribeCatalog(1000);
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
  // 2 フィールドで StartGroup = StartObject = 0 は Next Object を意味するため
  // (draft-ietf-moq-transport-21 §9.20.10)、Group 0 では絶対開始にならない。
  // Group 0 はフィルタ無しの要求範囲 {0, 0} から Largest Object までと一致する
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
  const { session, liveObject, fetchEnd, fetchOptions } = createCatalogTestSession({
    subscribeLargestLocation: { group: 7n, object: 3n },
  });
  control.session = session;

  const pending = control.subscribeCatalog(1000);
  // subscribe / fetch 登録の完了を microtask の flush で待つ (タイマー不使用)
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }

  assert.deepEqual(fetchOptions()?.filter, { startGroup: 7n, startObject: 0n });

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

  const pending = control.subscribeCatalog(1000);
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
    createBuffer: () => ({ copyToChannel: () => {} }),
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
