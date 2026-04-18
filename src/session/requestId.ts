/**
 * MOQT Request ID 採番と検証
 * draft-ietf-moq-transport-17 Section 9.1 (Request ID), 9.2 (Required Request ID)
 */

import { SessionError, SessionErrorCode } from "../error";
import type { Role } from "./types";

/**
 * Request ID 採番器 (自側)
 * draft-ietf-moq-transport-17 Section 9.1
 *
 * - Client は偶数 (0, 2, 4, ...) を採番
 * - Server は奇数 (1, 3, 5, ...) を採番
 * - 各エンドポイントは +2 ずつインクリメント
 */
export class RequestIdGenerator {
  private _next: bigint;

  constructor(role: Role) {
    this._next = role === "client" ? 0n : 1n;
  }

  /**
   * 次の Request ID を発行する
   * draft-ietf-moq-transport-17 Section 9.1
   */
  nextId(): bigint {
    const id = this._next;
    this._next += 2n;
    return id;
  }

  /** 次回発行予定の Request ID (peek) */
  peek(): bigint {
    return this._next;
  }
}

/**
 * 相手側の Request ID 追跡器
 * draft-ietf-moq-transport-17 Section 9.1
 *
 * - parity が送信者の role と合わない → INVALID_REQUEST_ID
 * - 重複した Request ID → INVALID_REQUEST_ID
 */
export class RequestIdTracker {
  private readonly _peerRole: Role;
  private readonly _seen: Set<bigint>;

  constructor(peerRole: Role) {
    this._peerRole = peerRole;
    this._seen = new Set();
  }

  /**
   * 受信した Request ID を検証・記録する
   * draft-ietf-moq-transport-17 Section 9.1
   *
   * parity 検証と重複検出を行う。違反時は SessionError を返す。
   * 成功時は null を返し、内部に記録する。
   */
  accept(id: bigint): SessionError | null {
    const expectedParity = this._peerRole === "client" ? 0n : 1n;
    if (id % 2n !== expectedParity) {
      return new SessionError(
        "request id has wrong parity for sender",
        SessionErrorCode.INVALID_REQUEST_ID,
      );
    }
    if (this._seen.has(id)) {
      return new SessionError("duplicate request id", SessionErrorCode.INVALID_REQUEST_ID);
    }
    this._seen.add(id);
    return null;
  }

  /**
   * Required Request ID Delta を検証する
   * draft-ietf-moq-transport-17 Section 9.2 (Required Request ID)
   *
   * - delta == 0: 依存なし、常に OK
   * - 2 * delta > request_id: INVALID_REQUIRED_REQUEST_ID
   *
   * JS の bigint は任意精度のため u64 オーバーフローを考慮する必要はない。
   */
  static validateRequiredDelta(requestId: bigint, delta: bigint): SessionError | null {
    if (delta === 0n) {
      return null;
    }
    if (2n * delta > requestId) {
      return new SessionError(
        "2 * Required Request ID Delta exceeds Request ID",
        SessionErrorCode.INVALID_REQUIRED_REQUEST_ID,
      );
    }
    return null;
  }

  /** 受信済み Request ID の数 (診断用) */
  get seenCount(): number {
    return this._seen.size;
  }

  /** 相手側の役割 */
  get peerRole(): Role {
    return this._peerRole;
  }
}
