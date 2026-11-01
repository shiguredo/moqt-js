/**
 * 復号した映像フレームの表示の組み立て (時間軸への記録・表示の選択・計器への記録)
 *
 * 復号へ渡した Object の情報 (TIMESTAMP の種類と位置) の対応表は `VideoDecodeInputs` として
 * 提供し、入口 (`MediaPlayout`) が保持する。復号の出力を受け取ると、共有の時間軸
 * (`src/playout/timeline.ts`) への記録から `PlayoutBuffer` への積み込み、表示周期ごとの
 * 選択、表示の実績の記録、捨てたフレームの計器への記録までを行う。表示時刻は時間軸が
 * 決める (音声と同じ式。`src/playout/buffer.ts`)。
 *
 * 同じ組み立てを `src/createMediaSubscriber.ts` (ライブラリ) と
 * `devtools/src/hooks/useSubscriber.ts` (devtools) が別々に持つと、表示の遅れ・
 * あふれの扱い・計器の修正を 2 か所へ入れる必要があり、片方だけを直すと挙動がずれる。
 * 組み立てはここ 1 か所に置き、両方がこれを使う。
 *
 * ブラウザ依存は注入する。表示すると決めたフレームの出し先は `VideoPlayoutOutput`
 * (ライブラリは `MediaStreamTrackGenerator`、devtools は canvas)、表示周期の予約は
 * `requestAnimationFrame` とする。ブラウザ API の無い環境では記録用の最小オブジェクトを
 * 注入すれば検証できる。呼び出し側が devtools 固有の判断 (relay の cache から追いつく
 * 途中のフレームを表示しない、購読ごとの統計と画面への反映) を持つ。
 *
 * 内部実装である (src/index.ts からは公開していない)。公開 API は再生の入口
 * (`MediaPlayout`) である。docs/ARCHITECTURE.md の「映像の表示の組み立て」を
 * 参照。
 */

import type { Location } from "../message";
import { type DecodeInputsOptions, type PlayoutTimestampKind } from "./decodeInputTimestamps";
import type { PlayoutTimeline } from "./timeline";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES, MAX_PRESENTATION_LAG_MS, PlayoutBuffer } from "./buffer";

/**
 * 復号へ渡した映像 Object の情報
 *
 * 復号の出力 (`VideoFrame`) では Object の位置が分からないため、decoder へ渡すときの
 * TIMESTAMP で引けるように覚える。TIMESTAMP の種類は表示時刻を決められるかの判定に、
 * 位置は relay の cache から追いつく途中かどうか (devtools の `CatchUpGate`) の判定に使う。
 */
export interface VideoDecodeInput {
  /** TIMESTAMP の種類 */
  readonly timestampKind: PlayoutTimestampKind;
  /** Object の位置 (Group ID と Object ID) */
  readonly location: Location;
}

/**
 * 復号へ渡した Object の情報を、復号の出力で引けるように覚えておく対応表
 *
 * TIMESTAMP を持たない Object は、同じ TIMESTAMP (0) を共有しうる。位置を追いつきの判定に
 * 使うときは、種類が `none` の入力は覚えない。同じ TIMESTAMP の入力は FIFO で保持し、
 * 復号器が返す複数のフレームをそれぞれ対応させる。
 *
 * 1 つの再生のまとまりに対して 1 つ作る。購読を始めるとき (`MediaPlayout.resetPlayout`) と
 * 停止するとき (`MediaPlayout.clearAll`) に `clear()` して再利用する。
 */
export class VideoDecodeInputs {
  private inputs: { timestamp: number; input: VideoDecodeInput }[] = [];
  private readonly maxTracked: number;

  constructor(options: Pick<DecodeInputsOptions, "maxTracked">) {
    this.maxTracked = options.maxTracked;
  }

  /** 保持している入力の件数。同じ timestamp の入力も別々に数える。 */
  get size(): number {
    return this.inputs.length;
  }

  /** 同じ timestamp の複数出力に備え、上書きせず投入順で保持する。 */
  remember(timestamp: number, input: VideoDecodeInput): void {
    if (input.timestampKind === "none") {
      this.inputs = this.inputs.filter((entry) => entry.timestamp !== timestamp);
      return;
    }
    this.inputs.push({ timestamp, input });
    while (this.inputs.length > this.maxTracked) this.inputs.shift();
  }

