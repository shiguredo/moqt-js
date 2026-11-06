/**
 * session/bidi.ts の単体テスト: FETCH の成功応答 (REQUEST_OK) の処理
 *
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.3 (REQUEST_OK) / Appendix A.1:
 * FETCH の成功応答は REQUEST_OK に統合され、旧 FETCH_OK の End Of Track /
 * End Location は削除された。応答がカバーする範囲の終端は、要求範囲と応答の
 * LARGEST_OBJECT から応答受理時に確定する。
 * 実 W3C ストリーム (ReadableStream / WritableStream) と実 Map、実
 * ControlStreamReader / ControlStreamWriter を使い、セッションは
 * src/testSupport/bidi.ts の createOkResponseReadTestContext が組む実 SessionImpl である。
 */

import { test, assert } from "vite-plus/test";
import { FetcherImpl } from "../fetcher";
import { MessageParameterType, MessageType } from "../message/types";
import type { Location } from "../message/types";
import { encodeLocation, encodeRequestOkPayload, type LocationFilter } from "../message";
import { encodeSubscribeOkPayload } from "../message/subscribe";
import { MAX_VARINT, encodeVarint } from "../varint";
import { createObject } from "../testSupport/helpers";
import { createOkResponseReadTestContext } from "../testSupport/bidi";
import { bidiReadFetchResponse } from "./bidi";
import { SessionError, SessionErrorCode } from "../error";
import { resolveFetchRequestRange } from "./params";

/**
 * FETCH の成功応答を検証するためのコンテキスト
 *
 * pendingFetch に Fetcher を登録し、要求範囲を実際の送信経路と同じ
 * resolveFetchRequestRange で確定してから、1 通の応答を読ませる。
 */
interface FetchResponseTestContext {
  fetcher: FetcherImpl;
  rejected: () => Error | undefined;
  closedWithError: () => Error | undefined;
  session: ReturnType<typeof createOkResponseReadTestContext>["session"];
  requestId: bigint;
  /** 読み取りの完了を待つ Promise */
  read: Promise<void>;
  /** 任意の型とペイロードを応答として流す */
  feed: (type: number, payload: Uint8Array) => void;
  /** ピアの FIN を送る */
  close: () => void;
}

/**
 * Fetcher と pendingFetch を登録し、読み取りを開始したコンテキストを構築する
 *
 * @param filter - FETCH の Location Filter。省略時はフィルタなし
 *   ({0, 0} から Largest Object まで) の要求として扱う
 */
function createFetchResponseTestContext(filter?: LocationFilter): FetchResponseTestContext {
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  // 送信経路 (src/session/requests.ts) と同じ純粋関数で要求範囲を確定する
  const requestRange = resolveFetchRequestRange(filter);
  fetcher.setFetchRequestRange(requestRange);

  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: fetcher,
  });

  const read = bidiReadFetchResponse(ctx.session, ctx.requestId, ctx.stream, ctx.controlReader);
  return {
    fetcher,
    rejected: () => rejected,
    closedWithError: () => ctx.getClosedWithError(),
    session: ctx.session,
    requestId: ctx.requestId,
    read,
    feed: (type, payload) => {
      ctx.readableController.enqueue(ctx.controlWriter.encode(type, payload));
    },
    close: () => {
      ctx.readableController.close();
    },
  };
}

/**
 * 成功応答 (REQUEST_OK) を流して読み取りを完了させる
 */
async function acceptFetchOk(
  context: FetchResponseTestContext,
  parameters: { type: number; value: Uint8Array }[],
  trackProperties: { id: bigint; value?: bigint }[] = [],
): Promise<void> {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters,
    trackProperties,
  });
  context.feed(MessageType.REQUEST_OK, payload);
  context.close();
  await context.read;
}

/**
 * LARGEST_OBJECT パラメータを組み立てる
 *
 * draft-ietf-moq-transport-23 §9.19.17: LARGEST_OBJECT の値は Location。
 */
function largestObjectParameter(location: Location): { type: number; value: Uint8Array } {
  return {
    type: MessageParameterType.LARGEST_OBJECT,
    value: encodeLocation(location),
  };
}

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.3 (REQUEST_OK):
 * 成功応答の EXPIRES / LARGEST_OBJECT と Track Properties を受け取り、Fetcher を
 * 解決する。要求範囲はフィルタなし ({0, 0} から Largest Object まで) であり、
 * 応答の LARGEST_OBJECT がそのまま endLocation になる。
 */
