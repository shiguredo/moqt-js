/**
 * c4m の伏せ字・URL fragment・トークンの性質
 *
 * 伏せ字は「認可トークンを外部へ出さない」ための最後の砦である。任意の parameter 列に
 * ついて、値が残らないこと・他の parameter を壊さないことを確かめる。
 *
 * あわせて msf fragment の組み立てと c4m の取り出し / 取り除きが往復すること、Base64 の
 * 復号が表現によらず同じバイト列へ戻ること、発行した実際のトークンからクレームが表示用の
 * 情報として取り出せることを確かめる。これらは画面が URL からトークンを取り込み、解除し、
 * 内容を表示する経路そのものである。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { C4M } from "moqt-js";
import { formatUnixTime } from "../c4m-devtools/utils/claims";
import {
  decodeC4mBase64,
  decodeC4mTokenInfo,
  extractC4mBase64,
  extractC4mTrackNames,
  maskC4mValue,
  removeC4mParameter,
} from "./c4m";
import { buildCatWithClaims, buildCatWithTrackNames } from "./c4mTestSupport";

// 伏せ字にすると値が `<redacted>` になるため、c4m の値として妥当な Base64 を生成する
const base64Arbitrary = fc.stringMatching(/^[A-Za-z0-9+/]{4,24}$/);
// parameter 名は c4m (`c4m` で終わる名前) 以外とする。伏せ字は `c4m=` の部分一致で潰すため
// (`maskC4mValue` の JSDoc)、`ac4m=` のような別の parameter も伏せ字になる。これは
// トークンを出さない側へ倒した意図した挙動であり、「c4m 以外は変えない」性質の前提から外す
const parameterNameArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
  .filter((name) => !name.endsWith("c4m"));
const parameterValueArbitrary = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);

/** `msf:track-identifier&key=value&...` の形の fragment を生成する */
const fragmentArbitrary = fc
  .record({
    trackIdentifier: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
    c4mValue: base64Arbitrary,
    parameters: fc.array(
      fc.record({ name: parameterNameArbitrary, value: parameterValueArbitrary }),
      {
        maxLength: 4,
      },
    ),
  })
  .map(({ trackIdentifier, c4mValue, parameters }) => {
    const others = parameters.map((parameter) => `${parameter.name}=${parameter.value}`);
    return `msf:${trackIdentifier}&c4m=${c4mValue}${others.length === 0 ? "" : `&${others.join("&")}`}`;
  });

test("maskC4mValue: 伏せ字にした出力からは c4m を取り出せない", () => {
  // 値そのものが残っていれば extractC4mBase64 が取り出せてしまう
  fc.assert(
    fc.property(fragmentArbitrary, (fragment) => {
      assert.equal(extractC4mBase64(maskC4mValue(fragment)), undefined);
    }),
    { numRuns: 200 },
  );
});

test("maskC4mValue: c4m 以外の parameter と track-identifier は変えない", () => {
  fc.assert(
    fc.property(fragmentArbitrary, (fragment) => {
      const masked = maskC4mValue(fragment);
      const before = fragment.split("&");
      const after = masked.split("&");

      // parameter の数は変わらない
      assert.equal(after.length, before.length);
      for (const [index, segment] of before.entries()) {
        if (segment.startsWith("c4m=")) {
          assert.equal(after[index], "c4m=<redacted>");
        } else {
          assert.equal(after[index], segment);
        }
      }
    }),
    { numRuns: 200 },
  );
});

test("maskC4mValue: 複数行の本文へかけても、c4m の後ろの行を消さない", () => {
  // Copy for LLM の本文全体へかけるため、値の範囲が行をまたぐと後続の節が消える
  fc.assert(
    fc.property(
      fragmentArbitrary,
      fc.stringMatching(/^[A-Za-z0-9 =:._-]{1,20}$/),
      (fragment, trailingLine) => {
        const masked = maskC4mValue(`${fragment}\n${trailingLine}`);
        assert.equal(masked.split("\n")[1], trailingLine);
      },
    ),
    { numRuns: 200 },
  );
});

// ===== msf fragment の組み立て (extractC4mBase64 / removeC4mParameter) =====

