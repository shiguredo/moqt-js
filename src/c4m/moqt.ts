/**
 * C4M の `moqt` / `moqt-reval` / `catdpop` クレーム
 *
 * draft-ietf-moq-c4m-01 Section 2.1 のアクションとスコープ、Section 2.2 の
 * `moqt-reval`、Section 3.1.1 の `catdpop` を扱う。クレームキーは
 * IANA の CWT Claims レジストリと付録 A のテストベクタに従う。
 *
 * このモジュールは I/O も時計も持たない。
 */

import { unreachableValue } from "./unreachable";

import {
  CBOR_NULL,
  type CborValue,
  cborArray,
  cborAsArray,
  cborAsBytes,
  cborAsInt64,
  cborAsMap,
  cborAsNumber,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
} from "./cbor";

/**
 * `moqt` クレームの claim key
 *
 * draft-ietf-moq-c4m-01 付録 A.5 のテストベクタが使う値 (327) を採用する。本文の
 * IANA Considerations は TBD_MOQT のままであり、確定したら追従する。
 */
export const CLAIM_MOQT = 327;

/**
 * `moqt-reval` クレームの claim key
 *
 * draft-ietf-moq-c4m-01 付録 A.5 のテストベクタが使う値 (328) を採用する。
 */
export const CLAIM_MOQT_REVAL = 328;

/**
 * `bin-match` の prefix マッチを表す match-type (draft-ietf-moq-c4m-01 Section 2.1)
 */
export const MATCH_TYPE_PREFIX = 1;

/**
 * `bin-match` の suffix マッチを表す match-type (draft-ietf-moq-c4m-01 Section 2.1)
 */
export const MATCH_TYPE_SUFFIX = 2;

/**
 * MOQT のアクション (draft-ietf-moq-c4m-01 Section 2.1 Table 1)
 */
export type MoqtAction =
  | "ClientSetup"
  | "ServerSetup"
  | "PublishNamespace"
  | "SubscribeNamespace"
  | "Subscribe"
  | "RequestUpdate"
  | "Publish"
  | "Fetch"
  | "TrackStatus";

/**
 * すべてのアクション (Table 1 の順)
 */
export const MOQT_ACTIONS: readonly MoqtAction[] = [
  "ClientSetup",
  "ServerSetup",
  "PublishNamespace",
  "SubscribeNamespace",
  "Subscribe",
  "RequestUpdate",
  "Publish",
  "Fetch",
  "TrackStatus",
];

/**
 * `moqt` クレームのアクション整数を返す (Table 1)
 */
export function moqtActionKey(action: MoqtAction): number {
  switch (action) {
    case "ClientSetup":
      return 0;
    case "ServerSetup":
      return 1;
    case "PublishNamespace":
      return 2;
    case "SubscribeNamespace":
      return 3;
    case "Subscribe":
      return 4;
    case "RequestUpdate":
      return 5;
    case "Publish":
      return 6;
    case "Fetch":
      return 7;
    case "TrackStatus":
      return 8;
    default:
      return unreachableValue(action);
  }
}

/**
 * アクション整数からアクションを返す
 */
export function moqtActionFromKey(key: number): MoqtAction | undefined {
  switch (key) {
    case 0:
      return "ClientSetup";
    case 1:
      return "ServerSetup";
    case 2:
      return "PublishNamespace";
    case 3:
      return "SubscribeNamespace";
    case 4:
      return "Subscribe";
    case 5:
      return "RequestUpdate";
    case 6:
      return "Publish";
    case 7:
      return "Fetch";
    case 8:
      return "TrackStatus";
    default:
      return undefined;
  }
}

/**
 * MOQT のメッセージ名を返す (ログとデバッグ用)
 */
export function moqtActionName(action: MoqtAction): string {
  switch (action) {
    case "ClientSetup":
      return "CLIENT_SETUP";
    case "ServerSetup":
      return "SERVER_SETUP";
    case "PublishNamespace":
      return "PUBLISH_NAMESPACE";
    case "SubscribeNamespace":
      return "SUBSCRIBE_NAMESPACE";
    case "Subscribe":
      return "SUBSCRIBE";
    case "RequestUpdate":
      return "REQUEST_UPDATE";
    case "Publish":
      return "PUBLISH";
    case "Fetch":
      return "FETCH";
    case "TrackStatus":
      return "TRACK_STATUS";
    default:
      return unreachableValue(action);
  }
}

/**
 * DPoP の Authorization Context で使うアクション識別子を返す (Table 2)
 */
