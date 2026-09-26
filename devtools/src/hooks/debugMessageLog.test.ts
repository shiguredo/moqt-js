import { test, assert, beforeEach } from "vite-plus/test";
import type { DebugMessage } from "moqt-js";
import { getMessageTypeName } from "../../../src/message/debug.ts";
import { MessageType } from "../../../src/message/types.ts";
import { __resetLogStateForTest, getLogBuffer } from "../signals/debugLog";
import { CREDENTIAL_MESSAGE_TYPES, logDebugMessage } from "./debugMessageLog";

/**
 * ログの payload の扱い
 *
 * AUTHORIZATION_TOKEN を載せうるメッセージの payload を残すと、画面の Binary タブ、
 * 行コピー、Copy for LLM の hex dump に認可トークンのバイト列が出る。残さないことを
 * ここで固定する。
 *
 * 判定はメッセージ型で行い、payload の中身は見ない。このテストの payload は
 * 中身に意味の無いサンプルである。
 */
const SAMPLE_PAYLOAD = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

beforeEach(() => {
  __resetLogStateForTest();
});

/** moqt-js のメッセージ型から DebugMessage を組み立てる */
function makeMessage(
  type: number,
  payload: Uint8Array = SAMPLE_PAYLOAD,
  decoded?: Record<string, unknown>,
): DebugMessage {
  return {
    direction: "send",
    type,
    typeName: getMessageTypeName(type),
    payload,
    timestamp: 0,
    ...(decoded === undefined ? {} : { decoded }),
  };
}

/** ログ 1 件を取り出す */
function firstEntry() {
  const [entry] = getLogBuffer();
  if (entry === undefined) {
    throw new Error("expected exactly one log entry");
  }
  return entry;
}

// draft-ietf-moq-transport-21 §9.1.4 (SETUP の Setup Option) と §9.20.3
// (AUTHORIZATION TOKEN Parameter) でトークンを載せうる型。仕様から書き出した期待値で、
// 実装の一覧 (CREDENTIAL_MESSAGE_TYPES) と一致することをテストで確かめる
const EXPECTED_CREDENTIAL_MESSAGE_TYPES: readonly number[] = [
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

/**
 * 認可トークンを載せない型と、その理由
 *
 * メッセージ型を足したら「載せうる」か「載せない (理由)」のどちらかへ分類することを
 * テストで強制する。仕様の版が上がって応答にも credential を載せられるようになったら
 * (draft-ietf-moq-privacy-pass-auth の AUTH CHALLENGE / AUTH RESPONSE など)、
 * ここを見直して載せうる側へ移す。
 */
const NON_CREDENTIAL_MESSAGE_TYPE_REASONS: Record<string, string> = {
  GOAWAY: "セッションの終了通知で、payload に credential を載せる枠が無い",
  REQUEST_OK: "応答。draft-ietf-moq-transport-21 §9.20.3 の対象は要求側の 8 型と SETUP",
  REQUEST_ERROR: "応答。エラーコードと理由のみ",
  SUBSCRIBE_OK: "応答。draft-ietf-moq-transport-21 §9.20.3 の対象は要求側の 8 型と SETUP",
  PUBLISH_DONE: "配信の終了通知 (応答)。draft-ietf-moq-transport-21 §9.20.3 の対象外",
  PUBLISH_STATE_NOTIFY: "購読の状態通知 (片方向)",
  FETCH_OK: "応答。draft-ietf-moq-transport-21 §9.20.3 の対象は要求側の 8 型と SETUP",
  PUBLISH_SKIPPED: "PUBLISH を送らないことの通知 (応答)",
  NAMESPACE: "namespace discovery の通知",
  NAMESPACE_DONE: "namespace discovery の終了通知",
};

test("CREDENTIAL_MESSAGE_TYPES: 仕様から書き出した型の一覧と一致する", () => {
  // 実装の一覧は仕様 (draft-ietf-moq-transport-21 §9.1.4 / §9.20.3) と一致していること。
  // 型を足した・消した・取り違えたらここで落ちる
  const sortNumbers = (values: Iterable<number>): number[] =>
    [...values].sort((left, right) => left - right);
  assert.deepEqual(
    sortNumbers(CREDENTIAL_MESSAGE_TYPES),
    sortNumbers(EXPECTED_CREDENTIAL_MESSAGE_TYPES),
  );
});

test("logDebugMessage: 認可トークンを載せうるメッセージの payload はログに残さない", () => {
  for (const type of EXPECTED_CREDENTIAL_MESSAGE_TYPES) {
    __resetLogStateForTest();
    logDebugMessage("[publisher]", makeMessage(type));

    const entry = firstEntry();
    assert.equal(entry.payload, undefined, `${getMessageTypeName(type)} の payload`);
    // 何バイトだったかと、payload を残さなかった理由は読める
    assert.include(entry.message, getMessageTypeName(type));
    assert.deepEqual(entry.data, {
      type,
      payloadSize: SAMPLE_PAYLOAD.length,
      payloadOmitted: "authorization-token",
    });
  }
});

test("logDebugMessage: 認可トークンを載せうるメッセージでも decoded は残す", () => {
  // どのメッセージだったかの情報 (requestId など) は診断に要る
  const type = MessageType.SUBSCRIBE;
  logDebugMessage("[subscriber-1]", makeMessage(type, SAMPLE_PAYLOAD, { requestId: 7 }));

  const entry = firstEntry();
  assert.equal(entry.payload, undefined);
  assert.deepEqual(entry.data, {
    type,
    payloadSize: SAMPLE_PAYLOAD.length,
    payloadOmitted: "authorization-token",
    requestId: 7,
  });
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

    const entry = firstEntry();
    const stored = entry.payload;
    assert.isDefined(stored, `${getMessageTypeName(type)} の payload`);
    // ログ保持に備えた独立コピーであること (元のバッファと共有しない)
    assert.notStrictEqual(stored.buffer, SAMPLE_PAYLOAD.buffer);
    assert.deepEqual(Array.from(stored), Array.from(SAMPLE_PAYLOAD));
    // payload を残した理由の欄は出さない
    assert.notProperty(entry.data as Record<string, unknown>, "payloadOmitted");
  }
});

