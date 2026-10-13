/**
 * COSE (RFC 9052 / RFC 8392) の Property-Based Testing
 *
 * COSE_Sign1 / COSE_Mac0 について、次の性質を任意の入力で確認する。
 *
 * - 署名対象バイト列 (Sig_structure / MAC_structure) の構造と、種別・protected
 *   ヘッダ・ペイロードからの単射性
 * - COSE ヘッダのエンコード / デコードの往復
 * - protected / unprotected の分離 (重複ラベルの拒否と unprotected の非認証性)
 * - crit の fail-closed な検証
 * - メッセージの往復とタグの規則
 * - デコーダの全域性 (任意の入力で成功するか CoseError になるか)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type CborValue,
  cborArray,
  cborAsArray,
  cborAsBytes,
  cborAsInteger,
  cborAsText,
  cborByteString,
  cborEquals,
  cborInteger,
  cborMap,
  cborMapGet,
  cborNegative,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  decodeCborPartial,
  encodeCbor,
} from "./cbor";
import {
  C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID,
  type Algorithm,
  CoseError,
  type CoseErrorCode,
  type CoseHeader,
  type CoseKeyId,
  type CoseMessage,
  HEADER_ALGORITHM,
  HEADER_CONTENT_TYPE,
  HEADER_CRITICAL,
  HEADER_KEY_ID,
  HEADER_TYPE,
  TAG_COSE_MAC0,
  TAG_COSE_SIGN1,
  TAG_CWT,
  algorithmIdentifier,
  algorithmIsMac,
  coseKeyIdBytes,
  coseKeyIdText,
  coseMessageHeader,
  coseMessagePayload,
  coseMessageSignature,
  coseMessageSigningInput,
  createCoseHeader,
  decodeCoseMessage,
  decodeCoseMessageValue,
  decodeProtectedHeader,
  decodeUnprotectedHeader,
  encodeCoseHeader,
  encodeCoseMessage,
} from "./cose";
import { assertCoseError, cborValueArbitrary, encodeHex } from "./testSupport";
import { unreachableValue } from "./unreachable";

/** CBOR の符号なし整数の最大値 (RFC 8949 Section 3 の 8 バイトの引数) */
const MAX_CBOR_UNSIGNED = 18446744073709551615n;

/** デコーダへ与えるデータ項目のネスト深度の上限 */
const MAX_TEST_DEPTH = 3;

/** ヘッダの値に使うデータ項目のネスト深度の上限 */
const HEADER_VALUE_DEPTH = 2;

/** 任意のバイト列 (protected ヘッダ / ペイロード / 署名) */
const BYTES_ARBITRARY = fc.uint8Array({ maxLength: 48, size: "max" });

/**
 * CoseError が取り得るエラーコード (CoseErrorCode)
 *
 * 全域性の確認で、CoseError 以外の例外が漏れていないことに加えて、エラーコードが
 * 定義済みであることを確認するために使う。
 */
const COSE_ERROR_CODES: readonly CoseErrorCode[] = [
  "cbor",
  "unexpectedType",
  "invalidStructure",
  "missingAlgorithm",
  "unsupportedAlgorithm",
  "unsupportedCriticalHeader",
  "criticalHeaderNotPresent",
  "emptyCriticalHeader",
  "unprotectedCriticalHeader",
  "unprotectedTypeHeader",
  "unprotectedAlgorithm",
  "duplicateHeaderParameter",
  "algorithmClassMismatch",
  "detachedPayloadUnsupported",
];

/**
 * ヘッダのラベルとして解釈できる整数の集合
 *
 * RFC 9052 Section 3.1 の alg / crit / content type / kid と、RFC 9596 Section 2 の
 * typ (ラベル 16) である。
 */
const UNDERSTOOD_HEADER_LABELS: ReadonlySet<bigint> = new Set([
  HEADER_ALGORITHM,
  HEADER_CRITICAL,
  HEADER_CONTENT_TYPE,
  HEADER_KEY_ID,
  HEADER_TYPE,
]);

/**
 * アルゴリズムと識別子の組
 *
 * C4M ドラフトのテストベクタが使う -4 の別名も `algorithmFromIdentifierWithC4mDraftAlias`
 * が HMAC-SHA256 として受理するため含める。`algorithm` と `identifier` が常に整合する
 * 正規形のヘッダを生成するために使う。
 */
const ALGORITHM_IDENTIFIERS: ReadonlyArray<{ algorithm: Algorithm; identifier: number }> = [
  { algorithm: "HmacSha256", identifier: 5 },
  { algorithm: "HmacSha256", identifier: C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID },
  { algorithm: "HmacSha384", identifier: 6 },
  { algorithm: "HmacSha512", identifier: 7 },
  { algorithm: "Es256", identifier: -7 },
  { algorithm: "Es384", identifier: -35 },
  { algorithm: "Es512", identifier: -36 },
  { algorithm: "EdDsa", identifier: -8 },
];

/** アルゴリズムと識別子の組を生成する */
const ALGORITHM_IDENTIFIER_ARBITRARY: fc.Arbitrary<{ algorithm: Algorithm; identifier: number }> =
  fc.constantFrom(...ALGORITHM_IDENTIFIERS);

/** メッセージの種別 */
const MESSAGE_TYPE_ARBITRARY: fc.Arbitrary<"sign1" | "mac0"> = fc.constantFrom(
  ...(["sign1", "mac0"] as const),
);

/**
 * メッセージが持つタグの状態
 *
 * CWT タグ (61) は COSE タグ (17 / 18) が無いと前置できない (RFC 8392 Section 6) ため、
 * `cwtTagged` が true で `coseTagged` が false の状態は生成しない。
 */
