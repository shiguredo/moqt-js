/**
 * 記録した時刻の順に並んだ値の列
 *
 * 受信から表示までの時間の統計 (playbackTimingStats.ts) と jitter buffer
 * (playoutBuffer.ts) が、直近の窓の値を保持するために使う。
 *
 * 記録の時刻は単調に増える (`performance.now()`) ため、窓より古い値は先頭にある。
 * 先頭から捨てるときに配列を詰め直さないよう、読み始めの位置を進め、半分を超えたら
 * まとめて詰める。
 */
export class TimedValues {
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

  /**
   * 窓の中の最も古い記録 (時刻と値)。無ければ null
   *
   * 値が窓の中でどれだけ動いたかを見るために使う。
   */
  oldest(): { atMs: number; value: number } | null {
    if (this.head >= this.times.length) {
      return null;
    }
    const atMs = this.times[this.head];
    const value = this.values[this.head];
    if (atMs === undefined || value === undefined) {
      return null;
    }
    return { atMs, value };
  }

  /**
   * atMs が sinceMs より後の値。無ければ空の配列
   *
   * 窓 (prune) より短い区間の分布を取り直すために使う。窓全体の分布は、目標を変えた
   * 結果が現れるまでに時間がかかるため、直近の観測だけを見たいことがある
   */
  since(sinceMs: number): number[] {
    const values: number[] = [];
    for (let index = this.times.length - 1; index >= this.head; index--) {
      if ((this.times[index] ?? sinceMs) <= sinceMs) {
        break;
      }
      const value = this.values[index];
      if (value !== undefined) {
        values.push(value);
      }
    }
    values.reverse();
    return values;
  }

  /**
   * atMs が sinceMs 以降の値の最小値。無ければ null
   *
   * 窓 (prune) より短い区間の最小値を取り直すために使う。窓全体の最小値は、値が
   * 単調に動いているときに最も古い観測を指したままになるため、直近の動きを見るには
   * 短い区間で取り直す必要がある。
   */
  minAfter(sinceMs: number): number | null {
    let min: number | null = null;
    for (let index = this.times.length - 1; index >= this.head; index--) {
      if ((this.times[index] ?? sinceMs) < sinceMs) {
        break;
      }
      const value = this.values[index] ?? 0;
      min = min === null ? value : Math.min(min, value);
    }
    return min;
  }

  clear(): void {
    this.times = [];
    this.values = [];
    this.head = 0;
  }
}
