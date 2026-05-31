/**
 * MOQT エラー型テスト
 * draft-ietf-moq-transport-18 Section 15.10 (Error Codes)
 */

import { test, assert } from "vite-plus/test";
import {
  DataStreamErrorCode,
  IncompleteDataError,
  MalformedTrackError,
  MoqtError,
  ProtocolViolationError,
  PublishDoneCode,
  RequestError,
  RequestErrorCode,
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
  assert.equal(PublishDoneCode.MALFORMED_TRACK, 0x12);
  assert.equal(DataStreamErrorCode.MALFORMED_TRACK, 0x12);
});
