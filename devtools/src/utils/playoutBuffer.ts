/**
 * 復号した映像フレームを LOC TIMESTAMP (壁時計) の間隔どおりに表示する jitter buffer
 *
 * 到着のタイミングのままフレームを表示すると、経路の到着の揺らぎがそのまま表示間隔の
 * 揺らぎ (かくつき) になる。draft-ietf-moq-loc-04 Section 2.3.1.1 により、Timescale の
 * 無い TIMESTAMP は Unix epoch マイクロ秒の壁時計であり、フレームを撮った間隔を表す。
 * フレームを TIMESTAMP に一定の遅れを足した時刻に表示すれば、その遅れの範囲の揺らぎを
 * 吸収できる。
 *
 * 表示時刻 = TIMESTAMP + 基準の遅れ + 再生遅延
 *
 * - 基準の遅れ: 直近の窓の「表示できるようになった時刻 - TIMESTAMP」(遅れ) の最小値。
 *   送信側と受信側の時計のずれと、経路の最小の遅延を含む。遅れは到着ではなく復号の
 *   出力の時刻で測る (表示できる時刻には復号の時間も含まれるため)
 * - 再生遅延: 窓の中の「遅れ - 基準の遅れ」(揺らぎ) の百分位を目標にする。百分位は
 *   表示時刻の後に届くフレームが 1 秒に 1 枚までになるよう配信 fps から決める
 *   (`playoutDelayPercentile`)。
 *   目標が上がったら直ちに追従し (遅れて届くフレームを減らす)、下がったときは毎秒
 *   `PLAYOUT_DELAY_DECAY_MS_PER_SECOND` でゆっくり戻す (表示時刻が前へ飛ぶと、その分の
 *   フレームを捨てることになる。毎秒 20 ms は再生を 2% 速めるだけで、目では分からない)
 *
 * 次のフレームの揺らぎは再生遅延の目標に使わない (基準の遅れには使う)。
 *
 * - 開始 (と基準の取り直し) の後の最初のフレーム。購読の開始では relay の cache から
 *   Group の先頭以降の古いフレームがまとめて届き (cache replay)、その先頭は経路の揺らぎ
 *   ではない大きな遅れを持つ
 * - 前のフレームからフレーム間隔の半分より短い間隔で届いたフレーム (まとまって届いた
 *   フレーム)。まとまりの中では先頭のフレームが最も遅れており、後続は先頭の遅れを
 *   引き継いだだけで新しい情報を持たない。cache replay の後続もここで除く
 * - 揺らぎが再生遅延の上限を超えるフレーム。再生遅延では吸収できず、使うと再生遅延が
 *   上限に張り付く
 *
 * 時刻は呼び出し側が引数で渡す (`performance.now()`)。ブラウザ API に依存しない。
 */

import { TimedValues } from "./timedValues";

/**
 * 基準の遅れと揺らぎを求める直近の窓 (ミリ秒)
 *
 * 再生遅延の目標の百分位 (30 fps で約 96.7%、120 fps で約 99.2%) を求めるのに十分な数
 * (30 fps で 300 枚、120 fps で 1200 枚) のフレームを含み、経路の最小の遅延を表す程度に
 * 長い。長すぎると経路の遅延が変わったときに基準が追従しない
 */
export const PLAYOUT_WINDOW_MS = 10_000;

/**
 * 表示時刻の後に届くことを許すフレームの数 (1 秒あたり)
 *
 * 表示時刻の後に届いたフレームは、その表示周期に描けず止まりになる。見る側が感じるのは
 * 1 秒あたりの止まりの数であり、同じ割合で遅れを許すと、配信 fps が高いほど止まりが
 * 増える (5% なら 30 fps で 1 秒に 1.5 回、120 fps で 6 回)。許す数を 1 秒あたりで決め、
 * 再生遅延の目標にする揺らぎの百分位を配信 fps から求める (`playoutDelayPercentile`)
 */
export const LATE_FRAMES_PER_SECOND = 1;

/**
 * 再生遅延の目標にする揺らぎの百分位の下限
 *
 * 配信 fps が低い (20 fps 以下) と 1 秒に 1 枚は 5% を超えるため、95% のフレームは
 * 表示時刻までに届く長さを保つ。経路のまれな大きな遅延の跳ね (数分に数回、300 ms 前後)
 * まで吸収しようとすると、常に大きく遅れて表示することになるため、百分位は 100% にしない
 */
export const MIN_PLAYOUT_DELAY_PERCENTILE = 0.95;

/**
 * 再生遅延の目標にする揺らぎの百分位
 *
 * 表示時刻の後に届くフレームが 1 秒に `LATE_FRAMES_PER_SECOND` 枚までになる百分位
 * (1 - フレーム間隔 × 枚数 / 1 秒) と下限の大きい方。30 fps で約 96.7%、60 fps で約 98.3%、
 * 120 fps で約 99.2% になる。
 *
 * @param frameIntervalMs - フレーム間隔 (ミリ秒)。不明なら null
 */
