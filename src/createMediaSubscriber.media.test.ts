/**
 * MediaSubscriber の受信・保留キュー・復号フレームの単体テスト
 *
 * 保留キューの上限、購読の確立、復号フレームの所有権、映像デコーダのエラー、
 * カタログセッション、新しい Group の要求、トラックの解決を検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import { MediaSubscriberImpl, createMediaSubscriber } from "./createMediaSubscriber";

import { playoutAudioInputMapOf } from "./testSupport/mediaPlayoutInternals";

import { installAudioOutput, subscriberInternalsOf } from "./testSupport/mediaSubscriberInternals";

import { MAX_PRE_DECODE_DELAY_MS } from "./playout/preDecodeDelay";

import { PreDecodeDelayStage } from "./playout/preDecodeDelayStage";

import type { Session } from "./session";

import type { Subscriber, RequestUpdateOptions } from "./subscriber";

import type { MediaSubscriberState } from "./codec/types";

import { TrackPropertyId } from "./properties";

import { encodeCatalog, encodeCatalogDelta, type Catalog, type CatalogTrack } from "./msf";

import { catalogFetchFilter, DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS } from "./createMediaSubscriber";

import * as LOC from "./loc";
import { type MoqtObject } from "./dataStream";

import { GROUP_SWITCH_HOLD_MS } from "./groupSwitchGate";

import type { VideoDecodeOrder } from "./videoDecodeOrder";

import type { AuthorizationToken, Location } from "./message";

import {
  useValueToken,
  waitForUnhandledRejectionDetection,
  withUnhandledRejectionWatch,
} from "./testSupport/helpers";

import {
  createTestSubscriber,
  makeCatalog,
  makeCatalogObject,
  deltaFrameMarking,
  type SubscriberInitialConfigControl,
  makeIdentifiedObject,
  type SubscriberVideoObjectControl,
  type SubscriberVideoGateControl,
  makeStreamVideoObject,
  type DelayedAudioItem,
  type SubscriberPreDecodeDelayControl,
  createPreDecodeDelaySubscriber,
  type SubscriberFrameControl,
  createCatalogTestSession,
  makeVideoCatalog,
  sleep,
  type SubscriberLifecycleControl,
  injectLifecycleResources,
  captureThrown,
  makeAudioTrackInfo,
  installRecordingAudioDecoder,
  installRecordingVideoDecoder,
} from "./testSupport/mediaSubscriberTestSupport";

/**
 * payload 長と properties 長を指定して Object を作る (保留キューのバイト上限の検証用)
 *
 * properties は省略可能なため、長さ 0 のときはフィールド自体を作らない
 * (exactOptionalPropertyTypes では undefined を明示できない)。
 */
function makeSizedObject(
  objectId: bigint,
  marker: number,
  payloadLength: number,
  propertiesLength = 0,
): MoqtObject {
  const payload = new Uint8Array(payloadLength);
  payload[0] = marker;
  const object: MoqtObject = {
    groupId: 1n,
    objectId,
    status: 0,
    payload,
  };
  if (propertiesLength > 0) {
    object.properties = new Uint8Array(propertiesLength);
  }
  return object;
}

// ============================================================================
// 保留キューの上限（初期 configure の完了まで保持する Object）
// ============================================================================

/**
 * 上限の既定値は定数として export され、購読の作成時に
 * `MediaSubscriberOptions.pendingObjectQueue` で上書きできる。保留は購読要求から
 * 初期 configure 完了までの短い区間に限られるが、`session.subscribe` が解決しない、
 * または初期 configure がハングする異常時は区間が伸びるため、件数とバイト数の
 * 両方に上限を設ける (0 以下は上限なしという既存の上限の規約に合わせる)。
 */
test("pendingObjectQueue: 既定は 512 件 / 1 MiB の定数として export されている", () => {
  assert.equal(DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS.maxObjects, 512);
  assert.equal(DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS.maxBytes, 1 << 20);
});

/**
 * 上限の指定を省略した場合は既定値が効く。件数の上限は「上限ぶんは保持し、超えた分は
 * 保持しない」であり、超過の通知はキューごとに購読期間あたり 1 回だけである。
 */
test("handleVideoObject: 上限を省略したら既定の件数上限で保留を打ち切る", () => {
  const { subscriber, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  // subscribeMediaTracks が購読要求より前に有効化する状態を再現する
  control.videoInitialConfigPending = true;

  // 既定の件数上限ちょうどまで保持し、その次の 1 件は保持しない
  const limit = DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS.maxObjects;
  for (let i = 0; i <= limit; i++) {
    control.handleVideoObject(makeIdentifiedObject(BigInt(i), 0x11));
  }

  assert.equal(control.pendingVideoObjects.length, limit);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /video pending object queue overflow/);
  assert.match(errors[0]?.message ?? "", new RegExp(`maxObjects=${limit}`));
});

/**
 * 上限を超えた Object は保持せず破棄し、超過は onError で 1 回だけ通知する。
 * 上限内の Object は従来どおり初期 configure 完了後に到着順で処理され、
 * 破棄した Object は受信統計に数えない (保留中の Object を数えていないのと同じ扱い)。
 */
