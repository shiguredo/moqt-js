/**
 * COSE (RFC 9052 / RFC 9053) のテスト
 */

import { test, assert } from "vite-plus/test";
import {
  C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID,
  type CoseMessage,
  HEADER_ALGORITHM,
  HEADER_CRITICAL,
  HEADER_CONTENT_TYPE,
  HEADER_KEY_ID,
  HEADER_TYPE,
  TAG_COSE_MAC0,
  TAG_COSE_SIGN1,
  TAG_CWT,
  algorithmClass,
  algorithmClassContext,
  algorithmClassTag,
  algorithmFromIdentifier,
  algorithmFromIdentifierWithC4mDraftAlias,
  algorithmIdentifier,
  algorithmIsMac,
  algorithmJoseName,
  algorithmFromJoseName,
  coseKeyIdAsBytes,
  coseMessageHeader,
  coseMessagePayload,
  coseMessageSignature,
  coseMessageSigningInput,
  createCoseHeader,
  decodeCoseMessage,
  decodeProtectedHeader,
  decodeUnprotectedHeader,
  encodeCoseHeader,
  encodeCoseMessage,
  type CoseHeader,
} from "./cose";
import {
  CBOR_NULL,
  type CborValue,
  cborArray,
  cborBool,
  cborByteString,
  cborInteger,
  cborMap,
  cborMapGet,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  decodeCborPartial,
  encodeCbor,
} from "./cbor";
import { assertCoseError, decodeHex, encodeHex } from "./testSupport";

/** protected ヘッダ (`alg` のみ) の CBOR バイト列を作る */
function protectedHeader(algorithmIdentifierValue: number): Uint8Array {
  return encodeCbor(cborMap([[cborUnsigned(1n), cborInteger(algorithmIdentifierValue)]]));
}

/** COSE 構造の配列を作る */
function coseArray(
  protectedBytes: Uint8Array,
  payload: Uint8Array | undefined,
  signature: Uint8Array,
): CborValue {
  return cborArray([
    cborByteString(protectedBytes),
    cborMap([]),
    payload !== undefined ? cborByteString(payload) : CBOR_NULL,
    cborByteString(signature),
  ]);
}

test("COSE_Sign1 の署名対象は RFC 9052 の Sig_structure と一致する", () => {
  const message: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: new TextEncoder().encode("hello"),
      signature: new Uint8Array([0x01]),
      coseTagged: false,
      cwtTagged: false,
    },
  };
  assert.equal(
    encodeHex(coseMessageSigningInput(message)),
    "846a5369676e61747572653143a10126404568656c6c6f",
  );
  assert.equal(coseMessageHeader(message).algorithm, "Es256");
});

test("COSE_Mac0 の署名対象は RFC 9052 の MAC_structure と一致する", () => {
  const message: CoseMessage = {
    type: "mac0",
    mac0: {
      protected: protectedHeader(5),
      unprotected: [],
      payload: new TextEncoder().encode("hello"),
      tag: new Uint8Array([0x01]),
      coseTagged: false,
      cwtTagged: false,
    },
  };
  assert.equal(encodeHex(coseMessageSigningInput(message)), "84644d41433043a10105404568656c6c6f");
});

test("CWT タグと COSE タグは保持される", () => {
  const protectedBytes = protectedHeader(-7);
  const array = coseArray(
    protectedBytes,
    new TextEncoder().encode("payload"),
    new TextEncoder().encode("signature"),
  );
  const tagged = cborTag(TAG_CWT, cborTag(TAG_COSE_SIGN1, array));
  const bytes = encodeCbor(tagged);
  const message = decodeCoseMessage(bytes);
  assert.equal(message.type, "sign1");
  if (message.type !== "sign1") {
    assert.fail("COSE_Sign1 としてデコードされるべき");
  }
  assert.equal(message.sign1.coseTagged, true);
  assert.equal(message.sign1.cwtTagged, true);
  assert.deepEqual(message.sign1.protected, protectedBytes);
  assert.deepEqual(message.sign1.payload, new TextEncoder().encode("payload"));
  assert.deepEqual(message.sign1.signature, new TextEncoder().encode("signature"));
  assert.deepEqual(encodeCoseMessage(message), bytes);
});

