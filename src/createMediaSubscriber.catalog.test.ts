/**
 * MediaSubscriber のカタログ・購読要求の組み立ての単体テスト
 *
 * processCatalogPayload / filterPendingCatalogObjects / isVideoKeyFrameObject /
 * resolveNewGroupRequestValue / resolveAuthorizationToken を検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import { MediaSubscriberImpl } from "./createMediaSubscriber";

import type { Session, SubscribeOptions } from "./session";

import type { Subscriber } from "./subscriber";

import type { AudioDelivery } from "./codec/types";

import {
  encodeCatalog,
  encodeCatalogDelta,
  type Catalog,
  type CatalogDelta,
  type CatalogTrack,
} from "./msf";

import {
  filterPendingCatalogObjects,
  isVideoKeyFrameObject,
  processCatalogPayload,
  resolveNewGroupRequestValue,
  resolveAuthorizationToken,
} from "./createMediaSubscriber";

import * as LOC from "./loc";
import { type MoqtObject } from "./dataStream";

import type { AuthorizationToken, Location } from "./message";

import { useValueToken } from "./testSupport/helpers";

import {
  createTestSubscriber,
  makeCatalog,
  makeCatalogObject,
  keyFrameMarking,
  deltaFrameMarking,
  type SubscriberInitialConfigControl,
  makeIdentifiedObject,
  makeAudioTrackInfo,
  makeVideoTrackInfo,
  installRecordingAudioDecoder,
} from "./testSupport/mediaSubscriberTestSupport";

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

test("processCatalogPayload: catalogNamespace の継承で重複する delta は error になる", () => {
  // draft-ietf-moq-msf-01 §5.2.2: track が namespace を宣言しない場合は catalog track の
  // namespace を継承する。継承後の重複 (§5.2.3) を検出するには呼び出し元が namespace を渡す
  const current = makeCatalog([
    { name: "v", packaging: "loc", isLive: true, namespace: "live/room1" },
  ]);
  const delta = encodeCatalogDelta({
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "v", packaging: "loc", isLive: true }] }],
  });

  // 継承を渡さないと、namespace 未宣言 (undefined) と "live/room1" は別物とみなされる
  assert.equal(processCatalogPayload(current, delta).kind, "delta");

  const result = processCatalogPayload(current, delta, { catalogNamespace: "live/room1" });
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.error.message, /duplicate track name 'v' under namespace 'live\/room1'/);
  }
});

test("catalog の delta 適用: catalog namespace を継承して重複を検出し、onError へ通知する", () => {
  // MediaSubscriberOptions.namespace を "/" で連結した値を継承に使う (実装固有の規約)
  const { control, catalogs, errors } = createDeltaTestSubscriber(["live", "room1"]);

  // フル: namespace を明示した track
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(
      makeCatalog([{ name: "v", packaging: "loc", isLive: true, namespace: "live/room1" }]),
    ),
  });
  assert.equal(catalogs.length, 1);
  const applied = control.receivedCatalog;

  // delta: 同じ名前の track を namespace を宣言せずに add する (継承後の重複)
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 1n),
    payload: encodeCatalogDelta({
      deltaUpdate: true,
      operations: [{ type: "add", tracks: [{ name: "v", packaging: "loc", isLive: true }] }],
    }),
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate track name 'v' under namespace 'live\/room1'/);
  // 適用しない (receivedCatalog も onCatalog も動かない)
  assert.strictEqual(control.receivedCatalog, applied);
  assert.equal(catalogs.length, 1);
});

test("catalog の delta 適用: 継承して重複しない delta は適用する", () => {
  // 既存 track の namespace が catalog のものと違えば、継承しても重複しない (過剰な拒否のガード)
  const { control, catalogs, errors } = createDeltaTestSubscriber(["live", "room1"]);

  control.handleCatalogObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(
      makeCatalog([{ name: "v", packaging: "loc", isLive: true, namespace: "live/room2" }]),
    ),
  });
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 1n),
    payload: encodeCatalogDelta({
      deltaUpdate: true,
      operations: [{ type: "add", tracks: [{ name: "v", packaging: "loc", isLive: true }] }],
    }),
  });

  assert.deepEqual(errors, []);
  assert.equal(catalogs.length, 2);
  assert.equal(control.receivedCatalog?.tracks.length, 2);
});

test("catalog の delta 適用: namespace が空配列なら継承せず従来どおり適用する", () => {
  // namespace が空配列のときは §5.2.2 の継承を解決しない (namespace 未宣言どうしの重複だけを
  // 検出する従来の挙動)。namespace を明示した track と namespace 未宣言の track は別物と
  // して扱う
  const { control, catalogs, errors } = createDeltaTestSubscriber([]);

  control.handleCatalogObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeCatalog([{ name: "v", packaging: "loc", isLive: true }])),
  });
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 1n),
    payload: encodeCatalogDelta({
      deltaUpdate: true,
      operations: [
        {
          type: "add",
          tracks: [{ name: "v", packaging: "loc", isLive: true, namespace: "live/room1" }],
        },
      ],
    }),
  });

  assert.deepEqual(errors, []);
  assert.equal(catalogs.length, 2);
  assert.equal(control.receivedCatalog?.tracks.length, 2);

  // 空文字の namespace を明示した track と namespace 未宣言の track も別物として扱う
  // (継承を解決しないため)。空文字を継承値にすると重複として拒否される入力である
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 2n),
    payload: encodeCatalog(
      makeCatalog([{ name: "w", packaging: "loc", isLive: true, namespace: "" }]),
    ),
  });
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 3n),
    payload: encodeCatalogDelta({
      deltaUpdate: true,
      operations: [{ type: "add", tracks: [{ name: "w", packaging: "loc", isLive: true }] }],
    }),
  });
  assert.deepEqual(errors, []);
  assert.equal(catalogs.length, 4);
});

/**
 * delta 適用の検証用の制御口
 *
 * `handleCatalogObject` は private であるため、この形にキャストして呼ぶ。
 */
