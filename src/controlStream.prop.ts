/**
 * Control Stream フレーミングの Property-Based Tests
 *
 * draft-ietf-moq-transport-23 §9 (Control Messages):
 * Control Message は Type (vi64) + Message Length (vi64) + Message Body で構成する。
 * 任意の Type・本文・チャンク分割に対して roundtrip が成立することと、
 * MAX_CONTROL_MESSAGE_SIZE との境界で送信可否が反転することを検証する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import { MessageType } from "./message/types";
import { SessionError, SessionErrorCode } from "./error";
import { encodeVarint } from "./varint";

/**
 * メッセージ Type の Arbitrary
 *
 * vi64 のうち JS の number で正確に表現できる範囲から生成する。
 */
const messageTypeArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/**
 * 本文の Arbitrary (既定上限 65535 に収まる長さ)
 *
 * 境界 (65535 ちょうど) は単体テストで固定するため、ここでは探索空間を
 * 広げすぎないよう 1,024 バイトまでにする。
 */
const payloadArb = fc.uint8Array({ maxLength: 1024 });

/**
 * チャンクサイズの列の Arbitrary
 *
 * 0 を許すと進まなくなるため、1 以上に固定する。
 */
const chunkSizesArb = fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 40 });

test("任意の Type と本文の roundtrip が成立する", () => {
  fc.assert(
    fc.property(messageTypeArb, payloadArb, (type, payload) => {
      const messages = new ControlStreamReader().feed(
        new ControlStreamWriter().encode(type, payload),
      );
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.type, type);
      assert.deepEqual(messages[0]?.payload, payload);
    }),
  );
});

test("任意のチャンク分割でも roundtrip が成立する", () => {
  fc.assert(
    fc.property(messageTypeArb, payloadArb, chunkSizesArb, (type, payload, chunkSizes) => {
      const frame = new ControlStreamWriter().encode(type, payload);
      const reader = new ControlStreamReader();
      const decoded: { type: number; payload: Uint8Array }[] = [];
      let offset = 0;
      let chunkIndex = 0;
      while (offset < frame.length) {
        const chunkSize = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
        const nextOffset = Math.min(frame.length, offset + chunkSize);
        decoded.push(...reader.feed(frame.slice(offset, nextOffset)));
        offset = nextOffset;
        chunkIndex++;
      }
      assert.equal(decoded.length, 1);
      assert.equal(decoded[0]?.type, type);
      assert.deepEqual(decoded[0]?.payload, payload);
    }),
  );
});

test("MAX_CONTROL_MESSAGE_SIZE との境界で送信可否が反転する", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 4096 }), (limit) => {
      const writer = new ControlStreamWriter(limit);
      const reader = new ControlStreamReader(limit);
      // 上限ちょうどは送信でき、同じ上限の reader で受理できる
      const payload = new Uint8Array(limit).fill(0x01);
      const messages = reader.feed(writer.encode(MessageType.GOAWAY, payload));
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.payload.length, limit);
      // 1 バイト超えると送信前に拒否される
      assert.throws(
        () => writer.encode(MessageType.GOAWAY, new Uint8Array(limit + 1)),
        `exceeds peer maximum ${limit}`,
      );
    }),
  );
});

test("宣言長がローカル上限を超えると本文の到着前に FIELD_LENGTH_EXCEEDED になる", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4096 }),
      fc.integer({ min: 1, max: 4096 }),
      (limit, overshoot) => {
        const reader = new ControlStreamReader(limit);
        const declaredLength = limit + overshoot;
        // Type と Message Length だけを供給し、本文は供給しない
        const header = new Uint8Array([
          ...encodeVarint(MessageType.GOAWAY),
          ...encodeVarint(declaredLength),
        ]);
        let error: unknown;
        try {
          reader.feed(header);
        } catch (caught) {
          error = caught;
        }
        assert.instanceOf(error, SessionError);
        assert.equal((error as SessionError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
      },
    ),
  );
});