test("タグの無い構造はアルゴリズムの種別から判別する", () => {
  const sign1 = encodeCbor(
    coseArray(protectedHeader(-7), new TextEncoder().encode("p"), new TextEncoder().encode("s")),
  );
  assert.equal(decodeCoseMessage(sign1).type, "sign1");

  const mac0 = encodeCbor(
    coseArray(protectedHeader(5), new TextEncoder().encode("p"), new TextEncoder().encode("s")),
  );
  assert.equal(decodeCoseMessage(mac0).type, "mac0");

  // alg が無い場合は構造を判別できない
  const bytes = encodeCbor(
    coseArray(new Uint8Array(0), new TextEncoder().encode("p"), new TextEncoder().encode("s")),
  );
  assertCoseError(() => decodeCoseMessage(bytes), "missingAlgorithm");
});

test("COSE タグとアルゴリズムの種別は一致しなければならない", () => {
  const sign1Array = coseArray(
    protectedHeader(-7),
    new TextEncoder().encode("p"),
    new TextEncoder().encode("s"),
  );
  const sign1Bytes = encodeCbor(cborTag(TAG_COSE_MAC0, sign1Array));
  assertCoseError(() => decodeCoseMessage(sign1Bytes), "algorithmClassMismatch");

  const mac0Array = coseArray(
    protectedHeader(5),
    new TextEncoder().encode("p"),
    new TextEncoder().encode("s"),
  );
  const mac0Bytes = encodeCbor(cborTag(TAG_COSE_SIGN1, mac0Array));
  assertCoseError(() => decodeCoseMessage(mac0Bytes), "algorithmClassMismatch");
});

test("対応していないアルゴリズムを拒否する", () => {
  const bytes = encodeCbor(
    coseArray(protectedHeader(42), new TextEncoder().encode("p"), new TextEncoder().encode("s")),
  );
  assertCoseError(() => decodeCoseMessage(bytes), "unsupportedAlgorithm", 42);
});

test("C4M ドラフトの HMAC の別名 (-4) を受理する", () => {
  assert.equal(
    algorithmFromIdentifierWithC4mDraftAlias(C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID),
    "HmacSha256",
  );
  assert.equal(algorithmFromIdentifier(C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID), undefined);
  const bytes = encodeCbor(
    coseArray(
      protectedHeader(C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID),
      new TextEncoder().encode("p"),
      new TextEncoder().encode("s"),
    ),
  );
  const message = decodeCoseMessage(bytes);
  const header = coseMessageHeader(message);
  assert.equal(header.algorithm, "HmacSha256");
  // 生の識別子も保持する
  assert.equal(header.algorithmIdentifier, C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID);
});

/**
 * RFC 9052 Section 3.1: crit の配列は 1 つ以上の要素を持たなければならない。
 * 空の配列は emptyCriticalHeader で拒否する。
 *
 * crit が理解できないラベルを指す場合 / protected ヘッダに無いラベルを指す場合 /
 * unprotected ヘッダに置かれた場合は cose.prop.ts の PBT が任意のラベルで検証する。
 */
test("crit の配列は空にできない", () => {
  assertCoseError(
    () =>
      decodeProtectedHeader(
        cborMap([
          [cborUnsigned(1n), cborInteger(5)],
          [cborUnsigned(2n), cborArray([])],
        ]),
      ),
    "emptyCriticalHeader",
  );
});

