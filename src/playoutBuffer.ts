/**
 * 復号した映像フレームを、共有の時間軸が決めた表示時刻に合わせて選ぶキュー
 *
 * 到着のタイミングのままフレームを出し入れすると、経路の到着の揺らぎがそのまま表示間隔の
 * 揺らぎ (かくつき) になる。表示時刻は `src/playbackTimeline.ts` が LOC TIMESTAMP と
 * 共有の基準の遅れ・再生遅延から決める (音声と同じ式)。学習 (基準の遅れ、再生遅延、
 * フレーム間隔) は時間軸が持つ。
 *
 * - 表示時刻を過ぎたフレームのうち最新の 1 枚を描き、それより古いものを捨てる
 * - 表示時刻を過ぎたフレームが 2 枚以上あるときは、最新を次の選択に残してその 1 つ前を
 *   描く。配信 fps と表示周期が近いとき、位相の揺れで重なった周期と空の周期が続いても
 *   両方の周期で 1 枚ずつ描ける
 * - 表示時刻を過ぎたフレームのうち `MAX_PRESENTATION_LAG_MS` を超えて遅れたものは捨てる
 *   (最新の 1 枚は遅れていても残す)
 * - 表示時刻を決められないフレーム (壁時計の TIMESTAMP を持たない、または時間軸が
 *   そのトラックの TIMESTAMP を使わない) は、届いた順に 1 回の選択で 1 枚ずつ描く
 *
 * 時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 */

import type { PlaybackStream, PlaybackTimeline } from "./playbackTimeline";

/**
 * 表示時刻を過ぎたフレームを捨てずに描く、表示時刻からの遅れの上限 (ミリ秒)
 *
 * 60 Hz の表示周期 (16.7 ms) 程度にする。この範囲の遅れは目で分からず、配信 fps と
 * 表示周期が近いときに位相や取得の間隔の揺れで重なったフレームを捨てずに、後の周期で
 * 追いつける。30 fps では 2 枚が表示時刻を過ぎると古い方は 1 フレーム (33.3 ms) 遅れて
 * いるため捨て、最新を描く
 */
export const MAX_PRESENTATION_LAG_MS = 20;

/**
 * 表示待ちのキューの上限 (枚)
 *
 * 保持している VideoFrame は decoder のメモリを占める。30 fps で再生遅延の上限 (500 ms)
 * を保持できる枚数に余裕を足した値にする
 */
export const JITTER_BUFFER_MAX_QUEUED_FRAMES = 24;

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

/**
 * 復号したフレームを積み、表示時刻に合わせて選ぶ
 *
 * フレームは積んだ順に並べたまま扱い、並べ替えない (復号の出力は TIMESTAMP の順である)。
 */
export class PlayoutBuffer<T> {
  private readonly maxQueuedFrames: number;
  private readonly timeline: PlaybackTimeline;
  private readonly stream: PlaybackStream;
  private queue: QueuedFrame<T>[] = [];

  /**
   * @param maxQueuedFrames - 表示待ちのキューの上限 (枚)。超えたら古い方から捨てる
   * @param timeline - 表示時刻を決める共有の時間軸
   * @param stream - このキューのトラック (既定は video)
   */
  constructor(
    maxQueuedFrames: number,
    timeline: PlaybackTimeline,
    stream: PlaybackStream = "video",
  ) {
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
   * 表示するフレームを選ぶ (表示周期ごとに呼ぶ)
   *
   * 先頭が表示時刻を決められないフレームなら、それを描く (届いた順に 1 枚ずつ)。
   * 先頭が表示時刻前なら何も描かずに待つ。
   *
   * @param nowMs - 現在の時刻 (`performance.now()`)
   */
  select(nowMs: number): PlayoutSelection<T> {
    const head = this.queue[0];
    if (head === undefined) {
      return { draw: null, late: [], drawPresentationMs: null };
    }
    if (this.framePresentationMs(head) === null) {
      this.queue.shift();
      return { draw: head.item, late: [], drawPresentationMs: null };
    }
    let lastDue = -1;
    for (const [index, frame] of this.queue.entries()) {
      const presentationMs = this.framePresentationMs(frame);
      if (presentationMs === null || presentationMs > nowMs) {
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
      const presentationMs = frame === undefined ? null : this.framePresentationMs(frame);
      if (presentationMs === null || presentationMs >= nowMs - MAX_PRESENTATION_LAG_MS) {
        break;
      }
      drawIndex++;
    }
    const late = this.queue.splice(0, drawIndex).map((frame) => frame.item);
    const drawn = this.queue.shift();
    if (drawn === undefined) {
      return { draw: null, late, drawPresentationMs: null };
    }
    return {
      draw: drawn.item,
      late,
      drawPresentationMs: this.framePresentationMs(drawn),
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

  /**
   * 積んだときの世代が今と同じフレームの表示時刻
   *
   * 基準を取り直した後に残っているフレームは、新しい基準では表示時刻が飛びの分だけ未来に
   * なる。決められないものとして null を返し、届いた順に描く (取り直し前の `PlayoutBuffer`
   * が積んでいたフレームの timestamp を消していたのと同じ扱い)。
   */
  private framePresentationMs(frame: QueuedFrame<T>): number | null {
    if (frame.generation !== this.timeline.generation) {
      return null;
    }
    return this.presentationTimeMs(frame.timestampMicros);
  }

  /** 現在の再生遅延 (ミリ秒)。壁時計の TIMESTAMP のフレームをまだ積んでいなければ null */
  playoutDelayMs(): number | null {
    return this.timeline.playoutDelayMs;
  }

  /** 表示待ちのフレームをすべて取り出す (呼び出し側が閉じる) */
  clear(): T[] {
    const items = this.queue.map((frame) => frame.item);
    this.queue = [];
    return items;
  }
}
