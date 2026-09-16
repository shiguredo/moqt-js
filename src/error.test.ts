/**
 * MOQT エラー型テスト
 * draft-ietf-moq-transport-21 Section 16.11 (Error Codes)
 */

import { test, assert } from "vite-plus/test";
import {
  ClosedSubgroupError,
  DataStreamErrorCode,
  IncompleteDataError,
  MalformedTrackError,
  MoqtError,
  ProtocolViolationError,
  PublishDoneStatusCode,
  RequestError,
  RequestErrorCode,
  normalizeRequestErrorCode,
  normalizePublishDoneCode,
  normalizeSessionErrorCode,
  normalizeDataStreamErrorCode,
  SessionError,
  SessionErrorCode,
} from "./error";

test("SessionError は MoqtError として code を保持する", () => {
  const error = new SessionError("protocol violation", SessionErrorCode.PROTOCOL_VIOLATION);

  assert.instanceOf(error, SessionError);
  assert.instanceOf(error, MoqtError);
  assert.equal(error.name, "SessionError");
  assert.equal(error.message, "protocol violation");
  assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("RequestError は MoqtError として code を保持する", () => {
  const error = new RequestError("track does not exist", RequestErrorCode.DOES_NOT_EXIST);

  assert.instanceOf(error, RequestError);
  assert.instanceOf(error, MoqtError);
  assert.equal(error.name, "RequestError");
  assert.equal(error.message, "track does not exist");
  assert.equal(error.code, RequestErrorCode.DOES_NOT_EXIST);
});

test("decode 用エラーは名前と message を保持する", () => {
  const incomplete = new IncompleteDataError("need more bytes");
  const protocolViolation = new ProtocolViolationError("invalid stream type");
  const malformedTrack = new MalformedTrackError("duplicate immutable properties");

  assert.equal(incomplete.name, "IncompleteDataError");
  assert.equal(incomplete.message, "need more bytes");
  assert.equal(protocolViolation.name, "ProtocolViolationError");
  assert.equal(protocolViolation.message, "invalid stream type");
  assert.equal(malformedTrack.name, "MalformedTrackError");
  assert.equal(malformedTrack.message, "duplicate immutable properties");
});

test("draft-18 の代表的なエラーコード値を保持する", () => {
  assert.equal(SessionErrorCode.PROTOCOL_VIOLATION, 0x03);
  assert.equal(SessionErrorCode.INVALID_PATH, 0x08);
  assert.equal(RequestErrorCode.MALFORMED_TRACK, 0x12);
  assert.equal(PublishDoneStatusCode.MALFORMED_TRACK, 0x12);
  assert.equal(DataStreamErrorCode.MALFORMED_TRACK, 0x12);
});

test("UNKNOWN_AUTH_TOKEN_ALIAS (0x17) は Session Termination のコードとして保持する", () => {
  // draft-ietf-moq-transport-21 §16.11.1: 0x17 は Session Termination Error Codes に
  // 収載されている。未登録 Alias の参照はこのコードの Session Termination で扱う。
  assert.equal(SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS, 0x17);
});

test("normalizeRequestErrorCode: 既知のコードはそのまま通す", () => {
  assert.equal(normalizeRequestErrorCode(0x0), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0x6), RequestErrorCode.GOING_AWAY);
  assert.equal(normalizeRequestErrorCode(0x34), RequestErrorCode.REDIRECT);
});

test("normalizeRequestErrorCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizeRequestErrorCode(0x99), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0xff), RequestErrorCode.INTERNAL_ERROR);
  // draft-ietf-moq-transport-21 §13: Grease REQUEST_ERROR codes
  assert.equal(normalizeRequestErrorCode(0x9d), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0x7f * 1 + 0x9d), RequestErrorCode.INTERNAL_ERROR);
});

