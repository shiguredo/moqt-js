/**
 * PUBLISH / PUBLISH_DONE の異常系・境界値テスト
 *
 * draft-ietf-moq-transport-21 §8.5 (Reason Phrase) / §9.9 (PUBLISH_DONE):
 * Reason Phrase の最大長は 1,024 バイトであり、超過は PROTOCOL_VIOLATION。
 * Error Reason は PUBLISH_DONE の最後のフィールドであり、後続データがあると
 * 消費バイト数が Message Body 長と一致しないため違反となる。
 *
 * 正常系の round-trip は src/message/publish.prop.ts の PBT が担う。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "./types";
import { MAX_REASON_PHRASE_LENGTH, createTrackNamespace } from "./parameter";
import {
  type Publish,
  decodePublishDonePayload,
  decodePublishPayload,
  encodePublishDonePayload,
  encodePublishPayload,
} from "./publish";

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

test("decodePublishDonePayload: Reason Phrase が上限を 1 超えると PROTOCOL_VIOLATION", () => {
  const reasonPhrase = "a".repeat(MAX_REASON_PHRASE_LENGTH + 1);
  const encoded = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase,
  });

  assert.throws(
    () => decodePublishDonePayload(encoded, 0),
    new RegExp(
      `reason phrase length exceeds maximum: ${MAX_REASON_PHRASE_LENGTH + 1} > ${MAX_REASON_PHRASE_LENGTH}`,
    ),
  );
});

test("decodePublishDonePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "done",
  });
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  assert.throws(
    () => decodePublishDonePayload(withTrailing, 0),
    /trailing data in PUBLISH_DONE: expected \d+ bytes, consumed \d+/,
  );
});

/**
 * draft-ietf-moq-transport-21 §9.8 (PUBLISH):
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
