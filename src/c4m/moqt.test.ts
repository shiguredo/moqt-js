/**
 * C4M の `moqt` クレームと認可のテスト
 */

import { test, assert } from "vite-plus/test";
import { encodeBase64Url } from "./base64url";
import {
  C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS,
  MATCH_TYPE_PREFIX,
  MATCH_TYPE_SUFFIX,
  MOQT_ACTIONS,
  type MoqtClaim,
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
  moqtActionName,
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
import { CatToken, createCatClaims, decodeCatClaims, encodeCatClaims } from "./cat";
import { assertC4mError, assertCborError, decodeHex, encodeHex } from "./testSupport";
import { SCOPE_VECTORS } from "./testVectors";

const TEXT_ENCODER = new TextEncoder();
/** テストで明示する claim label 設定 (C4M 02 付録 A の検証用 preset) */
const CLAIM_LABELS = C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS;

/** テスト用の namespace をバイト列の配列へ変換する */
function namespaceBytes(namespace: string[]): Uint8Array[] {
  return namespace.map((field) => TEXT_ENCODER.encode(field));
}

test("付録 A.5 のトークンから認可判定できる", () => {
  for (const vector of SCOPE_VECTORS) {
    // 一次資料の cose_hex と cose_b64 が同じ完全な COSE 構造を表すことを固定する
    assert.equal(
      encodeBase64Url(decodeHex(vector.coseHex)),
      vector.token,
      `ベクタ ${vector.id} の cose_hex と cose_b64`,
    );
    // トークンをデコードし、payload がベクタの claims と一致することを確認してから
    // 認可判定に使う。payloadHex だけを直接デコードするとトークン経路を通らない。
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    assert.equal(encodeHex(token.payload()), vector.payloadHex, `ベクタ ${vector.id} の payload`);
    const claims = token.claims();
    assert.ok(claims.moqt !== undefined, `ベクタ ${vector.id} に moqt クレームがある`);
    for (const testCase of vector.tests) {
      const action = moqtActionFromKey(testCase.action);
      if (action === undefined) {
        // draft-ietf-moq-c4m-02 付録 A の moqt_admin_wildcard は actions に
        // 旧 C4M 01 の 0 (ClientSetup) を含むが、C4M 02 Table 1 に 0 は無い。
        // スキップしてよいのはこのベクタの action 0 だけであり、それ以外で
        // 未定義のアクションが現れたらベクタか対応表の取りこぼしとして失敗させる。
        assert.equal(
          vector.id === "moqt_admin_wildcard" && testCase.action === 0,
          true,
          `ベクタ ${vector.id} の action ${testCase.action} は未定義のアクション`,
        );
        continue;
      }
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
    if (vector.id === "moqt_admin_wildcard") {
      // 原本の admin_wildcard は actions に 0 を含む不整合なベクタである。0 を
      // SETUP と読み替えず、標準アクションの意味は本文 §2.1 Table 1 を優先する。
      // 同じスコープが SETUP (1) を許可し、SUBSCRIBE_TRACKS (9) を許可しないこと
      // は明示的に固定する。
      assert.equal(
        moqtActionFromKey(0),
        undefined,
        "0 は C4M 02 の標準アクションではない (SETUP は 1)",
      );
      const namespace = namespaceBytes(["any.namespace"]);
      const track = TEXT_ENCODER.encode("any-track");
      assert.equal(
        claims.moqt.scopes[0]?.actions.includes(0),
        true,
        "admin_wildcard の actions は 0 を含む (原本の不整合)",
      );
      assert.equal(
        moqtClaimAuthorize(claims.moqt, "Setup", namespace, track),
        true,
        "admin_wildcard は SETUP (1) を許可する",
      );
      assert.equal(
        moqtClaimAuthorize(claims.moqt, "SubscribeTracks", namespace, track),
        false,
        "admin_wildcard は SUBSCRIBE_TRACKS (9) を許可しない",
      );
    }
  }
});

test("付録 A.5 のスコープの内容を確認する", () => {
  const publisher = SCOPE_VECTORS.find((vector) => vector.id === "moqt_publisher_exact");
  assert.ok(publisher !== undefined);
  const publisherClaims = decodeCatClaims(
    decodeCbor(decodeHex(publisher.payloadHex)),
    CLAIM_LABELS,
  );
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
  const adminClaims = decodeCatClaims(decodeCbor(decodeHex(admin.payloadHex)), CLAIM_LABELS);
  const adminMoqt = adminClaims.moqt;
  assert.ok(adminMoqt !== undefined);
  // 原本のバイト列は action 0〜8 を持つ。0 は C4M 02 Table 1 に無く、SETUP は 1
  // である。原本の値を変更しない。
  assert.deepEqual(adminMoqt.scopes[0]?.actions, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(adminMoqt.scopes[0]?.namespace, []);
  assert.equal(adminMoqt.scopes[0]?.track, undefined);
  // 原本の action_names は旧 C4M 01 の ClientSetup / ServerSetup を残している。
  // 本文 §2.1 Table 1 の標準名 (SETUP / SUBSCRIBE_TRACKS) へ書き換えない。
  assert.deepEqual(admin.actionNames, [
    [
      "ClientSetup",
      "ServerSetup",
      "PublishNamespace",
      "SubscribeNamespace",
      "Subscribe",
      "RequestUpdate",
      "Publish",
      "Fetch",
      "TrackStatus",
    ],
  ]);
  // action 0 の認可期待も原本のまま残す
  assert.equal(admin.tests[0]?.action, 0);
  assert.equal(admin.tests[0]?.expected, true);
  // 標準アクションとしては SETUP (1) を含み、SUBSCRIBE_TRACKS (9) を含まない
  const adminActions = adminMoqt.scopes[0]?.actions ?? [];
  assert.equal(adminActions.includes(moqtActionKey("Setup")), true, "SETUP (1) を含む");
  assert.equal(
    adminActions.includes(moqtActionKey("SubscribeTracks")),
    false,
    "SUBSCRIBE_TRACKS (9) を含まない (原本の不整合)",
  );
});

test("付録 A.5 の moqt-reval を確認する", () => {
  for (const vector of SCOPE_VECTORS) {
    const claims = decodeCatClaims(decodeCbor(decodeHex(vector.payloadHex)), CLAIM_LABELS);
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
  assert.equal(encodeHex(encodeCbor(encodeCatClaims(claims, CLAIM_LABELS))), vector.payloadHex);
});

// moqtScopeAllows のマッチ規則 (nil が名前空間の末尾にだけ一致すること、nil が無ければ
// 残りの名前空間フィールドが任意であること、名前空間マッチが無ければ全許可になること、
// トラックマッチが評価されること) は moqt.prop.ts の「有限宇宙の全列挙で宣言的モデルと
// 一致する」PBT が任意のスコープで検証する。ここではデコード / エンコードの異常系を固定する。
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
  // draft-ietf-moq-c4m-02 §2.1: claim は CBOR map であるため、旧形式の配列は拒否する
  assertC4mError(() => decodeMoqtClaim(cborArray([])), "unexpectedType", "moqt claim");
  // §2.1: key 0 が必須なので、空の map は missingScopes で拒否する
  assertC4mError(() => decodeMoqtClaim(cborMap([])), "missingScopes");
  assertC4mError(() => decodeMoqtClaim(cborMap([[cborInteger(0), cborArray([])]])), "emptyScopes");
  // §2.1: key 0 の値は moqt-scopes の配列でなければならない
  assertC4mError(
    () => decodeMoqtClaim(cborMap([[cborInteger(0), cborTextString("x")]])),
    "unexpectedType",
    "moqt scopes",
  );
  // §2.1.1: 未知の map key は fail-closed で拒否する
  assertC4mError(
    () => decodeMoqtClaim(cborMap([[cborInteger(1), cborArray([])]])),
    "unknownClaimKey",
    "1",
  );
  // 有効な key 0 が先にあっても未知の key 1 を読み飛ばさない (short-circuit による
  // fail-open を防ぐ回帰テスト)
  assertC4mError(
    () =>
      decodeMoqtClaim(
        cborMap([
          [cborInteger(0), cborArray([cborArray([cborInteger(1)])])],
          [cborInteger(1), cborArray([])],
        ]),
      ),
    "unknownClaimKey",
    "1",
  );
  // §2.1 の CDDL は `* int => any` なので、整数以外の key は unexpectedType とする
  assertC4mError(
    () => decodeMoqtClaim(cborMap([[cborTextString("x"), cborArray([])]])),
    "unexpectedType",
    "moqt claim key",
  );
  // 2^63 は i64 の範囲外だが CDDL の `int` ではある。整数判定を cborAsInt64 に
  // 限定すると unexpectedType へ変わってしまうため、未知の整数 key として拒否する
  assertC4mError(
    () => decodeMoqtClaim(cborMap([[cborUnsigned(9_223_372_036_854_775_808n), cborArray([])]])),
    "unknownClaimKey",
    "9223372036854775808",
  );
  // key 0 が重複した map は CBOR 層 (src/c4m/cbor.ts) がワイヤ上で拒否する。
  // decodeMoqtClaim は CborValue を直接受ける公開 API のため、構築した map の
  // 重複もここで拒否する (最後の要素を採用する last-wins にしない)。
  assertC4mError(
    () =>
      decodeMoqtClaim(
        cborMap([
          [cborInteger(0), cborArray([cborArray([cborInteger(1)])])],
          [cborInteger(0), cborArray([cborArray([cborInteger(2)])])],
        ]),
      ),
    "duplicateScopesKey",
  );
  // a2 00 81 01 00 81 01 は map(2) {0: [1], 0: [1]}
  assertCborError(() => decodeCbor(decodeHex("a2008101008101")), "duplicateMapKey");
  assertCborError(
    () =>
      encodeCbor(
        cborMap([
          [cborInteger(0), cborArray([cborArray([cborInteger(1)])])],
          [cborInteger(0), cborArray([cborArray([cborInteger(2)])])],
        ]),
      ),
    "duplicateMapKey",
  );
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
  }
  // draft-ietf-moq-c4m-02 Table 1: SETUP は 1 に統合され、SUBSCRIBE_TRACKS (9) が加わった
  assert.equal(moqtActionFromKey(1), "Setup");
  assert.equal(moqtActionFromKey(9), "SubscribeTracks");
  // 0 は C4M 01 の ClientSetup であり、C4M 02 のアクションではない
  assert.equal(moqtActionFromKey(0), undefined);
  assert.equal(moqtActionName("Setup"), "SETUP");
  assert.equal(moqtActionName("SubscribeTracks"), "SUBSCRIBE_TRACKS");
});

test("actions に 0 だけを持つスコープはすべてのアクションを拒否する", () => {
  // draft-ietf-moq-c4m-02 Table 1 に 0 は無い。0 を SETUP などへ読み替えず、
  // 未知のアクションとして扱うことを固定する。createMoqtScope は MoqtAction だけを
  // 受けるため、生の 0 はスコープを直接組み立てて検証する。
  const scope: MoqtScope = { actions: [0], namespace: [], track: undefined };
  const claim: MoqtClaim = { scopes: [scope] };
  const namespace = namespaceBytes(["example.com", "alice"]);
  const trackName = TEXT_ENCODER.encode("video-hd");
  for (const action of MOQT_ACTIONS) {
    assert.equal(
      moqtScopeAllows(scope, action, namespace, trackName),
      false,
      `actions [0] のスコープが ${action} を許可した`,
    );
    assert.equal(
      moqtClaimAuthorize(claim, action, namespace, trackName),
      false,
      `actions [0] のクレームが ${action} を許可した`,
    );
  }
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

test("catdpop の raw は整数ラベルだけを受け付ける", () => {
  // デコード側は i64 の整数以外のラベルを拒否するため、エンコード側も揃える
  const textLabel = createCatDpop(30, true);
  textLabel.raw.push([cborTextString("custom"), cborUnsigned(1n)]);
  assertC4mError(() => encodeCatDpop(textLabel), "unexpectedType", "catdpop label");

  // 整数ラベルは往復する
  const integerLabel = createCatDpop(30, true);
  integerLabel.raw.push([cborInteger(1000), cborTextString("x")]);
  assert.deepEqual(decodeCatDpop(encodeCatDpop(integerLabel)), integerLabel);
});

test("catdpop の重複ラベルを拒否する", () => {
  // ワイヤ上の重複 key は CBOR 層が拒否するが、decodeCatDpop は CborValue を
  // 直接受ける公開 API のため、手組みの map でも同じ判定で拒否する
  assertC4mError(
    () =>
      decodeCatDpop(
        cborMap([
          [cborInteger(0), cborInteger(30)],
          [cborInteger(0), cborInteger(60)],
        ]),
      ),
    "duplicateCatDpopKey",
    0,
  );
  assertC4mError(
    () =>
      decodeCatDpop(
        cborMap([
          [cborInteger(1), cborInteger(1)],
          [cborInteger(1), cborInteger(0)],
        ]),
      ),
    "duplicateCatDpopKey",
    1,
  );
  // 型付きで解釈しない raw のラベルも、デコード側では重複を拒否する
  assertC4mError(
    () =>
      decodeCatDpop(
        cborMap([
          [cborInteger(9), cborTextString("a")],
          [cborInteger(9), cborTextString("b")],
        ]),
      ),
    "duplicateCatDpopKey",
    9,
  );

  // raw に型付きラベル 0 / 1 を置くと、デコード時に型付きフィールドと raw の
  // どちらが使われるかが曖昧になるため拒否する
  const rawWindow = createCatDpop(30, true);
  rawWindow.raw.push([cborInteger(0), cborInteger(60)]);
  assertC4mError(() => encodeCatDpop(rawWindow), "duplicateCatDpopKey", 0);
  const rawHonorJti = createCatDpop(30, true);
  rawHonorJti.raw.push([cborInteger(1), cborInteger(0)]);
  assertC4mError(() => encodeCatDpop(rawHonorJti), "duplicateCatDpopKey", 1);

  // raw 同士の重複もデコード側と同じく拒否する
  const duplicateRaw = createCatDpop(30, true);
  duplicateRaw.raw.push([cborInteger(9), cborTextString("a")]);
  duplicateRaw.raw.push([cborInteger(9), cborTextString("b")]);
  assertC4mError(() => encodeCatDpop(duplicateRaw), "duplicateCatDpopKey", 9);
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
