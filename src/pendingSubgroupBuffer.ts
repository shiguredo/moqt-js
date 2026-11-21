/**
 * Pending Subgroup Stream Buffer
 *
 * draft-ietf-moq-transport-23 §3.1.3.1 (Unknown Track Alias):
 *
 * > When an endpoint receives a datagram or a new stream with a Track
 * > Alias that is not yet associated with an Established subscription, it
 * > MAY drop the data or buffer it briefly to handle reordering with the
 * > control message that establishes the Track Alias.  For streams, the
 * > endpoint MAY withhold stream flow control beyond the stream header
 * > until the Track Alias has been established.  To prevent deadlocks,
 * > endpoints MUST allocate connection flow control to control streams
 * > before allocating it to any data streams; otherwise a receiver might
 * > wait for a control message containing a Track Alias to release flow
 * > control, while the sender waits for flow control to send the message.
 *
 * Track Alias 未確立の Subgroup ストリームを一時保持するバッファ。
 * "buffer it briefly" の上限管理のためバイト数、ストリーム本数、保持時間を制限する。
 * 各 entry の `notified` は Alias の確立通知または破棄時に解決する。
 */

import { concatUint8Arrays, ReceiveBuffer } from "./bytes";

type PendingNotifyReason =
  | "subscriber"
  | "timeout"
  | "overflow-per-stream"
  | "overflow-per-session"
  | "overflow-stream-count"
  | "alias-retired"
  | "session-close"
  | "reset";

type PendingDiscardReason = Exclude<PendingNotifyReason, "subscriber">;

export interface PendingSubgroupBufferOptions {
  /** per-stream のバイト上限。これを超えた entry は overflow-per-stream で abandon する */
  perStreamMaxBytes: number;
  /** per-session の合計バイト上限。これを超えた最後の entry が overflow-per-session で abandon する */
  perSessionMaxBytes: number;
  /** "buffer it briefly" の上限ミリ秒。経過したら timeout で abandon する */
  timeoutMs: number;
}

/**
 * PendingSubgroupBufferOptions のデフォルト値
 *
 * - perStreamMaxBytes: 1 MiB
 * - perSessionMaxBytes: 16 MiB
 * - timeoutMs: 5000 (draft-ietf-moq-transport-23 §3.1.3.1 "buffer it briefly")
 */
export const DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS: PendingSubgroupBufferOptions = {
  perStreamMaxBytes: 1 << 20,
  perSessionMaxBytes: 16 << 20,
  timeoutMs: 5000,
};

// §3.1.3: 短い再順序化の間だけ解除済み Alias を覚える。専用タイマーは作らない。
const RETIRED_ALIAS_MAX_AGE_MS = DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.timeoutMs;
const MAX_RETIRED_ALIASES = 1024;
// ヘッダーのみのストリームにもタイマーと待機処理が必要なため、バイト数と別に制限する。
const MAX_PENDING_SUBGROUP_STREAMS = 1024;
// 細かいチャンクが続いても、保留バイト数に比例して Uint8Array の参照を増やさない。
const MAX_PENDING_SUBGROUP_CHUNKS = 64;

class PendingSubgroupEntry {
  private readonly chunks: Uint8Array[] = [];
  private buffer: ReceiveBuffer | null = null;
  totalBytes = 0;
  private resolvedReason: PendingNotifyReason | null = null;
  private resolveNotify!: (reason: PendingNotifyReason) => void;
  private wakeRead: (() => void) | undefined;
  readonly notified: Promise<PendingNotifyReason>;
  /** @internal PendingSubgroupBuffer が timeout 解除に使う */
  timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly trackAlias: bigint) {
    this.notified = new Promise<PendingNotifyReason>((resolve) => {
      this.resolveNotify = resolve;
    });
  }

  get reason(): PendingNotifyReason | null {
    return this.resolvedReason;
  }

  /** 呼び出し元でバイト上限を確認したチャンクを保留する。 */
  appendChunk(chunk: Uint8Array, totalBytes: number): void {
    if (this.buffer !== null) {
      this.buffer.append(chunk);
    } else {
      // 小さなビューのために大きな元配列を保持し続けない。
      this.chunks.push(chunk.buffer.byteLength > 2 * chunk.byteLength ? chunk.slice() : chunk);
      if (this.chunks.length > MAX_PENDING_SUBGROUP_CHUNKS) {
        this.buffer = new ReceiveBuffer(concatUint8Arrays(this.chunks, totalBytes));
        this.chunks.length = 0;
      }
    }
    this.totalBytes = totalBytes;
  }

  /** 保留側の集計から remove した後で、受信ループへ所有権を移す。 */
  takeBuffer(): ReceiveBuffer {
    const buffer =
      this.buffer ??
      new ReceiveBuffer(
        this.chunks.length === 1
          ? this.chunks[0]!
          : concatUint8Arrays(this.chunks, this.totalBytes),
      );
    this.clearBytes();
    return buffer;
  }

  clearBytes(): void {
    this.chunks.length = 0;
    this.buffer = null;
    this.totalBytes = 0;
  }

  /** 合流通知済みでも、実際に引き継ぐ前なら破棄を優先する。 */
  discard(reason: PendingDiscardReason): void {
    if (!this.notify(reason)) {
      this.resolvedReason = reason;
    }
  }

  /** 読み取りと通知を待つ。通知側には最新の read の待機先だけを保持する。 */
  waitForRead<T>(read: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      if (this.resolvedReason === null) {
        this.wakeRead = () => resolve(undefined);
      } else {
        resolve(undefined);
      }
      // 通知が先に来ても read の失敗を観測する。合流時は呼び出し元が read を引き継ぐ。
      void read.then(resolve, reject);
    });
  }

  /**
   * 通知を発火する
   * 複数回呼ばれても resolve は最初の 1 回のみ反映される (idempotent)
   * 戻り値: 実際に resolve したか (重複呼び出しでは false)
   */
  notify(reason: PendingNotifyReason): boolean {
    if (this.resolvedReason !== null) return false;
    this.resolvedReason = reason;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.resolveNotify(reason);
    this.wakeRead?.();
    this.wakeRead = undefined;
    return true;
  }
}