test("bidiReadFetchResponse: REQUEST_OK で EXPIRES / LARGEST_OBJECT / Track Properties を受理する", async () => {
  const context = createFetchResponseTestContext();

  await acceptFetchOk(
    context,
    [
      { type: MessageParameterType.EXPIRES, value: encodeVarint(60n) },
      largestObjectParameter({ group: 5n, object: 2n }),
    ],
    [{ id: 0x02n, value: 5000n }],
  );

  assert.isUndefined(context.rejected());
  assert.isUndefined(context.closedWithError());
  // 応答受理で fetchers に登録され、pendingFetch は掃除される
  assert.isTrue(context.session.fetchers.has(context.requestId));
  assert.isFalse(context.session.pendingFetch.has(context.requestId));
  // 開端の要求では LARGEST_OBJECT が要求 End そのものであり、終端になる
  assert.deepEqual(context.fetcher.endLocation, { group: 5n, object: 2n });
  // 応答は旧 FETCH_OK の End Of Track を運ばないため、Track 終端は未確認のまま
  assert.isFalse(context.fetcher.endOfTrack);
  assert.equal(context.fetcher.trackProperties.length, 1);
  assert.equal(context.fetcher.trackProperties[0].id, 0x02n);
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "If Largest Object is within the requested range, the FETCH response ends at
 *  Largest Object."
 * 0x04 (Absolute Range) の要求範囲内に LARGEST_OBJECT がある場合はその位置で終わる。
 */
test("bidiReadFetchResponse: 要求範囲内の LARGEST_OBJECT で終端が確定する", async () => {
  const context = createFetchResponseTestContext({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 3n,
    endObject: 4n,
  });

  await acceptFetchOk(context, [largestObjectParameter({ group: 3n, object: 1n })]);

  assert.isUndefined(context.rejected());
  assert.deepEqual(context.fetcher.endLocation, { group: 3n, object: 1n });
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "Otherwise, the response ends at the requested End Location."
 * 0x04 の要求 End より後ろに LARGEST_OBJECT がある場合は要求 End で終わる。
 */
test("bidiReadFetchResponse: 要求範囲外の LARGEST_OBJECT では要求 End で終端が確定する", async () => {
  const context = createFetchResponseTestContext({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 3n,
    endObject: 4n,
  });

  await acceptFetchOk(context, [largestObjectParameter({ group: 6n, object: 0n })]);

  assert.isUndefined(context.rejected());
  assert.deepEqual(context.fetcher.endLocation, { group: 5n, object: 4n });
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * End Location は inclusive である。1 Object だけの範囲 (Start == End) は
 * LARGEST_OBJECT が同じ位置ならその位置で終わる。
 */
test("bidiReadFetchResponse: 1 Object の範囲は Start == End == LARGEST_OBJECT になる", async () => {
  const context = createFetchResponseTestContext({
    startGroup: 5n,
    startObject: 3n,
    endGroupDelta: 0n,
    endObject: 3n,
  });

  await acceptFetchOk(context, [largestObjectParameter({ group: 5n, object: 3n })]);

  assert.isUndefined(context.rejected());
  assert.deepEqual(context.fetcher.endLocation, { group: 5n, object: 3n });
});

/**
 * draft-ietf-moq-transport-23 §3.2 / §9.19.9 (Table 6):
 * 0x03 (Absolute Start, Group End) で LARGEST_OBJECT による終端が得られない場合、
 * endLocation は {StartGroup + EndGroupDelta, 2^64-1} に正規化される。この
 * Object ID は Group 全体を含む境界値であり、実在する最後の Object ID ではない。
 * 後続データの実 Object が届いても endLocation を書き換えない。
 */
test("bidiReadFetchResponse: 0x03 で LARGEST_OBJECT 省略時に Group 上限へ正規化する", async () => {
  const context = createFetchResponseTestContext({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 2n,
  });

  await acceptFetchOk(context, []);

  assert.isUndefined(context.rejected());
  assert.deepEqual(context.fetcher.endLocation, { group: 4n, object: MAX_VARINT });

  // 実 Object が届いても境界値を実在の最後の Object ID として書き換えない
  context.fetcher.handleObject(createObject(4n, 7n));
  assert.deepEqual(context.fetcher.endLocation, { group: 4n, object: MAX_VARINT });
});

/**
 * draft-ietf-moq-transport-23 §3.1.4 (Largest Object) / §3.2 (Fetch):
 * Largest Object は到着中の Object を指し得る。応答受理時に確定した endLocation を
 * 後続データの最後の実 Object に合わせて書き換えない (書き換えると配送済みの
 * Object を取りこぼす)。
 */
test("bidiReadFetchResponse: 到着中の LARGEST_OBJECT でも endLocation を書き換えない", async () => {
  const context = createFetchResponseTestContext();

  await acceptFetchOk(context, [largestObjectParameter({ group: 5n, object: 2n })]);
  assert.deepEqual(context.fetcher.endLocation, { group: 5n, object: 2n });

  // LARGEST_OBJECT が指していた Object が届いても終端は変わらない
  context.fetcher.handleObject(createObject(5n, 2n));
  assert.deepEqual(context.fetcher.endLocation, { group: 5n, object: 2n });
});

/**
 * draft-ietf-moq-transport-23 §9:
 * 未知のメッセージ型はセッションを閉じるが、既知のメッセージ型が別の要求の
 * 応答として届いた場合はリクエスト単位の失敗として扱う (§6.6 の裁量)。
 */
test("bidiReadFetchResponse: 既知の別メッセージ型はリクエスト単位で失敗する", async () => {
  const context = createFetchResponseTestContext();

  const payload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  context.feed(MessageType.SUBSCRIBE_OK, payload);
  context.close();
  await context.read;

  assert.isDefined(context.rejected());
  assert.isTrue(context.rejected()!.message.includes("unexpected response type"));
  // 既知の型はセッションを閉じない
  assert.isUndefined(context.closedWithError());
  assert.isFalse(context.session.pendingFetch.has(context.requestId));
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "If no Objects have been published for the track or Start Location is
 *  greater than the Largest Object ... the publisher MUST return FETCH_ERROR
 *  with error code INVALID_RANGE."
 * 閉端の要求でも、LARGEST_OBJECT が要求 Start より前の成功応答は受理せず、
 * INVALID_FIELD でセッションを閉じる。
 */
test("bidiReadFetchResponse: 閉端の要求で LARGEST_OBJECT が Start より前なら INVALID_FIELD でセッションを閉じる", async () => {
  const context = createFetchResponseTestContext({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 4n,
  });

  await acceptFetchOk(context, [largestObjectParameter({ group: 1n, object: 9n })]);

  assert.isDefined(context.rejected());
  assert.isDefined(context.closedWithError());
  assert.equal((context.closedWithError() as SessionError).code, SessionErrorCode.INVALID_FIELD);
  assert.isFalse(context.session.pendingFetch.has(context.requestId));
  assert.isFalse(context.session.fetchers.has(context.requestId));
});
