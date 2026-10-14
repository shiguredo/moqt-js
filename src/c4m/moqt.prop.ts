/**
 * C4M の `moqt` クレームと認可の Property-Based Testing
 *
 * draft-ietf-moq-c4m-01 Section 2.1 の `bin-match` と `moqt-scope` の判定を、実装の
 * 走査手順を写経せずに仕様の宣言的な読み方で書いた独立モデルと突き合わせる。あわせて
 * `moqt-scope` / `moqt` クレームの往復と、任意のデータ項目に対するデコーダの全域性
 * (C4mError 以外の例外を漏らさないこと) を確認する。
 *
 * 判定の入力は任意のバイト列にする。文字列へ変換して比較すると不正な UTF-8 が置換
 * 文字に潰れて偽の緑になるため、モデルもバイト列の添字比較だけで書く。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  cborArray,
  cborAsInt64,
  cborBool,
  cborByteString,
  cborInteger,
  cborMap,
  cborMapGet,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import {
  C4mError,
  type C4mErrorCode,
  MATCH_TYPE_PREFIX,
  MATCH_TYPE_SUFFIX,
  MOQT_ACTIONS,
  type Match,
  type MoqtAction,
  type MoqtClaim,
  type MoqtScope,
  type NamespaceMatch,
  catDpopHonorsJti,
  createMoqtClaim,
  decodeCatDpop,
  decodeMatch,
  decodeMoqtClaim,
  decodeMoqtScope,
  encodeCatDpop,
  encodeMoqtClaim,
  encodeMoqtScope,
  exactMatch,
  matchMatches,
  moqtActionKey,
  moqtScopeAllows,
  namespaceMatchEnd,
  namespaceMatchValue,
  prefixMatch,
  suffixMatch,
} from "./moqt";
import { assertC4mError, cborValueArbitrary, encodeHex } from "./testSupport";
import { unreachableValue } from "./unreachable";

// ===== bin-match の判定 (matchMatches) =====

/** パターンの長さの上限 */
const PATTERN_MAX_LENGTH = 16;

/** `bin-match` の match-type を生成する */
const matchTypeArbitrary = fc.constantFrom("exact", "prefix", "suffix");

/** match-type とパターンから `bin-match` を作る (実装の公開コンストラクタを使う) */
function makeMatch(type: "exact" | "prefix" | "suffix", pattern: Uint8Array): Match {
  switch (type) {
    case "exact":
      return exactMatch(pattern);
    case "prefix":
      return prefixMatch(pattern);
    case "suffix":
      return suffixMatch(pattern);
    default:
      return unreachableValue(type);
  }
}

/** 任意の `bin-match` を生成する (パターンは不正な UTF-8 を含む任意のバイト列) */
const matchArbitrary: fc.Arbitrary<Match> = fc
  .tuple(matchTypeArbitrary, fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }))
  .map(([type, pattern]) => makeMatch(type, pattern));

/** 2 つのバイト列を連結する */
function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/** パターンを値から導く関係 */
const matchRelationArbitrary = fc.constantFrom("independent", "prefix", "suffix", "equal");

/**
 * 関係に応じてパターンを作る
 *
 * `lengthSeed` は prefix / suffix の長さを 0 〜 値の長さの範囲へ写す。
 */
function derivePattern(
  relation: "independent" | "prefix" | "suffix" | "equal",
  value: Uint8Array,
  independent: Uint8Array,
  lengthSeed: number,
): Uint8Array {
  switch (relation) {
    case "independent":
      return independent;
    case "equal":
      return value;
    case "prefix":
      return value.slice(0, lengthSeed % (value.length + 1));
    case "suffix":
      return value.slice(value.length - (lengthSeed % (value.length + 1)));
    default:
      return unreachableValue(relation);
  }
}

/**
 * `bin-match` と値の組を生成する
 *
 * 独立に生成した組だけでは、任意のバイト列が偶然一致する確率が 256 の長さ乗で
 * ほとんど 0 になり、prefix / suffix が一致する領域をほぼ踏まない。値から導いた
 * prefix / suffix / 同値のパターンも混ぜ、一致する領域を確実に踏む。
 */
