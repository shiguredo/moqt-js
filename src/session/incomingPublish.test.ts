/**
 * session/incomingPublish.ts の単体テスト: 受信 PUBLISH ストリームの受信上限と
 * 初期 fill fetch の Group Order
 *
 * draft-ietf-moq-transport-23 §9.1.8 / §9:
 * 受信 PUBLISH ストリームで扱う制御メッセージも MAX_CONTROL_MESSAGE_SIZE の上限に
 * 従う。incomingPublishHandleBidirectionalStream が生成する ControlStreamReader に
 * セッションの受信上限が配線されていることと、上限超過時に FIELD_LENGTH_EXCEEDED で
 * セッションを閉じることを検証する。
 *
 * draft-ietf-moq-transport-23 §3.4 / §9.19.8 / §9.19.15 / §10.5:
 * PUBLISH の FILL_PARAMETERS で開かれる初期 fill fetch は、PUBLISH の
 * GROUP_ORDER が無ければ Track Properties の DEFAULT_PUBLISHER_GROUP_ORDER を
 * 継承する。Descending を広告する publisher の fill ストリームを実ストリームで
 * 受信し、Group ID Delta が Descending で復号されることを検証する。
 *
 * テスト用の実 SessionImpl・最小のセッション代役と実 W3C ストリームで検証する
 * (モックライブラリは使わない)。代役は上限超過の経路が参照する状態と副作用だけを持つ。
 */

import { test, assert } from "vite-plus/test";
import { SessionError, SessionErrorCode } from "../error";
import { SubscriberImpl } from "../subscriber";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import {
  FetchHeaderType,
  createFetchObjectContext,
  createFetchObjectFlags,
  createFirstFetchObjectFlags,
  encodeFetchHeader,
  encodeFetchObjectFields,
  type FetchObjectFields,
  type MoqtObject,
} from "../dataStream";
import { GroupOrder, MessageType, createTrackNamespace, encodeFillParameters } from "../message";
import { encodePublishPayload } from "../message/publish";
import { TrackPropertyId } from "../properties";
import { SessionImpl } from "../session";
import { waitForMacrotask } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  incomingPublishHandleBidirectionalStream,
  incomingPublishRunStreamSubLoop,
  type IncomingPublishSessionInternal,
} from "./incomingPublish";

/**
 * 先頭メッセージの受信上限を検証するための最小のセッション代役
 *
 * 先頭メッセージの上限超過では読み取りが失敗して即座に戻るため、
 * この経路が参照する sessionState / closeWithError / notifyErrorIfActive だけを持つ。
 * 本番の sessionClose は同期的に sessionState を closed にするため、closeWithError も
 * 同じ副作用を持つようにする。
 */
function createOverLimitSession(localMaxControlMessageSize: number): {
  session: IncomingPublishSessionInternal;
  closed: SessionError[];
  notified: Error[];
} {
  const closed: SessionError[] = [];
  const notified: Error[] = [];
  const session = {
    sessionState: "connected",
    // 仕様の最小値 65535 未満のテスト専用値。既定値と異なる上限にして、
    // 生成された reader への配線を区別できるようにする。
    localMaxControlMessageSize,
    peerMaxControlMessageSize: 65535,
    closeWithError: (error: SessionError): void => {
      closed.push(error);
      session.sessionState = "closed";
    },
    notifyErrorIfActive: (error: Error): void => {
      // 本番と同じく、閉じたセッションでは通知しない
      if (session.sessionState !== "connected") {
        return;
      }
      notified.push(error);
    },
  } as unknown as IncomingPublishSessionInternal;
  return { session, closed, notified };
}

test("incomingPublishHandleBidirectionalStream: 先頭メッセージの reader をセッションの受信上限で作る", async () => {
  const { session, closed, notified } = createOverLimitSession(4);
  const stream = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        // Type 0x10 + Message Length 5 (vi64 の [0x05])。上限 4 を超える宣言
        controller.enqueue(new Uint8Array([0x10, 0x05]));
      },
    }),
  } as unknown as WebTransportBidirectionalStream;

  await incomingPublishHandleBidirectionalStream(session, stream);

  // 生成された reader はセッションの受信上限 4 で作られているため、本文長 5 の
  // 宣言だけで FIELD_LENGTH_EXCEEDED になる
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  // closeWithError が sessionState を closed にするため、追加の error 通知は起きない
  assert.equal(notified.length, 0);
});

/**
 * draft-ietf-moq-transport-23 §9:
 * 受信 PUBLISH のサブループで制御メッセージの Message Length がローカル上限を
 * 超えた場合、購読者への error 通知と保留中 REQUEST_UPDATE の reject を行って
 * から、FIELD_LENGTH_EXCEEDED でセッションを 1 回だけ閉じる。
 *
 * セッション終了を通知より先に実行すると、sessionClose が購読を closed にするため
 * 購読者への error 通知が消える。ここではテスト用の代役でも closeWithError が
 * 購読を closed にする副作用を持ち、close を通知より前へ動かす退行を検出できる
 * ようにする。
 */
