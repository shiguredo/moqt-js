/**
 * session/bidi.ts の単体テスト: bidiReadTrackStatusResponse の malformed 検出
 *
 * TRACK_STATUS_OK の未知 Mandatory Track Property に対する
 * cross-cancel と FIN の挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeRequestOkPayload } from "../message/session";
import { MessageType } from "../message/types";
import { MalformedTrackError } from "../error";
import { bidiReadTrackStatusResponse } from "./bidi";
import { FetcherImpl } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";
import { createOkResponseReadTestContext } from "../testSupport/bidi";

// ============================================================================
// bidiReadTrackStatusResponse の malformed 検出 (未知 Mandatory Track Property)
// draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS) / §12.1 (Malformed Tracks)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.13 / §12.1 / §2.4.1:
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
 * draft-ietf-moq-transport-21 §9.13 / §12.1:
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