const TAG_STATES: ReadonlyArray<{ coseTagged: boolean; cwtTagged: boolean }> = [
  { coseTagged: false, cwtTagged: false },
  { coseTagged: true, cwtTagged: false },
  { coseTagged: true, cwtTagged: true },
];

/** メッセージが持ち得るタグの状態を生成する */
const TAG_STATE_ARBITRARY: fc.Arbitrary<{ coseTagged: boolean; cwtTagged: boolean }> =
  fc.constantFrom(...TAG_STATES);

/**
 * バイト列を辞書順で比較する (RFC 8949 Section 4.2.1 の決定論的エンコードの順序)
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * 2 つのバイト列が同じ内容かどうかを返す
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

/**
 * ヘッダのラベルとして解釈できる整数かどうかを返す
 */
function isUnderstoodHeaderLabel(value: CborValue): boolean {
  const label = cborAsInteger(value);
  return label !== undefined && UNDERSTOOD_HEADER_LABELS.has(label);
}

/**
 * 決定論的エンコードで同じキーとみなされるかどうかを判定するための識別子
 *
 * encodeCbor / decodeCbor の重複キー判定はキーを正規化してから行うため、`-0.0` と
 * `0.0`、およびすべての NaN が同じキーになる (RFC 8949 Section 5.6.1)。同じ識別子の
 * キーを 2 つ含むマップは duplicateMapKey になるため、生成器はこの識別子で重複を除く。
 * マップのエントリーはエンコード時にキーのバイト列順へ並べ替えられるため、順序の違いは
 * 同一視する。
 */
function normalizedKeyIdentity(value: CborValue): string {
  switch (value.type) {
    case "unsigned":
      return `u:${String(value.value)}`;
    case "negative":
      return `n:${String(value.value)}`;
    case "byteString":
      return `b:${encodeHex(value.value)}`;
    case "textString":
      return `t:${value.value}`;
    case "array":
      return `a:[${value.value.map((item) => normalizedKeyIdentity(item)).join(",")}]`;
    case "map": {
      const entries = value.value.map(
        ([key, entry]) => `${normalizedKeyIdentity(key)}=>${normalizedKeyIdentity(entry)}`,
      );
      return `m:{${entries.sort().join(";")}}`;
    }
    case "tag":
      return `g:${String(value.tag)}(${normalizedKeyIdentity(value.value)})`;
    case "bool":
      return `o:${String(value.value)}`;
    case "null":
      return "o:null";
    case "undefined":
      return "o:undefined";
    case "float":
      return `f:${value.value === 0 ? "0" : String(value.value)}`;
    case "simple":
      return `s:${String(value.value)}`;
    default:
      return unreachableValue(value);
  }
}

/**
 * `raw` に置けるラベル (キー) を生成する
 *
 * RFC 9052 Section 1.5 のとおりラベルは整数かテキスト文字列 (int / tstr) である。
 * それ以外のラベルは実装が拒否するため生成しない。ラベル 1 / 2 / 3 / 4 / 16 は
 * ヘッダのデコードで解釈され `raw` からは取り除かれるため、こちらも除外する。
 */
const RAW_LABEL_ARBITRARY: fc.Arbitrary<CborValue> = fc
  .oneof(
    fc.bigInt({ min: 0n, max: MAX_CBOR_UNSIGNED }).map((value) => cborUnsigned(value)),
    fc.bigInt({ min: 0n, max: MAX_CBOR_UNSIGNED }).map((value) => cborNegative(value)),
    fc
      .string({ unit: "grapheme", maxLength: 8, size: "max" })
      .map((value) => cborTextString(value)),
  )
  .filter((value) => !isUnderstoodHeaderLabel(value));

/**
 * 理解できない整数ラベルを生成する
 */
const RAW_INTEGER_LABEL_ARBITRARY: fc.Arbitrary<bigint> = fc
  .bigInt({ min: 0n, max: MAX_CBOR_UNSIGNED })
  .filter((label) => !UNDERSTOOD_HEADER_LABELS.has(label));

/**
 * 整数として解釈できないラベル (テキスト文字列) を生成する
 *
 * RFC 9052 Section 1.5 のとおりラベルは整数かテキスト文字列である。整数以外の
 * ラベルはテキスト文字列だけであり、保護されたバケットに実在しても
 * `cborAsInteger` では解釈されない。
 */
const NON_INTEGER_LABEL_ARBITRARY: fc.Arbitrary<CborValue> = fc
  .string({ unit: "grapheme", maxLength: 8, size: "max" })
  .map((value) => cborTextString(value));

/**
 * 理解できないラベルを生成する (`crit` 用)
 */
const UNKNOWN_CRITICAL_LABEL_ARBITRARY: fc.Arbitrary<CborValue> = cborValueArbitrary(
  HEADER_VALUE_DEPTH,
).filter((value) => !isUnderstoodHeaderLabel(value));

/**
 * 理解できるが `crit` 以外のラベルを生成する
 */
const KNOWN_CRITICAL_LABEL_ARBITRARY: fc.Arbitrary<bigint> = fc.constantFrom(
  HEADER_ALGORITHM,
  HEADER_CONTENT_TYPE,
  HEADER_KEY_ID,
  HEADER_TYPE,
);

/**
 * `raw` に置ける (ラベル, 値) の組を生成する
 *
 * 値は任意の CBOR データ項目である。キーは決定論的エンコードで重複しないものに限る。
 */
