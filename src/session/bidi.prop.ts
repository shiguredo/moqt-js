/**
 * session/bidi.ts の Property-Based Tests
 *
 * draft-ietf-moq-transport-21 §3.1 / §3.2.1 / §3.3.1 / §3.3.2 / §3.4.1 / §6.4.2.2 /
 * §9.1.7 / §9.2 / §9.3 / §9.5 / §9.5.1 / §9.9 / §9.10 / §9.20.1 / §9.20.19 / §10.8 /
 * §10.9 / §12.1 / §12.5 / §13 を対象に、bidi 層の純粋関数と準純粋関数が持つ不変条件を
 * 検証する。
 *
 * 検証する性質:
 * - validateNoDuplicateGoawayOnRequestStream: 未登録の Request ID は null を返して
 *   登録され、登録済みの Request ID は必ず PROTOCOL_VIOLATION を返す (登録集合は
 *   呼び出し回数に依存せず、渡された異なる Request ID の集合と一致する)
 * - validateRequestOkNoTrackProperties: 空配列のときだけ null を返し、非空では必ず
 *   PROTOCOL_VIOLATION の SessionError を返してメッセージにコンテキスト名を含む
 * - createResetStreamError / createFetchDataStreamResetError: 任意の unknown 入力で
 *   必ず Error を返し、メッセージが空でなく、同じ入力に対して決定的である
 * - createResetStreamError / createFetchDataStreamResetError: 数値の streamErrorCode は
 *   正規化したコード名と値をメッセージおよびプロパティに載せ、数値以外では固定文言のみを
 *   返してプロパティを付けない
 * - restoreIncomingRequestUpdateCount: 記録値 0 ではエントリを作らず、正の値では記録値
 *   そのものへ復元する (過小・過大にならない)。対象外の Request ID は不変で、同じ記録値の
 *   再実行は冪等である
 * - clearPriorGapTrackingIfUnused: 追跡エントリは、その Track の購読と FETCH が 1 つも
 *   残っていないときだけ削除され、使用中は残る。他の Track のエントリは不変である
 * - deleteFillTargetsForSubscriber: 対象購読に紐づく fill 関連付けだけを削除する
 * - deleteFillTargetsForPendingUpdates: 応答待ちの更新に紐づく fill 関連付けだけを削除する
 * - hasPendingRequestUpdate / resolvePendingRequestUpdate: 対象 Request ID の pending が
 *   あれば true を返し、解決は先頭 1 件だけを行って送信時の値を返し、同じ対象の残りは残る
 * - rejectPendingRequestUpdates: 対象の pending を全件 reject して件数を返し、同じ Error
 *   オブジェクトを渡し、他の Request ID の pending には影響しない
 * - allowUnmatchedRequestOks / consumeUnmatchedRequestOk: 許可枠は加算と 1 件ずつの消費に
 *   対して単調で、尽きたら false を返して負の枠や空エントリを残さない
 * - cancelMalformedTrackPeers: 対象 Track の購読と FETCH だけを cancel し、他 Track の
 *   ピアは状態も error 通知も変えない (2 回目の検出でも二重通知しない)
 * - notifySubscriberFailure: 通知するのは購読が存在し GOAWAY 未受信で active のときだけで、
 *   error コールバックが throw しても state は closed になり、2 回目は何も通知しない
 * - bidiHandlePublishDone: 受信 PUBLISH_DONE の状態コードを正規化して購読へ通知し、
 *   記録用の情報を返す
 * - bidiHandlePublishStateNotify: subscribe ロールでは許可パラメータを検証通過後にまとめて
 *   反映し、省略されたパラメータは不変に保つ
 * - bidiHandlePublishStateNotify: subscribe ロール以外・許可外パラメータ・FORWARD の
 *   値域外では反映を行わない
 *
 * 対応する単体テストから削除した固定値ケース:
 * - src/session/bidiGoawayValidation.test.ts:
 *   "validateNoDuplicateGoawayOnRequestStream: 初回は null で seenSet に追加される"
 * - src/session/bidiTrackPropertiesValidation.test.ts:
 *   "validateRequestOkNoTrackProperties: 空の Track Properties は検証を通過する"
 *
 * 非同期 I/O を伴う bidiSendRequestOnBidiStream / bidiRead*Response /
 * bidiReadRequestStreamMessages / bidiSendRequestUpdate などは、性質がストリームの
 * 読み書き順序と pending の解決タイミングに依存し、fc.property の同期評価に載せられない
 * ため対象外とする。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  allowUnmatchedRequestOks,
  bidiCancelFetch,
  bidiHandlePublishDone,
  bidiHandlePublishStateNotify,
  cancelMalformedTrackPeers,
  clearPriorGapTrackingIfUnused,
  consumeUnmatchedRequestOk,
  createFetchDataStreamResetError,
  createResetStreamError,
  deleteFillTargetsForPendingUpdates,
  deleteFillTargetsForSubscriber,
  hasPendingRequestUpdate,
  notifySubscriberFailure,
  rejectPendingRequestUpdates,
  resolvePendingRequestUpdate,
  restoreIncomingRequestUpdateCount,
  validateNoDuplicateGoawayOnRequestStream,
  validateRequestOkNoTrackProperties,
  FIN_WITHOUT_PUBLISH_DONE_MESSAGE,
  RESET_FETCH_DATA_STREAM_MESSAGE,
  RESET_REQUEST_STREAM_MESSAGE,
  type BidiSessionInternal,
} from "./bidi";
import {
  DataStreamErrorCode,
  MalformedTrackError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
  normalizeDataStreamErrorCode,
  normalizePublishDoneCode,
} from "../error";
import { FetcherImpl } from "../fetcher";
import { SubscriberImpl } from "../subscriber";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import { type PriorGapTracking } from "./priorGapTracking";
import {
  encodeLocation,
  encodeLocationFilterParameter,
  encodeUint8ParameterValue,
  type LocationFilter,
  type Parameter,
  type RangeFilterSpec,
} from "../message/parameter";
import {
  GroupOrder,
  MessageParameterType,
  MessageType,
  ObjectStatus,
  isPublishDoneErrorStatus,
  type Location,
} from "../message/types";
import { encodePublishDonePayload } from "../message/publish";
import { encodePublishStateNotifyPayload } from "../message/session";
import { createBidiSession } from "../testSupport/bidi";

// ============================================================================
// Arbitrary 定義
// ============================================================================

/** Request ID (bidi リクエストストリームの比較キーに使う小さな非負整数) */
const requestIdArb = fc.bigInt({ min: 0n, max: 1024n });

/** Location (LARGEST_OBJECT / Location Filter の比較用) */
const locationArb: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: 10000n }),
  object: fc.bigInt({ min: 0n, max: 10000n }),
});

/**
 * Location Filter
 *
 * End Group を含む 3 / 4 フィールド表現は StartGroup + EndGroupDelta の上限超過で
 * decode が PROTOCOL_VIOLATION になるため、値域が常に妥当な 0 / 1 / 2 フィールドに限る。
 */
const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ reset: true } as const),
  fc.bigInt({ min: 0n, max: 10000n }).map((startGroup) => ({ startGroup })),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 10000n }),
    startObject: fc.bigInt({ min: 0n, max: 10000n }),
  }),
);

/** Track Property (validateRequestOkNoTrackProperties の入力) */
const propertyArb: fc.Arbitrary<{ id: bigint; value: bigint }> = fc.record({
  id: fc.bigInt({ min: 0n, max: 0x3fffn }),
  value: fc.bigInt({ min: 0n, max: 100000n }),
});

/** REQUEST_OK 系メッセージのコンテキスト名 */
const contextNameArb = fc.constantFrom(
  "PUBLISH_OK",
  "REQUEST_UPDATE_OK",
  "SUBSCRIBE_NAMESPACE_OK",
  "PUBLISH_NAMESPACE_OK",
);

