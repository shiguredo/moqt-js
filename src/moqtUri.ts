/**
 * MOQT URI スキーム処理
 *
 * draft-ietf-moq-transport-18 §3.1.1 (MOQT URI Scheme)
 * draft-ietf-moq-transport-18 §3.1.2 (Fragment Identifiers)
 * draft-ietf-moq-transport-18 §3.1.3 (WebTransport)
 */

/**
 * `moqt://` URI を WebTransport が受け付ける `https://` URL へ変換する。
 *
 * draft-ietf-moq-transport-18 §3.1.3:
 *
 * > When the client uses WebTransport, it constructs an https URI from
 * > the moqt URI by replacing the scheme with https.
 *
 * - `moqt://` で始まる場合: スキームを `https://` に置換し fragment を除去する
 * - 上記以外のスキーム / 空文字列は `Error` を throw する
 * - authority の host が空の場合は `Error` を throw する (draft-ietf-moq-transport-18 §3.1.1)
 *
 * fragment は WebTransport に渡さない (draft-ietf-moq-transport-18 §3.1.2):
 *
 * > Fragment identifiers MAY be used with moqt URIs. The fragment is not
 * > transmitted to the server; it is processed locally by the client
 * > after establishing the MOQT session.
 */
export function normalizeMoqtUri(url: string): string {
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
  parsed.hash = "";
  return parsed.toString();
}
