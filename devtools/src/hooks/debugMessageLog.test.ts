import { test, assert, beforeEach } from "vite-plus/test";
import type { DebugMessage } from "moqt-js";
import { getMessageTypeName } from "../../../src/message/debug.ts";
import { MessageType } from "../../../src/message/types.ts";
import { __resetLogStateForTest, getLogBuffer } from "../signals/debugLog";
import { logDebugMessage } from "./debugMessageLog";

/**
 * ログの payload の扱い
 *
 * AUTHORIZATION_TOKEN を載せうるメッセージの payload を残すと、画面の Binary タブ、
 * 行コピー、Copy for LLM の hex dump に認可トークンのバイト列が出る。残さないことを
 * ここで固定する。
 */

// ログへ残す必要がある値 (認可トークンではない別の setup option)
const TOKENISH_PAYLOAD = new Uint8Array([0x03, 0x00, 0x04, 0xde, 0xad, 0xbe, 0xef]);

beforeEach(() => {
  __resetLogStateForTest();
});

/** moqt-js のメッセージ型から DebugMessage を組み立てる */
function makeMessage(type: number, payload: Uint8Array = TOKENISH_PAYLOAD): DebugMessage {
  return {
    direction: "send",
    type,
    // 実際に moqt-js が載せる名前を使う (名前がずれたらこのテストが落ちる)
    typeName: getMessageTypeName(type),
    payload,
    timestamp: 0,
  };
}

/** ログに残った payload を返す */
function storedPayload(): Uint8Array | undefined {
  const [entry] = getLogBuffer();
  if (entry === undefined) {
    throw new Error("expected exactly one log entry");
  }
  return entry.payload;
}

// draft-ietf-moq-transport-21 §9.1.4 (SETUP の Setup Option) と §9.20.3
// (AUTHORIZATION_TOKEN Message Parameter) でトークンを載せうる型
const CREDENTIAL_MESSAGE_TYPES: readonly number[] = [
  MessageType.SETUP,
  MessageType.PUBLISH,
  MessageType.SUBSCRIBE,
  MessageType.FETCH,
  MessageType.TRACK_STATUS,
  MessageType.PUBLISH_NAMESPACE,
  MessageType.SUBSCRIBE_NAMESPACE,
  MessageType.SUBSCRIBE_TRACKS,
  MessageType.REQUEST_UPDATE,
];

test("logDebugMessage: 認可トークンを載せうるメッセージの payload はログに残さない", () => {
  for (const type of CREDENTIAL_MESSAGE_TYPES) {
    __resetLogStateForTest();
    logDebugMessage("[publisher]", makeMessage(type));

    assert.equal(storedPayload(), undefined, `${getMessageTypeName(type)} の payload`);
    // 何バイトだったかと、メッセージの種別は読める
    const [entry] = getLogBuffer();
    assert.isDefined(entry);
    assert.include(entry.message, getMessageTypeName(type));
    assert.deepEqual(entry.data, { type, payloadSize: TOKENISH_PAYLOAD.length });
  }
});

test("logDebugMessage: 認可トークンを載せないメッセージの payload は今までどおり残す", () => {
  // 残さない対象を広げすぎていないことを確かめる
  const keptTypes: readonly number[] = [
    MessageType.SUBSCRIBE_OK,
    MessageType.FETCH_OK,
    MessageType.PUBLISH_DONE,
    MessageType.GOAWAY,
    MessageType.REQUEST_OK,
    MessageType.REQUEST_ERROR,
  ];

  for (const type of keptTypes) {
    __resetLogStateForTest();
    logDebugMessage("[subscriber-1]", makeMessage(type));

    const stored = storedPayload();
    assert.isDefined(stored, `${getMessageTypeName(type)} の payload`);
    // ログ保持に備えた独立コピーであること (元のバッファと共有しない)
    assert.notStrictEqual(stored.buffer, TOKENISH_PAYLOAD.buffer);
    assert.deepEqual(Array.from(stored), Array.from(TOKENISH_PAYLOAD));
  }
});

test("logDebugMessage: 認可トークンを載せうるメッセージでも、空の payload は undefined のまま", () => {
  // 空の payload は今までも残していない (上限 0 バイト)
  logDebugMessage("[publisher]", makeMessage(MessageType.SUBSCRIBE, new Uint8Array()));
  assert.equal(storedPayload(), undefined);
});
