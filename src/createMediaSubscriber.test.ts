/**
 * MediaSubscriber の単体テスト
 *
 * processCatalogPayload / filterPendingCatalogObjects / isVideoKeyFrameObject /
 * resolveAuthorizationToken の純関数ロジック、映像 Object のキーフレーム判定が
 * VideoDecoder と videoStats に伝わること (handleVideoObject)、復号フレーム破棄の
 * 所有権 (handleVideoDecodedData / handleAudioDecodedData)、Catalog 取得失敗後の
 * hygiene、extractTrackInfo の role なし解決と未解決通知、Track Property の
 * VIDEO_CONFIG / AUDIO_CONFIG の初期 configure への反映と保留キューを検証する。
 */

import { test, assert } from "vite-plus/test";
import { MediaSubscriberImpl } from "./createMediaSubscriber";
import type { FetchOptions, Session } from "./session";
import type { Subscriber, RequestUpdateOptions } from "./subscriber";
import type { MediaSubscriberState } from "./codec/types";
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
  control.audioContext = {
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