test("logDebugMessage: payload の上限を超える分はコピーしない", () => {
  // 120 fps や 4K の映像では 1 Object が数十 KB になる。毎 Object をコピーすると
  // メインスレッドの負荷で再生がかくつくため、上限 (4096 バイト) を超えたら残さない。
  // 残さない理由は認可トークンではないため payloadOmitted は付けない
  const type = MessageType.SUBSCRIBE_OK;
  const oversized = new Uint8Array(4097);
  logDebugMessage("[subscriber-1]", makeMessage(type, oversized));

  const entry = firstEntry();
  assert.equal(entry.payload, undefined);
  assert.deepEqual(entry.data, { type, payloadSize: 4097 });

  // 上限ちょうどは残す
  __resetLogStateForTest();
  logDebugMessage("[subscriber-1]", makeMessage(type, new Uint8Array(4096)));
  assert.equal(firstEntry().payload?.length, 4096);
});

test("logDebugMessage: 認可トークンを載せうるメッセージでも、空の payload は undefined のまま", () => {
  // 空の payload は今までも残していない (0 バイト)
  logDebugMessage("[publisher]", makeMessage(MessageType.SUBSCRIBE, new Uint8Array()));
  assert.equal(firstEntry().payload, undefined);
});

test("logDebugMessage: すべてのメッセージ型が payload を残すか残さないかに分類されている", () => {
  // メッセージ型を足したら、認可トークンを載せうるかどうかを必ず判断させる。
  // 判断を忘れると payload がそのままログに残る
  const classified = new Set<string>([
    ...[...CREDENTIAL_MESSAGE_TYPES].map((type) => getMessageTypeName(type)),
    ...Object.keys(NON_CREDENTIAL_MESSAGE_TYPE_REASONS),
  ]);

  const unclassified = Object.entries(MessageType)
    .filter(([name]) => !classified.has(name))
    .map(([name]) => name);
  assert.deepEqual(unclassified, []);

  // 分類の表に、もう存在しない型が残っていないこと
  const knownNames = new Set(Object.keys(MessageType));
  const stale = [...classified].filter((name) => !knownNames.has(name));
  assert.deepEqual(stale, []);

  // 両方の表に載っている型が無いこと (載せうる側と載せない側は排他)
  const credentialNames = new Set(
    [...CREDENTIAL_MESSAGE_TYPES].map((type) => getMessageTypeName(type)),
  );
  const both = Object.keys(NON_CREDENTIAL_MESSAGE_TYPE_REASONS).filter((name) =>
    credentialNames.has(name),
  );
  assert.deepEqual(both, []);
});

test("logDebugMessage: 手入力の認可トークン (Token Value) を載せた SETUP の payload も残さない", () => {
  // c4m から取り込んだトークンだけでなく、Token Value 欄へ入力したトークンも
  // SETUP の AUTHORIZATION TOKEN Setup Option として payload に入る。
  // 本文全体の伏せ字は c4m しか対象にしないため、payload を残さないことが根拠になる
  const tokenValue = "sentinel-token-value-must-not-appear";
  const payload = new TextEncoder().encode(`AUTHORIZATION_TOKEN=${tokenValue}`);
  logDebugMessage("[publisher]", makeMessage(MessageType.SETUP, payload));

  const entry = firstEntry();
  assert.equal(entry.payload, undefined);
  assert.notInclude(entry.message, tokenValue);
  assert.notInclude(JSON.stringify(entry.data), tokenValue);
});