  /** 同じ timestamp の先頭の入力だけを取り出す。 */
  take(timestamp: number): VideoDecodeInput | undefined {
    const index = this.inputs.findIndex((entry) => entry.timestamp === timestamp);
    return index === -1 ? undefined : this.inputs.splice(index, 1)[0]?.input;
  }

  /** 購読を終えるときは全件を解放する。 */
  clear(): void {
    this.inputs = [];
  }
}

/**
 * 捨てたフレームの記録先 (計器)
 *
 * ライブラリは映像の計器を持たないため省略できる。devtools は「受信から表示までの時間」の
 * 統計 (`devtools/src/utils/playoutTimingStats.ts`) へ記録する。
 */
export interface VideoPlayoutTiming {
  /**
   * 表示待ちの上限を超えて捨てたフレーム
   *
   * この関数は throw しないこと。throw してもフレームは閉じ、表示周期は続ける
   * (計器の失敗で表示が止まらないようにする)。
   */
  recordQueueDrop(timestamp: number): void;
  /**
   * 提示しなかったフレーム
   *
   * 表示時刻を過ぎたフレームと、同じ表示周期に重なって提示できなかったフレームを含む。
   *
   * この関数は throw しないこと。throw してもフレームは閉じ、表示周期は続ける。
   *
   * @param presentationMs - このフレームの表示時刻。決められないときは捨てた時刻
   */
  recordLateDrop(timestamp: number, presentationMs: number): void;
}

/**
 * 表示すると決めたフレームの出し先
 *
 * ライブラリは `MediaStreamTrackGenerator` の writer、devtools は canvas へ出す。フレームの
 * 所有権は出し先へ移る (この中では閉じない)。
 */
export interface VideoPlayoutOutput {
  /**
   * 表示先の提示遅延 (表示周期の tick 数)
   *
   * `present()` を呼んでからフレームが実際に表示されるまでの遅延を、表示周期の tick 数で
   * 表す。canvas への描画は rAF のコールバック内で行われ、その vsync のフレームに含まれる
   * ため 0 とする。`MediaStreamTrackGenerator` は書き込みの次の vsync で表示されるため 1 と
   * する (Chromium 156 の実測。ブラウザの仕様として保証された値ではない)。
   */
  readonly presentationLatencyTicks: number;
  /**
   * フレームを表示する
   *
   * 所有権は true / false にかかわらず出し先へ移る。閉じる責任も出し先が負う
   * (false を返して閉じない実装はフレームを漏らす)。false は「同期の実績に記録しない」
   * という意味だけを持つ。
   *
   * この関数は throw しないこと。throw した場合はフレームを閉じ、表示の実績に記録しない
   * (表示周期の中で呼ばれるため、呼び出し側へ status を返す経路は無い)。
   *
   * @param presentationMs - 時間軸が決めた表示時刻 (`performance.now()` のミリ秒)。表示時刻を
   *   決めずに届いた順に表示するフレームは null
   * @returns 実際に表示したか。false のときは同期の実績として記録しない
   */
  present(frame: VideoFrame, presentationMs: number | null): boolean;
  /**
   * 今フレームを出せるか
   *
   * 購読が終わった、書く先が無いときは false。false のときのフレームは表示せずに閉じ、
   * 表示待ちのフレームも捨てる (出せないままメモリを占め続けないため)。
   *
   * この関数は throw しないこと。throw した場合はフレームを閉じて `status: "skipped"`
   * として扱う。
   */
  isAvailable(): boolean;
}

/** 復号したフレーム 1 枚の表示の依頼 */
export interface VideoPlayoutRequest {
  /**
   * 復号したフレーム
   *
   * 所有権は呼び出し側に残る (この中では閉じない)。実際に表示するときは出し先へ移る
   */
  readonly frame: VideoFrame;
  /**
   * フレームの TIMESTAMP の種類
   *
   * `wallClock` かつ時間軸を使うときだけ、共有の時間軸へ記録して表示時刻を決める
   */
  readonly timestampKind: PlayoutTimestampKind;
  /**
   * 時間軸を使って表示時刻を決めるか (jitter buffer が有効なとき)
   *
   * false のときは共有の時間軸へ記録せず、届いた順に表示する
   */
  readonly useTimeline: boolean;
}

/**
 * 復号したフレーム 1 枚の表示の結果
 *
 * 表示時刻を決めたフレームは、呼び出し側が同期の推定 (`AvSyncStats`) を出せるかの判定に
 * 使えるよう、使った壁時計の TIMESTAMP を返す。
 */
