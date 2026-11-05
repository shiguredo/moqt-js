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
import { MessageType, MessageParameterType } from "../message/types";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { encodeRangeFilter, type Parameter, type RangeFilterSpec } from "../message/parameter";
import { decodeSubgroupHeader, type SubgroupHeader } from "../dataStream";
import { decodeRequestErrorPayload } from "../message/session";
import { RequestErrorCode } from "../error";
import { ControlStreamReader, type ControlMessage } from "../controlStream";
import { encodeProperties } from "../properties";
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
  assert.isTrue(context.session.publisherStreams.get(trackAlias)?.omittedObjects);
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

// ============================================================================
// REQUEST_UPDATE による追加・置換・削除・据え置き
// ============================================================================

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
test("REQUEST_UPDATE: MAX_FILTER_RANGES を超える Range Filter は拒否し状態を変えない", async () => {
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

  // 3 Ranges は上限 2 を超えるため拒否される
  await driver.update([
    rangeFilterParameter({
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 0n },
        { start: 1n, end: 1n },
        { start: 2n, end: 2n },
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
  assert.deepEqual(context.publisher.getRangeFilters(), [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 0n }] },
  ]);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * 削除 (Length 0) と異なる型の追加を同じ REQUEST_UPDATE に含められる。
 * 削除は指定した型だけを削除し、別の型の追加は独立して反映される。
 */
test("REQUEST_UPDATE: Length 0 の削除と異なる型の追加を同じ更新で送れる", async () => {
  const context = createPublishReadTestContext({});
  advertiseMaxFilterRanges(context, 2);
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
