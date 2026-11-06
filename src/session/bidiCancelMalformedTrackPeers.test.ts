/**
 * session/bidi.ts の単体テスト: cancelMalformedTrackPeers の二重通知防止
 *
 * cancelMalformedTrackPeers が error コールバックを 1 回だけ呼ぶことを検証する。
 * 実 SessionImpl・実 W3C ストリーム・実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { MalformedTrackError } from "../error";
import { bidiCancelFetch, cancelMalformedTrackPeers } from "./bidi";
import { FetcherImpl } from "../fetcher";
import { ControlStreamReader } from "../controlStream";
import { fullTrackNameKey } from "../fullTrackName";
import { SessionImpl } from "../session";
import { asBidiSessionInternal, createTestWebTransport } from "../testSupport/bidi";

// ============================================================================
// cancelMalformedTrackPeers の二重通知防止
// draft-ietf-moq-transport-23 §12.1 (Malformed Tracks) / §3.2.4 (Fetch State Management)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §12.1 / §3.2.4:
 * 最初の malformed 検出のキャンセルが await で保留されている間に同一 Track の
 * 2 回目の検出が届いても、error コールバックは 1 回だけ呼ばれる。state を
 * キャンセル開始と同期に closed にするため、bidiCancelFetch の完了を待たずに
 * 二重通知が止まる。
 * §3.2.4 の MUST (bidi リクエストストリームへの STOP_SENDING) は維持され、
 * キャンセルも重複して送らない。
 */
test("cancelMalformedTrackPeers: キャンセル中の重複検出で error コールバックが 1 回だけ呼ばれる", async () => {
  const fetchErrors: Error[] = [];
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    3n,
    () => {},
    undefined,
    (error) => {
      fetchErrors.push(error);
    },
  );
  // キャンセルが完了しない stream を用意し、bidiCancelFetch の await で窓を開く
  // 実 W3C ストリームを使い、underlying source / sink で cancel / abort の到達を
  // 観測する。cancel が完了しないようにして bidiCancelFetch の await で窓を開く
  let resolveCancel: (() => void) | undefined;
  const pendingCancel = new Promise<void>((resolve) => {
    resolveCancel = resolve;
  });
  const cancelReasons: unknown[] = [];
  const abortReasons: unknown[] = [];
  const readable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason);
      return pendingCancel;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort(reason) {
      abortReasons.push(reason);
    },
  });
  const writer = writable.getWriter();
  // 実 SessionImpl に、cancel が完了しない実ストリームを requestStreams として
  // 登録する。セッションの型を偽装するのではなく、実セッションの内部 Map に
  // 実ストリームを挿入する (bidiCancelFetch の await 窓を作るため)。
  const impl = new SessionImpl(createTestWebTransport().transport, {});
  const session = asBidiSessionInternal(impl);
  session.fetchers.set(3n, fetcher);
  session.requestStreams.set(3n, {
    stream: { readable, writable } as unknown as WebTransportBidirectionalStream,
    writer,
    controlReader: new ControlStreamReader(),
  });
  fetcher.onCancel = () => bidiCancelFetch(session, fetcher);

  const trackKey = fullTrackNameKey(["live"], "video");
  const error = new MalformedTrackError("malformed track");
  cancelMalformedTrackPeers(session, trackKey, error);
  // 1 回目のキャンセルが await で保留されている間に 2 回目の検出が重なる
  await Promise.resolve();
  cancelMalformedTrackPeers(session, trackKey, error);
  await Promise.resolve();

  // error コールバックは 1 回だけ呼ばれる
  assert.equal(fetchErrors.length, 1);
  assert.strictEqual(fetchErrors[0], error);
  assert.equal(fetcher.state, "closed");

  // キャンセルを完了させ、後始末も 1 回だけであることを確認する
  resolveCancel?.();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  // §3.2.4 の STOP_SENDING 相当 (readable.cancel) と RESET_STREAM 相当 (writer.abort)
  assert.deepEqual(cancelReasons, ["fetch cancelled"]);
  assert.deepEqual(abortReasons, ["fetch cancelled"]);
  assert.isFalse(session.requestStreams.has(3n));
  assert.isFalse(session.fetchers.has(3n));
});
