/**
 * PUBLISH / PUBLISH_DONE の異常系・境界値テストと FILL_PARAMETERS の配置テスト
 *
 * draft-ietf-moq-transport-23 §9.8 (PUBLISH) / §9.19.15 (FILL PARAMETERS):
 * PUBLISH の Parameters に FILL_PARAMETERS が含まれても、後続の Track Properties の
 * 位置がずれないことを統合確認する (外側 Length の不在そのものは
 * parameter.test.ts の固定ワイヤが検証する)。
 *
 * draft-ietf-moq-transport-23 §8.5 (Reason Phrase) / §9.9 (PUBLISH_DONE):
 * Reason Phrase の最大長は 1,024 バイトであり、超過は FIELD_LENGTH_EXCEEDED。
 * Error Reason は PUBLISH_DONE の最後のフィールドであり、後続データがあると
 * 消費バイト数が Message Body 長と一致しないため違反となる。
 *
 * 正常系の round-trip は src/message/publish.prop.ts の PBT が担う。
 * 上限超過 (1,025 バイト) の FIELD_LENGTH_EXCEEDED も src/message/publish.prop.ts が
 * 上限値そのものを固定して検証する。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { MessageType } from "./types";
import {
  MAX_REASON_PHRASE_LENGTH,
  createTrackNamespace,
  decodeFillParameters,
  encodeFillParameters,
  encodeLocationFilterParameter,
} from "./parameter";
import {
  type Publish,
  decodePublishDonePayload,
  decodePublishPayload,
  encodePublishDonePayload,
  encodePublishPayload,
} from "./publish";
import { MalformedTrackError, ProtocolViolationError, SessionErrorCode } from "../error";
import { PublishDoneStatusCode } from "./types";
import { captureThrownError } from "../testSupport/helpers";

test("decodePublishDonePayload: Reason Phrase が上限ちょうどなら通過する", () => {
  const reasonPhrase = "a".repeat(MAX_REASON_PHRASE_LENGTH);
  const encoded = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase,
  });

  const decoded = decodePublishDonePayload(encoded, 0);
  assert.equal(decoded.reasonPhrase.length, MAX_REASON_PHRASE_LENGTH);
});

test("decodePublishDonePayload: 末尾に後続データがあると MALFORMED_MESSAGE", () => {
  const encoded = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "done",
  });
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  const thrown = captureThrownError(() => decodePublishDonePayload(withTrailing, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /trailing data in PUBLISH_DONE: expected \d+ bytes, consumed \d+/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.8 (PUBLISH):
 * Track Properties は length プレフィックスを持たず、Message の Length フィールド
 * で終端が決まる。したがって PUBLISH には「末尾の後続データ」という不正が無く、
 * 残りバイトはすべて Track Properties として解釈される。
 * 空の Track Properties と非空の Track Properties の双方でこの契約を固定する。
 */
