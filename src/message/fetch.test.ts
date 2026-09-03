/**
 * MOQT Fetch Messages Unit Tests
 * draft-ietf-moq-transport-20 Section 10.13 (FETCH)
 *
 * ワイヤ形式を固定バイト列でピン留めする。ラウンドトリップは PBT
 * (fetch.prop.ts) が担い、ここではエンコーダとデコーダが同時に
 * 誤った形式へ移行しても気づけない「相互に一致しただけ」の状態を
 * 防ぐため、仕様の Figure 16 (FETCH Message) と突き合わせる。
 */

import { test, assert } from "vite-plus/test";
import { type Fetch, decodeFetchPayload, encodeFetchPayload } from "./fetch";
import { createTrackNamespace } from "./parameter";
import { MessageType } from "./types";
import { ProtocolViolationError } from "../error";

/**
 * 正常な Fetch を構築する
 */
function createFetch(): Fetch {
  return {
    type: MessageType.FETCH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["test"]),
    trackName: new TextEncoder().encode("track"),
    parameters: [],
  };
}

/**
 * draft-ietf-moq-transport-20 Section 10.13 (FETCH):
 * FETCH Message {
 *   Type (vi64) = 0x16,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * Fetch Type / Start Location / End Location フィールドが存在しないことを
 * 固定バイト列でピン留めする (draft-19 形式は Request ID の直後に Fetch Type
 * が入るため、バイト列が一致すれば旧形式への回帰を検出できる)。
 */
test("encodeFetchPayload: draft-20 の固定バイト列を生成する", () => {
  const msg = createFetch();

  // Request ID = 1 (0x01)
  // Track Namespace = ["test"] (1 要素、各要素は Length 付き)
  // Track Name Length = 5, Track Name = "track"
  // Number of Parameters = 0
  const expected = new Uint8Array([
    0x01, // Request ID
    0x01, // Number of Namespace Tuples
    0x04, // Tuple Length
    0x74,
    0x65,
    0x73,
    0x74, // "test"
    0x05, // Track Name Length
    0x74,
    0x72,
    0x61,
    0x63,
    0x6b, // "track"
    0x00, // Number of Parameters
  ]);

  assert.deepEqual(encodeFetchPayload(msg), expected);
});

/**
 * draft-ietf-moq-transport-20 Section 10.13 (FETCH):
 * 固定バイト列をデコードすると Request ID / Track Namespace / Track Name /
 * Parameters に復元されることを検証する。
 */
test("decodeFetchPayload: draft-20 の固定バイト列をデコードする", () => {
  const data = new Uint8Array([
    0x01, // Request ID
    0x01, // Number of Namespace Tuples
    0x04, // Tuple Length
    0x74,
    0x65,
    0x73,
    0x74, // "test"
    0x05, // Track Name Length
    0x74,
    0x72,
    0x61,
    0x63,
    0x6b, // "track"
    0x00, // Number of Parameters
  ]);

  const decoded = decodeFetchPayload(data);

  assert.equal(decoded.type, MessageType.FETCH);
  assert.equal(decoded.requestId, 1n);
  assert.deepEqual(decoded.trackName, new TextEncoder().encode("track"));
  assert.deepEqual(decoded.parameters, []);
});

/**
 * draft-ietf-moq-transport-20 Section 10:
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は FETCH ペイロードの最後のフィールドであり、その後ろに後続
 * データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 */
test("decodeFetchPayload: 末尾に後続データがあると ProtocolViolationError を throw する", () => {
  const encoded = encodeFetchPayload(createFetch());
  const withTrailing = new Uint8Array(encoded.length + 1);
  withTrailing.set(encoded, 0);
  withTrailing[encoded.length] = 0xff;

  assert.throws(() => decodeFetchPayload(withTrailing), ProtocolViolationError);
});
