/**
 * MOQT Fetch Messages
 * draft-ietf-moq-transport-23 §9.11 (FETCH)
 *
 * draft-ietf-moq-transport-23 §9.3 / Appendix A.1: FETCH の成功応答は
 * REQUEST_OK (Type 0x07) に統合され、専用の FETCH_OK (0x18) は予約値になった。
 * このファイルは FETCH 要求のペイロードだけを扱う。成功応答は
 * ./session の REQUEST_OK codec で読み書きする。
 *
 * 制御メッセージのフレーミング (Type / Message Length) は
 * draft-ietf-moq-transport-23 §9 に従う。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { assertLengthWithinData } from "../length";
import { ProtocolViolationError } from "../error";
import {
  type Parameter,
  type TrackNamespace,
  decodeParameters,
  decodeTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
  validateFullTrackNameBytes,
} from "./parameter";
import { MessageType } from "./types";

/**
 * FETCH メッセージ (draft-ietf-moq-transport-23 §9.11 FETCH)
 *
 * FETCH Message {
 *   Type (vi64) = 0x16,
 *   Length (vi64),
 *   Request ID (vi64),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * 取得する範囲は LOCATION_FILTER パラメータ (0x21) で指定する (§9.19.9)。
 * パラメータを省略した場合、フィルタなしとして {0, 0} から Largest Object
 * までの全オブジェクトを要求する (§3.2)。FETCH で使える Location Filter は
 * None (0x00) と絶対指定 (0x02 / 0x03 / 0x04) のみである。相対指定 (0x01) は
 * §3.2 が相対 Location Filter の FETCH を INVALID_RANGE と定める。Next Object
 * (0x05) は Largest Object + 1 を指して既存 Object の範囲にならない。どちらも
 * 送信前に拒否する (詳細は resolveFetchRequestRange)。
 */
export interface Fetch {
  type: typeof MessageType.FETCH;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * Fetch のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 §9.11 (FETCH):
 * FETCH は Track Namespace / Track Name + Parameters のみを持つ
 * (draft-19 の Fetch Type / Start / End Location フィールドは削除された)。
 */
export function encodeFetchPayload(msg: Fetch): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeParameters(msg.parameters));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Fetch のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeFetchPayload(data: Uint8Array, offset = 0): Fetch {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [trackNameLen, trackNameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackNameLenSize;

  assertLengthWithinData("fetch track name", trackNameLen, offset + totalConsumed, data.length);
  const trackName = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(trackNameLen),
  );
  totalConsumed += Number(trackNameLen);

  // draft-ietf-moq-transport-23 §8.7:
  // Full Track Name (Namespace + Track Name 合計) が 4096 バイト超過は
  // FIELD_LENGTH_EXCEEDED でセッションを閉じる。現行の受信経路はエラー分類の
  // 移行まで PROTOCOL_VIOLATION として扱う。ワイヤバイト長で計測する
  // (不正 UTF-8 の置換による誤計測を防ぐ)
  validateFullTrackNameBytes(trackNamespace, trackName);

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a MALFORMED_MESSAGE."
  // 現行の受信経路はエラー分類の移行まで PROTOCOL_VIOLATION として扱う。
  // Parameters は FETCH ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in FETCH: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.FETCH,
    requestId,
    trackNamespace,
    trackName,
    parameters,
  };
}
