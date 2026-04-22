/**
 * RequestIdGenerator / RequestIdTracker Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.1, 9.2
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import { RequestIdGenerator, RequestIdTracker } from "./requestId";

test("RequestIdGenerator は 0 から始まる偶数列を返す", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100 }), (count) => {
      const gen = new RequestIdGenerator();
      for (let i = 0; i < count; i++) {
        const id = gen.nextId();
        assert.equal(id, BigInt(i * 2));
      }
    }),
  );
});

test("peek は次回 nextId() の値と一致する", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100 }), (count) => {
      const gen = new RequestIdGenerator();
      for (let i = 0; i < count; i++) {
        gen.nextId();
      }
      const peeked = gen.peek();
      const next = gen.nextId();
      assert.equal(peeked, next);
    }),
  );
});

test("奇数 parity の Request ID は accept される", () => {
  fc.assert(
    fc.property(
      fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 0, maxLength: 50 }),
      (rawIds) => {
        const tracker = new RequestIdTracker();
        // 奇数 parity (peer = server) に正規化し、重複除去
        const ids = Array.from(new Set(rawIds.map((v) => (v % 2n === 1n ? v : v + 1n))));
        for (const id of ids) {
          const err = tracker.accept(id);
          assert.equal(err, null);
        }
        assert.equal(tracker.seenCount, ids.length);
      },
    ),
  );
});

test("偶数 parity の Request ID は INVALID_REQUEST_ID で拒否される", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (id) => {
      // 偶数に正規化
      const evenId = (id / 2n) * 2n;
      const tracker = new RequestIdTracker();
      const err = tracker.accept(evenId);
      assert.notEqual(err, null);
      assert.equal(err?.code, SessionErrorCode.INVALID_REQUEST_ID);
    }),
  );
});

test("重複する Request ID は INVALID_REQUEST_ID で拒否される", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (id) => {
      // 奇数 (peer = server) に正規化
      const validId = (id / 2n) * 2n + 1n;
      const tracker = new RequestIdTracker();
      assert.equal(tracker.accept(validId), null);
      const second = tracker.accept(validId);
      assert.notEqual(second, null);
      assert.equal(second?.code, SessionErrorCode.INVALID_REQUEST_ID);
    }),
  );
});

test("validateRequiredDelta(_, 0) は常に null", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (requestId) => {
      assert.equal(RequestIdTracker.validateRequiredDelta(requestId, 0n), null);
    }),
  );
});

test("2 * delta <= request_id は OK", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      fc.bigInt({ min: 0n, max: 500_000n }),
      (rawRequestId, rawDelta) => {
        // request_id = 2*delta 以上に調整
        const delta = rawDelta;
        const requestId = rawRequestId + 2n * delta;
        assert.equal(RequestIdTracker.validateRequiredDelta(requestId, delta), null);
      },
    ),
  );
});

test("2 * delta > request_id は INVALID_REQUIRED_REQUEST_ID", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      (rawRequestId, extraDelta) => {
        // 2 * delta > request_id を強制
        const requestId = rawRequestId;
        // delta = (requestId + extraDelta) を 2 で割って大きくする
        const delta = (requestId + extraDelta + 1n) / 2n + 1n;
        // 2 * delta > requestId を確実に成立させる
        const err = RequestIdTracker.validateRequiredDelta(requestId, delta);
        assert.notEqual(err, null);
        assert.equal(err?.code, SessionErrorCode.INVALID_REQUIRED_REQUEST_ID);
      },
    ),
  );
});