test("decodePublishPayload: Track Properties は残りバイトすべてとして読み戻される", () => {
  const base = {
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    trackAlias: 7n,
    parameters: [],
  } satisfies Omit<Publish, "trackProperties">;

  // 空の Track Properties
  const empty = decodePublishPayload(encodePublishPayload({ ...base, trackProperties: [] }), 0);
  assert.equal(empty.trackProperties.length, 0);
  assert.equal(empty.trackAlias, 7n);

  // 非空の Track Properties (OBJECT_DELIVERY_TIMEOUT 0x02)
  const properties = [{ id: 0x02n, value: 5n }];
  const withProperties = decodePublishPayload(
    encodePublishPayload({ ...base, trackProperties: properties }),
    0,
  );
  assert.deepEqual(withProperties.trackProperties, properties);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15 / §9.8:
 * PUBLISH は Parameters の後ろに Track Properties が続く。FILL_PARAMETERS の
 * Value は Number of Parameters + Parameters の自己区切り構造で外側 Length を
 * 持たないため、fill を含む Parameters を復号しても後続の Track Properties の
 * 位置がずれないことを検証する。
 */
test("decodePublishPayload: FILL_PARAMETERS を含んでも Track Properties を誤読しない", () => {
  const base = {
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    trackAlias: 7n,
  } satisfies Omit<Publish, "parameters" | "trackProperties">;

  // 内側 2 件 (LOCATION_FILTER と SUBSCRIBER_PRIORITY) の fill と、
  // fill の前に置く外側パラメータ SUBSCRIBER_PRIORITY (0x20、PUBLISH の許可型)
  const fillParameter = encodeFillParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: 0x20, value: new Uint8Array([10]) },
  ]);
  const parameters = [{ type: 0x20, value: new Uint8Array([0x07]) }, fillParameter];
  const properties = [{ id: 0x02n, value: 5n }];

  const encoded = encodePublishPayload({ ...base, parameters, trackProperties: properties });
  const decoded = decodePublishPayload(encoded, 0);

  // fill の前の外側パラメータと fill が 2 件として読まれる
  assert.equal(decoded.parameters.length, 2);
  assert.equal(decoded.parameters[0].type, 0x20);
  assert.deepEqual(decoded.parameters[0].value, new Uint8Array([0x07]));
  assert.equal(decoded.parameters[1].type, 0x23);
  // fill の内側は 2 件のまま保たれる
  assert.equal(decodeFillParameters(decoded.parameters[1]).length, 2);
  // 後続の Track Properties が正しい位置から読まれる
  assert.deepEqual(decoded.trackProperties, properties);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15 / §9:
 * 制御メッセージは Message Length でフレーミングされ、ControlStreamReader は
 * フレームが揃った時点で完全な payload を返す。このテストは 1 バイトずつ供給した
 * 場合でも、フレーム再構成後の PUBLISH payload で FILL_PARAMETERS の消費長が
 * 正しく、後続の Track Properties の位置がずれないことをエンドツーエンドで確認する
 * (fill 固有のチャンク処理ではなく、reader の再構成 + payload 復号の結合を固定する)。
 */
test("decodePublishPayload: チャンク境界で分割されても FILL_PARAMETERS を復号できる", () => {
  const base = {
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    trackAlias: 7n,
  } satisfies Omit<Publish, "parameters" | "trackProperties">;

  const fillParameter = encodeFillParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: 0x20, value: new Uint8Array([10]) },
  ]);
  const properties = [{ id: 0x02n, value: 5n }];
  const payload = encodePublishPayload({
    ...base,
    parameters: [fillParameter],
    trackProperties: properties,
  });
  const frame = new ControlStreamWriter().encode(MessageType.PUBLISH, payload);

  // 1 バイトずつチャンクとして流し、フレームが揃った時点で 1 通になる
  const reader = new ControlStreamReader();
  const messages: { type: number; payload: Uint8Array }[] = [];
  for (let offset = 0; offset < frame.length; offset += 1) {
    messages.push(...reader.feed(frame.slice(offset, offset + 1)));
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.PUBLISH);

  const decoded = decodePublishPayload(messages[0].payload, 0);
  assert.equal(decoded.parameters.length, 1);
  assert.equal(decodeFillParameters(decoded.parameters[0]).length, 2);
  assert.deepEqual(decoded.trackProperties, properties);
});

/**
 * draft-ietf-moq-transport-23 §8.4 / §12.1 条件 8:
 * PUBLISH の Track Properties に Object-only Property (LOC TIMESTAMP) が含まれると
 * Track を malformed とする。MalformedTrackError を投げ、セッション終了
 * (ProtocolViolationError) にはしない。両 scope の Property は受理する。
 */
test("decodePublishPayload: Track Properties の scope 違反で MalformedTrackError", () => {
  const base = {
    type: MessageType.PUBLISH as typeof MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
  };
  // LOC TIMESTAMP (0x10) は Object scope のみ
  const objectOnly = encodePublishPayload({
    ...base,
    trackProperties: [{ id: 0x10n, value: 1n }],
  });
  assert.throws(() => decodePublishPayload(objectOnly), MalformedTrackError);

  // OBJECT_DELIVERY_TIMEOUT (0x02) は Track / Object 両 scope
  const bothScopes = encodePublishPayload({
    ...base,
    trackProperties: [{ id: 0x02n, value: 1n }],
  });
  assert.deepEqual(decodePublishPayload(bothScopes).trackProperties, [{ id: 0x02n, value: 1n }]);
});

/**
 * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE) / §12.4:
 * EXPIRED_AUTH_TOKEN (0x7) は既知 status として codec で保持され、未知コードや
 * 不要な Session エラーにならない。TRACK_ENDED (0x2) の既存経路も維持する。
 */
test("PUBLISH_DONE: EXPIRED_AUTH_TOKEN (0x7) をエンコード・デコードで保持する", () => {
  const encoded = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: BigInt(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN),
    streamCount: 0n,
    reasonPhrase: "auth token expired",
  });
  const decoded = decodePublishDonePayload(encoded);
  assert.equal(decoded.statusCode, BigInt(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN));
  assert.equal(decoded.reasonPhrase, "auth token expired");
});
