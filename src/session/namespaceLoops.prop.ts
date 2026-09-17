/**
 * session/namespaceLoops.ts の Property-Based Tests
 *
 * namespace 系ストリームループ (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS /
 * PUBLISH_NAMESPACE) と保留中 REQUEST_UPDATE の後始末について、任意の
 * メッセージ列・任意の prefix・任意の保留中更新集合で成立する性質を検証する。
 * ストリーム機構は実物 (ReadableStream / WritableStream)、状態は実 Map、
 * メッセージは実ワイヤ (ControlStreamWriter) で encode したフレームであり、
 * ループ起動前に enqueue してから close する (ピア FIN)。
 *
 * 検証する性質:
 * - rejectPendingNamespaceUpdates: 対象 Request ID の保留中更新だけを reject し、
 *   他の Request ID の保留中更新は pending のまま残る (連鎖不変条件)
 * - NAMESPACE / NAMESPACE_DONE の追跡と FIN 時の NAMESPACE_DONE 補完が
 *   active namespace 集合のモデルと一致する (対応する NAMESPACE の無い
 *   NAMESPACE_DONE は PROTOCOL_VIOLATION)
 * - 同一メッセージ列はチャンク分割を変えても同じ結果になる
 * - 任意のメッセージ列でループが終了し、対象 Map のエントリと保留中の更新が
 *   残らない (リーク検査)
 * - REQUEST_UPDATE 応答 (REQUEST_OK / REQUEST_ERROR / 応答未達の FIN) に応じた
 *   prefix 反映と保留中更新の決着が一貫する
 * - 正常なメッセージ列ではセッションを閉じず、対象 Promise を 1 回だけ解決する
 * - 対象が登録されていない Request ID は not found で reject する
 *
 * 対応する単体テストから削除した固定値ケース (本ファイルへ移した):
 * - REQUEST_UPDATE 応答の REQUEST_OK で prefix が更新され pending が解決される
 *   (namespace / tracks ループ)
 * - REQUEST_UPDATE 応答の REQUEST_ERROR で pending が reject され prefix は
 *   更新されない (namespace / tracks ループ)
 * - 応答を待たずにストリームが閉じたら pending が reject される
 *   (namespace / tracks ループ)
 * - namespaceStartNamespaceStreamLoop: ピア FIN で active namespace に
 *   NAMESPACE_DONE を補完し自方向も FIN する
 * - namespaceStartNamespaceStreamLoop: NAMESPACE_DONE 済みの namespace は
 *   FIN で重複補完しない
 * - 正常な NAMESPACE / NAMESPACE_DONE でセッションが閉じない (namespace ループ)
 * - 正常な PUBLISH_SKIPPED でセッションが閉じない (tracks ループ)
 * - 正常な REQUEST_OK で解決されセッションが閉じない (publication ループ)
 *
 * draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure) /
 * §9.2 (GOAWAY) / §9.3 (REQUEST_OK) / §9.5.1 (応答前にストリームが閉じた場合) /
 * §9.5.2 (Updating Namespace Subscriptions) / §9.14 (PUBLISH_NAMESPACE) /
 * §9.15 (SUBSCRIBE_NAMESPACE) / §9.16 (NAMESPACE) / §9.17 (NAMESPACE_DONE) /
 * §9.18 (SUBSCRIBE_TRACKS) / §9.19 (PUBLISH_SKIPPED)
 *
 * 前方一致 (matchNamespacePrefix / namespacePrefixesOverlap /
 * validateNamespacePrefixUpdate) は本モジュールからは使われず (SUBSCRIBE_TRACKS の
 * PUBLISH マッチングは bidi 側)、src/session/params.prop.ts が既に性質を
 * 検証しているため本ファイルでは重複して扱わない。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { MessageType, MessageParameterType } from "../message";
import {
  encodeGoawayPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "../message/session";
import {
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishSkippedPayload,
} from "../message/namespace";
import { createTrackNamespace } from "../message/parameter";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { RequestErrorCode, SessionErrorCode, type SessionError } from "../error";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  namespaceStartNamespaceStreamLoop,
  namespaceStartPublicationStreamLoop,
  namespaceStartTracksStreamLoop,
  rejectPendingNamespaceUpdates,
} from "./namespaceLoops";
import type { SessionInternal } from "./types";

// ============================================================================
// ループ種別と Arbitrary 定義
// ============================================================================

/** ループ種別 (namespace = SUBSCRIBE_NAMESPACE、tracks = SUBSCRIBE_TRACKS、publication = PUBLISH_NAMESPACE) */
type LoopKind = "namespace" | "tracks" | "publication";

/** namespace 系 3 ループ */
const LOOP_KINDS: readonly LoopKind[] = ["namespace", "tracks", "publication"];

/** subscription 系 2 ループ (publication は REQUEST_UPDATE を扱わない) */
const SUBSCRIPTION_LOOP_KINDS: readonly LoopKind[] = ["namespace", "tracks"];

/** ループ対象 (購読 / 公開) の Request ID */
const REQUEST_ID = 10n;

/** 別 Request ID の保留中更新 (誤って巻き込まれないことの観測用) */
const DECOY_REQUEST_ID = 100n;

/**
 * Track Namespace のフィールド
 *
 * draft-ietf-moq-transport-21 §8.7:
 * "Each Track Namespace Field Value MUST contain at least one byte."
 * 空フィールドは encode 時に弾かれるため生成しない。
 */