export function playoutDelayPercentile(frameIntervalMs: number | null): number {
  if (frameIntervalMs === null || frameIntervalMs <= 0) {
    return MIN_PLAYOUT_DELAY_PERCENTILE;
  }
  return Math.max(
    MIN_PLAYOUT_DELAY_PERCENTILE,
    1 - (frameIntervalMs * LATE_FRAMES_PER_SECOND) / 1_000,
  );
}

/** 再生遅延の上限 (ミリ秒)。これ以上遅れて表示するよりは、止まりを受け入れる */
export const MAX_PLAYOUT_DELAY_MS = 500;

/**
 * 表示時刻を過ぎたフレームを捨てずに描く、表示時刻からの遅れの上限 (ミリ秒)
 *
 * 60 Hz の表示周期 (16.7 ms) 程度にする。この範囲の遅れは目で分からず、配信 fps と
 * 表示周期が近いときに位相や取得の間隔の揺れで重なったフレームを捨てずに、後の周期で
 * 追いつける。30 fps では 2 枚が表示時刻を過ぎると古い方は 1 フレーム (33.3 ms) 遅れて
 * いるため捨て、最新を描く
 */
export const MAX_PRESENTATION_LAG_MS = 20;

/** 目標が下がったときに再生遅延を下げる速さ (ミリ秒 / 秒) */
export const PLAYOUT_DELAY_DECAY_MS_PER_SECOND = 20;

/**
 * 遅れが基準からこれ以上離れたら、TIMESTAMP の飛びとみなして基準を取り直す (ミリ秒)
 *
 * publisher の時計の変更や別の publisher への切り替えで TIMESTAMP が大きく戻ると、以降の
 * フレームがすべて遅れて見えて再生遅延が上限に張り付き、大きく進むとフレームが先の時刻で
 * 待ち続ける。再生遅延の上限 (500 ms) と通常の揺らぎより十分大きくする。
 * 2 秒を超える経路の停止も取り直しの対象になるが、停止の後は取り直した方が早く戻る
 */
export const PLAYOUT_DISCONTINUITY_MS = 2_000;

/**
 * jitter buffer が有効なときの表示待ちのキューの上限 (枚)
 *
 * 保持している VideoFrame は decoder のメモリを占める。30 fps で再生遅延の上限 (500 ms)
 * を保持できる枚数に余裕を足した値にする
 */
export const JITTER_BUFFER_MAX_QUEUED_FRAMES = 24;

/**
 * キューの上限のうち、揺らぎで一時的に増える分として空けておく枚数
 *
 * 再生遅延は (上限 - この枚数) 枚分のフレーム間隔までに抑える。フレーム間隔が短い
 * (120 fps など) ほど長く待てない
 */
export const PLAYOUT_QUEUE_HEADROOM_FRAMES = 4;

// フレーム間隔を求めるために保持する TIMESTAMP の差の数
const FRAME_INTERVAL_SAMPLES = 32;

/** 表示待ちのフレーム */
interface QueuedFrame<T> {
  readonly item: T;
  // 壁時計の TIMESTAMP (ミリ秒)。壁時計として使えないフレームは null で、届いた順に
  // 1 枚ずつ表示する
  timestampMs: number | null;
}

/** 1 回の選択の結果 */
export interface PlayoutSelection<T> {
  /** 描くフレーム (無ければ null) */
  readonly draw: T | null;
  /** 表示時刻を過ぎたが、より新しいフレームが 2 枚以上表示時刻を過ぎていたため捨てるフレーム */
  readonly late: T[];
  /**
   * 描くフレームの表示時刻 (`performance.now()` の時間軸、ミリ秒)。表示時刻を決めずに
   * 届いた順に描く (壁時計の TIMESTAMP を持たない) フレームと、描くフレームが無いときは null
   */
  readonly drawPresentationMs: number | null;
}

/** 昇順に並べた値の nearest-rank 法の百分位 */
function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? 0;
}

/**
 * 復号したフレームを積み、表示時刻に合わせて選ぶ
 *
 * フレームは積んだ順に並べたまま扱い、並べ替えない (復号の出力は TIMESTAMP の順である)。
 */
export class PlayoutBuffer<T> {
  private readonly maxQueuedFrames: number;
  private queue: QueuedFrame<T>[] = [];
  // 表示できるようになった時刻 - TIMESTAMP (ミリ秒)。基準の遅れ (最小値) に使う
  private readonly offsets = new TimedValues();
  // offsets のうち再生遅延の目標に使うもの (最初のフレームとまとまって届いたフレームを除く)
  private readonly learningOffsets = new TimedValues();
  // 直前に積んだ壁時計の TIMESTAMP のフレームの、表示できるようになった時刻
  private lastArrivalMs: number | null = null;
  private baseMs: number | null = null;
  private delayMs: number | null = null;
  private lastUpdateMs = 0;
  private lastTimestampMs: number | null = null;
  // 続けて積んだフレームの TIMESTAMP の差 (ミリ秒)
  private frameIntervals: number[] = [];

