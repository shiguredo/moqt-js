/**
 * MOQT Session Messages Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY) — 9.4 (REQUEST_ERROR)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Goaway,
  type Redirect,
  type RequestError,
  type RequestOk,
  decodeGoawayPayload,
  decodeRedirect,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
  encodeRedirect,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "./session";
import { createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import { parametersArb, propertyArb } from "./parameterArb";

/**
 * draft-ietf-moq-transport-21 Section 9.2:
 * GOAWAY のワイヤフォーマットは New Session URI Length + New Session URI + Timeout。
 * draft-19 で Request ID フィールドが削除された。
 */
test("Goaway のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      (newSessionUri, timeout) => {
        const original: Goaway = {
          type: MessageType.GOAWAY,
          newSessionUri,
          timeout,
        };

        const encoded = encodeGoawayPayload(original);
        const decoded = decodeGoawayPayload(encoded);

        assert.equal(decoded.type, MessageType.GOAWAY);
        assert.equal(decoded.newSessionUri, newSessionUri);
        assert.equal(decoded.timeout, timeout);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Timeout は GOAWAY ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な GOAWAY の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("GOAWAY の Timeout 後ろに後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (newSessionUri, timeout, trailing) => {
        const original: Goaway = {
          type: MessageType.GOAWAY,
          newSessionUri,
          timeout,
        };

        const encoded = encodeGoawayPayload(original);
        // 正常な GOAWAY の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeGoawayPayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9.3:
 * REQUEST_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-21 Section 9.3
 */
test("RequestOk のエンコード・デコードがラウンドトリップする（空 Track Properties）", () => {
  fc.assert(
    fc.property(parametersArb, (parameters) => {
      const original: RequestOk = {
        type: MessageType.REQUEST_OK,
        parameters,
        trackProperties: [],
      };

      const encoded = encodeRequestOkPayload(original);
      const decoded = decodeRequestOkPayload(encoded);

      assert.equal(decoded.type, MessageType.REQUEST_OK);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
      assert.equal(decoded.trackProperties.length, 0);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9.3 (REQUEST_OK):
 * REQUEST_OK に Track Properties が追加された。
 * 非空 Track Properties のエンコード・デコードが正しくラウンドトリップすることを検証する。
 */
test("RequestOk のエンコード・デコードがラウンドトリップする（非空 Track Properties）", () => {
  fc.assert(
    fc.property(
      parametersArb,
      fc.array(propertyArb, { minLength: 1, maxLength: 3 }),
      (parameters, trackProperties) => {
        const original: RequestOk = {
          type: MessageType.REQUEST_OK,
          parameters,
          trackProperties,
        };

        const encoded = encodeRequestOkPayload(original);
        const decoded = decodeRequestOkPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_OK);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
        assert.equal(decoded.trackProperties.length, trackProperties.length);
        // Track Properties はソートされるため、ソート後の値を比較
        const sortedOriginal = [...trackProperties].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        for (let i = 0; i < sortedOriginal.length; i++) {
          assert.equal(decoded.trackProperties[i].id, sortedOriginal[i].id);
          if (sortedOriginal[i].value !== undefined) {
            assert.equal(decoded.trackProperties[i].value, sortedOriginal[i].value);
          }
          if (sortedOriginal[i].data !== undefined) {
            assert.deepEqual(decoded.trackProperties[i].data, sortedOriginal[i].data);
          }
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9.4.2:
 * REQUEST_ERROR に Redirect が含まれる場合（REDIRECT エラーコード）
 */
test("REQUEST_ERROR with Redirect のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      fc.uint8Array({ minLength: 0, maxLength: 50 }),
      (retryInterval, reasonPhrase, connectUri, namespaceParts, trackName) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode: 0x34n, // REDIRECT
          retryInterval,
          reasonPhrase,
          redirect: {
            connectUri,
            trackNamespace: createTrackNamespace(namespaceParts),
            trackName,
          },
        };

        const encoded = encodeRequestErrorPayload(original);
        const decoded = decodeRequestErrorPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.errorCode, 0x34n);
        assert.equal(decoded.retryInterval, retryInterval);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
        assert.isDefined(decoded.redirect);
        assert.equal(decoded.redirect!.connectUri, connectUri);
        assert.deepEqual(trackNamespaceToStrings(decoded.redirect!.trackNamespace), namespaceParts);
        assert.deepEqual(decoded.redirect!.trackName, trackName);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9.4:
 * REQUEST_ERROR から Request ID が削除された。
 * draft-ietf-moq-transport-21 Section 6.4.2.1
 *
 * Retry Interval: 再試行までに待つべきミリ秒 + 1
 * - 0: 再試行すべきではない
 * - 1 以上: 再試行可能（1 は即座の再試行を許可）
 */
test("RequestError のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      // draft-ietf-moq-transport-21 Section 9.4.2:
      // REDIRECT (0x34) は Redirect 構造を必ず伴うため、Redirect なしの一般
      // ラウンドトリップ対象から除外する (Redirect 付きは専用のプロパティで検証する)
      fc.bigInt({ min: 0n, max: 1000n }).filter((n) => n !== 0x34n),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (errorCode, retryInterval, reasonPhrase) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode,
          retryInterval,
          reasonPhrase,
        };

        const encoded = encodeRequestErrorPayload(original);
        const decoded = decodeRequestErrorPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.retryInterval, retryInterval);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9.4.2:
 * Error Code が REDIRECT 以外だが Redirect バイト列が存在する場合は
 * ProtocolViolationError を throw する。
 *
 * 送信側 (encodeRequestErrorPayload) も同じ組み合わせを生成前に拒否するため、
 * デコーダの検証は Redirect バイト列を手で連結したワイヤで検証する。
 */
test("REDIRECT 以外のエラーコードで Redirect バイトが存在すると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }).filter((n) => n !== 0x34n),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (errorCode, retryInterval, reasonPhrase) => {
        const redirect: Redirect = {
          connectUri: "moqt://example.com",
          trackNamespace: createTrackNamespace(["test"]),
          trackName: new Uint8Array([1, 2, 3]),
        };
        // Redirect なしの REQUEST_ERROR をエンコードし、Redirect バイト列を後置する
        const encoded = encodeRequestErrorPayload({
          type: MessageType.REQUEST_ERROR,
          errorCode,
          retryInterval,
          reasonPhrase,
        });
        const redirectBytes = encodeRedirect(redirect);
        const wire = new Uint8Array(encoded.length + redirectBytes.length);
        wire.set(encoded, 0);
        wire.set(redirectBytes, encoded.length);
        assert.throws(() => decodeRequestErrorPayload(wire), ProtocolViolationError);
      },
    ),
  );
});

/**
 * 送信側も REDIRECT 以外の Error Code に Redirect を付けた REQUEST_ERROR を
 * 生成前に拒否する (デコーダと同じ規則)。
 */
test("REDIRECT 以外のエラーコードに Redirect を付けるとエンコードが拒否される", () => {
  let thrown: unknown;
  try {
    encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: 0x0n,
      retryInterval: 0n,
      reasonPhrase: "internal error",
      redirect: {
        connectUri: "moqt://example.com",
        trackNamespace: createTrackNamespace(["test"]),
        trackName: new Uint8Array([1, 2, 3]),
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.isTrue(
    (thrown as Error).message.includes("unexpected redirect in REQUEST_ERROR with error code 0x0"),
  );
});

/**
 * REDIRECT (0x34) なのに Redirect が無い REQUEST_ERROR も生成前に拒否される。
 */
test("REDIRECT で Redirect が無いとエンコードが拒否される", () => {
  let thrown: unknown;
  try {
    encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: 0x34n,
      retryInterval: 0n,
      reasonPhrase: "redirect",
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.isTrue(
    (thrown as Error).message.includes(
      "missing redirect structure in REQUEST_ERROR with error code REDIRECT (0x34)",
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 9:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Redirect は REQUEST_ERROR ペイロードの最後のフィールド (Section 9.4.2) であり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な REQUEST_ERROR + Redirect の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 * 検出は消費オフセットと data.length の比較であり後続データの長さに依存しないため、
 * 1 バイトから大きめの長さまでを生成して代表的に検証する。
 * 後続データが無い正常系は既存の「REQUEST_ERROR with Redirect のラウンドトリップ」テストが担保する。
 */
test("REQUEST_ERROR の Redirect 後ろに後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      fc.uint8Array({ minLength: 0, maxLength: 50 }),
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (retryInterval, reasonPhrase, connectUri, namespaceParts, trackName, trailing) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode: 0x34n, // REDIRECT
          retryInterval,
          reasonPhrase,
          redirect: {
            connectUri,
            trackNamespace: createTrackNamespace(namespaceParts),
            trackName,
          },
        };

        const encoded = encodeRequestErrorPayload(original);
        // 正常な REQUEST_ERROR + Redirect の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeRequestErrorPayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 Section 8.5:
 * "If an endpoint receives a length exceeding the maximum, it MUST close
 *  the session with a PROTOCOL_VIOLATION"
 * Reason Phrase Length が上限 (1024) を超える REQUEST_ERROR を受信すると
 * decodeRequestErrorPayload が ProtocolViolationError を throw することを検証する。
 */
test("REQUEST_ERROR の Reason Phrase 長が上限超過だと ProtocolViolationError を throw する", () => {
  // errorCode + retryInterval + reasonLen(>1024) を組み立てる。
  // reasonLen のチェックは Reason Phrase バイト読み取り前に行われるため、
  // 実際の Reason Phrase バイトは不要。
  const data = new Uint8Array([
    ...encodeVarint(0x01n),
    ...encodeVarint(0n),
    ...encodeVarint(1025n),
  ]);
  assert.throws(() => decodeRequestErrorPayload(data), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-21 Section 9.4.1 (Redirect Structure):
 * Connect URI に最大長の規定はない (8,192 バイト上限は GOAWAY の New Session URI
 * §9.2 にのみ存在する)。8,192 バイトを超える Connect URI を含む Redirect が
 * デコードできることを固定バイト列で検証する。
 */
test("Redirect の 8,192 バイト超 Connect URI がデコードできる", () => {
  const connectUri = "m".repeat(8193);
  const redirect: Redirect = {
    connectUri,
    trackNamespace: createTrackNamespace(["test"]),
    trackName: new Uint8Array([1, 2, 3]),
  };
  const encoded = encodeRedirect(redirect);

  const [decoded, consumed] = decodeRedirect(encoded, 0);

  assert.equal(decoded.connectUri, connectUri);
  assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), ["test"]);
  assert.deepEqual(decoded.trackName, new Uint8Array([1, 2, 3]));
  assert.equal(consumed, encoded.length);
});

/**
 * draft-ietf-moq-transport-21 §8.7:
 * Full Track Name (Namespace + Track Name 合計) が 4,096 バイトを超える
 * Redirect (REQUEST_ERROR) がデコード時に ProtocolViolationError になることを
 * 検証する (decodeRedirect 経由の統合テスト)。
 */
test("REQUEST_ERROR (REDIRECT) の Full Track Name 4,096 バイト超過で ProtocolViolationError", () => {
  // namespace 4,000 バイト + trackName 97 バイト = 合計 4,097 バイト
  const original: RequestError = {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x34n, // REDIRECT
    retryInterval: 0n,
    reasonPhrase: "redirect",
    redirect: {
      connectUri: "moqt://example.com",
      trackNamespace: createTrackNamespace(["a".repeat(4000)]),
      trackName: new TextEncoder().encode("a".repeat(97)),
    },
  };

  const encoded = encodeRequestErrorPayload(original);
  assert.throws(() => decodeRequestErrorPayload(encoded), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-21 Section 9.4.1 (Redirect Structure):
 * 8,192 バイトを超える Connect URI を含む REQUEST_ERROR (REDIRECT) が
 * デコード経路 (encodeRequestErrorPayload → decodeRequestErrorPayload) で
 * ラウンドトリップし、trailing 検査と干渉しないことを検証する。
 */
test("REQUEST_ERROR (REDIRECT) の 8,192 バイト超 Connect URI がラウンドトリップする", () => {
  const connectUri = "m".repeat(8193);
  const original: RequestError = {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x34n, // REDIRECT
    retryInterval: 0n,
    reasonPhrase: "redirect",
    redirect: {
      connectUri,
      trackNamespace: createTrackNamespace(["test"]),
      trackName: new Uint8Array([1, 2, 3]),
    },
  };

  const encoded = encodeRequestErrorPayload(original);
  const decoded = decodeRequestErrorPayload(encoded);

  assert.equal(decoded.errorCode, 0x34n);
  assert.isDefined(decoded.redirect);
  assert.equal(decoded.redirect!.connectUri, connectUri);
});
