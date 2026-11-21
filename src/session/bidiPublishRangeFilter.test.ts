/**
 * session/bidi.ts / publisher.ts の結合テスト: publisher 送信経路の Range Filter
 *
 * draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §3.3.3 (Combining Filters):
 * "The publisher MUST forward only objects that pass all filters."
 * publisher が送信する Object / Datagram に対して SUBGROUP_FILTER /
 * OBJECTID_FILTER / PRIORITY_FILTER を適用し、不通過の Object を送信しないこと、
 * REQUEST_UPDATE による追加・置換・削除 (Length 0)・省略時据え置き、および
 * §11.3.2 の RESET 判定を検証する。
 *
 * 実 SessionImpl・実 PublisherImpl・実 W3C ストリーム・実 Map で検証し、
 * モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { MessageType, MessageParameterType, ObjectStatus } from "../message/types";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import {
  encodeLocationFilterParameter,
  encodeRangeFilter,
  type Parameter,
  type RangeFilterSpec,
} from "../message/parameter";
import {
  decodeObjectDatagram,
  decodeObjectFields,
  decodeSubgroupHeader,
  type SubgroupHeader,
} from "../dataStream";
import { decodeRequestErrorPayload } from "../message/session";
import { ProtocolViolationError, RequestErrorCode } from "../error";
import { ControlStreamReader, type ControlMessage } from "../controlStream";
import {
  decodeProperties,
  encodeProperties,
  readDeliveryTimeoutObjectProperties,
  TrackPropertyId,
} from "../properties";
import { concatUint8Arrays } from "../testSupport/helpers";
import { createPublishReadTestContext, waitForMacrotask } from "../testSupport/bidi";
import { bidiReadRequestStreamMessages } from "./bidi";
import { publishCloseSubgroupStream } from "./publish";

type PublishReadContext = ReturnType<typeof createPublishReadTestContext>;

/** 1 本の Subgroup ストリームの記録を取得する */
function subgroupStream(context: PublishReadContext, index: number) {
  const stream = context.subgroupStreams[index];
  if (stream === undefined) {
    throw new Error(`Subgroup ストリーム ${index} が作成されていない`);
  }
  return stream;
}

/** 1 本の Subgroup ストリームの先頭 (Subgroup Header) をデコードする */
function decodeStreamHeader(context: PublishReadContext, index: number): SubgroupHeader {
  const headerBytes = subgroupStream(context, index).writes[0];
  if (headerBytes === undefined) {
    throw new Error(`Subgroup ストリーム ${index} にヘッダーの write が無い`);
  }
  const [header] = decodeSubgroupHeader(headerBytes, 0);
  return header;
}

/**
 * 書き込まれた制御メッセージをデコードする
 *
 * 要求ストリームの write は複数回に分かれるため、毎回すべてを連結して先頭から
 * デコードする。ControlStreamReader は新規インスタンスなので状態を持ち越さない。
 */
function decodeWrittenMessages(context: PublishReadContext): ControlMessage[] {
  return new ControlStreamReader().feed(concatUint8Arrays(context.written));
}

/**
 * 期待した件数の制御メッセージが書き込まれるまで待つ
 *
 * REQUEST_OK の書き込みは実 WritableStream の sink を経て非同期に完了するため、
 * 固定回数のマイクロタスク待ちでは負荷時に取りこぼす。メッセージ数で判定する。
 */
async function waitForWrittenMessageCount(
  context: PublishReadContext,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (decodeWrittenMessages(context).length >= expectedCount) {
      return;
    }
    await waitForMacrotask();
  }
  throw new Error(
    `制御メッセージ ${expectedCount} 件の書き込みを待機したがタイムアウトした (受信 ${decodeWrittenMessages(context).length} 件)`,
  );
}

/**
 * publish ロールの受信ストリームで REQUEST_UPDATE を順に処理するドライバー
 *
 * 同一購読への複数更新 (追加・置換・削除) を、Object 送信を挟みながら検証できる
 * よう、読み取りループを 1 回だけ起動して update() ごとに REQUEST_OK の書き込みを
 * 待つ。finish() で FIN を送って読み取りを終える。
 */
function startPublishRequestUpdates(context: PublishReadContext): {
  update: (parameters: Parameter[]) => Promise<void>;
  finish: () => Promise<void>;
} {
  const readPromise = bidiReadRequestStreamMessages(
    context.session,
    context.requestId,
    context.stream,
    context.controlReader,
    "publish",
  );
  let requestId = 101n;
  let expectedCount = 0;
  return {
    async update(parameters) {
      const payload = encodeRequestUpdatePayload({
        type: MessageType.REQUEST_UPDATE,
        requestId,
        parameters,
      });
      requestId += 2n;
      expectedCount += 1;
      const controlWriter = context.session.controlWriter;
      if (controlWriter === undefined) {
        throw new Error("制御ストリームの writer が初期化されていない");
      }
      context.readableController.enqueue(controlWriter.encode(MessageType.REQUEST_UPDATE, payload));
      await waitForWrittenMessageCount(context, expectedCount);
    },
    async finish() {
      context.readableController.close();
      await readPromise;
    },
  };
}