interface SubscriberCatalogDeltaControl {
  receivedCatalog: Catalog | null;
  handleCatalogObject(obj: MoqtObject): void;
}

/**
 * delta 適用のテスト用に購読者を作る
 *
 * `catalogs` と `errors` は利用者へ通知された内容の確認に使う。
 *
 * @param namespace 購読する Track Namespace のフィールド列
 * @returns 制御口と、通知された catalog / error
 */
function createDeltaTestSubscriber(namespace: string[]): {
  control: SubscriberCatalogDeltaControl;
  catalogs: Catalog[];
  errors: Error[];
} {
  const { subscriber, catalogs, errors } = createTestSubscriber({ namespace });
  return {
    control: subscriber as unknown as SubscriberCatalogDeltaControl,
    catalogs,
    errors,
  };
}

// ============================================================================
// filterPendingCatalogObjects（FETCH と live の二重配信除去）
// ============================================================================

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
// resolveNewGroupRequestValue（draft-ietf-moq-transport-22 §9.20.19）
// ============================================================================

/**
 * §9.20.19 (NEW GROUP REQUEST Parameter):
 * "It represents the largest Group ID in the Track known by the subscriber, plus 1.
 *  A value of 0 indicates that the subscriber has no Group information for the Track."
 *
 * 購読者が知る最大 Group ID は、購読で受信した Object の最大 Location (§3.1.4) と
 * LARGEST_OBJECT で報告された最大 Location (§9.20.17) の大きい方である。
 */
test("resolveNewGroupRequestValue: 受信と LARGEST_OBJECT の大きい方の次の Group になる", () => {
  // 受信した Object の方が進んでいる場合
  assert.equal(
    resolveNewGroupRequestValue({ group: 41n, object: 3n }, { group: 40n, object: 9n }),
    42n,
  );
  // LARGEST_OBJECT の方が進んでいる場合 (購読直後はこちら)
  assert.equal(
    resolveNewGroupRequestValue({ group: 40n, object: 0n }, { group: 41n, object: 3n }),
    42n,
  );
  // Group ID が同じときは Object ID の大小で値が変わらない (Group ID + 1 を作るため)
  assert.equal(
    resolveNewGroupRequestValue({ group: 41n, object: 0n }, { group: 41n, object: 7n }),
    42n,
  );
});

/**
 * 片方だけ分かっていればその値を使い、Group 情報がまったく無ければ 0 を送る
 * (§9.20.19 の「購読者は Group 情報を持たない」)。
 */