const namespaceFieldArb: fc.Arbitrary<string> = fc.constantFrom("a", "b", "live", "sports", "x1");

/** NAMESPACE / NAMESPACE_DONE が運ぶ Track Namespace Suffix */
const namespaceSuffixArb: fc.Arbitrary<string[]> = fc.array(namespaceFieldArb, {
  minLength: 1,
  maxLength: 3,
});

/** PUBLISH_SKIPPED が運ぶ Track Name */
const trackNameArb: fc.Arbitrary<string> = fc.constantFrom("track1", "game", "video");

/** 重複と衝突を意図的に作るための suffix のプール (添字 0..2 で選ぶ) */
const namespaceSuffixPoolArb: fc.Arbitrary<string[][]> = fc.tuple(
  namespaceSuffixArb,
  namespaceSuffixArb,
  namespaceSuffixArb,
);

/** プールの添字で suffix を選ぶ NAMESPACE / NAMESPACE_DONE のイベント */
interface NamespaceEvent {
  done: boolean;
  suffixIndex: number;
}

/** NAMESPACE (2) と NAMESPACE_DONE (1) の比率を偏らせ、追跡状態が伸びる列を増やす */
const namespaceEventArb: fc.Arbitrary<NamespaceEvent> = fc.record({
  done: fc.oneof(
    { weight: 2, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
  suffixIndex: fc.integer({ min: 0, max: 2 }),
});

/** 購読 / 公開の Track Namespace Prefix (namespaceLoops 内では状態フィールドとしてのみ扱われる) */
const prefixArb: fc.Arbitrary<string[]> = fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 });

// ============================================================================
// 制御メッセージの組み立て (実ワイヤ encode)
// ============================================================================

/** 制御メッセージ 1 件 (type と payload) */
interface ControlMessageSpec {
  type: number;
  payload: Uint8Array;
}

/**
 * 制御メッセージ 1 件をワイヤフレームへ変換する
 *
 * ControlStreamWriter は状態を持たないが、テスト間でインスタンスを共有しない
 * (実装が状態を持ち込んだ場合にテストが巻き添えで壊れないようにするため)。
 */
function frameOf(message: ControlMessageSpec): Uint8Array {
  return new ControlStreamWriter().encode(message.type, message.payload);
}

/** 制御メッセージ列をワイヤフレーム列へ変換する */
function framesOf(messages: readonly ControlMessageSpec[]): Uint8Array[] {
  return messages.map((message) => frameOf(message));
}

/** REQUEST_OK (パラメータ / Track Properties 無し) */
function requestOkSpec(): ControlMessageSpec {
  return {
    type: MessageType.REQUEST_OK,
    payload: encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  };
}

/** FORWARD パラメータ付き REQUEST_OK (初期 OK のスコープ違反) */
function requestOkWithForwardSpec(): ControlMessageSpec {
  return {
    type: MessageType.REQUEST_OK,
    payload: encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
      trackProperties: [],
    }),
  };
}

/** Track Properties 非空の REQUEST_OK (空必須違反) */
function requestOkWithTrackPropertiesSpec(): ControlMessageSpec {
  return {
    type: MessageType.REQUEST_OK,
    payload: encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [{ id: 0n, value: 1n }],
    }),
  };
}

/** NAMESPACE / NAMESPACE_DONE */
function namespaceSpec(suffix: string[], done: boolean): ControlMessageSpec {
  const trackNamespaceSuffix = createTrackNamespace(suffix);
  if (done) {
    return {
      type: MessageType.NAMESPACE_DONE,
      payload: encodeNamespaceDonePayload({
        type: MessageType.NAMESPACE_DONE,
        trackNamespaceSuffix,
      }),
    };
  }
  return {
    type: MessageType.NAMESPACE,
    payload: encodeNamespacePayload({ type: MessageType.NAMESPACE, trackNamespaceSuffix }),
  };
}

/** REQUEST_ERROR (PREFIX_OVERLAP) */
function requestErrorSpec(reasonPhrase: string): ControlMessageSpec {
  return {
    type: MessageType.REQUEST_ERROR,
    payload: encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(RequestErrorCode.PREFIX_OVERLAP),
      reasonPhrase,
      retryInterval: 0n,
    }),
  };
}

/** GOAWAY */
function goawaySpec(newSessionUri: string): ControlMessageSpec {
  return {
    type: MessageType.GOAWAY,
    payload: encodeGoawayPayload({ type: MessageType.GOAWAY, newSessionUri, timeout: 0n }),
  };
}

/** PUBLISH_SKIPPED */
function publishSkippedSpec(suffix: string[], trackName: string): ControlMessageSpec {
  return {
    type: MessageType.PUBLISH_SKIPPED,
    payload: encodePublishSkippedPayload({
      type: MessageType.PUBLISH_SKIPPED,
      trackNamespaceSuffix: createTrackNamespace(suffix),
      trackName: new TextEncoder().encode(trackName),
    }),
  };
}

/**
 * ループに注入する任意の制御メッセージ
 *
 * 正常系 (REQUEST_OK / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED) と異常系
 * (スコープ違反 / Track Properties 違反 / REQUEST_ERROR / 未知 Type) を混在させ、
 * 確立前の拒否・確立後の違反・後始末の各経路を網羅する。
 */
