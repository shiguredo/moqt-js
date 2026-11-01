/**
 * 復号した映像フレームを、共有の時間軸が決めた表示時刻に合わせて選ぶキュー
 *
 * 到着のタイミングのままフレームを出し入れすると、経路の到着の揺らぎがそのまま表示間隔の
 * 揺らぎ (かくつき) になる。表示時刻は `src/playout/timeline.ts` が LOC TIMESTAMP と
 * 共有の基準の遅れ・再生遅延から決める (音声と同じ式)。学習 (基準の遅れ、再生遅延、
 * フレーム間隔) は時間軸が持つ。
 *
 * - 表示周期ごとに `selectNearest` を 1 回呼び、目標表示時刻に最も近いフレームを 1 枚選ぶ
 * - 目標表示時刻から許容幅より古いフレームは提示せず、捨てるフレームとして返す。遅れて
 *   提示すると、次のフレームを早く出して表示間隔が半分になるためである
 * - 提示しないフレームは呼び出し側が閉じ、計器へ記録する
 * - 表示時刻を決められないフレーム (壁時計の TIMESTAMP を持たない、または時間軸が
 *   そのトラックの TIMESTAMP を使わない) は、届いた順に 1 回の選択で 1 枚ずつ描く
 *
 * 時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 */

import type { PlayoutStream, PlayoutTimeline } from "./timeline";

/**
 * 表示待ちのキューの上限 (枚)
 *
 * 保持している VideoFrame は decoder のメモリを占める。30 fps で再生遅延の上限 (500 ms)
 * を保持できる枚数に余裕を足した値にする
 */
export const JITTER_BUFFER_MAX_QUEUED_FRAMES = 24;

/**
 * 表示時刻を過ぎたフレームを、表示できるフレームが無いときに限って遅れて提示する上限 (ミリ秒)
 *
 * 目標表示時刻に合うフレームがキューに無く、かつ遅れがこの範囲なら、1 枚だけ遅れて提示する。
 * 表示を止めないための逃げ道であり、通常は目標に最も近いフレームを提示する。
 */
export const MAX_PRESENTATION_LAG_MS = 20;

/** 表示待ちのフレーム */
interface QueuedFrame<T> {
  readonly item: T;
  // 壁時計の TIMESTAMP (マイクロ秒)。壁時計として使えないフレームは null で、届いた順に
  // 1 枚ずつ表示する
  readonly timestampMicros: number | null;
  // 積んだときの時間軸の世代。基準を取り直すと表示時刻を決められなくなる
  readonly generation: number;
}

/** 1 回の選択の結果 */
export interface PlayoutNearestSelection<T> {
  /** 描くフレーム (無ければ null) */
  readonly draw: T | null;
  /**
   * 提示せずに捨てるフレーム
   *
   * 目標表示時刻から許容幅より古いフレームと、同じ目標表示時刻に重なったため選ばれなかった
   * フレームである。呼び出し側が閉じ、計器へ記録する。
   */
  readonly dropped: T[];
  /**
   * 描くフレームの表示時刻 (`performance.now()` の時間軸、ミリ秒)。表示時刻を決めずに
   * 届いた順に描く (壁時計の TIMESTAMP を持たない) フレームと、描くフレームが無いときは null
   */
  readonly drawPresentationMs: number | null;
  /** 目標表示時刻を過ぎたフレームを、表示できるフレームが無いため遅れて提示したか */
  readonly drawLate: boolean;
}

/**
 * 復号したフレームを積み、目標表示時刻に最も近い 1 枚を選ぶ
 *
 * フレームは積んだ順に並べたまま扱い、並べ替えない (復号の出力は TIMESTAMP の順である)。
 */
export class PlayoutBuffer<T> {
  private readonly maxQueuedFrames: number;
  private readonly timeline: PlayoutTimeline;
  private readonly stream: PlayoutStream;
  private queue: QueuedFrame<T>[] = [];

  /**
   * @param maxQueuedFrames - 表示待ちのキューの上限 (枚)。超えたら古い方から捨てる
   * @param timeline - 表示時刻を決める共有の時間軸
   * @param stream - このキューのトラック (既定は video)
   */
  constructor(maxQueuedFrames: number, timeline: PlayoutTimeline, stream: PlayoutStream = "video") {
    this.maxQueuedFrames = maxQueuedFrames;
    this.timeline = timeline;
    this.stream = stream;
  }

  /** 表示待ちのフレーム数 */
  get size(): number {
    return this.queue.length;
  }