test("handleVideoObject: 保留キューの件数上限を超えた Object は破棄し onError を 1 回通知する", async () => {
  const { subscriber, errors } = createTestSubscriber({
    video: {},
    pendingObjectQueue: { maxObjects: 2 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const decoded = installRecordingVideoDecoder(control);
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
  control.videoInitialConfigPending = true;

  // 上限 2 件のうち 2 件は保留し、3 件目と 4 件目は保持しない
  control.handleVideoObject(makeIdentifiedObject(0n, 0x11));
  control.handleVideoObject(makeIdentifiedObject(1n, 0x22));
  control.handleVideoObject(makeIdentifiedObject(2n, 0x33));
  control.handleVideoObject(makeIdentifiedObject(3n, 0x44));

  assert.equal(control.pendingVideoObjects.length, 2);
  assert.equal(control.pendingVideoQueueState.bytes, 2);
  // 保留中は復号せず、統計にも数えない
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.equal(subscriber.getStats().video?.bytesReceived, 0);
  // 超過の通知は 1 回だけで、上限と実際の件数を含む
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /video pending object queue overflow/);
  assert.match(errors[0]?.message ?? "", /maxObjects=2/);
  assert.match(errors[0]?.message ?? "", /objects=3/);

  // 初期 configure の完了で、保留していた 2 件だけが到着順に復号される
  await control.applyInitialVideoConfig();
  assert.deepEqual(decoded, [0x11, 0x22]);
  assert.equal(subscriber.getStats().video?.framesReceived, 2);
  assert.equal(subscriber.getStats().video?.bytesReceived, 2);
  // 解放後は保留キューの計数も空になる
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(control.pendingVideoQueueState.bytes, 0);
});

/**
 * バイト数の上限は、小さい Object を少しだけ送る場合でも効く。件数の上限に達して
 * いなくても、payload の合計が上限を超えた Object は保持せず破棄する。
 */
test("handleAudioObject: 保留キューのバイト上限を超えた Object は破棄し onError を 1 回通知する", async () => {
  const { subscriber, errors } = createTestSubscriber({
    audio: {},
    pendingObjectQueue: { maxBytes: 3 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const decoded = installRecordingAudioDecoder(control);
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "opus" };
  control.audioInitialConfigPending = true;

  // payload 2 バイトは保留し、続く 2 バイトは合計 4 バイトで上限 3 を超えるため保持しない
  // (さらに続く Object も保持せず、通知は 1 回だけである)
  control.handleAudioObject(makeSizedObject(0n, 0x11, 2));
  control.handleAudioObject(makeSizedObject(1n, 0x22, 2));
  control.handleAudioObject(makeSizedObject(2n, 0x33, 2));

  assert.equal(control.pendingAudioObjects.length, 1);
  assert.equal(control.pendingAudioQueueState.bytes, 2);
  assert.deepEqual(decoded, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /audio pending object queue overflow/);
  assert.match(errors[0]?.message ?? "", /maxBytes=3/);
  assert.match(errors[0]?.message ?? "", /bytes=4/);

  // 初期 configure の完了で、保留していた 1 件だけが復号される (破棄した分は統計に入らない)
  await control.applyInitialAudioConfig();
  assert.deepEqual(decoded, [0x11]);
  assert.equal(subscriber.getStats().audio?.framesReceived, 1);
  assert.equal(subscriber.getStats().audio?.bytesReceived, 2);
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.equal(control.pendingAudioQueueState.bytes, 0);
});

/**
 * 完了条件: 受信側の統計が音声 Object の到着経路 (Subgroup / Datagram) を分けて数える
 * (draft-ietf-moq-transport-22 §11)。Datagram は再送されないため、欠落と補間・捨ての割合を
 * 経路ごとに比べられるようにする。経路は到着時にしか分からないため、保留キューを経由しても
 * 保つ
 */
test("handleAudioObject: 到着経路ごとに受信数を数える (保留キューを経由しても保つ)", async () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const decoded = installRecordingAudioDecoder(control);
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "opus" };

  // 初期 configure が済んでいない間に届いた Datagram は保留し、経路を保ったまま復号する
  control.audioInitialConfigPending = true;
  control.handleAudioObject(makeIdentifiedObject(0n, 0x11), "datagram");
  assert.equal(control.pendingAudioObjects.length, 1);
  await control.applyInitialAudioConfig();

  // Subgroup で届いた分と Datagram で届いた分を別々に数える
  control.handleAudioObject(makeIdentifiedObject(1n, 0x22), "subgroup");
  control.handleAudioObject(makeIdentifiedObject(2n, 0x33), "datagram");

  const stats = subscriber.getStats().audio;
  assert.deepEqual(decoded, [0x11, 0x22, 0x33]);
  assert.equal(stats?.framesReceived, 3);
  assert.equal(stats?.subgroupFramesReceived, 1);
  assert.equal(stats?.datagramFramesReceived, 2);
});

/**
 * 完了条件: 同じ識別子の音声 Object を 2 回受け取ったとき、2 回目は復号へ渡さない。
 *
 * 音声は既定で datagram で届き、再送されない (RFC 9221)。経路の損失に備えて配信側が同じ
 * Object を 2 回送ることがある (devtools の `audioRedundancy=2`)。渡すと同じ音を 2 回鳴らし、
 * 媒体時刻が実時間より先へ進む。
 *
 * 実測 (実リレー、5 % のパケロスを入れて 60 秒、各 2 回): 1 回送りでは欠落 5.6 %・鳴らした
 * 長さ 94 %・復号器の作り直し 31 回 / 40 秒であったのに対し、2 回送りでは欠落 0.2 %・
 * 鳴らした長さ 99.4 %・作り直し 1〜3 回 / 60 秒になった
 */
test("handleAudioObject: 同じ識別子の音声 Object は 2 回目を復号へ渡さない", () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  const decoded = installRecordingAudioDecoder(control);
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true, codec: "opus" };

  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "datagram");
  // 配信側の冗長化で、同じ Object がもう 1 回届く
  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "datagram");
  // 別の Object は通す
  control.receiveAudioObject(makeIdentifiedObject(1n, 0x22), "datagram");

  assert.deepEqual(decoded, [0x11, 0x22], "同じ Object は 1 回だけ復号すること");
  const stats = subscriber.getStats().audio;
  assert.equal(stats?.framesReceived, 2, "受信数にも 2 回目を数えないこと");
  assert.equal(stats?.datagramFramesReceived, 2);
});

/**
 * バイト数の上限も「上限ぶんは保持し、超える分は保持しない」であり、payload と
 * properties の合計が上限ちょうどの Object は保持する。上限を 1 バイトでも超えた
 * Object だけを破棄する (件数の上限の数え方に合わせる)。
 */