/**
 * 自 endpoint が広告した MAX_FILTER_RANGES を実 SessionImpl に設定する
 *
 * BidiSessionInternal では読み取り専用のため、テストからだけ書き込み可能な型へ
 * 境界キャストする。値は実 SessionImpl のフィールドに設定される (偽装ではない)。
 */
function advertiseMaxFilterRanges(context: PublishReadContext, value: number): void {
  (context.session as unknown as { localMaxFilterRanges: number }).localMaxFilterRanges = value;
}

/** Range Filter の指定を REQUEST_UPDATE の Parameter に変換する */
function rangeFilterParameter(spec: RangeFilterSpec): Parameter {
  switch (spec.type) {
    case "subgroup":
      return { type: MessageParameterType.SUBGROUP_FILTER, value: encodeRangeFilter(spec) };
    case "objectId":
      return { type: MessageParameterType.OBJECTID_FILTER, value: encodeRangeFilter(spec) };
    case "priority":
      return { type: MessageParameterType.PRIORITY_FILTER, value: encodeRangeFilter(spec) };
    case "objectProperty":
      return { type: MessageParameterType.OBJECT_PROPERTY_FILTER, value: encodeRangeFilter(spec) };
    default:
      throw new Error(`未対応の Range Filter 種別: ${spec.type}`);
  }
}

// ============================================================================
// publisher 送信経路での Range Filter 適用
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §3.3.2 (SUBGROUP_FILTER) / §11.3.1:
 * moqt-js は FIRST_OBJECT モードで Subgroup を開くため、Subgroup ID は
 * 先頭 Object の Object ID になる。2 件目以降の Object は Object ID が
 * 変わっても同じ Subgroup ID で評価されなければならない。
 */
test("sendObject: SUBGROUP_FILTER は Subgroup ID (先頭 Object ID) で評価する", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 5n, end: 5n }] },
  ]);

  // Group 0 の先頭 Object 5 が Subgroup ID 5 の Subgroup を開く
  await context.publisher.sendObject({ groupId: 0, objectId: 5, payload: new Uint8Array([1]) });
  // 2 件目の Object 6 は Object ID が変わっても Subgroup ID は 5 のまま
  await context.publisher.sendObject({ groupId: 0, objectId: 6, payload: new Uint8Array([2]) });

  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(subgroupStream(context, 0).writes.length, 3);
  const firstHeader = decodeStreamHeader(context, 0);
  assert.equal(firstHeader.groupId, 0n);
  assert.equal(firstHeader.publisherPriority, 128);
  assert.isTrue(firstHeader.firstObject);

  // Group 1 の先頭 Object 7 は Subgroup ID 7 になり不通過
  await context.publisher.sendObject({ groupId: 1, objectId: 7, payload: new Uint8Array([3]) });
  assert.equal(context.subgroupStreams.length, 1);
  const trackAlias = context.publisher.getTrackAlias();
  assert.equal(context.session.publisherStreams.get(trackAlias)?.previousObjectId, 6n);
  assert.equal(context.publisher.getLargestLocation()?.group, 0n);
  assert.equal(context.publisher.getLargestLocation()?.object, 6n);

  // Group 1 の Object 5 は Subgroup ID 5 なので通過し、新しい Subgroup を開く
  await context.publisher.sendObject({ groupId: 1, objectId: 5, payload: new Uint8Array([4]) });
  assert.equal(context.subgroupStreams.length, 2);
  assert.equal(decodeStreamHeader(context, 1).groupId, 1n);
  assert.equal(subgroupStream(context, 1).writes.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 1n);
  assert.equal(context.publisher.getLargestLocation()?.object, 5n);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (SUBGROUP_FILTER) / §11.3.1:
 * 先頭 Object をフィルタで見送った場合、Subgroup は開かない。次に通過した
 * Object がその Subgroup の先頭 (Subgroup ID = その Object ID) になる。
 */