const controlMessageArb: fc.Arbitrary<ControlMessageSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(requestOkSpec()) },
  { weight: 1, arbitrary: fc.constant(requestOkWithForwardSpec()) },
  { weight: 1, arbitrary: fc.constant(requestOkWithTrackPropertiesSpec()) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("prefix overlap", "denied", "x")
      .map((reasonPhrase) => requestErrorSpec(reasonPhrase)),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("", "moqt://new.example.com")
      .map((newSessionUri) => goawaySpec(newSessionUri)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.boolean(), namespaceSuffixArb)
      .map(([done, suffix]) => namespaceSpec(suffix, done)),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(namespaceSuffixArb, trackNameArb)
      .map(([suffix, trackName]) => publishSkippedSpec(suffix, trackName)),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        // ループが扱う Type (0x02 / 0x05 / 0x07 / 0x08 / 0x0e / 0x0f / 0x10) 以外
        fc.constantFrom(0x00, 0x01, 0x09, 0x1f, 0x7f, 0xff),
        fc.uint8Array({ maxLength: 8 }),
      )
      .map(([type, payload]) => ({ type, payload: new Uint8Array(payload) })),
  },
);

// ============================================================================
// テストハーネス (実 W3C ストリーム + 実 Map)
// ============================================================================

/** ループ対象 (購読 / 公開) の構造。3 ループの対象を 1 つの形で扱う */
interface LoopTargetState {
  callbacks: {
    onNamespace?: (suffix: string[]) => void;
    onNamespaceDone?: (suffix: string[]) => void;
    onPublishSkipped?: (suffix: string[], trackName: string) => void;
    goaway?: (uri: string) => void;
    error?: (error: Error) => void;
  };
  state: "active" | "pending" | "closed";
  namespacePrefix: string[];
  pendingPrefix?: string[] | undefined;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** 保留中の REQUEST_UPDATE のエントリ (bidi.ts の PendingRequestUpdate と同形) */
interface PendingRequestUpdateEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  targetRequestId: bigint;
}

/** 保留中の REQUEST_UPDATE 1 件の観測結果 */
interface PendingUpdateObservation {
  /** pendingRequestUpdate のキー (REQUEST_UPDATE の Request ID) */
  updateKey: bigint;
  resolvedCount: number;
  rejections: Error[];
  /** ループ終了後も pendingRequestUpdate に残っていたか */
  remaining: boolean;
}

/** ループ 1 回分の観測結果 */
interface LoopOutcome {
  /** 購読 / 公開の Promise が解決された回数 */
  targetResolveCount: number;
  /** 購読 / 公開の Promise が reject された回数 */
  targetRejectCount: number;
  targetRejections: Error[];
  /** session.closeWithError の呼び出し回数 */
  closeCount: number;
  /** session.closeWithError に渡された最後のエラー */
  closedError: SessionError | undefined;
  namespaceSuffixes: string[][];
  namespaceDoneSuffixes: string[][];
  publishSkipped: { suffix: string[]; trackName: string }[];
  goawayUris: string[];
  errorNotifications: Error[];
  pendingUpdates: PendingUpdateObservation[];
  /** ループ終了時の対象 state */
  targetState: string;
  /** ループ終了時に対象が Map から削除されていたか */
  targetRemovedFromMap: boolean;
  namespacePrefix: string[];
  pendingPrefix: string[] | undefined;
  writerClosed: boolean;
  writerAborted: boolean;
  /** ループが読み取ったメッセージ数 (debug 記録の件数) */
  debugCount: number;
}

/** ループ 1 回分の実行オプション */
interface LoopRunOptions {
  /** ループ対象の Request ID (既定は REQUEST_ID) */
  requestId?: bigint;
  /** ループ対象を Map へ登録するか (false は対象が無い Request ID の経路を再現する) */
  registerTarget?: boolean;
  /** ループ開始時の state (アプリからの unsubscribe 相当を再現する) */
  initialState?: "active" | "pending" | "closed";
  /** 反映済みの Track Namespace Prefix */
  namespacePrefix?: string[];
  /**
   * 保留中の REQUEST_UPDATE を登録する。requestId がループ対象と一致する場合は
   * 送信中の新 prefix として pendingPrefix も設定する (update() と同じ
   * 「pendingPrefix と pending エントリは対」の状態)。
   */
  pendingRequests?: readonly { requestId: bigint; pendingPrefix?: string[] }[];
}

/**
 * ループ種別に対応する namespace 系ストリームループを起動する
 *
 * 3 ループの入口はそれぞれ別関数のため、鏡写しの性質はここで 1 箇所にまとめて
 * 呼び分ける。resolve の値そのものは検証しないため unknown で受ける。
 */
function startLoop(
  kind: LoopKind,
  session: SessionInternal,
  requestId: bigint,
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
): Promise<void> {
  if (kind === "namespace") {
    return namespaceStartNamespaceStreamLoop(session, requestId, resolve, reject);
  }
  if (kind === "tracks") {
    return namespaceStartTracksStreamLoop(session, requestId, resolve, reject);
  }
  return namespaceStartPublicationStreamLoop(session, requestId, resolve, reject);
}

/**
 * namespace 系ループを 1 回転がし、観測結果を返す
 *
 * メッセージ列はループ起動前に enqueue してから close する (ピア FIN)。
 * ReadableStream がキューに保持するため、ループは enqueue 順に read し、
 * 実行順序が生成データだけで決まる (同じ入力なら常に同じ結果になる)。
 */
