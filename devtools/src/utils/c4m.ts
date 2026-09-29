import { C4M } from "moqt-js";

/**
 * MSF URL または MSF URI Fragment から c4m パラメータ (Base64) を取り出す。
 *
 * draft-ietf-moq-msf-01 §11.1.1:
 * - msf-fragment は `msf:` で始まり、track-identifier と `&` 区切りの parameter-list を持つ
 * - c4m は reserved parameter で、Base64 encoded C4M token (draft-ietf-moq-c4m-01 §2) を持つ
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
 * c4m の値 (標準 Base64 / base64url) をバイト列へ復号する
 *
 * C4M のトークンは URL では Base64 encoded と定められる (draft-ietf-moq-msf-01 §11.1.1 /
 * draft-ietf-moq-c4m-01 §2) が、base64url (RFC 4648 Section 5) で発行されたトークンが
 * URL に載ることがある (draft-ietf-moq-c4m-01 付録 A のテストベクタも base64url)。
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
 * 文字列が Base64 (標準 / base64url) として復号可能か検証する
 */
function isBase64(value: string): boolean {
  return decodeC4mBase64(value) !== undefined;
}

/**
 * c4m のトークン 1 つのスコープの表示用の情報
 *
 * draft-ietf-moq-c4m-01 Section 2.1 の `moqt-scope` を画面に出すための文字列にする。
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
  /** 直列化の形式 (compact / coseSign1 / coseMac0) */
  format: C4M.TokenFormat;
  /** COSE ヘッダの alg (例: "Es256")。無い場合は undefined */
  algorithm: string | undefined;
  /** `iss` */
  issuer: string | undefined;
  /** `aud` (複数は ", " で連結する)。空の場合は undefined */
  audience: string | undefined;
  /** `exp` の表示 (例: "1790779292 (2026-09-30T14:41:32.000Z)")。無い場合は undefined */
  expiration: string | undefined;
  /** `nbf` の表示。無い場合は undefined */
  notBefore: string | undefined;
  /** `iat` の表示。無い場合は undefined */
  issuedAt: string | undefined;
  /** `moqt` クレームのスコープ。クレームが無い場合は空配列 */
  scopes: C4mTokenScopeInfo[];
  /**
   * `moqt` クレームが exact で許可する track name
   *
   * prefix / suffix のマッチは 1 つの名前を表さないため含めない。
   */
  trackNames: string[];
}

/**
 * c4m の値 (Base64 / base64url) を画面表示用にデコードする
 *
 * draft-ietf-moq-c4m-01 Section 2.1 の `moqt` クレームと、CWT の主要なクレーム
 * (iss / aud / exp / nbf / iat) を取り出す。署名の検証は行わない。
 * Base64 として復号できない場合、CAT としてデコードできない場合は undefined を返す
 * (入力途中の値を渡しても例外を投げない)。
 */
export function decodeC4mTokenInfo(base64: string): C4mTokenInfo | undefined {
  const bytes = decodeC4mBase64(base64);
  if (bytes === undefined) {
    return undefined;
  }
  let token: C4M.CatToken;
  try {
    token = C4M.CatToken.decode(bytes);
  } catch {
    return undefined;
  }
  const claims = token.claims();
  const scopes: C4mTokenScopeInfo[] = [];
  const trackNames: string[] = [];
  for (const scope of claims.moqt?.scopes ?? []) {
    scopes.push({
      actions: scope.actions.map(formatAction),
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
    expiration: formatClaimTime(claims.expiration),
    notBefore: formatClaimTime(claims.notBefore),
    issuedAt: formatClaimTime(claims.issuedAt),
    scopes,
    trackNames,
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
 * `moqt` クレームのアクション番号を表示名にする (draft-ietf-moq-c4m-01 Section 2.1 Table 1)
 *
 * 表に無い値は数値の文字列にする (デコード時に拒否していないため、未知の値が来る)。
 */
function formatAction(action: number): string {
  const name = C4M.moqtActionFromKey(action);
  return name === undefined ? String(action) : C4M.moqtActionName(name);
}

/**
 * `bin-match` を入力の書式へ戻す (draft-ietf-moq-c4m-01 Section 2.1)
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
 * `moqt-ns-match` を入力の書式へ戻す (draft-ietf-moq-c4m-01 Section 2.1)
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

/**
 * UNIX 秒のクレームを表示用の文字列にする (例: "1790779292 (2026-09-30T14:41:32.000Z)")
 */
function formatClaimTime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) {
    return undefined;
  }
  return `${seconds} (${new Date(seconds * 1000).toISOString()})`;
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
