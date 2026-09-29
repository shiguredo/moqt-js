/**
 * C4M の `moqt` クレームと認可のテスト
 */

import { test, assert } from "vite-plus/test";
import {
  MATCH_TYPE_PREFIX,
  MATCH_TYPE_SUFFIX,
  MOQT_ACTIONS,
  type MoqtScope,
  catDpopHonorsJti,
  catDpopWindowSecondsOr,
  createCatDpop,
  createMoqtClaim,
  createMoqtScope,
  decodeCatDpop,
  decodeMoqtClaim,
  decodeMoqtScope,
  encodeCatDpop,
  encodeMatch,
  encodeMoqtClaim,
  encodeMoqtScope,
  exactMatch,
  matchMatches,
  moqtActionFromKey,
  moqtActionKey,
  moqtActionMatchesAuthorizationContext,
  moqtActionName,
  moqtAuthorizationContext,
  moqtClaimAuthorize,
  moqtScopeAllows,
  namespaceMatchEnd,
  namespaceMatchValue,
  prefixMatch,
  suffixMatch,
} from "./moqt";
import {
  CBOR_NULL,
  CBOR_TRUE,
  cborArray,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
  cborMapGet,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import { createCatClaims, decodeCatClaims, encodeCatClaims } from "./cat";
import { assertC4mError, decodeHex, encodeHex } from "./testSupport";
import { SCOPE_VECTORS } from "./testVectors";

const TEXT_ENCODER = new TextEncoder();

/** テスト用の namespace をバイト列の配列へ変換する */
function namespaceBytes(namespace: string[]): Uint8Array[] {
  return namespace.map((field) => TEXT_ENCODER.encode(field));
}

test("付録 A.5 のトークンから認可判定できる", () => {
  for (const vector of SCOPE_VECTORS) {
    const claims = decodeCatClaims(decodeCbor(decodeHex(vector.payloadHex)));
    assert.ok(claims.moqt !== undefined, `ベクタ ${vector.id} に moqt クレームがある`);
    for (const testCase of vector.tests) {
      const action = moqtActionFromKey(testCase.action);
      assert.ok(action !== undefined, `ベクタ ${vector.id} のアクションが不正: ${testCase.action}`);
      assert.equal(
        moqtClaimAuthorize(
          claims.moqt,
          action,
          namespaceBytes(testCase.namespace),
          TEXT_ENCODER.encode(testCase.track),
        ),
        testCase.expected,
        `ベクタ ${vector.id} の認可判定 (action=${testCase.action}, namespace=${testCase.namespace.join(".")}, track=${testCase.track})`,
      );
    }
  }
});

test("付録 A.5 のスコープの内容を確認する", () => {
  const publisher = SCOPE_VECTORS.find((vector) => vector.id === "moqt_publisher_exact");
  assert.ok(publisher !== undefined);
  const publisherClaims = decodeCatClaims(decodeCbor(decodeHex(publisher.payloadHex)));
  const publisherMoqt = publisherClaims.moqt;
  assert.ok(publisherMoqt !== undefined);
  assert.equal(publisherMoqt.scopes.length, 1);
  const scope = publisherMoqt.scopes[0];
  assert.ok(scope !== undefined);
  assert.deepEqual(scope.actions, [2, 6]);
  assert.deepEqual(scope.namespace, [
    namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("example.com"))),
    namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("alice"))),
  ]);
  assert.deepEqual(scope.track, prefixMatch(TEXT_ENCODER.encode("video-")));

  const admin = SCOPE_VECTORS.find((vector) => vector.id === "moqt_admin_wildcard");
  assert.ok(admin !== undefined);
  const adminClaims = decodeCatClaims(decodeCbor(decodeHex(admin.payloadHex)));
  const adminMoqt = adminClaims.moqt;
  assert.ok(adminMoqt !== undefined);
  assert.deepEqual(adminMoqt.scopes[0]?.actions, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(adminMoqt.scopes[0]?.namespace, []);
  assert.equal(adminMoqt.scopes[0]?.track, undefined);
});

