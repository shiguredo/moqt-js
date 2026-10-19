/**
 * 復号前の Object を時間で保持するキュー
 *
 * 2 秒以上の再生遅延を復号済みフレームのキューで実現すると、1080p 30 fps で約 60 枚、
 * 60 fps で約 120 枚の `VideoFrame` を保持することになり、メモリが現実的でない。そこで、
 * 受信した圧縮済み Object を復号へ渡す前に時間で保持し、復号の開始を遅らせる。
 *
 * このクラスはブラウザ API に依存せず、時刻は呼び出し側が引数で渡す。タイマーは持たない
 * (キューから取り出す時刻の判定だけを持つ)。キューが空になるまで時間が進まないため、
 * 次の期限 (`nextDueMs`) を呼び出し側のタイマーが使う。
 *
 * 保持上限を超えたときは古い Object から落とす。新しい Object を落とすとキューが埋まった
 * ままになり、以降の Object をすべて捨てることになるためである。ライブ側を優先する。
 */

/**
 * 復号前の遅延の上限 (ミリ秒)
 *
 * 2 秒以上の用途を含みつつ、タイマーと保持量が無制限に増えないようにする。30 秒を超える
 * 遅延はライブ配信の視聴ではなく時間をずらした再生の用途であり、この仕組みの対象外とする。
 */
export const MAX_PRE_DECODE_DELAY_MS = 30_000;

/**
 * キューが保持してよいバイト数の上限 (トラックごと)
 *
 * 2 秒の遅延を想定したバイト数ではない。上限は壊れた publisher や極端に高いビットレートで
 * メモリが無制限に増えないようにするための保護であり、この値を超えた遅延は保持できない。
 * 20 Mbps の映像を 30 秒保持すると 75 MiB になるため、長い遅延と高いビットレートの組み合わせ
 * では古い Object が落ちる。
 */
export const PRE_DECODE_QUEUE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * キューが保持してよい Object 件数の上限 (トラックごと)
 *
 * 30 秒の遅延でも 60 fps の映像で 1,800 件、50 個 / 秒の音声で 1,500 件であり、8,192 件は
 * 十分に大きい。Object 1 件あたりの固定費 (キュー要素とタイマーの管理) が増えすぎない
 * ようにするための上限である。
 */
export const PRE_DECODE_QUEUE_MAX_OBJECTS = 8_192;

/** `PreDecodeDelayQueue.push` の結果 */
export interface PreDecodeDelayPushResult<T> {
  /** 上限を超えたため落とした Object (古い方から) */
  readonly dropped: readonly T[];
  /** 上限を超えて 1 件以上落としたか */
  readonly overflowed: boolean;
}

/** キューが保持する 1 件分 */
interface PreDecodeDelayEntry<T> {
  readonly item: T;
  /** 積んだ時刻 (ミリ秒)。期限はこの値と現在の遅延から求める */
  readonly enqueuedAtMs: number;
  readonly bytes: number;
}

/** `PreDecodeDelayQueue` の設定 */
export interface PreDecodeDelayQueueOptions {
  /** 復号まで保持する時間 (ミリ秒) */
  delayMs: number;
  /** 保持してよいバイト数の上限。0 以下は無制限 */
  maxBytes?: number;
  /** 保持してよい件数の上限。0 以下は無制限 */
  maxObjects?: number;
}

/**
 * 復号前の遅延の値を検証する
 *
 * @param value - 検証する遅延 (ミリ秒)
 */
function assertPreDecodeDelayMs(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`delayMs must be a finite number >= 0, got ${value}`);
  }
  if (value > MAX_PRE_DECODE_DELAY_MS) {
    throw new Error(`delayMs must be <= ${MAX_PRE_DECODE_DELAY_MS}, got ${value}`);
  }
}

/**
 * 復号前の Object を期限まで保持するキュー
 *
 * 期限は「積んだ時刻 + 現在の遅延」で決まる。Object の到着順を保ったまま期限だけを
 * 遅らせるため、積んだ時刻の昇順に並べておく。時刻は単調であることを前提にしない
 * (テストや呼び出し側の時計の取り直しで前後し得る) ため、`push` のたびに位置へ挿入する。
 *
 * 遅延は `setDelayMs` で変更できる。保持中の Object の期限も新しい値で計算し直すため、
 * 購読を止めずに再生遅延を変えられる。遅延を 0 にしたときは `takeAll` で待たずに
 * 取り出し、呼び出し側が復号へ流す。
 */
export class PreDecodeDelayQueue<T> {
  private delayMsValue: number;
  private readonly maxBytes: number;
  private readonly maxObjects: number;
  private entries: PreDecodeDelayEntry<T>[] = [];
  private bufferedBytesValue = 0;

