/**
 * MOQT Debug Utilities
 * draft-ietf-moq-transport-22 §1.5 (Response Message Naming) / §9 (Control Messages)
 *
 * §1.5 は REQUEST_OK (§9.3、Type 0x07) と REQUEST_ERROR (§9.4、Type 0x05) を
 * リクエスト種別ごとの別名 (shorthand) で呼ぶ。別名は仕様文書中の呼称であり、
 * ワイヤ上の Message Type は REQUEST_OK / REQUEST_ERROR のままである。
 *
 * - REQUEST_OK の別名: PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK /
 *   SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK。
 *   実装では、リクエスト種別が判明している検証のコンテキスト名として使う
 *   (`src/session/bidi.ts` の PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK と
 *   `src/session/namespaceLoops.ts` の REQUEST_UPDATE_OK /
 *   SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK)。
 *   応答の種別判定に使う `okType` はワイヤ型 (MessageType) であり、別名ではない
 * - REQUEST_ERROR の別名: SUBSCRIBE_ERROR / FETCH_ERROR / PUBLISH_ERROR /
 *   SUBSCRIBE_NAMESPACE_ERROR / SUBSCRIBE_TRACKS_ERROR / PUBLISH_NAMESPACE_ERROR /
 *   TRACK_STATUS_ERROR / REQUEST_UPDATE_ERROR。実行時の文言・表示では使わない
 *   (理由は `src/session/bidi.ts` の `requestLabel` の JSDoc)
 * - SUBSCRIBE_OK (§9.7、Type 0x04) と FETCH_OK (§9.12、Type 0x18) は独立した
 *   ワイヤメッセージであり、REQUEST_OK の別名ではない
 *
 * この別名一覧は draft-ietf-moq-transport-22 §1.5 の記述であり、将来のドラフトで
 * 変わり得る。
 */

import { MessageType } from "./types";

/**
 * MessageType の数値から名前を取得
 *
 * 返すのはワイヤ名 (例: REQUEST_OK / REQUEST_ERROR) であり、§1.5 の別名
 * (例: PUBLISH_OK / SUBSCRIBE_ERROR) ではない。デバッグ表示とワイヤの対応を
 * 読み取りやすくするためである。
 */
export function getMessageTypeName(type: number): string {
  for (const [name, value] of Object.entries(MessageType)) {
    if (value === type) {
      return name;
    }
  }
  return `UNKNOWN(0x${type.toString(16)})`;
}