test("handleAudioObject: payload と properties の合計がバイト上限ちょうどの Object は保持する", () => {
  const { subscriber, errors } = createTestSubscriber({
    audio: {},
    pendingObjectQueue: { maxBytes: 6 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  control.audioInitialConfigPending = true;

  // payload 3 バイトの 1 件目で合計 3 バイト、payload 1 バイト + properties 2 バイトの
  // 2 件目で合計 6 バイト (上限ちょうど) になり、properties 付きでもどちらも保留する
  control.handleAudioObject(makeSizedObject(0n, 0x11, 3));
  control.handleAudioObject(makeSizedObject(1n, 0x22, 1, 2));
  assert.equal(control.pendingAudioObjects.length, 2);
  assert.equal(control.pendingAudioQueueState.bytes, 6);
  assert.deepEqual(errors, []);

  // 合計 7 バイトになる 3 件目で初めて破棄し、超過を 1 回だけ通知する
  control.handleAudioObject(makeSizedObject(2n, 0x33, 1));
  assert.equal(control.pendingAudioObjects.length, 2);
  assert.equal(control.pendingAudioQueueState.bytes, 6);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /maxBytes=6/);
  assert.match(errors[0]?.message ?? "", /bytes=7/);
});

/**
 * properties の長さは wire では varint で運ばれ、上限が無ければ無制限に受理され得る。
 * payload だけを数えると、payload が 0 バイトに近くても properties が大きい Object が
 * バイト上限に触れずに保持され続けるため、payload と properties の合計で判定する
 * (受信統計の bytesReceived と同じ定義)。
 */
test("handleAudioObject: payload が小さくても properties との合計がバイト上限を超えたら破棄する", () => {
  const { subscriber, errors } = createTestSubscriber({
    audio: {},
    pendingObjectQueue: { maxBytes: 8 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  control.audioInitialConfigPending = true;

  // properties 16 バイトだけでも上限 8 を超える (payload 1 バイトを足した合計は 17 バイト)
  control.handleAudioObject(makeSizedObject(0n, 0x11, 1, 16));
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.equal(control.pendingAudioQueueState.bytes, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /audio pending object queue overflow/);
  assert.match(errors[0]?.message ?? "", /maxBytes=8/);
  // 通知のバイト数は payload と properties の合計 17 であり、payload だけの 1 ではない
  assert.match(errors[0]?.message ?? "", /bytes=17/);

  // 同じ payload でも properties が無ければ合計 1 バイトで上限に収まるため、保留する
  control.handleAudioObject(makeSizedObject(1n, 0x22, 1));
  assert.equal(control.pendingAudioObjects.length, 1);
  assert.equal(control.pendingAudioQueueState.bytes, 1);
  assert.equal(errors.length, 1);
});

/**
 * 件数とバイト数の上限はどちらも独立に見るため、1 件の Object で同時に超えることがある。
 * 同時に超えても通知は 1 回だけで、その後の超過でも増えない (キューごとに購読期間あたり
 * 1 回だけ通知する)。
 */
test("handleVideoObject: 件数とバイト数の上限を同時に超えても onError は 1 回だけ通知する", () => {
  const { subscriber, errors } = createTestSubscriber({
    video: {},
    pendingObjectQueue: { maxObjects: 1, maxBytes: 2 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  control.videoInitialConfigPending = true;

  // 1 件目 (payload 1 バイト) は件数 1 とバイト数 1 でどちらの上限にも収まる
  control.handleVideoObject(makeSizedObject(0n, 0x11, 1));
  assert.equal(control.pendingVideoObjects.length, 1);
  assert.equal(control.pendingVideoQueueState.bytes, 1);

  // 2 件目 (payload 2 バイト) は件数 2 > 1 とバイト数 3 > 2 を同時に超える
  control.handleVideoObject(makeSizedObject(1n, 0x22, 2));
  assert.equal(control.pendingVideoObjects.length, 1);
  assert.equal(control.pendingVideoQueueState.bytes, 1);
  assert.equal(errors.length, 1);
  // 通知の文言には両方の上限と実際の値が入る
  assert.match(errors[0]?.message ?? "", /video pending object queue overflow/);
  assert.match(errors[0]?.message ?? "", /maxObjects=1/);
  assert.match(errors[0]?.message ?? "", /maxBytes=2/);
  assert.match(errors[0]?.message ?? "", /objects=2/);
  assert.match(errors[0]?.message ?? "", /bytes=3/);

  // 3 件目も両方を超えるが、通知済みフラグにより通知は増えない
  control.handleVideoObject(makeSizedObject(2n, 0x33, 2));
  assert.equal(errors.length, 1);
  assert.equal(control.pendingVideoObjects.length, 1);
  assert.equal(control.pendingVideoQueueState.bytes, 1);
});

/**
 * 上限に 0 以下を指定した場合は上限なしになる (ConnectOptions の
 * dataStreamMaxBufferBytes と同じ規約)。既定の件数上限を超える件数でも保持し、
 * 超過の通知は出ない。
 */
test("handleVideoObject: 上限に 0 以下を指定したら無制限に保留する", () => {
  const { subscriber, errors } = createTestSubscriber({
    video: {},
    pendingObjectQueue: { maxObjects: 0, maxBytes: 0 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  control.videoInitialConfigPending = true;

  const count = DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS.maxObjects + 1;
  for (let i = 0; i < count; i++) {
    control.handleVideoObject(makeIdentifiedObject(BigInt(i), 0x11));
  }

  assert.equal(control.pendingVideoObjects.length, count);
  assert.equal(control.pendingVideoQueueState.bytes, count);
  assert.deepEqual(errors, []);
});

/**
 * 上限に負の値を指定した場合も上限なしになる (0 以下で上限なしという規約)。件数は既定の
 * 上限を超える件数を、バイト数は 1 件で既定の上限を超える payload を送り、どちらの上限も
 * 効かないことを見る。
 */
test("handleAudioObject: 上限に負の値を指定したら無制限に保留する", () => {
  const { subscriber, errors } = createTestSubscriber({
    audio: {},
    pendingObjectQueue: { maxObjects: -1, maxBytes: -1 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl;
  control.audioInitialConfigPending = true;

  // 既定の件数上限 + 1 件を送る (負の件数上限が 0 件の上限として扱われないこと)
  const count = DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS.maxObjects + 1;
  for (let i = 0; i < count; i++) {
    control.handleAudioObject(makeIdentifiedObject(BigInt(i), 0x11));
  }
  assert.equal(control.pendingAudioObjects.length, count);
  assert.equal(control.pendingAudioQueueState.bytes, count);

  // 1 件で既定のバイト上限を超える payload も保留する (負のバイト上限が効かないこと)
  const oversize = 2 << 20;
  control.handleAudioObject(makeSizedObject(BigInt(count), 0x22, oversize));
  assert.equal(control.pendingAudioObjects.length, count + 1);
  assert.equal(control.pendingAudioQueueState.bytes, count + oversize);
  assert.deepEqual(errors, []);
});

/**
 * 上限超過の通知はキューごとに購読期間あたり 1 回だけである。購読をやり直したら、
 * 新しい購読期間の超過は改めて通知される (通知済みフラグを購読開始で解除する)。
 */
test("subscribeMediaTracks: 購読期間ごとに上限超過の通知を解除する", async () => {
  const { subscriber, errors } = createTestSubscriber({
    video: { codec: "vp8" },
    pendingObjectQueue: { maxObjects: 1 },
  });
  const control = subscriber as unknown as SubscriberInitialConfigControl & {
    session: {
      subscribe(
        namespace: string[],
        trackName: string,
        callbacks: { object: (obj: MoqtObject) => void },
      ): Promise<{ trackProperties: { id: bigint; data?: Uint8Array }[] }>;
    } | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  const decoded = installRecordingVideoDecoder(control);
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
  // 購読のたびに Group を進める (Group 先頭の Object 0 をキーフレームとして復号させる)
  let groupId = 1n;
  let marker = 0x10;
  control.session = {
    subscribe: async (_namespace, _trackName, callbacks) => {
      // 購読要求より前に保留が有効化されている
      assert.isTrue(control.videoInitialConfigPending);
      const currentGroupId = groupId;
      groupId++;
      const heldMarker = marker;
      marker++;
      const droppedMarker = marker;
      marker++;
      // 上限 1 件を超える 2 件を購読の確立中に届ける (2 件目は保持せず破棄する)
      callbacks.object({ ...makeIdentifiedObject(0n, heldMarker), groupId: currentGroupId });
      callbacks.object({ ...makeIdentifiedObject(1n, droppedMarker), groupId: currentGroupId });
      return { trackProperties: [] };
    },
  };

  await control.subscribeMediaTracks(control.sessionGeneration);
  // 1 回目の購読期間: 上限内の 1 件だけが復号され、超過の通知は 1 回
  assert.deepEqual(decoded, [0x10]);
  assert.equal(errors.length, 1);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(control.pendingVideoQueueState.bytes, 0);

  // 2 回目の購読期間 (購読のやり直し): 通知済みフラグが解除されるため改めて通知される
  await control.subscribeMediaTracks(control.sessionGeneration);
  assert.deepEqual(decoded, [0x10, 0x12]);
  assert.equal(errors.length, 2);
  assert.equal(control.pendingVideoObjects.length, 0);
});

/**
 * 上限超過の通知はキューごとに購読期間あたり 1 回だけであり、音声と映像は別々のキュー
 * として数える。1 回の購読で両方のキューが溢れたら、1 購読期間に最大 2 回 (キューごとに
 * 1 回) 通知される。音声と映像で共通の通知済みフラグを持つと 1 回で止まってしまうため、
 * キューごとのフラグであることをここで固定する。
 */
test("subscribeMediaTracks: 音声と映像の両方のキューが溢れたら onError は 2 回になる", async () => {
  const { subscriber, errors } = createTestSubscriber({
    audio: { codec: "opus" },
    video: { codec: "vp8" },
    // 音声と映像は同じ上限を持ち、どちらも 1 件で溢れさせる
    pendingObjectQueue: { maxObjects: 1 },
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
    videoTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48000,
    channelConfig: "2",
  });
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
  // 上限 1 件を超える 2 件を、音声の購読と映像の購読のそれぞれで届ける (2 件目を破棄させる)
  const arriveOverLimit = (callbacks: { object: (obj: MoqtObject) => void }): void => {
    callbacks.object(makeIdentifiedObject(0n, 0x11));
    callbacks.object(makeIdentifiedObject(1n, 0x22));
  };
  control.session = {
    subscribe: async (_namespace, trackName, callbacks) => {
      // 購読要求より前に、購読する media 側の保留が有効化されている
      const initialConfigPending =
        trackName === "audio"
          ? control.audioInitialConfigPending
          : control.videoInitialConfigPending;
      assert.isTrue(initialConfigPending);
      arriveOverLimit(callbacks);
      return { largestLocation: null, trackProperties: [] };
    },
  };

  await control.subscribeMediaTracks(control.sessionGeneration);

  // 通知は音声と映像で 1 回ずつになり、共通のフラグなら 1 回で止まる
  assert.equal(errors.length, 2);
  assert.match(errors[0]?.message ?? "", /audio pending object queue overflow/);
  assert.match(errors[1]?.message ?? "", /video pending object queue overflow/);
  // どちらのキューも上限内の 1 件だけを保持し、初期 configure の完了までに解放されて空になる
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(control.pendingAudioQueueState.bytes, 0);
  assert.equal(control.pendingVideoQueueState.bytes, 0);
});

/**
 * close() は保留分を破棄し、上限超過の通知済みフラグも解除する。破棄は解放
 * (disposeAllResources) が行い、購読の再開はそのあとの start() が新しい購読期間として行う。
 */
test("close: 保留キューと上限超過の通知済みフラグを破棄する", async () => {
  const { subscriber, errors } = createTestSubscriber({
    video: {},
    pendingObjectQueue: { maxObjects: 1 },
  });
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  injectLifecycleResources(control);
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {},
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  control.videoInitialConfigPending = true;
  // 上限 1 件を超える 2 件目で超過を通知させる
  control.handleVideoObject(makeIdentifiedObject(0n, 0x11));
  control.handleVideoObject(makeIdentifiedObject(1n, 0x22));
  assert.equal(control.pendingVideoObjects.length, 1);
  assert.equal(errors.length, 1);
  assert.isTrue(control.pendingVideoQueueState.overflowNotified);

  await subscriber.close();

  // 保留分と計数・通知済みフラグ・保留の有効化が破棄され、復号も統計も進まない
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(control.pendingVideoQueueState.bytes, 0);
  assert.isFalse(control.pendingVideoQueueState.overflowNotified);
  assert.isFalse(control.videoInitialConfigPending);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.equal(subscriber.state, "closed");
});

/**
 * 再構成は reject しない契約であり、同期 throw し得る codec / channels の解決も
 * onError に 1 回届ける。解決できない codec は setupDecoders が先に検査するため現行の
 * 値では到達しないが、`void` 呼び出し側に未処理の rejection を残さないための防御である。
 * cast で解決できない codec を注入して駆動する。
 */
test("handleAudioObject: 再構成の codec 解決が throw しても onError に 1 回届く", async () => {
  await withUnhandledRejectionWatch(async (unhandled) => {
    const { subscriber, errors } = createTestSubscriber({ audio: {} });
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
    const subscriber = createTestSubscriber(
      { audio: {} },
      {
        onError: (error) => {
          notified.push(error);
          throw notificationFailure;
        },
      },
    ).subscriber;
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
    const { subscriber, errors } = createTestSubscriber({ video: {} });
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
    const subscriber = createTestSubscriber(
      { video: {} },
      {
        onError: (error) => {
          notified.push(error);
          throw notificationFailure;
        },
      },
    ).subscriber;
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
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
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
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
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

/** 映像の保留を検証する購読を作り、復号に渡した Object の payload を記録する */
function createVideoGateSubscriber(): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberVideoGateControl;
  decoded: number[];
} {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
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
 * 完了条件: `preDecodeDelayMs` は 0 と上限を受け付け、負数・非有限数・上限超過は拒否する。
 * 0 のときは遅延の段を作らず、既存の経路をそのまま通す。
 */
test("MediaSubscriberImpl: preDecodeDelayMs の不正値を拒否する", async () => {
  // 0 は追加遅延なしとして受け付け、段を作らない
  const zero = createTestSubscriber({
    audio: {},
    preDecodeDelayMs: 0,
  }).subscriber;
  const zeroControl = zero as unknown as SubscriberPreDecodeDelayControl;
  assert.isNull(zeroControl.audioPreDecodeStage, "0 のときは音声の段を作らないこと");
  assert.isNull(zeroControl.videoPreDecodeStage, "0 のときは映像の段を作らないこと");
  await zero.close();

  // 上限は受け付ける
  const atLimit = createTestSubscriber({
    audio: {},
    preDecodeDelayMs: MAX_PRE_DECODE_DELAY_MS,
  }).subscriber;
  const atLimitControl = atLimit as unknown as SubscriberPreDecodeDelayControl;
  assert.isNotNull(atLimitControl.audioPreDecodeStage, "上限の指定では段を作ること");
  await atLimit.close();

  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_PRE_DECODE_DELAY_MS + 1]) {
    assert.throws(
      () =>
        createTestSubscriber({
          audio: {},
          preDecodeDelayMs: value,
        }).subscriber,
      /preDecodeDelayMs/,
      `不正な値 ${value} を拒否すること`,
    );
  }

  // 公開 API の生成経路でも reject する
  let factoryError: unknown;
  try {
    await createMediaSubscriber("moqt://example.com/live", {
      namespace: ["live"],
      audio: {},
      preDecodeDelayMs: -1,
    });
  } catch (error) {
    factoryError = error;
  }
  assert.ok(factoryError instanceof Error);
  assert.match(factoryError.message, /preDecodeDelayMs/);
});

/**
 * 完了条件: 音声 Object は `preDecodeDelayMs` の期限まで復号へ渡らず、期限後に到着順で
 * 復号される。復号の前後で遅延の段の件数も変わる。
 */
test("receiveAudioObject: preDecodeDelayMs の期限まで復号しない", async () => {
  const { subscriber, control, decodedAudio } = createPreDecodeDelaySubscriber(80);

  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");

  assert.deepEqual(decodedAudio, [], "期限前は復号しないこと");
  assert.equal(control.audioPreDecodeStage?.size, 1, "復号前の段に保持すること");
  // 期限 (80 ms) より十分短い間は復号されない。負荷でタイマーが遅れても誤判定しないよう
  // 期限の 1/4 以下で見る
  await sleep(20);
  assert.deepEqual(decodedAudio, [], "期限の途中でも復号しないこと");
  await sleep(300);
  assert.deepEqual(decodedAudio, [0x11], "期限後に復号すること");
  assert.equal(control.audioPreDecodeStage?.size, 0, "復号した分を段から除くこと");
  await subscriber.close();
});

/**
 * 完了条件: 復号前の遅延を挟んでも、入力の遅れ (Object の到着 - LOC TIMESTAMP) は
 * 到着時点の値で記録される。復号の出力は遅れるが、入力の遅れを遅延の分だけ大きくすると
 * 受信側の追いつきが復号器の詰まりと誤判定する。
 */
test("receiveAudioObject: 復号前の遅延を挟んでも入力の遅れを到着時点で測る", async () => {
  const { subscriber, control, decodedAudio } = createPreDecodeDelaySubscriber(40);
  const wallClockTimestamp = Math.round((performance.timeOrigin + performance.now() - 200) * 1_000);
  const object: MoqtObject = {
    ...makeIdentifiedObject(0n, 0x11),
    properties: LOC.encodeAudioProperties({ timestamp: BigInt(wallClockTimestamp) }),
  };

  control.receiveAudioObject(object, "datagram");

  assert.equal(playoutAudioInputMapOf(control.playout).size, 0, "期限前は復号へ渡さないこと");
  await sleep(300);
  assert.deepEqual(decodedAudio, [0x11]);
  // 復号へ渡した入力の記録 (TIMESTAMP の種類・入力の遅れ・実際に保持した時間) は
  // 再生の入口の 1 つの対応表が持つ
  const record = playoutAudioInputMapOf(control.playout).get(wallClockTimestamp);
  assert.equal(record?.timestampKind, "wallClock", "壁時計の TIMESTAMP として記録すること");
  assert.closeTo(record?.inputLagMs ?? 0, 200, 30, "到着時点の入力の遅れを記録すること");
  // 意図した遅延は設定値ではなく、実際に保持した時間を記録する
  assert.closeTo(
    record?.intentionalDelayMs ?? 0,
    40,
    30,
    "復号へ渡すまで実際に保持した時間を記録すること",
  );
  await subscriber.close();
});

/**
 * 完了条件: 映像 Object も `preDecodeDelayMs` の期限まで復号へ渡らない。
 */
test("receiveVideoObject: preDecodeDelayMs の期限まで復号しない", async () => {
  const { subscriber, control, decodedVideo } = createPreDecodeDelaySubscriber(80);

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));

  assert.deepEqual(decodedVideo, [], "期限前は復号しないこと");
  assert.equal(control.videoPreDecodeStage?.size, 1, "復号前の段に保持すること");
  await sleep(20);
  assert.deepEqual(decodedVideo, [], "期限の途中でも復号しないこと");
  await sleep(300);
  assert.deepEqual(decodedVideo, [0x10], "期限後に復号すること");
  assert.equal(control.videoPreDecodeStage?.size, 0);
  await subscriber.close();
});

/**
 * 完了条件: 映像の初期 configure (VIDEO_CONFIG) の完了までは保留キューに入れ、復号できる
 * 状態になってから復号前の段へ移す。音声と同じく、configure の待ち時間を遅延として
 * 二重に数えない。
 */
test("receiveVideoObject: 初期 configure の保留中は復号前の段へ積まない", async () => {
  const { subscriber, control, decodedVideo } = createPreDecodeDelaySubscriber(80);
  control.videoInitialConfigPending = true;

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));

  assert.equal(control.videoPreDecodeStage?.size ?? 0, 0, "復号前の段へ積まないこと");
  assert.equal(control.pendingVideoObjects.length, 1, "保留キューに積むこと");
  assert.deepEqual(decodedVideo, []);
  await subscriber.close();
});

/**
 * 完了条件: 復号前の遅延は Group の切り替えの順序を変えない。前の Group の Object が先に
 * 復号され、保留されていた次の Group の Object はその後に復号される。
 */
test("receiveVideoObject: 復号前の遅延は Group の順序を変えない", async () => {
  const { subscriber, control, decodedVideo } = createPreDecodeDelaySubscriber(40);

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(2n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(1n, 1n));
  assert.deepEqual(decodedVideo, [], "期限前はどれも復号しないこと");

  // 前の Group の stream を終わらせると、保留していた次の Group の Object もキューへ入る
  control.receiveVideoSubgroupEnd({ groupId: 1n, subgroupId: 0n, reason: "fin" });
  await sleep(300);

  assert.deepEqual(decodedVideo, [0x10, 0x11, 0x20], "Group の順序を保つこと");
  await subscriber.close();
});

/**
 * 完了条件: `close()` は音声の復号前の段を flush して復号へ流す (停止時に保持分まで
 * 鳴らし切るため)。映像は従来どおり破棄し、flush の後に期限が来ても追加で復号しない。
 */
test("close: 音声の復号前の段を flush してから破棄する", async () => {
  const { subscriber, control, decodedAudio, decodedVideo } = createPreDecodeDelaySubscriber(80);
  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");
  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  assert.equal(control.audioPreDecodeStage?.size, 1);
  assert.equal(control.videoPreDecodeStage?.size, 1);

  await subscriber.close();

  assert.equal(control.audioPreDecodeStage?.size, 0, "音声の段を破棄すること");
  assert.equal(control.videoPreDecodeStage?.size, 0, "映像の段を破棄すること");
  assert.deepEqual(decodedAudio, [0x11], "保持していた音声を復号へ流すこと");
  const decodedAudioCount = decodedAudio.length;
  await sleep(300);
  assert.equal(decodedAudio.length, decodedAudioCount, "flush の後に追加で復号しないこと");
  assert.deepEqual(decodedVideo, [], "映像は flush しないこと");
});

/**
 * 完了条件: `stop()` は音声の復号前の段を flush して復号へ流し、そのあと破棄する。
 * flush の後に期限が来ても追加で復号しない。
 */
test("stop: 音声の復号前の段を flush してから破棄する", async () => {
  const { subscriber, control, decodedAudio, decodedVideo } = createPreDecodeDelaySubscriber(80);
  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");
  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  control.currentState = "active";

  await subscriber.stop();

  assert.equal(control.audioPreDecodeStage?.size, 0, "音声の段を破棄すること");
  assert.equal(control.videoPreDecodeStage?.size, 0, "映像の段を破棄すること");
  assert.deepEqual(decodedAudio, [0x11], "保持していた音声を復号へ流すこと");
  const decodedAudioCount = decodedAudio.length;
  await sleep(300);
  assert.equal(decodedAudio.length, decodedAudioCount, "flush の後に追加で復号しないこと");
  assert.deepEqual(decodedVideo, [], "映像は flush しないこと");
});

/**
 * 完了条件: 音声の復号前の段の上限を超えたら古い Object を落とし、`onError` をメディアごとに
 * 1 回だけ通知する。上限の判定は上限を小さくした実物の段で固定する。
 */
test("receiveAudioObject: 復号前の段の上限超過を 1 回だけ通知する", async () => {
  const { subscriber, control, errors } = createPreDecodeDelaySubscriber(1_000);
  // 上限を小さくした段を差し替え、通知を購読の経路 (notifyPreDecodeOverflow) へ通す
  control.audioPreDecodeStage = new PreDecodeDelayStage<DelayedAudioItem>({
    delayMs: 1_000,
    maxObjects: 1,
    maxBytes: 1_024,
    bytesOf: (item) => item.object.payload.byteLength + (item.object.properties?.byteLength ?? 0),
    onDue: () => {},
    onOverflow: (overflow) => control.notifyPreDecodeOverflow("audio", overflow),
  });

  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");
  control.receiveAudioObject(makeIdentifiedObject(1n, 0x22), "subgroup");
  control.receiveAudioObject(makeIdentifiedObject(2n, 0x33), "subgroup");

  assert.equal(errors.length, 1, "上限超過の通知は 1 回だけであること");
  assert.match(errors[0]?.message ?? "", /audio pre-decode delay queue overflow/);
  assert.equal(control.audioPreDecodeStage.size, 1, "古い Object を落として新しい方を残すこと");
  await subscriber.close();
});

/**
 * 完了条件: 映像の復号前の段の上限を超えたときも、`onError` をメディアごとに 1 回だけ
 * 通知する。
 */
test("receiveVideoObject: 復号前の段の上限超過を 1 回だけ通知する", async () => {
  const { subscriber, control, errors } = createPreDecodeDelaySubscriber(1_000);
  control.videoPreDecodeStage = new PreDecodeDelayStage<MoqtObject>({
    delayMs: 1_000,
    maxObjects: 1,
    maxBytes: 1_024,
    bytesOf: (obj) => obj.payload.byteLength + (obj.properties?.byteLength ?? 0),
    onDue: () => {},
    onOverflow: (overflow) => control.notifyPreDecodeOverflow("video", overflow),
  });

  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  control.receiveVideoObject(makeStreamVideoObject(1n, 1n));
  control.receiveVideoObject(makeStreamVideoObject(1n, 2n));

  assert.equal(errors.length, 1, "上限超過の通知は 1 回だけであること");
  assert.match(errors[0]?.message ?? "", /video pre-decode delay queue overflow/);
  assert.equal(control.videoPreDecodeStage.size, 1, "古い Object を落として新しい方を残すこと");
  await subscriber.close();
});

/**
 * 完了条件: 復号器のエラー時は復号前の段を破棄し、古い入力を復号器へ渡さない。
 */
test("handleAudioDecoderError / handleVideoDecoderError: 復号前の段を破棄する", async () => {
  const { subscriber, control, errors } = createPreDecodeDelaySubscriber(80);
  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");
  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  assert.equal(control.audioPreDecodeStage?.size, 1);
  assert.equal(control.videoPreDecodeStage?.size, 1);
  // 復号器へ渡したまま出力が来なかった音の対応 (購読中に増え続ける分) を入れておく
  subscriberInternalsOf(subscriber).audioDecodeSubmitSequences.push(0, 1);

  control.handleAudioDecoderError(new Error("audio decoder failed"));
  control.handleVideoDecoderError(new Error("video decoder failed"));

  assert.equal(control.audioPreDecodeStage?.size, 0, "音声の段を破棄すること");
  assert.equal(control.videoPreDecodeStage?.size, 0, "映像の段を破棄すること");
  assert.equal(
    subscriberInternalsOf(subscriber).audioDecodeSubmitSequences.length,
    0,
    "復号器へ渡した音の投入順の対応を捨てること",
  );
  assert.equal(errors.length, 2, "失敗を onError へ通知すること");
  await subscriber.close();
});

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
  const { subscriber, errors } = createTestSubscriber({ video: {} });
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
  const { subscriber, errors } = createTestSubscriber({ video: {} });
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
    const { subscriber, errors } = createTestSubscriber({ video: {} });
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
  const subscriber = createTestSubscriber(
    { video: {} },
    {
      onError: (error) => {
        notified.push(error);
        throw notificationFailure;
      },
    },
  ).subscriber;
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
  const { subscriber, errors } = createTestSubscriber({});
  const control = subscriber as unknown as SubscriberFrameControl;
  const audioContext = {
    createBuffer: () => {
      throw new Error("createBuffer failed");
    },
  } as unknown as AudioContext;
  installAudioOutput(control, audioContext, {} as MediaStreamAudioDestinationNode);
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
  // 再生の入口が出力の有無を判定してフレームを閉じるため、onError 通知はなく、write も
  // 呼ばれない
  const { subscriber, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberFrameControl;
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 出力先不在時はフレームを閉じる", () => {
  // context 不在の既存正常系が維持されることの検証。
  // 再生の入口が `status: "skipped"` を返し、復号の出力は finally で閉じるため onError
  // 通知はない
  const { subscriber, errors } = createTestSubscriber({});
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
  const { subscriber, errors } = createTestSubscriber({ video: {} });
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

test("handleAudioDecodedData: 音声再生開始の失敗時も onError 通知し AudioData を閉じる", () => {
  // 変換全体 (createBuffer〜start) の裏付けとして start 失敗経路を検証する
  const { subscriber, errors } = createTestSubscriber({});
  const control = subscriber as unknown as SubscriberFrameControl;
  const audioContext = {
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
  installAudioOutput(control, audioContext, {} as MediaStreamAudioDestinationNode);
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
 * subscribe / fetch の登録が終わるまで microtask を進める
 *
 * 実時間の待機を使わず、タイマー発火に依存せずに登録完了を待つ。
 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
}

test("タイムアウト reject 後に遅延オブジェクトが届いても catalog は更新されない", async () => {
  // 失敗後の遅延 catalog が receivedCatalog 更新と onCatalog 発火を起こさないこと。
  // 10 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const { subscriber, catalogs } = createTestSubscriber({});
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchObject, calls } = createCatalogTestSession({});
  control.session = session;

  const thrown = await captureThrown(control.subscribeCatalog(control.sessionGeneration, 10));
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

test("FETCH の応答が終わらないまま期限に達しても live のフル catalog で resolve する", async () => {
  // FETCH が end も error も通知しないリレーでは、バッファした catalog が
  // 適用されないまま期限に達していた。期限では破棄せずドレインして resolve する。
  // 50 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const { subscriber, catalogs } = createTestSubscriber({});
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchObject, fetchEnd } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 50);
  await flushMicrotasks();

  // FETCH フェーズ中の live のフル catalog はバッファされる (この時点では未適用)
  liveObject({ ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) });
  assert.equal(control.pendingCatalogObjects.length, 1);
  assert.isNull(subscriber.catalog);

  await pending;
  assert.isNotNull(subscriber.catalog);
  // ドレインは catalog を適用するため onCatalog が 1 回発火する (変更前は破棄していた)
  assert.deepEqual(catalogs, [subscriber.catalog]);
  assert.isFalse(control.catalogFetchInProgress);
  assert.isFalse(control.catalogReceiveFailed);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogTimer);
  assert.isNull(control.catalogResolve);

  // フェーズが終わったあとの live の catalog 更新は適用され続ける
  const updatedCatalog = makeCatalog([{ name: "video", packaging: "loc", isLive: false }]);
  liveObject({ ...makeCatalogObject(1n, 0n), payload: encodeCatalog(updatedCatalog) });
  assert.deepEqual(subscriber.catalog, updatedCatalog);

  // フェーズ終了後に届いた FETCH のオブジェクトは適用しない。適用すると live で
  // 得た catalog が古い内容へ巻き戻る (適用済みの live は FETCH が運ぶ Location より新しい)
  const catalogAfterLiveUpdate = subscriber.catalog;
  fetchObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeCatalog([{ name: "video", packaging: "loc", isLive: true }])),
  });
  fetchEnd();
  assert.strictEqual(subscriber.catalog, catalogAfterLiveUpdate);
});

test("ドレイン中に onCatalog が throw したら onError へ通知して受信タイムアウトで失敗する", async () => {
  // ドレインは利用者コールバックを呼ぶため、その例外で catalog の待ちが未決着に
  // ならないこと (live 配送経路と同じく onError へ流し、開始は失敗させる)。
  // 50 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const catalogError = new Error("onCatalog failed");
  const { subscriber, errors } = createTestSubscriber(
    {},
    {
      onCatalog: () => {
        throw catalogError;
      },
    },
  );
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 50);
  await flushMicrotasks();
  liveObject({ ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) });

  const thrown = await captureThrown(pending);
  assert.deepEqual(errors, [catalogError]);
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /catalog receive timeout/);
  assert.isTrue(control.catalogReceiveFailed);
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
});

test("FETCH の応答が終わらないまま期限に達し live がフル catalog でなければ reject する", async () => {
  // バッファが delta だけ (適用の基準になるフルが無い) の場合は resolve しない。
  // ドレインの誤解決を防ぐガードであり、回帰ガードは上のフル catalog のテストが担う。
  // 50 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 50);
  await flushMicrotasks();
  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalogDelta({
      deltaUpdate: true,
      operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
    }),
  });

  const thrown = await captureThrown(pending);
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /catalog receive timeout/);
  assert.isNull(subscriber.catalog);
  assert.isTrue(control.catalogReceiveFailed);
  assert.isNull(control.catalogResolve);
});

test("session.subscribe throw 後に即時掃除されタイマー副作用がない", async () => {
  // throw 直後にフェーズ状態が掃除され、後続のタイマー発火で副作用がないこと
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberCatalogControl;
  const subscribeError = new Error("subscribe failed");
  const { session } = createCatalogTestSession({ subscribeError });
  control.session = session;

  const thrown = await captureThrown(control.subscribeCatalog(control.sessionGeneration, 10));
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
  const { subscriber, catalogs } = createTestSubscriber({});
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  await flushMicrotasks();
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

test("catalogFetchFilter: LARGEST_OBJECT が不明 / Group 0 でも絶対位置 {0, 0} を明示する", () => {
  // 2 フィールドの 0:0 (Location Filter Type 0x02) は絶対位置 {0, 0} の指定であり
  // (draft-ietf-moq-transport-22 §9.20.9)、フィルタ無しの要求範囲 {0, 0} から
  // Largest Object までと一致する。同じ範囲でもフィルタを省略した FETCH は
  // リレーから応答が返らないため、常に定義済みのフィルタを返す
  assert.deepEqual(catalogFetchFilter({ group: 0n, object: 5n }), {
    startGroup: 0n,
    startObject: 0n,
  });
  assert.deepEqual(catalogFetchFilter(null), { startGroup: 0n, startObject: 0n });
});

test("subscribeCatalog: LARGEST_OBJECT の Group を FETCH の開始位置にする", async () => {
  // 開始位置を最新 Group の先頭にすると、relay の object cache が覆える範囲
  // (cache が持つ最新 Group) と一致する。catalog track の Group ID は Unix epoch
  // ミリ秒から始まることが多く、{0, 0} 起点の要求は cache で覆えない
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, subscribeOptions, fetchOptions } =
    createCatalogTestSession({
      subscribeLargestLocation: { group: 7n, object: 3n },
    });
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  await flushMicrotasks();

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

test("subscribeCatalog: LARGEST_OBJECT が不明 / Group 0 でも絶対位置 {0, 0} のフィルタを載せる", async () => {
  // LOCATION FILTER を省略した FETCH はリレーから応答が返らない (実測) ため、
  // フィルタ無しと同じ範囲でも形式を明示する。Group 0 の catalog は {0, 0} 起点の
  // 要求になり省略しても同じ範囲だが、同じ理由で明示する
  const cases: { largest: Location | null }[] = [
    { largest: null },
    { largest: { group: 0n, object: 4n } },
  ];
  for (const testCase of cases) {
    const subscriber = createTestSubscriber({}).subscriber;
    const control = subscriber as unknown as SubscriberCatalogControl;
    const { session, fetchEnd, fetchObject, fetchOptions } = createCatalogTestSession(
      testCase.largest === null ? {} : { subscribeLargestLocation: testCase.largest },
    );
    control.session = session;

    const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
    await flushMicrotasks();

    assert.deepEqual(fetchOptions()?.filter, { startGroup: 0n, startObject: 0n });

    fetchObject({
      ...makeCatalogObject(0n, 4n),
      payload: encodeCatalog(makeVideoCatalog()),
    });
    fetchEnd();
    await pending;
  }
});

/**
 * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
 * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
 * catalog の authInfo (§5.2.42) は catalog を受信するまで分からないため、SETUP Option (0x03)
 * として送ったトークン (MOQT URI の msf fragment の c4m を含む) を catalog の
 * SUBSCRIBE と FETCH にも付与する。
 */
test("subscribeCatalog: SETUP に載せたトークンを SUBSCRIBE と FETCH に付与する", async () => {
  const subscriber = createTestSubscriber({}).subscriber;
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
  await flushMicrotasks();

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
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd, subscribeOptions, fetchOptions } =
    createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(control.sessionGeneration, 1000);
  await flushMicrotasks();

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
 * requestNewGroup の値検証用の制御口
 */
interface SubscriberNewGroupControl {
  currentState: MediaSubscriberState;
  videoSubscriber: Subscriber | null;
  requestNewGroup(): Promise<void>;
}

test("requestNewGroup は購読者が知る最大 Group ID + 1 を送信する", async () => {
  // 固定値でなく送信時点の値を参照することの検証。値は購読で受信した最大 Location
  // (largestReceivedLocation) と LARGEST_OBJECT (largestLocation) の大きい方から作る。
  // 送信間に値を書き換えて 2 回送り、snapshot でなく都度参照と分かるようにする
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberNewGroupControl;
  control.currentState = "active";
  const sent: (RequestUpdateOptions | undefined)[] = [];
  const videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    // LARGEST_OBJECT の方が進んでいる (購読直後の状態)
    largestLocation: { group: 41n, object: 3n },
    largestReceivedLocation: { group: 40n, object: 9n },
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent.push(args[0]);
    },
  };
  control.videoSubscriber = videoSubscriber as unknown as Subscriber;

  await control.requestNewGroup();
  // 受信した Object が LARGEST_OBJECT を追い越したら、受信した値を使う
  videoSubscriber.largestReceivedLocation = { group: 100n, object: 0n };
  await control.requestNewGroup();

  assert.equal(sent[0]?.newGroupRequest, 42n, "LARGEST_OBJECT の次の Group");
  assert.equal(sent[1]?.newGroupRequest, 101n, "受信した最大 Location の次の Group");
});

test("requestNewGroup は情報なし時は 0 を送信する", async () => {
  const subscriber = createTestSubscriber({}).subscriber;
  const control = subscriber as unknown as SubscriberNewGroupControl;
  control.currentState = "active";
  let sent: RequestUpdateOptions | undefined;
  control.videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    largestLocation: null,
    largestReceivedLocation: null,
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent = args[0];
    },
  } as unknown as Subscriber;

  await control.requestNewGroup();

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
  const { subscriber, errors } = createTestSubscriber({
    audio: { trackName: "audio" },
    video: { trackName: "video" },
  });
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: role 省略カタログでデフォルト名のトラックが特定される", () => {
  // trackName 省略時はデフォルト名で探すことの検証
  const { subscriber, errors } = createTestSubscriber({ audio: {}, video: {} });
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: 未解決時は onError が呼ばれ他方メディアは継続する", () => {
  // 名前不一致で null のまま残り、throw せず通知することの検証
  const { subscriber, errors } = createTestSubscriber({
    audio: { trackName: "missing-audio" },
    video: { trackName: "video" },
  });
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
  const { subscriber, errors } = createTestSubscriber({ audio: { trackName: "missing" } });
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeCatalog([
    { name: "audio", packaging: "loc", isLive: true, role: "audio" },
  ]);

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.equal(errors.length, 0);
});
