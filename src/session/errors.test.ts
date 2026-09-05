import { test, assert } from "vite-plus/test";
import { isSessionClosedError, isPeerStreamError, toProtocolViolationSessionError } from "./errors";
import {
  IncompleteDataError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
} from "../error";

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
  // 空メッセージの Error が message.includes 経路で false になることを検証する
  const error = new Error("placeholder");
  error.message = "";
  assert.isFalse(isSessionClosedError(error));
});

test("isSessionClosedError: WebTransportError 互換オブジェクト (source: 'session') は true", () => {
  // テスト環境では WebTransportError グローバルが定義されていない場合があるので、
  // クラスを擬似的に注入してフォールバックではなく source 判定を経由させる
  class FakeWebTransportError extends Error {
    source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = "FakeWebTransportError";
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
      this.name = "FakeWebTransportError";
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

test("toProtocolViolationSessionError: ProtocolViolationError は PROTOCOL_VIOLATION の SessionError に変換される", () => {
  // 本物の ProtocolViolationError を渡し、変換後の SessionError がコードとメッセージを引き継ぐことを検証する
  const original = new ProtocolViolationError("GOAWAY URI length exceeds maximum: 9000 > 8192");
  const sessionError = toProtocolViolationSessionError(original);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(sessionError?.message, "GOAWAY URI length exceeds maximum: 9000 > 8192");
});

test("toProtocolViolationSessionError: IncompleteDataError は PROTOCOL_VIOLATION の SessionError に変換される", () => {
  // Length が揃った後のメッセージ構造の破損は仕様違反として
  // PROTOCOL_VIOLATION で閉じる (リポジトリ共通解釈)
  const original = new IncompleteDataError("incomplete request update fields");
  const sessionError = toProtocolViolationSessionError(original);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(sessionError?.message, "incomplete request update fields");
});

test("toProtocolViolationSessionError: 通常の Error は null を返す", () => {
  // ストリームの正常終了・キャンセル等で投げられる通常の Error は握り潰し対象なので null
  const sessionError = toProtocolViolationSessionError(new Error("stream reset by peer"));
  assert.isNull(sessionError);
});

test("toProtocolViolationSessionError: 変換対象以外のエラークラスは null を返す", () => {
  // 別の Error 派生クラス (SessionError) を渡しても変換対象 (ProtocolViolationError /
  // IncompleteDataError) ではないので null になることを検証する。closeWithError が
  // 投げうる SessionError を二度 PROTOCOL_VIOLATION 化して握り潰さない意図を担保する。
  const sessionError = toProtocolViolationSessionError(
    new SessionError("already closed", SessionErrorCode.PROTOCOL_VIOLATION),
  );
  assert.isNull(sessionError);
});

test("toProtocolViolationSessionError: undefined は null を返す", () => {
  // reader.read() の reject が値を持たないケースを想定し、undefined でも安全に null を返す
  assert.isNull(toProtocolViolationSessionError(undefined));
});

test("toProtocolViolationSessionError: null は null を返す", () => {
  // throw null / Promise.reject(null) のように値が null のケースでも安全に null を返す
  assert.isNull(toProtocolViolationSessionError(null));
});

test("toProtocolViolationSessionError: Error を継承しないオブジェクトは null を返す", () => {
  // WebTransport の reject が DOMException 相当の独自オブジェクトを渡しても、
  // ProtocolViolationError ではないため null になることを検証する
  const domExceptionLike = { name: "AbortError", message: "aborted" };
  assert.isNull(toProtocolViolationSessionError(domExceptionLike));
});

// ============================================================================
// isPeerStreamError のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §3.3.3:
 * ピアは STOP_SENDING / RESET_STREAM で当方の送信方向をキャンセルできる。
 * キャンセルされた writable の write / close は WebTransportError
 * (source: "stream") で reject する (W3C WebTransport の実装挙動)。
 * source === "stream" の失敗はピア起因のキャンセルであり、
 * PROTOCOL_VIOLATION に昇格させない。
 */
test("isPeerStreamError: source: 'stream' を持つ Error は true", () => {
  const error = Object.assign(new Error("peer cancel"), { source: "stream" });
  assert.isTrue(isPeerStreamError(error));
});

test("isPeerStreamError: source: 'stream' を持つオブジェクトは true", () => {
  // Error を継承しないプレーンオブジェクトでも source プロパティを直接読む
  assert.isTrue(isPeerStreamError({ source: "stream", streamErrorCode: 0x1 }));
});

test("isPeerStreamError: source: 'session' を持つ Error は false", () => {
  const error = Object.assign(new Error("session closed"), { source: "session" });
  assert.isFalse(isPeerStreamError(error));
});

test("isPeerStreamError: source を持たない Error は false", () => {
  assert.isFalse(isPeerStreamError(new Error("internal error")));
});

test("isPeerStreamError: null / undefined は false", () => {
  assert.isFalse(isPeerStreamError(null));
  assert.isFalse(isPeerStreamError(undefined));
});

test("isPeerStreamError: 非オブジェクトは false", () => {
  // reject が文字列等の非オブジェクト値を渡すケースを想定し、安全に false を返す
  assert.isFalse(isPeerStreamError("stream"));
  assert.isFalse(isPeerStreamError(42));
});
