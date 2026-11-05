/**
 * session/bidi.ts の単体テスト: bidiReadTrackStatusResponse の malformed 検出
 *
 * TRACK_STATUS_OK の未知 Mandatory Track Property に対する
 * cross-cancel と FIN の挙動を検証する。
 * 実 W3C ストリーム (ReadableStream / WritableStream) と実 Map、実
 * ControlStreamReader / ControlStreamWriter を使い、セッションは
 * src/testSupport/bidi.ts の createOkResponseReadTestContext が組む実 SessionImpl である。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeRequestOkPayload } from "../message/session";
import { MessageParameterType, MessageType } from "../message/types";
import { decodeVarint, encodeVarint } from "../varint";
import { TrackPropertyId } from "../properties";
import type { TrackStatusResult } from "./publicTypes";
import { MalformedTrackError } from "../error";
import { bidiReadTrackStatusResponse } from "./bidi";
import { FetcherImpl } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";
import { createOkResponseReadTestContext } from "../testSupport/bidi";

/**
 * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK) / §9.19.16 (EXPIRES Parameter):
 * TRACK_STATUS_OK で EXPIRES と LARGEST_OBJECT が受理され、公開 API の
 * TrackStatusResult.parameters にそのまま載ることを検証する。
 * EXPIRES は同じ Track の SUBSCRIBE_OK に入る値であり、TRACK_STATUS 自体の
 * 存続期限ではない。0 は期限無し / 期限不明、正値は advisory な終了時期である。
 */
test("bidiReadTrackStatusResponse: TRACK_STATUS_OK の EXPIRES と LARGEST_OBJECT を受理する", async () => {
  for (const expires of [0n, 5000n]) {
    const ctx = createOkResponseReadTestContext();
    const resolved: TrackStatusResult[] = [];
    let rejected: Error | undefined;
    ctx.session.pendingTrackStatus.set(ctx.requestId, {
      trackKey: fullTrackNameKey(["test"], "track"),
      resolve: (result) => {
        resolved.push(result);
      },
      reject: (error: Error) => {
        rejected = error;
      },
    });

    const readPromise = bidiReadTrackStatusResponse(
      ctx.session,
      ctx.requestId,
      ctx.stream,
      ctx.controlReader,
    );
    const okPayload = encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [
        { type: MessageParameterType.EXPIRES, value: encodeVarint(expires) },
        // LARGEST_OBJECT は Location (Group 0, Object 0)
        { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x00, 0x00]) },
      ],
      trackProperties: [],
    });
    ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
    ctx.readableController.close();
    await readPromise;

    // スコープ違反で拒否されず、両パラメータが公開 API に載る
    assert.isUndefined(rejected);
    assert.isUndefined(ctx.getClosedWithError());
    assert.equal(resolved.length, 1);
    const parameters = resolved[0]?.parameters ?? [];
    const expiresParam = parameters.find(
      (parameter) => parameter.type === MessageParameterType.EXPIRES,
    );
    assert.isDefined(expiresParam);
    assert.equal(decodeVarint(expiresParam!.value, 0)[0], expires);
    assert.isDefined(
      parameters.find((parameter) => parameter.type === MessageParameterType.LARGEST_OBJECT),
    );
    assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  }
});

/**
 * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK) / §9.12 (TRACK_STATUS):
 * TRACK_STATUS_OK は SUBSCRIBE_OK と同じ Track Properties を運ぶ。INCLUDE_PROPERTIES で
 * 要求した Track Properties がデコードされ、公開 API の TrackStatusResult.trackProperties
 * にそのまま載ることを検証する。
 */
test("bidiReadTrackStatusResponse: TRACK_STATUS_OK の Track Properties を公開 API に載せる", async () => {
  const ctx = createOkResponseReadTestContext();
  const resolved: TrackStatusResult[] = [];
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: (result) => {
      resolved.push(result);
    },
    reject: (error: Error) => {
      rejected = error;
    },
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // INCLUDE_PROPERTIES を要求した応答として Track Properties を 2 件載せる
  const trackProperties = [
    { id: TrackPropertyId.MAX_CACHE_DURATION, value: 30000n },
    { id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, value: 128n },
  ];
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 応答は拒否されず、Track Properties が公開 API の値として利用者へ渡る
  assert.isUndefined(rejected);
  assert.isUndefined(ctx.getClosedWithError());
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0]?.trackProperties, trackProperties);
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
});