test("unprotected ヘッダに alg / typ を置けない", () => {
  // alg は protected ヘッダで認証されなければならない (RFC 9052 Section 3.1)
  const protectedBytes = encodeCbor(cborMap([[cborUnsigned(16n), cborTextString("CAT")]]));
  const unprotected = cborMap([[cborUnsigned(1n), cborInteger(5)]]);
  const bytes = encodeCbor(
    cborArray([
      cborByteString(protectedBytes),
      unprotected,
      cborByteString(new TextEncoder().encode("payload")),
      cborByteString(new TextEncoder().encode("signature")),
    ]),
  );
  assertCoseError(() => decodeCoseMessage(bytes), "unprotectedAlgorithm");

  // alg が両方にある場合はエラー
  const bytesWithBoth = encodeCbor(
    cborArray([
      cborByteString(protectedHeader(5)),
      unprotected,
      cborByteString(new TextEncoder().encode("payload")),
      cborByteString(new TextEncoder().encode("signature")),
    ]),
  );
  assertCoseError(() => decodeCoseMessage(bytesWithBoth), "duplicateHeaderParameter", 1);

  // typ は unprotected ヘッダに置けない (RFC 9596 Section 2)
  const bytesWithUnprotectedType = encodeCbor(
    cborArray([
      cborByteString(protectedHeader(5)),
      cborMap([[cborUnsigned(16n), cborTextString("CAT")]]),
      cborByteString(new TextEncoder().encode("payload")),
      cborByteString(new TextEncoder().encode("signature")),
    ]),
  );
  assertCoseError(() => decodeCoseMessage(bytesWithUnprotectedType), "unprotectedTypeHeader");
});

test("CWT タグは COSE タグが無いと付けられない", () => {
  // RFC 8392 Section 6: CWT タグは COSE のタグ付きオブジェクトにだけ前置できる。
  // デコードで CWT タグだけが前置された構造を拒否することを検証する
  // (CWT タグだけを付けたエンコードの拒否は cose.prop.ts の PBT が任意の
  //  メッセージで検証する)。
  const array = coseArray(
    protectedHeader(5),
    new TextEncoder().encode("p"),
    new TextEncoder().encode("s"),
  );
  const bytes = encodeCbor(cborTag(TAG_CWT, array));
  const error = assertCoseError(() => decodeCoseMessage(bytes), "invalidStructure");
  assert.equal(typeof error.detail, "string");
});

test("エンコード時も alg の種別とメッセージの種別の不一致を拒否する", () => {
  // デコード側が拒否する組み合わせはエンコード側でも拒否する
  const sign1WithMac: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(5),
      unprotected: [],
      payload: new Uint8Array(0),
      signature: new Uint8Array(0),
      coseTagged: true,
      cwtTagged: true,
    },
  };
  assertCoseError(() => encodeCoseMessage(sign1WithMac), "algorithmClassMismatch");

  const mac0WithSignature: CoseMessage = {
    type: "mac0",
    mac0: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: new Uint8Array(0),
      tag: new Uint8Array(0),
      coseTagged: true,
      cwtTagged: true,
    },
  };
  assertCoseError(() => encodeCoseMessage(mac0WithSignature), "algorithmClassMismatch");

  // 一致する組み合わせは通り、デコードできる
  const sign1: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: new Uint8Array(0),
      signature: new Uint8Array([1]),
      coseTagged: true,
      cwtTagged: true,
    },
  };
  assert.equal(decodeCoseMessage(encodeCoseMessage(sign1)).type, "sign1");
});

test("整数でもテキスト文字列でもないヘッダラベルを拒否する", () => {
  // RFC 9052 Section 1.5: ヘッダのラベルは int / tstr であり、それ以外のラベルを
  // 持つマップはエラーになる
  assertCoseError(
    () => decodeProtectedHeader(cborMap([[cborBool(true), cborUnsigned(1n)]])),
    "unexpectedType",
    "header label",
  );
  assertCoseError(
    () =>
      decodeUnprotectedHeader(cborMap([[cborByteString(new Uint8Array([1])), cborUnsigned(1n)]])),
    "unexpectedType",
    "header label",
  );
  // 不正なラベルを持つメッセージを作ってはならない (MUST NOT)
  const invalid = createCoseHeader();
  invalid.raw.push([cborBool(false), cborUnsigned(1n)]);
  assertCoseError(() => encodeCoseHeader(invalid), "unexpectedType", "header label");

  // テキスト文字列のラベルは未知のパラメータとして往復する
  const textLabel = createCoseHeader();
  textLabel.raw.push([cborTextString("custom"), cborUnsigned(1n)]);
  assert.deepEqual(decodeProtectedHeader(encodeCoseHeader(textLabel)).raw, textLabel.raw);
});