async function runNamespaceLoop(
  kind: LoopKind,
  frames: readonly Uint8Array[],
  options: LoopRunOptions = {},
): Promise<LoopOutcome> {
  const requestId = options.requestId ?? REQUEST_ID;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  for (const frame of frames) {
    readableController.enqueue(frame);
  }
  readableController.close();
  const streamReader = readable.getReader();
  const controlReader = new ControlStreamReader();

  // 送信方向の FIN / RESET を観測する (writer.close() / abort() の到達)
  const writerEvents: string[] = [];
  const writable = new WritableStream<Uint8Array>({
    close() {
      writerEvents.push("close");
    },
    abort() {
      writerEvents.push("abort");
    },
  });
  const writer = writable.getWriter();

  const namespaceSuffixes: string[][] = [];
  const namespaceDoneSuffixes: string[][] = [];
  const publishSkipped: { suffix: string[]; trackName: string }[] = [];
  const goawayUris: string[] = [];
  const errorNotifications: Error[] = [];
  let debugCount = 0;

  const target: LoopTargetState = {
    callbacks: {
      onNamespace: (suffix) => {
        namespaceSuffixes.push(suffix);
      },
      onNamespaceDone: (suffix) => {
        namespaceDoneSuffixes.push(suffix);
      },
      onPublishSkipped: (suffix, trackName) => {
        publishSkipped.push({ suffix, trackName });
      },
      goaway: (uri) => {
        goawayUris.push(uri);
      },
      error: (error) => {
        errorNotifications.push(error);
      },
    },
    // publication は応答待ちの "pending" から始まり、それ以外は確立済みから始める
    state: options.initialState ?? (kind === "publication" ? "pending" : "active"),
    namespacePrefix: options.namespacePrefix ?? ["live"],
    streamReader,
    controlReader,
    writer,
  };

  // 保留中の REQUEST_UPDATE (実 Map)。キーは REQUEST_UPDATE の Request ID
  const pendingRequestUpdate = new Map<bigint, PendingRequestUpdateEntry>();
  const pendingUpdates: PendingUpdateObservation[] = [];
  let nextUpdateKey = 1000n;
  for (const request of options.pendingRequests ?? []) {
    const updateKey = nextUpdateKey;
    nextUpdateKey += 1n;
    const observation: PendingUpdateObservation = {
      updateKey,
      resolvedCount: 0,
      rejections: [],
      remaining: false,
    };
    pendingUpdates.push(observation);
    pendingRequestUpdate.set(updateKey, {
      resolve: () => {
        observation.resolvedCount += 1;
      },
      reject: (error) => {
        observation.rejections.push(error);
      },
      targetRequestId: request.requestId,
    });
    if (request.requestId === requestId && request.pendingPrefix !== undefined) {
      target.pendingPrefix = request.pendingPrefix;
    }
  }

  const namespaceSubscriptions = new Map<bigint, unknown>();
  const tracksSubscriptions = new Map<bigint, unknown>();
  const namespacePublications = new Map<bigint, unknown>();
  let targetMap: Map<bigint, unknown>;
  if (kind === "namespace") {
    targetMap = namespaceSubscriptions;
  } else if (kind === "tracks") {
    targetMap = tracksSubscriptions;
  } else {
    targetMap = namespacePublications;
  }
  if (options.registerTarget ?? true) {
    targetMap.set(requestId, target);
  }

  let closeCount = 0;
  let closedError: SessionError | undefined;

  const session = {
    namespaceSubscriptions,
    tracksSubscriptions,
    namespacePublications,
    pendingRequestUpdate,
    goawayReceivedOnRequestStreams: new Set<bigint>(),
    callbacks: {
      debug: () => {
        debugCount += 1;
      },
    },
    closeWithError: (error: SessionError): void => {
      closeCount += 1;
      closedError = error;
      // SessionImpl.closeWithError → close() → rejectPendingRequests と同じく、
      // セッション終了時は保留中の REQUEST_UPDATE を汎用エラーで reject する。
      // この連鎖を再現しないと「ループ終了後に pending が残らない」性質を
      // 検証できない (namespaceLoops 側は close 経路で pending を触らない)。
      for (const pending of pendingRequestUpdate.values()) {
        pending.reject(new Error("session closed"));
      }
      pendingRequestUpdate.clear();
    },
    createNamespaceSubscription: () => ({
      state: "active",
      unsubscribe: async () => {},
      update: async () => {},
    }),
    createTracksSubscription: () => ({
      state: "active",
      unsubscribe: async () => {},
      update: async () => {},
    }),
    createNamespacePublication: () => ({
      state: "active",
      unsubscribe: async () => {},
    }),
  } as unknown as SessionInternal;

  const targetResolutions: unknown[] = [];
  const targetRejections: Error[] = [];
  await startLoop(
    kind,
    session,
    requestId,
    (value) => {
      targetResolutions.push(value);
    },
    (error) => {
      targetRejections.push(error);
    },
  );

  for (const observation of pendingUpdates) {
    observation.remaining = pendingRequestUpdate.has(observation.updateKey);
  }

  return {
    targetResolveCount: targetResolutions.length,
    targetRejectCount: targetRejections.length,
    targetRejections,
    closeCount,
    closedError,
    namespaceSuffixes,
    namespaceDoneSuffixes,
    publishSkipped,
    goawayUris,
    errorNotifications,
    pendingUpdates,
    targetState: target.state,
    targetRemovedFromMap: !targetMap.has(requestId),
    namespacePrefix: target.namespacePrefix,
    pendingPrefix: target.pendingPrefix,
    writerClosed: writerEvents.includes("close"),
    writerAborted: writerEvents.includes("abort"),
    debugCount,
  };
}