/**
 * c4m の値として妥当な base64url (パディング無し)
 *
 * `extractC4mBase64` は Base64 として復号できる値だけを c4m と認める。空バイト列の
 * エンコードは空文字になり c4m として認められないため、長さ 1 以上にする。
 */
const c4mValueArbitrary: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 1, maxLength: 24, size: "max" })
  .map((bytes) => C4M.encodeBase64Url(bytes));

/**
 * c4m 以外の parameter 名
 *
 * 値の解釈 (extractC4mBase64 / removeC4mParameter) は key が完全に `c4m` の parameter
 * だけを対象にするため、`c4m` 以外の名前を作る。`ac4m` のような紛らわしい名前は
 * 別の parameter として残る (伏せ字は逆に部分一致で潰すが、そちらは maskC4mValue の
 * 性質であり、ここで確かめる対象ではない)。
 */
const otherParameterNameArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
  .filter((name) => name !== "c4m");

/**
 * c4m の値として復号できない文字列
 *
 * Base64 のアルファベット (標準 / base64url) にもパディングにも無い `!` を必ず含める。
 * これで厳密な復号でも atob でも失敗する。値が無い c4m (空文字) も含める。
 */
const invalidC4mValueArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9+/]{0,4}![A-Za-z0-9+/]{0,4}$/),
  fc.constant(""),
);

/**
 * track-identifier
 *
 * `c4m=` を含む名前も作る。parameter-list は最初の `&` の後ろだけなので、
 * track-identifier の中の `c4m=` は c4m として扱わない (単体テストの 1 例を任意の値へ
 * 一般化する)。`&` は parameter の区切りであり、track-identifier には入れられない。
 */
const trackIdentifierArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  c4mValueArbitrary.map((value) => `c4m=${value}--catalog`),
);

/** msf fragment の parameter 1 つ */
type FragmentParameter =
  | { readonly kind: "c4m"; readonly value: string }
  | { readonly kind: "other"; readonly name: string; readonly value: string };

const fragmentParameterArbitrary: fc.Arbitrary<FragmentParameter> = fc.oneof(
  {
    weight: 1,
    arbitrary: c4mValueArbitrary.map((value) => ({ kind: "c4m" as const, value })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ name: otherParameterNameArbitrary, value: parameterValueArbitrary })
      .map(({ name, value }) => ({ kind: "other" as const, name, value })),
  },
);

/**
 * msf fragment の組み立て材料
 *
 * テキストだけでなく、期待値を組み立てるための要素も一緒に持ち回る (生成した入力を
 * 検証に使うため)。
 */
interface FragmentSpec {
  readonly trackIdentifier: string;
  readonly parameters: readonly FragmentParameter[];
  /** URL 全体 (`#` 付き) の形にするかどうか */
  readonly withUrlPrefix: boolean;
}

const fragmentSpecArbitrary: fc.Arbitrary<FragmentSpec> = fc.record({
  trackIdentifier: trackIdentifierArbitrary,
  parameters: fc.array(fragmentParameterArbitrary, { maxLength: 5, size: "max" }),
  withUrlPrefix: fc.boolean(),
});

/** URL 全体の形にするときの前置き (`#` を含む) */
const URL_PREFIX = "moqt://example.com/moqt#";

/** 材料から msf fragment (`msf:track&key=value&...`) を組み立てる */
function buildFragmentText(spec: FragmentSpec): string {
  const parameters = spec.parameters.map((parameter) =>
    parameter.kind === "c4m" ? `c4m=${parameter.value}` : `${parameter.name}=${parameter.value}`,
  );
  return `msf:${spec.trackIdentifier}${parameters.map((parameter) => `&${parameter}`).join("")}`;
}

/** 材料から入力 (URL 全体または fragment 単体) を組み立てる */
function buildInputText(spec: FragmentSpec): string {
  return spec.withUrlPrefix ? `${URL_PREFIX}${buildFragmentText(spec)}` : buildFragmentText(spec);
}

/** 材料に含まれる c4m の値 (parameter の順) */
function c4mValuesOf(spec: FragmentSpec): string[] {
  return spec.parameters.flatMap((parameter) =>
    parameter.kind === "c4m" ? [parameter.value] : [],
  );
}