test("sendObject: 見送った先頭 Object は Subgroup を開かず次の Object が先頭になる", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 6n, end: 6n }] },
  ]);

  // Object 5 は Subgroup ID 5 になるため不通過 (Subgroup は開かない)
  await context.publisher.sendObject({ groupId: 0, objectId: 5, payload: new Uint8Array([1]) });
  assert.equal(context.subgroupStreams.length, 0);
  assert.isNull(context.publisher.getLargestLocation());

  // Object 6 が Subgroup ID 6 の先頭として開く
  await context.publisher.sendObject({ groupId: 0, objectId: 6, payload: new Uint8Array([2]) });
  // 2 件目の Object 7 も Subgroup ID 6 で通過する
  await context.publisher.sendObject({ groupId: 0, objectId: 7, payload: new Uint8Array([3]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.isTrue(decodeStreamHeader(context, 0).firstObject);
  assert.equal(subgroupStream(context, 0).writes.length, 3);
  assert.equal(context.publisher.getLargestLocation()?.object, 7n);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (OBJECTID_FILTER) / §3.3.3:
 * Range に含まれない Object ID の Object は送信せず、LARGEST_OBJECT も更新しない。
 * 不通過で見送った Object が残る Subgroup は §11.3.2 に従い RESET で閉じる。
 */
test("sendObject: OBJECTID_FILTER を通過しない Object は送信しない", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    {
      type: "objectId",
      setId: 0,
      ranges: [
        { start: 5n, end: 7n },
        { start: 10n, end: 10n },
      ],
    },
  ]);

  await context.publisher.sendObject({ groupId: 0, objectId: 5, payload: new Uint8Array([1]) });
  await context.publisher.sendObject({ groupId: 0, objectId: 6, payload: new Uint8Array([2]) });
  // 9 は Range 外なので送信しない
  await context.publisher.sendObject({ groupId: 0, objectId: 9, payload: new Uint8Array([3]) });
  await context.publisher.sendObject({ groupId: 0, objectId: 10, payload: new Uint8Array([4]) });
  // 11 も Range 外なので送信しない
  await context.publisher.sendObject({ groupId: 0, objectId: 11, payload: new Uint8Array([5]) });

  // Subgroup Header + Object 5 / 6 / 10 の 4 write だけが送られる
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(subgroupStream(context, 0).writes.length, 4);
  const trackAlias = context.publisher.getTrackAlias();
  assert.equal(context.session.publisherStreams.get(trackAlias)?.previousObjectId, 10n);
  assert.equal(context.publisher.getLargestLocation()?.group, 0n);
  assert.equal(context.publisher.getLargestLocation()?.object, 10n);
  // 9 と 11 を見送ったため、閉じる時は FIN ではなく RESET
  assert.isTrue(context.session.publisherStreams.get(trackAlias)?.subgroupOmissions?.has(0n));
  assert.equal(await publishCloseSubgroupStream(context.session, trackAlias), "reset");
  assert.equal(subgroupStream(context, 0).abortCount, 1);
  assert.equal(subgroupStream(context, 0).closeCount, 0);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (PRIORITY_FILTER) / §11.3.1 / §11.2.1 / §10.4:
 * Subgroup の Publisher Priority は Header で固定されるため、2 件目以降に指定した
 * 値ではなく Header の値で評価する。Datagram は指定値、省略時は既定の
 * Publisher Priority 128 で評価する。
 */
test("sendObject / sendDatagram: PRIORITY_FILTER は wire の Priority で評価する", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    { type: "priority", setId: 0, ranges: [{ start: 100n, end: 200n }] },
  ]);

  // Subgroup の先頭は Priority 150 で開く
  await context.publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
    priority: 150,
  });
  // 2 件目の Priority 0 は wire に載らないため、Header の 150 で評価される
  await context.publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([2]),
    priority: 0,
  });
  assert.equal(subgroupStream(context, 0).writes.length, 3);
  assert.equal(decodeStreamHeader(context, 0).publisherPriority, 150);

  // Datagram は指定値で評価する (50 は不通過)
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 2,
    payload: new Uint8Array([3]),
    priority: 50,
  });
  assert.equal(context.datagramChunks.length, 0);
  // Priority 省略時は既定 128 で評価され、100〜200 の Range を通過する
  await context.publisher.sendDatagram({ groupId: 0, objectId: 3, payload: new Uint8Array([4]) });
  assert.equal(context.datagramChunks.length, 1);
  // 250 も不通過
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 4,
    payload: new Uint8Array([5]),
    priority: 250,
  });
  assert.equal(context.datagramChunks.length, 1);
  // 指定値が Range 内なら通過する
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 5,
    payload: new Uint8Array([6]),
    priority: 150,
  });
  assert.equal(context.datagramChunks.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.object, 5n);

  // 新しい Subgroup の先頭 Priority 50 は不通過
  await context.publisher.sendObject({
    groupId: 1,
    objectId: 0,
    payload: new Uint8Array([7]),
    priority: 50,
  });
  assert.equal(context.subgroupStreams.length, 1);
  // 同じ Group の先頭を Priority 150 で送り直せば通過する
  await context.publisher.sendObject({
    groupId: 1,
    objectId: 0,
    payload: new Uint8Array([8]),
    priority: 150,
  });
  assert.equal(context.subgroupStreams.length, 2);
  assert.equal(decodeStreamHeader(context, 1).publisherPriority, 150);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 / §11.2.1:
 * Datagram は Subgroup ID を持たないため、SUBGROUP_FILTER は不通過になる。
 * 同じ購読でも Subgroup 経由の Object は Subgroup ID で通過する。
 */