test("ヘッダは解釈しないパラメータを往復できる", () => {
  const header: CoseHeader = {
    algorithm: "HmacSha256",
    algorithmIdentifier: C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID,
    keyId: { type: "bytes", value: new Uint8Array([1, 2, 3]) },
    typ: cborTextString("CAT"),
    contentType: cborUnsigned(0n),
    critical: [],
    raw: [[cborUnsigned(99n), cborTextString("x")]],
  };
  const encoded = encodeCoseHeader(header);
  assert.deepEqual(decodeProtectedHeader(encoded), header);
});

test("kid はバイト文字列とテキスト文字列の両方を受け付ける", () => {
  const textHeader = decodeProtectedHeader(cborMap([[cborUnsigned(4n), cborTextString("key-1")]]));
  assert.deepEqual(textHeader.keyId, { type: "text", value: "key-1" });
  const textKeyId = textHeader.keyId;
  assert.ok(textKeyId !== undefined);
  assert.deepEqual(coseKeyIdAsBytes(textKeyId), new TextEncoder().encode("key-1"));

  const bytesHeader = decodeProtectedHeader(
    cborMap([[cborUnsigned(4n), cborByteString(new Uint8Array([0xab]))]]),
  );
  assert.deepEqual(bytesHeader.keyId, { type: "bytes", value: new Uint8Array([0xab]) });
});

test("ヘッダの型エラーを拒否する", () => {
  assertCoseError(() => decodeProtectedHeader(cborUnsigned(1n)), "unexpectedType", "header map");
  assertCoseError(
    () => decodeProtectedHeader(cborMap([[cborUnsigned(1n), cborTextString("ES256")]])),
    "unexpectedType",
    "alg",
  );
  assertCoseError(
    () => decodeProtectedHeader(cborMap([[cborUnsigned(4n), cborUnsigned(1n)]])),
    "unexpectedType",
    "kid",
  );
});

test("detached payload は扱わない", () => {
  const message: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: undefined,
      signature: new Uint8Array([0x01]),
      coseTagged: false,
      cwtTagged: false,
    },
  };
  assertCoseError(() => coseMessageSigningInput(message), "detachedPayloadUnsupported");
  const bytes = encodeCoseMessage(message);
  const decoded = decodeCoseMessage(bytes);
  assert.equal(decoded.type, "sign1");
  if (decoded.type === "sign1") {
    assert.equal(decoded.sign1.payload, undefined);
  }
});

test("エンコードオプションでタグの付与を制御できる", () => {
  const message: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: new TextEncoder().encode("p"),
      signature: new Uint8Array([0x01]),
      coseTagged: false,
      cwtTagged: false,
    },
  };
  const untagged = encodeCoseMessage(message, { coseTag: false, cwtTag: false });
  assert.equal(coseMessageHeader(decodeCoseMessage(untagged)).algorithm, "Es256");
  const tagged = encodeCoseMessage(message, { coseTag: true, cwtTag: true });
  const { value } = decodeCborPartial(tagged);
  assert.equal(value.type, "tag");
  if (value.type !== "tag") {
    assert.fail("CWT タグを期待した");
  }
  assert.equal(value.tag, TAG_CWT);
  assert.equal(value.value.type, "tag");
  if (value.value.type === "tag") {
    assert.equal(value.value.tag, TAG_COSE_SIGN1);
  }
});