/** 材料に含まれる c4m 以外の parameter (元の順) */
function otherParametersOf(spec: FragmentSpec): Array<{ name: string; value: string }> {
  return spec.parameters.flatMap((parameter) =>
    parameter.kind === "other" ? [{ name: parameter.name, value: parameter.value }] : [],
  );
}

/**
 * `msf:` で始まらない fragment を持つ入力
 *
 * c4m の値自体は妥当な Base64 にして「値が読めること」ではなく「fragment type が
 * msf であること」を見ていることを確かめる。
 */
const nonMsfInputArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("", "-", "moqt://example.com/moqt", "#track:video", "#msf", "#msf-"),
    c4mValueArbitrary,
  )
  .map(([prefix, value]) => `${prefix}&c4m=${value}`);

/**
 * msf fragment を持たない入力
 *
 * `#` が無い場合は入力全体を fragment とみなすため、`#` を含まない前置きと、`msf:` で
 * 始まらない fragment を組み合わせる。後半は `track:` fragment の形にして、c4m らしき
 * parameter を含んでいても取り除かれないことを確かめる。前置きに `#` を含めないことと
 * fragment が `msf:` で始まらないことは、入力の文法 (実装の JSDoc) から導く前提である。
 */
const noMsfFragmentInputArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[a-z:0-9.-]{0,16}$/),
    fc.oneof(
      fc.stringMatching(/^[a-z:&=0-9-]{0,12}$/),
      c4mValueArbitrary.map((value) => `track:video&c4m=${value}`),
    ),
    fc.boolean(),
  )
  .map(([head, fragment, withHash]) => (withHash ? `${head}#${fragment}` : fragment))
  .filter((input) => {
    const hashIndex = input.indexOf("#");
    const fragment = hashIndex === -1 ? input : input.slice(hashIndex + 1);
    return !fragment.startsWith("msf:");
  });

// 生成した材料から msf fragment を組み立て、c4m の値がそのまま取り出せることを確かめる。
// c4m は parameter-list (track-identifier の後ろ) にだけ現れるため、値は必ず 2 番目以降の
// parameter になる。c4m を複数置いた場合は最初の値を返す。
test("extractC4mBase64: 組み立てた msf fragment から最初の c4m を取り出す", () => {
  fc.assert(
    fc.property(fragmentSpecArbitrary, (spec) => {
      const values = c4mValuesOf(spec);
      const input = buildInputText(spec);

      if (values.length === 0) {
        // c4m を持たない msf fragment では undefined
        assert.equal(extractC4mBase64(input), undefined);
        return;
      }
      assert.equal(extractC4mBase64(input), values[0]);
    }),
  );
});

// fragment type が msf でない場合、c4m は予約 parameter ではないため取り出さない。
// 復号できない値と空の値も c4m として認めない (入力途中の値を渡しても例外を投げない)。
test("extractC4mBase64: msf でない fragment と復号できない c4m の値では undefined を返す", () => {
  fc.assert(
    fc.property(nonMsfInputArbitrary, (input) => {
      assert.equal(extractC4mBase64(input), undefined);
    }),
  );
  fc.assert(
    fc.property(invalidC4mValueArbitrary, (value) => {
      assert.equal(extractC4mBase64(`msf:room-123--catalog&c4m=${value}`), undefined);
      assert.equal(
        extractC4mBase64(`moqt://example.com/moqt#msf:room-123--catalog&c4m=${value}`),
        undefined,
      );
    }),
  );
});

// c4m を取り除いても track-identifier と他の parameter は元の順で残り、取り除いた結果から
// は c4m を取り出せない。c4m を複数含む入力や、c4m を 1 つも含まない入力も作る
// (含まない場合は期待値が入力そのものになり、変更しないことを確かめる)。
test("removeC4mParameter: c4m だけを取り除き、他の要素の順序を保つ", () => {
  fc.assert(
    fc.property(fragmentSpecArbitrary, (spec) => {
      const input = buildInputText(spec);
      const removed = removeC4mParameter(input);
      const others = otherParametersOf(spec);
      const removedFragment = `msf:${spec.trackIdentifier}${others
        .map((parameter) => `&${parameter.name}=${parameter.value}`)
        .join("")}`;
      const expected = spec.withUrlPrefix ? `${URL_PREFIX}${removedFragment}` : removedFragment;

      assert.equal(removed, expected);
      // 取り除いた結果から c4m は取り出せない (解除した URL をそのまま接続に使える)
      assert.equal(extractC4mBase64(removed), undefined);
      // 2 回かけても結果は変わらない
      assert.equal(removeC4mParameter(removed), removed);
    }),
  );
});