test("normalizeRequestErrorCode: UNKNOWN_AUTH_TOKEN_ALIAS (0x17) は INTERNAL_ERROR に正規化", () => {
  // draft-ietf-moq-transport-21 §16.11.1 / §16.11.2:
  // 0x17 UNKNOWN_AUTH_TOKEN_ALIAS は Session Termination Error Codes にのみ収載され、
  // REQUEST_ERROR Codes には収載されていない。REQUEST_ERROR 文脈で受信した場合は
  // §13 の MUST により INTERNAL_ERROR と等価に扱う。
  assert.equal(normalizeRequestErrorCode(0x17), RequestErrorCode.INTERNAL_ERROR);
  // 受理集合は RequestErrorCode の値だけで組み立てるため、0x17 は列挙に存在しない
  assert.isFalse("UNKNOWN_AUTH_TOKEN_ALIAS" in RequestErrorCode);
});

test("normalizePublishDoneCode: 既知のコードはそのまま通す", () => {
  assert.equal(normalizePublishDoneCode(0x0), PublishDoneStatusCode.INTERNAL_ERROR);
  assert.equal(normalizePublishDoneCode(0x4), PublishDoneStatusCode.GOING_AWAY);
});

test("normalizePublishDoneCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizePublishDoneCode(0x99), PublishDoneStatusCode.INTERNAL_ERROR);
  // draft-ietf-moq-transport-21 §13: Grease PUBLISH_DONE codes
  assert.equal(normalizePublishDoneCode(0x9d), PublishDoneStatusCode.INTERNAL_ERROR);
  assert.equal(normalizePublishDoneCode(0x7f * 1 + 0x9d), PublishDoneStatusCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-21 Appendix A.2:
 * 削除された 0x3 SUBSCRIPTION_ENDED は未知コードとして
 * INTERNAL_ERROR に正規化されることを検証する。
 */
test("normalizePublishDoneCode: 削除された 0x3 は INTERNAL_ERROR に正規化", () => {
  assert.isFalse("SUBSCRIPTION_ENDED" in PublishDoneStatusCode);
  assert.equal(normalizePublishDoneCode(0x3), PublishDoneStatusCode.INTERNAL_ERROR);
});

test("normalizeSessionErrorCode: 既知のコードはそのまま通す", () => {
  assert.equal(normalizeSessionErrorCode(0x0), SessionErrorCode.NO_ERROR);
  assert.equal(normalizeSessionErrorCode(0x1), SessionErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeSessionErrorCode(0x3), SessionErrorCode.PROTOCOL_VIOLATION);
});

test("normalizeSessionErrorCode: UNKNOWN_AUTH_TOKEN_ALIAS (0x17) は Session Termination のコードとして通す", () => {
  // draft-ietf-moq-transport-21 §16.11.1: 0x17 は Session Termination Error Codes に
  // 収載されているため、Session Termination 文脈では未知コードにならない。
  assert.equal(normalizeSessionErrorCode(0x17), SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});

test("normalizeSessionErrorCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizeSessionErrorCode(0x99), SessionErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeSessionErrorCode(0x9d), SessionErrorCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-21 §16.11.1 / §13 / Appendix A.2:
 * 削除された 0x15 VERSION_NEGOTIATION_FAILED は未知コードとして
 * INTERNAL_ERROR に正規化されることを検証する。
 */
test("normalizeSessionErrorCode: 削除された 0x15 は INTERNAL_ERROR に正規化", () => {
  assert.isFalse("VERSION_NEGOTIATION_FAILED" in SessionErrorCode);
  assert.equal(normalizeSessionErrorCode(0x15), SessionErrorCode.INTERNAL_ERROR);
});

test("normalizeDataStreamErrorCode: 既知のコードはそのまま通す", () => {
  assert.equal(normalizeDataStreamErrorCode(0x0), DataStreamErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeDataStreamErrorCode(0x1), DataStreamErrorCode.CANCELLED);
});

test("normalizeDataStreamErrorCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizeDataStreamErrorCode(0x99), DataStreamErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeDataStreamErrorCode(0x9d), DataStreamErrorCode.INTERNAL_ERROR);
});

test("ClosedSubgroupError は Error を継承し name/trackAlias/groupId を保持する", () => {
  const error = new ClosedSubgroupError("subgroup is closed: trackAlias=1 groupId=3", 1n, 3n);

  assert.instanceOf(error, Error);
  assert.equal(error.name, "ClosedSubgroupError");
  assert.equal(error.message, "subgroup is closed: trackAlias=1 groupId=3");
  assert.equal(error.trackAlias, 1n);
  assert.equal(error.groupId, 3n);
});