test("incomingPublishRunStreamSubLoop: 上限超過で購読者通知と reject を行ってから 1 回だけ閉じる", async () => {
  const publishRequestId = 10n;
  const events: string[] = [];
  const closedWithError: SessionError[] = [];
  const rejectedUpdateErrors: Error[] = [];
  const impl = new SubscriberImpl(
    ["live"],
    "video",
    publishRequestId,
    7n,
    () => {},
    undefined,
    undefined,
    (error: Error) => {
      events.push("subscriberError");
      assert.instanceOf(error, SessionError);
      assert.equal((error as SessionError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
    },
  );

  // 応答待ちの REQUEST_UPDATE を 1 件注入し、reject の文言を検証できるようにする
  const session = {
    sessionState: "connected",
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: (): void => {},
          reject: (error: Error): void => {
            rejectedUpdateErrors.push(error);
          },
          targetRequestId: publishRequestId,
        },
      ],
    ]),
    subscribers: new Map([[publishRequestId, impl]]),
    goawayReceivedOnRequestStreams: new Set<bigint>(),
    emitDebug: (): void => {},
    closeWithError: (error: SessionError): void => {
      // 本番の sessionClose と同じく、close の副作用として購読を closed にする
      events.push("close");
      impl.markClosed();
      session.sessionState = "closed";
      closedWithError.push(error);
    },
  } as unknown as IncomingPublishSessionInternal;

  // 仕様の最小値 65535 未満のテスト専用値。本文長 5 の宣言だけで
  // FIELD_LENGTH_EXCEEDED を起こせる上限にする。
  const subControlReader = new ControlStreamReader(4);
  const subReader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x10, 0x05]));
    },
  }).getReader();

  try {
    await incomingPublishRunStreamSubLoop(
      session,
      impl,
      publishRequestId,
      subReader,
      subControlReader,
    );
  } finally {
    subReader.releaseLock();
  }

  // 購読者への error 通知 → セッション終了の順序で、セッション終了は 1 回だけ
  assert.deepEqual(events, ["subscriberError", "close"]);
  assert.equal(closedWithError.length, 1);
  assert.equal(closedWithError[0]?.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  // 保留中の REQUEST_UPDATE はストリーム終了の文言で reject される
  assert.equal(rejectedUpdateErrors.length, 1);
  assert.equal(rejectedUpdateErrors[0]?.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  // 購読は closed になる
  assert.equal(impl.state, "closed");
});

// ============================================================================
// 受信 PUBLISH の初期 fill fetch の Group Order
// draft-ietf-moq-transport-23 §3.4 / §9.19.8 / §9.19.15 / §10.5
// ============================================================================

/**
 * 実 SessionImpl で受信 PUBLISH を処理するための内部状態ビュー
 *
 * SessionImpl の private フィールドは実行時には存在するため、PUBLISH の受理に
 * 必要な tracksSubscriptions への登録と、検証に使う subscribers /
 * fillFetchTargets の参照だけを表す。
 */
interface IncomingPublishFillTestSessionView {
  tracksSubscriptions: Map<
    bigint,
    {
      callbacks: {
        onPublish: (
          suffix: string[],
          trackName: string,
        ) => Promise<{ object: (object: MoqtObject) => void }>;
      };
      state: "active";
      namespacePrefix: string[];
    }
  >;
  subscribers: Map<bigint, SubscriberImpl>;
  fillFetchTargets: Map<bigint, unknown>;
}

/**
 * 受信 PUBLISH の SubscriberImpl 登録を待つ
 *
 * PUBLISH の処理は非同期に進むため、登録されるまでマクロタスク境界で待つ。
 * 登録されないまま上限回数を超えた場合は、実装の退行として失敗させる。
 */
async function waitForIncomingPublishFillSubscriber(
  internal: IncomingPublishFillTestSessionView,
  requestId: bigint,
): Promise<SubscriberImpl> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const subscriber = internal.subscribers.get(requestId);
    if (subscriber !== undefined) {
      return subscriber;
    }
    await waitForMacrotask();
  }
  throw new Error("受信 PUBLISH の SubscriberImpl が登録されていない");
}

/**
 * FILL_PARAMETERS と DEFAULT_PUBLISHER_GROUP_ORDER (Descending) を持つ
 * 受信 PUBLISH の双方向ストリームを作る
 *
 * draft-ietf-moq-transport-23 §9.8 / §10.5:
 * PUBLISH の Parameters に FILL_PARAMETERS、Track Properties に
 * DEFAULT_PUBLISHER_GROUP_ORDER = Descending (0x02) を載せる。
 * GROUP_ORDER は PUBLISH にも FILL_PARAMETERS 内側にも載せない。
 *
 * readable は先頭メッセージを 1 チャンクで渡したまま閉じない。PUBLISH の
 * 受理後も購読を active に保ち、subscriber.unsubscribe() で後始末する。
 */