const matchCaseArbitrary: fc.Arbitrary<{ match: Match; value: Uint8Array }> = fc
  .tuple(
    matchRelationArbitrary,
    matchTypeArbitrary,
    fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
    fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
    fc.nat({ max: PATTERN_MAX_LENGTH }),
  )
  .map(([relation, type, value, independent, lengthSeed]) => ({
    match: makeMatch(type, derivePattern(relation, value, independent, lengthSeed)),
    value,
  }));

/**
 * `matchMatches` の独立モデル (draft-ietf-moq-c4m-01 Section 2.1)
 *
 * `Uint8Array` の添字比較だけで書き、TextDecoder や文字列を経由しない。suffix は
 * 末尾から数えた添字で比較し、実装の前方向の走査とは別の書き方にする。
 */
function matchMatchesModel(match: Match, value: Uint8Array): boolean {
  const { pattern } = match;
  switch (match.type) {
    case "exact": {
      if (pattern.length !== value.length) {
        return false;
      }
      for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] !== value[index]) {
          return false;
        }
      }
      return true;
    }
    case "prefix": {
      if (pattern.length > value.length) {
        return false;
      }
      for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] !== value[index]) {
          return false;
        }
      }
      return true;
    }
    case "suffix": {
      if (pattern.length > value.length) {
        return false;
      }
      for (let offset = 0; offset < pattern.length; offset++) {
        if (pattern[pattern.length - 1 - offset] !== value[value.length - 1 - offset]) {
          return false;
        }
      }
      return true;
    }
    default:
      return unreachableValue(match);
  }
}

test("matchMatches は exact / prefix / suffix の添字モデルと一致する", () => {
  // 独立な組と値から導いた組の両方で、3 つの match-type すべてがモデルと一致することを見る
  fc.assert(
    fc.property(matchCaseArbitrary, ({ match, value }) => {
      assert.equal(
        matchMatches(match, value),
        matchMatchesModel(match, value),
        `${describeMatch(match)} と値 ${encodeHex(value)} の判定がモデルと異なる`,
      );
    }),
  );
});

test("matchMatches は空パターンと同長・1 バイト長いパターンの境界でモデルと一致する", () => {
  // 空パターン / 値と同長 / 値より 1 バイト長い、の 3 通りを固定する。値より長い
  // パターンは exact / prefix / suffix のいずれでも一致しない
  fc.assert(
    fc.property(
      matchTypeArbitrary,
      fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
      (type, value) => {
        const empty = makeMatch(type, new Uint8Array(0));
        assert.equal(
          matchMatches(empty, value),
          matchMatchesModel(empty, value),
          `空パターンと値 ${encodeHex(value)} の判定がモデルと異なる`,
        );

        const sameLength = makeMatch(type, value);
        assert.equal(
          matchMatches(sameLength, value),
          matchMatchesModel(sameLength, value),
          `同長のパターン ${describeMatch(sameLength)} の判定がモデルと異なる`,
        );
        assert.equal(
          matchMatches(sameLength, value),
          true,
          `同長のパターン ${describeMatch(sameLength)} が値 ${encodeHex(value)} に一致しない`,
        );

        const longer = makeMatch(type, concatBytes(value, new Uint8Array([0x00])));
        assert.equal(
          matchMatches(longer, value),
          false,
          `値より長いパターン ${describeMatch(longer)} が値 ${encodeHex(value)} に一致した`,
        );
        assert.equal(
          matchMatches(longer, value),
          matchMatchesModel(longer, value),
          `値より長いパターン ${describeMatch(longer)} の判定がモデルと異なる`,
        );
      },
    ),
  );
});

