/**
 * session/bidi.ts の単体テスト: Location Filter による省略 Object の記録
 *
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream.  This includes, but is not limited to:
 *  ... Omitting a Subgroup Object due to the subscriber's Forward State"
 * REQUEST_UPDATE (購読者からの範囲変更) と PUBLISH_STATE_NOTIFY (アプリ起点の範囲変更)
 * で Location Filter を狭めたときに、送信中の Subgroup の次の Object が範囲外になるなら、
 * アプリがその Object を送らなくても省略として記録され、その Subgroup は FIN ではなく
 * RESET で閉じることを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "../message/types";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { encodeLocationFilterParameter, type LocationFilter } from "../message/parameter";
import { ControlStreamReader } from "../controlStream";
import { concatUint8Arrays } from "../testSupport/helpers";
import { createPublishReadTestContext, waitForMacrotask } from "../testSupport/bidi";
import { objectMatchesFilter } from "../filter";
import { bidiReadRequestStreamMessages } from "./bidi";
import { publishCloseSubgroupStream } from "./publish";

/**
 * publish ロールの REQUEST_UPDATE を read loop 経由で処理し、読み取りを終える
 *
 * REQUEST_UPDATE 自身の Request ID (101n) は更新ごとに新規 ID を消費するため任意でよく、
 * 対象の購読はストリーム (ctx.requestId) で特定される (draft-ietf-moq-transport-21 §6.4.2.1)。
 */
async function drivePublishRequestUpdate(
  ctx: ReturnType<typeof createPublishReadTestContext>,
  filter: LocationFilter,
): Promise<void> {
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeLocationFilterParameter(filter)],
  });
  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload),
  );
  await waitForMacrotask();
  ctx.readableController.close();
  await readPromise;
}

/**
 * REQUEST_UPDATE で End Group を狭めると、送信中の Subgroup の次の Object が
 * 範囲外になり、アプリの送信を待たずに省略として記録される。
 */
test("bidiReadRequestStreamMessages: 範囲を狭めた REQUEST_UPDATE で Subgroup の次の Object が省略として記録される", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  // Group 0 の Object 0 を送って Subgroup を開く (次に送る Object は 1)
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);

  // End Group を (0, 0) に狭める (次の Object (0, 1) が範囲外になる)
  await drivePublishRequestUpdate(ctx, {
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });

  // REQUEST_OK が応答され、省略として記録される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);

  // 閉じると RESET になる (省略を記録しない場合は FIN になる)
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
  assert.equal(ctx.subgroupStreams.length, 1);
  assert.equal(ctx.subgroupStreams[0].abortCount, 1);
  assert.equal(ctx.subgroupStreams[0].closeCount, 0);
  assert.equal(ctx.subgroupStreams[0].abortReasons[0], "subgroup omitted objects");
});

/**
 * draft-ietf-moq-transport-21 §11.3.2:
 * REQUEST_UPDATE で範囲を狭めた後、アプリが範囲外の Object を送ろうとした場合は
 * sendObject の見送りで省略が記録され、その Subgroup は RESET で閉じる
 * (更新時点では次の Object が範囲内だったため、更新時の記録は発生しない)。
 */
test("bidiReadRequestStreamMessages: 範囲を狭めた後の送信見送りでも省略として記録される", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  // End Object 1 に狭める (次の Object (0, 1) は範囲内なので更新時には記録されない)
  await drivePublishRequestUpdate(ctx, {
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 1n,
  });
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);

  // 範囲内の (0, 1) を送り、範囲外の (0, 2) は送らない (見送りとして記録される)
  await ctx.publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  await ctx.publisher.sendObject({ groupId: 0, objectId: 2, payload: new Uint8Array([3]) });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
});

/**
 * 範囲を狭めても次の Object が範囲内なら省略として記録されず、FIN で閉じられる。
 */
test("bidiReadRequestStreamMessages: 次の Object が範囲内なら省略として記録されない", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  // End Group を (1, 0) にする (次の Object (0, 1) は範囲内)
  await drivePublishRequestUpdate(ctx, {
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 1n,
    endObject: 0n,
  });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "fin");
  assert.equal(ctx.subgroupStreams[0].closeCount, 1);
  assert.equal(ctx.subgroupStreams[0].abortCount, 0);
});

/**
 * 送信中の Subgroup が無い場合は記録対象が無い (購読前の状態変更で落ちない)。
 */
test("bidiReadRequestStreamMessages: 送信中の Subgroup が無ければ省略は記録されない", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();

  await drivePublishRequestUpdate(ctx, {
    startGroup: 1n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });

  assert.isUndefined(ctx.session.publisherStreams.get(trackAlias));
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "fin");
});

/**
 * 判定には送信中の Subgroup の次の Object を使い、`getLargestLocation()` は
 * 使わない。Largest Location は datagram でも進むため、範囲内の Object が
 * Subgroup に残っているのに RESET にしてしまう。
 */