test("sendDatagram: SUBGROUP_FILTER は Datagram では不通過になる", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 0n }] },
  ]);

  await context.publisher.sendDatagram({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(context.datagramChunks.length, 0);
  assert.isNull(context.publisher.getLargestLocation());

  // Subgroup 経由の Object 0 は Subgroup ID 0 なので通過する
  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([2]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(context.publisher.getLargestLocation()?.object, 0n);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (PRIORITY_FILTER) / §10.4 / §11.2.1:
 * Datagram で Publisher Priority を省略した場合、wire には Priority フィールドが
 * 無い。しかし購読の Subgroup / Datagram は既定の Publisher Priority を継承し、
 * 省略時の既定値は 128 である (§10.4)。そのため PRIORITY_FILTER は 128 として
 * 評価する。
 */
test("sendDatagram: Priority 省略時は既定 128 として評価され 0〜255 の範囲を通過する", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    { type: "priority", setId: 0, ranges: [{ start: 0n, end: 255n }] },
  ]);

  // 省略しても既定 128 として全 Range を通過し、Largest Object も更新する
  await context.publisher.sendDatagram({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(context.datagramChunks.length, 1);
  assert.equal(context.publisher.getLargestLocation()?.group, 0n);
  assert.equal(context.publisher.getLargestLocation()?.object, 0n);

  // 128 を含まない Range では不通過になる (省略時に 0 や別の値で評価しないことの固定)
  context.publisher.setRangeFilters([
    { type: "priority", setId: 0, ranges: [{ start: 0n, end: 127n }] },
  ]);
  await context.publisher.sendDatagram({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });
  assert.equal(context.datagramChunks.length, 1);
  assert.equal(context.publisher.getLargestLocation()?.group, 0n);

  // 明示値 127 は 0〜127 の Range を通過する
  await context.publisher.sendDatagram({
    groupId: 1,
    objectId: 0,
    payload: new Uint8Array([3]),
    priority: 127,
  });
  assert.equal(context.datagramChunks.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 1n);

  // 明示値 128 は 0〜127 の Range に含まれないため不通過
  await context.publisher.sendDatagram({
    groupId: 2,
    objectId: 0,
    payload: new Uint8Array([4]),
    priority: 128,
  });
  assert.equal(context.datagramChunks.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 1n);
});

/**
 * draft-ietf-moq-transport-23 §3.3.3 (Combining Filters):
 * "Pass = (NOT Paused) AND Location Filters AND Range Filters"
 * Location Filter と Range Filter を同時に設定した場合、両方を通過した Object だけを
 * 送信する。片方だけを通過する Object が送信されないことで AND の合成を固定する。
 */
test("sendObject: Location Filter と Range Filter は AND で合成される", async () => {
  const context = createPublishReadTestContext({});
  // Location Filter: {5, 0} 以降 (終端なし)
  context.publisher.setLocationFilter({ startGroup: 5n, startObject: 0n });
  // Object ID 10〜20 のみ通過する Range Filter
  context.publisher.setRangeFilters([
    { type: "objectId", setId: 0, ranges: [{ start: 10n, end: 20n }] },
  ]);

  // 両方を通過する {5, 10} は送信し、Subgroup を開く
  await context.publisher.sendObject({ groupId: 5, objectId: 10, payload: new Uint8Array([1]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(subgroupStream(context, 0).writes.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 5n);
  assert.equal(context.publisher.getLargestLocation()?.object, 10n);

  // Location だけを通過する {5, 21} (Range 外) は送信しない
  await context.publisher.sendObject({ groupId: 5, objectId: 21, payload: new Uint8Array([2]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(subgroupStream(context, 0).writes.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.object, 10n);

  // Range だけを通過する {4, 15} (Location 外) も送信しない
  await context.publisher.sendObject({ groupId: 4, objectId: 15, payload: new Uint8Array([3]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(subgroupStream(context, 0).writes.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 5n);

  // 両方を通過する {6, 20} は送信し、新しい Subgroup を開く
  await context.publisher.sendObject({ groupId: 6, objectId: 20, payload: new Uint8Array([4]) });
  assert.equal(context.subgroupStreams.length, 2);
  assert.equal(subgroupStream(context, 1).writes.length, 2);
  assert.equal(context.publisher.getLargestLocation()?.group, 6n);
  assert.equal(context.publisher.getLargestLocation()?.object, 20n);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (OBJECT_PROPERTY_FILTER):
 * Object Properties の値で評価する。Subgroup と Datagram の両方に適用する。
 */
test("sendObject / sendDatagram: OBJECT_PROPERTY_FILTER は Object Properties で評価する", async () => {
  const context = createPublishReadTestContext({});
  context.publisher.setRangeFilters([
    {
      type: "objectProperty",
      setId: 0,
      propertyType: 0x100n,
      ranges: [{ start: 5n, end: 5n }],
    },
  ]);
  const matching = encodeProperties([{ id: 0x100n, value: 5n }]);
  const notMatching = encodeProperties([{ id: 0x100n, value: 6n }]);

  await context.publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
    properties: matching,
  });
  await context.publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([2]),
    properties: notMatching,
  });
  assert.equal(subgroupStream(context, 0).writes.length, 2);

  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 2,
    payload: new Uint8Array([3]),
    properties: matching,
  });
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 3,
    payload: new Uint8Array([4]),
    properties: notMatching,
  });
  assert.equal(context.datagramChunks.length, 1);
});

test("GREASE: 末尾に不完全な KVP があってもフィルタと一致した Property を保つ", async () => {
  const context = createPublishReadTestContext({});
  (context.session as unknown as { grease: boolean }).grease = true;
  const property = { id: 0x7an, value: 42n };
  context.publisher.setRangeFilters([
    {
      type: "objectProperty",
      setId: 0,
      propertyType: property.id,
      ranges: [{ start: 42n, end: 42n }],
    },
  ]);
  const prefix = encodeProperties([property]);
  // 不完全な Delta Type で終わる。照合に使った先行 Property は完全に読める。
  const properties = new Uint8Array([...prefix, 0xff]);
  const payload = new Uint8Array([1]);
  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload, properties });
  await context.publisher.sendDatagram({ groupId: 0, objectId: 1, payload, properties });

  const [fields] = decodeObjectFields(
    subgroupStream(context, 0).writes[1],
    decodeStreamHeader(context, 0).type,
  );
  const [datagram] = decodeObjectDatagram(context.datagramChunks[0]);
  for (const encoded of [fields.properties, datagram.properties]) {
    assert.isDefined(encoded);
    const decoded = decodeProperties(encoded, "object");
    assert.deepInclude(decoded, property);
    assert.lengthOf(decoded, 2);
  }
});

test("sendObject: OBJECT_PROPERTY_FILTER は Delivery Timeout を合成した後の値で判定する", async () => {
  for (const { propertyType, options, originalValue, acceptedValue, allowed } of [
    {
      propertyType: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT,
      options: { deliveryTimeout: 20n },
      acceptedValue: 20n,
      allowed: true,
    },
    {
      propertyType: TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT,
      options: { subgroupDeliveryTimeout: 20n },
      originalValue: 10n,
      acceptedValue: 20n,
      allowed: true,
    },
    {
      propertyType: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT,
      options: { deliveryTimeout: 20n },
      originalValue: 10n,
      acceptedValue: 10n,
      allowed: false,
    },
  ]) {
    const context = createPublishReadTestContext({});
    context.publisher.setRangeFilters([
      {
        type: "objectProperty",
        setId: 0,
        propertyType,
        ranges: [{ start: acceptedValue, end: acceptedValue }],
      },
    ]);
    const properties =
      originalValue === undefined
        ? {}
        : { properties: encodeProperties([{ id: propertyType, value: originalValue }]) };
    await context.publisher.sendObject({
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1]),
      ...properties,
      ...options,
    });

    // API 引数を合成した値が一致する場合にだけ、同じ値をワイヤへ書く。
    assert.lengthOf(context.subgroupStreams, allowed ? 1 : 0);
    if (allowed) {
      const [fields] = decodeObjectFields(
        subgroupStream(context, 0).writes[1],
        decodeStreamHeader(context, 0).type,
      );
      const timeouts = readDeliveryTimeoutObjectProperties(fields.properties);
      assert.equal(timeouts.objectDeliveryTimeout, options.deliveryTimeout);
      assert.equal(timeouts.subgroupDeliveryTimeout, options.subgroupDeliveryTimeout);
    }
  }
});

test("sendObject: 終端ステータスに型付き Timeout があるとストリームを開く前に拒否する", async () => {
  const context = createPublishReadTestContext({});
  await context.publisher
    .sendObject({
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array(),
      status: ObjectStatus.END_OF_TRACK,
      deliveryTimeout: 20n,
    })
    .then(
      () => assert.fail("Timeout 付きの END_OF_TRACK が受理された"),
      (error: unknown) => assert.instanceOf(error, ProtocolViolationError),
    );
  assert.isEmpty(context.subgroupStreams);

  // 無効な終端 Object のあとも同じ購読で正常な Object を送れる。
  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.lengthOf(subgroupStream(context, 0).writes, 2);
});

// ============================================================================
// REQUEST_UPDATE による追加・置換・削除・据え置き
// ============================================================================

/** 書き込みの到達と再開を別々に制御する一度限りの通知。 */
function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("REQUEST_UPDATE: 送信キュー待機中の Object に更新後のフィルタを適用する", async () => {
  const filters = [
    encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n, endGroupDelta: 0n }),
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ];
  for (const filter of filters) {
    const firstObjectWrite = deferredSignal();
    const releaseFirstObject = deferredSignal();
    const context = createPublishReadTestContext({}, 0, {
      unidirectionalStream: (record) =>
        new WritableStream<Uint8Array>({
          async write(chunk) {
            record.writes.push(chunk);
            if (context.subgroupStreams.length === 1 && record.writes.length === 2) {
              firstObjectWrite.resolve();
              await releaseFirstObject.promise;
            }
          },
        }),
    });
    advertiseMaxFilterRanges(context, 2);
    const driver = startPublishRequestUpdates(context);
    const first = context.publisher.sendObject({
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1]),
    });
    await firstObjectWrite.promise;
    const queued = context.publisher.sendObject({
      groupId: 1,
      objectId: 1,
      status: ObjectStatus.END_OF_TRACK,
      payload: new Uint8Array(),
    });
    // 先行 Object の書き込み中に購読を更新し、REQUEST_OK のあとでキューを進める。
    await driver.update([filter]);
    releaseFirstObject.resolve();
    await Promise.all([first, queued]);
    assert.lengthOf(context.subgroupStreams, 1);
    assert.lengthOf(subgroupStream(context, 0).writes, 2);

    // 見送った END_OF_TRACK で購読を終端済みにしない。範囲内の次の Group は送信できる。
    const resetFilter =
      filter.type === MessageParameterType.LOCATION_FILTER
        ? encodeLocationFilterParameter({ reset: true })
        : rangeFilterParameter({ type: "objectId", remove: true });
    await driver.update([resetFilter]);
    await context.publisher.sendObject({ groupId: 2, objectId: 0, payload: new Uint8Array([2]) });
    assert.lengthOf(context.subgroupStreams, 2);
    assert.equal(decodeStreamHeader(context, 1).groupId, 2n);
    await driver.finish();
  }
});

