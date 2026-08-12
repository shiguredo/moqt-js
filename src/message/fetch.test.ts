/**
 * MOQT Fetch Messages Unit Tests
 * draft-ietf-moq-transport-19 Section 10.12 (FETCH)
 *
 * encodeFetchPayload の構造検証 (Fetch Type と Standalone / Joining の整合) を
 * 検証する。整合の取れた値のみを生成する PBT ではエラーパスを生成できないため、
 * 固定の不正入力で単体テストする。
 */

import { test, assert } from "vite-plus/test";
import { type Fetch, FetchType, encodeFetchPayload } from "./fetch";
import { createTrackNamespace } from "./parameter";
import { MessageType } from "./types";
import { ProtocolViolationError } from "../error";

/**
 * 正常な Standalone Fetch を構築する
 */
function createStandaloneFetch(): Fetch {
  return {
    type: MessageType.FETCH,
    requestId: 0n,
    fetchType: FetchType.STANDALONE,
    standalone: {
      trackNamespace: createTrackNamespace(["test"]),
      trackName: new TextEncoder().encode("track"),
      startLocation: { group: 0n, object: 0n },
      endLocation: { group: 10n, object: 0n },
    },
    parameters: [],
  };
}

/**
 * 正常な Joining Fetch を構築する
 */
function createJoiningFetch(fetchType: FetchType): Fetch {
  return {
    type: MessageType.FETCH,
    requestId: 0n,
    fetchType,
    joining: {
      joiningRequestId: 1n,
      joiningStart: 0n,
    },
    parameters: [],
  };
}

/**
 * draft-ietf-moq-transport-19 Section 10.12 (FETCH):
 * Fetch Type が 0x1 / 0x2 / 0x3 以外の場合はエンコード前に throw する。
 * エラーは自コードの防御であり、decode 側の ProtocolViolationError とは
 * 区別してプレーンな Error で throw する。
 */
test("encodeFetchPayload: 不正な Fetch Type で throw する", () => {
  const msg = createStandaloneFetch();
  msg.fetchType = 0x04 as FetchType;

  // 自コードの防御のため、decode 側の ProtocolViolationError ではない
  // プレーンな Error で throw することを検証する
  let thrown: unknown;
  try {
    encodeFetchPayload(msg);
  } catch (error) {
    thrown = error;
  }
  assert.isDefined(thrown);
  assert.isFalse(thrown instanceof ProtocolViolationError);
  assert.isTrue(thrown instanceof Error);
  assert.isTrue(
    (thrown as Error).message.includes("unknown fetch type: 0x4, expected 0x1, 0x2, or 0x3"),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.1 (Standalone Fetch):
 * Fetch Type 0x1 (STANDALONE) は standalone 構造が必須。
 */
test("encodeFetchPayload: STANDALONE で standalone がないと throw する", () => {
  const msg = createStandaloneFetch();
  delete msg.standalone;

  assert.throws(() => encodeFetchPayload(msg), /standalone fetch requires a standalone structure/);
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.1 (Standalone Fetch):
 * 型外入力の防御として、standalone が null の場合も構造未設定として拒否する。
 */
test("encodeFetchPayload: STANDALONE で standalone が null だと throw する", () => {
  const msg = createStandaloneFetch();
  (msg as { standalone: unknown }).standalone = null;

  assert.throws(() => encodeFetchPayload(msg), /standalone fetch requires a standalone structure/);
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.1 (Standalone Fetch):
 * Fetch Type 0x1 (STANDALONE) に joining 構造を含めることはできない。
 */
test("encodeFetchPayload: STANDALONE で joining があると throw する", () => {
  const msg = createStandaloneFetch();
  msg.joining = {
    joiningRequestId: 1n,
    joiningStart: 0n,
  };

  assert.throws(
    () => encodeFetchPayload(msg),
    /standalone fetch must not contain a joining structure/,
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches):
 * Fetch Type 0x2 / 0x3 (JOINING 系) は joining 構造が必須。
 */
test("encodeFetchPayload: JOINING 系で joining がないと throw する", () => {
  const msg = createJoiningFetch(FetchType.RELATIVE_JOINING);
  delete msg.joining;

  assert.throws(() => encodeFetchPayload(msg), /joining fetch requires a joining structure/);
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches):
 * 型外入力の防御として、joining が null の場合も構造未設定として拒否する。
 */
test("encodeFetchPayload: JOINING 系で joining が null だと throw する", () => {
  const msg = createJoiningFetch(FetchType.RELATIVE_JOINING);
  (msg as { joining: unknown }).joining = null;

  assert.throws(() => encodeFetchPayload(msg), /joining fetch requires a joining structure/);
});

/**
 * draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches):
 * Fetch Type 0x2 / 0x3 (JOINING 系) に standalone 構造を含めることはできない。
 */
test("encodeFetchPayload: JOINING 系で standalone があると throw する", () => {
  const msg = createJoiningFetch(FetchType.ABSOLUTE_JOINING);
  msg.standalone = createStandaloneFetch().standalone;

  assert.throws(
    () => encodeFetchPayload(msg),
    /joining fetch must not contain a standalone structure/,
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10.12 (FETCH):
 * 正常な 3 種の Fetch Type は従来どおりエンコードされる。
 */
test("encodeFetchPayload: 正常な 3 種の Fetch Type はエンコードされる", () => {
  assert.doesNotThrow(() => encodeFetchPayload(createStandaloneFetch()));
  assert.doesNotThrow(() => encodeFetchPayload(createJoiningFetch(FetchType.RELATIVE_JOINING)));
  assert.doesNotThrow(() => encodeFetchPayload(createJoiningFetch(FetchType.ABSOLUTE_JOINING)));
});