/** チャンク分割の比較に使う観測値 (結果に影響する項目だけを抜き出す) */
function outcomeSnapshot(outcome: LoopOutcome): Record<string, unknown> {
  return {
    targetResolveCount: outcome.targetResolveCount,
    targetRejectCount: outcome.targetRejectCount,
    targetRejectedMessages: outcome.targetRejections.map((error) => error.message),
    closeCount: outcome.closeCount,
    closedErrorCode: outcome.closedError?.code,
    closedErrorMessage: outcome.closedError?.message,
    namespaceSuffixes: outcome.namespaceSuffixes,
    namespaceDoneSuffixes: outcome.namespaceDoneSuffixes,
    publishSkipped: outcome.publishSkipped,
    goawayUris: outcome.goawayUris,
    errorNotificationMessages: outcome.errorNotifications.map((error) => error.message),
    targetState: outcome.targetState,
    targetRemovedFromMap: outcome.targetRemovedFromMap,
    writerClosed: outcome.writerClosed,
    writerAborted: outcome.writerAborted,
    debugCount: outcome.debugCount,
  };
}

/** プールから suffix を取り出す (生成側の添字は 0..2 に固定している) */
function suffixAt(pool: readonly string[][], index: number): string[] {
  const suffix = pool[index];
  if (suffix === undefined) {
    // noUncheckedIndexedAccess のための防御。黙って空 suffix を返さず失敗させる
    throw new Error(`namespace suffix pool index out of range: ${String(index)}`);
  }
  return suffix;
}

/** NAMESPACE / NAMESPACE_DONE のイベント列をワイヤフレーム列へ変換する (先頭は確立応答) */
function namespaceEventFrames(
  pool: readonly string[][],
  events: readonly NamespaceEvent[],
): Uint8Array[] {
  return [
    frameOf(requestOkSpec()),
    ...events.map((event) => frameOf(namespaceSpec(suffixAt(pool, event.suffixIndex), event.done))),
  ];
}

/**
 * ループ種別ごとの正常なメッセージ列
 *
 * 先頭は確立応答の REQUEST_OK、以降はそのループが確立後に受理する通知メッセージ。
 * PUBLISH_NAMESPACE は REQUEST_OK 以外の応答メッセージを持たない (§9.14)。
 */
function validSequenceArb(kind: LoopKind): fc.Arbitrary<ControlMessageSpec[]> {
  if (kind === "tracks") {
    return fc
      .array(fc.tuple(namespaceSuffixArb, trackNameArb), { maxLength: 4 })
      .map((entries) => [
        requestOkSpec(),
        ...entries.map(([suffix, trackName]) => publishSkippedSpec(suffix, trackName)),
      ]);
  }
  if (kind === "publication") {
    return fc.constant([requestOkSpec()]);
  }
  return fc
    .array(namespaceSuffixArb, { maxLength: 4 })
    .map((suffixes) => [
      requestOkSpec(),
      ...suffixes.map((suffix) => namespaceSpec(suffix, false)),
    ]);
}

// ============================================================================
// PBT 1: rejectPendingNamespaceUpdates の連鎖不変条件
// ============================================================================

test("rejectPendingNamespaceUpdates: 対象 Request ID の保留中更新だけを reject し、他は pending のまま残す", () => {
  fc.assert(
    fc.property(
      // (更新 ID、対象 Request ID) の列。同じ更新 ID は後勝ちで Map が上書きされる
      fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 5n }), fc.bigInt({ min: 0n, max: 5n })), {
        maxLength: 8,
      }),
      fc.bigInt({ min: 0n, max: 5n }),
      fc.boolean(),
      (entries, targetRequestId, hasPendingPrefix) => {
        const pendingRequestUpdate = new Map<bigint, PendingRequestUpdateEntry>();
        const observations = new Map<bigint, { resolvedCount: number; rejections: Error[] }>();
        for (const [updateKey, entryRequestId] of entries) {
          const observation = { resolvedCount: 0, rejections: [] as Error[] };
          observations.set(updateKey, observation);
          pendingRequestUpdate.set(updateKey, {
            resolve: () => {
              observation.resolvedCount += 1;
            },
            reject: (error) => {
              observation.rejections.push(error);
            },
            targetRequestId: entryRequestId,
          });
        }

        // 期待値は呼び出し前の Map の中身から独立に計算する
        const matchingKeys: bigint[] = [];
        const remainingKeys: bigint[] = [];
        for (const [updateKey, entry] of pendingRequestUpdate) {
          if (entry.targetRequestId === targetRequestId) {
            matchingKeys.push(updateKey);
          } else {
            remainingKeys.push(updateKey);
          }
        }

        const subscription = {
          callbacks: {},
          state: "active" as const,
          namespacePrefix: ["live"],
          pendingPrefix: hasPendingPrefix ? ["live", "sports"] : undefined,
        };
        const error = new Error("request update rejected by test");

        // session は pendingRequestUpdate しか参照しないため、そのフィールドだけを持つ
        // 実オブジェクトを SessionInternal として渡す
        rejectPendingNamespaceUpdates(
          { pendingRequestUpdate } as unknown as SessionInternal,
          targetRequestId,
          subscription,
          error,
        );

        // キー集合の差分が期待どおりである (reject 済みエントリが残らない)
        const keysAfterCall = [...pendingRequestUpdate.keys()];
        assert.deepEqual(
          [...keysAfterCall].sort((a, b) => (a < b ? -1 : 1)),
          [...remainingKeys].sort((a, b) => (a < b ? -1 : 1)),
        );
        assert.equal(keysAfterCall.length, pendingRequestUpdate.size);

        // 対象の Request ID のエントリだけが、渡したエラーそのもので reject される
        for (const updateKey of matchingKeys) {
          const observation = observations.get(updateKey);
          assert.isDefined(observation);
          assert.equal(observation!.resolvedCount, 0);
          assert.equal(observation!.rejections.length, 1);
          assert.strictEqual(observation!.rejections[0], error);
        }
        // 他の Request ID のエントリは pending のまま残る (解決も棄却もされない)
        for (const updateKey of remainingKeys) {
          const observation = observations.get(updateKey);
          assert.isDefined(observation);
          assert.equal(observation!.resolvedCount, 0);
          assert.deepEqual(observation!.rejections, []);
        }
        // pendingPrefix は「対象の保留中更新が存在した」ときだけクリアされる
        if (matchingKeys.length > 0) {
          assert.isUndefined(subscription.pendingPrefix);
        } else {
          assert.deepEqual(
            subscription.pendingPrefix,
            hasPendingPrefix ? ["live", "sports"] : undefined,
          );
        }
      },
    ),
  );
});