const RAW_ENTRY_ARBITRARY: fc.Arbitrary<[CborValue, CborValue]> = fc.tuple(
  RAW_LABEL_ARBITRARY,
  cborValueArbitrary(HEADER_VALUE_DEPTH),
);

/**
 * `raw` に置ける (ラベル, 値) の組を重複なく生成する
 */
const RAW_ENTRIES_ARBITRARY: fc.Arbitrary<Array<[CborValue, CborValue]>> = fc.uniqueArray(
  RAW_ENTRY_ARBITRARY,
  {
    selector: (entry) => normalizedKeyIdentity(entry[0]),
    maxLength: 3,
    size: "max",
  },
);

/**
 * kid (ラベル 4) の値を作る
 *
 * RFC 9052 Section 3.1 はバイト文字列とするが、テキスト文字列を使う実装もあるため
 * 両方を生成する。
 */
const KEY_ID_ARBITRARY: fc.Arbitrary<CoseKeyId> = fc.oneof(
  fc.uint8Array({ maxLength: 24, size: "max" }).map((value) => coseKeyIdBytes(value)),
  fc.string({ unit: "grapheme", maxLength: 24, size: "max" }).map((value) => coseKeyIdText(value)),
);

/**
 * protected ヘッダに単独で置ける (ラベル, 値) の組を生成する
 *
 * protected ヘッダと unprotected ヘッダの重複ラベルを検証するとき、protected ヘッダ
 * 自体はデコードできなければならない。そのためラベルごとにデコードが受理する値だけを
 * 使う。crit (2) は単独では criticalHeaderNotPresent になるため含めない。
 */
const PROTECTED_ENTRY_ARBITRARY: fc.Arbitrary<[CborValue, CborValue]> = fc.oneof(
  // content type (3) と typ (16) は任意のデータ項目を値にできる
  fc
    .tuple(
      fc.constantFrom(HEADER_CONTENT_TYPE, HEADER_TYPE),
      cborValueArbitrary(HEADER_VALUE_DEPTH),
    )
    .map(([label, value]): [CborValue, CborValue] => [cborInteger(label), value]),
  // 解釈しない整数ラベルは raw として保持される
  RAW_INTEGER_LABEL_ARBITRARY.map((label): [CborValue, CborValue] => [
    cborInteger(label),
    cborUnsigned(1n),
  ]),
  // kid (4) はバイト文字列かテキスト文字列
  fc
    .oneof(
      fc.uint8Array({ maxLength: 8, size: "max" }).map((value) => cborByteString(value)),
      fc
        .string({ unit: "grapheme", maxLength: 8, size: "max" })
        .map((value) => cborTextString(value)),
    )
    .map((value): [CborValue, CborValue] => [cborInteger(HEADER_KEY_ID), value]),
  // alg (1) は対応するアルゴリズムの識別子
  ALGORITHM_IDENTIFIER_ARBITRARY.map((entry): [CborValue, CborValue] => [
    cborInteger(HEADER_ALGORITHM),
    cborInteger(entry.identifier),
  ]),
);

/**
 * unprotected ヘッダに置けるラベルを生成する
 *
 * alg (1) / crit (2) / typ (16) は unprotected ヘッダでは拒否されるため、生成器には
 * content type (3) と、解釈されないラベルだけを含める。
 */
const UNPROTECTED_LABEL_ARBITRARY: fc.Arbitrary<CborValue> = fc.oneof(
  fc.constant(cborInteger(HEADER_CONTENT_TYPE)),
  RAW_LABEL_ARBITRARY,
);

/**
 * unprotected ヘッダに置ける (ラベル, 値) の組を生成する
 *
 * 次のラベルはデコードが拒否するため生成器から除外する。
 *
 * - alg (1): protected ヘッダで認証されなければならない (RFC 9052 Section 3.1)
 * - crit (2): protected ヘッダに置かなければならない (RFC 9052 Section 3.1)
 * - typ (16): unprotected ヘッダに置けない (RFC 9596 Section 2)
 */
const UNPROTECTED_ENTRY_ARBITRARY: fc.Arbitrary<[CborValue, CborValue]> = fc.oneof(
  // content type (3) と解釈しないラベルは任意のデータ項目を値にできる
  fc
    .tuple(UNPROTECTED_LABEL_ARBITRARY, cborValueArbitrary(HEADER_VALUE_DEPTH))
    .map(([label, value]): [CborValue, CborValue] => [label, value]),
  // kid (4) はバイト文字列かテキスト文字列
  fc
    .oneof(
      fc.uint8Array({ maxLength: 8, size: "max" }).map((value) => cborByteString(value)),
      fc
        .string({ unit: "grapheme", maxLength: 8, size: "max" })
        .map((value) => cborTextString(value)),
    )
    .map((value): [CborValue, CborValue] => [cborInteger(HEADER_KEY_ID), value]),
);

/**
 * protected ヘッダが使っているラベルを返す
 *
 * unprotected ヘッダのラベルがこれらと重複すると、`coseMessageHeader` が
 * duplicateHeaderParameter で拒否する (RFC 9052 Section 3)。
 */
function headerUsedLabels(header: CoseHeader): CborValue[] {
  const labels: CborValue[] = header.raw.map(([key]) => key);
  if (header.algorithm !== undefined) {
    labels.push(cborInteger(HEADER_ALGORITHM));
  }
  if (header.keyId !== undefined) {
    labels.push(cborInteger(HEADER_KEY_ID));
  }
  if (header.contentType !== undefined) {
    labels.push(cborInteger(HEADER_CONTENT_TYPE));
  }
  if (header.typ !== undefined) {
    labels.push(cborInteger(HEADER_TYPE));
  }
  if (header.critical.length > 0) {
    labels.push(cborInteger(HEADER_CRITICAL));
  }
  labels.push(...header.critical);
  return labels;
}