test("prefix / suffix のマッチは連結で保存され、exact は両方と同長で特徴づけられる", () => {
  // 実装ではなく仕様の読み方から導ける法則だけを確認する。値から導いたパターンを
  // 混ぜることで、prefix / suffix が一致する領域で法則が空振りしないようにする
  fc.assert(
    fc.property(
      matchCaseArbitrary,
      fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
      fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
      ({ match, value }, head, tail) => {
        const { pattern } = match;

        // prefix が値に一致するなら、値の後ろへ何を足しても一致し続ける
        if (match.type === "prefix" && matchMatches(match, value)) {
          assert.equal(
            matchMatches(match, concatBytes(value, tail)),
            true,
            `prefix(${encodeHex(pattern)}) が値 ${encodeHex(value)} に一致するのに ${encodeHex(tail)} を足すと一致しない`,
          );
        }

        // suffix が値に一致するなら、値の前へ何を足しても一致し続ける
        if (match.type === "suffix" && matchMatches(match, value)) {
          assert.equal(
            matchMatches(match, concatBytes(head, value)),
            true,
            `suffix(${encodeHex(pattern)}) が値 ${encodeHex(value)} に一致するのに ${encodeHex(head)} を足すと一致しない`,
          );
        }

        // exact は「prefix と suffix の両方が成り立ち、かつ長さが等しい」ことと同値
        const characterized =
          matchMatches(prefixMatch(pattern), value) &&
          matchMatches(suffixMatch(pattern), value) &&
          pattern.length === value.length;
        assert.equal(
          matchMatches(exactMatch(pattern), value),
          characterized,
          `exact(${encodeHex(pattern)}) の判定が prefix / suffix / 同長の組み合わせと異なる (値 ${encodeHex(value)})`,
        );

        // exact が成り立つなら prefix と suffix も成り立つ
        if (matchMatches(exactMatch(pattern), value)) {
          assert.equal(
            matchMatches(prefixMatch(pattern), value),
            true,
            "exact なのに prefix が一致しない",
          );
          assert.equal(
            matchMatches(suffixMatch(pattern), value),
            true,
            "exact なのに suffix が一致しない",
          );
        }
      },
    ),
  );
});

// ===== moqt-scope の認可判定 (moqtScopeAllows) =====

/** 名前空間フィールドに使うバイト列 */
const FIELD_A = new Uint8Array([0x61]);
const FIELD_B = new Uint8Array([0x62]);
const FIELD_AB = new Uint8Array([0x61, 0x62]);
const FIELD_ABC = new Uint8Array([0x61, 0x62, 0x63]);
const FIELD_EMPTY = new Uint8Array(0);

/** 判定を全列挙する名前空間の有限宇宙 (空・ 1 フィールド・ 2 フィールド・ 3 フィールド) */
const NAMESPACE_UNIVERSE: Uint8Array[][] = [
  [],
  [FIELD_EMPTY],
  [FIELD_A],
  [FIELD_B],
  [FIELD_A, FIELD_B],
  [FIELD_A, FIELD_A],
  [FIELD_AB],
  [FIELD_A, FIELD_AB],
  [FIELD_AB, FIELD_A],
  [FIELD_A, FIELD_B, FIELD_AB],
];

/** 判定を全列挙するトラック名の有限宇宙 */
const TRACK_UNIVERSE: Uint8Array[] = [FIELD_EMPTY, FIELD_A, FIELD_B, FIELD_AB, FIELD_ABC];

/** 有限宇宙のフィールドと重なるパターンを作るためのアルファベット */
const PATTERN_ALPHABET = [0x61, 0x62, 0x63];

/** 有限宇宙のフィールドと重なる短いパターンを持つ `bin-match` を生成する */
const compactMatchArbitrary: fc.Arbitrary<Match> = fc
  .tuple(
    matchTypeArbitrary,
    fc.array(fc.constantFrom(...PATTERN_ALPHABET), { maxLength: 3, size: "max" }),
  )
  .map(([type, bytes]) => makeMatch(type, Uint8Array.from(bytes)));

/**
 * 名前空間マッチ列を生成する
 *
 * `nil` は末尾にだけ置けるため、末尾へ置く場合と置かない場合を分けて生成する。
 */
function namespaceMatchArrayArbitrary(
  match: fc.Arbitrary<Match>,
  maxLength: number,
): fc.Arbitrary<NamespaceMatch[]> {
  const withoutNil = fc
    .array(match, { maxLength, size: "max" })
    .map((matches) => matches.map((item) => namespaceMatchValue(item)));
  const withNil = fc
    .array(match, { maxLength: maxLength - 1, size: "max" })
    .map((matches) => [...matches.map((item) => namespaceMatchValue(item)), namespaceMatchEnd()]);
  return fc.oneof(withoutNil, withNil);
}