/** Data Stream Reset エラーコード名の逆引き表 (正規化結果の検証に使う) */
const dataStreamErrorCodeNames = new Map<number, string>(
  Object.entries(DataStreamErrorCode).map(([name, value]) => [value, name]),
);

/** Range Filter の送信指定 (pending に保持される値の検証用) */
const rangeFiltersArb: fc.Arbitrary<RangeFilterSpec[]> = fc.constant<RangeFilterSpec[]>([
  { type: "objectId", setId: 0, ranges: [{ start: 2n, end: 3n }] },
]);

/**
 * 応答待ちの REQUEST_UPDATE 1 件分の仕様
 *
 * updateId は Map のキー (REQUEST_UPDATE 自身の Request ID)、targetRequestId は
 * 更新対象のリクエストを識別する値である。
 */
interface PendingUpdateSpec {
  updateId: bigint;
  targetRequestId: bigint;
  forward: boolean | undefined;
  rangeFilters: RangeFilterSpec[] | undefined;
  locationFilter: LocationFilter | undefined;
}

/** updateId が一意な pending 仕様の配列 */
const pendingUpdateSpecsArb: fc.Arbitrary<PendingUpdateSpec[]> = fc.uniqueArray(
  fc.record({
    updateId: fc.bigInt({ min: 0n, max: 64n }),
    targetRequestId: fc.bigInt({ min: 0n, max: 4n }),
    forward: fc.option(fc.boolean(), { nil: undefined }),
    rangeFilters: fc.option(rangeFiltersArb, { nil: undefined }),
    locationFilter: fc.option(locationFilterArb, { nil: undefined }),
  }),
  { selector: (spec) => spec.updateId.toString(), maxLength: 8 },
);

/**
 * 更新対象として引く Request ID
 *
 * pending 仕様の targetRequestId と同じ値域 (一致する場合) と、それを超える値域
 * (一致しない場合) の両方を生成し、対象あり / 対象なしの両分岐を必ず通す。
 */
const pendingTargetArb = fc.oneof(
  fc.bigInt({ min: 0n, max: 4n }),
  fc.bigInt({ min: 5n, max: 64n }),
);

/**
 * pending 仕様を session に登録し、resolve / reject の到達を記録する
 *
 * モックではなく、実 Map に手書きの実オブジェクトを入れて呼び出しを記録する。
 */
function installPendingUpdates(
  session: BidiSessionInternal,
  specs: PendingUpdateSpec[],
): { resolved: bigint[]; rejected: Array<{ updateId: bigint; error: Error }> } {
  const resolved: bigint[] = [];
  const rejected: Array<{ updateId: bigint; error: Error }> = [];
  for (const spec of specs) {
    session.pendingRequestUpdate.set(spec.updateId, {
      resolve: () => {
        resolved.push(spec.updateId);
      },
      reject: (error: Error) => {
        rejected.push({ updateId: spec.updateId, error });
      },
      targetRequestId: spec.targetRequestId,
      forward: spec.forward,
      rangeFilters: spec.rangeFilters,
      locationFilter: spec.locationFilter,
    });
  }
  return { resolved, rejected };
}

/**
 * createBidiSession() が返すセッションへ closeWithError の観測点を付ける
 *
 * 共有ヘルパーは closeWithError を空実装で返すため、検証対象のセッション終了を観測するには
 * テスト側で差し替える必要がある (モックではなく実オブジェクトのフィールド差し替え)。
 */
function observeCloseWithError(session: BidiSessionInternal): {
  closed: () => SessionError | undefined;
  count: () => number;
} {
  let closed: SessionError | undefined;
  let count = 0;
  (session as unknown as { closeWithError: (error: SessionError) => void }).closeWithError = (
    error,
  ) => {
    closed = error;
    count += 1;
  };
  return {
    closed: () => closed,
    count: () => count,
  };
}

/** PUBLISH_STATE_NOTIFY で運ぶ状態変化 (省略は undefined) */
interface StateNotifyCase {
  largest: Location | undefined;
  forward: boolean | undefined;
  filter: LocationFilter | undefined;
}

/** 許可パラメータのみで構成した PUBLISH_STATE_NOTIFY の状態変化 */
const stateNotifyCaseArb: fc.Arbitrary<StateNotifyCase> = fc.record({
  largest: fc.option(locationArb, { nil: undefined }),
  forward: fc.option(fc.boolean(), { nil: undefined }),
  filter: fc.option(locationFilterArb, { nil: undefined }),
});

/** 状態変化を許可パラメータ列へ変換する (省略したパラメータは載せない) */
function buildStateNotifyParameters(state: StateNotifyCase): Parameter[] {
  const parameters: Parameter[] = [];
  if (state.largest !== undefined) {
    parameters.push({
      type: MessageParameterType.LARGEST_OBJECT,
      value: encodeLocation(state.largest),
    });
  }
  if (state.forward !== undefined) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(state.forward ? 1 : 0, "FORWARD"),
    });
  }
  if (state.filter !== undefined) {
    parameters.push(encodeLocationFilterParameter(state.filter));
  }
  return parameters;
}

/** 許可パラメータのみの PUBLISH_STATE_NOTIFY ペイロードを組み立てる */
function buildStateNotifyPayload(state: StateNotifyCase): Uint8Array {
  return encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: buildStateNotifyParameters(state),
  });
}

// ============================================================================
// PBT 1: validateNoDuplicateGoawayOnRequestStream
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * "The endpoint MUST close the session with a PROTOCOL_VIOLATION if it receives
 *  more than one GOAWAY on the control stream or on a single request stream."
 * Request ID ごとに初回だけ null を返し、2 回目以降は必ず PROTOCOL_VIOLATION を返す。
 * 登録集合は呼び出し回数ではなく、渡された異なる Request ID の集合と一致する。
 */
test("validateNoDuplicateGoawayOnRequestStream: 初回だけ null を返し、同じ Request ID の 2 回目以降は必ず PROTOCOL_VIOLATION になる", () => {
  fc.assert(
    fc.property(fc.array(requestIdArb, { maxLength: 12 }), (requestIds) => {
      const seen = new Set<bigint>();
      const callsPerId = new Map<bigint, number>();

      for (const requestId of requestIds) {
        const calls = callsPerId.get(requestId) ?? 0;
        const error = validateNoDuplicateGoawayOnRequestStream(requestId, seen);
        if (calls === 0) {
          // 初回は検出されず、以降の重複判定のために登録される
          assert.isNull(error);
          assert.isTrue(seen.has(requestId));
        } else {
          // 2 回目以降は必ず重複として拒否される
          if (error === null) {
            assert.fail("重複 GOAWAY で SessionError を期待したが null だった");
          }
          assert.instanceOf(error, SessionError);
          assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
        }
        callsPerId.set(requestId, calls + 1);
      }

      // 登録集合は「現れた異なる Request ID」と一致し、呼び出し回数の影響を受けない
      assert.equal(seen.size, callsPerId.size);
      for (const requestId of callsPerId.keys()) {
        assert.isTrue(seen.has(requestId));
      }
    }),
  );
});

// ============================================================================
// PBT 2: validateRequestOkNoTrackProperties
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * "Track Properties are populated in TRACK_STATUS_OK; they are empty in PUBLISH_OK,
 *  REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK. If an endpoint
 *  receives Track Properties in one of these messages it MUST close the session with a
 *  PROTOCOL_VIOLATION."
 * 空配列のときだけ null を返し、非空では必ず PROTOCOL_VIOLATION を返す。
 */