// ============================================================================
// PBT 2: NAMESPACE / NAMESPACE_DONE の追跡 (active 集合モデル)
// ============================================================================

test("namespaceStartNamespaceStreamLoop: NAMESPACE / NAMESPACE_DONE の追跡と FIN 補完が active 集合モデルと一致する", async () => {
  await fc.assert(
    fc.asyncProperty(
      namespaceSuffixPoolArb,
      fc.array(namespaceEventArb, { maxLength: 8 }),
      async (pool, events) => {
        // 実装と同じ「JSON 文字列をキーにした active 集合」を独立にモデル化する。
        // Map は既存キーの set で挿入位置を変えず、delete 後の再 set で末尾へ移るため、
        // 配列でも同じ規則 (既存なら追加しない / 削除してから末尾へ追加) を再現する。
        const seenKeys = new Set<string>();
        const activeEntries: { key: string; suffix: string[] }[] = [];
        const expectedNamespaceSuffixes: string[][] = [];
        const expectedDoneSuffixes: string[][] = [];
        let violationSuffix: string[] | undefined;

        for (const event of events) {
          const suffix = suffixAt(pool, event.suffixIndex);
          const key = JSON.stringify(suffix);
          if (!event.done) {
            // §9.16: NAMESPACE は active へ追加し、アプリへ通知する
            seenKeys.add(key);
            if (!activeEntries.some((entry) => entry.key === key)) {
              activeEntries.push({ key, suffix });
            }
            expectedNamespaceSuffixes.push(suffix);
            continue;
          }
          // §9.17: 対応する NAMESPACE の無い NAMESPACE_DONE は PROTOCOL_VIOLATION
          // であり、その時点でループが終了する (以降のメッセージは処理されない)
          if (!seenKeys.has(key)) {
            violationSuffix = suffix;
            break;
          }
          expectedDoneSuffixes.push(suffix);
          const activeIndex = activeEntries.findIndex((entry) => entry.key === key);
          if (activeIndex !== -1) {
            activeEntries.splice(activeIndex, 1);
          }
        }
        if (violationSuffix === undefined) {
          // §9.15: FIN 検出時は残っている active namespace へ NAMESPACE_DONE を
          // 1 回ずつ補完する (明示的な NAMESPACE_DONE 済みの suffix は残っていない)
          for (const entry of activeEntries) {
            expectedDoneSuffixes.push(entry.suffix);
          }
        }

        // 違反以降のイベントもフレームとして enqueue するが、ループは違反を検出した
        // 時点で return するため読み取られない (期待値側も違反で打ち切っている)
        const outcome = await runNamespaceLoop("namespace", namespaceEventFrames(pool, events));

        assert.equal(outcome.targetResolveCount, 1);
        assert.equal(outcome.targetRejectCount, 0);
        assert.deepEqual(outcome.namespaceSuffixes, expectedNamespaceSuffixes);
        assert.deepEqual(outcome.namespaceDoneSuffixes, expectedDoneSuffixes);
        assert.isTrue(outcome.targetRemovedFromMap);
        assert.equal(outcome.targetState, "closed");

        if (violationSuffix === undefined) {
          assert.equal(outcome.closeCount, 0);
          // §6.4.2.2: ピアの FIN を検出したら自方向も FIN で閉じる
          assert.isTrue(outcome.writerClosed);
          return;
        }
        assert.equal(outcome.closeCount, 1);
        assert.isDefined(outcome.closedError);
        assert.equal(outcome.closedError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
        assert.isTrue(outcome.closedError!.message.includes("before corresponding NAMESPACE"));
        // 違反で return するため自方向の FIN には到達しない
        assert.isFalse(outcome.writerClosed);
      },
    ),
  );
});

// ============================================================================
// PBT 3: チャンク分割の不変性
// ============================================================================

/** 連結したバイト列を指定位置で分割する (境界は昇順・重複なしを前提とする) */
function splitFrames(data: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const boundaries: number[] = [0, ...cuts, data.length];
  const chunks: Uint8Array[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    // 添字は 0..boundaries.length-2 に固定しているため undefined にはならない
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? data.length;
    chunks.push(data.slice(start, end));
  }
  return chunks;
}

test("namespaceStartNamespaceStreamLoop: メッセージ列のチャンク分割を変えても結果が変わらない", async () => {
  await fc.assert(
    fc.asyncProperty(
      namespaceSuffixPoolArb,
      fc.array(namespaceEventArb, { maxLength: 6 }),
      fc.array(fc.nat({ max: 200 }), { maxLength: 5 }),
      async (pool, events, rawCuts) => {
        const frames = namespaceEventFrames(pool, events);
        const combined = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
        let offset = 0;
        for (const frame of frames) {
          combined.set(frame, offset);
          offset += frame.length;
        }
        // 任意の境界 (メッセージの途中でも良い) で分割したチャンク列を作る
        const cuts = [...new Set(rawCuts.map((cut) => cut % (combined.length + 1)))].sort(
          (a, b) => a - b,
        );
        const splitChunks = splitFrames(combined, cuts);

        const wholeOutcome = await runNamespaceLoop("namespace", [combined]);
        const splitOutcome = await runNamespaceLoop("namespace", splitChunks);

        // フレーム境界を無視した分割でも、ControlStreamReader のバッファリングにより
        // 同じメッセージ列として処理される (結果の観測値が一致する)
        assert.deepEqual(outcomeSnapshot(splitOutcome), outcomeSnapshot(wholeOutcome));
      },
    ),
  );
});

// ============================================================================
// PBT 4: ループ終了時の後始末 (リーク検査)
// ============================================================================

LOOP_KINDS.forEach((kind) => {
  test(`namespace 系ループ: 任意のメッセージ列でループが終了し対象 Map と保留中の更新が残らない: ${kind} ループ`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(controlMessageArb, { maxLength: 6 }), async (messages) => {
        // 先頭が REQUEST_OK なら確立しうるため、確立後の更新失敗経路も通る。
        // 確立前に保留中更新を持つ状態は update() の契約上あり得ないため、
        // 保留中更新は「先頭が REQUEST_OK」のときだけ登録する。
        const establishesFirst = messages[0]?.type === MessageType.REQUEST_OK;
        // publication は REQUEST_UPDATE を扱わない (§9.14)
        const registersPendingUpdate = establishesFirst && kind !== "publication";

        const outcome = await runNamespaceLoop(kind, framesOf(messages), {
          pendingRequests: registersPendingUpdate
            ? [{ requestId: REQUEST_ID, pendingPrefix: ["live", "sports"] }]
            : [],
        });

        // 購読 / 公開の Promise は高々 1 回しか決着しない (二重解決しない)
        assert.isAtMost(outcome.targetResolveCount, 1);
        assert.isAtMost(outcome.targetRejectCount, 1);
        assert.isFalse(outcome.targetResolveCount > 0 && outcome.targetRejectCount > 0);
        // finally で state が閉じられ、Map からエントリが削除される
        assert.equal(outcome.targetState, "closed");
        assert.isTrue(outcome.targetRemovedFromMap);
        if (outcome.closeCount > 0) {
          assert.isDefined(outcome.closedError);
        }
        for (const observation of outcome.pendingUpdates) {
          // close 経路は session 側の rejectPendingRequests 連鎖、FIN / read 失敗
          // 経路はループ側の rejectPendingNamespaceUpdates が掃除する
          assert.isFalse(observation.remaining);
        }
      }),
    );
  });
});

