/**
 * 復号前の遅延キューと、期限を待つタイマーをまとめた段
 *
 * `PreDecodeDelayQueue` は時刻を引数で受ける純粋なデータ構造であり、タイマーを持たない。
 * キューへ積むたびに次の期限へタイマーを張り、期限が来た Object を `onDue` で復号へ渡す
 * ところまでを 1 か所にまとめる。音声と映像、高レベル API と moqt-devtools で同じ段を使い、
 * 「積む・期限を待つ・取り出す」の実装が経路ごとに分かれるのを防ぐ。
 *
 * 遅延は `setDelayMs` で変更できる。保持中の Object の期限も新しい値で計算し直し、タイマーも
 * 張り直すため、購読を止めずに再生遅延を変えられる。動的に 0 にするときは `flush` で保持中の
 * Object を待たずに `onDue` へ流す。
 *
 * 上限超過の通知は購読期間 (この段を作り直すまで) あたり 1 回だけ行う。段を使い回す経路では
 * `resetOverflowNotification` で解除できる。
 *
 * `stop` はキューとタイマーを捨てるが、段そのものは再利用できる (復号器のエラー後に購読を
 * 続ける経路と、購読の停止・再 start の両方で使う)。
 *
 * タイマーと時計は差し替えられる。テストでは決定的な時計とタイマーを渡し、実時間を待たずに
 * 期限の計算と並び順を検証する。
 */

import { type PreDecodeDelayPushResult, PreDecodeDelayQueue } from "./preDecodeDelay";

/** 段が使う時計とタイマー。テストでは決定的な実装に差し替える */
export interface PreDecodeDelayStageClock {
  /** 現在時刻 (ミリ秒) */
  now(): number;
  /** タイマーを張り、解除に使うハンドルを返す */
  setTimer(callback: () => void, delayMs: number): unknown;
  /** タイマーを解除する */
  clearTimer(handle: unknown): void;
}

/** ブラウザの `performance.now` と `setTimeout` を使う既定の時計 */
const DEFAULT_PRE_DECODE_DELAY_STAGE_CLOCK: PreDecodeDelayStageClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** コールバックへ渡す、上限超過の内容 */
export interface PreDecodeDelayStageOverflow {
  /** 落とした Object の件数 */
  readonly dropped: number;
  /** 落としたあとのキューに残っている件数 */
  readonly size: number;
  /** 落としたあとのキューに残っているバイト数 */
  readonly bufferedBytes: number;
  /** 設定されている遅延 (ミリ秒) */
  readonly delayMs: number;
  /** 上限超過で前倒ししたあとの実効的な遅延 (ミリ秒) */
  readonly effectiveDelayMs: number;
}

/** `PreDecodeDelayStage` の設定 */
interface PreDecodeDelayStageOptions<T> {
  /** 復号まで保持する時間 (ミリ秒) */
  delayMs: number;
  /** 保持してよいバイト数の上限。0 以下は無制限 */
  maxBytes?: number;
  /** 保持してよい件数の上限。0 以下は無制限 */
  maxObjects?: number;
  /** Object が占めるバイト数 */
  bytesOf: (item: T) => number;
  /** 期限が来た Object (積んだ順)。復号へ渡す */
  onDue: (items: readonly T[]) => void;
  /** 上限超過の通知。段を作り直すまで 1 回だけ呼ばれる */
  onOverflow?: (overflow: PreDecodeDelayStageOverflow) => void;
  /**
   * 上限超過による遅延の短縮量が変わったときの通知 (音声と映像で揃えるのに使う)
   *
   * @param reset - キューが空になって短縮が解除されたかどうか
   */
  onDelayShortenChanged?: (reset: boolean) => void;
  /** `onDue` が throw したときの通知。期限の張り直しは保証される */
  onDueError?: (error: unknown) => void;
  /** 時計とタイマー。省略するとブラウザの実時間を使う */
  clock?: PreDecodeDelayStageClock;
}

/** 復号前の遅延キューとタイマーをまとめた段 */
export class PreDecodeDelayStage<T> {
  private readonly queue: PreDecodeDelayQueue<T>;
  private readonly options: PreDecodeDelayStageOptions<T>;
  private readonly clock: PreDecodeDelayStageClock;
  private timer: unknown = null;
  private timerDueMs: number | null = null;
  private overflowNotified = false;
  private lastNotifiedShortenMs = 0;