/**
 * `usedLabels` と重複しない unprotected ヘッダのエントリーを生成する
 *
 * protected ヘッダが空の場合は `usedLabels` を空にして呼ぶ。
 */
function unprotectedEntriesArbitrary(
  usedLabels: readonly CborValue[],
): fc.Arbitrary<Array<[CborValue, CborValue]>> {
  return fc
    .uniqueArray(UNPROTECTED_ENTRY_ARBITRARY, {
      selector: (entry) => normalizedKeyIdentity(entry[0]),
      maxLength: 4,
      size: "max",
    })
    .filter((entries) =>
      entries.every(([key]) => !usedLabels.some((used) => cborEquals(used, key))),
    );
}

/**
 * COSE ヘッダの alg 以外のフィールドを生成する
 *
 * 正規形の条件は次のとおりである。
 *
 * - `algorithmIdentifier` は `algorithm` と整合する (省略時はエンコードが正準の値を補う)
 * - `keyId` はバイト列かテキスト
 * - `typ` / `contentType` は任意の CBOR データ項目
 * - `raw` はラベル 1 / 2 / 3 / 4 / 16 を含まず、決定論的エンコードで重複しない
 * - `critical` は理解できるラベルだけで、指すパラメータが protected ヘッダに実在する
 *   (RFC 9052 Section 3.1)
 *
 * @param algorithmArbitrary - `alg` の生成器。undefined を生成すると alg 無しになる
 */
function coseHeaderFieldsArbitrary(
  algorithmArbitrary: fc.Arbitrary<{ algorithm: Algorithm; identifier: number } | undefined>,
): fc.Arbitrary<CoseHeader> {
  return fc
    .record({
      algorithm: algorithmArbitrary,
      // algorithm が無いのに指定された識別子はエンコードで捨てられる (正規化)
      orphanIdentifier: fc.option(
        fc.constantFrom(...ALGORITHM_IDENTIFIERS.map((entry) => entry.identifier)),
        { nil: undefined },
      ),
      keyId: fc.option(KEY_ID_ARBITRARY, { nil: undefined }),
      typ: fc.option(cborValueArbitrary(HEADER_VALUE_DEPTH), { nil: undefined }),
      contentType: fc.option(cborValueArbitrary(HEADER_VALUE_DEPTH), { nil: undefined }),
      raw: RAW_ENTRIES_ARBITRARY,
    })
    .chain((base) => {
      // crit に列挙できるのは「理解でき、protected ヘッダに実在する」ラベルだけである
      const criticalLabels: CborValue[] = [cborInteger(HEADER_CRITICAL)];
      if (base.algorithm !== undefined) {
        criticalLabels.push(cborInteger(HEADER_ALGORITHM));
      }
      if (base.keyId !== undefined) {
        criticalLabels.push(cborInteger(HEADER_KEY_ID));
      }
      if (base.typ !== undefined) {
        criticalLabels.push(cborInteger(HEADER_TYPE));
      }
      if (base.contentType !== undefined) {
        criticalLabels.push(cborInteger(HEADER_CONTENT_TYPE));
      }
      return fc
        .subarray(criticalLabels, { minLength: 0, maxLength: criticalLabels.length })
        .map((critical): CoseHeader => ({
          algorithm: base.algorithm?.algorithm,
          algorithmIdentifier: base.algorithm?.identifier ?? base.orphanIdentifier,
          keyId: base.keyId,
          typ: base.typ,
          contentType: base.contentType,
          critical,
          raw: base.raw,
        }));
    });
}

/**
 * alg を持つ場合と持たない場合の両方がある正規形のヘッダを生成する
 */
function coseHeaderArbitrary(): fc.Arbitrary<CoseHeader> {
  return coseHeaderFieldsArbitrary(fc.option(ALGORITHM_IDENTIFIER_ARBITRARY, { nil: undefined }));
}

/**
 * エントリーを決定論的エンコードのキー順に並べ替える
 */
function sortedEntries(entries: Array<[CborValue, CborValue]>): Array<[CborValue, CborValue]> {
  return [...entries].sort((left, right) =>
    compareBytes(encodeCbor(left[0]), encodeCbor(right[0])),
  );
}

/**
 * ヘッダの往復で正規化される表現を期待値へ反映する
 *
 * `encodeCoseHeader` は次の正規化を行う。
 *
 * - `algorithmIdentifier` は `algorithm` があるときだけ出力する。省略時は
 *   `algorithmIdentifier(algorithm)` の正準の識別子を補い、`algorithm` が無ければ
 *   指定されていても出力しない
 * - マップは決定論的エンコードのキー順 (エンコード済みバイト列の昇順) に並ぶため、
 *   解釈しなかったパラメータ (`raw`) もその順で戻る
 */
function expectedHeaderAfterDecode(header: CoseHeader): CoseHeader {
  return {
    algorithm: header.algorithm,
    algorithmIdentifier:
      header.algorithm === undefined
        ? undefined
        : (header.algorithmIdentifier ?? algorithmIdentifier(header.algorithm)),
    keyId: header.keyId,
    typ: header.typ,
    contentType: header.contentType,
    critical: header.critical,
    raw: sortedEntries(header.raw),
  };
}