test("REQUEST_UPDATE: ストリーム生成や Header の書き込みを待つ Object にも更新を適用する", async () => {
  for (const { waitForHeader, allowed, filterByTimeout } of [
    { waitForHeader: false, allowed: false },
    { waitForHeader: true, allowed: false },
    { waitForHeader: true, allowed: true },
    { waitForHeader: true, allowed: true, filterByTimeout: true },
  ]) {
    const started = deferredSignal();
    const resume = deferredSignal();
    const context = createPublishReadTestContext({}, 0, {
      unidirectionalStream: async (record) => {
        if (!waitForHeader) {
          started.resolve();
          await resume.promise;
        }
        return new WritableStream<Uint8Array>({
          async write(chunk) {
            record.writes.push(chunk);
            if (waitForHeader && record.writes.length === 1) {
              started.resolve();
              await resume.promise;
            }
          },
          abort() {
            record.abortCount++;
          },
        });
      },
    });
    advertiseMaxFilterRanges(context, 2);
    const driver = startPublishRequestUpdates(context);
    const pending = context.publisher.sendObject({
      groupId: 1,
      objectId: 1,
      payload: new Uint8Array([1]),
      ...(filterByTimeout ? { deliveryTimeout: 20n } : {}),
    });
    await started.promise;
    const matchingId = allowed ? 1n : 0n;
    const filter: RangeFilterSpec = filterByTimeout
      ? {
          type: "objectProperty",
          setId: 0,
          propertyType: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT,
          ranges: [{ start: 20n, end: 20n }],
        }
      : { type: "objectId", setId: 0, ranges: [{ start: matchingId, end: matchingId }] };
    await driver.update([rangeFilterParameter(filter)]);
    resume.resolve();
    await pending;
    await driver.finish();

    const stream = subgroupStream(context, 0);
    // §9.9: ヘッダー送信前に RESET した場合も、生成に成功したストリームは数える。
    assert.equal(context.publisher.getDataStreamCount(), 1n);
    if (allowed) {
      // 更新後も通過する Object は Header に続けて書き込む。
      assert.lengthOf(stream.writes, 2);
      assert.equal(stream.abortCount, 0);
    } else {
      // Header を書き始めていればその 1 チャンクだけ残り、Object 本体は送信しない。
      assert.lengthOf(stream.writes, waitForHeader ? 1 : 0);
      assert.equal(stream.abortCount, 1);
      assert.isEmpty(context.session.publisherStreams);
    }
  }
});