function createDescendingFillPublishStream(
  requestId: bigint,
  trackAlias: bigint,
): WebTransportBidirectionalStream {
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    trackAlias,
    parameters: [encodeFillParameters([])],
    trackProperties: [{ id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0x02n }],
  });
  const controlWriter = new ControlStreamWriter();
  const frame = controlWriter.encode(MessageType.PUBLISH, publishPayload);
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame);
    },
  });
  return {
    readable,
    writable: new WritableStream<Uint8Array>({}),
  } as unknown as WebTransportBidirectionalStream;
}

/**
 * Descending の Group ID Delta を含む fill fetch データストリームを組み立てる
 *
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * 先頭 Object は Group ID を絶対値 (10) で運び、2 番目の Object は Group ID
 * Delta 0 で Group 10 から Group 9 へ移動する。
 *   - Ascending:  10 + (0 + 1) = 11
 *   - Descending: 10 - (0 + 1) = 9
 * Group Order の解決漏れがあると 11 に復号されるため、2 番目の Group ID で
 * 解決結果を検証できる。
 */
function buildDescendingFillStreamChunk(requestId: bigint): Uint8Array {
  const firstContext = createFetchObjectContext({
    groupId: 10n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    // 直前のオブジェクトまでをエンコードした直後の状態。ここでは
    // createFetchObjectFlags / encodeFetchObjectFields が参照する
    // Group ID / Subgroup ID / Object ID / Publisher Priority だけが意味を持つ。
    subgroupPublisherPriority: 100,
    hasPriorSubgroup: true,
    hasPriorActualObject: true,
    lastActualObject: { groupId: 10n, objectId: 0n },
    lastSerializedLocation: { groupId: 10n, objectId: 0n },
    subgroupPriorities: new Map([[0n, 100]]),
  });
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(false),
    groupId: 10n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const second: FetchObjectFields = {
    serializationFlags: createFetchObjectFlags(
      { groupId: 9n, subgroupId: 0n, objectId: 1n, publisherPriority: 100 },
      firstContext,
      false,
    ),
    groupId: 9n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  return concatUint8Arrays([
    encodeFetchHeader({ type: FetchHeaderType, requestId }),
    // 送信側も同じ Descending の規則で delta を書く
    encodeFetchObjectFields(first, false, null, GroupOrder.DESCENDING),
    encodeFetchObjectFields(second, false, firstContext, GroupOrder.DESCENDING),
  ]);
}

/**
 * draft-ietf-moq-transport-23 §3.4 / §9.19.8 / §9.19.15 / §10.5:
 * publisher が DEFAULT_PUBLISHER_GROUP_ORDER で Descending を広告し、
 * PUBLISH の GROUP_ORDER を省略した初期 fill では、fill fetch の Group ID Delta を
 * Descending で復号する。Ascending に倒すと 2 番目の Group ID が 11 になり、
 * 誤った Group ID をアプリへ配送する。
 */
test("受信 PUBLISH の初期 fill: Descending 既定の Track Property で Group ID Delta を Descending で復号する", async () => {
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  const requestId = 1n;
  const trackAlias = 7n;
  const delivered: MoqtObject[] = [];
  const internal = session as unknown as IncomingPublishFillTestSessionView;
  internal.tracksSubscriptions.set(requestId, {
    callbacks: {
      onPublish: async () => ({
        object: (object: MoqtObject) => {
          delivered.push(object);
        },
      }),
    },
    state: "active",
    namespacePrefix: ["live"],
  });

  const publishHandle = session.handleIncomingBidirectionalStream(
    createDescendingFillPublishStream(requestId, trackAlias),
  );
  const subscriber = await waitForIncomingPublishFillSubscriber(internal, requestId);
  // PUBLISH の受理で初期 fill の受信先が登録されている
  assert.isTrue(internal.fillFetchTargets.has(requestId));

  let fillController!: ReadableStreamDefaultController<Uint8Array>;
  const fillStream = new ReadableStream<Uint8Array>({
    start(controller) {
      fillController = controller;
    },
  });
  const fillHandle = session.handleIncomingStream(fillStream);
  fillController.enqueue(buildDescendingFillStreamChunk(requestId));
  fillController.close();
  await fillHandle;
  await waitForMacrotask();

  // Group ID Delta 0 は Descending で prior - (0 + 1) = 9 に復号される
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]?.groupId, 10n);
  assert.equal(delivered[1]?.groupId, 9n);
  // fill fetch 経由の Object であることがアプリへ伝わる
  assert.isTrue(delivered.every((object) => object.fillDelivered === true));
  // FIN 後は fill の関連付けが消え、購読とセッションは継続する
  assert.isFalse(internal.fillFetchTargets.has(requestId));
  assert.equal(subscriber.state, "active");
  assert.equal(session.state, "connected");

  await subscriber.unsubscribe();
  await publishHandle;
});