// ============================================================================
// bidiReadTrackStatusResponse の malformed 検出 (未知 Mandatory Track Property)
// draft-ietf-moq-transport-23 §9.12 (TRACK_STATUS) / §12.1 (Malformed Tracks)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.12 / §12.1 / §2.4.1:
 * TRACK_STATUS_OK の malformed 検出による cross-cancel も Full Track Name の比較
 * キーで対象を決める。namespace ["a"] + trackName "b/c" と namespace ["a","b"] +
 * trackName "c" は "/" 連結では同じ "a/b/c" になるため、区切り文字の曖昧さで
 * 無関係な Track を巻き込む退行が起き得る。対象 Track だけが cancel されることを
 * 固定する。
 */
test("bidiReadTrackStatusResponse: 区切り文字が衝突する別 Track を cross-cancel しない", async () => {
  const ctx = createOkResponseReadTestContext();
  const targetSubscriber = new SubscriberImpl(["a", "b"], "c", 20n, 7n, () => {});
  const collidingSubscriber = new SubscriberImpl(["a"], "b/c", 21n, 8n, () => {});
  const targetFetcher = new FetcherImpl(["a", "b"], "c", 30n, () => {});
  const collidingFetcher = new FetcherImpl(["a"], "b/c", 31n, () => {});
  ctx.session.subscribersByAlias.set(7n, [targetSubscriber]);
  ctx.session.subscribersByAlias.set(8n, [collidingSubscriber]);
  ctx.session.fetchers.set(30n, targetFetcher);
  ctx.session.fetchers.set(31n, collidingFetcher);
  // FETCH の cancel 到達を観測する (対象だけが cancel される)
  const cancelledFetchers: string[] = [];
  targetFetcher.onCancel = async () => {
    cancelledFetchers.push("target");
  };
  collidingFetcher.onCancel = async () => {
    cancelledFetchers.push("colliding");
  };

  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    trackKey: fullTrackNameKey(["a", "b"], "c"),
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を含む TRACK_STATUS_OK
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  ctx.readableController.close();
  await readPromise;
  // cross-cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.instanceOf(rejected, MalformedTrackError);
  // 対象 Track だけが cancel され、衝突する別 Track は活性のまま
  assert.equal(targetSubscriber.state, "closed");
  assert.equal(targetFetcher.state, "closed");
  assert.deepEqual(cancelledFetchers, ["target"]);
  assert.equal(collidingSubscriber.state, "active");
  assert.equal(collidingFetcher.state, "active");
  assert.equal(ctx.session.subscribersByAlias.get(8n)?.length, 1);
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-23 §9.12 / §12.1:
 * TRACK_STATUS_OK は SUBSCRIBE_OK と同じ Track Properties を運ぶため、未知 Mandatory
 * Track Property (0x4000-0x7FFF) の受信は malformed Track の検出に当たる。pending を
 * reject して自方向を FIN し、同一 Full Track Name の購読 / FETCH を cross-cancel する。
 * 別 Track は cancel せず、セッションも閉じない。
 */
test("bidiReadTrackStatusResponse: 未知 Mandatory Track Property で FIN と cross-cancel を行う", async () => {
  const ctx = createOkResponseReadTestContext();
  const targetSubscriber = new SubscriberImpl(["live"], "video", 20n, 7n, () => {});
  const otherSubscriber = new SubscriberImpl(["live"], "other", 21n, 8n, () => {});
  const targetFetcher = new FetcherImpl(["live"], "video", 30n, () => {});
  const otherFetcher = new FetcherImpl(["live"], "other", 31n, () => {});
  ctx.session.subscribersByAlias.set(7n, [targetSubscriber]);
  ctx.session.subscribersByAlias.set(8n, [otherSubscriber]);
  ctx.session.fetchers.set(30n, targetFetcher);
  ctx.session.fetchers.set(31n, otherFetcher);
  // FETCH は onCancel 経由でストリームの cancel に到達することを観測する
  const cancelledFetchers: string[] = [];
  targetFetcher.onCancel = async () => {
    cancelledFetchers.push("target");
  };
  otherFetcher.onCancel = async () => {
    cancelledFetchers.push("other");
  };

  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    trackKey: fullTrackNameKey(["live"], "video"),
  });
  const writer = ctx.session.requestStreams.get(ctx.requestId)?.writer;

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を含む TRACK_STATUS_OK
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  ctx.readableController.close();
  await readPromise;
  // cross-cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // pending は malformed エラーで reject され、セッションは閉じない
  assert.instanceOf(rejected, MalformedTrackError);
  assert.isUndefined(ctx.getClosedWithError());
  // 自方向は FIN され、requestStreams / pendingTrackStatus から削除される
  assert.isDefined(writer);
  await writer!.closed;
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  // 同一 Track の購読 / FETCH だけが cancel される
  assert.equal(targetSubscriber.state, "closed");
  assert.equal(targetFetcher.state, "closed");
  assert.deepEqual(cancelledFetchers, ["target"]);
  assert.equal(otherSubscriber.state, "active");
  assert.equal(otherFetcher.state, "active");
});