/**
 * alg の種別とメッセージの種別が整合する COSE メッセージを生成する
 *
 * alg は protected ヘッダに必ず置く。タグの無いメッセージでも種別を判別できるように
 * するためである (decodeCoseMessageValue)。種別は alg の種別から決めるため、常に
 * 整合する。
 */
const COSE_MESSAGE_ARBITRARY: fc.Arbitrary<CoseMessage> = ALGORITHM_IDENTIFIER_ARBITRARY.chain(
  (algorithmEntry) =>
    coseHeaderFieldsArbitrary(
      fc.constant<{ algorithm: Algorithm; identifier: number } | undefined>(algorithmEntry),
    ).chain((header) => {
      const protectedBytes = encodeCbor(encodeCoseHeader(header));
      return fc
        .record({
          unprotected: unprotectedEntriesArbitrary(headerUsedLabels(header)),
          payload: fc.option(fc.uint8Array({ maxLength: 32, size: "max" }), { nil: undefined }),
          signature: fc.uint8Array({ maxLength: 32, size: "max" }),
          tags: TAG_STATE_ARBITRARY,
        })
        .map((parts): CoseMessage => {
          if (algorithmIsMac(algorithmEntry.algorithm)) {
            return {
              type: "mac0",
              mac0: {
                protected: protectedBytes,
                unprotected: parts.unprotected,
                payload: parts.payload,
                tag: parts.signature,
                coseTagged: parts.tags.coseTagged,
                cwtTagged: parts.tags.cwtTagged,
              },
            };
          }
          return {
            type: "sign1",
            sign1: {
              protected: protectedBytes,
              unprotected: parts.unprotected,
              payload: parts.payload,
              signature: parts.signature,
              coseTagged: parts.tags.coseTagged,
              cwtTagged: parts.tags.cwtTagged,
            },
          };
        });
    }),
);

/**
 * 種別に依存しないメッセージの構成要素を取り出す
 */
function messageParts(message: CoseMessage): {
  protected: Uint8Array;
  unprotected: Array<[CborValue, CborValue]>;
  payload: Uint8Array | undefined;
  signature: Uint8Array;
  coseTagged: boolean;
  cwtTagged: boolean;
} {
  const container = message.type === "sign1" ? message.sign1 : message.mac0;
  return {
    protected: container.protected,
    unprotected: container.unprotected,
    payload: coseMessagePayload(message),
    signature: coseMessageSignature(message),
    coseTagged: container.coseTagged,
    cwtTagged: container.cwtTagged,
  };
}

/**
 * 往復の比較用に、メッセージの構成要素を正規形へ揃える
 *
 * unprotected ヘッダは決定論的エンコードのキー順に並べ替えられて戻るため、比較の前に
 * エンコード済みキーのバイト列で並べ替える。
 */
function normalizedMessageParts(message: CoseMessage): {
  type: "sign1" | "mac0";
  protected: Uint8Array;
  unprotected: Array<[CborValue, CborValue]>;
  payload: Uint8Array | undefined;
  signature: Uint8Array;
  coseTagged: boolean;
  cwtTagged: boolean;
} {
  const parts = messageParts(message);
  return {
    type: message.type,
    protected: parts.protected,
    unprotected: sortedEntries(parts.unprotected),
    payload: parts.payload,
    signature: parts.signature,
    coseTagged: parts.coseTagged,
    cwtTagged: parts.cwtTagged,
  };
}

/**
 * メッセージが持つタグの状態を返す
 */
function messageTagState(message: CoseMessage): { coseTagged: boolean; cwtTagged: boolean } {
  const container = message.type === "sign1" ? message.sign1 : message.mac0;
  return { coseTagged: container.coseTagged, cwtTagged: container.cwtTagged };
}

/**
 * タグの状態だけを差し替えたメッセージを返す
 */
function withMessageTags(
  message: CoseMessage,
  coseTagged: boolean,
  cwtTagged: boolean,
): CoseMessage {
  if (message.type === "sign1") {
    return { type: "sign1", sign1: { ...message.sign1, coseTagged, cwtTagged } };
  }
  return { type: "mac0", mac0: { ...message.mac0, coseTagged, cwtTagged } };
}

/**
 * 指定した protected / unprotected ヘッダを持つ COSE_Sign1 を作る
 *
 * ヘッダの検証だけを目的とするため、ペイロードと署名は空にする。
 */
function sign1MessageWithHeader(
  protectedBytes: Uint8Array,
  unprotected: Array<[CborValue, CborValue]>,
): CoseMessage {
  return {
    type: "sign1",
    sign1: {
      protected: protectedBytes,
      unprotected,
      payload: new Uint8Array(0),
      signature: new Uint8Array(0),
      coseTagged: false,
      cwtTagged: false,
    },
  };
}

/**
 * 指定した種別・protected ヘッダ・ペイロードの署名対象バイト列を組み立てる
 *
 * 署名対象バイト列は protected ヘッダとペイロードだけで決まる (RFC 9052 Section 4.4 /
 * Section 6.3)。この関数は protected ヘッダの中身を解釈しないため、任意のバイト列を
 * 渡せる。
 */
function messageSigningInput(
  type: "sign1" | "mac0",
  protectedBytes: Uint8Array,
  payload: Uint8Array,
  unprotected: Array<[CborValue, CborValue]> = [],
  coseTagged = false,
  cwtTagged = false,
): Uint8Array {
  if (type === "sign1") {
    return coseMessageSigningInput({
      type: "sign1",
      sign1: {
        protected: protectedBytes,
        unprotected,
        payload,
        signature: new Uint8Array(0),
        coseTagged,
        cwtTagged,
      },
    });
  }
  return coseMessageSigningInput({
    type: "mac0",
    mac0: {
      protected: protectedBytes,
      unprotected,
      payload,
      tag: new Uint8Array(0),
      coseTagged,
      cwtTagged,
    },
  });
}