test("REQUEST_UPDATE: Group 切替を見送った後の Range Filter は既存 Header の Priority で判定する", async () => {
  const firstObjectWrite = deferredSignal();
  const releaseFirstObject = deferredSignal();
  const context = createPublishReadTestContext({}, 0, {
    unidirectionalStream: (record) =>
      new WritableStream<Uint8Array>({
        async write(chunk) {
          record.writes.push(chunk);
          if (record.writes.length === 2) {
            firstObjectWrite.resolve();
            await releaseFirstObject.promise;
          }
        },
      }),
  });
  advertiseMaxFilterRanges(context, 2);
  const driver = startPublishRequestUpdates(context);
  const payload = new Uint8Array([1]);
  const first = context.publisher.sendObject({ groupId: 0, objectId: 0, priority: 7, payload });
  await firstObjectWrite.promise;
  const nextGroup = context.publisher.sendObject({ groupId: 1, objectId: 0, priority: 9, payload });
  const backToFirst = context.publisher.sendObject({
    groupId: 0,
    objectId: 1,
    priority: 9,
    payload,
  });
  // Group 1 を除外するため、既存の Group 0 の Header が引き続き使われる。
  await driver.update([
    encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n, endGroupDelta: 0n }),
    rangeFilterParameter({ type: "priority", setId: 0, ranges: [{ start: 9n, end: 9n }] }),
  ]);
  releaseFirstObject.resolve();
  await Promise.all([first, nextGroup, backToFirst]);
  await driver.finish();

  assert.lengthOf(context.subgroupStreams, 1);
  assert.equal(decodeStreamHeader(context, 0).publisherPriority, 7);
  // アプリが指定した Priority 9 は既存 Header を変えない。Object 1 は不通過。
  assert.lengthOf(subgroupStream(context, 0).writes, 2);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 / §9.1.6:
 * MAX_FILTER_RANGES を広告した購読では、上限以内の Range Filter を含む
 * REQUEST_UPDATE を受理して REQUEST_OK を返し、送信経路へ反映する。
 */