test("アルゴリズムの定義を確認する", () => {
  assert.equal(algorithmIdentifier("Es256"), -7);
  assert.equal(algorithmIdentifier("Es384"), -35);
  assert.equal(algorithmIdentifier("Es512"), -36);
  assert.equal(algorithmIdentifier("EdDsa"), -8);
  assert.equal(algorithmIdentifier("HmacSha256"), 5);
  assert.equal(algorithmIdentifier("HmacSha384"), 6);
  assert.equal(algorithmIdentifier("HmacSha512"), 7);
  assert.equal(algorithmIsMac("HmacSha384"), true);
  assert.equal(algorithmIsMac("Es256"), false);
  assert.equal(algorithmClass("HmacSha256"), "mac");
  assert.equal(algorithmClass("EdDsa"), "signature");
  assert.equal(algorithmClassContext("mac"), "MAC0");
  assert.equal(algorithmClassContext("signature"), "Signature1");
  assert.equal(algorithmClassTag("mac"), TAG_COSE_MAC0);
  assert.equal(algorithmClassTag("signature"), TAG_COSE_SIGN1);
  assert.equal(algorithmFromJoseName("ES256"), "Es256");
  assert.equal(algorithmFromJoseName("EdDSA"), "EdDsa");
  assert.equal(algorithmFromJoseName("HS256"), "HmacSha256");
  assert.equal(algorithmFromJoseName("PS256"), undefined);
  assert.equal(algorithmJoseName("Es256"), "ES256");
});

test("要素数が 4 でない COSE 配列を拒否する", () => {
  const oneElement = encodeCbor(cborArray([cborUnsigned(1n)]));
  assertCoseError(() => decodeCoseMessage(oneElement), "invalidStructure");
  const threeElements = encodeCbor(
    cborArray([cborByteString(new Uint8Array(0)), cborMap([]), cborByteString(new Uint8Array(0))]),
  );
  assertCoseError(() => decodeCoseMessage(threeElements), "invalidStructure");
  // タグ付きの構造は alg が無くても構造としてはデコードできる
  // (CAT として使う場合は CatToken が alg の存在を要求する)
  const tagged = encodeCbor(
    cborTag(
      TAG_COSE_SIGN1,
      cborArray([
        cborByteString(new Uint8Array(0)),
        cborMap([]),
        cborByteString(new Uint8Array(0)),
        cborByteString(new Uint8Array(0)),
      ]),
    ),
  );
  assert.equal(coseMessageHeader(decodeCoseMessage(tagged)).algorithm, undefined);
});

test("既知のバイト列からヘッダをデコードできる", () => {
  // 付録 A.3 の protected ヘッダ (alg = -4、typ = "CAT")
  const protectedBytes = decodeHex("a201231063434154");
  const header = decodeProtectedHeader(decodeCbor(protectedBytes));
  assert.equal(header.algorithm, "HmacSha256");
  assert.deepEqual(header.typ, cborTextString("CAT"));
});

test("kid と content type は unprotected バケットからも読める", () => {
  const bytes = encodeCbor(
    cborArray([
      cborByteString(protectedHeader(5)),
      cborMap([
        [cborUnsigned(4n), cborTextString("key-1")],
        [cborUnsigned(3n), cborTextString("cat")],
      ]),
      cborByteString(new TextEncoder().encode("p")),
      cborByteString(new TextEncoder().encode("s")),
    ]),
  );
  const header = coseMessageHeader(decodeCoseMessage(bytes));
  assert.deepEqual(header.keyId, { type: "text", value: "key-1" });
  assert.deepEqual(header.contentType, cborTextString("cat"));
});

test("ヘッダのエンコードでも crit のラベルを検証する", () => {
  const header: CoseHeader = {
    algorithm: "HmacSha256",
    algorithmIdentifier: 5,
    keyId: undefined,
    typ: undefined,
    contentType: undefined,
    critical: [cborUnsigned(16n)],
    raw: [],
  };
  assertCoseError(() => encodeCoseHeader(header), "criticalHeaderNotPresent");
});

