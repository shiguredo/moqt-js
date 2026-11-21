/**
 * Publisher 送信系 free function 群
 *
 * SessionImpl の sendObject / sendObjectInternal / closePublisherStream /
 * closePublisherStreamInternal / sendDatagram / getDatagramWriter / sendPublishDone
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-23 §2.2 (Subgroups):
 * "Objects from the same Subgroup MUST NOT be sent on different streams"
 * publisherSendQueues による Promise チェーン排他制御で同一トラックの逐次実行を保証する。
 */

import {
  encodeSubgroupHeader,
  SubgroupHeaderType,
  encodeObjectDatagram,
  encodeObjectFields,
  validatePublisherPriority,
} from "../dataStream";
import { ClosedSubgroupError, DataStreamErrorCode, SessionError, SessionErrorCode } from "../error";
import { MessageType, PublishDoneStatusCode, ObjectStatus } from "../message";
import { encodeVarint, MAX_VARINT } from "../varint";
import {
  type PublisherImpl,
  type SendObjectParamsInternal,
  type SendDatagramParams,
  type ResolvedSubgroup,
} from "../publisher";
import { calculateObjectIdDelta, exceedsDeliveryTimeout } from "./params";
import { isPeerStreamError, isWritableStreamStateError } from "./errors";
import {
  mergeDeliveryTimeoutObjectProperties,
  appendGreaseObjectProperty,
  readDeliveryTimeoutObjectProperties,
} from "../properties";
import type { SessionState } from "./publicTypes";
import type { PublisherStreamState, SessionInternal } from "./types";
import type { BidiSessionInternal } from "./bidi";
import { rememberClosedSubgroup } from "./closedSubgroups";

const PUBLISHER_STREAM_CLOSE_TIMEOUT_MS = 5000;

/** 購読のデータストリームの終了処理と、購読解除時に待機を解く通知。 */
export interface PendingPublisherCloses {
  readonly completions: Set<Promise<void>>;
  readonly cancelled: Promise<void>;
  readonly cancel: () => void;
}

/**
 * datagram 送信用の WritableStream を取得する
 *
 * WebTransport の datagram 送信 API は移行期にあり、実装によって持つ API が異なる。
 *
 * - 現行仕様の `datagrams.createWritable()`: WebKit (Safari 26.4 以降) / Firefox 155 以降
 * - 旧仕様の `datagrams.writable`: Chrome / Firefox 155 以降 (移行期のため両方を持つ)
 *
 * `writable` は現行仕様 (W3C WebTransport CR) から削除済みであり、MDN でも非推奨 +
 * 非標準とされている。そのため現行仕様の `createWritable()` を優先し、持たない実装
 * (Chrome) だけ旧 API の `writable` へフォールバックする。Chrome が `createWritable()`
 * を実装すれば、フォールバックを使わずに現行 API へ切り替わる。
 * どちらも無い実装は datagram を送れないため、原因の分かるエラーを返す。
 *
 * https://w3c.github.io/webtransport/#dom-webtransportdatagramduplexstream-createwritable
 */
function publishGetDatagramSendStream(transport: WebTransport): WritableStream<Uint8Array> {
  const datagrams = transport.datagrams;
  if (typeof datagrams.createWritable === "function") {
    return datagrams.createWritable();
  }
  if (datagrams.writable !== undefined) {
    return datagrams.writable as WritableStream<Uint8Array>;
  }
  throw new Error(
    "WebTransport does not support sending datagrams: neither datagrams.createWritable() nor datagrams.writable is available",
  );
}

/**
 * datagram 送信用 writer を取得する
 *
 * datagram の送信経路は単一の WritableStream であり、writer は 1 つだけロックを
 * 保持できる。最初の呼び出しで getWriter() して保持し、以降は同じ writer を返す。
 */
function publishGetDatagramWriter(
  session: SessionInternal,
): WritableStreamDefaultWriter<Uint8Array> {
  session.datagramWriter ??= publishGetDatagramSendStream(session.transport).getWriter();
  return session.datagramWriter;
}

/**
 * オブジェクトを送信する（Promise チェーン排他制御付き）
 *
 * draft-ietf-moq-transport-23 §2.2:
 * "Objects from the same Subgroup MUST NOT be sent on different streams"
 */
export function publishSendObject(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParamsInternal,
): Promise<void> {
  const providedAtMs = params.providedAtMs ?? performance.now();
  // draft-ietf-moq-transport-23 §3.1.1:
  // "The publisher does not send Objects on a paused subscription"
  // PublisherImpl 側でも同じガードを持つが、内部送信関数を直接呼ぶ経路の
  // 防御としてここでも参照する。
  if (publisher.paused) {
    // draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
    // 送信を見送った Object がある Subgroup は、閉じる時に FIN ではなく RESET が
    // 必要になる。公開経路 (PublisherImpl.sendObject) は guardSend で止まるため
    // ここへは到達しないが、内部送信関数を直接呼ぶ経路の防御として記録する。
    recordQueuedObjectOmission(publisher, params);
    return Promise.resolve();
  }

  const trackAlias = publisher.getTrackAlias();
  // draft-ietf-moq-transport-23 §11.3.1 / §11.2:
  // 不正 ID はローカル API 誤用のため、副作用 (ストリーム生成・統計加算・
  // キュー登録) の前に fail-fast で呼び出し元へ返す。groupId も objectId と
  // 同一契約に揃える (吸収して resolve する旧契約はやめる)。
  // 通知契約のため handleError も呼び、返値 Promise は reject する (解決しない)。
  // priority の null は undefined 同様に既定値 (128) 扱いとする。
  let groupId: bigint;
  try {
    groupId = validateGroupAndObjectIdRange("group id", params.groupId);
    validateGroupAndObjectIdRange("object id", params.objectId);
    // 不正 priority も FIN 等の副作用の前に fail-fast で返す (ID 検証と同位置)。
    validatePublisherPriority(params.priority ?? 128);
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    return Promise.reject(rejection);
  }
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => {
      // 閉じた Subgroup への送信を拒否する
      // draft-ietf-moq-transport-23 §11.3.2
      if (session.closedSubgroups.get(trackAlias)?.has(groupId)) {
        throw new ClosedSubgroupError(
          `subgroup is closed: trackAlias=${trackAlias} groupId=${groupId}`,
          trackAlias,
          groupId,
        );
      }
    })
    .then(() => publishSendObjectInternal(session, publisher, params, providedAtMs))
    .catch((err: unknown) => {
      publisher.handleError(err instanceof Error ? err : new Error(String(err)));
    });
  session.publisherSendQueues.set(trackAlias, currentPromise);
  return currentPromise;
}

