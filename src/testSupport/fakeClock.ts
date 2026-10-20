/**
 * 復号前の遅延の段 (PreDecodeDelayStage) のテストで共有する、決定的な時計とタイマー
 *
 * 実時間を待たずに期限の計算・タイマーの張り直し・取り出しの順序を検証する。実際の
 * `setTimeout` は使わず、`advance` で時刻を進めたときにだけ期限の来たタイマーを実行する。
 *
 * テスト本文を持たないため vitest の `test.include` (`src/**\/*.{test,prop}.ts`) に一致
 * しない名前にして、テストファイルとして収集されるのを避ける。
 */

import type { PreDecodeDelayStageClock } from "../playout/preDecodeDelayStage";

/** 実行待ちのタイマー */
interface FakeTimer {
  readonly handle: number;
  readonly atMs: number;
  readonly callback: () => void;
}

/** 決定的な時計とタイマー */
export class FakePreDecodeDelayClock implements PreDecodeDelayStageClock {
  private currentMs = 0;
  private nextHandle = 1;
  private readonly timers: FakeTimer[] = [];

  /** 現在時刻 (ミリ秒) */
  now(): number {
    return this.currentMs;
  }

  /** タイマーを張る (テストでは実行せず、advance で実行する) */
  setTimer(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.push({ handle, atMs: this.currentMs + Math.max(0, delayMs), callback });
    return handle;
  }

  /** タイマーを解除する */
  clearTimer(handle: unknown): void {
    const index = this.timers.findIndex((timer) => timer.handle === handle);
    if (index !== -1) {
      this.timers.splice(index, 1);
    }
  }

  /**
   * 時刻を進め、期限の来たタイマーを期限の早い順に実行する
   *
   * コールバックの中で新しいタイマーが張られた場合も、その期限が進めた先までなら続けて
   * 実行する (実時間のイベントループと同じ振る舞い)。
   *
   * @param ms - 進める時間 (ミリ秒)
   */
  advance(ms: number): void {
    const targetMs = this.currentMs + ms;
    for (;;) {
      let next: FakeTimer | null = null;
      for (const timer of this.timers) {
        if (timer.atMs > targetMs) {
          continue;
        }
        if (
          next === null ||
          timer.atMs < next.atMs ||
          (timer.atMs === next.atMs && timer.handle < next.handle)
        ) {
          next = timer;
        }
      }
      if (next === null) {
        break;
      }
      const index = this.timers.indexOf(next);
      if (index !== -1) {
        this.timers.splice(index, 1);
      }
      this.currentMs = Math.max(this.currentMs, next.atMs);
      next.callback();
    }
    this.currentMs = targetMs;
  }

  /** 実行待ちのタイマーの数 */
  get pendingTimerCount(): number {
    return this.timers.length;
  }
}