// msf fragment を持たない入力は変更しない。`c4m=` の出現を探すだけの実装だと、msf 以外の
// fragment や fragment の無い URL の parameter まで消えてしまう。
test("removeC4mParameter: msf fragment を持たない入力は変更しない", () => {
  fc.assert(
    fc.property(noMsfFragmentInputArbitrary, (input) => {
      assert.equal(removeC4mParameter(input), input);
    }),
  );
});

// ===== Base64 の復号 (decodeC4mBase64) =====

/** base64url のアルファベット (RFC 4648 Section 5) */
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 復号の往復に使うバイト列 (長い入力を含める) */
const decodeBytesArbitrary = fc.uint8Array({ maxLength: 48, size: "max" });

/** バイト列から標準 Base64 (パディング付き) の文字列を組み立てる */
function toStandardBase64(bytes: Uint8Array): string {
  const standard = C4M.encodeBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
  const remainder = standard.length % 4;
  return remainder === 0 ? standard : `${standard}${"=".repeat(4 - remainder)}`;
}

/**
 * 端数ビットが 0 でない base64url へ変える
 *
 * 最後の文字が持つ「余るビット」の最下位ビットを反転する。端数のビットは値に含まれない
 * ためバイト列は変わらないが、RFC 4648 Section 3.5 の正規形ではなくなる。
 */
function flipLastCharacterLowestBit(text: string): string {
  const last = text.charAt(text.length - 1);
  const value = BASE64_URL_ALPHABET.indexOf(last);
  return `${text.slice(0, -1)}${BASE64_URL_ALPHABET.charAt(value ^ 1)}`;
}

/** Base64 のアルファベット外の文字を含む入力 (厳密な復号でも atob でも失敗する) */
const undecodableTextArbitrary = fc.stringMatching(/^[A-Za-z0-9+/]{0,4}![A-Za-z0-9+/]{0,4}$/);

// c4m は URL では標準 Base64 (draft-ietf-moq-msf-01 §11.1.1)、トークンでは base64url
// (draft-ietf-moq-c4m-01 付録 A) で載る。パディングの有無を含め、どの表現でも同じ
// バイト列へ戻ることを確かめる。
test("decodeC4mBase64: base64url と標準 Base64 (パディング有無) は同じバイト列へ戻る", () => {
  fc.assert(
    fc.property(decodeBytesArbitrary, (bytes) => {
      const base64Url = C4M.encodeBase64Url(bytes);
      const standard = toStandardBase64(bytes);

      if (bytes.length === 0) {
        // 空文字は c4m の値として認められない (トークンが空になる)
        assert.equal(decodeC4mBase64(base64Url), undefined);
        assert.equal(decodeC4mBase64(standard), undefined);
        return;
      }
      assert.deepEqual(decodeC4mBase64(base64Url), bytes);
      assert.deepEqual(decodeC4mBase64(standard), bytes);
      assert.deepEqual(decodeC4mBase64(standard.replace(/=+$/, "")), bytes);
    }),
  );
});

// MSF の仕様例 (§11.1.1 の c4m の値) は端数ビットが 0 でない。厳密な規則では拒否されるが、
// atob は端数ビットを捨てて受理するため、値としては同じバイト列になる。
test("decodeC4mBase64: 端数ビットが 0 でない入力も同じバイト列へ復号する", () => {
  fc.assert(
    fc.property(
      decodeBytesArbitrary.filter((bytes) => bytes.length > 0 && bytes.length % 3 !== 0),
      (bytes) => {
        // 端数ビットが出るのは 3 の倍数でない長さのときだけ
        const nonCanonical = flipLastCharacterLowestBit(C4M.encodeBase64Url(bytes));

        // 厳密な規則では非正規なエンコードとして拒否される (緩い経路だけが受ける)
        assert.isUndefined(C4M.tryDecodeBase64OrUrl(nonCanonical));
        const decoded = decodeC4mBase64(nonCanonical);

        assert.deepEqual(decoded, bytes);
        if (decoded !== undefined) {
          // 正規形へ再エンコードした文字列の復号結果とも一致する
          assert.deepEqual(decodeC4mBase64(C4M.encodeBase64Url(decoded)), decoded);
        }
      },
    ),
  );
});

