/**
 * メインスレッドの停止と音声の到着の重なりを数える
 *
 * 音声 Object の到着時刻は、受信のコールバックが動いた時点で `performance.now()` を
 * 読んで求める。メインスレッドが長く止まっていると、止まっている間に届いていた Object の
 * コールバックも止まった後に動くため、到着時刻は実際にネットワークへ届いた時刻より
 * 遅れる。この遅れは到着の遅れ (`receiveDelayMs` = 受信した壁時計 - LOC TIMESTAMP) に
 * 混ざり、経路や relay の遅れと区別できない。
 *
 * ここでは `PerformanceObserver` の `longtask` が報告する停止区間と、音声の到着の間隔を
 * 突き合わせる。止まっている間は同じスレッドで到着のコールバックが動かないため、
 * 「到着の時刻が停止区間の内側にある」ことはない。代わりに、直前の到着から今回の到着
 * までの間隔が停止区間と重なる到着を数える。この到着は、待っている間にメインスレッドが
 * 止まった (その分だけ到着の観測が遅れた) と読める。
 *
 * ブラウザ API に依存しない。停止区間と到着の時刻は呼び出し側が渡し、このクラスは
 * 直近の窓の値だけを保持する。
 */

/** 停止区間と到着を保持する直近の窓 (ミリ秒)。音声の他の計器 (10 秒) と揃える */
export const HOST_DELAY_WINDOW_MS = 10_000;

/** メインスレッドの停止と音声の到着の重なりの観測値 */
export interface HostDelaySnapshot {
  /** 直近の窓で観測した停止 (longtask) の回数 */
  readonly stallCount: number;
  /** 直近の窓で観測した停止の合計 (ミリ秒) */
  readonly stallMs: number;
  /**
   * 到着の間隔が停止区間と重なった音声 Object の数
   *
   * 直前の到着から今回の到着までの間に停止区間がある到着を数える。止まっている間は
   * 到着のコールバックが動かないため、停止の直後に観測された到着がここに入る。
   */
  readonly overlappedArrivalCount: number;
}

/** 何も観測していないときの値 */
export const EMPTY_HOST_DELAY: HostDelaySnapshot = {
  stallCount: 0,
  stallMs: 0,
  overlappedArrivalCount: 0,
};

/** 保持する停止区間 */
interface StallInterval {
  readonly startMs: number;
  readonly endMs: number;
}

/** 保持する到着 */
interface ArrivalRecord {
  readonly atMs: number;
}

/**
 * メインスレッドの停止区間と音声の到着を突き合わせる
 *
 * 音声の購読ごとに 1 つ作る。`PerformanceObserver` の `longtask` を受け取るたびに
 * `recordStall()`、音声 Object の到着のたびに `recordArrival()` を呼び、統計を出す
 * ときに `snapshot()` を呼ぶ。`PerformanceObserver` が無い環境ではどちらも呼ばれない
 * ため、このクラス自身は何もしない。
 *
 * 到着は記録した順に並んでいるものとして扱う (音声の受信は 1 本の順序で処理する)。
 */
export class HostDelayTracker {
  /** 保持する窓の長さ (ミリ秒) */
  private readonly windowMs: number;
  /** 直近の窓の停止区間 (古い順) */
  private readonly stalls: StallInterval[] = [];
  /** 直近の窓の到着 (古い順) */
  private readonly arrivals: ArrivalRecord[] = [];

  constructor(windowMs: number = HOST_DELAY_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * メインスレッドの停止区間を記録する
   *
   * `PerformanceObserver` の `longtask` の `startTime` と `duration` をそのまま渡す。
   * 停止の報告は止まった後 (次のタスク) に届くため、記録の順序は到着の記録と前後し得る。
   * 重なりの判定は `snapshot()` で行うため、順序に依らない。
   *
   * @param startMs - 停止が始まった時刻 (`performance.now()` と同じ軸のミリ秒)
   * @param durationMs - 停止の長さ (ミリ秒)
   */
  recordStall(startMs: number, durationMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const endMs = startMs + durationMs;
    this.stalls.push({ startMs, endMs });
    this.pruneStalls(endMs);
  }

  /**
   * 音声 Object の到着を記録する
   *
   * @param atMs - 到着を観測した時刻 (`performance.now()` と同じ軸のミリ秒)
   */
  recordArrival(atMs: number): void {
    if (!Number.isFinite(atMs)) {
      return;
    }
    this.arrivals.push({ atMs });
    this.pruneArrivals(atMs);
  }

  /**
   * 直近の窓の観測値を返す
   *
   * @param nowMs - 現在時刻 (`performance.now()` と同じ軸のミリ秒)
   */
  snapshot(nowMs: number): HostDelaySnapshot {
    this.pruneStalls(nowMs);
    this.pruneArrivals(nowMs);

    let stallMs = 0;
    for (const stall of this.stalls) {
      stallMs += stall.endMs - stall.startMs;
    }

    let overlappedArrivalCount = 0;
    for (let index = 1; index < this.arrivals.length; index++) {
      const previous = this.arrivals[index - 1];
      const current = this.arrivals[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (this.overlapsStall(previous.atMs, current.atMs)) {
        overlappedArrivalCount++;
      }
    }

    return {
      stallCount: this.stalls.length,
      stallMs,
      overlappedArrivalCount,
    };
  }

  /** 記録を消す (購読を始めるときと、購読を止めるとき) */
  reset(): void {
    this.stalls.length = 0;
    this.arrivals.length = 0;
  }

  /**
   * 到着の間隔 (fromMs, toMs] が停止区間と重なるか
   *
   * 停止区間は [startMs, endMs) として扱う。到着が停止の始まった瞬間 (toMs === startMs)
   * と、停止の終わった瞬間が直前の到着 (fromMs === endMs) のときは、停止の外側の到着で
   * あるため重ならない。
   */
  private overlapsStall(fromMs: number, toMs: number): boolean {
    for (const stall of this.stalls) {
      if (fromMs < stall.endMs && toMs > stall.startMs) {
        return true;
      }
    }
    return false;
  }

  /** 窓より古い停止区間を捨てる */
  private pruneStalls(nowMs: number): void {
    const oldestMs = nowMs - this.windowMs;
    while (this.stalls.length > 0 && (this.stalls[0]?.endMs ?? 0) <= oldestMs) {
      this.stalls.shift();
    }
  }

  /**
   * 窓より古い到着を捨てる
   *
   * 窓の先頭の到着についても、その前の到着との間隔を求められるよう、窓より古い最後の
   * 到着を 1 件だけ基準として残す。2 件以上前の到着は間隔の判定に使わないため捨てる。
   */
  private pruneArrivals(nowMs: number): void {
    const oldestMs = nowMs - this.windowMs;
    while (
      this.arrivals.length > 1 &&
      (this.arrivals[1]?.atMs ?? Number.POSITIVE_INFINITY) <= oldestMs
    ) {
      this.arrivals.shift();
    }
  }
}
