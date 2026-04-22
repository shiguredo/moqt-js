/**
 * MOQT Request ID 採番と検証
 * draft-ietf-moq-transport-17 Section 9.1 (Request ID), 9.2 (Required Request ID)
 */

import { SessionError, SessionErrorCode } from "../error";

/**
 * Request ID 採番器 (自側)
 * draft-ietf-moq-transport-17 Section 9.1
 *
 * moqt-js は client 専用なので偶数 (0, 2, 4, ...) を +2 ずつ採番する。
 */
export class RequestIdGenerator {
  private _next: bigint = 0n;

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
 * moqt-js は client 専用で、peer は server。
 * server は奇数採番なので parity は常に 1 を期待する。
 *
 * - parity が奇数でない → INVALID_REQUEST_ID
 * - 重複した Request ID → INVALID_REQUEST_ID
 */
export class RequestIdTracker {
  private readonly _seen: Set<bigint> = new Set();

  /**
   * 受信した Request ID を検証・記録する
   * draft-ietf-moq-transport-17 Section 9.1
   *
   * parity 検証と重複検出を行う。違反時は SessionError を返す。
   * 成功時は null を返し、内部に記録する。
   */
  accept(id: bigint): SessionError | null {
    if (id % 2n !== 1n) {
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
}