export function moqtAuthorizationContext(action: MoqtAction): string {
  switch (action) {
    case "ClientSetup":
    case "ServerSetup":
      return "SETUP";
    case "PublishNamespace":
      return "PUB_NS";
    case "SubscribeNamespace":
      return "SUB_NS";
    case "Subscribe":
      return "SUBSCRIBE";
    case "RequestUpdate":
      return "REQ_UPDATE";
    case "Publish":
      return "PUBLISH";
    case "Fetch":
      return "FETCH";
    case "TrackStatus":
      return "TRK_STATUS";
    default:
      return unreachableValue(action);
  }
}

/**
 * アクションが Authorization Context のアクション識別子と一致するかを返す
 *
 * CLIENT_SETUP と SERVER_SETUP はどちらも `"SETUP"` を使う (Table 2)。
 */
export function moqtActionMatchesAuthorizationContext(action: MoqtAction, value: string): boolean {
  return moqtAuthorizationContext(action) === value;
}

/**
 * `bin-match` (draft-ietf-moq-c4m-01 Section 2.1)
 *
 * バイト文字列は完全一致、`[match-type, match-value]` は prefix / suffix マッチを
 * 表す。マッチはバイト単位で行い、正規化はしない。
 */
export type Match =
  | { readonly type: "exact"; readonly pattern: Uint8Array }
  | { readonly type: "prefix"; readonly pattern: Uint8Array }
  | { readonly type: "suffix"; readonly pattern: Uint8Array };

/**
 * 完全一致の `bin-match` を作る
 */
export function exactMatch(pattern: Uint8Array): Match {
  return { type: "exact", pattern };
}

/**
 * 前方一致の `bin-match` を作る
 */
export function prefixMatch(pattern: Uint8Array): Match {
  return { type: "prefix", pattern };
}

/**
 * 後方一致の `bin-match` を作る
 */
export function suffixMatch(pattern: Uint8Array): Match {
  return { type: "suffix", pattern };
}

/**
 * バイト列が prefix で始まるかどうかを返す
 */
function bytesStartsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index++) {
    if (value[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

/**
 * バイト列が suffix で終わるかどうかを返す
 */
function bytesEndsWith(value: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.length > value.length) {
    return false;
  }
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index++) {
    if (value[offset + index] !== suffix[index]) {
      return false;
    }
  }
  return true;
}

/**
 * 値がマッチするかどうかを返す
 */
export function matchMatches(match: Match, value: Uint8Array): boolean {
  switch (match.type) {
    case "exact":
      return bytesEqual(match.pattern, value);
    case "prefix":
      return bytesStartsWith(value, match.pattern);
    case "suffix":
      return bytesEndsWith(value, match.pattern);
    default:
      return unreachableValue(match);
  }
}

/**
 * 2 つのバイト列が等しいかどうかを返す
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * `bin-match` をデコードする
 */
export function decodeMatch(value: CborValue): Match {
  if (value.type === "byteString") {
    return exactMatch(value.value);
  }
  const items = cborAsArray(value);
  if (items === undefined) {
    throw new C4mError("unexpectedType", "bin-match");
  }
  if (items.length !== 2) {
    throw new C4mError("invalidMatchArrayLength", items.length);
  }
  const matchType = cborAsInt64(items[0] ?? CBOR_NULL);
  if (matchType === undefined) {
    throw new C4mError("unexpectedType", "match-type");
  }
  const pattern = cborAsBytes(items[1] ?? CBOR_NULL);
  if (pattern === undefined) {
    throw new C4mError("unexpectedType", "match-value");
  }
  if (matchType === BigInt(MATCH_TYPE_PREFIX)) {
    return prefixMatch(pattern);
  }
  if (matchType === BigInt(MATCH_TYPE_SUFFIX)) {
    return suffixMatch(pattern);
  }
  throw new C4mError("invalidMatchType", Number(matchType));
}

/**
 * `bin-match` をエンコードする
 */
export function encodeMatch(match: Match): CborValue {
  switch (match.type) {
    case "exact":
      return cborByteString(match.pattern);
    case "prefix":
      return cborArray([cborInteger(MATCH_TYPE_PREFIX), cborByteString(match.pattern)]);
    case "suffix":
      return cborArray([cborInteger(MATCH_TYPE_SUFFIX), cborByteString(match.pattern)]);
    default:
      return unreachableValue(match);
  }
}

/**
 * `moqt-ns-match` (draft-ietf-moq-c4m-01 Section 2.1)
 */
export type NamespaceMatch =
  | { readonly type: "match"; readonly match: Match }
  | { readonly type: "end" };

/**
 * `bin-match` による名前空間フィールドのマッチを作る
 */
export function namespaceMatchValue(match: Match): NamespaceMatch {
  return { type: "match", match };
}

/**
 * 名前空間の末尾を表す `nil` を作る
 */
export function namespaceMatchEnd(): NamespaceMatch {
  return { type: "end" };
}

/**
 * `moqt-scope` (draft-ietf-moq-c4m-01 Section 2.1)
 *
 * アクションの配列と、省略可能な名前空間マッチの配列 / トラック名マッチを持つ。
 */
export interface MoqtScope {
  /** 認可するアクションの整数値 (Table 1) */
  actions: number[];
  /** 名前空間フィールドのマッチ。空の場合はすべての名前空間にマッチする */
  namespace: NamespaceMatch[];
  /** トラック名のマッチ。undefined の場合はすべてのトラック名にマッチする */
  track: Match | undefined;
}

/**
 * アクションを指定してスコープを作る
 *
 * 名前空間マッチとトラックマッチは返り値の配列へ追加する。`nil` は名前空間の
 * 末尾にだけ置ける。
 */
export function createMoqtScope(actions: MoqtAction[]): MoqtScope {
  return {
    actions: actions.map((action) => moqtActionKey(action)),
    namespace: [],
    track: undefined,
  };
}

/**
 * アクションと Full Track Name がこのスコープで認可されるかどうかを返す
 *
 * `namespace` は Track Namespace のフィールド列、`trackName` は Track Name を
 * 表す。マッチはバイト単位で行う (Section 2.1)。
 */
export function moqtScopeAllows(
  scope: MoqtScope,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  if (!scope.actions.includes(moqtActionKey(action))) {
    return false;
  }
  // nil は末尾にだけ置ける (末尾以外にあれば不正なスコープとして拒否する)
  const lastIndex = Math.max(0, scope.namespace.length - 1);
  for (let index = 0; index < lastIndex; index++) {
    if (scope.namespace[index]?.type === "end") {
      return false;
    }
  }
  let namespaceIndex = 0;
  let requiresEnd = false;
  for (const namespaceMatch of scope.namespace) {
    if (namespaceMatch.type === "end") {
      // nil は名前空間の末尾に一致することを要求する
      requiresEnd = true;
      continue;
    }
    const field = namespace[namespaceIndex];
    if (field === undefined) {
      return false;
    }
    if (!matchMatches(namespaceMatch.match, field)) {
      return false;
    }
    namespaceIndex += 1;
  }
  if (requiresEnd && namespaceIndex !== namespace.length) {
    return false;
  }
  // 末尾に nil が無い場合、残りの名前空間フィールドは任意 (Section 2.1)
  if (scope.track === undefined) {
    return true;
  }
  return matchMatches(scope.track, trackName);
}

/**
 * `moqt-scope` をデコードする
 */
export function decodeMoqtScope(value: CborValue): MoqtScope {
  const items = cborAsArray(value);
  if (items === undefined) {
    throw new C4mError("unexpectedType", "moqt-scope");
  }
  if (items.length === 0 || items.length > 3) {
    throw new C4mError("invalidScopeLength", items.length);
  }
  const actionValues = cborAsArray(items[0] ?? CBOR_NULL);
  if (actionValues === undefined) {
    throw new C4mError("unexpectedType", "moqt-actions");
  }
  if (actionValues.length === 0) {
    throw new C4mError("emptyActions");
  }
  const actions: number[] = [];
  for (const action of actionValues) {
    const actionValue = cborAsInt64(action);
    if (actionValue === undefined) {
      throw new C4mError("unexpectedType", "moqt-action");
    }
    actions.push(Number(actionValue));
  }
  const namespace: NamespaceMatch[] = [];
  const matchesValue = items[1];
  if (matchesValue !== undefined) {
    const matches = cborAsArray(matchesValue);
    if (matches === undefined) {
      throw new C4mError("unexpectedType", "moqt-ns-match");
    }
    if (matches.length === 0) {
      throw new C4mError("emptyNamespaceMatch");
    }
    for (let position = 0; position < matches.length; position++) {
      const item = matches[position] ?? CBOR_NULL;
      if (item.type === "null") {
        if (position !== matches.length - 1) {
          throw new C4mError("nilNotLast");
        }
        namespace.push(namespaceMatchEnd());
      } else {
        namespace.push(namespaceMatchValue(decodeMatch(item)));
      }
    }
  }
  const trackValue = items[2];
  const track = trackValue !== undefined ? decodeMatch(trackValue) : undefined;
  return { actions, namespace, track };
}

/**
 * `moqt-scope` をエンコードする
 *
 * `actions` が空の場合、`nil` が末尾以外にある場合、および名前空間マッチ無しで
 * トラックマッチだけを持つ場合はエラーを返す。後者は CDDL の位置指定で表現できず、
 * 黙ってトラック制限を落とすと認可が広がるためである。
 */
export function encodeMoqtScope(scope: MoqtScope): CborValue {
  if (scope.actions.length === 0) {
    throw new C4mError("emptyActions");
  }
  const items: CborValue[] = [cborArray(scope.actions.map((action) => cborInteger(action)))];
  if (scope.namespace.length === 0) {
    if (scope.track !== undefined) {
      throw new C4mError("trackWithoutNamespace");
    }
    return cborArray(items);
  }
  for (let position = 0; position < scope.namespace.length; position++) {
    if (scope.namespace[position]?.type === "end" && position !== scope.namespace.length - 1) {
      throw new C4mError("nilNotLast");
    }
  }
  items.push(
    cborArray(
      scope.namespace.map((namespaceMatch) =>
        namespaceMatch.type === "match" ? encodeMatch(namespaceMatch.match) : CBOR_NULL,
      ),
    ),
  );
  if (scope.track !== undefined) {
    items.push(encodeMatch(scope.track));
  }
  return cborArray(items);
}

/**
 * `moqt` クレーム (draft-ietf-moq-c4m-01 Section 2.1)
 *
 * アクションスコープの配列を持つ。いずれかのスコープが認可すれば許可となり、
 * 評価順は問わない (Section 2.1.2)。
 */
export interface MoqtClaim {
  /** 認可スコープ */
  scopes: MoqtScope[];
}

/**
 * 空のクレームを作る
 */
export function createMoqtClaim(): MoqtClaim {
  return { scopes: [] };
}

/**
 * アクションと Full Track Name が認可されるかどうかを返す
 *
 * いずれかのスコープが認可すれば true を返す。
 */
export function moqtClaimAuthorize(
  claim: MoqtClaim,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  return claim.scopes.some((scope) => moqtScopeAllows(scope, action, namespace, trackName));
}

/**
 * `moqt` クレームをデコードする
 */
export function decodeMoqtClaim(value: CborValue): MoqtClaim {
  const items = cborAsArray(value);
  if (items === undefined) {
    throw new C4mError("unexpectedType", "moqt claim");
  }
  if (items.length === 0) {
    throw new C4mError("emptyScopes");
  }
  return { scopes: items.map((item) => decodeMoqtScope(item)) };
}

/**
 * `moqt` クレームをエンコードする
 */
export function encodeMoqtClaim(claim: MoqtClaim): CborValue {
  if (claim.scopes.length === 0) {
    throw new C4mError("emptyScopes");
  }
  return cborArray(claim.scopes.map((scope) => encodeMoqtScope(scope)));
}

/**
 * `catdpop` クレーム (CTA-5007-B / draft-ietf-moq-c4m-01 Section 3.1.1)
 *
 * DPoP proof の処理設定を持つ。label 0 が受理ウィンドウ (秒)、label 1 が jti に
 * よるリプレイ保護を行うかどうかを表す。
 */
export interface CatDpop {
  /** label 0: DPoP proof を受理する時間ウィンドウ (秒) */
  windowSeconds: number | undefined;
  /** label 1: jti によるリプレイ保護を行うかどうか */
  honorJti: boolean | undefined;
  /** 解釈しなかった設定 */
  raw: Array<[CborValue, CborValue]>;
}

/**
 * ウィンドウと jti の扱いを指定して作る
 */
export function createCatDpop(windowSeconds: number, honorJti: boolean): CatDpop {
  return { windowSeconds, honorJti, raw: [] };
}

/**
 * 数値クレームを CBOR のデータ項目へエンコードする
 *
 * 整数値は整数として、非整数値は浮動小数点数としてエンコードする。CBOR の決定論的
 * エンコードは値が同じでも整数と浮動小数点を区別するため、入力の表現をなるべく
 * 保つ。
 */
export function cborNumberValue(number: number): CborValue {
  // 2^63 は整数として表現できないため、半開区間で判定する
  if (
    Number.isInteger(number) &&
    number >= -9_223_372_036_854_775_808 &&
    number < 9_223_372_036_854_775_808
  ) {
    return cborInteger(BigInt(number));
  }
  return cborFloat(number);
}

/**
 * `catdpop` をデコードする
 *
 * ウィンドウは整数と浮動小数点の両方、jti の扱いは真偽値と整数 (0 / 1) の
 * 両方を受ける (付録 A.4 のベクタは整数を使う)。
 */
export function decodeCatDpop(value: CborValue): CatDpop {
  const entries = cborAsMap(value);
  if (entries === undefined) {
    throw new C4mError("unexpectedType", "catdpop");
  }
  const catdpop: CatDpop = { windowSeconds: undefined, honorJti: undefined, raw: [] };
  for (const [key, entry] of entries) {
    const label = cborAsInt64(key);
    if (label === undefined) {
      throw new C4mError("unexpectedType", "catdpop label");
    }
    if (label === 0n) {
      const window = cborAsNumber(entry);
      if (window === undefined) {
        throw new C4mError("unexpectedType", "catdpop window");
      }
      if (!Number.isFinite(window)) {
        throw new C4mError("nonFiniteNumber", "catdpop window");
      }
      catdpop.windowSeconds = window;
      continue;
    }
    if (label === 1n) {
      let honorJti: boolean | undefined;
      if (entry.type === "bool") {
        honorJti = entry.value;
      } else {
        const integer = cborAsInt64(entry);
        if (integer !== undefined) {
          honorJti = integer !== 0n;
        }
      }
      if (honorJti === undefined) {
        throw new C4mError("unexpectedType", "catdpop honor jti");
      }
      catdpop.honorJti = honorJti;
      continue;
    }
    catdpop.raw.push([key, entry]);
  }
  return catdpop;
}

/**
 * `catdpop` をエンコードする
 *
 * label 1 はドラフトの例に合わせて整数 (1 / 0) で書く。ウィンドウが有限でない
 * 場合はエラーを返す (デコード側が拒否する値を持つトークンを発行しないため)。
 */
export function encodeCatDpop(catdpop: CatDpop): CborValue {
  const entries: Array<[CborValue, CborValue]> = [];
  if (catdpop.windowSeconds !== undefined) {
    if (!Number.isFinite(catdpop.windowSeconds)) {
      throw new C4mError("nonFiniteNumber", "catdpop window");
    }
    entries.push([cborInteger(0), cborNumberValue(catdpop.windowSeconds)]);
  }
  if (catdpop.honorJti !== undefined) {
    entries.push([cborInteger(1), cborInteger(catdpop.honorJti ? 1 : 0)]);
  }
  entries.push(...catdpop.raw.map((entry): [CborValue, CborValue] => [entry[0], entry[1]]));
  return cborMap(entries);
}

/**
 * ウィンドウを返す (未指定の場合は `defaultValue` を返す)
 */
export function catDpopWindowSecondsOr(catdpop: CatDpop, defaultValue: number): number {
  return catdpop.windowSeconds ?? defaultValue;
}

/**
 * jti によるリプレイ保護を行うかどうかを返す
 *
 * 未指定の場合は false を返す。
 */
export function catDpopHonorsJti(catdpop: CatDpop): boolean {
  return catdpop.honorJti ?? false;
}

/**
 * C4M のクレームのエンコード / デコードエラー
 */
export type C4mErrorCode =
  | "unexpectedType"
  | "emptyActions"
  | "emptyScopes"
  | "invalidMatchArrayLength"
  | "invalidMatchType"
  | "nilNotLast"
  | "emptyNamespaceMatch"
  | "invalidScopeLength"
  | "trackWithoutNamespace"
  | "nonFiniteNumber";

export class C4mError extends Error {
  readonly code: C4mErrorCode;
  readonly detail: string | number | undefined;

  constructor(code: C4mErrorCode, detail?: string | number) {
    super(buildC4mErrorMessage(code, detail));
    this.name = "C4mError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildC4mErrorMessage(code: C4mErrorCode, detail: string | number | undefined): string {
  switch (code) {
    case "unexpectedType":
      return `expected ${String(detail)}`;
    case "emptyActions":
      return "moqt-scope has no actions";
    case "emptyScopes":
      return "moqt claim has no scopes";
    case "invalidMatchArrayLength":
      return `bin-match array must have 2 elements, got ${String(detail)}`;
    case "invalidMatchType":
      return `invalid match type: ${String(detail)}`;
    case "nilNotLast":
      return "nil must be the last namespace match";
    case "emptyNamespaceMatch":
      return "moqt-ns-match array is empty";
    case "invalidScopeLength":
      return `moqt-scope must have 1 to 3 elements, got ${String(detail)}`;
    case "trackWithoutNamespace":
      return "moqt-scope has a track match without a namespace match";
    case "nonFiniteNumber":
      return `${String(detail)} must be finite`;
    default:
      return unreachableValue(code);
  }
}
