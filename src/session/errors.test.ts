import { test, assert } from "vite-plus/test";
import { isSessionClosedError } from "./errors";

test("isSessionClosedError: メッセージに 'session is closed' を含むエラーは true", () => {
  const error = new Error("The session is closed.");
  assert.isTrue(isSessionClosedError(error));
});

test("isSessionClosedError: メッセージに 'session closed' を含むエラーは true", () => {
  const error = new Error("session closed by peer");
  assert.isTrue(isSessionClosedError(error));
});

test("isSessionClosedError: 関係ないメッセージのエラーは false", () => {
  const error = new Error("stream reset by peer");
  assert.isFalse(isSessionClosedError(error));
});

test("isSessionClosedError: 空メッセージのエラーは false", () => {
  const error = new Error("");
  assert.isFalse(isSessionClosedError(error));
});

test("isSessionClosedError: WebTransportError 互換オブジェクト (source: 'session') は true", () => {
  // テスト環境では WebTransportError グローバルが定義されていない場合があるので、
  // クラスを擬似的に注入してフォールバックではなく source 判定を経由させる
  class FakeWebTransportError extends Error {
    source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = "WebTransportError";
      this.source = source;
    }
  }
  const original = (globalThis as { WebTransportError?: unknown }).WebTransportError;
  (globalThis as { WebTransportError?: unknown }).WebTransportError = FakeWebTransportError;
  try {
    const sessionError = new FakeWebTransportError("anything", "session");
    assert.isTrue(isSessionClosedError(sessionError));
  } finally {
    (globalThis as { WebTransportError?: unknown }).WebTransportError = original;
  }
});

test("isSessionClosedError: WebTransportError 互換オブジェクト (source: 'stream') は false", () => {
  class FakeWebTransportError extends Error {
    source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = "WebTransportError";
      this.source = source;
    }
  }
  const original = (globalThis as { WebTransportError?: unknown }).WebTransportError;
  (globalThis as { WebTransportError?: unknown }).WebTransportError = FakeWebTransportError;
  try {
    // source が "stream" なら session 終了起源ではないので、フォールバック判定 (message) のみ
    const streamError = new FakeWebTransportError("stream RESET", "stream");
    assert.isFalse(isSessionClosedError(streamError));
  } finally {
    (globalThis as { WebTransportError?: unknown }).WebTransportError = original;
  }
});