  /**
   * 復号したフレームを積む
   *
   * @param item - フレーム
   * @param timestampMicros - 壁時計の TIMESTAMP (Unix epoch マイクロ秒)。壁時計として
   *   使えないフレーム (Timescale あり / TIMESTAMP 無し) は null
   * @returns キューの上限を超えたため捨てるフレーム (古い方から)
   */
  enqueue(item: T, timestampMicros: number | null): T[] {
    this.queue.push({ item, timestampMicros, generation: this.timeline.generation });
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
   * 目標表示時刻に最も近いフレームを 1 枚選ぶ (表示周期ごとに呼ぶ)
   *
   * 先頭が表示時刻を決められないフレームなら、それを描く (届いた順に 1 枚ずつ)。
   * 表示時刻を決められるフレームでは、目標表示時刻から許容幅以内で最も近いものを描く。
   * 許容幅より古いフレームは、そのフレームを提示できた表示周期を過ぎているため、捨てる
   * フレームとして返す。許容幅より未来のフレームしかない場合は何も描かない。
   *
   * @param targetMs - この選択で表示したい時刻 (`performance.now()` の時間軸、ミリ秒)
   * @param toleranceMs - 目標表示時刻からの許容幅 (ミリ秒)。負の値は受け付けない
   * @returns 描くフレーム、捨てるフレーム、描くフレームの表示時刻
   */
  selectNearest(targetMs: number, toleranceMs: number): PlayoutNearestSelection<T> {
    if (!(toleranceMs >= 0)) {
      throw new RangeError(`toleranceMs must be a non-negative finite number, got ${toleranceMs}`);
    }
    const head = this.queue[0];
    if (head === undefined) {
      return { draw: null, dropped: [], drawPresentationMs: null, drawLate: false };
    }
    if (this.framePresentationMs(head) === null) {
      this.queue.shift();
      return { draw: head.item, dropped: [], drawPresentationMs: null, drawLate: false };
    }

    // 表示時刻を過ぎて久しいフレームは、目標表示時刻に合うフレームが無いときの逃げ道
    // (MAX_PRESENTATION_LAG_MS) にも使えないため、先に捨てる
    const dropped: T[] = [];
    while (this.queue.length > 0) {
      const frame = this.queue[0];
      if (frame === undefined) {
        break;
      }
      const presentationMs = this.framePresentationMs(frame);
      if (presentationMs === null || presentationMs >= targetMs - MAX_PRESENTATION_LAG_MS) {
        break;
      }
      this.queue.shift();
      dropped.push(frame.item);
    }

    let bestIndex = -1;
    let bestDistanceMs = Number.POSITIVE_INFINITY;
    let bestPresentationMs: number | null = null;
    for (const [index, frame] of this.queue.entries()) {
      const presentationMs = this.framePresentationMs(frame);
      if (presentationMs === null || presentationMs > targetMs + toleranceMs) {
        break;
      }
      const distanceMs = Math.abs(presentationMs - targetMs);
      if (distanceMs < bestDistanceMs) {
        bestIndex = index;
        bestDistanceMs = distanceMs;
        bestPresentationMs = presentationMs;
      }
    }
    if (bestIndex < 0 || bestPresentationMs === null) {
      // 目標表示時刻に合うフレームは無い。未来のフレームだけなら待つ
      return { draw: null, dropped, drawPresentationMs: null, drawLate: false };
    }

    // 選んだフレームより前のフレームは、この表示周期でも次の表示周期でも提示できない
    const skipped = this.queue.splice(0, bestIndex).map((frame) => frame.item);
    dropped.push(...skipped);
    const drawn = this.queue.shift();
    if (drawn === undefined) {
      return { draw: null, dropped, drawPresentationMs: null, drawLate: false };
    }
    const drawLate = bestPresentationMs < targetMs - toleranceMs;
    return {
      draw: drawn.item,
      dropped,
      drawPresentationMs: bestPresentationMs,
      drawLate,
    };
  }

  /**
   * 壁時計の TIMESTAMP のフレームの表示時刻 (`performance.now()` の時間軸、ミリ秒)。
   * まだ基準が無い、またはこのトラックの TIMESTAMP を使わないときは null
   */
  presentationTimeMs(timestampMicros: number | null): number | null {
    if (timestampMicros === null) {
      return null;
    }
    return this.timeline.presentationPerformanceMs(this.stream, timestampMicros);
  }

  /** 現在の再生遅延 (ミリ秒)。壁時計の TIMESTAMP のフレームをまだ積んでいなければ null */
  playoutDelayMs(): number | null {
    return this.timeline.videoDelayMs;
  }

  /** キューを空にする */
  clear(): T[] {
    const cleared = this.queue.map((frame) => frame.item);
    this.queue = [];
    return cleared;
  }

  /**
   * 積んだときの世代が今と同じフレームの表示時刻
   *
   * 基準を取り直した後に残っているフレームは、新しい基準では表示時刻が飛びの分だけ未来に
   * なる。決められないものとして null を返し、届いた順に描く (取り直し前の `PlayoutBuffer`
   * が積んでいたフレームの timestamp を消していたのと同じ扱い)
   */
  private framePresentationMs(frame: QueuedFrame<T>): number | null {
    if (frame.generation !== this.timeline.generation) {
      return null;
    }
    return this.presentationTimeMs(frame.timestampMicros);
  }
}