test("付録 A.5 の moqt-reval を確認する", () => {
  for (const vector of SCOPE_VECTORS) {
    const claims = decodeCatClaims(decodeCbor(decodeHex(vector.payloadHex)));
    assert.equal(claims.moqtReval, vector.moqtReval, `ベクタ ${vector.id}`);
  }
});

test("publisher スコープを再構築するとベクタの payload と一致する", () => {
  const vector = SCOPE_VECTORS.find((entry) => entry.id === "moqt_publisher_exact");
  assert.ok(vector !== undefined);
  const scope = createMoqtScope(["PublishNamespace", "Publish"]);
  scope.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("example.com"))));
  scope.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("alice"))));
  scope.track = prefixMatch(TEXT_ENCODER.encode("video-"));
  const claims = createCatClaims();
  claims.issuer = "https://auth.example.com";
  claims.expiration = 1700086400;
  claims.moqt = { scopes: [scope] };
  assert.equal(encodeHex(encodeCbor(encodeCatClaims(claims))), vector.payloadHex);
});

test("nil は名前空間の末尾にだけ一致する", () => {
  const scope = createMoqtScope(["Subscribe"]);
  scope.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("example.com"))));
  scope.namespace.push(namespaceMatchEnd());
  assert.equal(
    moqtScopeAllows(scope, "Subscribe", [TEXT_ENCODER.encode("example.com")], new Uint8Array(0)),
    true,
  );
  assert.equal(
    moqtScopeAllows(
      scope,
      "Subscribe",
      [TEXT_ENCODER.encode("example.com"), TEXT_ENCODER.encode("alice")],
      new Uint8Array(0),
    ),
    false,
  );
  assert.equal(
    moqtScopeAllows(scope, "Subscribe", [TEXT_ENCODER.encode("example")], new Uint8Array(0)),
    false,
  );
});

test("nil が無い場合は長い名前空間も許可する", () => {
  const scope = createMoqtScope(["Subscribe"]);
  scope.namespace.push(namespaceMatchValue(prefixMatch(TEXT_ENCODER.encode("example"))));
  assert.equal(
    moqtScopeAllows(
      scope,
      "Subscribe",
      [TEXT_ENCODER.encode("example.com"), TEXT_ENCODER.encode("alice")],
      new Uint8Array(0),
    ),
    true,
  );
  assert.equal(
    moqtScopeAllows(scope, "Subscribe", [TEXT_ENCODER.encode("other")], new Uint8Array(0)),
    false,
  );
});

test("名前空間マッチの無いスコープはすべての名前空間にマッチする", () => {
  const scope = createMoqtScope(["Publish"]);
  assert.equal(moqtScopeAllows(scope, "Publish", [], TEXT_ENCODER.encode("track")), true);
  assert.equal(
    moqtScopeAllows(
      scope,
      "Publish",
      [TEXT_ENCODER.encode("any"), TEXT_ENCODER.encode("namespace")],
      TEXT_ENCODER.encode("track"),
    ),
    true,
  );
  assert.equal(
    moqtScopeAllows(scope, "Fetch", [TEXT_ENCODER.encode("any")], TEXT_ENCODER.encode("track")),
    false,
  );
});

test("トラックマッチがある場合は適用される", () => {
  const scope = createMoqtScope(["Publish"]);
  scope.track = suffixMatch(TEXT_ENCODER.encode(".json"));
  assert.equal(
    moqtScopeAllows(scope, "Publish", [TEXT_ENCODER.encode("a")], TEXT_ENCODER.encode("data.json")),
    true,
  );
  assert.equal(
    moqtScopeAllows(scope, "Publish", [TEXT_ENCODER.encode("a")], TEXT_ENCODER.encode("data.xml")),
    false,
  );
  // 名前空間マッチが無くてもトラックマッチは適用される
  assert.equal(moqtScopeAllows(scope, "Publish", [], TEXT_ENCODER.encode(".json")), true);
});