/**
 * Group ID / Object ID の値域を検証して bigint で返す
 *
 * draft-ietf-moq-transport-23 §11.3.1 / §11.2:
 * Group ID / Object ID は 0 以上 2^64-1 以下の整数である
 * (varint 上限と一致し、単一出所化のため MAX_VARINT を使う)。
 * 不正値はローカル API 誤用のため throw で呼び出し元へ返す
 * (セッションは閉じない)。
 *
 * @throws Error 非整数・範囲外の場合 (期待値と実際値を含む)
 */
function validateGroupAndObjectIdRange(kind: "group id" | "object id", value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${kind}: ${value}, expected integer 0 to ${MAX_VARINT}`);
  }
  const id = BigInt(value);
  if (id < 0n || id > MAX_VARINT) {
    throw new Error(`invalid ${kind}: ${value}, expected 0 to ${MAX_VARINT}`);
  }
  return id;
}

/**
 * Publisher が closed かどうかを返す
 *
 * `publisher.state` を直接比較すると TypeScript が最初の分岐で "active" に
 * 絞り込み、await 中に markClosed され得ることを表現できない。関数経由で
 * 参照して絞り込みを避ける。
 */
function isPublisherClosed(publisher: PublisherImpl): boolean {
  return publisher.state === "closed";
}

function recordQueuedObjectOmission(
  publisher: PublisherImpl,
  params: SendObjectParamsInternal,
): void {
  publisher.recordOmittedSubgroupObject(params);
  params.onOmitted?.();
}

/** ストリーム生成や Header の書き込みの待ちから戻った時点の購読状態で判定する。 */
function subgroupSendBlockReason(
  publisher: PublisherImpl,
  params: SendObjectParamsInternal,
  objectProperties: Uint8Array | undefined,
  subgroup: ResolvedSubgroup,
  checkedFilterRevision: number,
): string | undefined {
  if (isPublisherClosed(publisher)) return "peer cancelled subscription";
  const paused = publisher.paused;
  if (
    !paused &&
    publisher.matchesSubgroupSendFilters(objectProperties, subgroup, checkedFilterRevision)
  ) {
    return undefined;
  }
  recordQueuedObjectOmission(publisher, params);
  return paused ? "subscription paused" : "subscription filter changed";
}

/**
 * オブジェクト送信の内部実装
 *
 * draft-ietf-moq-transport-23 Section 11.3.1 (Subgroup Header)
 */
export async function publishSendObjectInternal(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParamsInternal,
  providedAtMs = params.providedAtMs ?? performance.now(),
): Promise<void> {
  // draft-ietf-moq-transport-23 §3.1.2 (Subscription State Management):
  // peer のキャンセル後は新しい Subgroup ストリームを開かない。キュー済みの
  // 送信は handlePublishPeerCancel の markClosed 後に実行され得るため、
  // 副作用 (ストリーム生成・統計加算) の前に closed を確認する。
  if (isPublisherClosed(publisher)) {
    return;
  }
  // draft-ietf-moq-transport-23 §3.1.1 (Pausing Subscriptions):
  // "The publisher does not send Objects on a paused subscription"
  // キュー投入時には unpaused でも、待機中に paused (PAUSED=1) へ変わることがある。
  // その場合は送信せず、§11.3.2 の省略として記録する (新しい Subgroup のストリームを
  // paused 中に開かない点でも §3.1.1 と整合する)。
  if (publisher.paused) {
    recordQueuedObjectOmission(publisher, params);
    return;
  }
  const trackAlias = publisher.getTrackAlias();
  // ID・priority 範囲検証は lookup・FIN より前に行う。公開経路では publishSendObject の
  // fail-fast が先に拒否するため、この throw が公開経路の handleError と
  // 二重通知になることはない。
  const groupId = validateGroupAndObjectIdRange("group id", params.groupId);
  const objectId = validateGroupAndObjectIdRange("object id", params.objectId);
  validatePublisherPriority(params.priority ?? 128);

  // draft-ietf-moq-transport-23 §7.1 / §12.1 / §11.3.1:
  // Subgroup Header の種別と Subgroup ID / Publisher Priority を決める。
  // - Subgroup ID がこのストリームの先頭 Object ID と一致する場合は、Header に
  //   Subgroup ID フィールドを持たない FIRST_OBJ_EXT (SUBGROUP_ID_MODE 0b01) を使う。
  // - 一致しない場合 (Group の途中から購読を始めた subscription など) は、
  //   Subgroup ID を明示する EXPLICIT_EXT (SUBGROUP_ID_MODE 0b10) を使う。
  // どちらの値も Track 共通の値であり、同じ (Group, Object) を他の subscription へ
  // 送るときと同じ値になる (PublisherImpl.resolveSubgroupForObject)。
  // resolvedSubgroup が無い場合は、低レベル API から内部送信関数を直接呼んだ経路で
  // あり、この Object を先頭にした Subgroup を開く (従来の挙動)。
  let streamState = session.publisherStreams.get(trackAlias);
  let subgroup = params.resolvedSubgroup ?? {
    groupId,
    objectId,
    subgroupId: objectId,
    publisherPriority: params.priority ?? 128,
    firstObject: true,
  };
  let enqueuedFilterRevision = params.sendFilterRevision;
  const activeSubgroup = streamState?.groupId === groupId ? streamState.subgroup : undefined;
  if (
    activeSubgroup !== undefined &&
    (subgroup.subgroupId !== activeSubgroup.subgroupId ||
      subgroup.publisherPriority !== activeSubgroup.publisherPriority)
  ) {
    // キューに入った Group 切替を見送ると元の Header を引き続き使う。
    // フィルタが同じ世代でも、Header の値が想定と違うときは再評価する。
    subgroup = {
      ...subgroup,
      subgroupId: activeSubgroup.subgroupId,
      publisherPriority: activeSubgroup.publisherPriority,
    };
    enqueuedFilterRevision = undefined;
  }
  let checkedFilterRevision = publisher.getSendFilterRevision();
  const hasDeliveryTimeout =
    params.deliveryTimeout !== undefined || params.subgroupDeliveryTimeout !== undefined;
  let objectProperties = params.properties;
  if (hasDeliveryTimeout) {
    objectProperties =
      params.preparedProperties ??
      mergeDeliveryTimeoutObjectProperties(
        params.properties,
        params.deliveryTimeout,
        params.subgroupDeliveryTimeout,
      );
  }
  // §3.3.1〜3.3.3: キュー待機中に変わったフィルタを、ストリームを開く前に適用する。
  if (!publisher.matchesSubgroupSendFilters(objectProperties, subgroup, enqueuedFilterRevision)) {
    recordQueuedObjectOmission(publisher, params);
    return;
  }
  const { subgroupId, publisherPriority, firstObject } = subgroup;
  const headerType =
    subgroupId === objectId ? SubgroupHeaderType.FIRST_OBJ_EXT : SubgroupHeaderType.EXPLICIT_EXT;

  // 新しい Group または最初のオブジェクト → 新しいストリームを開く
  if (!streamState || streamState.groupId !== groupId) {
    // 前の Subgroup を §11.3.2 の判定で閉じる。close の完了は待たない
    // (closeSubgroupStreamWithoutWaiting を参照)。
    if (streamState) {
      closeSubgroupStreamWithoutWaiting(session, trackAlias);
    }

    // Subgroup Header をエンコードする
    // draft-ietf-moq-transport-23 Section 11.3.1
    // ストリーム生成前にエンコードする。trackAlias / groupId が 2^64-1 を
    // 超える等でエンコードが throw した場合、新規ストリーム生成という
    // 副作用なしで失敗させるためである (グループ切替時の前ストリームの
    // FIN はエンコード前に実行済み)。
    const header = encodeSubgroupHeader({
      type: headerType,
      trackAlias,
      groupId,
      // EXPLICIT_EXT だけ Subgroup ID フィールドを持つ。FIRST_OBJ_EXT では
      // Subgroup ID = 先頭 Object ID のため、フィールドを渡すと encode が throw する。
      ...(headerType === SubgroupHeaderType.EXPLICIT_EXT ? { subgroupId } : {}),
      publisherPriority,
      firstObject,
    });

    // 新しいストリームを開く
    const stream = await session.transport.createUnidirectionalStream();
    // §9.9: ヘッダーが届く前に RESET する場合も、生成済みのストリームは数える。
    session.statsUnidirectionalStreamsOpened++;
    publisher.incrementDataStreamCount();
    const writer = stream.getWriter();
    // 待機中に購読が終わるかフィルタで見送る場合、Header を書かずに RESET する。
    const beforeHeader = subgroupSendBlockReason(
      publisher,
      params,
      objectProperties,
      subgroup,
      checkedFilterRevision,
    );
    if (beforeHeader !== undefined) {
      resetUnsentPublisherStream(session, publisher, writer, beforeHeader);
      return;
    }
    checkedFilterRevision = publisher.getSendFilterRevision();
    try {
      await writer.write(header);
    } catch (err) {
      try {
        writer.releaseLock();
      } catch {
        // releaseLock の失敗は無視し、元の write エラーを優先する
      }
      if (!isPublisherClosed(publisher)) {
        rememberClosedSubgroup(session.closedSubgroups, trackAlias, groupId);
      }
      throw err;
    }

    // Header の書き込みを待った間の変更も、Object 本体を渡す前に確認する。
    const afterHeader = subgroupSendBlockReason(
      publisher,
      params,
      objectProperties,
      subgroup,
      checkedFilterRevision,
    );
    if (afterHeader !== undefined) {
      resetUnsentPublisherStream(session, publisher, writer, afterHeader);
      return;
    }

    streamState = {
      groupId,
      writer,
      previousObjectId: -1n,
      objectDeliveryTimeout: resolveObjectDeliveryTimeoutOverride(params, objectProperties),
      subgroup,
      subgroupOmissions: publisher.getSubgroupOmissions(),
      omittedObjects: false,
    };
    session.publisherStreams.set(trackAlias, streamState);
  }

  // Object ID Delta を計算
  const objectIdDelta = calculateObjectIdDelta(streamState.previousObjectId, objectId);

  // delivery timeout の Object Property は subgroup 先頭オブジェクトにのみ載せる
  const isFirstInSubgroup = streamState.previousObjectId < 0n;
  if (!isFirstInSubgroup && hasDeliveryTimeout) {
    throw new Error(
      "deliveryTimeout/subgroupDeliveryTimeout can only be set on the first object in a subgroup",
    );
  }

  // GREASE Object Property - draft-ietf-moq-transport-23 §13 (Grease)
  // opt-in 時、各オブジェクトに 1 つ追加する。§11.1.2 により Object Properties は
  // status Normal のオブジェクトにのみ許容される（非 Normal は INVALID_OBJECT_STATUS）ため、
  // Normal のときだけ注入する。
  const status = params.status ?? ObjectStatus.NORMAL;
  if (session.grease && status === ObjectStatus.NORMAL) {
    objectProperties = appendGreaseObjectProperty(objectProperties);
  }

  const data = encodeObjectFields(
    objectIdDelta,
    BigInt(params.payload.length),
    headerType,
    status,
    objectProperties,
  );

  // Object Fields と payload は 1 回の write() で送信する。
  // draft-ietf-moq-transport-23 §11.3 / §11.3.2:
  // 2 回の write() の間に close (FIN) が割り込むと、宣言 payloadLength 未達の
  // FIN を送出し得る (§11.3 の serialized Object 途中の FIN / §11.3.2 の
  // 配信途中終了は reset MUST)。QUIC/WebTransport の write はセグメント境界を
  // 保証しないため、連結して単一 write にすることで割り込みの窓を構造的に
  // 無くす。
  // 空 payload 時は fields のみの単一 write になる (従来どおり)。
  // なお Subgroup Header の write と本 write の間には窓が残るが、header のみの
  // FIN は Object 途中の FIN には当たらず、session 終了時の teardown 競合に
  // 限定される。
  let objectBytes = data;
  if (params.payload.length > 0) {
    objectBytes = new Uint8Array(data.length + params.payload.length);
    objectBytes.set(data, 0);
    objectBytes.set(params.payload, data.length);
  }

  if (resetExpiredSubgroupObject(session, publisher, streamState, providedAtMs, params.onOmitted)) {
    return;
  }

  try {
    await streamState.writer.write(objectBytes);
  } catch (err) {
    // 終了済みの writer を次の Group 切替で再処理すると、STOP_SENDING による
    // 終了を送信側の RESET と誤認して、閉じた Group の記録を取り消し得る。
    if (session.publisherStreams.get(trackAlias) === streamState) {
      session.publisherStreams.delete(trackAlias);
    }
    try {
      streamState.writer.releaseLock();
    } catch {
      // releaseLock の失敗は無視し、元の write エラーを優先する
    }
    // 購読自体が終了している場合は、後始末でクリアした記録を復活させない。
    if (!isPublisherClosed(publisher)) {
      rememberClosedSubgroup(session.closedSubgroups, trackAlias, groupId);
    }
    throw err;
  }

  // 状態を更新
  publisher.recordPublishedLocation(groupId, objectId);
  streamState.previousObjectId = objectId;
  publisher.recordWrittenSubgroupObject(groupId, objectId);

  // draft-ietf-moq-transport-23 §11.1.1 (Object Status) / §11.3.2 (Closing Subgroup Streams):
  // END_OF_GROUP は Group の最終 Object を宣言する status であり、Subgroup の終端は FIN で
  // 通知する。省略 (paused 中、Location Filter の範囲外、Range Filters の不通過に
  // よる見送り) がある場合は FIN ではなく RESET で閉じる (§11.3.2 の MUST)。
  // endOfSubgroup は「この Object が Subgroup の最後である」ことを status ではなく送信側の
  // 申告で伝える経路である。catalog のように payload を持つ Object が Subgroup の最後に
  // なる場合、payload を持てない END_OF_GROUP status (§11.1.1) は使えない。
  // 書き込みの完了を待ってから閉じるため、宣言した payload を残したまま FIN することはない。
  if (status === ObjectStatus.END_OF_GROUP || params.endOfSubgroup === true) {
    closeSubgroupStreamWithoutWaiting(session, trackAlias);
  }
}

function requiresSubgroupReset(streamState: PublisherStreamState): boolean {
  return (
    streamState.omittedObjects || streamState.subgroupOmissions?.has(streamState.groupId) === true
  );
}

/** §10.2: 途中から始まる購読でも Track で確定した先頭 Object の値を使う。 */
function resolveObjectDeliveryTimeoutOverride(
  params: SendObjectParamsInternal,
  properties: Uint8Array | undefined,
): bigint | undefined {
  if (params.resolvedSubgroup !== undefined) return params.resolvedSubgroup.objectDeliveryTimeout;
  // 内部関数を直接呼ぶ場合も、新規 Subgroup の先頭で値を取り出す。
  return (
    params.deliveryTimeout ?? readDeliveryTimeoutObjectProperties(properties).objectDeliveryTimeout
  );
}

/** §5.2: キューと Header の書き込みの待機時間を含め、Object を渡す直前に判定する。 */
function resetExpiredSubgroupObject(
  session: SessionInternal,
  publisher: PublisherImpl,
  streamState: PublisherStreamState,
  providedAtMs: number,
  onOmitted: (() => void) | undefined,
): boolean {
  const timeout = publisher.getSubgroupObjectDeliveryTimeout(streamState.objectDeliveryTimeout);
  if (timeout === 0n || !exceedsDeliveryTimeout(performance.now() - providedAtMs, timeout))
    return false;

  const trackAlias = publisher.getTrackAlias();
  session.publisherStreams.delete(trackAlias);
  rememberClosedSubgroup(session.closedSubgroups, trackAlias, streamState.groupId);
  onOmitted?.();
  const { writer } = streamState;
  commitWrittenSubgroupBytes(writer);
  trackPublisherStreamClose(
    session,
    trackAlias,
    startPublisherStreamReset(writer, deliveryTimeoutResetReason()),
  );
  return true;
}

/** RESET を開始し、WebTransport での処理完了を返す。 */
function startPublisherStreamReset(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reason: string | WebTransportError,
): Promise<void> {
  const completion = writer.abort(reason).catch(() => {
    // 既に停止したストリームに対する abort の失敗は無視する。
  });
  writer.releaseLock();
  return completion;
}

/** §11.3.2: RESET_STREAM_AT を指定できる場合は Header と先行 Object を保持する。 */
function commitWrittenSubgroupBytes(writer: WritableStreamDefaultWriter<Uint8Array>): void {
  if ("commit" in writer && typeof writer.commit === "function") {
    try {
      writer.commit();
    } catch {
      // ピアによる停止などで確定できない場合も、リセット処理は続ける。
    }
  }
}

/** §12.5: WebTransport の終了理由に MOQT の DELIVERY_TIMEOUT コードを含める。 */
function deliveryTimeoutResetReason(): WebTransportError | string {
  const message = "object delivery timeout";
  if (typeof WebTransportError === "undefined") return message;
  const streamErrorCode = DataStreamErrorCode.DELIVERY_TIMEOUT;
  try {
    const reason = new WebTransportError(message, { streamErrorCode });
    if (reason.streamErrorCode === streamErrorCode) return reason;
  } catch {
    // 辞書 1 引数を受けるブラウザでは、そちらの形式で作成する。
  }
  const DictionaryConstructor = WebTransportError as unknown as new (options: {
    message: string;
    streamErrorCode: number;
  }) => WebTransportError;
  return new DictionaryConstructor({ message, streamErrorCode });
}

function resetUnsentPublisherStream(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reason: string,
): void {
  const completion = startPublisherStreamReset(writer, reason);
  if (!isPublisherClosed(publisher)) {
    trackPublisherStreamClose(session, publisher.getTrackAlias(), completion);
  }
}

function trackPublisherStreamClose(
  session: BidiSessionInternal,
  trackAlias: bigint,
  completion: Promise<void>,
): void {
  let pending = session.publisherPendingCloses.get(trackAlias);
  if (pending === undefined) {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    pending = { completions: new Set(), cancelled, cancel };
    session.publisherPendingCloses.set(trackAlias, pending);
  }
  const pendingCloses = pending;
  pendingCloses.completions.add(completion);
  void completion.then(() => {
    pendingCloses.completions.delete(completion);
    if (
      pendingCloses.completions.size === 0 &&
      session.publisherPendingCloses.get(trackAlias) === pendingCloses
    ) {
      session.publisherPendingCloses.delete(trackAlias);
    }
  });
}

/**
 * 開いている Subgroup ストリームを §11.3.2 の判定で閉じ、close の完了を待たない
 *
 * WebTransport の `WritableStreamDefaultWriter.close()` は FIN が ACK されるまで解決しない
 * (Chrome)。Group の切り替えでその完了を待つと、同じトラックの送信は publisherSendQueues で
 * 直列化しているため、新しい Group の先頭の Object の送信が 1 RTT 遅れる。
 * draft-ietf-moq-transport-23 に Group (Subgroup) の切り替えで前の stream の完了を待つ
 * 要件は無い。§9.9 は "A sender MUST NOT send PUBLISH_DONE until it has closed all streams
 * it will ever open" とするため、PUBLISH_DONE の前の終了処理
 * (publishClosePublisherStreamInternal) で完了を待つ。
 *
 * 終了処理を始める時点で Subgroup を closedSubgroups に追加し、結果が分かるまでは
 * 同じ Group を開かない。送信側で RESET した場合は登録を取り消す。FIN またはピアの
 * STOP_SENDING で終わった場合は、閉じた Group として保持する (§11.3.2)。
 * publishCloseSubgroupStream は reject しないため、未処理の reject は出ない。
 */
function closeSubgroupStreamWithoutWaiting(session: BidiSessionInternal, trackAlias: bigint): void {
  const streamState = session.publisherStreams.get(trackAlias);
  if (!streamState) {
    return;
  }
  const closedGroups = rememberClosedSubgroup(
    session.closedSubgroups,
    trackAlias,
    streamState.groupId,
  );
  // publishCloseSubgroupStream は最初の await の前に publisherStreams から削除する
  const completion = publishCloseSubgroupStream(session, trackAlias).then((outcome) => {
    if (outcome === "reset" && session.closedSubgroups.get(trackAlias) === closedGroups) {
      closedGroups.delete(streamState.groupId);
      if (closedGroups.isEmpty) session.closedSubgroups.delete(trackAlias);
    }
  });
  trackPublisherStreamClose(session, trackAlias, completion);
}

/**
 * 開いている Subgroup を、Object を送らずに閉じる（Promise チェーン排他制御付き）
 *
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
 * 送信を止める時点で「その Subgroup に続く Object は無い」と分かったときに使う。
 * FIN と RESET の選択は closeSubgroupStreamWithoutWaiting の判定 (省略がある Subgroup は
 * RESET) に従う。開いている Subgroup が無い場合は何もしない。
 *
 * 送信キュー (`publisherSendQueues`) に載せ、キュー済みの送信が終わってから閉じる。
 * Group の切り替えで `createUnidirectionalStream()` を待っている送信が、閉じた後に
 * ストリームを開き直して FIN を無効にするのを防ぐ。FIN の完了は待たない
 * (`done()` が publishClosePublisherStreamInternal で完了を待つ)。
 */
export function publishCloseSubgroup(
  session: BidiSessionInternal,
  trackAlias: bigint,
): Promise<void> {
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => {
      closeSubgroupStreamWithoutWaiting(session, trackAlias);
    });
  session.publisherSendQueues.set(trackAlias, currentPromise);
  return currentPromise;
}

/**
 * Publisher のストリームを閉じる（Promise チェーン排他制御付き）
 *
 * @param timeoutMs - writer.close の打ち切りまでのミリ秒 (テスト用の短縮のためにある。
 * 本番呼び出しは既定値のままにする)
 */
export function publishClosePublisherStream(
  session: BidiSessionInternal,
  trackAlias: bigint,
  timeoutMs = PUBLISHER_STREAM_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => publishClosePublisherStreamInternal(session, trackAlias, timeoutMs))
    .finally(() => {
      // 終了した購読の末尾を破棄する。既に別の処理が末尾を更新していれば残す。
      if (session.publisherSendQueues.get(trackAlias) === currentPromise) {
        session.publisherSendQueues.delete(trackAlias);
      }
    });
  session.publisherSendQueues.set(trackAlias, currentPromise);
  return currentPromise;
}

/**
 * Publisher のストリームを reset (abort) で閉じる (peer キャンセル時の後始末)
 *
 * draft-ietf-moq-transport-23 §3.1.2:
 * 「The Publisher can remove subscription state as soon as it has received
 *  STOP_SENDING.  It MUST reset any open streams associated with the
 *  SUBSCRIBE.」
 * FIN ではなく reset にするため、publishClosePublisherStreamInternal の
 * FIN 経路とは別に abort 専用の後始末を提供する。二重 reset / 既に閉じた
 * ストリームへの操作は黙殺する。
 */
export function publishResetPublisherStream(
  session: BidiSessionInternal,
  trackAlias: bigint,
): void {
  const streamState = session.publisherStreams.get(trackAlias);
  if (streamState) {
    session.publisherStreams.delete(trackAlias);
    try {
      // peer キャンセル後の後始末であり abort の完了は待たない。失敗は黙殺する。
      void startPublisherStreamReset(streamState.writer, "peer cancelled subscription");
    } catch {
      // 既に閉じている場合は無視
    }
  }
  session.closedSubgroups.delete(trackAlias);
  // 送信キューの Map エントリを削除する。既にチェーンへ登録済みの送信は
  // publishSendObjectInternal の closed ガードで抑止される。
  session.publisherSendQueues.delete(trackAlias);
  // §3.1.2: peer キャンセルでは PUBLISH_DONE が不要になるため、終了確認の待機を解く。
  session.publisherPendingCloses.get(trackAlias)?.cancel();
  session.publisherPendingCloses.delete(trackAlias);
}

/**
 * Publisher のストリームを閉じる内部実装
 *
 * writer.close のタイムアウトは確定時 (成功・タイムアウト発火) に
 * 必ず解放する (残留タイマーを残さない)。
 */
async function publishClosePublisherStreamInternal(
  session: BidiSessionInternal,
  trackAlias: bigint,
  timeoutMs: number,
): Promise<void> {
  if (session.publisherStreams.has(trackAlias)) {
    const completion = publishCloseSubgroupStream(session, trackAlias, timeoutMs).then(() => {});
    trackPublisherStreamClose(session, trackAlias, completion);
  }
  // §9.9: 送信中のストリームと、切り替えや送信見送りで既に閉じ始めたものを待つ。
  const pendingCloses = session.publisherPendingCloses.get(trackAlias);
  if (pendingCloses !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        Promise.all(pendingCloses.completions).then(() => true),
        pendingCloses.cancelled.then(() => true),
        // FIN を諦めて RESET に切り替えた場合にも、処理のための時間を残す。
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2 * timeoutMs);
        }),
      ]);
      if (!finished && session.sessionState === "connected") {
        session.closeWithError(
          new SessionError(
            `publisher data streams did not close: trackAlias=${trackAlias}`,
            SessionErrorCode.INTERNAL_ERROR,
          ),
        );
      }
    } finally {
      clearTimeout(timer);
      if (session.publisherPendingCloses.get(trackAlias) === pendingCloses) {
        session.publisherPendingCloses.delete(trackAlias);
      }
    }
  }

  // publisher done 時に当該 trackAlias の closedSubgroups エントリをクリアする
  session.closedSubgroups.delete(trackAlias);
}

/**
 * フィルタ更新によって送信中の Subgroup が途中で打ち切られることを記録する
 *
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream."
 * 記録先は更新の影響を受ける Group に限る。sendObject の実際の見送りは
 * ストリームを開く前にも起きるため、PublisherImpl が購読ごとに保持する。
 *
 * @param groupId 見送った Object の Group ID
 */
export function publishMarkStreamOmitted(
  session: Pick<BidiSessionInternal, "publisherStreams">,
  trackAlias: bigint,
  groupId: number | bigint,
): void {
  // bigint は検証済みの値を渡す (bidi.ts の PublisherStreamState.groupId)。
  const target = typeof groupId === "bigint" ? groupId : convertGroupIdNumber(groupId);
  if (target === undefined) {
    return;
  }
  const streamState = session.publisherStreams.get(trackAlias);
  if (streamState === undefined || streamState.groupId !== target) {
    return;
  }
  streamState.omittedObjects = true;
}

/**
 * number の Group ID を bigint へ変換する (非整数・負値・非有限は undefined)
 */
function convertGroupIdNumber(groupId: number): bigint | undefined {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return undefined;
  }
  return BigInt(groupId);
}

/**
 * Subgroup ストリームを §11.3.2 の判定で閉じる
 *
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream.  This includes, but is not limited to:
 *  ... Omitting a Subgroup Object because the subscription is paused"
 * フィルタ変更で配信を打ち切った場合、または購読に未送信の Object が残る場合は RESET する。
 * FIN の打ち切り (timeoutMs)
 * が発生した場合は graceful な FIN を諦めて RESET で後始末する (この場合は省略の有無に
 * よらず reset)。
 *
 * ストリーム状態は Map から削除する。ストリームが無い場合は何もせず `"fin"` を返す
 * (閉じる対象が無いため、呼び出し側が closedSubgroups へ追加してよい)。
 *
 * @param timeoutMs - FIN の打ち切りまでのミリ秒 (テスト用の短縮のためにある)
 * @returns `"fin"`、送信側の `"reset"`、またはピアの STOP_SENDING による `"peer-stop"`
 */
export async function publishCloseSubgroupStream(
  session: BidiSessionInternal,
  trackAlias: bigint,
  timeoutMs = PUBLISHER_STREAM_CLOSE_TIMEOUT_MS,
): Promise<"fin" | "reset" | "peer-stop"> {
  const streamState = session.publisherStreams.get(trackAlias);
  if (!streamState) {
    return "fin";
  }
  session.publisherStreams.delete(trackAlias);

  const { writer } = streamState;
  let peerStopped = false;
  // close() や abort() より先に STOP_SENDING が届いた場合は writer.closed で原因を拾う。
  void writer.closed.catch((error: unknown) => {
    peerStopped = isPeerStreamError(error);
  });
  // §11.3.2: 全 Object を渡し切る前に閉じる場合は RESET する。
  if (requiresSubgroupReset(streamState)) {
    await startPublisherStreamReset(writer, "subgroup omitted objects");
    return peerStopped ? "peer-stop" : "reset";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      writer.close(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("writer.close() timed out")), timeoutMs);
      }),
    ]);
    writer.releaseLock();
    return "fin";
  } catch (error) {
    if (peerStopped || isPeerStreamError(error)) {
      // §11.3.2: ピアが停止した Subgroup は再度開かない。
      writer.releaseLock();
      return "peer-stop";
    }
    // FIN の完了を確認できない場合はタイマーを片付けてから RESET する。
  } finally {
    clearTimeout(timer);
  }
  await startPublisherStreamReset(writer, "publisher stream cleanup");
  return peerStopped ? "peer-stop" : "reset";
}

/**
 * datagram を送信する
 * draft-ietf-moq-transport-23 Section 11.2 (Datagrams)
 */
export function publishSendDatagram(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendDatagramParams,
  providedAtMs = performance.now(),
): Promise<void> {
  // セッションクローズ後は datagram を送らない
  if (session.sessionState === "closed") {
    return Promise.resolve();
  }

  // draft-ietf-moq-transport-23 §3.1.1:
  // "The publisher does not send Objects on a paused subscription"
  // PublisherImpl 側でも同じガードを持つが、内部送信関数を直接呼ぶ経路の
  // 防御としてここでも参照する。
  if (publisher.paused) {
    return Promise.resolve();
  }

  // 不正 ID はローカル API 誤用のため、送信前に通知して throw する
  // (戻り値が void のため throw 維持。sendObject の通知 + reject と対称)。
  // closed 時は検証より先に no-op で返す (終了後の送信試行を抑止する)。
  let groupId: bigint;
  let objectId: bigint;
  try {
    groupId = validateGroupAndObjectIdRange("group id", params.groupId);
    objectId = validateGroupAndObjectIdRange("object id", params.objectId);
    // 不正 priority も副作用の前に fail-fast で返す (ID 検証と同位置)。
    validatePublisherPriority(params.priority ?? 128);
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    throw rejection;
  }

  // §11.2: 上限を超える Datagram は通知せず破棄する。確実に超える場合は連結を省く。
  const maxDatagramSize = session.transport.datagrams.maxDatagramSize;
  if (params.payload.byteLength + (params.properties?.byteLength ?? 0) > maxDatagramSize) {
    return Promise.resolve();
  }

  // GREASE Object Property - draft-ietf-moq-transport-23 §13 (Grease)
  // opt-in 時、datagram に 1 つ追加する。Datagram Type の Properties Present ビット
  // （bit 0）を正しく設定するため、hasProperties の判定より前に注入する。
  const properties = session.grease
    ? appendGreaseObjectProperty(params.properties)
    : params.properties;

  const hasProperties = properties !== undefined && properties.length > 0;
  const hasPriority = params.priority !== undefined;
  const endOfGroup = params.endOfGroup ?? false;

  // §11.1.1 / §11.2.1: 空の Object は STATUS (0x20) で Normal を明示する。
  // DEFAULT_PRIORITY (0x08)、END_OF_GROUP (0x02)、PROPERTIES (0x01) を組み合わせる。
  const type =
    (params.payload.byteLength === 0 ? 0x20 : 0) |
    (hasPriority ? 0 : 0x08) |
    (endOfGroup ? 0x02 : 0) |
    (hasProperties ? 0x01 : 0);

  // エンコード失敗もローカル誤用のため通知して throw する
  // (ID 検証と同一の通知契約にする)。
  let datagram: Uint8Array;
  try {
    datagram = encodeObjectDatagram({
      type,
      trackAlias: publisher.getTrackAlias(),
      groupId,
      objectId,
      publisherPriority: params.priority ?? 128,
      // exactOptionalPropertyTypes では optional な properties に undefined を渡せないため、
      // 値がある場合だけ載せる
      ...(properties !== undefined ? { properties } : {}),
      payload: params.payload,
    });
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    throw rejection;
  }

  // ヘッダーや GREASE を含めた実際のワイヤ長を照合する。
  if (datagram.byteLength > maxDatagramSize) return Promise.resolve();

  // §5.2: アプリが Object を提供してから WebTransport に渡すまでの時間で判定する。
  // 期限超過は §11.2 のサイズ超過と同様に、送信せず最大位置にも記録しない。
  const timeout = publisher.getDatagramDeliveryTimeout();
  if (timeout !== 0n && exceedsDeliveryTimeout(performance.now() - providedAtMs, timeout)) {
    return Promise.resolve();
  }
  const writer = publishGetDatagramWriter(session);
  // 受理した Datagram で最大位置を更新する。失敗は error 通知し、未処理の reject は残さない。
  const completed = writer.write(datagram).then(
    () => publisher.recordPublishedLocation(groupId, objectId),
    (err: unknown) => {
      if (session.sessionState !== "closed") {
        try {
          publisher.handleError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // アプリの通知コールバックの例外から、送信完了の待機を隔離する。
        }
      }
    },
  );
  publisher.recordDatagramWrite(completed);
  return completed;
}

/**
 * PUBLISH_DONE を送信する
 * draft-ietf-moq-transport-23 Section 9.9 (PUBLISH_DONE)
 *
 * status は必須引数とする (後方互換の既定値は付けない)。
 * 正常終了は TRACK_ENDED、REQUEST_UPDATE 失敗時は UPDATE_FAILED を渡す。
 */
export async function publishSendPublishDone(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
  status: PublishDoneStatusCode,
): Promise<void> {
  // §9.9: この購読で受理した Datagram を共有 writer に渡し終えてから送る。
  // write の完了はピアへの到達を待たない。購読がキャンセルされたら終了通知も不要になる。
  const pendingDatagrams = publisher.waitForDatagramWrites();
  if (pendingDatagrams !== undefined) {
    await pendingDatagrams;
  }
  if (isPublisherClosed(publisher)) {
    return;
  }
  await publishSendPublishDoneCore(
    session,
    publisher.getRequestId(),
    publisher.getDataStreamCount(),
    status,
  );
}

/**
 * Publisher がない購読に PUBLISH_DONE を送信する
 *
 * draft-ietf-moq-transport-23 §9.9:
 * 開設ストリーム数の正確数を確定できないため、Stream Count は
 * 呼び出し側が決める (不明な場合は 2^64 - 1 の MUST 後段に従う)。
 * Error Reason は空のまま変えない。
 *
 * @param streamCount - 開設ストリーム数。不明な場合は MAX_VARINT (2^64 - 1) を渡す
 */
export async function publishSendPublishDoneWithoutPublisher(
  session: BidiSessionInternal,
  requestId: bigint,
  streamCount: bigint,
  status: PublishDoneStatusCode,
): Promise<void> {
  await publishSendPublishDoneCore(session, requestId, streamCount, status);
}

/**
 * PUBLISH_DONE 送信後の close 失敗を、ストリームの終了として扱えるか判定する
 *
 * draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection) /
 * §9.9 (PUBLISH_DONE):
 * ピアの STOP_SENDING / RESET_STREAM やローカルの終了処理との競合で writable が
 * 先に終了している場合、PUBLISH_DONE 後の close は「既に errored / closed の
 * writable は close できない」ことを示す source なしの TypeError で失敗する。
 * それをセッション全体の INTERNAL_ERROR に昇格させないための判定である。
 *
 * - close 失敗がピア起因のキャンセル (source: "stream") ならストリーム終了
 * - write 失敗がピア起因のキャンセルなら、close 失敗もその後始末であり終了
 * - close 失敗が writable の状態エラー (既に errored / closed) の場合、
 *   write が成功している (STOP_SENDING が write の後に届いたレース) か、
 *   write 失敗も状態エラー (writer は write の前から終了) ならストリーム終了
 * - write が状態エラー以外で失敗している場合は、PUBLISH_DONE を送れていない
 *   失敗を状態エラーが覆い隠さないよう、ストリーム終了として扱わない
 *   (従来どおり INTERNAL_ERROR でセッションを閉じる)
 *
 * 上記以外 (close 失敗が状態エラーではない TypeError 等) は実装不具合として
 * 扱い、セッションを閉じる。
 */
function isPublishDoneCloseFailureTermination(closeError: unknown, writeError: unknown): boolean {
  if (isPeerStreamError(closeError) || isPeerStreamError(writeError)) {
    return true;
  }
  if (!isWritableStreamStateError(closeError)) {
    return false;
  }
  return writeError === undefined || isWritableStreamStateError(writeError);
}

async function publishSendPublishDoneCore(
  session: BidiSessionInternal,
  requestId: bigint,
  streamCount: bigint,
  status: PublishDoneStatusCode,
): Promise<void> {
  // セッション終了後は送信を試行しない。
  // アプリの session.close() でもピア起点の終了でも publishers は markClosed
  // され done() が no-op になるが、ストリーム単位の終了とセッション終了の
  // レースがあるため、ここでガードする。ガードしないと write / close が
  // セッション終了起因のエラーで失敗し、誤って INTERNAL_ERROR として
  // callbacks.error に通知される。
  if (session.sessionState === "closed") {
    return;
  }

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(status));
  parts.push(encodeVarint(streamCount));
  parts.push(encodeVarint(0));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const payload = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo?.publishDoneStarted) {
    return;
  }
  // controlWriter 不在では何も送信できない (終了処理はベストエフォートのため
  // 黙殺し、後段のマップ掃除は行う)。
  if (streamInfo && session.controlWriter) {
    const message = session.controlWriter.encode(MessageType.PUBLISH_DONE, payload);
    // §9.9: PUBLISH_DONE を最後にする。write の完了待ちに届く応答も新たに登録しない。
    streamInfo.publishDoneStarted = true;
    session.statsControlMessagesSent++;
    // アプリの debug コールバック例外で終了処理を壊さないよう隔離する
    // (bidiSendRequestMessage 内の emitDebug は try 内にあるため同様に安全)。
    try {
      session.emitDebug("send", MessageType.PUBLISH_DONE, payload, {
        requestId: requestId.toString(),
        statusCode: status,
        streamCount: streamCount.toString(),
      });
    } catch {
      // アプリのコールバック例外は無視する
    }
    // write と FIN の失敗を別々に扱い、ストリーム終了による close 失敗を判定する。
    let writeError: unknown;
    try {
      await streamInfo.writer.write(message);
    } catch (error) {
      writeError = error;
    }

    try {
      await streamInfo.writer.close();
    } catch (err) {
      // draft-ietf-moq-transport-23 §6.4.2.3:
      // 「An endpoint that has already sent a FIN on its sending direction and
      //  subsequently wishes to cancel sends STOP_SENDING on the receiving
      //  direction.」— ピアが FIN 後に STOP_SENDING で当方の送信方向を
      // キャンセルした場合、write / close は WebTransportError
      // (source: "stream") で reject する (W3C WebTransport の実装挙動。
      // 判定は isPeerStreamError 参照)。
      // STOP_SENDING の到着は非同期のため、write() が成功した後に close() が
      // 失敗するレースが実 WebTransport で起こり得る。このとき close 失敗エラー
      // 自体の source を判定して非昇格にする。
      // また、ピアの STOP_SENDING / RESET_STREAM で writable が errored に
      // なった後や、ローカルの終了処理との競合で既に closed になった後の
      // close() は、source を持たない TypeError で reject する (実装ごとの
      // 文言は isWritableStreamStateError 参照)。
      // これらのストリーム終了由来の close 失敗ではセッションを閉じない
      // (判定の詳細は isPublishDoneCloseFailureTermination 参照)。
      // どれにも該当しない失敗は実装固有の失敗 (INTERNAL_ERROR) として
      // セッションを閉じる。
      if (!isPublishDoneCloseFailureTermination(err, writeError)) {
        // session.close() との並行実行では、ローカルの writer.abort() 起因の
        // close 失敗 (source なしの TypeError) がここに到達し得る。セッションは
        // 既に閉じているため、この失敗はピアの違反ではなく誤報になる。
        // 入り口ガード (関数先頭の sessionState チェック) 通過後にセッションが
        // 閉じた場合は INTERNAL_ERROR として通知しない。
        // ピア起因のセッション終了 (transport.closed) は sessionState 遷移が
        // 非同期のため、reject 処理時に遷移が完了している場合のみ再確認が
        // 機能する。遷移より先に reject が処理された場合は昇格し得る既知の
        // 残余リスクである (エラーの source 判定に依存せず、sessionState の
        // 再確認のみで判定する設計のため。両経路の検証は bidi.test.ts の
        // close() 並行テスト / ピア起因テストを参照)。
        // なお、入り口ガードにより sessionState は "connected" に絞り込まれる
        // ため、絞り込みを解除して実状態を再確認する。
        // また peer キャンセル (STOP_SENDING / RESET_STREAM) で購読が既に終了して
        // いる場合、handlePublishPeerCancel が request stream をローカル abort
        // するため close が source なし TypeError で失敗し得る。publishers から
        // 削除済みなら当該購読は終了済みであり、ピアの違反ではないため昇格しない。
        if (
          session.publishers.has(requestId) &&
          (session.sessionState as SessionState) !== "closed"
        ) {
          session.closeWithError(
            new SessionError(
              `failed to close stream after PUBLISH_DONE: ${err instanceof Error ? err.message : String(err)}`,
              SessionErrorCode.INTERNAL_ERROR,
            ),
          );
        }
      }
    }
  }

  session.requestStreams.delete(requestId);
  session.publishers.delete(requestId);
}