/** Table 1 のアクション整数を生成する */
const tableActionKeyArbitrary: fc.Arbitrary<number> = fc.constantFrom(
  ...MOQT_ACTIONS.map((action) => moqtActionKey(action)),
);

/**
 * `moqtScopeAllows` の判定に使うスコープを生成する
 *
 * 名前空間マッチが空でもトラックマッチを持つスコープを許す (`moqtScopeAllows` は
 * その形も判定できる)。直接構築したスコープはアクションが空にもなり得るため、
 * アクション 0 個のスコープも生成する (エンコードは別の生成器で制限する)。
 */
const scopeArbitrary: fc.Arbitrary<MoqtScope> = fc.record({
  actions: fc.uniqueArray(tableActionKeyArbitrary, {
    minLength: 0,
    maxLength: 4,
    size: "max",
    selector: String,
  }),
  namespace: namespaceMatchArrayArbitrary(compactMatchArbitrary, 3),
  track: fc.option(compactMatchArbitrary, { nil: undefined }),
});

/** 失敗メッセージ用に `bin-match` を表す */
function describeMatch(match: Match): string {
  return `${match.type}(${encodeHex(match.pattern)})`;
}

/** 失敗メッセージ用に名前空間マッチ列を表す */
function describeNamespaceMatch(namespace: NamespaceMatch[]): string {
  if (namespace.length === 0) {
    return "<empty>";
  }
  return namespace
    .map((item) => (item.type === "end" ? "end" : describeMatch(item.match)))
    .join(",");
}

/** 失敗メッセージ用にスコープを表す */
function describeScope(scope: MoqtScope): string {
  const track = scope.track === undefined ? "<none>" : describeMatch(scope.track);
  const namespace = describeNamespaceMatch(scope.namespace);
  return `actions=[${scope.actions.join(",")}] namespace=[${namespace}] track=${track}`;
}

/** 失敗メッセージ用に名前空間を表す */
function describeNamespace(namespace: Uint8Array[]): string {
  if (namespace.length === 0) {
    return "<empty>";
  }
  return namespace.map((field) => encodeHex(field)).join("/");
}

/** 失敗メッセージ用に判定の入力一式を表す */
function describeCase(
  scope: MoqtScope,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): string {
  const fields = describeNamespace(namespace);
  return `action=${action} scope=${describeScope(scope)} namespace=${fields} track=${encodeHex(trackName)}`;
}

/**
 * `moqtScopeAllows` の宣言的モデル (draft-ietf-moq-c4m-01 Section 2.1)
 *
 * 実装の「マッチを順に消費する」走査は写経せず、仕様の宣言的な読み方で書く:
 *
 * - アクションの集合に含まれること
 * - 名前空間がマッチ列を先頭から満たすこと。`nil` があれば名前空間の長さはマッチ列の
 *   長さに固定され、無ければ残りのフィールドは任意である
 * - トラックマッチがあればトラック名にも一致すること
 *
 * `scope.namespace` は `nil` が末尾にだけ現れる整形式を前提にする (末尾以外の `nil`
 * は不正なスコープとして別のテストで固定する)。
 */
function moqtScopeAllowsModel(
  scope: MoqtScope,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  if (!scope.actions.includes(moqtActionKey(action))) {
    return false;
  }

  // 整形式のスコープでは nil は末尾にしか無いため、nil を除いた列がマッチ列になる
  const namespaceMatches: Match[] = [];
  for (const item of scope.namespace) {
    if (item.type === "match") {
      namespaceMatches.push(item.match);
    }
  }
  const endsWithNil = scope.namespace.at(-1)?.type === "end";

  if (namespace.length < namespaceMatches.length) {
    return false;
  }
  if (endsWithNil && namespace.length !== namespaceMatches.length) {
    return false;
  }
  for (let index = 0; index < namespaceMatches.length; index++) {
    const namespaceMatch = namespaceMatches[index];
    const field = namespace[index];
    if (namespaceMatch === undefined || field === undefined) {
      return false;
    }
    if (!matchMatches(namespaceMatch, field)) {
      return false;
    }
  }
  if (scope.track === undefined) {
    return true;
  }
  return matchMatches(scope.track, trackName);
}