test("不正なスコープのデコードエラーを拒否する", () => {
  assertC4mError(() => decodeMoqtScope(cborArray([cborArray([])])), "emptyActions");
  assertC4mError(() => decodeMoqtScope(cborArray([])), "invalidScopeLength", 0);
  assertC4mError(
    () => decodeMoqtScope(cborArray([cborArray([cborInteger(1)]), cborArray([])])),
    "emptyNamespaceMatch",
  );
  assertC4mError(
    () =>
      decodeMoqtScope(
        cborArray([
          cborArray([cborInteger(1)]),
          cborArray([
            CBOR_NULL,
            cborArray([cborInteger(1), cborByteString(TEXT_ENCODER.encode("a"))]),
          ]),
        ]),
      ),
    "nilNotLast",
  );
  assertC4mError(
    () =>
      decodeMoqtScope(
        cborArray([
          cborArray([cborInteger(1)]),
          cborArray([cborArray([cborInteger(3), cborByteString(TEXT_ENCODER.encode("a"))])]),
        ]),
      ),
    "invalidMatchType",
    3,
  );
  assertC4mError(
    () =>
      decodeMoqtScope(
        cborArray([cborArray([cborInteger(1)]), cborArray([cborArray([cborInteger(1)])])]),
      ),
    "invalidMatchArrayLength",
    1,
  );
  assertC4mError(() => decodeMoqtScope(cborUnsigned(1n)), "unexpectedType", "moqt-scope");
  assertC4mError(
    () => decodeMoqtScope(cborArray([cborByteString(TEXT_ENCODER.encode("a"))])),
    "unexpectedType",
    "moqt-actions",
  );
  assertC4mError(
    () => decodeMoqtScope(cborArray([cborArray([cborTextString("a")])])),
    "unexpectedType",
    "moqt-action",
  );
  assertC4mError(
    () =>
      decodeMoqtScope(
        cborArray([cborArray([cborInteger(1)]), cborByteString(TEXT_ENCODER.encode("a"))]),
      ),
    "unexpectedType",
    "moqt-ns-match",
  );
  assertC4mError(() => decodeMoqtClaim(cborArray([])), "emptyScopes");
  assertC4mError(() => decodeMoqtClaim(cborUnsigned(1n)), "unexpectedType", "moqt claim");
});

test("スコープとクレームのエンコードエラーと往復を確認する", () => {
  const emptyActions: MoqtScope = { actions: [], namespace: [], track: undefined };
  assertC4mError(() => encodeMoqtScope(emptyActions), "emptyActions");
  const nilNotLast: MoqtScope = {
    actions: [1],
    namespace: [namespaceMatchEnd(), namespaceMatchValue(exactMatch(new Uint8Array([1])))],
    track: undefined,
  };
  assertC4mError(() => encodeMoqtScope(nilNotLast), "nilNotLast");
  assertC4mError(() => encodeMoqtClaim(createMoqtClaim()), "emptyScopes");

  const scope = createMoqtScope(["Fetch"]);
  scope.namespace.push(namespaceMatchValue(prefixMatch(TEXT_ENCODER.encode("live"))));
  scope.namespace.push(namespaceMatchEnd());
  scope.track = suffixMatch(TEXT_ENCODER.encode("-audio"));
  const encoded = encodeMoqtScope(scope);
  assert.deepEqual(decodeMoqtScope(encoded), scope);

  const claim = createMoqtClaim();
  claim.scopes.push(createMoqtScope(["Subscribe"]));
  claim.scopes.push(scope);
  const encodedClaim = encodeMoqtClaim(claim);
  assert.deepEqual(decodeMoqtClaim(encodedClaim), claim);
});

test("スコープのエンコードは空の省略可能部分を出力しない", () => {
  const actionOnly = createMoqtScope(["Publish"]);
  assert.deepEqual(encodeMoqtScope(actionOnly), cborArray([cborArray([cborInteger(6)])]));
  const withNamespace = createMoqtScope(["Publish"]);
  withNamespace.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("a"))));
  assert.deepEqual(
    encodeMoqtScope(withNamespace),
    cborArray([cborArray([cborInteger(6)]), cborArray([cborByteString(TEXT_ENCODER.encode("a"))])]),
  );
  // namespace を省略して track だけを持つことはできない
  // (CDDL の位置指定で表現できず、トラック制限を落とすと認可が広がるため)
  const trackOnly = createMoqtScope(["Publish"]);
  trackOnly.track = exactMatch(TEXT_ENCODER.encode("t"));
  assertC4mError(() => encodeMoqtScope(trackOnly), "trackWithoutNamespace");
});

