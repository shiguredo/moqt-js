/**
 * NetEq の区間最大値による推定を比較するための独立した実験実装。
 * 500 ms ごとの最大値、20 ms の階級、0.983 の忘却、95 百分位だけを比較する。
 * NetEq 全体の移植ではなく、再生や並べ替え、起動予算は現行実装に任せる。
 */
export class IntervalPeakDelay {
  histogram = new Float64Array(100);
  intervalStartMs = null;
  maximumMs = 0;
  delayMs = null;

  observe(nowMs, delayMs) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(delayMs)) return;
    this.intervalStartMs ??= nowMs;
    if (nowMs - this.intervalStartMs > 500) {
      let weight = 0;
      for (let index = 0; index < this.histogram.length; index++) {
        this.histogram[index] *= 0.983;
        weight += this.histogram[index];
      }
      const bucket = Math.floor(this.maximumMs / 20);
      if (bucket < this.histogram.length) {
        this.histogram[bucket] += 1;
        weight += 1;
      }
      let accumulated = 0;
      for (let index = 0; index < this.histogram.length; index++) {
        accumulated += this.histogram[index];
        if (weight > 0 && accumulated >= weight * 0.95) {
          this.delayMs = (index + 1) * 20;
          break;
        }
      }
      this.intervalStartMs = nowMs;
      this.maximumMs = 0;
    }
    this.maximumMs = Math.max(this.maximumMs, Math.max(0, delayMs));
  }
}

/**
 * Moon ら (1998) §4.2 の、スパイク中は遅延分布へ入れない方式を比較する。
 * 相対遅延の基準が 0 になるため、開始判定の基準には最低 1 フレーム分を使う。
 * スパイク中に必要な待ちは呼び出し側で現在の遅れから求め、過去の分布には残さない。
 */
export class SpikeDelayGate {
  tailMs = null;

  get active() {
    return this.tailMs !== null;
  }

  observe(jitterMs, learnedJitterMs, frameIntervalMs) {
    if (this.tailMs !== null) {
      if (jitterMs <= this.tailMs) this.tailMs = null;
    } else {
      const referenceMs = Math.max(learnedJitterMs, frameIntervalMs);
      if (jitterMs > referenceMs * 4) this.tailMs = referenceMs * 2;
    }
    return !this.active;
  }
}