  /**
   * @param options - 遅延と保持上限
   */
  constructor(options: PreDecodeDelayQueueOptions) {
    assertPreDecodeDelayMs(options.delayMs);
    this.delayMsValue = options.delayMs;
    this.maxBytes = options.maxBytes ?? PRE_DECODE_QUEUE_MAX_BYTES;
    this.maxObjects = options.maxObjects ?? PRE_DECODE_QUEUE_MAX_OBJECTS;
  }

  /** 現在の遅延 (ミリ秒) */
  get delayMs(): number {
    return this.delayMsValue;
  }

  /**
   * 遅延を変更する
   *
   * 保持中の Object の期限は新しい値で計算し直される。呼び出し側は変更後にタイマーを
   * 張り直すこと (期限が早まる場合がある)。
   *
   * @param value - 新しい遅延 (ミリ秒)
   */
  setDelayMs(value: number): void {
    assertPreDecodeDelayMs(value);
    this.delayMsValue = value;
  }

  /** 保持している件数 */
  get size(): number {
    return this.entries.length;
  }

  /** 保持しているバイト数 (呼び出し側が渡した値の合計) */
  get bufferedBytes(): number {
    return this.bufferedBytesValue;
  }

  /**
   * Object を期限付きで積む
   *
   * @param item - 保持する Object
   * @param bytes - この Object が占めるバイト数
   * @param nowMs - 積んだ時刻 (ミリ秒)
   * @returns 上限を超えて落とした Object と、overflow の有無
   */
  push(item: T, bytes: number, nowMs: number): PreDecodeDelayPushResult<T> {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`bytes must be a finite number >= 0, got ${bytes}`);
    }
    const entry: PreDecodeDelayEntry<T> = { item, enqueuedAtMs: nowMs, bytes };
    // 積んだ時刻の昇順に挿入する。通常は末尾への追加になる
    let index = this.entries.length;
    while (index > 0) {
      const previous = this.entries[index - 1];
      if (previous === undefined || previous.enqueuedAtMs <= entry.enqueuedAtMs) {
        break;
      }
      index--;
    }
    this.entries.splice(index, 0, entry);
    this.bufferedBytesValue += bytes;

    // 1 件だけでバイト上限を超える Object は、キューに入れずに落とす。保持しても次の
    // Object をすべて落とすことになり、遅延を保てないためである
    if (this.maxBytes > 0 && bytes > this.maxBytes) {
      this.entries.splice(index, 1);
      this.bufferedBytesValue -= bytes;
      return { dropped: [item], overflowed: true };
    }

    const dropped: T[] = [];
    while (this.isOverLimit()) {
      const removed = this.entries.shift();
      if (removed === undefined) {
        break;
      }
      this.bufferedBytesValue -= removed.bytes;
      dropped.push(removed.item);
    }
    return { dropped, overflowed: dropped.length > 0 };
  }

  /**
   * 期限が来た Object を取り出す
   *
   * @param nowMs - 今の時刻 (ミリ秒)
   * @returns 期限が来た Object (積んだ順)
   */
  takeDue(nowMs: number): T[] {
    let dueCount = 0;
    while (dueCount < this.entries.length) {
      const entry = this.entries[dueCount];
      if (entry === undefined || entry.enqueuedAtMs + this.delayMsValue > nowMs) {
        break;
      }
      dueCount++;
    }
    if (dueCount === 0) {
      return [];
    }
    const due = this.entries.splice(0, dueCount);
    for (const entry of due) {
      this.bufferedBytesValue -= entry.bytes;
    }
    return due.map((entry) => entry.item);
  }

  /** 次に期限が来る時刻 (ミリ秒)。保持していなければ null */
  nextDueMs(): number | null {
    const head = this.entries[0];
    return head === undefined ? null : head.enqueuedAtMs + this.delayMsValue;
  }

  /**
   * 保持している Object をすべて取り出す
   *
   * 期限を待たずに取り出す。動的に遅延を 0 にしたとき、保持中の Object を捨てずに
   * 復号へ流してライブへ追いつくために使う。
   *
   * @returns 保持していた Object (積んだ順)
   */
  takeAll(): T[] {
    const items = this.entries.map((entry) => entry.item);
    this.entries = [];
    this.bufferedBytesValue = 0;
    return items;
  }

  /** 保持している Object をすべて破棄する */
  clear(): void {
    this.entries = [];
    this.bufferedBytesValue = 0;
  }

  /** 保持上限を超えているか */
  private isOverLimit(): boolean {
    if (this.maxObjects > 0 && this.entries.length > this.maxObjects) {
      return true;
    }
    return this.maxBytes > 0 && this.bufferedBytesValue > this.maxBytes;
  }
}
