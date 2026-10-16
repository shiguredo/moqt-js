/**
 * 音声の再生の遅れを、到着の遅れの分布から決める
 *
 * libwebrtc の NetEq (`modules/audio_coding/neteq/delay_manager.cc` の `DelayManager` と
 * `underrun_optimizer.cc` / `histogram.cc` / `packet_arrival_history.cc`) の移植である。
 * 音声の jitter buffer の目標遅延を、到着の遅れの分布から「途切れの確率が一定以下になる」
 * 値として求める。固定の下限ではなく分布から求めることで、経路の揺らぎが小さいときは
 * 遅延を下げ、大きいときだけ上げる。
 *
 * libwebrtc の規則:
 *
 * - 到着の遅れは「直近 2 秒の窓で最も早く届いたパケット (到着 - TIMESTAMP が最小) を
 *   基準にした相対値」である (`PacketArrivalHistory::GetPacketArrivalDelayMs`)。送信側と
 *   受信側の時計のずれと経路の最小遅延は基準に含まれ、引き算で消える
 * - その相対値を、500 ms ごとに 1 つだけ (区間の最大値) ヒストグラムへ入れる
 *   (`resample_interval_ms = 500`)。ジッタの尾を遅延に反映させるため、平均ではなく
 *   区間の最大を使う
 * - ヒストグラムは 20 ms ごとの 100 バケット (0 から 2000 ms) で、`forget_factor`
 *   (0.983) で古い観測を忘れる。最初の数回は `start_forget_weight` (2) で忘れ方を
 *   速くし、すぐ収束させる
 * - 目標遅延は 0.95 分位のバケットから `(1 + バケット) * 20` ms とする。これは
 *   「途切れの確率が 5% 未満になる遅延」である。まだ観測が無いときは 80 ms
 *
 * 分位点の計算は libwebrtc では固定小数点 (Q15 / Q30) で行うが、ここでは同じ重み付けを
 * 倍精度で行う (固定小数点の丸めの補正項は、その誤差のためのものであり必要ない)。
 *
 * libwebrtc の `ReorderOptimizer` (並べ替えで届いたパケットの割合からコスト最小の遅延を
 * 求める) は移植していない。音声は 1 つの Subgroup の stream で Group の順に届き、
 * 並べ替えは起きにくいためである。
 *
 * 単位はミリ秒、時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 */

/**
 * 観測を保持する窓 (ミリ秒)
 *
 * libwebrtc の `kPacketHistorySizeMs` と同じ値
 */
export const AUDIO_DELAY_HISTORY_WINDOW_MS = 2_000;

/** ヒストグラムのバケット数。libwebrtc の `kDelayBuckets` と同じ値 */
export const AUDIO_DELAY_BUCKETS = 100;

/** ヒストグラムのバケットの幅 (ミリ秒)。libwebrtc の `kBucketSizeMs` と同じ値 */
export const AUDIO_DELAY_BUCKET_MS = 20;

/**
 * 目標にする分位点
 *
 * libwebrtc の `DelayManager::Config::quantile` と同じ値。「途切れの確率が 1 - 0.95 =
 * 5% 未満になる遅延」を目標にする
 */
export const AUDIO_DELAY_QUANTILE = 0.95;

/** ヒストグラムの忘れ係数。libwebrtc の `Config::forget_factor` と同じ値 */
export const AUDIO_DELAY_FORGET_FACTOR = 0.983;

/** 忘れ方の収束を速くする重み。libwebrtc の `Config::start_forget_weight` と同じ値 */
export const AUDIO_DELAY_START_FORGET_WEIGHT = 2;

/**
 * ヒストグラムへ入れる間隔 (ミリ秒)
 *
 * libwebrtc の `Config::resample_interval_ms` と同じ値。区間の最大の遅れだけを入れる
 */
export const AUDIO_DELAY_RESAMPLE_INTERVAL_MS = 500;

