import { base64ToArrayBuffer } from "./base64";

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
 * 文字列が Base64 として復号可能か検証する。
 *
 * C4M の Base64 はパディング省略形も許容されるため (draft-ietf-moq-msf-01 §11.1.1 の例は省略形)、
 * `atob` の許容範囲 (WHATWG forgiving-base64) をそのまま使う。
 */
function isBase64(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  try {
    base64ToArrayBuffer(value);
    return true;
  } catch {
    return false;
  }
}

/** c4m の値に置き換える伏せ字 */
const C4M_REDACTED = "c4m=<redacted>";

/**
 * c4m パラメータの値を伏せ字にする
 *
 * c4m は Base64 encoded C4M token (CAT) を持つ (draft-ietf-moq-msf-01 §11.1.1)。
 * デバッグパネルの「Copy for LLM」は不具合の報告のために外部へ貼る前提のため、
 * 値そのものを載せない。Relay URI は接続に使う値なので signal は変えず、
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