test("moqtScopeAllows は有限宇宙の全列挙で宣言的モデルと一致する", () => {
  // スコープだけを fc で生成し、判定の入力は有限宇宙で for により全列挙する。
  // 名前空間 10 通り × トラック名 5 通りなので既定の numRuns でも十分に速い
  fc.assert(
    fc.property(scopeArbitrary, fc.constantFrom(...MOQT_ACTIONS), (scope, action) => {
      for (const namespace of NAMESPACE_UNIVERSE) {
        for (const trackName of TRACK_UNIVERSE) {
          const actual = moqtScopeAllows(scope, action, namespace, trackName);
          const expected = moqtScopeAllowsModel(scope, action, namespace, trackName);
          assert.equal(actual, expected, describeCase(scope, action, namespace, trackName));
        }
      }
    }),
  );
});

/** `nil` が末尾以外にある不正なスコープと、そのスコープが持つアクションの組を生成する */
const illFormedNilScopeArbitrary: fc.Arbitrary<{ scope: MoqtScope; action: MoqtAction }> = fc
  .tuple(
    fc.constantFrom(...MOQT_ACTIONS),
    fc.array(matchArbitrary, { minLength: 1, maxLength: 2, size: "max" }),
    fc.nat({ max: 1000 }),
  )
  .map(([action, matches, seed]) => {
    const namespace = matches.map((item) => namespaceMatchValue(item));
    // 末尾以外の位置 (0 〜 元の長さ - 1) へ nil を差し込む
    namespace.splice(seed % namespace.length, 0, namespaceMatchEnd());
    return { scope: { actions: [moqtActionKey(action)], namespace, track: undefined }, action };
  });

test("nil が末尾以外にあるスコープはアクションが一致しても認可しない", () => {
  // 単体テストの固定ケースを、nil の位置・マッチ・判定入力を任意に広げて固定する。
  // 宣言的モデルは整形式のスコープだけを対象にするため、不正形はここで押さえる
  fc.assert(
    fc.property(illFormedNilScopeArbitrary, ({ scope, action }) => {
      for (const namespace of NAMESPACE_UNIVERSE) {
        for (const trackName of TRACK_UNIVERSE) {
          assert.equal(
            moqtScopeAllows(scope, action, namespace, trackName),
            false,
            `nil が末尾以外にあるスコープが認可した: ${describeCase(scope, action, namespace, trackName)}`,
          );
        }
      }
    }),
  );
});

// ===== スコープとクレームの往復 =====

/**
 * 直列化できるスコープを生成する
 *
 * 実装が拒否する形は生成器の定義域から外す: アクションを 1 個以上持ち、`nil` は末尾
 * にだけ置き、名前空間マッチが空ならトラックマッチを持たない。
 */
function serializableScopeArbitrary(action: fc.Arbitrary<number>): fc.Arbitrary<MoqtScope> {
  return fc
    .record({
      actions: fc.array(action, { minLength: 1, maxLength: 4, size: "max" }),
      namespace: namespaceMatchArrayArbitrary(matchArbitrary, 3),
      track: fc.option(matchArbitrary, { nil: undefined }),
    })
    .map((scope) => ({
      actions: scope.actions,
      namespace: scope.namespace,
      track: scope.namespace.length === 0 ? undefined : scope.track,
    }));
}

/** 失敗メッセージ用にクレームを表す */
function describeClaim(claim: MoqtClaim): string {
  return claim.scopes.map((scope) => describeScope(scope)).join(" | ");
}

test("直列化できるスコープは CBOR を挟んでも往復し、再エンコードが安定する", () => {
  // パターンは任意のバイト列なので、不正な UTF-8 が置換文字に潰れないことも一緒に見る
  fc.assert(
    fc.property(serializableScopeArbitrary(tableActionKeyArbitrary), (scope) => {
      const encoded = encodeMoqtScope(scope);
      assert.deepEqual(
        decodeMoqtScope(encoded),
        scope,
        `エンコードしたデータ項目のデコードで構造が変わった: ${describeScope(scope)}`,
      );

      // CBOR のバイト列を挟むとバイト列が複製されるため、参照の一致に頼らない確認になる
      const bytes = encodeCbor(encoded);
      const decoded = decodeMoqtScope(decodeCbor(bytes));
      assert.deepEqual(decoded, scope, `CBOR を挟むと構造が変わった: ${describeScope(scope)}`);
      assert.deepEqual(
        encodeCbor(encodeMoqtScope(decoded)),
        bytes,
        `再エンコードが同じバイト列にならない: ${describeScope(scope)}`,
      );
    }),
  );
});