/**
 * 観測が無いときの目標遅延 (ミリ秒)
 *
 * libwebrtc の `kStartDelayMs` と同じ値。最初のヒストグラムの更新まではこの値を使う
 */
export const AUDIO_DELAY_START_MS = 80;

/** 到着の遅れの観測 */
interface Arrival {
  /** 復号の出力の時刻 (受信側の壁時計、ミリ秒) */
  readonly arrivalMs: number;
  /** TIMESTAMP (送信側の壁時計、ミリ秒) */
  readonly captureMs: number;
}

/**
 * 忘れ方と重みを持つヒストグラム
 *
 * libwebrtc の `modules/audio_coding/neteq/histogram.cc` と同じ規則である。バケットの
 * 合計は常に 1 で、追加のたびに全体を `forgetFactor` 倍し、観測したバケットへ
 * `1 - forgetFactor` を足す。
 */
class DelayHistogram {
  private readonly buckets: number[];
  private forgetFactor = 0;
  private addCount = 0;

  /**
   * @param numBuckets - バケット数
   * @param baseForgetFactor - 収束後の忘れ係数
   * @param startForgetWeight - 最初の数回の忘れ方の重み
   */
  constructor(
    private readonly numBuckets: number,
    private readonly baseForgetFactor: number,
    private readonly startForgetWeight: number,
  ) {
    this.buckets = Array.from<number>({ length: numBuckets }).fill(0);
    this.reset();
  }

  /** 初期分布 (0.5^(i+1)) に戻す。libwebrtc の `Histogram::Reset` と同じ */
  reset(): void {
    for (let index = 0; index < this.numBuckets; index++) {
      this.buckets[index] = 0.5 ** (index + 1);
    }
    this.forgetFactor = 0;
    this.addCount = 0;
  }

  /** 観測したバケットの重みを上げ、ほかのバケットの重みを下げる */
  add(value: number): void {
    for (let index = 0; index < this.numBuckets; index++) {
      this.buckets[index] = (this.buckets[index] ?? 0) * this.forgetFactor;
    }
    this.buckets[value] = (this.buckets[value] ?? 0) + (1 - this.forgetFactor);
    this.addCount += 1;
    // 最初の数回は忘れ方を速くし、目標をすぐ観測へ合わせる
    if (this.forgetFactor !== this.baseForgetFactor) {
      const factor = 1 - this.startForgetWeight / (this.addCount + 1);
      this.forgetFactor = Math.max(0, Math.min(this.baseForgetFactor, factor));
    }
  }

  /**
   * 分位点のバケットを返す
   *
   * libwebrtc の `Histogram::Quantile` と同じで、先頭から足し上げた確率が
   * `probability` を超える最小のバケットを返す
   */
  quantile(probability: number): number {
    const inverseProbability = 1 - probability;
    let index = 0;
    let sum = 1;
    sum -= this.buckets[index] ?? 0;
    while (sum > inverseProbability && index < this.numBuckets - 1) {
      index += 1;
      sum -= this.buckets[index] ?? 0;
    }
    return index;
  }
}

/** `AudioDelayManager` の設定 (省略時は libwebrtc の既定値) */
export interface AudioDelayManagerOptions {
  historyWindowMs?: number;
  resampleIntervalMs?: number;
  quantile?: number;
  forgetFactor?: number;
}

/**
 * 音声トラックごとに 1 つ持つ
 *
 * `observe` に「復号の出力の時刻」と「その TIMESTAMP」を渡す。目標遅延は
 * `targetDelayMs` で読む。
 */
export class AudioDelayManager {
  private readonly historyWindowMs: number;
  private readonly resampleIntervalMs: number;
  private readonly quantile: number;
  private readonly histogram: DelayHistogram;
  // 直近の観測。窓より古いものは捨てる
  private readonly arrivals: Arrival[] = [];
  // 500 ms の区間の最大の相対遅延と、その区間の開始時刻
  private intervalStartMs: number | null = null;
  private maxInIntervalMs = 0;
  // 求めた目標遅延。まだヒストグラムへ入れていなければ null
  private optimalDelayMs: number | null = null;