test("アクションの対応表を確認する", () => {
  for (const [index, action] of MOQT_ACTIONS.entries()) {
    assert.equal(moqtActionKey(action), index);
    assert.equal(moqtActionFromKey(index), action);
    assert.notEqual(moqtActionName(action), "");
    assert.notEqual(moqtAuthorizationContext(action), "");
    assert.equal(
      moqtActionMatchesAuthorizationContext(action, moqtAuthorizationContext(action)),
      true,
    );
  }
  assert.equal(moqtActionFromKey(9), undefined);
  assert.equal(moqtActionName("ClientSetup"), "CLIENT_SETUP");
  assert.equal(moqtAuthorizationContext("ClientSetup"), "SETUP");
  assert.equal(moqtAuthorizationContext("ServerSetup"), "SETUP");
  assert.equal(moqtActionMatchesAuthorizationContext("ClientSetup", "PUB_NS"), false);
});

test("bin-match のマッチ規則を確認する", () => {
  assert.equal(
    matchMatches(exactMatch(TEXT_ENCODER.encode("abc")), TEXT_ENCODER.encode("abc")),
    true,
  );
  assert.equal(
    matchMatches(exactMatch(TEXT_ENCODER.encode("abc")), TEXT_ENCODER.encode("abcd")),
    false,
  );
  assert.equal(
    matchMatches(prefixMatch(TEXT_ENCODER.encode("ab")), TEXT_ENCODER.encode("abc")),
    true,
  );
  assert.equal(
    matchMatches(prefixMatch(TEXT_ENCODER.encode("ab")), TEXT_ENCODER.encode("b")),
    false,
  );
  assert.equal(
    matchMatches(suffixMatch(TEXT_ENCODER.encode("bc")), TEXT_ENCODER.encode("abc")),
    true,
  );
  assert.equal(
    matchMatches(suffixMatch(TEXT_ENCODER.encode("bc")), TEXT_ENCODER.encode("b")),
    false,
  );
  assert.equal(MATCH_TYPE_PREFIX, 1);
  assert.equal(MATCH_TYPE_SUFFIX, 2);
  assert.deepEqual(
    encodeMatch(prefixMatch(TEXT_ENCODER.encode("x"))),
    cborArray([cborInteger(MATCH_TYPE_PREFIX), cborByteString(TEXT_ENCODER.encode("x"))]),
  );
  assert.deepEqual(
    encodeMatch(suffixMatch(TEXT_ENCODER.encode("x"))),
    cborArray([cborInteger(MATCH_TYPE_SUFFIX), cborByteString(TEXT_ENCODER.encode("x"))]),
  );
  assert.deepEqual(
    encodeMatch(exactMatch(TEXT_ENCODER.encode("x"))),
    cborByteString(TEXT_ENCODER.encode("x")),
  );
});

test("catdpop はウィンドウと jti の設定をデコードできる", () => {
  const integerSettings = decodeCatDpop(
    cborMap([
      [cborInteger(0), cborInteger(60)],
      [cborInteger(1), cborInteger(1)],
    ]),
  );
  assert.equal(integerSettings.windowSeconds, 60);
  assert.equal(integerSettings.honorJti, true);
  assert.equal(catDpopHonorsJti(integerSettings), true);
  assert.equal(catDpopWindowSecondsOr(integerSettings, 300), 60);

  const floatSettings = decodeCatDpop(
    cborMap([
      [cborInteger(0), cborFloat(300)],
      [cborInteger(1), cborInteger(0)],
    ]),
  );
  assert.equal(floatSettings.windowSeconds, 300);
  assert.equal(floatSettings.honorJti, false);
  assert.equal(catDpopHonorsJti(floatSettings), false);

  const windowOnly = decodeCatDpop(cborMap([[cborInteger(0), cborInteger(120)]]));
  assert.equal(windowOnly.windowSeconds, 120);
  assert.equal(windowOnly.honorJti, undefined);
  assert.equal(catDpopHonorsJti(windowOnly), false);
  assert.equal(catDpopWindowSecondsOr(windowOnly, 300), 120);

  // 未知の設定は raw に保持する
  const unknown = decodeCatDpop(cborMap([[cborInteger(9), cborTextString("x")]]));
  assert.deepEqual(unknown.raw, [[cborInteger(9), cborTextString("x")]]);
});

