/**
 * MOQT Data Stream の共通定義
 * draft-ietf-moq-transport-21 Section 11 (Data Streams and Datagrams)
 *
 * Subgroup (Section 11.3) / Datagram (Section 11.2) / Fetch (Section 11.4) の
 * 各エンコーダ・デコーダが共有する型と検証を置く。特定の転送形態に依存する
 * 実装は置かない (各モジュールが個別に持つ)。
 */

import { ObjectStatus } from "../message/types";
import { ProtocolViolationError } from "../error";

// Priority Present の型で Publisher Priority が省略された場合のエラーメッセージ
// (encodeSubgroupHeader と encodeObjectDatagram で共通)
export const ERR_PUBLISHER_PRIORITY_REQUIRED =
  "publisherPriority is required when Priority Present bit is set";

/**
 * Publisher Priority の値域を検証する
 *
 * draft-ietf-moq-transport-21 §11.1 / §11.2 / §11.3.1 / §11.4.1:
 * Publisher Priority は 8 bit (0〜255) である。範囲外・非整数は
 * Uint8Array 化で黙って丸められるため、変換前に throw する。
 * 仕様の将来版で値域が変わる可能性がある。
 *
 * @throws Error 非整数または 0〜255 外の場合 (期待値と実際値を含む)
 */
export function validatePublisherPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 255) {
    throw new Error(`invalid publisher priority: ${priority}, expected integer 0 to 255`);
  }
}

/**
 * Object Status の値を検証する
 *
 * draft-ietf-moq-transport-21 Section 11.1.2:
 * "Any other value SHOULD be treated as a protocol error and the session
 *  SHOULD be closed with a PROTOCOL_VIOLATION."
 */
export function validateObjectStatus(status: number): void {
  if (
    status !== ObjectStatus.NORMAL &&
    status !== ObjectStatus.END_OF_GROUP &&
    status !== ObjectStatus.END_OF_TRACK
  ) {
    throw new ProtocolViolationError(
      `invalid object status: 0x${status.toString(16)}, expected 0x0, 0x3, or 0x4`,
    );
  }
}

/**
 * Object in a Subgroup
 */
export interface MoqtObject {
  groupId: bigint;
  subgroupId?: bigint;
  objectId: bigint;
  /**
   * Publisher Priority
   * draft-ietf-moq-transport-21 §10.4 / §11.3.1 / §11.2.1
   *
   * Subgroup Header / Object Datagram で Priority が省略された場合 (DEFAULT_PRIORITY
   * ビットが 1) は、購読を確立した control message の DEFAULT_PUBLISHER_PRIORITY
   * Track Property (省略時 128) を継承する。受信経路 (SubscriberImpl) が配送前に
   * 解決して設定するため、フィルタ評価とアプリのコールバックでは継承値が見える。
   * FETCH オブジェクトは §11.4.1.1 Table 9 の継承規則 (直近オブジェクトの
   * Priority) で解決される。
   */
  publisherPriority?: number;
  status: ObjectStatus;
  properties?: Uint8Array;
  payload: Uint8Array;
  /**
   * Object Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.2 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property から抽出される。
   * 先頭以外・Fetch・Datagram では設定されない。
   */
  objectDeliveryTimeout?: bigint;
  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.1 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property から抽出される。
   * 先頭以外・Fetch・Datagram では設定されない。
   */
  subgroupDeliveryTimeout?: bigint;
  /**
   * fill fetch ストリーム経由で届いたかどうか
   * draft-ietf-moq-transport-21 §3.3.1 / §3.4 (Fill Semantics)
   *
   * 購読の object コールバック文脈では、true は fill-delivered (fill fetch
   * ストリーム経由)、未設定は subscription-delivered (subgroup / datagram
   * 経由) を示す。fill 範囲と subscription の Location Filter が重なると
   * 同一 Location が両経路で届き得るため、アプリはこの値で区別する。
   * FETCH (Session.fetch) 経由では設定されない。
   * 実装が false を設定することはなく、判定は真偽値として行う。
   */
  fillDelivered?: boolean;
}
