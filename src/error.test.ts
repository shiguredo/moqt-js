/**
 * MOQT エラー型テスト
 * draft-ietf-moq-transport-22 Section 16.11 (Error Codes)
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
  peerStreamErrorCode,
  SessionError,
  SessionErrorCode,
} from "./error";
import { isPublishDoneErrorStatus } from "./message/types";

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

/**
 * draft-ietf-moq-transport-23 §12.2:
 * ProtocolViolationError は受信した違反に対応する Session Termination Code を
 * 保持する。code を指定しない場合は「他に specific なコードが当てはまらない」
 * ことを表す PROTOCOL_VIOLATION になる。
 */
test("ProtocolViolationError は §12.2 の code を保持し、省略時は PROTOCOL_VIOLATION になる", () => {
  const explicit = new ProtocolViolationError(
    "invalid datagram type",
    SessionErrorCode.INVALID_STREAM_HEADER,
  );
  assert.equal(explicit.code, SessionErrorCode.INVALID_STREAM_HEADER);

  const fallback = new ProtocolViolationError("track name must not be empty");
  assert.equal(fallback.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("normalizeRequestErrorCode: 既知のコードはそのまま通す", () => {
  assert.equal(normalizeRequestErrorCode(0x0), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0x6), RequestErrorCode.GOING_AWAY);
  assert.equal(normalizeRequestErrorCode(0x34), RequestErrorCode.REDIRECT);
});

test("normalizeRequestErrorCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizeRequestErrorCode(0x99), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0xff), RequestErrorCode.INTERNAL_ERROR);
  // draft-ietf-moq-transport-22 §13: Grease REQUEST_ERROR codes
  assert.equal(normalizeRequestErrorCode(0x9d), RequestErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeRequestErrorCode(0x7f * 1 + 0x9d), RequestErrorCode.INTERNAL_ERROR);
});

test("normalizeRequestErrorCode: UNKNOWN_AUTH_TOKEN_ALIAS (0x17) は INTERNAL_ERROR に正規化", () => {
  // draft-ietf-moq-transport-22 §16.11.1 / §16.11.2:
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
  // draft-ietf-moq-transport-22 §13: Grease PUBLISH_DONE codes
  assert.equal(normalizePublishDoneCode(0x9d), PublishDoneStatusCode.INTERNAL_ERROR);
  assert.equal(normalizePublishDoneCode(0x7f * 1 + 0x9d), PublishDoneStatusCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-22 §A.3 (draft-20 で削除):
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
  // draft-ietf-moq-transport-22 §16.11.1: 0x17 は Session Termination Error Codes に
  // 収載されているため、Session Termination 文脈では未知コードにならない。
  assert.equal(normalizeSessionErrorCode(0x17), SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});

test("normalizeSessionErrorCode: 未知のコードは INTERNAL_ERROR に正規化", () => {
  assert.equal(normalizeSessionErrorCode(0x99), SessionErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeSessionErrorCode(0x9d), SessionErrorCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-23 §12.2:
 * 0x200-0x4FF の新コードを既知コードとして保持する。範囲でカテゴリを推定して
 * 認証や回復の意味に置き換えないため、normalizer は範囲ではなく登録値の集合で
 * 判定する。
 */
test("normalizeSessionErrorCode: §12.2 の新コードを既知コードとして保持する", () => {
  assert.equal(normalizeSessionErrorCode(0x6), SessionErrorCode.MALFORMED_KEY_VALUE);
  assert.equal(normalizeSessionErrorCode(0x200), SessionErrorCode.INVALID_STREAM_HEADER);
  assert.equal(normalizeSessionErrorCode(0x201), SessionErrorCode.MALFORMED_OBJECT);
  assert.equal(normalizeSessionErrorCode(0x202), SessionErrorCode.INVALID_OBJECT_STATUS);
  assert.equal(normalizeSessionErrorCode(0x203), SessionErrorCode.TRUNCATED_OBJECT);
  assert.equal(normalizeSessionErrorCode(0x300), SessionErrorCode.MALFORMED_MESSAGE);
  assert.equal(normalizeSessionErrorCode(0x301), SessionErrorCode.INVALID_FIELD);
  assert.equal(normalizeSessionErrorCode(0x302), SessionErrorCode.INVALID_TRACK_NAMESPACE);
  assert.equal(normalizeSessionErrorCode(0x303), SessionErrorCode.UNEXPECTED_MESSAGE);
  assert.equal(normalizeSessionErrorCode(0x304), SessionErrorCode.ROLE_VIOLATION);
  assert.equal(normalizeSessionErrorCode(0x305), SessionErrorCode.INVALID_PARAMETER);
  assert.equal(normalizeSessionErrorCode(0x306), SessionErrorCode.CLOSED_CONTROL_STREAM);
  assert.equal(normalizeSessionErrorCode(0x400), SessionErrorCode.DELTA_ENCODING_OVERFLOW);
  assert.equal(normalizeSessionErrorCode(0x401), SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

/**
 * draft-ietf-moq-transport-23 §12.2 / §13:
 * 0x200-0x4FF の範囲内でも登録されていない値は、範囲からカテゴリを推定して
 * 別のコードへ読み替えず INTERNAL_ERROR にする。GREASE 値も同様である。
 */
test("normalizeSessionErrorCode: §12.2 の範囲内の未知コードも INTERNAL_ERROR にする", () => {
  // 0x200-0x2FF の範囲だが未登録
  assert.equal(normalizeSessionErrorCode(0x210), SessionErrorCode.INTERNAL_ERROR);
  // 0x300-0x3FF の範囲だが未登録
  assert.equal(normalizeSessionErrorCode(0x310), SessionErrorCode.INTERNAL_ERROR);
  // 0x400-0x4FF の範囲だが未登録
  assert.equal(normalizeSessionErrorCode(0x402), SessionErrorCode.INTERNAL_ERROR);
  // GREASE 値 (0x7f * N + 0x9d) は範囲内でも未知コードとして扱う
  assert.equal(normalizeSessionErrorCode(0x7f * 5 + 0x9d), SessionErrorCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-23 §12.2:
 * 0x06 は MALFORMED_KEY_VALUE に改名された。旧名が公開 API に残らないことを
 * 名前空間の列挙で確認する (文字列名の互換別名は提供しない)。
 */
test("SessionErrorCode: 0x06 は MALFORMED_KEY_VALUE で旧名 KEY_VALUE_FORMATTING_ERROR を持たない", () => {
  assert.equal(SessionErrorCode.MALFORMED_KEY_VALUE, 0x6);
  assert.isFalse("KEY_VALUE_FORMATTING_ERROR" in SessionErrorCode);
});

/**
 * draft-ietf-moq-transport-22 §16.11.1 / §13 / Appendix A.3:
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

/**
 * ピアの RESET_STREAM で失敗した read / write の失敗値 (WebTransportError) から、
 * Data Stream Reset の error code を取り出す。
 *
 * draft-ietf-moq-transport-22 Section 12.5: 理由ごとに code が決まっている。
 * Section 13: 未知の code は INTERNAL_ERROR として扱う。数値の code を持たない失敗値
 * (code を渡さない実装、stream 以外の失敗) からは取り出さない。
 */
test("peerStreamErrorCode: 数値の streamErrorCode を正規化して返し、無ければ undefined を返す", () => {
  // 既知の code はそのまま
  assert.equal(
    peerStreamErrorCode(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x2 }),
    ),
    DataStreamErrorCode.DELIVERY_TIMEOUT,
  );
  assert.equal(
    peerStreamErrorCode(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x5 }),
    ),
    DataStreamErrorCode.TOO_FAR_BEHIND,
  );
  // 未知の code は INTERNAL_ERROR
  assert.equal(
    peerStreamErrorCode(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x99 }),
    ),
    DataStreamErrorCode.INTERNAL_ERROR,
  );
  // code が無い、数値でない、object でない失敗値からは取り出さない
  assert.isUndefined(peerStreamErrorCode(Object.assign(new Error("reset"), { source: "stream" })));
  assert.isUndefined(
    peerStreamErrorCode(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: "2" }),
    ),
  );
  assert.isUndefined(peerStreamErrorCode("reset"));
  assert.isUndefined(peerStreamErrorCode(null));
});

test("ClosedSubgroupError は Error を継承し name/trackAlias/groupId を保持する", () => {
  const error = new ClosedSubgroupError("subgroup is closed: trackAlias=1 groupId=3", 1n, 3n);

  assert.instanceOf(error, Error);
  assert.equal(error.name, "ClosedSubgroupError");
  assert.equal(error.message, "subgroup is closed: trackAlias=1 groupId=3");
  assert.equal(error.trackAlias, 1n);
  assert.equal(error.groupId, 3n);
});

// ============================================================================
// draft-ietf-moq-transport-23 §12.3-§12.5 / §13 の登録コード同期
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §12.3: REQUEST_ERROR に UNAVAILABLE (0x0A) が
 * 追加された。既知コードとして保持し、INTERNAL_ERROR に正規化しない。
 * draft-22 の PREFIX_OVERLAP (0x30) は削除されたため、受信時は §13 の
 * 未知コードとして INTERNAL_ERROR になる。
 */
test("normalizeRequestErrorCode: UNAVAILABLE を保持し、削除された PREFIX_OVERLAP は未知名", () => {
  assert.equal(RequestErrorCode.UNAVAILABLE, 0x0a);
  assert.equal(normalizeRequestErrorCode(0x0a), RequestErrorCode.UNAVAILABLE);
  // 削除された 0x30
  assert.equal(normalizeRequestErrorCode(0x30), RequestErrorCode.INTERNAL_ERROR);
  // GREASE も未知扱い
  assert.equal(normalizeRequestErrorCode(0x1f), RequestErrorCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-23 §12.4: PUBLISH_DONE に EXPIRED_AUTH_TOKEN (0x7) が
 * 追加された。同じ名前でも Session Termination (0x18) / REQUEST_ERROR (0x5) /
 * Stream Reset (0x7) は別のコード空間であり、共通化しない。
 */
test("正常系: PUBLISH_DONE の EXPIRED_AUTH_TOKEN は各文脈で独立したコード", () => {
  assert.equal(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN, 0x7);
  // 認可トークン期限切れは購読のエラー終了として扱う
  assert.isTrue(isPublishDoneErrorStatus(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN));
  assert.equal(normalizePublishDoneCode(0x7), PublishDoneStatusCode.EXPIRED_AUTH_TOKEN);
  // 各文脈の EXPIRED_AUTH_TOKEN は異なる
  assert.equal(RequestErrorCode.EXPIRED_AUTH_TOKEN, 0x5);
  assert.equal(SessionErrorCode.EXPIRED_AUTH_TOKEN, 0x18);
  assert.equal(DataStreamErrorCode.EXPIRED_AUTH_TOKEN, 0x7);
  // 文脈違いの数値を混同しない: PUBLISH_DONE 0x7 を Request の 0x7 として扱わない
  assert.equal(normalizeRequestErrorCode(0x7), RequestErrorCode.INTERNAL_ERROR);
  // PUBLISH_DONE に存在しない 0x3 (draft-22 の削除済みコード) は未知扱い
  assert.equal(normalizePublishDoneCode(0x3), PublishDoneStatusCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-23 §12.5 / §13: Stream Reset から
 * UNKNOWN_OBJECT_STATUS (0x6) が削除された。0x6 は未知コードとして
 * INTERNAL_ERROR に正規化する。
 */
test("normalizeDataStreamErrorCode: 削除された UNKNOWN_OBJECT_STATUS は未知名", () => {
  assert.equal(normalizeDataStreamErrorCode(0x6), DataStreamErrorCode.INTERNAL_ERROR);
  assert.equal(normalizeDataStreamErrorCode(0x7), DataStreamErrorCode.EXPIRED_AUTH_TOKEN);
  assert.equal(normalizeDataStreamErrorCode(0x12), DataStreamErrorCode.MALFORMED_TRACK);
});