test("validateRequestOkNoTrackProperties: 空配列のときだけ null を返し、非空では必ず PROTOCOL_VIOLATION を返す", () => {
  fc.assert(
    fc.property(
      fc.array(propertyArb, { maxLength: 4 }),
      contextNameArb,
      (trackProperties, contextName) => {
        const error = validateRequestOkNoTrackProperties(trackProperties, contextName);
        if (trackProperties.length === 0) {
          assert.isNull(error);
          return;
        }
        if (error === null) {
          assert.fail("非空の Track Properties で SessionError を期待したが null だった");
        }
        assert.instanceOf(error, SessionError);
        assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
        // どのメッセージで違反したかがメッセージから読み取れる
        assert.equal(error.message, `track properties must be empty in ${contextName}`);
      },
    ),
  );
});

// ============================================================================
// PBT 3: createResetStreamError / createFetchDataStreamResetError
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §12.5:
 * ピアの RESET_STREAM 由来の値はどんな型でも届き得るため、変換は必ず Error を返し、
 * 通知文言が空になってはならない。同じ入力に対しては常に同じメッセージを返す。
 */
test("createResetStreamError と createFetchDataStreamResetError: 任意の unknown 入力で必ず Error を返し、同じ入力に同じメッセージを返す", () => {
  fc.assert(
    fc.property(fc.anything(), (rawError) => {
      for (const build of [createResetStreamError, createFetchDataStreamResetError]) {
        const first = build(rawError);
        const second = build(rawError);
        assert.instanceOf(first, Error);
        assert.isTrue(first.message.length > 0);
        // 決定的である (同じ入力から同じメッセージ)
        assert.equal(first.message, second.message);
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §12.5 / §13:
 * 数値の streamErrorCode は名前付き列挙へ正規化し、コード名と値をメッセージへ載せて
 * streamErrorCode プロパティにも正規化値を設定する。未知値・非整数・非有限は
 * INTERNAL_ERROR へ倒れる。数値以外は固定文言のみを返し、プロパティを付けない。
 */
test("createResetStreamError: 数値の streamErrorCode は正規化したコード名と値を載せ、数値以外は固定文言のみを返す", () => {
  const numericCodeArb = fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.double(),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  );

  fc.assert(
    fc.property(numericCodeArb, (streamErrorCode) => {
      const rawError = Object.assign(new Error("reset"), {
        source: "stream",
        streamErrorCode,
      });
      const error = createResetStreamError(rawError) as Error & { streamErrorCode?: unknown };
      const normalized = normalizeDataStreamErrorCode(streamErrorCode);
      const name = dataStreamErrorCodeNames.get(normalized);
      if (name === undefined) {
        assert.fail(`正規化後のコード値 ${normalized} に対応する名前が無い`);
      }
      // 正規化した値がコード名と 16 進数の両方で読み取れる
      assert.equal(
        error.message,
        `${RESET_REQUEST_STREAM_MESSAGE}: ${name}(0x${normalized.toString(16)})`,
      );
      assert.isTrue(error.message.startsWith(`${RESET_REQUEST_STREAM_MESSAGE}: `));
      assert.equal(error.streamErrorCode, normalized);
    }),
  );

  const nonNumericCodeArb: fc.Arbitrary<unknown> = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.string(),
    fc.bigInt({ min: 0n, max: 100n }),
    fc.boolean(),
    fc.record({ nested: fc.string() }),
    fc.record({ streamErrorCode: fc.oneof(fc.string(), fc.bigInt(), fc.boolean()) }),
  );

  fc.assert(
    fc.property(nonNumericCodeArb, (streamErrorCode) => {
      const rawError = Object.assign(new Error("reset"), {
        source: "stream",
        streamErrorCode,
      });
      const error = createResetStreamError(rawError) as Error & { streamErrorCode?: unknown };
      // コード値を取り出せない場合は固定文言のみで、プロパティも付けない
      assert.equal(error.message, RESET_REQUEST_STREAM_MESSAGE);
      assert.isFalse("streamErrorCode" in error);
    }),
  );
});

/**
 * createFetchDataStreamResetError は bidi リクエストストリーム用と同じ組み立てを共有し、
 * 対象が FETCH データストリームであることだけが異なる (§3.2.1)。
 */
test("createFetchDataStreamResetError: 同じ streamErrorCode から bidi 用と対になる固定文言の Error を作る", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0x20 }), (streamErrorCode) => {
      const rawError = Object.assign(new Error("reset"), {
        source: "stream",
        streamErrorCode,
      });
      const bidiError = createResetStreamError(rawError);
      const fetchError = createFetchDataStreamResetError(rawError);

      // コード名の部分は共通で、先頭の対象を表す文言だけが異なる
      const bidiSuffix = bidiError.message.slice(RESET_REQUEST_STREAM_MESSAGE.length);
      const fetchSuffix = fetchError.message.slice(RESET_FETCH_DATA_STREAM_MESSAGE.length);
      assert.equal(fetchSuffix, bidiSuffix);
      assert.isTrue(fetchError.message.startsWith(RESET_FETCH_DATA_STREAM_MESSAGE));
    }),
  );
});

// ============================================================================
// PBT 4: restoreIncomingRequestUpdateCount
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 未応答数の減算は 1 回の read の先頭で記録した値へ戻す形で行う。記録値 0 のときは
 * エントリを作らず、正の値のときは記録値そのものへ戻す (過小・過大にならない)。
 * 対象外の Request ID の記録は変化せず、同じ記録値での再実行は冪等である。
 */
test("restoreIncomingRequestUpdateCount: 記録値 0 ではエントリを作らず、正の値では記録値どおりに復元する", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(requestIdArb, fc.nat({ max: 1000 })), {
        selector: ([requestId]) => requestId.toString(),
        maxLength: 6,
      }),
      requestIdArb,
      fc.nat({ max: 1000 }),
      (entries, requestId, countBeforeRead) => {
        const { session } = createBidiSession();
        const counts = session.receivedRequestUpdateCounts;
        for (const [id, value] of entries) {
          counts.set(id, value);
        }
        const before = new Map(counts);

        restoreIncomingRequestUpdateCount(session, requestId, countBeforeRead);

        if (countBeforeRead === 0) {
          assert.isFalse(counts.has(requestId));
        } else {
          assert.equal(counts.get(requestId), countBeforeRead);
        }
        // 対象外の Request ID は変化しない
        for (const [id, value] of before) {
          if (id !== requestId) {
            assert.equal(counts.get(id), value);
          }
        }
        // 同じ記録値での復元は冪等 (繰り返しても値がずれない)
        const after = new Map(counts);
        restoreIncomingRequestUpdateCount(session, requestId, countBeforeRead);
        assert.deepEqual([...counts.entries()], [...after.entries()]);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.1.7:
 * read をまたいで復元を繰り返しても、対象 Request ID の値は最後の記録値と一致する。
 * 加算 (recordIncomingRequestUpdate) と対になる減算が、記録値 0 でエントリを残さない
 * ことを連鎖で確認する。
 */
test("restoreIncomingRequestUpdateCount: 復元を繰り返しても対象の値は最後の記録値と一致し、他の Request ID を変えない", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: 100 }), { maxLength: 10 }),
      requestIdArb,
      requestIdArb,
      fc.nat({ max: 100 }),
      (readings, firstId, secondId, fixedCount) => {
        const { session } = createBidiSession();
        const counts = session.receivedRequestUpdateCounts;

        for (const reading of readings) {
          restoreIncomingRequestUpdateCount(session, firstId, reading);
        }
        const lastReading = readings.length > 0 ? readings[readings.length - 1] : undefined;
        if (lastReading === undefined || lastReading === 0) {
          assert.isFalse(counts.has(firstId));
        } else {
          assert.equal(counts.get(firstId), lastReading);
        }

        // 別の Request ID の復元は先のエントリへ影響しない
        if (secondId !== firstId) {
          restoreIncomingRequestUpdateCount(session, secondId, fixedCount);
          assert.equal(counts.get(firstId), lastReading === 0 ? undefined : lastReading);
          if (fixedCount === 0) {
            assert.isFalse(counts.has(secondId));
          } else {
            assert.equal(counts.get(secondId), fixedCount);
          }
        }
      },
    ),
  );
});