// 復号できない入力では undefined を返し、例外を投げない (入力途中の値を渡しても壊れない)。
test("decodeC4mBase64: 復号できない入力では undefined を返し、例外を投げない", () => {
  fc.assert(
    fc.property(undecodableTextArbitrary, (text) => {
      assert.equal(decodeC4mBase64(text), undefined);
    }),
  );
  // 1 文字は 6 ビットで 1 バイトに満たないため、4 の倍数 + 1 の長さは Base64 で表現できない
  fc.assert(
    fc.property(
      fc
        .array(fc.stringMatching(/^[A-Za-z0-9_-]{4}$/), { maxLength: 2, size: "max" })
        .map((chunks) => `${chunks.join("")}A`),
      (text) => {
        assert.equal(decodeC4mBase64(text), undefined);
      },
    ),
  );
  // 任意の文字列でも例外を投げない。復号できた場合は正規形へ再エンコードして戻せる
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 32, size: "max" }), (text) => {
      const bytes = decodeC4mBase64(text);

      if (bytes !== undefined && bytes.length > 0) {
        assert.deepEqual(decodeC4mBase64(C4M.encodeBase64Url(bytes)), bytes);
      }
    }),
  );
});

// ===== 発行したトークンからの情報抽出 (decodeC4mTokenInfo / extractC4mTrackNames) =====

/**
 * マッチのパターンに使う文字列
 *
 * `{a,b,c}` の 3 文字にする。ここでは claims に入れた値と表示の対応だけを見るため、
 * trim や `prefix:` の二重解釈を持ち込まない。
 */
const scopePatternArbitrary = fc.stringMatching(/^[abc]{1,16}$/, { size: "max" });

/** moqt スコープのアクション 1 つ (表にあるアクションと、表に無い番号) */
type ActionToken =
  | { readonly kind: "known"; readonly action: C4M.MoqtAction }
  | { readonly kind: "unknown"; readonly value: number };

const actionTokenArbitrary: fc.Arbitrary<ActionToken> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .constantFrom(...C4M.MOQT_ACTIONS)
      .map((action) => ({ kind: "known" as const, action })),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 9, max: 1_000 })
      .map((value) => ({ kind: "unknown" as const, value })),
  },
);

/** マッチ 1 つ (表示の書式へ戻す前の値) */
interface MatchToken {
  readonly type: "exact" | "prefix" | "suffix";
  readonly pattern: string;
}

const matchTokenArbitrary: fc.Arbitrary<MatchToken> = fc.record({
  type: fc.constantFrom<"exact" | "prefix" | "suffix">("exact", "prefix", "suffix"),
  pattern: scopePatternArbitrary,
});

/** 名前空間マッチ 1 つ (`end` は末尾にだけ置く) */
type NamespaceToken =
  | { readonly kind: "match"; readonly match: MatchToken }
  | { readonly kind: "end" };

const namespaceTokensArbitrary: fc.Arbitrary<NamespaceToken[]> = fc
  .tuple(fc.array(matchTokenArbitrary, { maxLength: 3, size: "max" }), fc.boolean())
  .map(([matches, withEnd]) => {
    const tokens: NamespaceToken[] = matches.map((match) => ({ kind: "match", match }));
    if (withEnd) {
      tokens.push({ kind: "end" });
    }
    return tokens;
  });

/** moqt スコープ 1 つ (claims へ入れる値と、表示の期待値を組み立てる材料) */
interface ScopeSpec {
  readonly actions: readonly ActionToken[];
  readonly namespace: readonly NamespaceToken[];
  readonly track: MatchToken | undefined;
}

