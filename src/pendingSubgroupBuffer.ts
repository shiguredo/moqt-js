/**
 * Pending Subgroup Stream Buffer
 *
 * draft-ietf-moq-transport-21 Section 11.3.1 (Subgroup Header):
 *
 * > If an endpoint receives a subgroup with an unknown Track Alias, it
 * > MAY abandon the stream, or choose to buffer it for a brief period to
 * > handle reordering with the control message that establishes the Track
 * > Alias.  The endpoint MAY withhold stream flow control beyond the
 * > SUBGROUP_HEADER until the Track Alias has been established.  To
 * > prevent deadlocks, endpoints MUST allocate connection flow control to
 * > the control streams before allocating it to any data streams.
 *
 * Track Alias 未確立の Subgroup ストリームを一時保持するバッファ。
 * "brief period" の上限管理のため per-stream / per-session のバイト上限と
 * タイムアウトを備える。各 entry は `notified` Promise を持ち、subscriber 登録 /
 * timeout / overflow / session-close / end-of-stream のいずれかで resolve する。
 */

type PendingNotifyReason =
  | "subscriber"
  | "timeout"
  | "overflow-per-stream"
  | "overflow-per-session"
  | "session-close"
  | "end-of-stream";

export interface PendingSubgroupBufferOptions {
  /** per-stream のバイト上限。これを超えた entry は overflow-per-stream で abandon する */
  perStreamMaxBytes: number;
  /** per-session の合計バイト上限。これを超えた最後の entry が overflow-per-session で abandon する */
  perSessionMaxBytes: number;
  /** "brief period" の上限ミリ秒。経過したら timeout で abandon する */
  timeoutMs: number;
}

/**
 * PendingSubgroupBufferOptions のデフォルト値
 *
 * - perStreamMaxBytes: 1 MiB
 * - perSessionMaxBytes: 16 MiB
 * - timeoutMs: 5000 (draft-ietf-moq-transport-21 §11.3.1 "brief period")
 */
export const DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS: PendingSubgroupBufferOptions = {
  perStreamMaxBytes: 1 << 20,
  perSessionMaxBytes: 16 << 20,
  timeoutMs: 5000,
};

class PendingSubgroupEntry {
  readonly chunks: Uint8Array[] = [];
  totalBytes = 0;
  private resolved = false;
  private resolvedReason: PendingNotifyReason | null = null;
  private resolveNotify!: (reason: PendingNotifyReason) => void;
  readonly notified: Promise<PendingNotifyReason>;
  /** @internal PendingSubgroupBuffer が timeout 解除に使う */
  timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly trackAlias: bigint) {
    this.notified = new Promise<PendingNotifyReason>((resolve) => {
      this.resolveNotify = resolve;
    });
  }

  /**
   * 上限超過で破棄された entry かどうか
   *
   * 破棄後に受け取ったチャンクを加算し続けると、この entry のバイトが
   * per-session の集計に積み上がり、無関係な他ストリームを巻き添えで
   * overflow させる。破棄済みなら受け取らない。
   *
   * "subscriber" (購読確立) や "timeout" は所有者がまだ保持中のチャンクを
   * 引き取る可能性があるため破棄扱いにしない (所有者の remove に委ねる)。
   */
  get abandoned(): boolean {
    return (
      this.resolvedReason === "overflow-per-stream" ||
      this.resolvedReason === "overflow-per-session"
    );
  }

  /**
   * 通知を発火する
   * 複数回呼ばれても resolve は最初の 1 回のみ反映される (idempotent)
   * 戻り値: 実際に resolve したか (重複呼び出しでは false)
   */
  notify(reason: PendingNotifyReason): boolean {
    if (this.resolved) return false;
    this.resolved = true;
    this.resolvedReason = reason;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.resolveNotify(reason);
    return true;
  }
}

export class PendingSubgroupBuffer {
  private entriesByAlias = new Map<bigint, PendingSubgroupEntry[]>();
  private totalBytesValue = 0;
  private readonly options: PendingSubgroupBufferOptions;

  constructor(options: Partial<PendingSubgroupBufferOptions> = {}) {
    this.options = { ...DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS, ...options };
  }

  /**
   * 新しい pending entry を作成して Map に追加し、timeout を起動する
   * draft-ietf-moq-transport-21 §11.3.1 "brief period" の上限を timeoutMs で表現する
   */
  add(trackAlias: bigint): PendingSubgroupEntry {
    const entry = new PendingSubgroupEntry(trackAlias);

    let list = this.entriesByAlias.get(trackAlias);
    if (!list) {
      list = [];
      this.entriesByAlias.set(trackAlias, list);
    }
    list.push(entry);

    entry.timeoutHandle = setTimeout(() => {
      entry.notify("timeout");
    }, this.options.timeoutMs);

    return entry;
  }

  /**
   * チャンクを entry に追加する
   * per-stream / per-session の上限を超えたら entry.notify を発火する
   *
   * 上限超過で破棄済みの entry には加算しない。加算を続けると破棄したはずの
   * バイトが per-session の集計に残り、無関係な他ストリームを巻き添えで
   * overflow させる (この場合チャンクを保持しないので remove 時の減算もずれない)。
   * 上限判定の前後で必ず entry.totalBytes と集計バイト数が一致する。
   */
  appendChunk(entry: PendingSubgroupEntry, chunk: Uint8Array): void {
    if (entry.abandoned) {
      return;
    }

    entry.chunks.push(chunk);
    entry.totalBytes += chunk.byteLength;
    this.totalBytesValue += chunk.byteLength;

    if (entry.totalBytes > this.options.perStreamMaxBytes) {
      entry.notify("overflow-per-stream");
      return;
    }
    if (this.totalBytesValue > this.options.perSessionMaxBytes) {
      entry.notify("overflow-per-session");
    }
  }

  /**
   * entry を Map から取り出し、集計から減算する
   * timeout が走っていれば解除する
   * 既に削除済み or 未登録の entry に対する remove は no-op
   */
  remove(entry: PendingSubgroupEntry): void {
    if (entry.timeoutHandle !== null) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    const list = this.entriesByAlias.get(entry.trackAlias);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) {
      this.entriesByAlias.delete(entry.trackAlias);
    }
    this.totalBytesValue -= entry.totalBytes;
  }

  /**
   * 該当 trackAlias の全 entry に通知を送る
   * 実際の Map からの削除は entry の所有者が remove() で行う
   */
  notifyAlias(trackAlias: bigint, reason: PendingNotifyReason): void {
    const list = this.entriesByAlias.get(trackAlias);
    if (!list) return;
    for (const entry of list.slice()) {
      entry.notify(reason);
    }
  }

  /**
   * 全 entry に通知を送る (session close 時)
   * 実際の Map からの削除は entry の所有者が remove() で行う
   */
  notifyAll(reason: PendingNotifyReason): void {
    for (const list of this.entriesByAlias.values()) {
      for (const entry of list.slice()) {
        entry.notify(reason);
      }
    }
  }

  /**
   * 現在保持している entry 数 (全 trackAlias 合計)
   */
  get streamCount(): number {
    let count = 0;
    for (const list of this.entriesByAlias.values()) {
      count += list.length;
    }
    return count;
  }

  /**
   * 現在保持している総バイト数
   */
  get totalBytes(): number {
    return this.totalBytesValue;
  }
}