test("REQUEST_UPDATE: Range Filter を追加すると REQUEST_OK を返し送信経路へ反映する", async () => {
  const context = createPublishReadTestContext({});
  // 自 endpoint が MAX_FILTER_RANGES = 2 を広告した状態を再現する
  advertiseMaxFilterRanges(context, 2);
  const driver = startPublishRequestUpdates(context);
  await driver.update([
    rangeFilterParameter({
      type: "objectId",
      setId: 0,
      ranges: [
        { start: 0n, end: 0n },
        { start: 10n, end: 10n },
      ],
    }),
  ]);
  await driver.finish();

  const messages = decodeWrittenMessages(context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, MessageType.REQUEST_OK);
  assert.equal(context.publisher.getRangeFilters().length, 1);

  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await context.publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  assert.equal(subgroupStream(context, 0).writes.length, 2);
  assert.equal(
    context.session.publisherStreams.get(context.publisher.getTrackAlias())?.previousObjectId,
    0n,
  );
});

test("REQUEST_UPDATE: Location と Range を同時に変える場合は更新後の条件で Subgroup を閉じる", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 1);
  const driver = startPublishRequestUpdates(context);
  const { publisher } = context;
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ]);
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: Uint8Array.of(1) });
  // まとめて適用すると Object 1 は通過する。更新途中の旧 Range を評価すると省略が残る。
  await driver.update([
    encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n }),
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 1n }] }),
  ]);
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: Uint8Array.of(2) });
  await publisher.done();
  await driver.finish();

  const stream = subgroupStream(context, 0);
  assert.lengthOf(stream.writes, 3);
  assert.equal(stream.closeCount, 1);
  assert.equal(stream.abortCount, 0);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * "non-zero replaces it entirely."
 * 同じ型の新しい Range Filter で置換され、旧 Range の Object は送信されない。
 */
test("REQUEST_UPDATE: Range Filter は非ゼロ指定で型全体を置換する", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 2);
  const driver = startPublishRequestUpdates(context);
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ]);
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 5n }] }),
  ]);
  await driver.finish();

  const messages = decodeWrittenMessages(context);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.type, MessageType.REQUEST_OK);
  assert.equal(messages[1]?.type, MessageType.REQUEST_OK);
  assert.deepEqual(context.publisher.getRangeFilters(), [
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 5n }] },
  ]);

  // 置換前の Range にだけ含まれる Object 0 は、更新後に送っても通過しない
  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(context.subgroupStreams.length, 0);
  assert.isNull(context.publisher.getLargestLocation());

  // Object 5 は通過して Subgroup を開く
  await context.publisher.sendObject({ groupId: 0, objectId: 5, payload: new Uint8Array([2]) });
  assert.equal(context.subgroupStreams.length, 1);
  assert.equal(context.publisher.getLargestLocation()?.object, 5n);
});

/**
 * draft-ietf-moq-transport-23 §11.3.2:
 * REQUEST_UPDATE で Range Filter を狭めた時点で、送信中の Subgroup の次の Object が
 * 不通過になる場合は、アプリが送信しなくても省略として記録され、RESET で閉じる。
 */
