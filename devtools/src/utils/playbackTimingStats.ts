/**
 * 受信した映像の到着・復号・表示の時間の統計
 *
 * 受信側の映像がかくつくとき、原因は到着の揺らぎ、送信から受信までの遅延、復号の
 * 遅れ、表示の止まり、表示キューのあふれのいずれか (または組み合わせ) である。
 * 累積のカウンタだけでは区別できないため、時刻を記録して分布と累積の値を出す。
 *
 * ブラウザ API に依存しないよう、時刻は呼び出し側が引数で渡す
 * (`performance.now()` と `performance.timeOrigin + performance.now()`)。
 *
 * - 分布 (p50 / p95 / max) は直近の窓 (既定 10 秒) の値から求める
 * - 止まりの回数と時間、表示キューのあふれは購読の開始 (reset) からの累積である
 */

/** 分布を求める直近の窓 (ミリ秒) */
export const PLAYBACK_TIMING_WINDOW_MS = 10_000;

/** 表示 fps を数える窓 (ミリ秒) */
export const DISPLAY_FPS_WINDOW_MS = 1_000;

/** 表示間隔がフレーム間隔のこの倍数を超えたら止まりとみなす */
export const DISPLAY_STALL_FACTOR = 1.5;

/** 分布の要約 (ミリ秒) */
export interface TimingSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** 統計の値 */
export interface PlaybackTimingSnapshot {
  /**
   * 到着の揺らぎ。到着時刻 - メディア時刻 (LOC TIMESTAMP) の、窓の中の最小値からの差。
   * 送信側と受信側の時計のずれに依らない
   */
  readonly arrivalJitterMs: TimingSummary | null;
  /**
   * 遅延。受信側の壁時計 - 送信側の壁時計の LOC TIMESTAMP。
   * Timescale の無い (壁時計の) TIMESTAMP だけで求める。別のマシンでは時計のずれを含む
   */
  readonly latencyMs: TimingSummary | null;
  /** 復号時間。decoder に渡してから出力されるまで */
  readonly decodeTimeMs: TimingSummary | null;
  /** 表示間隔 */
  readonly displayIntervalMs: TimingSummary | null;
  /** 直近 1 秒に描いたフレーム数 */
  readonly displayFps: number;
  /** 表示間隔がフレーム間隔の 1.5 倍を超えた回数 (累積) */
  readonly displayStalls: number;
  /** 止まりとみなした表示間隔の合計 (ミリ秒、累積) */
  readonly displayStallMs: number;
  /** 表示キューがあふれて捨てたフレーム数 (累積) */
  readonly displayQueueDrops: number;
}

/** 何も記録していないときの統計 */
export const EMPTY_PLAYBACK_TIMING: PlaybackTimingSnapshot = {
  arrivalJitterMs: null,
  latencyMs: null,
  decodeTimeMs: null,
  displayIntervalMs: null,
  displayFps: 0,
  displayStalls: 0,
  displayStallMs: 0,
  displayQueueDrops: 0,
};

/**
 * 値の分布を p50 / p95 / max に要約する
 *
 * 百分位は nearest-rank 法 (昇順に並べて ceil(p * n) 番目) で求める。値が無ければ null。
 */
export function summarizeTimings(values: readonly number[]): TimingSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: nearestRank(sorted, 1),
  };
}

function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

/**
 * 分布の要約を「p50 / p95 / max」(ミリ秒、小数 1 桁) の文字列にする。値が無ければ "-"
 */
export function formatTimingSummary(summary: TimingSummary | null): string {
  if (summary === null) {
    return "-";
  }
  return `${summary.p50.toFixed(1)} / ${summary.p95.toFixed(1)} / ${summary.max.toFixed(1)}`;
}

/**
 * 記録した時刻の順に並んだ値の列
 *
 * 記録の時刻は単調に増える (`performance.now()`) ため、窓より古い値は先頭にある。
 * 先頭から捨てるときに配列を詰め直さないよう、読み始めの位置を進め、半分を超えたら
 * まとめて詰める。
 */
class TimedValues {
  private times: number[] = [];
  private values: number[] = [];
  private head = 0;

  push(atMs: number, value: number): void {
    this.times.push(atMs);
    this.values.push(value);
  }

  /** atMs が minAtMs より前の値を捨てる */
  prune(minAtMs: number): void {
    while (this.head < this.times.length && (this.times[this.head] ?? minAtMs) < minAtMs) {
      this.head++;
    }
    if (this.head > 0 && this.head * 2 >= this.times.length) {
      this.times = this.times.slice(this.head);
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
  }

  current(): number[] {
    return this.values.slice(this.head);
  }

  /** atMs が sinceMs より後の値の数 */
  countAfter(sinceMs: number): number {
    let count = 0;
    for (let index = this.times.length - 1; index >= this.head; index--) {
      if ((this.times[index] ?? sinceMs) <= sinceMs) {
        break;
      }
      count++;
    }
    return count;
  }

  clear(): void {
    this.times = [];
    this.values = [];
    this.head = 0;
  }
}

/**
 * 受信した映像の到着・復号・表示の時間を記録し、統計を求める
 */
export class PlaybackTimingStats {
  private readonly windowMs: number;
  // 到着時刻 - メディア時刻 (ミリ秒)
  private readonly lateness = new TimedValues();
  // 受信側の壁時計 - 送信側の壁時計の TIMESTAMP (ミリ秒)
  private readonly latency = new TimedValues();
  private readonly decodeTimes = new TimedValues();
  // decoder に渡したフレームの timestamp (マイクロ秒) と渡した時刻 (ミリ秒)。
  // 挿入順 (渡した順) に並ぶ
  private decodeStarts = new Map<number, number>();
  private readonly displayIntervals = new TimedValues();
  // 続けて描いたフレームのメディア時刻の差 (ミリ秒)。フレーム間隔を求めるために使う
  private readonly frameSteps = new TimedValues();
  // 描いた時刻 (表示 fps を数えるために使う。値は使わない)
  private readonly displays = new TimedValues();
  private lastDisplay: { nowMs: number; timestampMicros: number } | null = null;
  private displayStalls = 0;
  private displayStallMs = 0;
  private displayQueueDrops = 0;