export type VideoPlayoutResult =
  | {
      /** 表示待ちのキューへ積んだ */
      readonly status: "queued";
      /** 表示時刻に使った壁時計の TIMESTAMP。使わなかった (種類が違う、時間軸を使わない) ときは null */
      readonly wallClockTimestamp: number | null;
    }
  | {
      /** 出し先が無いため、表示せずに閉じた */
      readonly status: "skipped";
    };

/** `VideoPlayoutSession` の設定 */
export interface VideoPlayoutSessionOptions {
  /** 音声と映像で共有する表示時刻の時間軸 */
  readonly timeline: PlayoutTimeline;
  /** 表示すると決めたフレームの出し先 */
  readonly output: VideoPlayoutOutput;
  /** 捨てたフレームの記録先 (計器)。映像の計器を持たないときは省略する */
  readonly timing?: VideoPlayoutTiming;
  /** 表示待ちのキューの上限 (枚)。既定は `JITTER_BUFFER_MAX_QUEUED_FRAMES` */
  readonly maxQueuedFrames?: number;
  /**
   * 表示の周期の予約。既定は `requestAnimationFrame`
   *
   * コールバックは rAF のタイムスタンプ (vsync の時刻、`performance.now()` の軸) を受け取る。
   */
  readonly requestFrame?: (callback: (timestampMs: number) => void) => number;
  /** 表示の周期の予約の取り消し。既定は `cancelAnimationFrame` */
  readonly cancelFrame?: (handle: number) => void;
}

/**
 * 表示周期 R の初期値と、rAF の間隔を測り直す条件
 *
 * rAF の間隔のサンプルが 2 つ未満の間は 60 Hz を仮定する。4 tick 分 (約 66.7 ms) を
 * 超える間隔は、非表示タブの復帰やメインスレッドの停止で表示周期が乱れた可能性があるため、
 * サンプルを捨てて取り直す。
 */
const DEFAULT_REFRESH_MS = 1_000 / 60;
const REFRESH_SAMPLE_COUNT = 16;
// 表示待ちが空でも、最後の表示からこの時間までは表示周期の予約を続ける。30 fps のように
// 表示周期より長い間隔でフレームが届くとき、予約を毎回止めると rAF の間隔が届いた間隔に
// 引き伸ばされ、表示周期の推定が壊れるためである
const IDLE_STOP_MS = 250;

/**
 * 復号した映像フレームの表示
 *
 * 1 つの表示のまとまりに対して 1 つ作る。時間軸とキューを作り直すときは、新しい
 * インスタンスを作る (古いインスタンスは `clear()` してから捨てる)。
 */