test("ヘッダのエンコードは存在して理解できる crit のラベルを受理する", () => {
  const header: CoseHeader = {
    algorithm: "HmacSha256",
    algorithmIdentifier: 5,
    keyId: undefined,
    typ: cborTextString("CAT"),
    contentType: undefined,
    critical: [cborUnsigned(1n), cborUnsigned(16n)],
    raw: [],
  };
  const encoded = encodeCoseHeader(header);
  assert.deepEqual(decodeProtectedHeader(encoded), header);
  // crit 自身の列挙は許す
  const criticalItself: CoseHeader = { ...header, critical: [cborUnsigned(2n)] };
  assert.doesNotThrow(() => encodeCoseHeader(criticalItself));
  // 理解できないラベルは encode でも拒否する
  const unknown: CoseHeader = {
    ...header,
    critical: [cborUnsigned(99n)],
    raw: [[cborUnsigned(99n), cborUnsigned(1n)]],
  };
  assertCoseError(() => encodeCoseHeader(unknown), "unsupportedCriticalHeader");
});

test("メッセージのアクセサーを確認する", () => {
  const message: CoseMessage = {
    type: "sign1",
    sign1: {
      protected: protectedHeader(-7),
      unprotected: [],
      payload: new TextEncoder().encode("p"),
      signature: new Uint8Array([0x01, 0x02]),
      coseTagged: false,
      cwtTagged: false,
    },
  };
  assert.deepEqual(coseMessageSignature(message), new Uint8Array([0x01, 0x02]));
  assert.deepEqual(coseMessagePayload(message), new TextEncoder().encode("p"));
  assert.doesNotThrow(() => coseMessageSigningInput(message));
});

test("ヘッダのエンコードで kid はバイト文字列とテキスト文字列の両方を使える", () => {
  const bytesKeyId = encodeCoseHeader({
    algorithm: "HmacSha256",
    algorithmIdentifier: 5,
    keyId: { type: "bytes", value: new Uint8Array([1, 2]) },
    typ: undefined,
    contentType: undefined,
    critical: [],
    raw: [],
  });
  assert.deepEqual(
    cborMapGet(bytesKeyId, cborInteger(HEADER_KEY_ID)),
    cborByteString(new Uint8Array([1, 2])),
  );
  const textKeyId = encodeCoseHeader({
    algorithm: "HmacSha256",
    algorithmIdentifier: 5,
    keyId: { type: "text", value: "key-1" },
    typ: cborTextString("CAT"),
    contentType: cborUnsigned(0n),
    critical: [],
    raw: [],
  });
  assert.deepEqual(cborMapGet(textKeyId, cborInteger(HEADER_TYPE)), cborTextString("CAT"));
  assert.deepEqual(cborMapGet(textKeyId, cborInteger(HEADER_CONTENT_TYPE)), cborUnsigned(0n));
  assert.deepEqual(cborMapGet(textKeyId, cborInteger(HEADER_ALGORITHM)), cborInteger(5));
  assert.deepEqual(cborMapGet(textKeyId, cborInteger(HEADER_CRITICAL)), undefined);
});

test("COSE メッセージの要素の型が違うと拒否する", () => {
  // protected / unprotected / payload / signature を 1 つずつ別の型にして、
  // どの位置でも unexpectedType になることを確認する
  const cases: Array<[number, CborValue]> = [
    [0, cborTextString("protected")],
    [1, cborArray([])],
    [2, cborTextString("payload")],
    [3, cborTextString("signature")],
  ];
  for (const [index, replacement] of cases) {
    const parts: CborValue[] = [
      cborByteString(protectedHeader(-7)),
      cborMap([]),
      cborByteString(new Uint8Array(0)),
      cborByteString(new Uint8Array([1])),
    ];
    parts[index] = replacement;
    assertCoseError(
      () => decodeCoseMessage(encodeCbor(cborTag(TAG_COSE_SIGN1, cborArray(parts)))),
      "unexpectedType",
    );
  }

  // crit はラベルの配列でなければならない
  assertCoseError(
    () => decodeProtectedHeader(cborMap([[cborInteger(HEADER_CRITICAL), cborTextString("x")]])),
    "unexpectedType",
    "crit",
  );
});