// ============================================================================
// PBT 5: clearPriorGapTrackingIfUnused
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * Track 単位の Prior ID Gap 追跡は、その Track の購読と FETCH が 1 つも残っていない
 * ときだけ破棄できる。購読だけでは Track の生存を判定できない (FETCH は Track Alias を
 * 持たない) ため fetchers も見る。他の Track の追跡エントリは影響を受けない。
 */
test("clearPriorGapTrackingIfUnused: 対象 Track の購読と FETCH が尽きたときだけエントリを削除し、他の Track は残す", () => {
  const targetKey = fullTrackNameKey(["live"], "video");
  const otherKeys: FullTrackNameKey[] = [
    fullTrackNameKey(["live"], "audio"),
    fullTrackNameKey(["vod"], "video"),
    fullTrackNameKey(["live", "video"], ""),
  ];

  const trackingEntry = (): PriorGapTracking => ({
    receivedGroupIds: new Set<bigint>(),
    receivedObjectIdsByGroup: new Map<bigint, Set<bigint>>(),
    priorGroupIdGapRanges: [],
    priorObjectIdGapRanges: [],
    firstPriorGroupIdGapByGroup: new Map<bigint, bigint>(),
  });

  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      fc.nat({ max: 2 }),
      fc.nat({ max: 2 }),
      fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      (
        hasTargetEntry,
        otherEntryPresence,
        targetSubscriberCount,
        targetFetcherCount,
        hasOtherPeer,
      ) => {
        const { session } = createBidiSession();
        const tracking = new Map<FullTrackNameKey, PriorGapTracking>();
        if (hasTargetEntry) {
          tracking.set(targetKey, trackingEntry());
        }
        otherKeys.forEach((key, index) => {
          if (otherEntryPresence[index] === true) {
            tracking.set(key, trackingEntry());
          }
        });
        (
          session as unknown as {
            priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;
          }
        ).priorGapTrackingByTrack = tracking;

        // 対象 Track の購読 (同一 Track でも別 Request ID は別エントリ)
        for (let index = 0; index < targetSubscriberCount; index += 1) {
          const subscriber = new SubscriberImpl(
            ["live"],
            "video",
            BigInt(index + 1),
            BigInt(index + 1),
            () => {},
          );
          session.subscribersByAlias.set(BigInt(index + 1), [subscriber]);
        }
        // 対象 Track の FETCH
        for (let index = 0; index < targetFetcherCount; index += 1) {
          const fetcher = new FetcherImpl(["live"], "video", BigInt(100 + index), () => {});
          session.fetchers.set(BigInt(100 + index), fetcher);
        }
        // 別 Track の購読と FETCH (対象 Track の生存判定に数えてはならない)
        if (hasOtherPeer) {
          const otherSubscriber = new SubscriberImpl(["live"], "audio", 200n, 200n, () => {});
          session.subscribersByAlias.set(200n, [otherSubscriber]);
          const otherFetcher = new FetcherImpl(["vod"], "video", 201n, () => {});
          session.fetchers.set(201n, otherFetcher);
        }

        clearPriorGapTrackingIfUnused(session, targetKey);

        const shouldKeep = hasTargetEntry && (targetSubscriberCount > 0 || targetFetcherCount > 0);
        assert.equal(tracking.has(targetKey), shouldKeep);
        // 他の Track の追跡エントリは消えない
        otherKeys.forEach((key, index) => {
          assert.equal(tracking.has(key), otherEntryPresence[index] === true);
        });
      },
    ),
  );
});

// ============================================================================
// PBT 6: deleteFillTargetsForSubscriber / deleteFillTargetsForPendingUpdates
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.4.1:
 * 購読自体が終わると fill fetch ストリームも終わるため、その購読の関連付けだけを
 * 削除する。別の購読に紐づく関連付けは残る。
 */