const scopeSpecArbitrary: fc.Arbitrary<ScopeSpec> = fc
  .record({
    actions: fc.array(actionTokenArbitrary, { minLength: 1, maxLength: 3, size: "max" }),
    namespace: namespaceTokensArbitrary,
    track: fc.option(matchTokenArbitrary, { nil: undefined }),
  })
  // 名前空間マッチが無いスコープはトラックマッチを持てない (encodeMoqtScope が
  // trackWithoutNamespace で拒否する入力を作らない)
  .map(({ actions, namespace, track }) => ({
    actions,
    namespace,
    track: namespace.length === 0 ? undefined : track,
  }));

const SCOPE_TEXT_ENCODER = new TextEncoder();

/** 材料のマッチを claims の `Match` にする */
function buildMatch(token: MatchToken): C4M.Match {
  const pattern = SCOPE_TEXT_ENCODER.encode(token.pattern);
  switch (token.type) {
    case "exact":
      return C4M.exactMatch(pattern);
    case "prefix":
      return C4M.prefixMatch(pattern);
    default:
      return C4M.suffixMatch(pattern);
  }
}

/** 材料のスコープを claims の `MoqtScope` にする */
function buildScope(spec: ScopeSpec): C4M.MoqtScope {
  return {
    actions: spec.actions.map((token) =>
      token.kind === "known" ? C4M.moqtActionKey(token.action) : token.value,
    ),
    namespace: spec.namespace.map((token) =>
      token.kind === "end"
        ? C4M.namespaceMatchEnd()
        : C4M.namespaceMatchValue(buildMatch(token.match)),
    ),
    track: spec.track === undefined ? undefined : buildMatch(spec.track),
  };
}

/** マッチの表示 (draft-ietf-moq-c4m-01 Section 2.1 の書式: exact は素のパターン) */
function displayMatch(token: MatchToken): string {
  return token.type === "exact" ? token.pattern : `${token.type}:${token.pattern}`;
}

/**
 * アクションの表示名
 *
 * draft-ietf-moq-transport-22 のメッセージ名で出し、SETUP は 2 つの claim をまとめる。
 * 表に無い番号は数値の文字列になる。
 */
function displayAction(token: ActionToken): string {
  return token.kind === "known" ? C4M.moqtActionName(token.action) : String(token.value);
}

/** スコープの表示 (decodeC4mTokenInfo の scopes と同じ形) */
function displayScope(spec: ScopeSpec): { actions: string[]; namespace: string; track: string } {
  return {
    actions: spec.actions.map(displayAction),
    namespace:
      spec.namespace.length === 0
        ? "-"
        : spec.namespace
            .map((token) => (token.kind === "end" ? "end" : displayMatch(token.match)))
            .join(", "),
    track: spec.track === undefined ? "any" : displayMatch(spec.track),
  };
}

/**
 * クレームの秒 (UNIX 秒)
 *
 * 整数と端数の両方を含める。整数は CBOR の整数、端数は浮動小数点数として往復する
 * (どちらも値そのものが戻る範囲に限る)。
 */
const claimSecondsArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 4_102_444_800 }),
  fc.double({ min: 0, max: 4_102_444_800, noNaN: true, noDefaultInfinity: true }),
);

/** クレームのテキスト (UTF-8 として妥当な全 Unicode) */
const claimTextArbitrary = fc.string({ unit: "grapheme", maxLength: 12, size: "max" });