  /**
   * @param maxQueuedFrames - 表示待ちのキューの上限 (枚)。超えたら古い方から捨てる
   */
  constructor(maxQueuedFrames: number) {
    this.maxQueuedFrames = maxQueuedFrames;
  }

  /** 表示待ちのフレーム数 */
  get size(): number {
    return this.queue.length;
  }

  /**
   * 復号したフレームを積む
   *
   * @param item - フレーム
   * @param nowMs - 表示できるようになった時刻 (`performance.now()`)
   * @param timestampMicros - 壁時計の TIMESTAMP (Unix epoch マイクロ秒)。壁時計として
   *   使えないフレーム (Timescale あり / TIMESTAMP 無し) は null
   * @returns キューの上限を超えたため捨てるフレーム (古い方から)
   */
  enqueue(item: T, nowMs: number, timestampMicros: number | null): T[] {
    const timestampMs = timestampMicros === null ? null : timestampMicros / 1_000;
    if (timestampMs !== null) {
      this.observe(nowMs, timestampMs);
    }
    this.queue.push({ item, timestampMs });
    const overflow: T[] = [];
    while (this.queue.length > this.maxQueuedFrames) {
      const head = this.queue.shift();
      if (head !== undefined) {
        overflow.push(head.item);
      }
    }
    return overflow;
  }

  /**
   * 表示するフレームを選ぶ (requestAnimationFrame ごとに呼ぶ)
   *
   * 先頭が壁時計の TIMESTAMP を持たないフレームなら、それを描く (届いた順に 1 枚ずつ)。
   * 先頭が表示時刻前なら何も描かずに待つ。
   *
   * 表示時刻を過ぎたフレームのうち、表示時刻からの遅れが `MAX_PRESENTATION_LAG_MS` を
   * 超えたものを捨て (最新の 1 枚は遅れていても残す)、残りの最も古いフレームを描く。
   * 表示時刻を過ぎたフレームのうち最新だけを描くと、配信 fps と表示周期が近いとき
   * (120 fps を 120 Hz で表示するなど)、表示時刻と選択の位相の揺れや publisher の取得の
   * 間隔の揺れ (間隔の短い 2 枚) で 2 枚以上が重なった周期のたびに捨て、次の周期は何も
   * 描けずに表示が飛ぶ。上限までの遅れを許して 1 枚ずつ描けば、後の周期で追いつける。
   *
   * @param nowMs - 現在の時刻 (`performance.now()`)
   */
  select(nowMs: number): PlayoutSelection<T> {
    const head = this.queue[0];
    if (head === undefined) {
      return { draw: null, late: [], drawPresentationMs: null };
    }
    const baseMs = this.baseMs;
    const delayMs = this.delayMs;
    if (head.timestampMs === null || baseMs === null || delayMs === null) {
      this.queue.shift();
      return { draw: head.item, late: [], drawPresentationMs: null };
    }
    let lastDue = -1;
    for (const [index, frame] of this.queue.entries()) {
      if (frame.timestampMs === null || frame.timestampMs + baseMs + delayMs > nowMs) {
        break;
      }
      lastDue = index;
    }
    if (lastDue < 0) {
      return { draw: null, late: [], drawPresentationMs: null };
    }
    // 表示時刻から上限を超えて遅れたフレームを捨てる (最新の lastDue は残す)
    let drawIndex = 0;
    while (drawIndex < lastDue) {
      const frame = this.queue[drawIndex];
      if (
        frame === undefined ||
        frame.timestampMs === null ||
        frame.timestampMs + baseMs + delayMs >= nowMs - MAX_PRESENTATION_LAG_MS
      ) {
        break;
      }
      drawIndex++;
    }
    const late = this.queue.splice(0, drawIndex).map((frame) => frame.item);
    const drawn = this.queue.shift();
    if (drawn === undefined) {
      return { draw: null, late, drawPresentationMs: null };
    }
    // lastDue までのフレームは壁時計の TIMESTAMP を持つ (null のフレームで走査を止めている)
    return {
      draw: drawn.item,
      late,
      drawPresentationMs: drawn.timestampMs === null ? null : drawn.timestampMs + baseMs + delayMs,
    };
  }

