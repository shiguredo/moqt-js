/**
 * C4M の `moqt` / `moqt-reval` / `catdpop` クレーム
 *
 * draft-ietf-moq-c4m-02 Section 2.1 のアクションとスコープ、Section 2.2 の
 * `moqt-reval`、Section 4.1 が参照する `catdpop` (CTA-5007-B Section 4.8) を
 * 扱う。`catdpop` など確定したクレームキーは IANA の CWT Claims レジストリに従う。
 *
 * `moqt` / `moqt-reval` の claim key は draft-ietf-moq-c4m-02 Section 8 でも
 * TBD_MOQT / TBD_MOQT_REVAL のままであり、IANA に割り当てられていない。そのため
 * このモジュールは固定値も暗黙の既定値も持たず、相互接続する peer と事前に合意した
 * 値を `C4mClaimLabels` として呼び出し側から受け取る。付録 A の検証用ベクタだけが
 * Private Use の -65537 / -65538 を使うため、その preset を
 * `C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS` として公開する。
 *
 * このモジュールは I/O も時計も持たない。
 */

import { bytesEqual } from "./bytes";
import { unreachableValue } from "./unreachable";

import {
  CBOR_NULL,
  type CborValue,
  cborArray,
  cborAsArray,
  cborAsBytes,
  cborAsInt64,
  cborAsInteger,
  cborAsMap,
  cborAsNumber,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
} from "./cbor";

/**
 * `moqt` / `moqt-reval` クレームの claim key 設定
 *
 * draft-ietf-moq-c4m-02 Section 8 は両クレームの claim key を
 * TBD_MOQT / TBD_MOQT_REVAL のままとし、IANA の CWT Claims レジストリには
 * 登録されていない。付録 A の検証用ベクタだけが Private Use (RFC 8392
 * Section 9.1.1 の -65536 未満) の -65537 / -65538 を使う。
 *
 * したがって確定した IANA 割当として扱える既定値は存在しない。相互接続する
 * peer と事前に合意した値をこの型で明示し、トークンのエンコード / デコードの
 * 開始時に検証する。検証に失敗する設定 (未指定、安全な整数でない値、互いに
 * 同じ値、実装が使う他の claim key との重複) では処理を開始しない。
 *
 * 値をコピーして保持するため、Token / builder の生成後にこのオブジェクトを
 * 変更しても、すでに生成した Token / builder の解釈は変わらない。
 */
export interface C4mClaimLabels {
  /** `moqt` クレームの claim key */
  readonly moqt: number;
  /** `moqt-reval` クレームの claim key */
  readonly moqtReval: number;
}

/**
 * draft-ietf-moq-c4m-02 付録 A の検証用ベクタが使う claim key の preset
 *
 * 付録 A は IANA 未割当の `moqt` / `moqt-reval` の代わりに Private Use の
 * -65537 / -65538 を placeholder として使う。この preset はその検証用の値で
 * あり、IANA に登録された標準値でも運用上の既定値でもない。
 *
 * テストと devtools はこの preset を明示して使う。実運用では peer と合意した
 * 暫定値を同じ形で渡す。この preset を暗黙に使う経路は無い。
 */
export const C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS: C4mClaimLabels = Object.freeze({
  moqt: -65537,
  moqtReval: -65538,
});

/**
 * `moqt` claim map の scope 配列を表す key (draft-ietf-moq-c4m-02 Section 2.1)
 */
export const MOQT_SCOPES_KEY = 0;

/**
 * `bin-match` の prefix マッチを表す match-type (draft-ietf-moq-c4m-02 Section 2.1)
 */
export const MATCH_TYPE_PREFIX = 1;

/**
 * `bin-match` の suffix マッチを表す match-type (draft-ietf-moq-c4m-02 Section 2.1)
 */
export const MATCH_TYPE_SUFFIX = 2;

/**
 * MOQT のアクション (draft-ietf-moq-c4m-01 Section 2.1 Table 1)
 */