  /**
   * @param options - 遅延、保持上限、期限の通知先
   */
  constructor(options: PreDecodeDelayStageOptions<T>) {
    this.options = options;
    this.clock = options.clock ?? DEFAULT_PRE_DECODE_DELAY_STAGE_CLOCK;
    // 未指定の上限はキュー側の既定値を使う (undefined を明示的に渡さない)
    this.queue = new PreDecodeDelayQueue<T>({
      delayMs: options.delayMs,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxObjects === undefined ? {} : { maxObjects: options.maxObjects }),
    });
  }

  /** 上限超過で前倒ししている量 (ミリ秒)。0 なら設定した遅延のまま */
  get delayShortenMs(): number {
    return this.queue.delayShortenMs;
  }

  /** 保持している件数 */
  get size(): number {
    return this.queue.size;
  }

  /** 保持しているバイト数 */
  get bufferedBytes(): number {
    return this.queue.bufferedBytes;
  }

  /**
   * Object を積み、次の期限のタイマーを張る
   *
   * 上限超過で保存している Object の期限が前倒しされた場合は、既に張ってあるタイマーより
   * 早い期限になるため張り直す。これをしないと、最初の Object の元の期限が来るまで復号が
   * 止まり、その間も古い Object を落とし続ける。
   */
  push(item: T): void {
    const result = this.queue.push(item, this.options.bytesOf(item), this.clock.now());
    if (result.overflowed) {
      this.notifyOverflow(result);
    }
    this.notifyDelayShortenChanged();
    this.schedule();
  }

  /**
   * 上限超過で前倒しする量を外から設定する
   *
   * 音声と映像で同じ実効的な遅延を保つため、購読側が 2 つの段の短縮量を揃えるのに使う。
   *
   * @param value - 短縮量 (ミリ秒)
   */
  setDelayShortenMs(value: number): void {
    this.queue.setDelayShortenMs(value);
    this.notifyDelayShortenChanged();
    this.reschedule();
  }

  /**
   * 遅延を変更し、タイマーを張り直す
   *
   * @param value - 新しい遅延 (ミリ秒)
   */
  setDelayMs(value: number): void {
    this.queue.setDelayMs(value);
    this.notifyDelayShortenChanged();
    this.reschedule();
  }

  /**
   * 保持している Object を期限を待たずに `onDue` へ流す
   *
   * 動的に遅延を 0 にしたときに、保持中の Object を捨てずに復号へ流してライブへ追いつく
   * ために使う。
   */
  flush(): void {
    this.cancelTimer();
    this.emit(this.queue.takeAll());
  }

  /**
   * キューとタイマーを破棄する
   *
   * 段そのものは再利用できる (購読の停止・再 start と復号器のエラー後の両方で使う)。
   */
  stop(): void {
    this.cancelTimer();
    this.queue.clear();
    this.overflowNotified = false;
    // 同じ短縮量で再開したときに同期の通知が落ちないよう、通知済みの値も戻す
    this.lastNotifiedShortenMs = 0;
  }

  /** 上限超過の通知済みフラグを解除する (購読をやり直すときに使う) */
  resetOverflowNotification(): void {
    this.overflowNotified = false;
  }

  /** 期限が来た Object を取り出して復号へ渡し、次の期限のタイマーを張る */
  private drain(): void {
    this.timer = null;
    this.timerDueMs = null;
    try {
      this.emit(this.queue.takeDue(this.clock.now()));
      this.notifyDelayShortenChanged();
    } finally {
      // onDue が throw しても、キューに残った Object の期限は張り直す
      this.schedule();
    }
  }

  /** `onDue` を呼ぶ。例外は `onDueError` へ流し、呼び出し元へは投げない */
  private emit(items: readonly T[]): void {
    if (items.length === 0) {
      return;
    }
    try {
      this.options.onDue(items);
    } catch (error) {
      this.options.onDueError?.(error);
    }
  }

  /** 上限超過を 1 回だけ通知する */
  private notifyOverflow(result: PreDecodeDelayPushResult<T>): void {
    if (this.overflowNotified) {
      return;
    }
    this.overflowNotified = true;
    this.options.onOverflow?.({
      dropped: result.dropped.length,
      size: this.queue.size,
      bufferedBytes: this.queue.bufferedBytes,
      delayMs: this.queue.delayMs,
      effectiveDelayMs: this.queue.effectiveDelayMs,
    });
  }

  /**
   * 次の期限にタイマーを張る
   *
   * 既にタイマーがあっても、期限が早まっていれば張り直す (上限超過で残りの Object の
   * 期限が前倒しされた場合)。
   */
  private schedule(): void {
    const dueMs = this.queue.nextDueMs();
    if (dueMs === null) {
      this.cancelTimer();
      return;
    }
    if (this.timer !== null && this.timerDueMs !== null && this.timerDueMs <= dueMs) {
      return;
    }
    this.cancelTimer();
    this.timer = this.clock.setTimer(() => this.drain(), Math.max(0, dueMs - this.clock.now()));
    this.timerDueMs = dueMs;
  }

  /** タイマーを張り直す */
  private reschedule(): void {
    this.cancelTimer();
    this.schedule();
  }

  /** タイマーを解除する */
  private cancelTimer(): void {
    if (this.timer === null) {
      return;
    }
    this.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerDueMs = null;
  }

  /** 上限超過による短縮量が変わったら通知する */
  private notifyDelayShortenChanged(): void {
    const shortenMs = this.queue.delayShortenMs;
    const previousShortenMs = this.lastNotifiedShortenMs;
    if (shortenMs === previousShortenMs) {
      return;
    }
    this.lastNotifiedShortenMs = shortenMs;
    // キューが空になって解除されたかを伝える (音声と映像の短縮を両方解除するため)
    this.options.onDelayShortenChanged?.(shortenMs === 0 && previousShortenMs > 0);
  }
}