// ============================================================================
// PBT 5: アプリ cancel 相当のリーク検査
// ============================================================================

LOOP_KINDS.forEach((kind) => {
  test(`namespace 系ループ: unsubscribe 相当で state が閉じている場合はメッセージを処理せず掃除する: ${kind} ループ`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(controlMessageArb, { maxLength: 3 }), async (messages) => {
        // アプリが購読 / 公開を閉じた後 (state="closed") に届いたメッセージは
        // 1 件も処理されない (ループ条件が初期状態で偽になる)
        const outcome = await runNamespaceLoop(kind, framesOf(messages), {
          initialState: "closed",
        });

        assert.equal(outcome.debugCount, 0);
        assert.equal(outcome.targetResolveCount, 0);
        assert.equal(outcome.targetRejectCount, 0);
        assert.equal(outcome.closeCount, 0);
        assert.deepEqual(outcome.namespaceSuffixes, []);
        assert.deepEqual(outcome.namespaceDoneSuffixes, []);
        assert.deepEqual(outcome.publishSkipped, []);
        // finally の closeTarget / cleanup はループ本体が走らなくても実行される
        assert.equal(outcome.targetState, "closed");
        assert.isTrue(outcome.targetRemovedFromMap);
      }),
    );
  });
});

// ============================================================================
// PBT 6: REQUEST_UPDATE 応答による prefix 反映の連鎖不変条件
// ============================================================================

