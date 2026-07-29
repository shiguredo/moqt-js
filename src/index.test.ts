/**
 * connect() の MSF URI fragment connection チェックテスト
 * draft-ietf-moq-msf-01 §11.1.1
 */

import { test, assert } from "vite-plus/test";
import { connect } from "./index";

// connection=q は Native QUIC 未実装のため明確にエラーにする
test("connect: connection=q で Native QUIC 未実装エラーが throw される", async () => {
  try {
    await connect("moqt://example.com/app#msf:catalog--catalog&connection=q");
    assert.fail("expected error was not thrown");
  } catch (err) {
    assert.instanceOf(err, Error);
    assert.include((err as Error).message, "native QUIC connection is not supported");
  }
});

// connection=wt は WebTransport 接続を許可する（接続先がないため WebTransport エラーになるが、
// connection チェックでは拒否されないことを確認する）
test("connect: connection=wt は connection チェックで拒否されない", async () => {
  try {
    await connect("moqt://example.com/app#msf:catalog--catalog&connection=wt");
    assert.fail("expected error was not thrown");
  } catch (err) {
    // connection チェックのエラーメッセージではないことを確認
    assert.notInclude((err as Error).message, "native QUIC connection is not supported");
  }
});

// connection 欠如時は現状どおり（connection チェックで拒否されない）
test("connect: connection 欠如時は connection チェックで拒否されない", async () => {
  try {
    await connect("moqt://example.com/app#msf:catalog--catalog");
    assert.fail("expected error was not thrown");
  } catch (err) {
    assert.notInclude((err as Error).message, "native QUIC connection is not supported");
  }
});