// 実際の CAT を発行し、claims に入れた値が表示用の情報としてそのまま取り出せることを
// 確かめる。署名は HMAC なので形式は COSE_Mac0、alg は HmacSha256 に固定される
// (draft-ietf-moq-c4m-01 §7.1.1 の Token Type 0x01)。
test("decodeC4mTokenInfo: 発行したトークンのクレームとスコープを表示用に取り出す", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        issuer: fc.option(claimTextArbitrary, { nil: undefined }),
        audience: fc.array(claimTextArbitrary, { maxLength: 3, size: "max" }),
        expiration: fc.option(claimSecondsArbitrary, { nil: undefined }),
        notBefore: fc.option(claimSecondsArbitrary, { nil: undefined }),
        issuedAt: fc.option(claimSecondsArbitrary, { nil: undefined }),
        scopes: fc.array(scopeSpecArbitrary, { minLength: 1, maxLength: 3, size: "max" }),
      }),
      async (values) => {
        const claims = C4M.createCatClaims();
        claims.issuer = values.issuer;
        claims.audience = values.audience;
        claims.expiration = values.expiration;
        claims.notBefore = values.notBefore;
        claims.issuedAt = values.issuedAt;
        claims.moqt = { scopes: values.scopes.map(buildScope) };
        const base64 = await buildCatWithClaims(claims);

        const info = decodeC4mTokenInfo(base64);

        assert.isDefined(info);
        if (info === undefined) {
          return;
        }
        assert.equal(info.format, "coseMac0");
        assert.equal(info.algorithm, "HmacSha256");
        assert.equal(info.issuer, values.issuer);
        // aud は複数を ", " で連結し、1 つも無い場合は undefined にする
        assert.equal(
          info.audience,
          values.audience.length > 0 ? values.audience.join(", ") : undefined,
        );
        // exp / nbf / iat は formatUnixTime の書式で出す (書式自体は claims.prop.ts で固定)
        assert.equal(
          info.expiration,
          values.expiration === undefined ? undefined : formatUnixTime(values.expiration),
        );
        assert.equal(
          info.notBefore,
          values.notBefore === undefined ? undefined : formatUnixTime(values.notBefore),
        );
        assert.equal(
          info.issuedAt,
          values.issuedAt === undefined ? undefined : formatUnixTime(values.issuedAt),
        );
        assert.deepEqual(info.scopes, values.scopes.map(displayScope));
        // exact な track だけが trackNames に入り、extractC4mTrackNames も同じ見解になる
        const expectedTrackNames = values.scopes.flatMap((scope) =>
          scope.track?.type === "exact" ? [scope.track.pattern] : [],
        );
        assert.deepEqual(info.trackNames, expectedTrackNames);
        assert.deepEqual(extractC4mTrackNames(base64), expectedTrackNames);
      },
    ),
  );
});

// exact な track name はスコープの順に取り出され、スコープの表示にもそのまま出る。
// namespace と actions は buildCatWithTrackNames が固定する値になる。
test("decodeC4mTokenInfo / extractC4mTrackNames: exact な track name を任意の名前で取り出す", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ unit: "grapheme", maxLength: 8, size: "max" }), {
        minLength: 1,
        maxLength: 4,
        size: "max",
      }),
      async (trackNames) => {
        const base64 = await buildCatWithTrackNames(trackNames);

        const info = decodeC4mTokenInfo(base64);

        assert.deepEqual(
          info?.scopes,
          trackNames.map((trackName) => ({
            actions: ["SUBSCRIBE", "PUBLISH"],
            namespace: "15551, spam, end",
            track: trackName,
          })),
        );
        assert.deepEqual(info?.trackNames, trackNames);
        assert.deepEqual(extractC4mTrackNames(base64), trackNames);
      },
    ),
  );
});

// 復号できない入力では undefined / 空配列を返す (入力途中の値を渡しても例外を投げない)。
test("decodeC4mTokenInfo / extractC4mTrackNames: 復号できない値では undefined と空配列を返す", () => {
  fc.assert(
    fc.property(invalidC4mValueArbitrary, (value) => {
      assert.isUndefined(decodeC4mTokenInfo(value));
      assert.deepEqual(extractC4mTrackNames(value), []);
    }),
  );
});

// 任意の入力で例外を投げず、trackNames の見解が 2 つの入口で一致する
// (extractC4mTrackNames は decodeC4mTokenInfo の trackNames の薄い入口)。
test("extractC4mTrackNames: 任意の入力で例外を投げず decodeC4mTokenInfo と一致する", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ unit: "binary", maxLength: 64, size: "max" }),
        decodeBytesArbitrary.map((bytes) => C4M.encodeBase64Url(bytes)),
      ),
      (text) => {
        const info = decodeC4mTokenInfo(text);

        assert.deepEqual(extractC4mTrackNames(text), info?.trackNames ?? []);
      },
    ),
  );
});
