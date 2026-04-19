/**
 * SessionMachine Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.4 (SETUP)
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import { createSetup, MessageType } from "../message";
import type { Setup } from "../message";
import { SessionMachine } from "./machine";

// Setup arbitrary (Phase 2 時点では中身の違いは本質的ではないのでデフォルト値で十分)
const setupArb: fc.Arbitrary<Setup> = fc.constant(createSetup());

// Transport arbitrary (WebTransport のみ)
const transportArb = fc.constant("webTransport" as const);

test("createClient 直後は setup 状態になる", () => {
  fc.assert(
    fc.property(transportArb, setupArb, (transport, setup) => {
      const p = SessionMachine.createClient(transport, setup);
      assert.equal(p.state, "setup");
      assert.equal(p.role, "client");
      assert.equal(p.transport, transport);
      assert.strictEqual(p.localSetup, setup);
      assert.equal(p.peerSetup, null);
    }),
  );
});

test("createClient 直後は sendControl(SETUP) イベントが 1 件だけ積まれる", () => {
  fc.assert(
    fc.property(transportArb, setupArb, (transport, setup) => {
      const p = SessionMachine.createClient(transport, setup);
      const first = p.nextEvent();
      assert.ok(first !== undefined);
      assert.equal(first.type, "sendControl");
      if (first.type === "sendControl") {
        assert.equal(first.message.type, MessageType.SETUP);
        assert.strictEqual(first.message, setup);
      }
      assert.equal(p.nextEvent(), undefined);
    }),
  );
});

test("peer SETUP を受信すると established 状態に遷移する", () => {
  fc.assert(
    fc.property(transportArb, setupArb, setupArb, (transport, localSetup, peerSetup) => {
      const p = SessionMachine.createClient(transport, localSetup);
      // 自側 SETUP イベントを消費
      p.nextEvent();
      // peer SETUP を受信
      p.handleControl(peerSetup);
      assert.equal(p.state, "established");
      assert.strictEqual(p.peerSetup, peerSetup);
      const event = p.nextEvent();
      assert.ok(event !== undefined);
      assert.equal(event.type, "established");
    }),
  );
});

test("重複した peer SETUP を受信すると closeSession イベントが出る", () => {
  fc.assert(
    fc.property(transportArb, setupArb, setupArb, (transport, localSetup, peerSetup) => {
      const p = SessionMachine.createClient(transport, localSetup);
      p.nextEvent();
      p.handleControl(peerSetup);
      p.nextEvent(); // established
      // 2 回目の SETUP を受信
      p.handleControl(peerSetup);
      assert.equal(p.state, "closing");
      const event = p.nextEvent();
      assert.ok(event !== undefined);
      assert.equal(event.type, "closeSession");
      if (event.type === "closeSession") {
        assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
      }
      // nextEvent で closeSession を取り出すと closed に遷移する
      assert.equal(p.state, "closed");
    }),
  );
});

test("制御ストリームに SETUP 以外を流すと closeSession が出る", () => {
  fc.assert(
    fc.property(transportArb, setupArb, (transport, setup) => {
      const p = SessionMachine.createClient(transport, setup);
      p.nextEvent();
      p.handleControl(setup);
      p.nextEvent(); // established
      // REQUEST_OK (制御ストリームに流してはならない) を渡す
      p.handleControl({ type: MessageType.REQUEST_OK, parameters: [] });
      assert.equal(p.state, "closing");
      const event = p.nextEvent();
      assert.ok(event !== undefined);
      assert.equal(event.type, "closeSession");
      if (event.type === "closeSession") {
        assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
      }
    }),
  );
});

test("close を呼ぶと closing に遷移し closeSession イベントが出る", () => {
  fc.assert(
    fc.property(
      transportArb,
      setupArb,
      fc.constantFrom(
        SessionErrorCode.NO_ERROR,
        SessionErrorCode.INTERNAL_ERROR,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
      fc.string({ minLength: 0, maxLength: 64 }),
      (transport, setup, code, reason) => {
        const p = SessionMachine.createClient(transport, setup);
        p.close(code, reason);
        assert.equal(p.state, "closing");
        // sendControl(SETUP) → closeSession の順
        const sendCtrl = p.nextEvent();
        assert.ok(sendCtrl !== undefined);
        assert.equal(sendCtrl.type, "sendControl");
        const closeEvent = p.nextEvent();
        assert.ok(closeEvent !== undefined);
        assert.equal(closeEvent.type, "closeSession");
        if (closeEvent.type === "closeSession") {
          assert.equal(closeEvent.error.code, code);
          assert.equal(closeEvent.error.message, reason);
        }
        assert.equal(p.state, "closed");
      },
    ),
  );
});

test("closed 状態では handleControl が no-op になる", () => {
  fc.assert(
    fc.property(transportArb, setupArb, (transport, setup) => {
      const p = SessionMachine.createClient(transport, setup);
      p.close(SessionErrorCode.NO_ERROR, "bye");
      while (p.nextEvent() !== undefined) {
        // drain
      }
      assert.equal(p.state, "closed");
      // この状態で peer SETUP を送っても何も起きない
      p.handleControl(setup);
      assert.equal(p.state, "closed");
      assert.equal(p.nextEvent(), undefined);
    }),
  );
});

test("2 回目の close 呼び出しは no-op", () => {
  fc.assert(
    fc.property(transportArb, setupArb, (transport, setup) => {
      const p = SessionMachine.createClient(transport, setup);
      p.close(SessionErrorCode.NO_ERROR, "bye");
      // 2 回目の close は closing 状態なので何も起きない
      p.close(SessionErrorCode.INTERNAL_ERROR, "again");
      assert.equal(p.state, "closing");
      // sendControl 以外の closeSession イベントは 1 件のみ
      let closeCount = 0;
      for (let event = p.nextEvent(); event !== undefined; event = p.nextEvent()) {
        if (event.type === "closeSession") {
          closeCount++;
        }
      }
      assert.equal(closeCount, 1);
    }),
  );
});