/**
 * 署名対象バイト列を CBOR の 4 要素の配列としてデコードする
 *
 * RFC 9052 Section 4.4 の `Sig_structure` と Section 6.3 の `MAC_structure` は、どちらも
 * `[コンテキスト文字列, protected, external_aad, payload]` の 4 要素である。
 */
function decodeSigningInputItems(input: Uint8Array): CborValue[] {
  const items = cborAsArray(decodeCbor(input));
  if (items === undefined || items.length !== 4) {
    throw new Error("署名対象バイト列は CBOR の 4 要素の配列でなければならない");
  }
  return items;
}

/**
 * 配列の位置からデータ項目を取り出す
 *
 * 要素数は `decodeSigningInputItems` で確認済みである。
 */
function elementAt(items: CborValue[], index: number): CborValue {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`署名対象バイト列の要素 ${String(index)} が存在しない`);
  }
  return item;
}

/**
 * デコーダが成功するか CoseError を投げるかのいずれかであることを確認する
 *
 * CoseError 以外の例外 (RangeError など) が漏れていないことと、エラーコードが
 * `CoseErrorCode` のいずれかであることを確認する。
 */
function assertDecoderOutcome(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CoseError, `CoseError を期待したが ${String(error)} が送出された`);
    assert.include(COSE_ERROR_CODES, error.code);
  }
}

test("署名対象バイト列は Sig_structure / MAC_structure の 4 要素になる", () => {
  fc.assert(
    fc.property(
      MESSAGE_TYPE_ARBITRARY,
      BYTES_ARBITRARY,
      BYTES_ARBITRARY,
      (type, protectedBytes, payload) => {
        const items = decodeSigningInputItems(messageSigningInput(type, protectedBytes, payload));
        // [0] はコンテキスト文字列である (RFC 9052 Section 4.4 / Section 6.3)
        assert.equal(cborAsText(elementAt(items, 0)), type === "sign1" ? "Signature1" : "MAC0");
        // [1] は署名対象になる protected ヘッダそのものである
        assert.deepEqual(cborAsBytes(elementAt(items, 1)), protectedBytes);
        // [2] は external_aad で、本実装は常に空のバイト文字列にする
        assert.deepEqual(cborAsBytes(elementAt(items, 2)), new Uint8Array(0));
        // [3] はペイロードそのものである
        assert.deepEqual(cborAsBytes(elementAt(items, 3)), payload);
      },
    ),
  );
});

test("署名対象バイト列はタグの有無に影響されない", () => {
  fc.assert(
    fc.property(
      MESSAGE_TYPE_ARBITRARY,
      BYTES_ARBITRARY,
      BYTES_ARBITRARY,
      TAG_STATE_ARBITRARY,
      (type, protectedBytes, payload, tags) => {
        // COSE タグ (17 / 18) と CWT タグ (61) は署名対象バイト列に含まれない
        const untagged = messageSigningInput(type, protectedBytes, payload);
        const tagged = messageSigningInput(
          type,
          protectedBytes,
          payload,
          [],
          tags.coseTagged,
          tags.cwtTagged,
        );
        assert.deepEqual(tagged, untagged);
      },
    ),
  );
});

test("署名対象バイト列は種別・protected ヘッダ・ペイロードから単射に決まる", () => {
  fc.assert(
    fc.property(
      MESSAGE_TYPE_ARBITRARY,
      BYTES_ARBITRARY,
      BYTES_ARBITRARY,
      MESSAGE_TYPE_ARBITRARY,
      BYTES_ARBITRARY,
      BYTES_ARBITRARY,
      (type1, protected1, payload1, type2, protected2, payload2) => {
        const input1 = messageSigningInput(type1, protected1, payload1);
        const input2 = messageSigningInput(type2, protected2, payload2);
        if (!bytesEqual(input1, input2)) {
          return;
        }
        // 同じ署名対象バイト列になるのは、種別・protected ヘッダ・ペイロードが
        // すべて同じ場合だけである
        assert.equal(type1, type2);
        assert.deepEqual(protected1, protected2);
        assert.deepEqual(payload1, payload2);
      },
    ),
  );
});

test("種別だけが違うメッセージの署名対象バイト列は必ず異なる", () => {
  fc.assert(
    fc.property(BYTES_ARBITRARY, BYTES_ARBITRARY, (protectedBytes, payload) => {
      // コンテキスト文字列 ("Signature1" / "MAC0") が異なるため、種別が違えば
      // 必ず別のバイト列になる (ドメイン分離)
      const sign1Input = messageSigningInput("sign1", protectedBytes, payload);
      const mac0Input = messageSigningInput("mac0", protectedBytes, payload);
      assert.ok(!bytesEqual(sign1Input, mac0Input), "種別が違うのに同じバイト列になった");
    }),
  );
});

test("正規形のヘッダは protected ヘッダとして往復する", () => {
  fc.assert(
    fc.property(coseHeaderArbitrary(), (header) => {
      // 受信側と同じ手順 (CBOR バイト列にしてからヘッダを解釈する) で往復させる
      const encoded = encodeCbor(encodeCoseHeader(header));
      const decoded = decodeProtectedHeader(decodeCbor(encoded));
      assert.deepEqual(decoded, expectedHeaderAfterDecode(header));
    }),
  );
});