export type MoqtAction =
  | "Setup"
  | "PublishNamespace"
  | "SubscribeNamespace"
  | "Subscribe"
  | "RequestUpdate"
  | "Publish"
  | "Fetch"
  | "TrackStatus"
  | "SubscribeTracks";

/**
 * すべてのアクション (Table 1 の順)
 */
export const MOQT_ACTIONS: readonly MoqtAction[] = [
  "Setup",
  "PublishNamespace",
  "SubscribeNamespace",
  "Subscribe",
  "RequestUpdate",
  "Publish",
  "Fetch",
  "TrackStatus",
  "SubscribeTracks",
];

/**
 * `moqt` クレームのアクション整数を返す (Table 1)
 */
export function moqtActionKey(action: MoqtAction): number {
  switch (action) {
    case "Setup":
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
    case "SubscribeTracks":
      return 9;
    default:
      return unreachableValue(action);
  }
}

/**
 * アクション整数からアクションを返す
 */
export function moqtActionFromKey(key: number): MoqtAction | undefined {
  switch (key) {
    case 1:
      return "Setup";
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
    case 9:
      return "SubscribeTracks";
    default:
      // 0 は C4M 01 の ClientSetup であり、C4M 02 のアクションではない。
      return undefined;
  }
}

/**
 * MOQT のメッセージ名を返す (ログとデバッグ用)
 *
 * draft-17 で CLIENT_SETUP と SERVER_SETUP が 1 つの SETUP メッセージに
 * 統合された (draft-ietf-moq-transport-23 §A.7)。そのため ClientSetup と
 * ServerSetup はどちらも `SETUP` を返す (Authorization Context (Table 2) も
 * 同じ名前を使う)。
 */
export function moqtActionName(action: MoqtAction): string {
  switch (action) {
    case "Setup":
      return "SETUP";
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
    case "SubscribeTracks":
      return "SUBSCRIBE_TRACKS";
    default:
      return unreachableValue(action);
  }
}

/**
 * `bin-match` (draft-ietf-moq-c4m-02 Section 2.1)
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
 * `moqt-ns-match` (draft-ietf-moq-c4m-02 Section 2.1)
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
 * `moqt-scope` (draft-ietf-moq-c4m-02 Section 2.1)
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
 * アクションが安全な整数でない場合、`actions` が空の場合、`nil` が末尾以外にある
 * 場合、および名前空間マッチ無しでトラックマッチだけを持つ場合はエラーを返す。
 * 最後のものは CDDL の位置指定で表現できず、黙ってトラック制限を落とすと認可が
 * 広がるためである。
 *
 * アクションの検証はデコード側と揃える。デコードは i64 の整数を
 * `Number` へ丸めるため、2^53 を超える値は元の値に戻らない。
 */
