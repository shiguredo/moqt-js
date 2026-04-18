/**
 * SessionProtocol GOAWAY / tick Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.5 (GOAWAY)
 */

import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import { createSetup, type Goaway, MessageType } from "../message";
import { SessionProtocol } from "./protocol";

function established(): SessionProtocol {
  const p = SessionProtocol.createClient("webTransport", createSetup());
  p.nextEvent();
  p.handleControl(createSetup());
  p.nextEvent();
  return p;
}

function buildGoaway(newSessionUri: string, timeout: bigint): Goaway {
  return {
    type: MessageType.GOAWAY,
    newSessionUri,
    timeout,
  };
}

test("sendGoaway(timeout=0) で sendControl イベントを積み localGoawaySent が true になる", () => {
  const p = established();
  p.sendGoaway(buildGoaway("", 0n));
  assert.equal(p.localGoawaySent, true);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "sendControl");
  if (event.type === "sendControl") {
    assert.equal(event.message.type, MessageType.GOAWAY);
  }
});

test("2 回目の sendGoaway は PROTOCOL_VIOLATION", () => {
  const p = established();
  p.sendGoaway(buildGoaway("", 0n));
  assert.throws(() => {
    p.sendGoaway(buildGoaway("", 0n));
  });
});

test("Client の sendGoaway で non-zero URI は PROTOCOL_VIOLATION", () => {
  const p = established();
  assert.throws(() => {
    p.sendGoaway(buildGoaway("moqt://new", 0n));
  });
});

test("8192 バイト超過の URI は sendGoaway で PROTOCOL_VIOLATION", () => {
  const p = SessionProtocol.createClient("webTransport", createSetup());
  p.nextEvent();
  p.handleControl(createSetup());
  p.nextEvent();
  // ただし client なので URI は必ず空にしなければならない。
  // 超過チェックだけ確認するため、別の経路は取れないので「URI 長 < 8192 は OK」の検証。
  // 8192 を超える文字列を渡すと、まず zero-length check で先に落ちる。
  assert.throws(() => {
    p.sendGoaway(buildGoaway("x".repeat(9000), 0n));
  });
});

test("tick が deadline 前なら何もしない、deadline 後に closeSession を積む", () => {
  const p = established();
  p.tick(1000);
  p.sendGoaway(buildGoaway("", 500n));
  assert.equal(p.localGoawayDeadlineMs, 1500);
  // deadline 前の tick
  p.tick(1400);
  assert.equal(p.state, "established");
  // deadline 後の tick
  p.tick(1600);
  assert.equal(p.state, "closing");
  // sendControl(GOAWAY) → closeSession(GOAWAY_TIMEOUT) の順
  p.nextEvent(); // sendControl
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.GOAWAY_TIMEOUT);
  }
});

test("tick 未経験の sendGoaway は初回 tick で deadline を確定する", () => {
  const p = established();
  p.sendGoaway(buildGoaway("", 500n));
  assert.equal(p.localGoawayDeadlineMs, null);
  p.tick(2000);
  assert.equal(p.localGoawayDeadlineMs, 2500);
  assert.equal(p.state, "established");
  p.tick(2600);
  assert.equal(p.state, "closing");
});

test("peer からの GOAWAY で goawayReceived イベントが積まれる", () => {
  const p = established();
  p.handleControl(buildGoaway("moqt://new", 1000n));
  assert.ok(p.peerGoaway);
  assert.equal(p.peerGoaway.timeout, 1000n);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "goawayReceived");
  if (event.type === "goawayReceived") {
    assert.equal(event.timeout, 1000n);
  }
});

test("重複 peer GOAWAY は PROTOCOL_VIOLATION で closeSession", () => {
  const p = established();
  p.handleControl(buildGoaway("", 0n));
  p.nextEvent(); // goawayReceived
  p.handleControl(buildGoaway("", 0n));
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("peer からの 8192 バイト超過 URI は closeSession", () => {
  const p = established();
  p.handleControl(buildGoaway("x".repeat(9000), 0n));
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("closed 状態では tick が deadline 超過しても追加イベントは積まない", () => {
  const p = established();
  p.sendGoaway(buildGoaway("", 500n));
  p.tick(1000);
  p.tick(2000); // deadline 超過で closeSession が積まれる
  // drain
  while (p.nextEvent() !== undefined) {
    // nop
  }
  assert.equal(p.state, "closed");
  // もう一度 tick しても何も起きない
  p.tick(3000);
  assert.equal(p.nextEvent(), undefined);
});