test("protected と unprotected に同じ整数ラベルがあると拒否する", () => {
  fc.assert(
    fc.property(
      PROTECTED_ENTRY_ARBITRARY,
      cborValueArbitrary(HEADER_VALUE_DEPTH),
      (entry, unprotectedValue) => {
        const protectedBytes = encodeCbor(cborMap([entry]));
        const unprotected: Array<[CborValue, CborValue]> = [[entry[0], unprotectedValue]];
        // RFC 9052 Section 3 は同じラベルが両方のバケットに現れないことを検証する
        // SHOULD を定め、本実装は拒否する
        assertCoseError(
          () => coseMessageHeader(sign1MessageWithHeader(protectedBytes, unprotected)),
          "duplicateHeaderParameter",
          cborAsInteger(entry[0]),
        );
      },
    ),
  );
});

test("protected と unprotected に同じ非整数ラベルがあると拒否する", () => {
  fc.assert(
    fc.property(NON_INTEGER_LABEL_ARBITRARY, (label) => {
      // ラベルが整数でない場合はヘッダパラメータとして解釈できないため invalidStructure
      const protectedBytes = encodeCbor(cborMap([[label, cborUnsigned(1n)]]));
      const unprotected: Array<[CborValue, CborValue]> = [[label, cborUnsigned(2n)]];
      const error = assertCoseError(
        () => coseMessageHeader(sign1MessageWithHeader(protectedBytes, unprotected)),
        "invalidStructure",
      );
      assert.equal(typeof error.detail, "string");
    }),
  );
});

test("protected が空のときは重複判定が起きない", () => {
  fc.assert(
    fc.property(unprotectedEntriesArbitrary([]), (unprotected) => {
      // protected ヘッダが空の場合、unprotected のどのラベルも重複しない
      const header = coseMessageHeader(sign1MessageWithHeader(new Uint8Array(0), unprotected));
      assert.equal(header.algorithm, undefined);
      assert.equal(header.typ, undefined);
      assert.equal(header.critical.length, 0);
      // kid と content type は unprotected から統合され、それ以外は raw に残る
      const hasKeyId = unprotected.some(([key]) => cborAsInteger(key) === HEADER_KEY_ID);
      const hasContentType = unprotected.some(
        ([key]) => cborAsInteger(key) === HEADER_CONTENT_TYPE,
      );
      assert.equal(header.keyId !== undefined, hasKeyId);
      assert.equal(header.contentType !== undefined, hasContentType);
      assert.equal(
        header.raw.length,
        unprotected.length - (hasKeyId ? 1 : 0) - (hasContentType ? 1 : 0),
      );
    }),
  );
});

test("crit に理解できないラベルを列挙すると拒否する", () => {
  fc.assert(
    fc.property(UNKNOWN_CRITICAL_LABEL_ARBITRARY, (label) => {
      // RFC 9052 Section 3.1 は理解できないラベルを crit が指す場合を致命的エラーとする
      const value = cborMap([[cborInteger(HEADER_CRITICAL), cborArray([label])]]);
      assertCoseError(() => decodeProtectedHeader(value), "unsupportedCriticalHeader");
    }),
  );
});

test("crit が指すラベルが protected に無いと拒否する", () => {
  fc.assert(
    fc.property(RAW_ENTRY_ARBITRARY, KNOWN_CRITICAL_LABEL_ARBITRARY, (rawEntry, label) => {
      // 理解できるラベルでも protected ヘッダに実在しなければ致命的エラーである
      const value = cborMap([
        rawEntry,
        [cborInteger(HEADER_CRITICAL), cborArray([cborInteger(label)])],
      ]);
      assertCoseError(() => decodeProtectedHeader(value), "criticalHeaderNotPresent");
    }),
  );
});

test("crit を unprotected に置くと拒否する", () => {
  fc.assert(
    fc.property(cborValueArbitrary(HEADER_VALUE_DEPTH), (critValue) => {
      // 値の型に関わらず、crit は protected ヘッダに置かなければならない
      assertCoseError(
        () => decodeUnprotectedHeader(cborMap([[cborInteger(HEADER_CRITICAL), critValue]])),
        "unprotectedCriticalHeader",
      );
      // メッセージの unprotected ヘッダ経由でも同じ規則で拒否する
      const unprotected: Array<[CborValue, CborValue]> = [
        [cborInteger(HEADER_CRITICAL), critValue],
      ];
      assertCoseError(
        () => coseMessageHeader(sign1MessageWithHeader(new Uint8Array(0), unprotected)),
        "unprotectedCriticalHeader",
      );
    }),
  );
});

test("空の crit 配列は拒否し、エンコードでは crit なしとして扱う", () => {
  // RFC 9052 Section 3.1 は crit の配列に 1 つ以上のラベルを求める
  const empty = cborMap([[cborInteger(HEADER_CRITICAL), cborArray([])]]);
  assertCoseError(() => decodeProtectedHeader(empty), "emptyCriticalHeader");

  // エンコード側は空の配列を「crit を指定しない」として扱う (createCoseHeader の既定値)。
  // crit パラメータ自体を出力しないため、自分自身が読めないヘッダは作らない
  const encoded = encodeCoseHeader(createCoseHeader());
  assert.equal(cborMapGet(encoded, cborInteger(HEADER_CRITICAL)), undefined);
  assert.deepEqual(decodeProtectedHeader(encoded), createCoseHeader());
});