  /**
   * 壁時計の TIMESTAMP のフレームの表示時刻 (`performance.now()` の時間軸、ミリ秒)。
   * まだ基準が無ければ null
   */
  presentationTimeMs(timestampMicros: number): number | null {
    if (this.baseMs === null || this.delayMs === null) {
      return null;
    }
    return timestampMicros / 1_000 + this.baseMs + this.delayMs;
  }

  /** 現在の再生遅延 (ミリ秒)。壁時計の TIMESTAMP のフレームをまだ積んでいなければ null */
  playoutDelayMs(): number | null {
    return this.delayMs;
  }

  /** 表示待ちのフレームをすべて取り出す (呼び出し側が閉じる)。基準と再生遅延は残す */
  clear(): T[] {
    const items = this.queue.map((frame) => frame.item);
    this.queue = [];
    return items;
  }

  /** 壁時計の TIMESTAMP のフレームの遅れを記録し、基準の遅れと再生遅延を更新する */
  private observe(nowMs: number, timestampMs: number): void {
    const offsetMs = nowMs - timestampMs;
    if (this.baseMs !== null && Math.abs(offsetMs - this.baseMs) >= PLAYOUT_DISCONTINUITY_MS) {
      this.restart();
    }

    // 最初のフレームと、まとまって届いたフレームは再生遅延の目標に使わない
    let learns = false;
    if (this.lastTimestampMs !== null && this.lastArrivalMs !== null) {
      const intervalMs = timestampMs - this.lastTimestampMs;
      if (intervalMs > 0) {
        this.frameIntervals.push(intervalMs);
        if (this.frameIntervals.length > FRAME_INTERVAL_SAMPLES) {
          this.frameIntervals.shift();
        }
      }
      learns = nowMs - this.lastArrivalMs >= intervalMs / 2;
    }
    this.lastTimestampMs = timestampMs;
    this.lastArrivalMs = nowMs;

    const minAtMs = nowMs - PLAYOUT_WINDOW_MS;
    this.offsets.push(nowMs, offsetMs);
    this.offsets.prune(minAtMs);
    if (learns) {
      this.learningOffsets.push(nowMs, offsetMs);
    }
    this.learningOffsets.prune(minAtMs);
    const baseMs = Math.min(...this.offsets.current());
    this.baseMs = baseMs;

    const frameIntervalMs = this.frameIntervalMs();
    const capMs = this.delayCapMs(frameIntervalMs);
    // 再生遅延の上限を超える揺らぎは吸収できないため目標に使わない
    const jitters = this.learningOffsets
      .current()
      .map((offset) => offset - baseMs)
      .filter((jitter) => jitter <= MAX_PLAYOUT_DELAY_MS)
      .sort((a, b) => a - b);
    const targetMs = Math.min(percentile(jitters, playoutDelayPercentile(frameIntervalMs)), capMs);
    if (this.delayMs === null || targetMs >= this.delayMs) {
      this.delayMs = targetMs;
    } else {
      const elapsedMs = Math.max(0, nowMs - this.lastUpdateMs);
      const decayedMs = this.delayMs - (PLAYOUT_DELAY_DECAY_MS_PER_SECOND * elapsedMs) / 1_000;
      // フレーム間隔が短くなって上限が下がったときは、上限まで直ちに下げる
      this.delayMs = Math.min(Math.max(targetMs, decayedMs), capMs);
    }
    this.lastUpdateMs = nowMs;
  }

  /**
   * 再生遅延の上限 (ミリ秒)。キューの上限を超えない長さ ((上限 - 余裕) 枚分のフレーム
   * 間隔) と `MAX_PLAYOUT_DELAY_MS` の小さい方
   */
  private delayCapMs(frameIntervalMs: number | null): number {
    if (frameIntervalMs === null) {
      return MAX_PLAYOUT_DELAY_MS;
    }
    const queueCapMs =
      Math.max(0, this.maxQueuedFrames - PLAYOUT_QUEUE_HEADROOM_FRAMES) * frameIntervalMs;
    return Math.min(MAX_PLAYOUT_DELAY_MS, queueCapMs);
  }

  /** 直近のフレーム間隔 (TIMESTAMP の差の中央値、ミリ秒)。まだ分からなければ null */
  private frameIntervalMs(): number | null {
    if (this.frameIntervals.length === 0) {
      return null;
    }
    const sorted = [...this.frameIntervals].sort((a, b) => a - b);
    return percentile(sorted, 0.5);
  }

  /**
   * TIMESTAMP の飛びで基準を取り直す。積んでいるフレームは新しい基準で表示時刻を求め
   * られないため、届いた順に 1 枚ずつ表示する
   */
  private restart(): void {
    this.offsets.clear();
    this.learningOffsets.clear();
    this.baseMs = null;
    this.delayMs = null;
    this.lastTimestampMs = null;
    this.lastArrivalMs = null;
    this.frameIntervals = [];
    for (const frame of this.queue) {
      frame.timestampMs = null;
    }
  }
}