test("REQUEST_UPDATE: Range Filter を狭めると送信中の Subgroup の次の Object が省略になる", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 2);
  const trackAlias = context.publisher.getTrackAlias();

  // 先に Object 0 を送って Subgroup を開く (次の Object は 1)
  await context.publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(context.session.publisherStreams.get(trackAlias)?.omittedObjects, false);

  const driver = startPublishRequestUpdates(context);
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 5n }] }),
  ]);
  await driver.finish();

  // 次の Object 1 は Range 外なので、更新時点で省略として記録される
  assert.equal(context.session.publisherStreams.get(trackAlias)?.omittedObjects, true);

  // Object 1 は送信されない
  await context.publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  assert.equal(subgroupStream(context, 0).writes.length, 2);
  assert.equal(await publishCloseSubgroupStream(context.session, trackAlias), "reset");
  assert.equal(subgroupStream(context, 0).abortCount, 1);
  assert.equal(subgroupStream(context, 0).closeCount, 0);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * "If a filter parameter is omitted from REQUEST_UPDATE, it is unchanged."
 * 型ごとに独立して据え置かれ、別の型の追加・削除に影響されない。
 * Length 0 はその型全体を削除する。
 */
test("REQUEST_UPDATE: 省略した Range Filter は据え置き、Length 0 で型単位に削除する", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 4);
  const driver = startPublishRequestUpdates(context);

  // 1 通目: PRIORITY_FILTER のみ追加
  await driver.update([
    rangeFilterParameter({ type: "priority", setId: 0, ranges: [{ start: 100n, end: 200n }] }),
  ]);
  // 1 通目だけでは Object ID の制約が無い
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([1]),
    priority: 150,
  });
  assert.equal(context.datagramChunks.length, 1);

  // 2 通目: OBJECTID_FILTER を追加 (PRIORITY_FILTER は省略 = 据え置き)
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ]);
  // Priority 50 は据え置かれた PRIORITY_FILTER で不通過
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([2]),
    priority: 50,
  });
  assert.equal(context.datagramChunks.length, 1);
  // Object ID 1 は追加された OBJECTID_FILTER で不通過
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([3]),
    priority: 150,
  });
  assert.equal(context.datagramChunks.length, 1);
  // 両方を満たす Datagram だけ通過する
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([4]),
    priority: 150,
  });
  assert.equal(context.datagramChunks.length, 2);

  // 3 通目: 両方を Length 0 で削除
  await driver.update([
    rangeFilterParameter({ type: "priority", remove: true }),
    rangeFilterParameter({ type: "objectId", remove: true }),
  ]);
  await driver.finish();

  const messages = decodeWrittenMessages(context);
  assert.equal(messages.length, 3);
  assert.isTrue(messages.every((message) => message.type === MessageType.REQUEST_OK));
  assert.equal(context.publisher.getRangeFilters().length, 0);

  // 削除後は同じ Datagram が通過する
  await context.publisher.sendDatagram({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([5]),
    priority: 50,
  });
  assert.equal(context.datagramChunks.length, 3);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 / §9.1.6 (MAX FILTER RANGES):
 * 上限を超える Range Filter を含む REQUEST_UPDATE は INVALID_FILTER で拒否し、
 * 受理済みの Range Filter を変更しない (検証は状態変更より前に行う)。
 */
test("REQUEST_UPDATE: マージ後に MAX_FILTER_RANGES を超える更新は拒否し状態を変えない", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 2);
  const driver = startPublishRequestUpdates(context);

  // 上限 2 以内の 1 Range は受理される
  await driver.update([
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ]);
  assert.deepEqual(context.publisher.getRangeFilters(), [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] },
  ]);

  // 更新の 2 Ranges と省略された objectId の 1 Range を合わせると上限を超える。
  await driver.update([
    { type: MessageParameterType.PAUSED, value: Uint8Array.of(1) },
    rangeFilterParameter({
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 0n },
        { start: 1n, end: 1n },
      ],
    }),
  ]);
  await driver.finish();

  const messages = decodeWrittenMessages(context);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.type, MessageType.REQUEST_OK);
  const requestError = messages[1];
  if (requestError === undefined) {
    throw new Error("REQUEST_ERROR が書き込まれていない");
  }
  assert.equal(requestError.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(requestError.payload).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.equal(messages[2]?.type, MessageType.PUBLISH_DONE);
  // 拒否された更新は反映されない
  assert.isFalse(context.publisher.paused);
  assert.deepEqual(context.publisher.getRangeFilters(), [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] },
  ]);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * 削除 (Length 0) と異なる型の追加を同じ REQUEST_UPDATE に含められる。
 * 削除は指定した型だけを削除し、別の型の追加は独立して反映される。
 */
test("REQUEST_UPDATE: Length 0 の削除で空いた上限を異なる型の追加に使える", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 1);
  const driver = startPublishRequestUpdates(context);

  await driver.update([
    rangeFilterParameter({ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 0n }] }),
  ]);
  await driver.update([
    rangeFilterParameter({ type: "subgroup", remove: true }),
    rangeFilterParameter({ type: "objectId", setId: 0, ranges: [{ start: 3n, end: 3n }] }),
  ]);
  await driver.finish();

  const filters = context.publisher.getRangeFilters();
  assert.equal(filters.length, 1);
  assert.deepEqual(filters, [{ type: "objectId", setId: 0, ranges: [{ start: 3n, end: 3n }] }]);
});
