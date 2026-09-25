/**
 * 送信する映像フレームの遅延を区間ごとに記録する
 *
 * 受信側の遅延 (latencyBreakdown.ts の到着) は、publisher がフレームを読んだ時刻 (LOC の
 * TIMESTAMP) から受信までで、publisher の符号化と送信、経路、relay を含む。publisher の
 * 中の遅れを分けるため、フレームごとに次の区間を記録する。
 *
 * - 符号化 (encode): フレームを読んでから encoder の出力まで (encoder の待ちを含む)
 * - 送信 (send): encoder の出力から `Publisher.sendObject` の完了 (WebTransport の stream へ
 *   書き終えた時点) まで。moqt-js の送信の待ちと、WebTransport の送信の詰まり (backpressure)
 *   を含む
 *
 * encoder の待ちが上限を超えて符号化せずに捨てたフレームも数える。
 *
 * フレームは VideoFrame の timestamp (マイクロ秒) で対応づける。時刻は呼び出し側が引数で
 * 渡す (`performance.now()`)。
 */

import { summarizeTimings, type TimingSummary } from "./playbackTimingStats";
import { TimedValues } from "./timedValues";

/** 分布を求める直近の窓 (ミリ秒) */
export const PUBLISH_TIMING_WINDOW_MS = 10_000;

/** 統計の値 */
export interface PublishTimingSnapshot {
  /** フレームを読んでから encoder の出力まで (直近の窓の p50 / p95 / max、ミリ秒) */
  readonly encodeMs: TimingSummary | null;
  /** encoder の出力から sendObject の完了まで (直近の窓の p50 / p95 / max、ミリ秒) */
  readonly sendMs: TimingSummary | null;
  /** encoder の待ちが上限を超えて符号化せずに捨てたフレームの数 (累積) */
  readonly encodeQueueDrops: number;
}

/** 何も記録していないときの統計 */
export const EMPTY_PUBLISH_TIMING: PublishTimingSnapshot = {
  encodeMs: null,
  sendMs: null,
  encodeQueueDrops: 0,
};

/**
 * 送信する映像フレームの符号化と送信の時間を記録し、統計を求める
 */
export class PublishTimingStats {
  private readonly windowMs: number;
  // 読んだ時刻と encoder の出力の時刻 (timestamp ごと、記録した順)
  private readAt = new Map<number, number>();
  private encodedAt = new Map<number, number>();
  private readonly encodeTimes = new TimedValues();
  private readonly sendTimes = new TimedValues();
  private encodeQueueDrops = 0;

  /**
   * @param windowMs - 分布を求める直近の窓 (ミリ秒)。対応づける前の時刻もこの間だけ残す
   */
  constructor(windowMs: number = PUBLISH_TIMING_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** フレームを読んだことを記録する */
  recordRead(timestampMicros: number, nowMs: number): void {
    pruneTimes(this.readAt, nowMs - this.windowMs);
    this.readAt.delete(timestampMicros);
    this.readAt.set(timestampMicros, nowMs);
  }

  /** 読んだフレームを encoder の待ちが上限を超えたため符号化せずに捨てたことを記録する */
  recordEncodeQueueDrop(timestampMicros: number): void {
    this.readAt.delete(timestampMicros);
    this.encodeQueueDrops++;
  }

  /** encoder がフレームを出力したことを記録する。読んだ時刻との差を符号化の時間にする */
  recordEncoded(timestampMicros: number, nowMs: number): void {
    const readAtMs = this.readAt.get(timestampMicros);
    if (readAtMs === undefined) {
      return;
    }
    this.readAt.delete(timestampMicros);
    this.encodeTimes.push(nowMs, nowMs - readAtMs);
    pruneTimes(this.encodedAt, nowMs - this.windowMs);
    this.encodedAt.set(timestampMicros, nowMs);
  }

  /** フレームの送信 (sendObject) が完了したことを記録する。出力との差を送信の時間にする */
  recordSent(timestampMicros: number, nowMs: number): void {
    const encodedAtMs = this.encodedAt.get(timestampMicros);
    if (encodedAtMs === undefined) {
      return;
    }
    this.encodedAt.delete(timestampMicros);
    this.sendTimes.push(nowMs, nowMs - encodedAtMs);
  }

  /**
   * 統計を求める
   *
   * @param nowMs - 求める時刻 (`performance.now()`)。窓はこの時刻から遡る
   */
  snapshot(nowMs: number): PublishTimingSnapshot {
    const minAtMs = nowMs - this.windowMs;
    this.encodeTimes.prune(minAtMs);
    this.sendTimes.prune(minAtMs);
    return {
      encodeMs: summarizeTimings(this.encodeTimes.current()),
      sendMs: summarizeTimings(this.sendTimes.current()),
      encodeQueueDrops: this.encodeQueueDrops,
    };
  }

  /** 記録をすべて捨てる */
  reset(): void {
    this.readAt = new Map();
    this.encodedAt = new Map();
    this.encodeTimes.clear();
    this.sendTimes.clear();
    this.encodeQueueDrops = 0;
  }
}

/**
 * 窓より前の時刻を捨てる
 *
 * 対応づけられなかった記録 (出力されなかった、送信が失敗した) が残り続けないようにする。
 * Map は記録した順に並ぶため、先頭から窓の中に入るまで捨てる
 */
function pruneTimes(times: Map<number, number>, minAtMs: number): void {
  for (const [timestampMicros, atMs] of times) {
    if (atMs >= minAtMs) {
      break;
    }
    times.delete(timestampMicros);
  }
}