export class VideoPlayoutSession {
  /** 表示待ちのフレーム (検証と統計が読む) */
  readonly playout: PlayoutBuffer<VideoFrame>;
  private readonly timeline: PlayoutTimeline;
  private readonly output: VideoPlayoutOutput;
  private readonly timing: VideoPlayoutTiming | null;
  // 表示の周期の予約 (ブラウザ依存は注入する)
  private readonly requestFrame: (callback: (timestampMs: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  // 予約済みの表示周期。予約済みの間は積み増さない
  private frameRequest: number | null = null;
  // 表示周期の実測値と、rAF の間隔の窓
  private refreshMs = DEFAULT_REFRESH_MS;
  private readonly tickIntervalsMs: number[] = [];
  private lastTickMs: number | null = null;
  // 最後にフレームを積んだ、または表示した時刻 (`performance.now()` の軸)
  private lastActivityMs: number | null = null;

  constructor(options: VideoPlayoutSessionOptions) {
    const presentationLatencyTicks = options.output.presentationLatencyTicks;
    if (!Number.isInteger(presentationLatencyTicks) || presentationLatencyTicks < 0) {
      throw new RangeError(
        `presentationLatencyTicks must be a non-negative integer, got ${presentationLatencyTicks}`,
      );
    }
    this.timeline = options.timeline;
    this.output = options.output;
    this.timing = options.timing ?? null;
    this.playout = new PlayoutBuffer<VideoFrame>(
      options.maxQueuedFrames ?? JITTER_BUFFER_MAX_QUEUED_FRAMES,
      options.timeline,
    );
    // 表示周期の予約はブラウザ依存である。テストは記録用の関数を注入する
    this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  }

  /**
   * 復号したフレームを表示待ちへ積み、表示周期へ予約する
   *
   * 壁時計の TIMESTAMP を持ち、時間軸を使っているときだけ、共有の時間軸へ記録して表示時刻を
   * 決められるようにする。出し先が無い (購読が終わった、映像を表示しない) ときは表示せずに
   * 閉じる。
   *
   * @param request - 復号したフレームと、そのフレームの TIMESTAMP の種類
   * @returns 積んだか、表示せずに閉じたか
   */
  handleDecodedFrame(request: VideoPlayoutRequest): VideoPlayoutResult {
    const frame = request.frame;
    if (!this.isOutputAvailable()) {
      // 出し先が無い。表示待ちに積まずに閉じる (キューに入れても誰も出さない)
      frame.close();
      return { status: "skipped" };
    }

    // 表示時刻に使うのは、壁時計の TIMESTAMP を持ち、時間軸を使っているときだけである。
    // メディア時刻 (TIMESCALE あり) と TIMESTAMP 無しのフレームは映像の表示時刻と対応しない
    const wallClockTimestamp =
      request.useTimeline && request.timestampKind === "wallClock" ? frame.timestamp : null;
    if (wallClockTimestamp !== null) {
      // 復号の出力を共有の時間軸へ記録し、音声と同じ式で表示時刻を求める
      // (src/playout/timeline.ts)
      this.timeline.observe(
        "video",
        performance.timeOrigin + performance.now(),
        wallClockTimestamp,
      );
    }

    const overflow = this.playout.enqueue(frame, wallClockTimestamp);
    for (const dropped of overflow) {
      // あふれて捨てたフレームは表示されないため計器へ残す (timestamp は閉じる前に読む)。
      // 計器は throw しない契約である。それでも表示が止まらないよう、失敗しても閉じる
      try {
        this.timing?.recordQueueDrop(dropped.timestamp);
      } catch {
        // 記録の失敗でフレームを閉じ損ねない
      }
      dropped.close();
    }

    this.lastActivityMs = performance.now();
    this.scheduleDrain();
    return { status: "queued", wallClockTimestamp };
  }

  /**
   * 予約を取り消し、表示待ちのフレームを捨てる
   *
   * 購読の停止と、時間軸・キューを作り直す直前に呼ぶ。捨てたフレームは計器へ記録しない
   * (購読の停止で表示されなかった分は、停止の統計が別に数える)。復号へ渡した入力の
   * 対応表は呼び出し側 (`MediaPlayout`) が持つため、ここでは消さない。
   */
  clear(): void {
    if (this.frameRequest !== null) {
      this.cancelFrame(this.frameRequest);
      this.frameRequest = null;
    }
    for (const frame of this.playout.clear()) {
      frame.close();
    }
    this.lastTickMs = null;
    this.lastActivityMs = null;
    this.tickIntervalsMs.length = 0;
    this.refreshMs = DEFAULT_REFRESH_MS;
  }

  /**
   * 表示周期ごとに、目標表示時刻に最も近いフレームを 1 枚提示する
   *
   * 目標表示時刻は、書き込み tick の時刻に表示先の提示遅延を足した時刻である。generator は
   * 書き込みの次の vsync で表示されるため、この時刻を目標にすると表示時刻に最も近い vsync
   * で提示できる。
   */
  private onTick(timestampMs: number): void {
    this.observeTick(timestampMs);
    const targetMs = timestampMs + this.output.presentationLatencyTicks * this.refreshMs;
    // generator は書き込みの次の vsync で表示されるため、遅れて提示してよい上限を
    // 提示遅延の分だけ広げる。これが無いと、時間軸の表示の遅れが小さいときに、到着の
    // 位相によっては書き込みの tick に間に合わずフレームを捨ててしまう
    const maxLateMs =
      MAX_PRESENTATION_LAG_MS + this.output.presentationLatencyTicks * this.refreshMs;
    const selection = this.playout.selectNearest(targetMs, this.refreshMs / 2, maxLateMs);
    for (const dropped of selection.dropped) {
      // 提示しなかったフレームの表示時刻は、止まりの原因 (間に合わなかった段) を決めるのに
      // 使う。表示時刻は選択と同じ基準で求まる
      try {
        this.timing?.recordLateDrop(
          dropped.timestamp,
          this.playout.presentationTimeMs(dropped.timestamp) ?? targetMs,
        );
      } catch {
        // 記録の失敗でフレームを閉じ損ねない
      }
      dropped.close();
    }
    const draw = selection.draw;
    if (draw === null) {
      return;
    }
    this.lastActivityMs = timestampMs;
    // 表示すると出し先へ所有権が移る (devtools は閉じる) ため、記録に使う値は先に読む
    const timestamp = draw.timestamp;
    // 出し先は throw しない契約である。それでも表示が止まらないよう、throw したときは
    // フレームを閉じて表示の実績に記録せずに次のフレームへ進む
    let presented: boolean;
    try {
      presented = this.output.present(draw, selection.drawPresentationMs);
    } catch {
      draw.close();
      presented = false;
    }
    if (presented && selection.drawPresentationMs !== null) {
      // 実際に表示される vsync の時刻を実績として記録する (同期ずれの推定に使う)。表示時刻を
      // 決めずに表示したフレームは音声と対応づけられないため記録しない。
      // 第 3 引数は Unix epoch マイクロ秒
      this.timeline.recordPresentation(
        "video",
        timestamp,
        BigInt(Math.round((performance.timeOrigin + targetMs) * 1_000)),
      );
    }
  }

  /**
   * rAF のタイムスタンプから表示周期 R を実測する
   *
   * 直近 `REFRESH_SAMPLE_COUNT` 個の間隔の中央値を使う。サンプルが 2 つ未満の間は 60 Hz を
   * 仮定する。4 tick 分 (約 66.7 ms) を超える間隔は、非表示タブの復帰やメインスレッドの
   * 停止で表示周期が乱れた可能性があるため、サンプルを捨てて取り直す。
   */
  private observeTick(timestampMs: number): void {
    const previousMs = this.lastTickMs;
    this.lastTickMs = timestampMs;
    if (previousMs === null) {
      return;
    }
    const intervalMs = timestampMs - previousMs;
    if (!(intervalMs > 0)) {
      return;
    }
    if (intervalMs > 4 * DEFAULT_REFRESH_MS) {
      // メインスレッドの停止などで 1 tick 分より大きく外れた間隔は、表示周期の推定に
      // 使わない。1 つ混ざるだけで中央値が大きくずれるためである
      this.tickIntervalsMs.length = 0;
      this.refreshMs = DEFAULT_REFRESH_MS;
      return;
    }
    this.tickIntervalsMs.push(intervalMs);
    if (this.tickIntervalsMs.length > REFRESH_SAMPLE_COUNT) {
      this.tickIntervalsMs.shift();
    }
    if (this.tickIntervalsMs.length < 2) {
      return;
    }
    const sorted = [...this.tickIntervalsMs].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      const left = sorted[middle - 1] ?? DEFAULT_REFRESH_MS;
      const right = sorted[middle] ?? DEFAULT_REFRESH_MS;
      this.refreshMs = (left + right) / 2;
    } else {
      this.refreshMs = sorted[middle] ?? DEFAULT_REFRESH_MS;
    }
  }

  /**
   * 表示周期の予約を続ける
   *
   * 表示待ちがある間は毎周期続ける。表示待ちが空でも、最後の表示から `IDLE_STOP_MS` までは
   * 続ける (30 fps のようにフレームの到着が表示周期より遅いとき、予約を止めると rAF の
   * 間隔が到着の間隔に引き伸ばされ、表示周期の推定が壊れるため)。予約は 1 つだけ持ち、
   * 予約済みの間は積み増さない。出し先が無くなったときは表示待ちを捨てる。
   */
  private scheduleDrain(): void {
    if (this.frameRequest !== null) {
      return;
    }
    if (this.playout.size === 0) {
      // 表示待ちが無くても、最後の表示からしばらくは予約を続ける。止めると、届いた
      // フレームの間隔が rAF の間隔として観測され、表示周期の推定が壊れる
      const lastActivityMs = this.lastActivityMs;
      if (lastActivityMs === null || performance.now() - lastActivityMs >= IDLE_STOP_MS) {
        return;
      }
    }
    this.frameRequest = this.requestFrame((timestampMs) => {
      this.frameRequest = null;
      if (!this.isOutputAvailable()) {
        this.clear();
        return;
      }
      this.onTick(timestampMs);
      this.scheduleDrain();
    });
  }

  /**
   * 今フレームを出せるかを返す
   *
   * 出し先は throw しない契約である。それでも表示が止まらないよう、throw したときは
   * 出せない (false) として扱う (フレームを閉じ、表示待ちを捨てる側へ倒す)。
   */
  private isOutputAvailable(): boolean {
    try {
      return this.output.isAvailable();
    } catch {
      return false;
    }
  }
}