test("直列化できるクレームは CBOR を挟んでも往復し、再エンコードが安定する", () => {
  fc.assert(
    fc.property(
      fc.array(serializableScopeArbitrary(tableActionKeyArbitrary), {
        minLength: 1,
        maxLength: 3,
        size: "max",
      }),
      (scopes) => {
        const claim = createMoqtClaim();
        claim.scopes.push(...scopes);

        const encoded = encodeMoqtClaim(claim);
        assert.deepEqual(
          decodeMoqtClaim(encoded),
          claim,
          `エンコードしたデータ項目のデコードで構造が変わった: ${describeClaim(claim)}`,
        );

        const bytes = encodeCbor(encoded);
        const decoded = decodeMoqtClaim(decodeCbor(bytes));
        assert.deepEqual(decoded, claim, `CBOR を挟むと構造が変わった: ${describeClaim(claim)}`);
        assert.deepEqual(
          encodeCbor(encodeMoqtClaim(decoded)),
          bytes,
          `再エンコードが同じバイト列にならない: ${describeClaim(claim)}`,
        );
      },
    ),
  );
});

// ===== デコーダの全域性 =====

/** `C4mError` が取り得るエラーコード (`C4mErrorCode` の全体) */
const C4M_ERROR_CODES: readonly C4mErrorCode[] = [
  "unexpectedType",
  "emptyActions",
  "emptyScopes",
  "invalidAction",
  "invalidMatchArrayLength",
  "invalidMatchType",
  "nilNotLast",
  "emptyNamespaceMatch",
  "invalidScopeLength",
  "trackWithoutNamespace",
  "nonFiniteNumber",
];

/**
 * デコーダを呼び、成功するか `C4mError` を投げるかのいずれかであることを確認する
 *
 * RangeError や TypeError が漏れた場合はここでテストを落とす。エラー時は undefined を返す。
 */
function runDecoder<T>(name: string, decode: () => T): T | undefined {
  try {
    return decode();
  } catch (error) {
    assert.ok(error instanceof C4mError, `${name} が C4mError 以外を送出した: ${String(error)}`);
    assert.include(C4M_ERROR_CODES, error.code, `${name} のエラーコードが未知: ${error.code}`);
    return undefined;
  }
}

test("decodeMatch は match-type 1 / 2 を prefix / suffix にし、それ以外の i64 を拒否する", () => {
  // match-type を i64 の全域から生成し、1 / 2 以外が黙って exact へ落ちないことを固定する
  fc.assert(
    fc.property(
      fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }),
      fc.uint8Array({ maxLength: PATTERN_MAX_LENGTH, size: "max" }),
      (matchType, pattern) => {
        // バイト文字列は完全一致を表す
        assert.deepEqual(decodeMatch(cborByteString(pattern)), exactMatch(pattern));

        if (matchType === BigInt(MATCH_TYPE_PREFIX)) {
          assert.deepEqual(
            decodeMatch(cborArray([cborInteger(matchType), cborByteString(pattern)])),
            prefixMatch(pattern),
          );
          return;
        }
        if (matchType === BigInt(MATCH_TYPE_SUFFIX)) {
          assert.deepEqual(
            decodeMatch(cborArray([cborInteger(matchType), cborByteString(pattern)])),
            suffixMatch(pattern),
          );
          return;
        }
        const encoded = cborArray([cborInteger(matchType), cborByteString(pattern)]);
        const error = assertC4mError(() => decodeMatch(encoded), "invalidMatchType");
        assert.equal(
          error.detail,
          Number(matchType),
          `invalidMatchType の詳細が違う: ${matchType}`,
        );
      },
    ),
  );
});

