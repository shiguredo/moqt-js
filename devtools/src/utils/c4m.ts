import { C4M } from "moqt-js";
import { actionDisplayName } from "../c4m-devtools/utils/actions";
import { formatUnixTime } from "../c4m-devtools/utils/claims";

/**
 * 表示用のデコードに使う claim label 設定
 *
 * C4M 02 付録 A の検証用 preset (Private Use の -65537 / -65538) を明示して使う。
 */
const CLAIM_LABELS = C4M.C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS;

/**
 * `moqt` クレームの探索結果
 *
 * draft-ietf-moq-c4m-02 §8 の Table 2 は `moqt` の claim key を TBD にしており、
 * IANA に割り当てられていない。そのため、設定した claim label で解釈できなくても、
 * 解釈しなかった claim の中に `moqt` クレームの形をしたものがあれば表示に使う。
 */
export interface ResolvedMoqtClaim {
  /** 見つかった `moqt` クレーム。見つからない場合は undefined */
  readonly claim: C4M.MoqtClaim | undefined;
  /** `moqt` クレームの claim key。見つからない場合は undefined */
  readonly label: number | undefined;
  /** 設定した claim label ではなく、解釈しなかった claim から見つけたかどうか */
  readonly fromRaw: boolean;
  /** 解釈しなかった claim の key の表示 (`"999"` / `"text:moqt"` など) */
  readonly rawClaimKeys: string[];
}

/** CBOR の claim key を画面に出す文字列にする */
function formatClaimKey(key: C4M.CborValue): string {
  const integer = C4M.cborAsInteger(key);
  if (integer !== undefined) {
    return integer.toString();
  }
  const text = C4M.cborAsText(key);
  if (text !== undefined) {
    return `text:${text}`;
  }
  return "unknown";
}

/**
 * 解釈しなかった claim から `moqt` クレームを探す
 *
 * `moqt` クレームの値は CBOR map で、key 0 に scope の配列を持つ
 * (draft-ietf-moq-c4m-02 §2.1)。`decodeMoqtClaim` が受理できる値だけを `moqt` クレーム
 * とみなし、ほかの claim は飛ばす。
 */
function findMoqtClaim(
  raw: readonly (readonly [C4M.CborValue, C4M.CborValue])[],
): { readonly label: number; readonly claim: C4M.MoqtClaim } | undefined {
  for (const [key, value] of raw) {
    const integer = C4M.cborAsInteger(key);
    if (integer === undefined) {
      continue;
    }
    const label = Number(integer);
    // claim label は安全な整数だけを扱う (C4mClaimLabels と同じ制約)
    if (!Number.isSafeInteger(label)) {
      continue;
    }
    try {
      return { label, claim: C4M.decodeMoqtClaim(value) };
    } catch {
      // `moqt` クレームの形ではない claim は飛ばす
    }
  }
  return undefined;
}

/**
 * トークンの claims から `moqt` クレームを取り出す
 *
 * 設定した claim label で解釈できていればそれを返す。解釈できていない場合は、
 * 解釈しなかった claim から `moqt` クレームの形を探す。C4M 02 の `moqt` claim key は
 * IANA 未割当で peer ごとに異なるため、デバッグ表示ではこの探索を行う。
 *
 * @param claims デコードしたトークンの claims
 * @param configuredMoqtLabel デコードに使った `moqt` の claim label
 */
export function resolveMoqtClaim(
  claims: C4M.CatClaims,
  configuredMoqtLabel: number,
): ResolvedMoqtClaim {
  const rawClaimKeys = claims.raw.map(([key]) => formatClaimKey(key));
  if (claims.moqt !== undefined) {
    return {
      claim: claims.moqt,
      label: configuredMoqtLabel,
      fromRaw: false,
      rawClaimKeys,
    };
  }
  const found = findMoqtClaim(claims.raw);
  if (found === undefined) {
    return { claim: undefined, label: undefined, fromRaw: false, rawClaimKeys };
  }
  return { claim: found.claim, label: found.label, fromRaw: true, rawClaimKeys };
}