test("bidiReadRequestStreamMessages: datagram で Largest Location が進んでも Subgroup の次の Object で判定する", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  // datagram は Subgroup を持たないが Largest Location を進める
  ctx.publisher.sendDatagram({ groupId: 0, objectId: 5, payload: new Uint8Array([2]) });
  assert.equal(ctx.publisher.getLargestLocation()?.object, 5n);

  // Subgroup の次の Object は (0, 1) であり範囲内 (datagram の (0, 5) とは無関係)
  await drivePublishRequestUpdate(ctx, {
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 2n,
  });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "fin");
});

/**
 * アプリ起点の PUBLISH_STATE_NOTIFY でも同じく、範囲を狭めた時点で
 * 送信中の Subgroup の次の Object が範囲外になるなら省略として記録される。
 */
test("bidiSendPublishStateNotify: 範囲を狭めると送信中の Subgroup の次の Object が省略として記録される", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);

  await ctx.publisher.notifyStateChange({
    filter: { startGroup: 0n, startObject: 0n, endGroupDelta: 0n, endObject: 0n },
  });

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.PUBLISH_STATE_NOTIFY);
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
});

/**
 * 範囲を狭めて省略が記録された後に広げても、記録は取り消されない
 * (`omittedObjects` は boolean であり、Subgroup は RESET のまま閉じる)。
 */
test("bidiSendPublishStateNotify: 省略の記録は範囲を広げても取り消されない", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  // End Object 0 に狭めると次の Object (0, 1) が範囲外になり記録される
  await ctx.publisher.notifyStateChange({
    filter: { startGroup: 0n, startObject: 0n, endGroupDelta: 0n, endObject: 0n },
  });
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);

  // 広げても記録は残る (RESET で閉じる)
  await ctx.publisher.notifyStateChange({
    filter: { startGroup: 0n, startObject: 0n, endGroupDelta: 2n, endObject: 0n },
  });
  // フィルタが実際に広がっている (次の Object (0, 1) が範囲内に戻っている)
  assert.isTrue(
    objectMatchesFilter({ group: 0n, object: 1n }, ctx.publisher.getResolvedLocationFilter()),
  );
  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
});

/**
 * 範囲を狭めても次の Object が範囲内のままなら記録されず、FIN で閉じられる。
 */
test("bidiSendPublishStateNotify: 次の Object が範囲内なら省略として記録されない", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  await ctx.publisher.notifyStateChange({
    filter: { startGroup: 0n, startObject: 0n, endGroupDelta: 0n, endObject: 2n },
  });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "fin");
});

/**
 * draft-ietf-moq-transport-21 §11.3.2 の RESET の例:
 * Start Location を大きい Location へ動かす REQUEST_UPDATE では、次の Object が
 * Start Location より前になり、省略として記録される。
 */
test("bidiReadRequestStreamMessages: Start Location を進めると Subgroup の次の Object が省略として記録される", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  // Start Location を (0, 5) に進める (次の Object (0, 1) は開始位置より前)
  await drivePublishRequestUpdate(ctx, { startGroup: 0n, startObject: 5n });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
});

/**
 * draft-ietf-moq-transport-21 §11.3.2 の RESET の例:
 * End Group を送信中の Subgroup より小さい Group へ動かす REQUEST_UPDATE では、
 * 次の Object が End Group を超え、省略として記録される。
 */
test("bidiReadRequestStreamMessages: End Group を送信中の Group より小さくすると省略として記録される", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array([1]) });

  // End Group を 0 にする (送信中の Group 5 の次の Object (5, 1) が範囲外)
  await drivePublishRequestUpdate(ctx, { startGroup: 0n, startObject: 0n, endGroupDelta: 0n });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, true);
  assert.equal(await publishCloseSubgroupStream(ctx.session, trackAlias), "reset");
});

/**
 * 最初の Object の write 中は `previousObjectId` が -1 のため、次の Object を
 * 特定できない。この間は省略として記録しない (範囲内の Object しか送らない Subgroup を
 * 誤って RESET にしない)。
 */
test("bidiReadRequestStreamMessages: 最初の Object の write 中は省略として記録しない", async () => {
  const ctx = createPublishReadTestContext({});
  const trackAlias = ctx.publisher.getTrackAlias();
  // write 中の状態 (previousObjectId = -1) を実ストリームで作る
  const stream = await ctx.session.transport.createUnidirectionalStream();
  ctx.session.publisherStreams.set(trackAlias, {
    groupId: 7n,
    writer: stream.getWriter(),
    previousObjectId: -1n,
    omittedObjects: false,
  });

  // 次の Object を 0 と誤認すると範囲外になるフィルタ (Start Location を (7, 5) にする)
  await drivePublishRequestUpdate(ctx, { startGroup: 7n, startObject: 5n });

  assert.equal(ctx.session.publisherStreams.get(trackAlias)?.omittedObjects, false);
});