test("任意のデータ項目に対してデコーダは成功するか C4mError になる", () => {
  // 入れ子 3 段までの任意のデータ項目を 4 つのデコーダへ通す。C4mError 以外の例外
  // (RangeError や TypeError) が漏れないことと、エラーコードが既知であることを見る。
  // 成功側の assert は decodeMoqtScope 自身が保証する契約の再確認であり、任意の
  // データ項目が有効な moqt-scope になる確率は低いため、回数は既定のままにする
  fc.assert(
    fc.property(cborValueArbitrary(3), (value) => {
      const scope = runDecoder("decodeMoqtScope", () => decodeMoqtScope(value));
      if (scope !== undefined) {
        assert.ok(
          scope.actions.length > 0,
          `アクションが空のスコープがデコードされた: ${describeScope(scope)}`,
        );
      }
      runDecoder("decodeMoqtClaim", () => decodeMoqtClaim(value));
      runDecoder("decodeCatDpop", () => decodeCatDpop(value));
      runDecoder("decodeMatch", () => decodeMatch(value));
    }),
  );
});

// ===== エンコード側のアクション検証 =====

/** 安全な整数のアクションを生成する (0 / 8 / ±(2^53 - 1) の境界を含む) */
const safeActionArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 8, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, -1),
  // -0 は BigInt への変換で 0 に潰れて往復しないため生成器の定義域から外す
  fc
    .integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })
    .filter((value) => !Object.is(value, -0)),
);

/** 安全な整数でないアクションを生成する (小数・非数・無限大・2^53 以上) */
const unsafeActionArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.double().filter((value) => !Number.isSafeInteger(value)),
  fc.constantFrom(
    1.5,
    -1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2 ** 53,
    -(2 ** 53),
    2 ** 63,
    -(2 ** 63),
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ),
);

test("安全な整数でないアクションは invalidAction でエンコードを拒否する", () => {
  fc.assert(
    fc.property(
      fc.tuple(unsafeActionArbitrary, fc.array(safeActionArbitrary, { maxLength: 2, size: "max" })),
      ([unsafeAction, otherActions]) => {
        // 安全なアクションが混ざっていても、安全でない値を 1 つでも含めば拒否する
        const scope: MoqtScope = {
          actions: [unsafeAction, ...otherActions],
          namespace: [],
          track: undefined,
        };
        const error = assertC4mError(() => encodeMoqtScope(scope), "invalidAction");
        // 有限の値はエラー詳細に残す (NaN と無限大は数値として示せない)
        const expectedDetail = Number.isFinite(unsafeAction) ? unsafeAction : undefined;
        assert.equal(
          error.detail,
          expectedDetail,
          `invalidAction の詳細が違う: ${String(unsafeAction)}`,
        );
      },
    ),
  );
});

test("安全な整数のアクションは負の値を含めてエンコードとデコードで往復する", () => {
  fc.assert(
    fc.property(serializableScopeArbitrary(safeActionArbitrary), (scope) => {
      const bytes = encodeCbor(encodeMoqtScope(scope));
      assert.deepEqual(
        decodeMoqtScope(decodeCbor(bytes)),
        scope,
        `安全な整数のアクションが往復しない: ${describeScope(scope)}`,
      );
    }),
  );
});

test("catdpop の honor-jti は真偽値でも整数でも同じ値にデコードされる", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.integer({ min: 1, max: 3600 }), (honorJti, windowSeconds) => {
      // Appendix A の JSON 表現は真偽値で書き、Section 3.1.1 の CBOR 例は整数で書く
      const withBool = decodeCatDpop(
        cborMap([
          [cborInteger(0), cborInteger(windowSeconds)],
          [cborInteger(1), cborBool(honorJti)],
        ]),
      );
      const withInteger = decodeCatDpop(
        cborMap([
          [cborInteger(0), cborInteger(windowSeconds)],
          [cborInteger(1), cborInteger(honorJti ? 1 : 0)],
        ]),
      );
      assert.equal(withBool.honorJti, honorJti);
      assert.deepEqual(withInteger, withBool);
      assert.equal(catDpopHonorsJti(withBool), honorJti);
      // エンコードは整数の形に正規化する
      const encodedHonorJti = cborMapGet(encodeCatDpop(withBool), cborInteger(1));
      assert.ok(encodedHonorJti !== undefined, "honor-jti がエンコードされていない");
      assert.deepEqual(cborAsInt64(encodedHonorJti), honorJti ? 1n : 0n);
    }),
  );
});