export class PendingSubgroupBuffer {
  private readonly entriesByAlias = new Map<bigint, Set<PendingSubgroupEntry>>();
  private readonly retiredAliases = new Map<bigint, number>();
  private closed = false;
  private streamCountValue = 0;
  private totalBytesValue = 0;
  private readonly options: PendingSubgroupBufferOptions;

  constructor(options: Partial<PendingSubgroupBufferOptions> = {}) {
    this.options = { ...DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS, ...options };
  }

  /** 終了済み Alias を記録し、その Alias の保留ストリームをその場で破棄する。 */
  retireAlias(alias: bigint): void {
    this.retiredAliases.delete(alias);
    this.retiredAliases.set(alias, performance.now() + RETIRED_ALIAS_MAX_AGE_MS);
    if (this.retiredAliases.size > MAX_RETIRED_ALIASES) {
      const oldest = this.retiredAliases.keys().next();
      if (!oldest.done) this.retiredAliases.delete(oldest.value);
    }
    const entries = this.entriesByAlias.get(alias);
    if (entries !== undefined) {
      for (const entry of entries) {
        this.discardEntry(entry, "alias-retired");
      }
    }
  }

  /** 制御メッセージで Alias が再利用されたときは新規購読を受け付ける。 */
  reopenAlias(alias: bigint): void {
    this.retiredAliases.delete(alias);
  }

  isRetiredAlias(alias: bigint): boolean {
    const expires = this.retiredAliases.get(alias);
    if (expires === undefined) return false;
    if (expires > performance.now()) return true;
    this.retiredAliases.delete(alias);
    return false;
  }

  close(): void {
    this.closed = true;
    this.retiredAliases.clear();
    for (const entries of this.entriesByAlias.values()) {
      for (const entry of entries) {
        this.discardEntry(entry, "session-close");
      }
    }
  }

  private discardEntry(entry: PendingSubgroupEntry, reason: PendingDiscardReason): void {
    entry.discard(reason);
    this.remove(entry);
    entry.clearBytes();
  }

  /**
   * 新しい pending entry を作成して Map に追加し、timeout を起動する
   * draft-ietf-moq-transport-23 §3.1.3.1 "buffer it briefly" の上限を timeoutMs で表現する
   */
  add(trackAlias: bigint): PendingSubgroupEntry {
    const entry = new PendingSubgroupEntry(trackAlias);
    if (this.closed) {
      entry.notify("session-close");
      return entry;
    }
    if (this.streamCountValue >= MAX_PENDING_SUBGROUP_STREAMS) {
      entry.notify("overflow-stream-count");
      return entry;
    }

    let entries = this.entriesByAlias.get(trackAlias);
    if (entries === undefined) {
      entries = new Set();
      this.entriesByAlias.set(trackAlias, entries);
    }
    entries.add(entry);
    this.streamCountValue++;

    entry.timeoutHandle = setTimeout(() => {
      this.discardEntry(entry, "timeout");
    }, this.options.timeoutMs);

    return entry;
  }

  /**
   * チャンクを entry に追加する
   * 追加で上限を超える場合は、チャンクを保持する前にそのストリームを破棄する。
   */
  appendChunk(entry: PendingSubgroupEntry, chunk: Uint8Array): void {
    const chunkBytes = chunk.byteLength;
    // 解放済みや別バッファの entry に後着チャンクを計上しない。
    if (
      chunkBytes === 0 ||
      entry.reason !== null ||
      !this.entriesByAlias.get(entry.trackAlias)?.has(entry)
    ) {
      return;
    }

    const entryBytes = entry.totalBytes + chunkBytes;
    if (entryBytes > this.options.perStreamMaxBytes) {
      this.discardEntry(entry, "overflow-per-stream");
      return;
    }
    const sessionBytes = this.totalBytesValue + chunkBytes;
    if (sessionBytes > this.options.perSessionMaxBytes) {
      this.discardEntry(entry, "overflow-per-session");
      return;
    }
    entry.appendChunk(chunk, entryBytes);
    this.totalBytesValue = sessionBytes;
  }

  /**
   * entry を Map から取り出し、集計から減算する
   * timeout が走っていれば解除する
   * 既に削除済み or 未登録の entry に対する remove は no-op
   */
  remove(entry: PendingSubgroupEntry): void {
    const entries = this.entriesByAlias.get(entry.trackAlias);
    if (!entries?.delete(entry)) return;
    if (entry.timeoutHandle !== null) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    if (entries.size === 0) {
      this.entriesByAlias.delete(entry.trackAlias);
    }
    this.streamCountValue--;
    this.totalBytesValue -= entry.totalBytes;
  }

  /**
   * 該当 trackAlias の全 entry に通知を送る
   * 実際の Map からの削除は entry の所有者が remove() で行う
   */
  notifyAlias(trackAlias: bigint, reason: PendingNotifyReason): void {
    const entries = this.entriesByAlias.get(trackAlias);
    if (entries === undefined) return;
    // notify は Promise を解決するだけなので、この反復中に entry は削除されない。
    for (const entry of entries) {
      entry.notify(reason);
    }
  }

  /**
   * 現在保持している entry 数 (全 trackAlias 合計)
   */
  get streamCount(): number {
    return this.streamCountValue;
  }

  /**
   * 現在保持している総バイト数
   */
  get totalBytes(): number {
    return this.totalBytesValue;
  }
}
