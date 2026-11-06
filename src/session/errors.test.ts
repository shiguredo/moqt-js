import { test, assert } from "vite-plus/test";
import {
  isSessionClosedError,
  isPeerStreamError,
  toProtocolViolationSessionError,
  toSessionCloseError,
} from "./errors";
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

test("toProtocolViolationSessionError: code 省略の ProtocolViolationError は PROTOCOL_VIOLATION に変換される", () => {
  // code を指定しない ProtocolViolationError は、§12.2 で specific なコードが
  // 当てはまらない違反 (空 Track Name 等) を表す。既定の PROTOCOL_VIOLATION を
  // そのまま引き継ぎ、メッセージも保持することを検証する。
  const original = new ProtocolViolationError("track name must not be empty");
  const sessionError = toProtocolViolationSessionError(original);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(sessionError?.message, "track name must not be empty");
});

test("toProtocolViolationSessionError: code 付き ProtocolViolationError はその code を保持する", () => {
  // §12.2 の specific なコードを指定した ProtocolViolationError は、変換後も
  // 同じコードで閉じる。GOAWAY の URI 長超過は FIELD_LENGTH_EXCEEDED (§9.2)。
  const original = new ProtocolViolationError(
    "GOAWAY URI length exceeds maximum: 9000 > 8192",
    SessionErrorCode.FIELD_LENGTH_EXCEEDED,
  );
  const sessionError = toProtocolViolationSessionError(original);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  assert.equal(sessionError?.message, "GOAWAY URI length exceeds maximum: 9000 > 8192");
});

test("toProtocolViolationSessionError: IncompleteDataError は既定で MALFORMED_MESSAGE に変換される", () => {
  // 制御メッセージは Message Length 分の完全な Body を読み切ってから decode する
  // ため、その不足は「Message Length が Body の長さと一致しない」ことを意味する (§9)。
  const original = new IncompleteDataError("incomplete request update fields");
  const sessionError = toProtocolViolationSessionError(original);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.equal(sessionError?.message, "incomplete request update fields");
});

test("toProtocolViolationSessionError: IncompleteDataError の分類は呼び出し経路が指定できる", () => {
  // datagram / データストリームの Object decode 不足は、完全な Object バイト列に
  // 対する構造破損であり MALFORMED_OBJECT (§12.2)。呼び出し経路が分類を指定する。
  const original = new IncompleteDataError("incomplete datagram properties");
  const sessionError = toProtocolViolationSessionError(original, SessionErrorCode.MALFORMED_OBJECT);
  assert.instanceOf(sessionError, SessionError);
  assert.equal(sessionError?.code, SessionErrorCode.MALFORMED_OBJECT);
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

test("toProtocolViolationSessionError: undefined / null / Error を継承しないオブジェクトは null を返す", () => {
  // 次の 3 経路はいずれも ProtocolViolationError / IncompleteDataError ではないため、
  // 変換せずに安全に null を返すことをまとめて検証する。
  // - reader.read() の reject が値を持たない (undefined)
  // - throw null / Promise.reject(null) のように値が null
  // - WebTransport の reject が DOMException 相当の独自オブジェクトを渡す
  assert.isNull(toProtocolViolationSessionError(undefined));
  assert.isNull(toProtocolViolationSessionError(null));
  assert.isNull(toProtocolViolationSessionError({ name: "AbortError", message: "aborted" }));
});

// ============================================================================
// toSessionCloseError のテスト
// draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure)
//
// toSessionCloseError は SessionError をそのまま返し、それ以外は
// toProtocolViolationSessionError へ委譲する (errors.ts)。
// ProtocolViolationError / IncompleteDataError / 通常の Error の変換結果は
// 委譲先の toProtocolViolationSessionError のテストで検証済みのため、
// ここでは SessionError の素通しと非 Error 値の安全な null だけを検証する。
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 * MALFORMED_KEY_VALUE の SessionError はコードを保持したまま、
 * 同一オブジェクトでセッションを閉じるために必要である。
 */
test("toSessionCloseError: SessionError は同一オブジェクトのまま返る", () => {
  const original = new SessionError(
    "key-value-pair value does not match serialization for known type 0x2: insufficient data",
    SessionErrorCode.MALFORMED_KEY_VALUE,
  );
  assert.strictEqual(toSessionCloseError(original), original);
});

test("toSessionCloseError: undefined / null / Error を継承しないオブジェクトは null を返す", () => {
  // reject が値を持たない / 非オブジェクトのケースでも安全に null を返す
  assert.isNull(toSessionCloseError(undefined));
  assert.isNull(toSessionCloseError(null));
  assert.isNull(toSessionCloseError({ name: "AbortError", message: "aborted" }));
});

// ============================================================================
// isPeerStreamError のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §6.4.2.3:
 * ピアは STOP_SENDING / RESET_STREAM で当方の送信方向をキャンセルできる。
 * キャンセルされた writable の write / close は WebTransportError
 * (source: "stream") で reject する (W3C WebTransport の実装挙動)。
 * source === "stream" の失敗はピア起因のキャンセルであり、
 * PROTOCOL_VIOLATION に昇格させない。例外として制御ストリームの
 * RESET_STREAM は §6.3 の MUST により呼び出し側 (startControlMessageLoop) が
 * PROTOCOL_VIOLATION でセッションを閉じる。
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
