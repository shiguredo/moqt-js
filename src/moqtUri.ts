/**
 * MOQT URI スキーム処理
 *
 * draft-ietf-moq-transport-18 §3.1.1 (MOQT URI Scheme)
 * draft-ietf-moq-transport-18 §3.1.2 (Fragment Identifiers)
 * draft-ietf-moq-transport-18 §3.1.3 (WebTransport)
 */

/**
 * MOQT URI Fragment Identifier
 *
 * draft-ietf-moq-transport-18 §3.1.2:
 *
 * > A moqt URI fragment MUST begin with a registered fragment type
 * > identifier, followed by a colon (:), followed by a type-specific
 * > value:
 * >
 * > moqt://example.com/app#<type>:<value>
 */
export interface MoqtFragment {
  readonly type: string;
  readonly value: string;
}

/**
 * `normalizeMoqtUri()` の戻り値
 */
export interface NormalizedMoqtUri {
  /** WebTransport に渡す `https://` URL (fragment 除去済み) */
  readonly url: string;
  /** moqt URI から取り出した fragment (指定なしは `null`) */
  readonly fragment: MoqtFragment | null;
}

/**
 * fragment type identifier の許容文字 (draft-ietf-moq-transport-18 §3.1.2):
 *
 * > Fragment type identifiers MUST consist of ASCII lowercase letters,
 * > digits, and hyphens (a-z, 0-9, -).
 */
const FRAGMENT_TYPE_PATTERN = /^[a-z0-9-]+$/;

/**
 * fragment 文字列 (先頭 `#` 除去後) を type と value に分割する。
 *
 * draft-ietf-moq-transport-18 §3.1.2:
 *
 * > A moqt URI fragment MUST begin with a registered fragment type
 * > identifier, followed by a colon (:), followed by a type-specific
 * > value
 *
 * - 最初のコロンで type / value に分割する (value 中のコロンは保持する)
 * - type は ASCII 小文字 / 数字 / ハイフンのみ
 * - type / value の空文字列許容は仕様に明示が無いため、type は空不可、value は空許容とする
 */
export function parseFragment(fragment: string): MoqtFragment {
  if (fragment.length === 0) {
    throw new Error("fragment must not be empty");
  }

  const colonIndex = fragment.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("fragment must contain a colon separator");
  }

  const type = fragment.slice(0, colonIndex);
  const value = fragment.slice(colonIndex + 1);

  if (type.length === 0) {
    throw new Error("fragment type identifier must not be empty");
  }
  if (!FRAGMENT_TYPE_PATTERN.test(type)) {
    throw new Error(
      "fragment type identifier must consist of ASCII lowercase letters, digits, and hyphens",
    );
  }

  return { type, value };
}

/**
 * `moqt://` URI を WebTransport が受け付ける `https://` URL と fragment 情報に分解する。
 *
 * draft-ietf-moq-transport-18 §3.1.3:
 *
 * > When the client uses WebTransport, it constructs an https URI from
 * > the moqt URI by replacing the scheme with https.
 *
 * - `moqt://` で始まる場合: スキームを `https://` に置換する
 * - 上記以外のスキーム / 空文字列 / authority host が空の場合は `Error` を throw する
 *
 * fragment は WebTransport に渡さない (draft-ietf-moq-transport-18 §3.1.2):
 *
 * > Fragment identifiers MAY be used with moqt URIs. The fragment is not
 * > transmitted to the server; it is processed locally by the client
 * > after establishing the MOQT session.
 *
 * fragment が指定されていれば `parseFragment()` でパースして返す。指定されていなければ `null`。
 */
export function normalizeMoqtUri(url: string): NormalizedMoqtUri {
  if (url.length === 0) {
    throw new Error("url is empty");
  }

  if (!url.startsWith("moqt://")) {
    throw new Error(`url must start with moqt://, got: ${url}`);
  }
  const rest = url.slice("moqt://".length);

  // authority 部 (scheme:// の直後から最初の / ? # まで) を切り出して host を検証する
  // URL コンストラクタは `https:///path` を `https://path/` と解釈してしまうため自前で検証する
  // RFC 3986 §3.2: authority = [ userinfo "@" ] host [ ":" port ]
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const atIndex = authority.lastIndexOf("@");
  const hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);
  let host: string;
  if (hostPort.startsWith("[")) {
    // IPv6 リテラル: [::1]:port 形式
    const end = hostPort.indexOf("]");
    if (end === -1) {
      throw new Error(`url has unterminated ipv6 host: ${url}`);
    }
    host = hostPort.slice(1, end);
  } else {
    const colon = hostPort.indexOf(":");
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  }
  if (host.length === 0) {
    throw new Error(`url has empty host: ${url}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${rest}`);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }

  // URL.hash は `#` を含む。先頭の `#` を除去してから parseFragment に渡す
  const hash = parsed.hash;
  let fragment: MoqtFragment | null = null;
  if (hash.length > 0) {
    fragment = parseFragment(hash.startsWith("#") ? hash.slice(1) : hash);
  }
  parsed.hash = "";
  return { url: parsed.toString(), fragment };
}