/**
 * MSF URL または MSF URI Fragment から c4m パラメータ (Base64) を取り出す。
 *
 * draft-ietf-moq-msf-01 §11.1.1:
 * - msf-fragment は `msf:` で始まり、track-identifier と `&` 区切りの parameter-list を持つ
 * - c4m は reserved parameter で、Base64 encoded C4M token (draft-ietf-moq-c4m-02 §2) を持つ
 *
 * 入力は `moqt://example.com/moqt#msf:room-123--catalog&c4m=...` のような URL 全体、
 * または `msf:room-123--catalog&c4m=...` のような fragment 単体を受け付ける。
 *
 * fragment が `msf:` で始まらない場合、c4m が無い場合、Base64 として復号できない場合は
 * undefined を返す (入力途中の値を渡しても例外を投げない)。
 */
export function extractC4mBase64(input: string): string | undefined {
  // `#` 以降を fragment として扱う。`#` が無い場合は入力全体を fragment とみなす
  const hashIndex = input.indexOf("#");
  const fragment = hashIndex === -1 ? input : input.slice(hashIndex + 1);
  if (!fragment.startsWith("msf:")) {
    return undefined;
  }

  // `msf:` の後は track-identifier *( "&" parameter ) のため、parameter は 2 番目以降
  const parameterList = fragment.slice("msf:".length);
  for (const segment of parameterList.split("&").slice(1)) {
    const equalsIndex = segment.indexOf("=");
    if (equalsIndex === -1 || segment.slice(0, equalsIndex) !== "c4m") {
      continue;
    }
    const value = segment.slice(equalsIndex + 1);
    if (!isBase64(value)) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

/**
 * Base64 (標準 / base64url) のアルファベットとパディング
 *
 * `atob` は HTML の forgiving-base64 として ASCII 空白を取り除き、`=` の位置も緩く
 * 解釈する。c4m の値は URL の parameter なので、ここでは Base64 の文字だけを受理し、
 * 端数のビットが 0 でない入力 (draft-ietf-moq-msf-01 §11.1.1 の例) の緩さだけを残す。
 */
const BASE64_CHARACTERS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_=",
);

/** Base64 の文字だけで書かれているかどうかを返す */
function isBase64Characters(value: string): boolean {
  for (const character of value) {
    if (!BASE64_CHARACTERS.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * c4m の値 (標準 Base64 / base64url) をバイト列へ復号する
 *
 * C4M のトークンは URL では Base64 encoded と定められる (draft-ietf-moq-msf-01 §11.1.1 /
 * draft-ietf-moq-c4m-02 §2) が、base64url (RFC 4648 Section 5) で発行されたトークンが
 * URL に載ることがある (draft-ietf-moq-c4m-02 付録 A のテストベクタも base64url)。
 * パディングの有無も含め、まず C4M のトークンデコーダと同じ厳密な規則で復号し、
 * MSF の仕様例 (§11.1.1 の例は端数のビットが 0 でない) のために atob の許容範囲でも試す。
 *
 * 復号できない場合は undefined を返す (入力途中の値を渡しても例外を投げない)。
 */
export function decodeC4mBase64(value: string): Uint8Array | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const strict = C4M.tryDecodeBase64OrUrl(value);
  if (strict !== undefined) {
    return strict;
  }
  // Base64 の文字でなければ atob へ渡さない (空白や `=` の位置の緩さを引き継がない)
  if (!isBase64Characters(value)) {
    return undefined;
  }
  // atob は base64url の `-` と `_` を受理しないため、標準 Base64 の文字へ置き換える
  try {
    const binaryString = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index++) {
      bytes[index] = binaryString.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * MSF URL または MSF URI Fragment から c4m パラメータを取り除く
 *
 * moqt-js の `connect()` は MOQT URI の msf fragment の c4m を復号して SETUP の
 * Authorization Token として送る (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)。
 * そのため画面で c4m の取り込みを解除しても、URL に値が残っていれば送信が止まらない。
 * 解除するときは URL からも取り除く。
 *
 * `c4m=` の出現をすべて取り除き、track-identifier と他のパラメータは元の順序で残す。
 * msf fragment を持たない入力、c4m を持たない入力はそのまま返す
 * (入力途中の値を渡しても壊さない)。
 */
export function removeC4mParameter(input: string): string {
  // `#` 以降を fragment として扱う。`#` が無い場合は入力全体を fragment とみなす
  const hashIndex = input.indexOf("#");
  const uriPrefix = hashIndex === -1 ? "" : input.slice(0, hashIndex + 1);
  const fragment = hashIndex === -1 ? input : input.slice(hashIndex + 1);
  if (!fragment.startsWith("msf:")) {
    return input;
  }

  // `msf:` の後は track-identifier *( "&" parameter ) のため、parameter は 2 番目以降
  const segments = fragment.slice("msf:".length).split("&");
  const trackIdentifier = segments[0] ?? "";
  const keptParameters = segments.slice(1).filter((segment) => {
    const equalsIndex = segment.indexOf("=");
    return equalsIndex === -1 || segment.slice(0, equalsIndex) !== "c4m";
  });
  if (keptParameters.length === segments.length - 1) {
    return input;
  }
  return `${uriPrefix}msf:${[trackIdentifier, ...keptParameters].join("&")}`;
}

/**
 * 文字列が Base64 (標準 / base64url) として復号可能か検証する
 */
function isBase64(value: string): boolean {
  return decodeC4mBase64(value) !== undefined;
}

/**
 * c4m のトークン 1 つのスコープの表示用の情報
 *
 * draft-ietf-moq-c4m-02 Section 2.1 の `moqt-scope` を画面に出すための文字列にする。
 */
export interface C4mTokenScopeInfo {
  /** アクションの表示名 (例: ["SUBSCRIBE", "PUBLISH"])。不明な値は数値の文字列 */
  actions: string[];
  /** namespace マッチの表示 (例: "15551, spam, end")。空の場合は "-" */
  namespace: string;
  /** track マッチの表示 (例: "audio" / "prefix:vid")。無い場合は "any" */
  track: string;
}

/**
 * c4m のトークンを画面表示用にデコードした情報
 *
 * 署名の検証は行わない (送信するトークンは relay が検証する)。
 */
export interface C4mTokenInfo {
  /** 直列化の形式 (coseSign1 / coseMac0) */
  format: C4M.TokenFormat;
  /** COSE ヘッダの alg (例: "Es256")。無い場合は undefined */
  algorithm: string | undefined;
  /** `iss` */
  issuer: string | undefined;
  /** `aud` (複数は ", " で連結する)。空の場合は undefined */
  audience: string | undefined;
  /** `exp` の表示 (例: "2026-09-30T14:41:32.000Z (1790779292)")。無い場合は undefined */
  expiration: string | undefined;
  /** `nbf` の表示 (`exp` と同じ書式)。無い場合は undefined */
  notBefore: string | undefined;
  /** `iat` の表示 (`exp` と同じ書式)。無い場合は undefined */
  issuedAt: string | undefined;
  /** `moqt` クレームのスコープ。クレームが無い場合は空配列 */
  scopes: C4mTokenScopeInfo[];
  /**
   * `moqt` クレームが exact で許可する track name
   *
   * prefix / suffix のマッチは 1 つの名前を表さないため含めない。
   */
  trackNames: string[];
  /** デコードに使った claim label 設定 (C4M 02 付録 A の検証用 preset) */
  claimLabels: C4M.C4mClaimLabels;
  /** `moqt` クレームを解釈した claim key。見つからない場合は undefined */
  moqtClaimLabel: number | undefined;
  /** 設定した claim label ではなく、解釈しなかった claim から `moqt` クレームを見つけたかどうか */
  moqtClaimFromRaw: boolean;
  /** 解釈しなかった claim の key の表示 (`"999"` / `"text:moqt"` など) */
  rawClaimKeys: string[];
}

/**
 * c4m の値 (Base64 / base64url) を画面表示用にデコードする
 *
 * draft-ietf-moq-c4m-02 Section 2.1 の `moqt` クレームと、CWT の主要なクレーム
 * (iss / aud / exp / nbf / iat) を取り出す。署名の検証は行わない。
 * Base64 として復号できない場合、CAT としてデコードできない場合は undefined を返す
 * (入力途中の値を渡しても例外を投げない)。
 *
 * `moqt` クレームの claim key は IANA 未割当のため、付録 A の preset で解釈できない
 * ときは、解釈しなかった claim から `moqt` クレームの形を探す (resolveMoqtClaim)。
 */
export function decodeC4mTokenInfo(base64: string): C4mTokenInfo | undefined {
  const bytes = decodeC4mBase64(base64);
  if (bytes === undefined) {
    return undefined;
  }
  let token: C4M.CatToken;
  try {
    token = C4M.CatToken.decode(bytes, CLAIM_LABELS);
  } catch {
    return undefined;
  }
  const claims = token.claims();
  const resolved = resolveMoqtClaim(claims, CLAIM_LABELS.moqt);
  const scopes: C4mTokenScopeInfo[] = [];
  const trackNames: string[] = [];
  for (const scope of resolved.claim?.scopes ?? []) {
    scopes.push({
      actions: scope.actions.map(actionDisplayName),
      namespace: scope.namespace.length > 0 ? formatNamespaceMatches(scope.namespace) : "-",
      track: scope.track !== undefined ? formatMatch(scope.track) : "any",
    });
    if (scope.track?.type === "exact") {
      trackNames.push(new TextDecoder().decode(scope.track.pattern));
    }
  }
  return {
    format: token.format(),
    algorithm: token.header().algorithm,
    issuer: claims.issuer,
    audience: claims.audience.length > 0 ? claims.audience.join(", ") : undefined,
    expiration: claims.expiration !== undefined ? formatUnixTime(claims.expiration) : undefined,
    notBefore: claims.notBefore !== undefined ? formatUnixTime(claims.notBefore) : undefined,
    issuedAt: claims.issuedAt !== undefined ? formatUnixTime(claims.issuedAt) : undefined,
    scopes,
    trackNames,
    claimLabels: CLAIM_LABELS,
    moqtClaimLabel: resolved.label,
    moqtClaimFromRaw: resolved.fromRaw,
    rawClaimKeys: resolved.rawClaimKeys,
  };
}

/**
 * c4m の値 (Base64 / base64url) から、moqt クレームが許可する track name を取り出す
 *
 * `decodeC4mTokenInfo` が取り出す exact な track name と同じもので、デコードできない場合は
 * 空配列を返す。
 */
export function extractC4mTrackNames(base64: string): string[] {
  return decodeC4mTokenInfo(base64)?.trackNames ?? [];
}

/**
 * `bin-match` を入力の書式へ戻す (draft-ietf-moq-c4m-02 Section 2.1)
 *
 * `example.com` は完全一致、`prefix:live` は前方一致、`suffix:.example.com` は後方一致。
 */
export function formatMatch(match: C4M.Match): string {
  const pattern = new TextDecoder().decode(match.pattern);
  switch (match.type) {
    case "prefix":
      return `prefix:${pattern}`;
    case "suffix":
      return `suffix:${pattern}`;
    case "exact":
      return pattern;
    default:
      throw new Error("unsupported match type");
  }
}

/**
 * `moqt-ns-match` を入力の書式へ戻す (draft-ietf-moq-c4m-02 Section 2.1)
 *
 * `end` は名前空間の末尾を固定する `nil` を表す。
 */
export function formatNamespaceMatches(matches: C4M.NamespaceMatch[]): string {
  return matches
    .map((namespaceMatch) =>
      namespaceMatch.type === "end" ? "end" : formatMatch(namespaceMatch.match),
    )
    .join(", ");
}

/** c4m の値に置き換える伏せ字 */
const C4M_REDACTED = "c4m=<redacted>";

/**
 * c4m パラメータの値を伏せ字にする
 *
 * c4m は Base64 encoded C4M token (CAT) を持つ (draft-ietf-moq-msf-01 §11.1.1)。
 * デバッグパネルの「Copy for LLM」は不具合の報告のために外部へ貼る前提のため、
 * 値そのものを載せない。MOQT URI は接続に使う値なので signal は変えず、
 * テキストへ出すときだけこの関数を通す。
 *
 * 入力は URL 全体と fragment 単体の両方を受け付ける (`extractC4mBase64` と同じ)。
 * `extractC4mBase64` は最初の c4m だけを返すが、伏せ字は `c4m=` の出現をすべて潰す。
 */
export function maskC4mValue(input: string): string {
  // parameter-list の区切りは `&` のため、`&` の手前までを値として扱う。
  // 本文全体 (複数行) へかけることがあるため、改行と空白も値に含めない
  // (含めると c4m の後ろの行まで消える)。`c4m=` の部分一致で潰すため、`xc4m=` の
  // ような別の parameter も伏せ字になるが、安全側に倒す
  return input.replaceAll(/c4m=[^&\s]*/g, C4M_REDACTED);
}