  constructor(options: AudioDelayManagerOptions = {}) {
    this.historyWindowMs = options.historyWindowMs ?? AUDIO_DELAY_HISTORY_WINDOW_MS;
    this.resampleIntervalMs = options.resampleIntervalMs ?? AUDIO_DELAY_RESAMPLE_INTERVAL_MS;
    this.quantile = options.quantile ?? AUDIO_DELAY_QUANTILE;
    this.histogram = new DelayHistogram(
      AUDIO_DELAY_BUCKETS,
      options.forgetFactor ?? AUDIO_DELAY_FORGET_FACTOR,
      AUDIO_DELAY_START_FORGET_WEIGHT,
    );
  }

  /**
   * 復号の出力を 1 つ記録する
   *
   * @param arrivalMs - 復号の出力の時刻 (受信側の壁時計、ミリ秒)
   * @param captureMs - その TIMESTAMP (送信側の壁時計、ミリ秒)
   */
  observe(arrivalMs: number, captureMs: number): void {
    const relativeDelayMs = this.relativeDelayMs(arrivalMs, captureMs);
    this.arrivals.push({ arrivalMs, captureMs });
    this.pruneArrivals(captureMs);

    this.intervalStartMs ??= arrivalMs;
    // 区間の最大の遅れだけをヒストグラムへ入れる (500 ms ごと)
    let update: number | null = null;
    if (arrivalMs - this.intervalStartMs > this.resampleIntervalMs) {
      update = this.maxInIntervalMs;
      this.intervalStartMs = arrivalMs;
      this.maxInIntervalMs = 0;
    }
    this.maxInIntervalMs = Math.max(this.maxInIntervalMs, relativeDelayMs);
    if (update === null) {
      return;
    }
    const index = Math.trunc(update / AUDIO_DELAY_BUCKET_MS);
    if (index < 0 || index >= AUDIO_DELAY_BUCKETS) {
      return;
    }
    this.histogram.add(index);
    const bucket = this.histogram.quantile(this.quantile);
    this.optimalDelayMs = (1 + bucket) * AUDIO_DELAY_BUCKET_MS;
  }

  /** 目標遅延 (ミリ秒)。まだ観測が無いときは `AUDIO_DELAY_START_MS` */
  get targetDelayMs(): number {
    return this.optimalDelayMs ?? AUDIO_DELAY_START_MS;
  }

  /** 観測と学習を消す (購読のやり直し) */
  reset(): void {
    this.histogram.reset();
    this.arrivals.length = 0;
    this.intervalStartMs = null;
    this.maxInIntervalMs = 0;
    this.optimalDelayMs = null;
  }

  /**
   * 直近の窓で最も早く届いた観測を基準にした相対遅延 (ミリ秒)
   *
   * libwebrtc の `PacketArrivalHistory::GetPacketArrivalDelayMs` と同じ式である。
   */
  private relativeDelayMs(arrivalMs: number, captureMs: number): number {
    let best: Arrival | null = null;
    for (const entry of this.arrivals) {
      if (entry.captureMs < captureMs - this.historyWindowMs) {
        continue;
      }
      if (best === null || entry.arrivalMs - entry.captureMs < best.arrivalMs - best.captureMs) {
        best = entry;
      }
    }
    if (best === null) {
      return 0;
    }
    return Math.max(0, arrivalMs - best.arrivalMs - (captureMs - best.captureMs));
  }

  /** 窓より古い観測を捨てる */
  private pruneArrivals(captureMs: number): void {
    const oldest = captureMs - this.historyWindowMs;
    let drop = 0;
    while (drop < this.arrivals.length && (this.arrivals[drop]?.captureMs ?? captureMs) < oldest) {
      drop += 1;
    }
    if (drop > 0) {
      this.arrivals.splice(0, drop);
    }
  }
}
