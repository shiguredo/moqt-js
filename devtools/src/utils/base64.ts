/**
 * Base64 文字列を ArrayBuffer に変換する。
 *
 * WebTransport の `serverCertificateHashes[].value` は ArrayBuffer を要求するため、
 * URL クエリやフォームで受け取った Base64 文字列をここで変換する。
 * 不正な Base64 文字列に対しては `atob` が例外を投げる。
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
