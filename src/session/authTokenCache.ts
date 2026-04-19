/**
 * MOQT AUTHORIZATION_TOKEN Alias Cache
 * draft-ietf-moq-transport-17 Section 9.3.2, 9.4.1.3, 9.4.1.4
 *
 * Client と Server はそれぞれ独立した alias 空間を持つ。
 * 各エンドポイントは、自側が登録した alias (相手がトラッキングすべき) と
 * 相手が登録した alias (自側がトラッキングすべき) の 2 つを保持する。
 */

import { SessionError, SessionErrorCode } from "../error";

/**
 * Token 1 つが占めるバイト数 (draft §9.4.1.3)
 *
 * 16 バイト + Token Value のバイト数。
 */
function entrySize(tokenValueLen: number): bigint {
  return 16n + BigInt(tokenValueLen);
}

interface CacheEntry {
  tokenType: bigint;
  tokenValue: Uint8Array;
}

export class AuthTokenCache {
  private readonly _entries: Map<bigint, CacheEntry> = new Map();
  private _totalSize: bigint = 0n;
  private readonly _maxSize: bigint;

  /**
   * 新しいキャッシュを作成する
   *
   * @param maxSize Setup Option MAX_AUTH_TOKEN_CACHE_SIZE (draft §9.4.1.3)。
   *               0 の場合は alias 登録は常に容量超過扱いとなる。
   */
  constructor(maxSize: bigint) {
    this._maxSize = maxSize;
  }

  /**
   * REGISTER を試行する
   *
   * @returns `true`: 登録成功、`false`: 容量超過で登録せず
   * @throws DUPLICATE_AUTH_TOKEN_ALIAS の場合
   */
  tryRegister(alias: bigint, tokenType: bigint, tokenValue: Uint8Array): boolean {
    if (this._entries.has(alias)) {
      throw new SessionError(
        "duplicate AUTHORIZATION_TOKEN alias",
        SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS,
      );
    }
    const size = entrySize(tokenValue.length);
    const newTotal = this._totalSize + size;
    if (newTotal > this._maxSize) {
      return false;
    }
    this._entries.set(alias, { tokenType, tokenValue });
    this._totalSize = newTotal;
    return true;
  }

  /**
   * USE_ALIAS: 登録済みの alias を Token Type / Value に解決する
   *
   * draft-ietf-moq-transport-17 Section 9.3.2:
   * 未登録の alias を参照すると UNKNOWN_AUTH_TOKEN_ALIAS だが、
   * 本メソッドは単に undefined を返す。呼び出し側でエラーに変換する。
   */
  resolve(alias: bigint): { tokenType: bigint; tokenValue: Uint8Array } | undefined {
    const entry = this._entries.get(alias);
    if (entry === undefined) return undefined;
    return { tokenType: entry.tokenType, tokenValue: entry.tokenValue };
  }

  /**
   * DELETE: alias を除去する
   *
   * 未登録 alias の DELETE は no-op。
   */
  delete(alias: bigint): void {
    const entry = this._entries.get(alias);
    if (entry === undefined) return;
    this._totalSize -= entrySize(entry.tokenValue.length);
    this._entries.delete(alias);
  }

  /** 現在の登録エントリー数 */
  get size(): number {
    return this._entries.size;
  }

  /** 現在のキャッシュ合計サイズ (バイト) */
  get totalSize(): bigint {
    return this._totalSize;
  }

  /** キャッシュサイズ上限 */
  get maxSize(): bigint {
    return this._maxSize;
  }

  /** 空かどうか */
  get isEmpty(): boolean {
    return this._entries.size === 0;
  }
}