test("ヘッダのエンコードでも crit の規則を検証する", () => {
  fc.assert(
    fc.property(UNKNOWN_CRITICAL_LABEL_ARBITRARY, RAW_ENTRIES_ARBITRARY, (label, raw) => {
      // 理解できないラベルはエンコードでも拒否する
      const header: CoseHeader = { ...createCoseHeader(), critical: [label], raw };
      assertCoseError(() => encodeCoseHeader(header), "unsupportedCriticalHeader");
    }),
  );

  fc.assert(
    fc.property(KNOWN_CRITICAL_LABEL_ARBITRARY, RAW_ENTRIES_ARBITRARY, (label, raw) => {
      // 理解できるラベルでも protected ヘッダに無ければ拒否する
      const header: CoseHeader = {
        ...createCoseHeader(),
        critical: [cborInteger(label)],
        raw,
      };
      assertCoseError(() => encodeCoseHeader(header), "criticalHeaderNotPresent");
    }),
  );

  // crit は protected 専用であるため、エンコードした protected ヘッダを unprotected と
  // して解釈させると拒否する (受信側と同じく CBOR バイト列にしてから解釈する)
  const withCritical: CoseHeader = {
    ...createCoseHeader(),
    typ: cborTextString("CAT"),
    critical: [cborInteger(HEADER_TYPE)],
  };
  assertCoseError(
    () => decodeUnprotectedHeader(decodeCbor(encodeCbor(encodeCoseHeader(withCritical)))),
    "unprotectedCriticalHeader",
  );
});

test("メッセージは protected / unprotected / payload / 署名を保って往復する", () => {
  fc.assert(
    fc.property(COSE_MESSAGE_ARBITRARY, (message) => {
      // メッセージ自身のタグの状態だけで往復させる (オプションではタグを足さない)
      const decoded = decodeCoseMessage(
        encodeCoseMessage(message, { coseTag: false, cwtTag: false }),
      );
      assert.deepEqual(normalizedMessageParts(decoded), normalizedMessageParts(message));
    }),
  );
});

test("既定のエンコードオプションでは CWT タグと COSE タグが付く", () => {
  fc.assert(
    fc.property(COSE_MESSAGE_ARBITRARY, (message) => {
      const bytes = encodeCoseMessage(message);
      const decoded = decodeCoseMessage(bytes);
      const tags = messageTagState(decoded);
      assert.equal(decoded.type, message.type);
      // タグを持たないメッセージでも、既定のオプションで両方のタグが付く
      assert.equal(tags.coseTagged, true);
      assert.equal(tags.cwtTagged, true);
      // 外側が CWT タグ (61)、内側が COSE タグ (17 / 18) になる (RFC 8392 Section 6)
      const value = decodeCborPartial(bytes).value;
      assert.equal(value.type, "tag");
      if (value.type !== "tag") {
        assert.fail("CWT タグを期待した");
      }
      assert.equal(value.tag, TAG_CWT);
      assert.equal(value.value.type, "tag");
      if (value.value.type !== "tag") {
        assert.fail("COSE タグを期待した");
      }
      assert.equal(value.value.tag, message.type === "sign1" ? TAG_COSE_SIGN1 : TAG_COSE_MAC0);
    }),
  );
});

test("CWT タグだけを付けるエンコードは拒否する", () => {
  fc.assert(
    fc.property(COSE_MESSAGE_ARBITRARY, (message) => {
      // RFC 8392 Section 6: CWT タグは COSE のタグ付きオブジェクトにだけ前置できる
      for (const cwtTagged of [false, true]) {
        const untagged = withMessageTags(message, false, cwtTagged);
        assertCoseError(
          () => encodeCoseMessage(untagged, { coseTag: false, cwtTag: true }),
          "invalidStructure",
        );
      }
    }),
  );
});

test("デコーダは任意の入力で成功するか CoseError を投げる", () => {
  // 任意のバイト列は CBOR としても COSE としても不正になり得る
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64, size: "max" }), (bytes) => {
      assertDecoderOutcome(() => decodeCoseMessage(bytes));
    }),
  );

  // 任意のデータ項目は COSE の構造として不正になり得る
  fc.assert(
    fc.property(cborValueArbitrary(MAX_TEST_DEPTH), (value) => {
      assertDecoderOutcome(() => decodeCoseMessageValue(value));
      assertDecoderOutcome(() => decodeProtectedHeader(value));
      assertDecoderOutcome(() => decodeUnprotectedHeader(value));
    }),
  );
});

test("署名対象バイト列は unprotected ヘッダの影響を受けない", () => {
  fc.assert(
    fc.property(
      MESSAGE_TYPE_ARBITRARY,
      BYTES_ARBITRARY,
      BYTES_ARBITRARY,
      fc.array(fc.tuple(cborValueArbitrary(1), cborValueArbitrary(1)), {
        maxLength: 3,
        size: "max",
      }),
      (type, protectedBytes, payload, unprotected) => {
        // RFC 9052 Section 4.4 / Section 6.3 の Sig_structure / MAC_structure は protected
        // ヘッダとペイロードだけを対象にする。unprotected ヘッダは署名 / MAC の対象外で
        // あり、途中で書き換えられても検出できない
        //
        // したがって kid を unprotected ヘッダから読む利用側は protected ヘッダの kid だけを
        // 信用しなければならない。`coseMessageHeader` は unprotected の kid も統合して返すが、
        // それは保護されていない値である (keyId の選択に使う場合は特に注意する)
        const withUnprotected = messageSigningInput(type, protectedBytes, payload, unprotected);
        const withoutUnprotected = messageSigningInput(type, protectedBytes, payload);
        assert.deepEqual(withUnprotected, withoutUnprotected);
      },
    ),
  );
});
