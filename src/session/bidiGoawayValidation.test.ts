/**
 * session/bidi.ts の単体テスト: validateNoDuplicateGoawayOnRequestStream
 *
 * リクエストストリーム上の重複 GOAWAY を検出する
 * validateNoDuplicateGoawayOnRequestStream の挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import { validateNoDuplicateGoawayOnRequestStream } from "./bidi";

// ============================================================================
// validateNoDuplicateGoawayOnRequestStream のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
 * リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION。
 * 初回の Request ID は seenSet に追加され null を返す。
 */
test("validateNoDuplicateGoawayOnRequestStream: 初回は null で seenSet に追加される", () => {
  const seen = new Set<bigint>();
  const error = validateNoDuplicateGoawayOnRequestStream(0n, seen);
  assert.isNull(error);
  assert.isTrue(seen.has(0n));
});

/**
 * 2 回目の同一 Request ID は重複として PROTOCOL_VIOLATION の SessionError を返す。
 */
test("validateNoDuplicateGoawayOnRequestStream: 2 回目は PROTOCOL_VIOLATION を返す", () => {
  const seen = new Set<bigint>([0n]);
  const error = validateNoDuplicateGoawayOnRequestStream(0n, seen);
  assert.isNotNull(error);
  assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(error.message.includes("received duplicate goaway on request stream"));
});