  constructor(windowMs: number = PLAYBACK_TIMING_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * 映像の Object の到着を記録する
   *
   * @param nowMs - 到着した時刻 (`performance.now()`)
   * @param timestampMicros - Object の LOC TIMESTAMP (マイクロ秒)
   * @param wallClockNowMs - 到着した時刻の壁時計 (`performance.timeOrigin + performance.now()`)。
   *   TIMESTAMP が壁時計でない (Timescale がある) ときは null を渡し、遅延を求めない
   */
  recordArrival(nowMs: number, timestampMicros: number, wallClockNowMs: number | null): void {
    this.lateness.push(nowMs, nowMs - timestampMicros / 1_000);
    if (wallClockNowMs !== null) {
      this.latency.push(nowMs, wallClockNowMs - timestampMicros / 1_000);
    }
  }

  /**
   * フレームを decoder に渡したことを記録する
   *
   * 出力されなかったフレームの記録が残り続けないよう、窓より古い記録を捨てる。
   */
  recordDecodeStart(nowMs: number, timestampMicros: number): void {
    const minAtMs = nowMs - this.windowMs;
    for (const [timestamp, startMs] of this.decodeStarts) {
      if (startMs >= minAtMs) {
        break;
      }
      this.decodeStarts.delete(timestamp);
    }
    // 同じ timestamp を渡し直したときは新しい記録にし、挿入順の末尾へ移す
    this.decodeStarts.delete(timestampMicros);
    this.decodeStarts.set(timestampMicros, nowMs);
  }

  /**
   * decoder がフレームを出力したことを記録する。同じ timestamp の開始との差を復号時間にする
   */
  recordDecodeOutput(nowMs: number, timestampMicros: number): void {
    const startMs = this.decodeStarts.get(timestampMicros);
    if (startMs === undefined) {
      return;
    }
    this.decodeStarts.delete(timestampMicros);
    this.decodeTimes.push(nowMs, nowMs - startMs);
  }

  /**
   * フレームを描いたことを記録する
   *
   * 直前に描いたフレームからの表示間隔が、フレーム間隔 (窓の中の、続けて描いたフレームの
   * メディア時刻の差の中央値) の 1.5 倍を超えたら止まりとして数える。フレーム間隔は
   * この表示より前の値から求める。
   */
  recordDisplay(nowMs: number, timestampMicros: number): void {
    const previous = this.lastDisplay;
    if (previous !== null) {
      const intervalMs = nowMs - previous.nowMs;
      this.frameSteps.prune(nowMs - this.windowMs);
      const frameIntervalMs = summarizeTimings(this.frameSteps.current())?.p50;
      if (frameIntervalMs !== undefined && intervalMs > frameIntervalMs * DISPLAY_STALL_FACTOR) {
        this.displayStalls++;
        this.displayStallMs += intervalMs;
      }
      this.displayIntervals.push(nowMs, intervalMs);
      const stepMs = (timestampMicros - previous.timestampMicros) / 1_000;
      // メディア時刻が進んでいない (同じフレーム、巻き戻り) 差はフレーム間隔に含めない
      if (stepMs > 0) {
        this.frameSteps.push(nowMs, stepMs);
      }
    }
    this.displays.push(nowMs, 0);
    this.lastDisplay = { nowMs, timestampMicros };
  }

  /** 表示キューがあふれてフレームを捨てたことを記録する */
  recordQueueDrop(): void {
    this.displayQueueDrops++;
  }

  /**
   * 統計を求める
   *
   * @param nowMs - 求める時刻 (`performance.now()`)。窓はこの時刻から遡る
   */
  snapshot(nowMs: number): PlaybackTimingSnapshot {
    const minAtMs = nowMs - this.windowMs;
    for (const series of [
      this.lateness,
      this.latency,
      this.decodeTimes,
      this.displayIntervals,
      this.frameSteps,
      this.displays,
    ]) {
      series.prune(minAtMs);
    }
    const lateness = this.lateness.current();
    const earliest = Math.min(...lateness);
    return {
      arrivalJitterMs: summarizeTimings(lateness.map((value) => value - earliest)),
      latencyMs: summarizeTimings(this.latency.current()),
      decodeTimeMs: summarizeTimings(this.decodeTimes.current()),
      displayIntervalMs: summarizeTimings(this.displayIntervals.current()),
      displayFps: this.displays.countAfter(nowMs - DISPLAY_FPS_WINDOW_MS),
      displayStalls: this.displayStalls,
      displayStallMs: this.displayStallMs,
      displayQueueDrops: this.displayQueueDrops,
    };
  }

  /** 記録をすべて捨てて初期状態に戻す */
  reset(): void {
    this.lateness.clear();
    this.latency.clear();
    this.decodeTimes.clear();
    this.decodeStarts = new Map();
    this.displayIntervals.clear();
    this.frameSteps.clear();
    this.displays.clear();
    this.lastDisplay = null;
    this.displayStalls = 0;
    this.displayStallMs = 0;
    this.displayQueueDrops = 0;
  }
}