test("resolveNewGroupRequestValue: 片方だけでも使う", () => {
  assert.equal(resolveNewGroupRequestValue({ group: 7n, object: 0n }, null), 8n);
  assert.equal(resolveNewGroupRequestValue(null, { group: 7n, object: 0n }), 8n);
  assert.equal(resolveNewGroupRequestValue(null, null), 0n);
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

/** 再構成 (fire-and-forget) の完了を待つ */
async function waitForConfigured(control: SubscriberInitialConfigControl): Promise<void> {
  for (let i = 0; i < 10 && !control.videoDecoderConfigured; i++) {
    await Promise.resolve();
  }
}

/**
 * 音声の cache 境界の検証用の制御口
 *
 * `subscribeMediaTracks` を実際に駆動し、SUBSCRIBE_OK の LARGEST_OBJECT を境界として
 * 設定させる。Session は購読の確立と Object のコールバックの捕捉だけを持つ最小の代役で
 * ある (モジュール置換は行わない)。
 */
interface SubscriberAudioCatchUpControl extends SubscriberInitialConfigControl {
  session: Session | null;
  audioTrackInfo: CatalogTrack | null;
  sessionGeneration: number;
  subscribeMediaTracks(startGeneration: number): Promise<void>;
}

/** 音声の cache 境界を検証するための組 */
interface AudioCatchUpHarness {
  readonly subscriber: MediaSubscriberImpl;
  readonly control: SubscriberAudioCatchUpControl;
  /** 購読の Object コールバックへ Object を流す */
  readonly deliver: (obj: MoqtObject, delivery?: AudioDelivery) => void;
  /** 復号へ渡った Object の payload の先頭バイト (到着順) */
  readonly decoded: number[];
}

/**
 * 音声の cache 境界を検証する組を作る
 *
 * 購読のたびに `boundaries` の次の要素を SUBSCRIBE_OK の LARGEST_OBJECT として返す。
 * `onSubscribe` は購読の確立中 (SUBSCRIBE_OK を返す前) に呼ばれ、前の購読の境界が
 * 残っていないかを確かめるために Object を届ける。
 */
function createAudioCatchUpHarness(options: {
  boundaries: readonly (Location | null)[];
  onSubscribe?: (deliver: (obj: MoqtObject) => void, subscriptionIndex: number) => void;
}): AudioCatchUpHarness {
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
  }).subscriber;
  const control = subscriber as unknown as SubscriberAudioCatchUpControl;
  const decoded = installRecordingAudioDecoder(control);
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "opus" };
  let objectCallback: ((obj: MoqtObject) => void) | null = null;
  let datagramCallback: ((obj: MoqtObject) => void) | null = null;
  let subscriptionIndex = 0;
  control.session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>): Promise<Subscriber> => {
      objectCallback = args[2].object;
      datagramCallback = args[2].datagram ?? null;
      const largestLocation = options.boundaries[subscriptionIndex] ?? null;
      // 購読の確立中に届く Object を、前の購読の境界が残っていない状態で受け取れるか
      options.onSubscribe?.((obj) => objectCallback?.(obj), subscriptionIndex);
      subscriptionIndex++;
      return {
        state: "active",
        largestLocation,
        trackProperties: [],
        unsubscribe: async () => {},
      } as unknown as Subscriber;
    },
  } as unknown as Session;
  return {
    subscriber,
    control,
    deliver: (obj, delivery = "datagram") => {
      if (delivery === "datagram") {
        datagramCallback?.(obj);
        return;
      }
      objectCallback?.(obj);
    },
    decoded,
  };
}

/**
 * draft-ietf-moq-loc-04 Table 1 / §2.3.2.1:
 * VIDEO_CONFIG は Track Property でも届く。SUBSCRIBE_OK の Track Property を初期 configure に
 * 反映し、その完了までに届いた Object を保留して復号に渡す (最初の Object を捨てない)。
 */
test("applyInitialVideoConfig: Track Property の VIDEO_CONFIG が初期 configure に渡り保留中の Object が復号される", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
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
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
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
  const subscriber = createTestSubscriber({
    video: { codec: "av1" },
  }).subscriber;
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
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
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
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
  }).subscriber;
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
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48000,
    channelConfig: "2",
  });
  control.session = {
    subscribe: async (_namespace, _trackName, callbacks) => {
      // 購読要求より前に保留が有効化されている
      assert.isTrue(control.audioInitialConfigPending);
      callbacks.object(makeIdentifiedObject(0n, 0x88));
      return {
        largestLocation: null,
        trackProperties: [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([6, 6]) }],
      } as unknown as {
        largestLocation: Location | null;
        trackProperties: { id: bigint; data?: Uint8Array }[];
      };
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
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
  }).subscriber;
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
      return { largestLocation: null, trackProperties: [] } as unknown as Subscriber;
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
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
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
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
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
  const { subscriber, errors } = createTestSubscriber({ video: {} });
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
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
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
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
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
 * 完了条件: SUBSCRIBE_OK の LARGEST_OBJECT 以前の音声 Object は relay の cache から
 * 届いた分として復号へ渡さず、捨てた数を統計に出す。境界より後の Object は live として
 * 復号する。
 */
