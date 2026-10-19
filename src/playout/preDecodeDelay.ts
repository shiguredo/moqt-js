/**
 * 復号前の Object を時間で保持するキュー
 *
 * 2 秒以上の再生遅延を復号済みフレームのキューで実現すると、1080p 30 fps で約 60 枚、
 * 60 fps で約 120 枚の `VideoFrame` を保持することになり、メモリが現実的でない。そこで、
 * 受信した圧縮済み Object を復号へ渡す前に時間で保持し、復号の開始を遅らせる。
 *
 * このクラスはブラウザ API に依存せず、時刻は呼び出し側が引数で渡す。タイマーは持たない
 * (キューから取り出す時刻の判定だけを持つ)。呼び出し側は `nextDueMs` で次の期限を引いて
 * タイマーを張る。
 *
 * 保持上限を超えたときは古い Object から落とす。新しい Object を落とすとキューが埋まった
 * ままになり、以降の Object をすべて捨てることになるためである。ライブ側を優先する。
 *
 * 古い Object を落としただけでは、保持できる時間 (上限 / ビットレート) が遅延より短い構成で
 * キューが詰まったままになる。先頭の期限 `積んだ時刻 + 遅延` が来る前に毎回落とされるため、
 * `takeDue` が何も返さなくなる。そこで上限超過のたびに残っている Object の期限を前倒しし、
 * 「保持できる時間」まで実効的な遅延を短くする。落とした分を配信の遅れとして吸収し、
 * 復号が止まらないようにするためである。キューが空になったら短縮を解除する。
 *
 * 期限は各 Object を積んだ時点で決めて保持する。実効的な遅延をあとから変化させても、既に
 * 積んだ Object の期限は動かさない (期限を実効的な遅延から毎回計算し直すと、短縮を時間で
 * 解消するときに期限が時間と一緒に動き、いつまでも取り出せなくなる)。上限超過の前倒しだけが
 * 既に積んだ Object の期限を動かす。
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
 * 20 Mbps の映像を 30 秒保持すると 75 MB (約 71.5 MiB) になるため、長い遅延と高い
 * ビットレートの組み合わせでは古い Object が落ち、実効的な遅延が短くなる。
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
  /** 積んだ時刻 (ミリ秒)。取り出しの順序を決める */
  readonly enqueuedAtMs: number;
  /** 期限 (ミリ秒)。積んだ時点の実効的な遅延で決め、上限超過のときだけ前倒しする */
  dueAtMs: number;
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
 * 期限は各 Object を積んだ時点の実効的な遅延で決める。Object の到着順を保ったまま期限
 * だけを遅らせるため、積んだ時刻の昇順に並べておく。時刻は単調であることを前提にしない
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
  // 積んだ時刻の昇順に並べた Object。期限 (dueAtMs) はこの順序と一致しないことがある
  // (短縮中に積んだ Object の期限が、後から積んだ Object より遅くなる) ため、取り出しは
  // 全件を見る
  private entries: PreDecodeDelayEntry<T>[] = [];
  private bufferedBytesValue = 0;
  // 上限超過で前倒しした遅延の短縮分 (ミリ秒)。これから積む Object の期限にだけ使う
  private delayShortenValue = 0;

  /**
   * @param options - 遅延と保持上限
   */
  constructor(options: PreDecodeDelayQueueOptions) {
    assertPreDecodeDelayMs(options.delayMs);
    this.delayMsValue = options.delayMs;
    this.maxBytes = options.maxBytes ?? PRE_DECODE_QUEUE_MAX_BYTES;
    this.maxObjects = options.maxObjects ?? PRE_DECODE_QUEUE_MAX_OBJECTS;
  }

  /** 設定されている遅延 (ミリ秒) */
  get delayMs(): number {
    return this.delayMsValue;
  }

  /**
   * 遅延を変更する
   *
   * 保持中の Object の期限も新しい値で計算し直す。上限超過で前倒ししていた短縮分は
   * 解除し、新しい遅延を起点にやり直す。呼び出し側は変更後にタイマーを張り直すこと
   * (期限が早まる場合がある)。
   *
   * @param value - 新しい遅延 (ミリ秒)
   */
  setDelayMs(value: number): void {
    assertPreDecodeDelayMs(value);
    this.delayMsValue = value;
    this.delayShortenValue = 0;
    for (const entry of this.entries) {
      entry.dueAtMs = entry.enqueuedAtMs + value;
    }
  }

  /** 保持している件数 */
  get size(): number {
    return this.entries.length;
  }

  /** 保持しているバイト数 (呼び出し側が渡した値の合計) */
  get bufferedBytes(): number {
    return this.bufferedBytesValue;
  }

  /** 上限超過で前倒ししている量 (ミリ秒)。0 なら遅延は設定値のまま */
  get delayShortenMs(): number {
    return this.delayShortenValue;
  }

  /** いまの実効的な遅延 (ミリ秒)。上限超過で前倒しした分を引いた値 */
  get effectiveDelayMs(): number {
    return Math.max(0, this.delayMsValue - this.delayShortenValue);
  }

  /**
   * 上限超過で前倒しする量を外から設定する
   *
   * 音声と映像で同じ実効的な遅延を保つため、購読側が 2 つのキューの短縮量を揃えるのに
   * 使う。既に保持している Object の期限は動かさない (これから積む Object にだけ使う)。
   *
   * @param value - 短縮量 (ミリ秒)。0 以上、設定した遅延以下に丸める
   */
  setDelayShortenMs(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`delayShortenMs must be a finite number >= 0, got ${value}`);
    }
    this.delayShortenValue = Math.min(this.delayMsValue, value);
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
    const entry: PreDecodeDelayEntry<T> = {
      item,
      enqueuedAtMs: nowMs,
      dueAtMs: nowMs + this.effectiveDelayMs,
      bytes,
    };
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
    if (dropped.length > 0) {
      // 落とした分だけ遅延を詰める。これをしないと、保持できる時間が遅延より短い構成で
      // 先頭の期限が来る前に毎回落とされ、takeDue が何も返さなくなる
      this.shortenDelayForOverflow(nowMs);
    }
    return { dropped, overflowed: dropped.length > 0 };
  }

  /**
   * 期限が来た Object を取り出す
   *
   * 期限は積んだ時刻の順に並んでいるとは限らないため、全件を見て期限が来たものを
   * 積んだ順に返す。
   *
   * @param nowMs - 今の時刻 (ミリ秒)
   * @returns 期限が来た Object (積んだ順)
   */
  takeDue(nowMs: number): T[] {
    const due: T[] = [];
    const remaining: PreDecodeDelayEntry<T>[] = [];
    for (const entry of this.entries) {
      if (entry.dueAtMs <= nowMs) {
        this.bufferedBytesValue -= entry.bytes;
        due.push(entry.item);
      } else {
        remaining.push(entry);
      }
    }
    if (due.length === 0) {
      return [];
    }
    this.entries = remaining;
    if (this.entries.length === 0) {
      // 空になったら上限超過による短縮は解除する。次の Object は元の遅延で保持する
      this.delayShortenValue = 0;
    }
    return due;
  }

  /** 次に期限が来る時刻 (ミリ秒)。保持していなければ null */
  nextDueMs(): number | null {
    let nextMs: number | null = null;
    for (const entry of this.entries) {
      if (nextMs === null || entry.dueAtMs < nextMs) {
        nextMs = entry.dueAtMs;
      }
    }
    return nextMs;
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
    this.delayShortenValue = 0;
    return items;
  }

  /** 保持している Object をすべて破棄する */
  clear(): void {
    this.entries = [];
    this.bufferedBytesValue = 0;
    this.delayShortenValue = 0;
  }

  /**
   * 上限超過で Object を落としたあと、残っている Object の期限を前倒しする
   *
   * 先頭の Object がいま期限を迎えるように短縮し、それより前の短縮は維持する。保持できる
   * 時間だけ遅延を短くして、落とした分を遅れとして吸収する。既に積んだ Object の期限は
   * ここでだけ動かし、以後の短縮はこれから積む Object にだけ使う。
   *
   * @param nowMs - 落とした時刻 (ミリ秒)
   */
  private shortenDelayForOverflow(nowMs: number): void {
    const head = this.entries[0];
    if (head === undefined) {
      this.delayShortenValue = 0;
      return;
    }
    // 先頭の期限を now まで前倒しする (残りの期限も同じだけ前倒しする)
    const shiftMs = Math.max(0, head.dueAtMs - nowMs);
    if (shiftMs > 0) {
      for (const entry of this.entries) {
        entry.dueAtMs -= shiftMs;
      }
    }
    const headAgeMs = nowMs - head.enqueuedAtMs;
    const shortenMs = Math.max(0, this.delayMsValue - headAgeMs);
    this.delayShortenValue = Math.min(
      this.delayMsValue,
      Math.max(this.delayShortenValue, shortenMs),
    );
  }

  /** 保持上限を超えているか */
  private isOverLimit(): boolean {
    if (this.maxObjects > 0 && this.entries.length > this.maxObjects) {
      return true;
    }
    return this.maxBytes > 0 && this.bufferedBytesValue > this.maxBytes;
  }
}
