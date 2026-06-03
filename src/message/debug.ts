/**
 * MOQT Debug Utilities
 * draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK)
 */

import { MessageType } from "./types";

/**
 * REQUEST_OK の textual alias マッピング
 *
 * draft-ietf-moq-transport-18 §10.5:
 * > This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
 * > TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK, and PUBLISH_NAMESPACE_OK
 * > to refer to a REQUEST_OK sent in response to the corresponding
 * > request type.
 *
 * Wire format 上はすべて REQUEST_OK (0x7) だが、デバッグ表示用に
 * リクエスト種別に応じた別名を提供する。
 *
 * SUBSCRIBE_OK (0x04) と FETCH_OK (0x18) は独立したメッセージタイプであり、
 * REQUEST_OK のエイリアスではない。
 */
const REQUEST_OK_ALIASES: Record<number, string> = {
  [MessageType.PUBLISH]: "PUBLISH_OK",
  0x02: "REQUEST_UPDATE_OK",
  [MessageType.TRACK_STATUS]: "TRACK_STATUS_OK",
  [MessageType.PUBLISH_NAMESPACE]: "PUBLISH_NAMESPACE_OK",
  [MessageType.SUBSCRIBE_NAMESPACE]: "SUBSCRIBE_NAMESPACE_OK",
};

/**
 * MessageType の数値から名前を取得
 */
export function getMessageTypeName(type: number): string {
  for (const [name, value] of Object.entries(MessageType)) {
    if (value === type) {
      return name;
    }
  }
  return `UNKNOWN(0x${type.toString(16)})`;
}

/**
 * REQUEST_OK のエイリアス名を取得する
 *
 * Wire format 上は REQUEST_OK (0x7) だが、どのリクエストへの応答かに
 * 応じてエイリアス名を返す。デバッグログでの表示に使用する。
 */
export function getRequestOkAliasName(requestType: number): string {
  return REQUEST_OK_ALIASES[requestType] || `REQUEST_OK(0x${requestType.toString(16)})`;
}