export function encodeMoqtScope(scope: MoqtScope): CborValue {
  if (scope.actions.length === 0) {
    throw new C4mError("emptyActions");
  }
  for (const action of scope.actions) {
    if (!Number.isSafeInteger(action)) {
      throw new C4mError("invalidAction", Number.isFinite(action) ? action : undefined);
    }
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
 * `moqt` クレーム (draft-ietf-moq-c4m-02 Section 2.1)
 *
 * CBOR map の key 0 に認可スコープの配列を持つ。いずれかのスコープが認可すれば
 * 許可となり、評価順は問わない。
 *
 * draft-ietf-moq-c4m-02 §2.1.1 (Extensibility): key 0 以外は将来の改訂のために
 * 予約されており、未知の key を持つ claim は受理してはならない (fail-closed)。
 * そのためこの型は key 0 以外の要素を保持しない。
 */
export interface MoqtClaim {
  /** 認可スコープ (CBOR map の key 0) */
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
 *
 * draft-ietf-moq-c4m-02 §2.1: claim の値は CBOR map で、key 0 が scope 配列である。
 * §2.1.1 に従い、key 0 以外の key を持つ claim は受理しない (fail-closed)。
 * 旧形式の配列 (C4M 01) も受理しない。
 */
export function decodeMoqtClaim(value: CborValue): MoqtClaim {
  const entries = cborAsMap(value);
  if (entries === undefined) {
    throw new C4mError("unexpectedType", "moqt claim");
  }
  let scopesValue: CborValue | undefined;
  for (const [key, entryValue] of entries) {
    const mapKey = cborAsInteger(key);
    // draft-ietf-moq-c4m-02 §2.1 の CDDL は `* int => any` であり、
    // 整数以外の key は map の形として不正である。2^63 以上も整数なので
    // cborAsInt64 ではなく cborAsInteger で判定する
    if (mapKey === undefined) {
      throw new C4mError("unexpectedType", "moqt claim key");
    }
    // draft-ietf-moq-c4m-02 §2.1.1: 未知の整数 key を持つ claim set は受理しない
    if (mapKey !== BigInt(MOQT_SCOPES_KEY)) {
      throw new C4mError("unknownClaimKey", mapKey.toString());
    }
    // 同じ key 0 が複数ある map は、最後の要素を採用せず claim 全体を拒否する。
    // ワイヤ上の重複 key は CBOR 層が拒否するが、この関数は CborValue を直接
    // 受ける公開 API のため、構築した map に対してもここで拒否する
    if (scopesValue !== undefined) {
      throw new C4mError("duplicateScopesKey");
    }
    scopesValue = entryValue;
  }
  if (scopesValue === undefined) {
    throw new C4mError("missingScopes");
  }
  const items = cborAsArray(scopesValue);
  if (items === undefined) {
    throw new C4mError("unexpectedType", "moqt scopes");
  }
  if (items.length === 0) {
    throw new C4mError("emptyScopes");
  }
  return { scopes: items.map((item) => decodeMoqtScope(item)) };
}

/**
 * `moqt` クレームをエンコードする
 *
 * draft-ietf-moq-c4m-02 §2.1: CBOR map の key 0 に scope 配列を置く。
 */
export function encodeMoqtClaim(claim: MoqtClaim): CborValue {
  if (claim.scopes.length === 0) {
    throw new C4mError("emptyScopes");
  }
  return cborMap([
    [cborInteger(MOQT_SCOPES_KEY), cborArray(claim.scopes.map((scope) => encodeMoqtScope(scope)))],
  ]);
}

/**
 * `catdpop` クレーム (CTA-5007-B Section 4.8 / draft-ietf-moq-c4m-02 Section 4.1)
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
 * `raw` の label は i64 の整数だけを受け付ける。デコード側も整数以外の label を
 * 拒否するため、受理域を揃える。
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
  for (const [key, value] of catdpop.raw) {
    if (cborAsInt64(key) === undefined) {
      throw new C4mError("unexpectedType", "catdpop label");
    }
    entries.push([key, value]);
  }
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
  | "invalidAction"
  | "invalidMatchArrayLength"
  | "invalidMatchType"
  | "nilNotLast"
  | "emptyNamespaceMatch"
  | "invalidScopeLength"
  | "trackWithoutNamespace"
  | "nonFiniteNumber"
  | "unknownClaimKey"
  | "duplicateScopesKey"
  | "missingScopes";

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
    case "invalidAction":
      return `moqt-action must be a safe integer: ${String(detail)}`;
    case "invalidMatchArrayLength":
      return `bin-match array must have 2 elements, got ${String(detail)}`;
    case "invalidMatchType":
      return `invalid match type: ${String(detail)}`;
    case "nilNotLast":
      return "nil must be the last namespace match";
    case "emptyNamespaceMatch":
      return "moqt-ns-match array is empty";
    case "unknownClaimKey":
      return `moqt claim has an unknown map key: ${String(detail)}`;
    case "duplicateScopesKey":
      return `moqt claim has more than one scopes key (${MOQT_SCOPES_KEY})`;
    case "missingScopes":
      return "moqt claim has no scopes key (0)";
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