test("deleteFillTargetsForSubscriber: 対象購読に紐づく fill 関連付けだけを削除する", () => {
  const subscribers = [0, 1, 2].map(
    (index) =>
      new SubscriberImpl(["live"], "video", BigInt(index + 1), BigInt(index + 1), () => {}),
  );

  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.record({
          updateId: fc.bigInt({ min: 0n, max: 32n }),
          subscriberIndex: fc.integer({ min: 0, max: 2 }),
        }),
        { selector: (entry) => entry.updateId.toString(), maxLength: 8 },
      ),
      fc.integer({ min: 0, max: 2 }),
      (entries, targetIndex) => {
        const { session } = createBidiSession();
        for (const entry of entries) {
          const subscriber = subscribers[entry.subscriberIndex];
          if (subscriber === undefined) {
            assert.fail("購読の添字が範囲外");
          }
          session.fillFetchTargets.set(entry.updateId, {
            subscriber,
            groupOrder: GroupOrder.ASCENDING,
          });
        }
        const target = subscribers[targetIndex];
        if (target === undefined) {
          assert.fail("対象購読の添字が範囲外");
        }

        deleteFillTargetsForSubscriber(session, target);

        for (const entry of entries) {
          const owner = subscribers[entry.subscriberIndex];
          if (owner === target) {
            assert.isFalse(session.fillFetchTargets.has(entry.updateId));
          } else {
            // 他の購読の関連付けは値ごと残る
            assert.strictEqual(session.fillFetchTargets.get(entry.updateId)?.subscriber, owner);
          }
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.5.1 / §3.4:
 * REQUEST_ERROR / GOAWAY で失敗が確定した更新の fill 関連付けだけを削除する。
 * 応答待ちでない更新の fill はまだ到着し得るため残す。
 */
test("deleteFillTargetsForPendingUpdates: 応答待ちの更新に紐づく fill 関連付けだけを削除する", () => {
  fc.assert(
    fc.property(pendingUpdateSpecsArb, pendingTargetArb, (specs, targetRequestId) => {
      const { session } = createBidiSession();
      installPendingUpdates(session, specs);
      const subscriber = new SubscriberImpl(["live"], "video", 999n, 999n, () => {});

      // pending の updateId すべてと、pending に無い updateId を fill 関連付けに置く
      const pendingIds = new Set(specs.map((spec) => spec.updateId));
      for (const spec of specs) {
        session.fillFetchTargets.set(spec.updateId, {
          subscriber,
          groupOrder: GroupOrder.ASCENDING,
        });
      }
      const unrelatedIds = [100n, 101n, 102n].filter((id) => !pendingIds.has(id));
      for (const id of unrelatedIds) {
        session.fillFetchTargets.set(id, { subscriber, groupOrder: GroupOrder.DESCENDING });
      }

      const failedUpdateIds = new Set(
        specs.filter((spec) => spec.targetRequestId === targetRequestId).map((s) => s.updateId),
      );

      deleteFillTargetsForPendingUpdates(session, targetRequestId);

      for (const spec of specs) {
        if (failedUpdateIds.has(spec.updateId)) {
          assert.isFalse(session.fillFetchTargets.has(spec.updateId));
        } else {
          assert.isTrue(session.fillFetchTargets.has(spec.updateId));
        }
      }
      for (const id of unrelatedIds) {
        assert.isTrue(session.fillFetchTargets.has(id));
      }
    }),
  );
});

// ============================================================================
// PBT 7: pendingRequestUpdate ヘルパー
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.5:
 * REQUEST_OK / REQUEST_ERROR が応答待ちの REQUEST_UPDATE への応答なのか、
 * 2 通目以降の不正な応答なのかを、対象 Request ID の pending の有無で判定する。
 */
test("hasPendingRequestUpdate: 対象 Request ID の pending の有無と一致する", () => {
  fc.assert(
    fc.property(pendingUpdateSpecsArb, pendingTargetArb, (specs, targetRequestId) => {
      const { session } = createBidiSession();
      installPendingUpdates(session, specs);

      const expected = specs.some((spec) => spec.targetRequestId === targetRequestId);
      assert.equal(hasPendingRequestUpdate(session, targetRequestId), expected);

      // 対象の pending をすべて reject すると必ず false になる
      rejectPendingRequestUpdates(session, targetRequestId, new Error("REQUEST_ERROR"));
      assert.isFalse(hasPendingRequestUpdate(session, targetRequestId));
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * "The receiver MUST still send a REQUEST_OK for each successful update"
 * 1 通の REQUEST_OK は 1 件だけを解決する。解決では pending から消え、送信時の
 * FORWARD / Range Filters / LOCATION_FILTER のうち値があるものだけが返る。
 * 同じ対象の残りは pending に残り、他の Request ID は影響を受けない。
 */
test("resolvePendingRequestUpdate: 対象の先頭 1 件だけを解決して送信時の値を返し、残りは pending に残る", () => {
  fc.assert(
    fc.property(pendingUpdateSpecsArb, pendingTargetArb, (specs, targetRequestId) => {
      const { session } = createBidiSession();
      const log = installPendingUpdates(session, specs);

      const matching = specs.filter((spec) => spec.targetRequestId === targetRequestId);
      const resolved = resolvePendingRequestUpdate(session, targetRequestId);

      if (matching.length === 0) {
        // 対応する更新が無い場合は何も解決しない
        assert.isUndefined(resolved);
        assert.deepEqual(log.resolved, []);
        assert.deepEqual(log.rejected, []);
        assert.equal(session.pendingRequestUpdate.size, specs.length);
        return;
      }

      const first = matching[0];
      if (first === undefined) {
        assert.fail("解決対象の pending 仕様が取得できない");
      }
      assert.isDefined(resolved);
      // 解決されたのは先頭 1 件だけであり、reject は呼ばれない
      assert.deepEqual(log.resolved, [first.updateId]);
      assert.deepEqual(log.rejected, []);
      assert.isFalse(session.pendingRequestUpdate.has(first.updateId));
      assert.equal(session.pendingRequestUpdate.size, specs.length - 1);
      // 送信時の値がそのまま返る (省略したフィールドは載せない)
      assert.equal(resolved?.forward, first.forward);
      assert.equal("forward" in (resolved ?? {}), first.forward !== undefined);
      assert.deepEqual(resolved?.rangeFilters, first.rangeFilters);
      assert.equal("rangeFilters" in (resolved ?? {}), first.rangeFilters !== undefined);
      assert.deepEqual(resolved?.locationFilter, first.locationFilter);
      assert.equal("locationFilter" in (resolved ?? {}), first.locationFilter !== undefined);
      // 同じ対象の残りがまだあれば pending は残る
      assert.equal(hasPendingRequestUpdate(session, targetRequestId), matching.length > 1);
      // 他の Request ID の pending は残る
      for (const spec of specs) {
        if (spec.targetRequestId !== targetRequestId) {
          assert.isTrue(session.pendingRequestUpdate.has(spec.updateId));
        }
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * coalescing された REQUEST_ERROR は複数の REQUEST_UPDATE を失敗させるため、
 * 対象の pending を全件 reject して件数を返す。呼び出し側はその件数を
 * 遅延 REQUEST_OK の許容枠に使う。他の Request ID の pending は影響を受けない。
 */
test("rejectPendingRequestUpdates: 対象の pending を全件 reject して件数を返し、他の Request ID には影響しない", () => {
  fc.assert(
    fc.property(pendingUpdateSpecsArb, pendingTargetArb, (specs, targetRequestId) => {
      const { session } = createBidiSession();
      const log = installPendingUpdates(session, specs);
      const error = new Error("coalesced REQUEST_ERROR");

      const matching = specs.filter((spec) => spec.targetRequestId === targetRequestId);
      const rejectedCount = rejectPendingRequestUpdates(session, targetRequestId, error);

      // 返る件数は対象の件数と一致する
      assert.equal(rejectedCount, matching.length);
      // 対象だけが、挿入順に、同じ Error オブジェクトで reject される
      assert.deepEqual(
        log.rejected.map((entry) => entry.updateId),
        matching.map((spec) => spec.updateId),
      );
      for (const entry of log.rejected) {
        assert.strictEqual(entry.error, error);
      }
      // reject 経路では resolve は呼ばれない
      assert.deepEqual(log.resolved, []);
      // 対象のエントリは消え、他の Request ID の pending は残る
      assert.equal(session.pendingRequestUpdate.size, specs.length - matching.length);
      for (const spec of specs) {
        assert.equal(
          session.pendingRequestUpdate.has(spec.updateId),
          spec.targetRequestId !== targetRequestId,
        );
      }
      assert.isFalse(hasPendingRequestUpdate(session, targetRequestId));
    }),
  );
});

// ============================================================================
// PBT 8: unmatchedRequestOkAllowances ヘルパー
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * coalescing で pending を消した件数分だけ「pending の無い REQUEST_OK」を許容する。
 * 許可枠は正の加算だけで増え、0 以下の加算では枠もエントリも作らない。
 */
test("allowUnmatchedRequestOks: 正の加算だけが許可枠を増やし、0 以下では枠もエントリも作らない", () => {
  fc.assert(
    fc.property(
      requestIdArb,
      requestIdArb,
      fc.array(fc.integer({ min: -3, max: 5 }), { maxLength: 6 }),
      (targetRequestId, otherRequestId, counts) => {
        const { session } = createBidiSession();
        const expectedAllowance = counts
          .filter((count) => count > 0)
          .reduce((sum, count) => sum + count, 0);

        for (const count of counts) {
          allowUnmatchedRequestOks(session, targetRequestId, count);
        }

        if (expectedAllowance === 0) {
          // 加算が全て 0 以下なら枠は作られない
          assert.isFalse(session.unmatchedRequestOkAllowances.has(targetRequestId));
        } else {
          assert.equal(
            session.unmatchedRequestOkAllowances.get(targetRequestId),
            expectedAllowance,
          );
        }
        // 他の Request ID の枠は作られない
        if (otherRequestId !== targetRequestId) {
          assert.isFalse(session.unmatchedRequestOkAllowances.has(otherRequestId));
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * 許可枠は 1 通の REQUEST_OK ごとに 1 つだけ減り、尽きたら false を返す。
 * 消費は単調で、負の枠や 0 のエントリを残さない。
 */
test("consumeUnmatchedRequestOk: 許可枠を 1 つずつ消費し、尽きたら false を返して負の枠を残さない", () => {
  fc.assert(
    fc.property(
      requestIdArb,
      requestIdArb,
      fc.nat({ max: 20 }),
      (targetRequestId, otherRequestId, allowance) => {
        const { session } = createBidiSession();
        allowUnmatchedRequestOks(session, targetRequestId, allowance);

        // 消費できるのは加算した枠の数だけである
        let consumed = 0;
        while (consumeUnmatchedRequestOk(session, targetRequestId)) {
          consumed += 1;
          assert.isTrue(consumed <= allowance);
        }
        assert.equal(consumed, allowance);
        // 尽きたら false を返し、エントリも残さない
        assert.isFalse(consumeUnmatchedRequestOk(session, targetRequestId));
        assert.isFalse(session.unmatchedRequestOkAllowances.has(targetRequestId));

        // 他の Request ID の枠は消費の影響を受けない
        if (otherRequestId !== targetRequestId) {
          allowUnmatchedRequestOks(session, otherRequestId, 2);
          assert.isTrue(consumeUnmatchedRequestOk(session, otherRequestId));
          assert.equal(session.unmatchedRequestOkAllowances.get(otherRequestId), 1);
          assert.isTrue(consumeUnmatchedRequestOk(session, otherRequestId));
          assert.isFalse(session.unmatchedRequestOkAllowances.has(otherRequestId));
        }
      },
    ),
  );
});

// ============================================================================
// PBT 9: cancelMalformedTrackPeers
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * "it MUST cancel any corresponding subscription or fetches for that Track from that
 *  publisher and SHOULD deliver an error to the application."
 * 対象 Track の購読と FETCH だけが error 通知付きで closed になり、他 Track のピアは
 * 状態も通知も変わらない。2 回目の検出でも error コールバックは 1 回だけである。
 */
test("cancelMalformedTrackPeers: 対象 Track の購読と FETCH だけを cancel し、他 Track のピアは変えない", () => {
  const peerSpecArb = fc.array(fc.record({ matching: fc.boolean(), isFetcher: fc.boolean() }), {
    maxLength: 6,
  });

  fc.assert(
    fc.property(peerSpecArb, (peerSpecs) => {
      const { session } = createBidiSession();
      const targetKey = fullTrackNameKey(["live"], "video");
      const error = new MalformedTrackError("malformed track");

      /** requestId から error 通知の到達を引くための記録 */
      const subscribersById = new Map<bigint, SubscriberImpl>();
      const fetchersById = new Map<bigint, FetcherImpl>();
      const subscriberErrors = new Map<bigint, Error[]>();
      const fetcherErrors = new Map<bigint, Error[]>();
      const matchingSubscriberIds: bigint[] = [];
      const otherSubscriberIds: bigint[] = [];
      const matchingFetcherIds: bigint[] = [];
      const otherFetcherIds: bigint[] = [];

      // FETCH を先に構築する (対象 Track かどうかで cancel の有無が変わる)
      peerSpecs.forEach((spec, index) => {
        if (!spec.isFetcher) {
          return;
        }
        const requestId = BigInt(index + 1);
        const errors: Error[] = [];
        const fetcher = new FetcherImpl(
          ["live"],
          spec.matching ? "video" : "audio",
          requestId,
          () => {},
          undefined,
          (e) => {
            errors.push(e);
          },
        );
        // SessionImpl と同じ配線: cancel() がストリームと fetchers の掃除を行う
        fetcher.onCancel = () => bidiCancelFetch(session, fetcher);
        fetcherErrors.set(requestId, errors);
        fetchersById.set(requestId, fetcher);
        session.fetchers.set(requestId, fetcher);
        if (spec.matching) {
          matchingFetcherIds.push(requestId);
          return;
        }
        otherFetcherIds.push(requestId);
      });

      // 次に購読を構築する (Track Alias は Request ID と同じ値にして 1 対 1 にする)
      peerSpecs.forEach((spec, index) => {
        if (spec.isFetcher) {
          return;
        }
        const requestId = BigInt(index + 1);
        const errors: Error[] = [];
        const subscriber = new SubscriberImpl(
          ["live"],
          spec.matching ? "video" : "audio",
          requestId,
          requestId,
          () => {},
          undefined,
          undefined,
          (e) => {
            errors.push(e);
          },
        );
        subscriberErrors.set(requestId, errors);
        subscribersById.set(requestId, subscriber);
        session.subscribersByAlias.set(requestId, [subscriber]);
        session.subscribers.set(requestId, subscriber);
        if (spec.matching) {
          matchingSubscriberIds.push(requestId);
          return;
        }
        otherSubscriberIds.push(requestId);
      });

      cancelMalformedTrackPeers(session, targetKey, error);

      // 対象 Track の購読は closed になり、同一の error が 1 回だけ通知される
      for (const requestId of matchingSubscriberIds) {
        assert.equal(subscribersById.get(requestId)?.state, "closed");
        assert.isUndefined(session.subscribers.get(requestId));
        assert.equal(session.subscribersByAlias.get(requestId)?.length ?? 0, 0);
        assert.equal(subscriberErrors.get(requestId)?.length, 1);
        assert.strictEqual(subscriberErrors.get(requestId)?.[0], error);
      }
      // 対象 Track の FETCH も closed になり、同一の error が 1 回だけ通知される
      for (const requestId of matchingFetcherIds) {
        assert.equal(fetchersById.get(requestId)?.state, "closed");
        assert.isUndefined(session.fetchers.get(requestId));
        assert.equal(fetcherErrors.get(requestId)?.length, 1);
        assert.strictEqual(fetcherErrors.get(requestId)?.[0], error);
      }
      // 他 Track のピアは active のままで、error 通知も受けない
      for (const requestId of otherSubscriberIds) {
        assert.equal(subscribersById.get(requestId)?.state, "active");
        assert.isDefined(session.subscribers.get(requestId));
        assert.deepEqual(subscriberErrors.get(requestId), []);
      }
      for (const requestId of otherFetcherIds) {
        assert.equal(fetchersById.get(requestId)?.state, "active");
        assert.isDefined(session.fetchers.get(requestId));
        assert.deepEqual(fetcherErrors.get(requestId), []);
      }

      // 同じ malformed 検出が重なっても error コールバックは増えない
      cancelMalformedTrackPeers(session, targetKey, error);
      for (const requestId of matchingSubscriberIds) {
        assert.equal(subscriberErrors.get(requestId)?.length, 1);
      }
      for (const requestId of matchingFetcherIds) {
        assert.equal(fetcherErrors.get(requestId)?.length, 1);
      }
    }),
  );
});

// ============================================================================
// PBT 10: notifySubscriberFailure
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure):
 * "An endpoint that receives a FIN before all required messages have arrived treats
 *  the request as failed."
 * 失敗を通知するのは、購読が存在し、GOAWAY 未受信で、state が active のときだけである。
 * error コールバックが throw しても state は closed になり、2 回目は何も通知しない。
 */
test("notifySubscriberFailure: active な購読だけに通知して state を closed にし、二重通知しない", () => {
  const failureCaseArb = fc.record({
    registered: fc.boolean(),
    goawayReceived: fc.boolean(),
    alreadyClosed: fc.boolean(),
    callbackThrows: fc.boolean(),
  });

  fc.assert(
    fc.property(failureCaseArb, (failureCase) => {
      const { session } = createBidiSession();
      const requestId = 10n;
      const callbackError = new Error("error callback failed");
      const notifiedErrors: Error[] = [];

      const subscriber = new SubscriberImpl(
        ["live"],
        "video",
        requestId,
        1n,
        () => {},
        undefined,
        () => {},
        (error) => {
          notifiedErrors.push(error);
          if (failureCase.callbackThrows) {
            throw callbackError;
          }
        },
      );
      if (failureCase.registered) {
        session.subscribers.set(requestId, subscriber);
      }
      if (failureCase.alreadyClosed) {
        subscriber.markClosed();
      }
      if (failureCase.goawayReceived) {
        session.goawayReceivedOnRequestStreams.add(requestId);
      }

      const failure = new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
      let thrown: unknown;
      try {
        notifySubscriberFailure(session, requestId, failure);
      } catch (error) {
        thrown = error;
      }

      const shouldNotify =
        failureCase.registered && !failureCase.goawayReceived && !failureCase.alreadyClosed;
      if (shouldNotify) {
        assert.equal(notifiedErrors.length, 1);
        assert.strictEqual(notifiedErrors[0], failure);
        // error コールバックが throw しても state は必ず closed になる
        assert.equal(subscriber.state, "closed");
        if (failureCase.callbackThrows) {
          assert.strictEqual(thrown, callbackError);
        } else {
          assert.isUndefined(thrown);
        }
      } else {
        // 購読不在 / GOAWAY 受信済み / closed では何も起きない
        assert.deepEqual(notifiedErrors, []);
        assert.isUndefined(thrown);
      }

      // 2 回目は state が closed のため、通知も例外も起きない
      let secondThrown: unknown;
      try {
        notifySubscriberFailure(session, requestId, failure);
      } catch (error) {
        secondThrown = error;
      }
      assert.isUndefined(secondThrown);
      assert.equal(notifiedErrors.length, shouldNotify ? 1 : 0);
    }),
  );
});

// ============================================================================
// PBT 11: bidiHandlePublishDone
// ============================================================================

/** PUBLISH_DONE の状態コード (既知のエラー / 非エラー / 未知値を混ぜる) */
const publishDoneStatusCodeArb = fc.oneof(
  fc.constantFrom(0x0n, 0x1n, 0x2n, 0x4n, 0x5n, 0x6n, 0x8n, 0x9n, 0x12n),
  fc.bigInt({ min: 0x20n, max: 0x100n }),
);

/** PUBLISH_DONE の Reason Phrase (UTF-8 のバイト長が文字数と一致する ASCII に限る) */
const reasonPhraseArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0x20, max: 0x7e }), { maxLength: 32 })
  .map((codes) => String.fromCharCode(...codes));

/**
 * draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE) / §13 (Grease):
 * 受信した状態コードは既知の列挙へ正規化して購読へ通知する。未知値は INTERNAL_ERROR
 * として扱われる。エラーを示す状態コードのときだけ error コールバックが呼ばれ、
 * 成功を示す状態コードでは end コールバックだけが呼ばれる。返り値は記録用の情報であり、
 * デコード結果と一致する。
 */
test("bidiHandlePublishDone: 状態コードを正規化して購読へ通知し、記録用の情報を返す", () => {
  const publishDoneArb = fc.record({
    statusCode: publishDoneStatusCodeArb,
    streamCount: fc.bigInt({ min: 0n, max: 1000000n }),
    reasonPhrase: reasonPhraseArb,
  });

  fc.assert(
    fc.property(publishDoneArb, (done) => {
      const payload = encodePublishDonePayload({
        type: MessageType.PUBLISH_DONE,
        statusCode: done.statusCode,
        streamCount: done.streamCount,
        reasonPhrase: done.reasonPhrase,
      });

      const { session } = createBidiSession();
      const requestId = 10n;
      const events: string[] = [];
      let notifiedError: Error | undefined;
      const subscriber = new SubscriberImpl(
        ["live"],
        "video",
        requestId,
        1n,
        () => {},
        undefined,
        () => {
          events.push("end");
        },
        (error) => {
          events.push("error");
          notifiedError = error;
        },
      );
      session.subscribers.set(requestId, subscriber);

      const record = bidiHandlePublishDone(session, payload, requestId);

      // 記録用の情報はデコード結果と一致する
      assert.equal(record.requestId, requestId.toString());
      assert.equal(record.statusCode, done.statusCode);
      assert.equal(record.streamCount, done.streamCount.toString());
      assert.equal(record.reasonPhrase, done.reasonPhrase);

      // 状態コードの正規化結果に応じて error → end の順に通知される
      const normalized = normalizePublishDoneCode(Number(done.statusCode));
      const expectError = isPublishDoneErrorStatus(BigInt(normalized));
      assert.deepEqual(events, expectError ? ["error", "end"] : ["end"]);
      assert.equal(subscriber.state, "closed");
      if (expectError) {
        if (notifiedError === undefined) {
          assert.fail("エラー状態コードで error コールバックが呼ばれなかった");
        }
        assert.isTrue(notifiedError.message.includes(done.reasonPhrase));
      } else {
        assert.isUndefined(notifiedError);
      }

      // 2 通目の PUBLISH_DONE は state が closed のため通知も状態遷移も起きない
      const secondRecord = bidiHandlePublishDone(session, payload, requestId);
      assert.deepEqual(events, expectError ? ["error", "end"] : ["end"]);
      assert.equal(secondRecord.requestId, requestId.toString());
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.9:
 * 購読が特定できない場合は状態を変えず、記録用の情報だけを返す。Request ID が
 * 渡されない経路でも例外にならない。
 */
test("bidiHandlePublishDone: 購読が無い requestId では通知せず記録用の情報だけを返す", () => {
  const publishDoneArb = fc.record({
    statusCode: publishDoneStatusCodeArb,
    streamCount: fc.bigInt({ min: 0n, max: 1000000n }),
    reasonPhrase: reasonPhraseArb,
  });

  fc.assert(
    fc.property(publishDoneArb, requestIdArb, (done, requestId) => {
      const payload = encodePublishDonePayload({
        type: MessageType.PUBLISH_DONE,
        statusCode: done.statusCode,
        streamCount: done.streamCount,
        reasonPhrase: done.reasonPhrase,
      });

      const { session } = createBidiSession();
      // 購読を登録しないまま呼ぶ (未確立・unsubscribe 済みの経路)
      const record = bidiHandlePublishDone(session, payload, requestId);
      assert.equal(record.requestId, requestId.toString());
      assert.equal(record.statusCode, done.statusCode);
      assert.equal(session.subscribers.size, 0);

      // Request ID 省略時は "unknown" として記録する
      const withoutRequestId = bidiHandlePublishDone(session, payload);
      assert.equal(withoutRequestId.requestId, "unknown");
      assert.equal(withoutRequestId.statusCode, done.statusCode);
    }),
  );
});

// ============================================================================
// PBT 12: bidiHandlePublishStateNotify
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY) / §9.20.1:
 * subscribe ロールで受信した許可パラメータは検証通過後にまとめて反映する。
 * 省略されたパラメータは不変であり (「If a parameter is not present, its value is
 * unchanged.」)、応答は送信しない (返り値 true / セッションを閉じない)。
 */
test("bidiHandlePublishStateNotify: subscribe ロールでは許可パラメータを反映し、省略されたパラメータは不変にする", () => {
  fc.assert(
    fc.property(stateNotifyCaseArb, (state) => {
      const { session } = createBidiSession();
      const closeObserver = observeCloseWithError(session);
      const requestId = 10n;
      const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
      session.subscribers.set(requestId, subscriber);

      const accepted = bidiHandlePublishStateNotify(
        session,
        buildStateNotifyPayload(state),
        requestId,
        "subscribe",
      );

      // 応答は送らないが、受理したことを返り値で示す
      assert.isTrue(accepted);
      assert.isUndefined(closeObserver.closed());

      if (state.largest !== undefined) {
        assert.deepEqual(subscriber.largestLocation, state.largest);
      } else {
        assert.isNull(subscriber.largestLocation);
      }
      if (state.forward !== undefined) {
        assert.equal(subscriber.forwardState, state.forward);
      } else {
        // 省略時は不変 (SubscriberImpl の初期値 true)
        assert.isTrue(subscriber.forwardState);
      }
      if (state.filter !== undefined) {
        assert.deepEqual(subscriber.getLocationFilter(), state.filter);
      } else {
        assert.isUndefined(subscriber.getLocationFilter());
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * "If a parameter is not present, its value is unchanged."
 * LARGEST_OBJECT だけを運ぶ通知では Forward State と Location Filter を変更しない。
 */
test("bidiHandlePublishStateNotify: LARGEST_OBJECT だけの通知では Forward State と Location Filter を変えない", () => {
  const initialStateArb = fc.record({
    forward: fc.boolean(),
    filter: fc.option(locationFilterArb, { nil: undefined }),
    largest: fc.option(locationArb, { nil: undefined }),
  });

  fc.assert(
    fc.property(initialStateArb, locationArb, (initial, nextLargest) => {
      const { session } = createBidiSession();
      const closeObserver = observeCloseWithError(session);
      const requestId = 10n;
      const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
      subscriber.setForwardState(initial.forward);
      if (initial.filter !== undefined) {
        subscriber.setLocationFilter(initial.filter);
      }
      if (initial.largest !== undefined) {
        subscriber.setLargestLocation(initial.largest);
      }
      session.subscribers.set(requestId, subscriber);

      const accepted = bidiHandlePublishStateNotify(
        session,
        buildStateNotifyPayload({
          largest: nextLargest,
          forward: undefined,
          filter: undefined,
        }),
        requestId,
        "subscribe",
      );

      assert.isTrue(accepted);
      assert.isUndefined(closeObserver.closed());
      // LARGEST_OBJECT だけが反映される
      assert.deepEqual(subscriber.largestLocation, nextLargest);
      assert.equal(subscriber.forwardState, initial.forward);
      assert.deepEqual(subscriber.getLocationFilter(), initial.filter);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.10 / §3.3.1:
 * 保持値と等価な LOCATION_FILTER が再報告されても再適用しない。相対指定の再解決で
 * 開始位置が前進し、受信済み範囲の Object を破棄することを防ぐ。
 * 相対フィルタ { startGroup: 1 } は largest = {g0, 0} で開始 Group g0 に解決されるため、
 * LARGEST_OBJECT を g1 (> g0) へ進めた後も Group g0 の Object が配信される。
 */
test("bidiHandlePublishStateNotify: 同じ LOCATION_FILTER の再報告では相対フィルタの開始位置が前進しない", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 5000n }),
      fc.bigInt({ min: 1n, max: 100n }),
      fc.bigInt({ min: 0n, max: 5000n }),
      (startGroup, groupDelta, nextObject) => {
        const { session } = createBidiSession();
        const requestId = 10n;
        const delivered: bigint[] = [];
        const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, (object) => {
          delivered.push(object.groupId);
        });
        // 購読確立時に相対フィルタを largest = {startGroup, 0} で解決しておく
        subscriber.setLargestLocation({ group: startGroup, object: 0n });
        subscriber.setLocationFilter({ startGroup: 1n });
        session.subscribers.set(requestId, subscriber);

        const accepted = bidiHandlePublishStateNotify(
          session,
          buildStateNotifyPayload({
            largest: { group: startGroup + groupDelta, object: nextObject },
            forward: undefined,
            filter: { startGroup: 1n },
          }),
          requestId,
          "subscribe",
        );

        assert.isTrue(accepted);
        // LARGEST_OBJECT は反映される
        assert.deepEqual(subscriber.largestLocation, {
          group: startGroup + groupDelta,
          object: nextObject,
        });
        // 開始位置は解決済みの Group startGroup のままである
        subscriber.handleObject({
          groupId: startGroup,
          objectId: 0n,
          status: ObjectStatus.NORMAL,
          payload: new Uint8Array(),
        });
        assert.deepEqual(delivered, [startGroup]);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * "An endpoint that receives a PUBLISH_STATE_NOTIFY for any other request type, or from
 *  the subscriber, MUST close the session with a PROTOCOL_VIOLATION."
 * subscribe ロール以外では、購読の状態を一切変更せずにセッションを閉じる。
 */
test("bidiHandlePublishStateNotify: subscribe ロール以外では状態を変えずに PROTOCOL_VIOLATION で閉じる", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("publish" as const, "fetch" as const),
      stateNotifyCaseArb,
      (role, state) => {
        const { session } = createBidiSession();
        const closeObserver = observeCloseWithError(session);
        const requestId = 10n;
        const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
        session.subscribers.set(requestId, subscriber);

        const accepted = bidiHandlePublishStateNotify(
          session,
          buildStateNotifyPayload(state),
          requestId,
          role,
        );

        assert.isFalse(accepted);
        const closed = closeObserver.closed();
        if (closed === undefined) {
          assert.fail("subscribe ロール以外でセッションが閉じなかった");
        }
        assert.equal(closed.code, SessionErrorCode.PROTOCOL_VIOLATION);
        // 違反確定後の部分反映は起きない
        assert.isNull(subscriber.largestLocation);
        assert.isTrue(subscriber.forwardState);
        assert.isUndefined(subscriber.getLocationFilter());
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
 * 許可外パラメータを含む PUBLISH_STATE_NOTIFY は PROTOCOL_VIOLATION で閉じる。
 * 反映は検証通過後にまとめて行うため、同時に正当な LARGEST_OBJECT が載っていても
 * 部分反映は起きない。購読が無い場合も検証は行い、不正ワイヤを見逃さない。
 */
test("bidiHandlePublishStateNotify: 許可外パラメータでは部分反映せず PROTOCOL_VIOLATION で閉じる", () => {
  fc.assert(
    fc.property(stateNotifyCaseArb, fc.boolean(), (state, withSubscriber) => {
      const { session } = createBidiSession();
      const closeObserver = observeCloseWithError(session);
      const requestId = 10n;
      const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
      if (withSubscriber) {
        session.subscribers.set(requestId, subscriber);
      }

      // SUBSCRIBER_PRIORITY は PUBLISH_STATE_NOTIFY に許可されない
      const parameters: Parameter[] = [
        ...buildStateNotifyParameters(state),
        {
          type: MessageParameterType.SUBSCRIBER_PRIORITY,
          value: encodeUint8ParameterValue(10, "SUBSCRIBER_PRIORITY"),
        },
      ];
      const payload = encodePublishStateNotifyPayload({
        type: MessageType.PUBLISH_STATE_NOTIFY,
        parameters,
      });

      const accepted = bidiHandlePublishStateNotify(session, payload, requestId, "subscribe");

      assert.isFalse(accepted);
      const closed = closeObserver.closed();
      if (closed === undefined) {
        assert.fail("許可外パラメータでセッションが閉じなかった");
      }
      assert.equal(closed.code, SessionErrorCode.PROTOCOL_VIOLATION);
      // 許可外の型番号がメッセージから読み取れる
      assert.isTrue(closed.message.includes("not allowed in PUBLISH_STATE_NOTIFY"));
      // 正当な LARGEST_OBJECT も反映されない
      assert.isNull(subscriber.largestLocation);
      assert.isTrue(subscriber.forwardState);
      assert.isUndefined(subscriber.getLocationFilter());
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
 * 値域は 0 / 1 であり、範囲外は PROTOCOL_VIOLATION になる。検証は購読への書き込みより
 * 前に全パラメータで行うため、同時に載った LARGEST_OBJECT も反映されない。
 * 呼び出し元 (受信ループ) がセッション終了へ変換するため、ここでは throw を確認する。
 */
test("bidiHandlePublishStateNotify: FORWARD の値域外では部分反映せず ProtocolViolationError になる", () => {
  fc.assert(
    fc.property(stateNotifyCaseArb, fc.integer({ min: 2, max: 255 }), (state, forwardValue) => {
      const { session } = createBidiSession();
      const closeObserver = observeCloseWithError(session);
      const requestId = 10n;
      const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
      session.subscribers.set(requestId, subscriber);

      const parameters: Parameter[] = [
        ...buildStateNotifyParameters({ ...state, forward: undefined }),
        {
          type: MessageParameterType.FORWARD,
          value: encodeUint8ParameterValue(forwardValue, "FORWARD"),
        },
      ];
      const payload = encodePublishStateNotifyPayload({
        type: MessageType.PUBLISH_STATE_NOTIFY,
        parameters,
      });

      assert.throws(
        () => bidiHandlePublishStateNotify(session, payload, requestId, "subscribe"),
        ProtocolViolationError,
      );
      // 値検証は書き込みより前に行われるため、部分反映もセッション終了も起きない
      assert.isUndefined(closeObserver.closed());
      assert.isNull(subscriber.largestLocation);
      assert.isTrue(subscriber.forwardState);
      assert.isUndefined(subscriber.getLocationFilter());
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 購読が存在しない場合でも受理判定 (true) を返し、状態遷移は行わない。
 * ペイロードの検証自体は購読の有無に依存しない。
 */
test("bidiHandlePublishStateNotify: 購読が無い場合も受理して状態遷移しない", () => {
  fc.assert(
    fc.property(stateNotifyCaseArb, requestIdArb, (state, requestId) => {
      const { session } = createBidiSession();
      const closeObserver = observeCloseWithError(session);

      const accepted = bidiHandlePublishStateNotify(
        session,
        buildStateNotifyPayload(state),
        requestId,
        "subscribe",
      );

      assert.isTrue(accepted);
      assert.isUndefined(closeObserver.closed());
      assert.equal(session.subscribers.size, 0);
    }),
  );
});