test("catdpop のエラーと往復を確認する", () => {
  assertC4mError(() => decodeCatDpop(cborUnsigned(1n)), "unexpectedType", "catdpop");
  assertC4mError(
    () => decodeCatDpop(cborMap([[cborInteger(0), CBOR_TRUE]])),
    "unexpectedType",
    "catdpop window",
  );
  assertC4mError(
    () => decodeCatDpop(cborMap([[cborInteger(1), cborTextString("x")]])),
    "unexpectedType",
    "catdpop honor jti",
  );
  assertC4mError(
    () => decodeCatDpop(cborMap([[cborTextString("x"), cborInteger(1)]])),
    "unexpectedType",
    "catdpop label",
  );

  const catdpop = createCatDpop(300, true);
  const encoded = encodeCatDpop(catdpop);
  assert.deepEqual(decodeCatDpop(encoded), catdpop);
  // ドラフトの例に合わせて 1 / 0 の整数で書く
  assert.deepEqual(cborMapGet(encoded, cborInteger(1)), cborInteger(1));
});

test("nil で名前空間の長さを固定してもトラックマッチは評価される", () => {
  const scope = createMoqtScope(["Publish"]);
  scope.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("a"))));
  scope.namespace.push(namespaceMatchEnd());
  scope.track = exactMatch(TEXT_ENCODER.encode("t"));
  assert.equal(
    moqtScopeAllows(scope, "Publish", [TEXT_ENCODER.encode("a")], TEXT_ENCODER.encode("t")),
    true,
  );
  assert.equal(
    moqtScopeAllows(scope, "Publish", [TEXT_ENCODER.encode("a")], TEXT_ENCODER.encode("other")),
    false,
  );
  assert.equal(
    moqtScopeAllows(
      scope,
      "Publish",
      [TEXT_ENCODER.encode("a"), TEXT_ENCODER.encode("b")],
      TEXT_ENCODER.encode("t"),
    ),
    false,
  );
});

test("catdpop の非有限ウィンドウを拒否する", () => {
  assertC4mError(
    () => decodeCatDpop(cborMap([[cborInteger(0), cborFloat(Number.NaN)]])),
    "nonFiniteNumber",
    "catdpop window",
  );
});

test("数値クレームは 2^63 を整数へ丸めない", () => {
  // 2^63 は整数として表現できないため、静かに 2^63-1 へ丸めず浮動小数点数のまま扱う
  const value = 2 ** 63;
  const catdpop = createCatDpop(value, false);
  const decoded = decodeCatDpop(encodeCatDpop(catdpop));
  assert.equal(decoded.windowSeconds, value);
});

test("直接構築したスコープでも nil の位置異常は認可しない", () => {
  // デコードでは弾かれるが、直接構築したスコープでも nil の位置異常は認可しない
  const scope: MoqtScope = {
    actions: [moqtActionKey("Publish")],
    namespace: [
      namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("a"))),
      namespaceMatchEnd(),
      namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("b"))),
    ],
    track: undefined,
  };
  assert.equal(
    moqtScopeAllows(
      scope,
      "Publish",
      [TEXT_ENCODER.encode("a"), TEXT_ENCODER.encode("b")],
      TEXT_ENCODER.encode("t"),
    ),
    false,
  );
  assert.equal(
    moqtScopeAllows(scope, "Publish", [TEXT_ENCODER.encode("a")], TEXT_ENCODER.encode("t")),
    false,
  );
});