test("subscription 系ループ: REQUEST_UPDATE 応答に応じた prefix 反映と保留中更新の決着が一貫する", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<LoopKind>(...SUBSCRIPTION_LOOP_KINDS),
      prefixArb,
      prefixArb,
      fc.constantFrom<"ok" | "error" | "fin">("ok", "error", "fin"),
      fc.constantFrom("prefix overlap", "denied", "x"),
      async (kind, initialPrefix, newPrefix, response, reasonPhrase) => {
        const frames: Uint8Array[] = [frameOf(requestOkSpec())];
        if (response === "ok") {
          frames.push(frameOf(requestOkSpec()));
        } else if (response === "error") {
          frames.push(frameOf(requestErrorSpec(reasonPhrase)));
        }
        // "fin" は更新応答を挟まずにピアの FIN でストリームが閉じる (§9.5.1)

        const outcome = await runNamespaceLoop(kind, frames, {
          namespacePrefix: initialPrefix,
          pendingRequests: [
            { requestId: REQUEST_ID, pendingPrefix: newPrefix },
            { requestId: DECOY_REQUEST_ID, pendingPrefix: ["other"] },
          ],
        });

        const ownUpdate = outcome.pendingUpdates[0];
        const decoyUpdate = outcome.pendingUpdates[1];
        assert.isDefined(ownUpdate);
        assert.isDefined(decoyUpdate);

        // 確立応答で購読が確立し、セッションは閉じない
        assert.equal(outcome.targetResolveCount, 1);
        assert.equal(outcome.targetRejectCount, 0);
        assert.equal(outcome.closeCount, 0);
        assert.isTrue(outcome.targetRemovedFromMap);

        // 別 Request ID の保留中更新はどの応答でも無傷で残る (連鎖不変条件)
        assert.equal(decoyUpdate!.resolvedCount, 0);
        assert.deepEqual(decoyUpdate!.rejections, []);
        assert.isTrue(decoyUpdate!.remaining);

        if (response === "ok") {
          // §9.5.2: REQUEST_UPDATE_OK は保留中の更新を解決し、新 prefix を反映する
          assert.equal(ownUpdate!.resolvedCount, 1);
          assert.deepEqual(ownUpdate!.rejections, []);
          assert.isFalse(ownUpdate!.remaining);
          assert.deepEqual(outcome.namespacePrefix, newPrefix);
          assert.isUndefined(outcome.pendingPrefix);
          return;
        }

        // 更新失敗 / 応答未達では prefix を反映せず、保留中の更新を失敗させる
        assert.equal(ownUpdate!.resolvedCount, 0);
        assert.isFalse(ownUpdate!.remaining);
        assert.deepEqual(outcome.namespacePrefix, initialPrefix);
        assert.isUndefined(outcome.pendingPrefix);
        assert.equal(ownUpdate!.rejections.length, 1);
        if (response === "error") {
          // §9.5.2: REQUEST_ERROR は理由句を保持した RequestError で reject する
          assert.equal(ownUpdate!.rejections[0]!.message, reasonPhrase);
          return;
        }
        // §9.5.1: 応答を待たずに閉じた場合は共通文言で reject する
        assert.equal(ownUpdate!.rejections[0]!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
      },
    ),
  );
});

// ============================================================================
// PBT 7: 正常なメッセージ列ではセッションを閉じない
// ============================================================================

LOOP_KINDS.forEach((kind) => {
  test(`namespace 系ループ: 正常なメッセージ列ではセッションを閉じず対象 Promise を 1 回だけ解決する: ${kind} ループ`, async () => {
    await fc.assert(
      fc.asyncProperty(validSequenceArb(kind), async (messages) => {
        const outcome = await runNamespaceLoop(kind, framesOf(messages));

        // すべてのメッセージが処理され、PROTOCOL_VIOLATION にもならない
        assert.equal(outcome.debugCount, messages.length);
        assert.equal(outcome.closeCount, 0);
        assert.equal(outcome.errorNotifications.length, 0);
        // 確立応答で 1 回だけ解決し、reject はしない
        assert.equal(outcome.targetResolveCount, 1);
        assert.equal(outcome.targetRejectCount, 0);
        // §6.4.2.2: ピアの FIN を検出したら自方向も FIN で閉じる
        assert.isTrue(outcome.writerClosed);
        assert.isFalse(outcome.writerAborted);
        assert.equal(outcome.targetState, "closed");
        assert.isTrue(outcome.targetRemovedFromMap);
      }),
    );
  });
});

// ============================================================================
// PBT 8: 対象が登録されていない Request ID
// ============================================================================

test("namespace 系ループ: 対象が登録されていない Request ID は not found で reject しセッションを閉じない", async () => {
  const expectedMessages: Record<LoopKind, string> = {
    namespace: "namespace subscription not found",
    tracks: "tracks subscription not found",
    publication: "namespace publication not found",
  };
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<LoopKind>(...LOOP_KINDS),
      fc.bigInt({ min: 0n, max: 1000000n }),
      async (kind, requestId) => {
        const outcome = await runNamespaceLoop(kind, [frameOf(requestOkSpec())], {
          requestId,
          registerTarget: false,
        });

        assert.equal(outcome.targetRejectCount, 1);
        assert.equal(outcome.targetRejections[0]!.message, expectedMessages[kind]);
        assert.equal(outcome.targetResolveCount, 0);
        // ストリームを読まずに return するため、メッセージは 1 件も処理されない
        assert.equal(outcome.debugCount, 0);
        assert.equal(outcome.closeCount, 0);
      },
    ),
  );
});