test("receiveAudioObject: SUBSCRIBE_OK の LARGEST_OBJECT 以前の音声 Object を復号へ渡さない", async () => {
  const harness = createAudioCatchUpHarness({
    boundaries: [{ group: 1n, object: 1n }],
    onSubscribe: (deliver, subscriptionIndex) => {
      if (subscriptionIndex === 0) {
        // 購読の確立前 (境界を設定する前) に届いて保留された Object も、境界が決まった後の
        // 解放で cache と判定して捨てる
        deliver({ ...makeIdentifiedObject(0n, 0x99), groupId: 1n });
      }
    },
  });
  await harness.control.subscribeMediaTracks(harness.control.sessionGeneration);

  // 境界そのもの、境界より前の位置、前の Group の位置は cache の音声である
  harness.deliver({ ...makeIdentifiedObject(1n, 0x11), groupId: 1n });
  harness.deliver({ ...makeIdentifiedObject(0n, 0x22), groupId: 1n });
  harness.deliver({ ...makeIdentifiedObject(9n, 0x33), groupId: 0n });
  // 境界より後の位置は live である
  harness.deliver({ ...makeIdentifiedObject(2n, 0x44), groupId: 1n });
  harness.deliver({ ...makeIdentifiedObject(0n, 0x55), groupId: 2n });

  assert.deepEqual(harness.decoded, [0x44, 0x55], "境界以前の音声だけを復号しないこと");
  const stats = harness.subscriber.getStats().audio;
  assert.equal(stats?.catchUpObjectsSkipped, 4, "保留から解放した分も含めて捨てた数を数えること");
  assert.equal(stats?.framesReceived, 2, "捨てた分を受信数に含めないこと");
});

/**
 * 完了条件: LARGEST_OBJECT が省略された (null の) 購読では、位置によらず全 Object を
 * live として復号する。
 */
test("receiveAudioObject: LARGEST_OBJECT が無い購読では全 Object を live として復号する", async () => {
  const harness = createAudioCatchUpHarness({ boundaries: [null] });
  await harness.control.subscribeMediaTracks(harness.control.sessionGeneration);

  harness.deliver({ ...makeIdentifiedObject(1n, 0x11), groupId: 0n });
  harness.deliver({ ...makeIdentifiedObject(2n, 0x22), groupId: 1n });

  assert.deepEqual(harness.decoded, [0x11, 0x22]);
  assert.equal(harness.subscriber.getStats().audio?.catchUpObjectsSkipped, 0);
});

/**
 * 完了条件: 購読を始め直すと前の購読の境界が消える。2 回目の購読の確立中に、前の購読の
 * 境界以前だった位置の Object を届けても捨てず、live として復号する。
 */
test("receiveAudioObject: 購読のやり直しで cache の境界をリセットする", async () => {
  const harness = createAudioCatchUpHarness({
    boundaries: [{ group: 1n, object: 1n }, null],
    onSubscribe: (deliver, subscriptionIndex) => {
      if (subscriptionIndex === 1) {
        // 2 回目の購読の確立中 (SUBSCRIBE_OK を受け取る前) に、前の購読の境界以前だった
        // 位置の Object を届ける。購読の開始で境界を消していなければ捨てられる
        deliver({ ...makeIdentifiedObject(0n, 0x77), groupId: 1n });
      }
    },
  });
  // 1 回目の購読: 境界が設定され、境界以前の Object は捨てる
  await harness.control.subscribeMediaTracks(harness.control.sessionGeneration);
  harness.deliver({ ...makeIdentifiedObject(1n, 0x11), groupId: 1n });
  assert.deepEqual(harness.decoded, []);

  // 2 回目の購読: 開始時に境界を消しているため、確立中に届いた Object は live になる
  await harness.control.subscribeMediaTracks(harness.control.sessionGeneration);
  // 2 回目は LARGEST_OBJECT が無いため、確立後の Object も live である
  harness.deliver({ ...makeIdentifiedObject(2n, 0x88), groupId: 2n });

  assert.deepEqual(harness.decoded, [0x77, 0x88], "前の購読の境界で捨てないこと");
  assert.equal(harness.subscriber.getStats().audio?.catchUpObjectsSkipped, 1);
});
