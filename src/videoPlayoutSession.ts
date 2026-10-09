/**
 * 復号した映像フレームの表示の組み立て (対応表・時間軸への記録・表示の選択・計器への記録)
 *
 * 復号へ渡した Object の情報 (TIMESTAMP の種類と位置) を覚えておき、復号の出力を受け取ると、
 * 共有の時間軸 (`src/playbackTimeline.ts`) への記録から `PlayoutBuffer` への積み込み、
 * 表示周期ごとの選択、表示の実績の記録、捨てたフレームの計器への記録までを行う。表示時刻は
 * 時間軸が決める (音声と同じ式。`src/playoutBuffer.ts`)。
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
 * 公開 API である (src/index.ts)。docs/HIGH_LEVEL_API.md の「映像の表示の組み立て」を参照。
 */

import type { Location } from "./message";
import type { PlaybackTimeline } from "./playbackTimeline";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES, PlayoutBuffer } from "./playoutBuffer";

/**
 * 映像の TIMESTAMP の種類 (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)
 *
 * - `wallClock`: TIMESCALE が無い TIMESTAMP (Unix epoch マイクロ秒)。音声と同じ時間軸で
 *   表示時刻を決められる
 * - `mediaTime`: TIMESCALE がある TIMESTAMP。メディア時刻であり壁時計とは対応しない
 * - `none`: TIMESTAMP が無い (decoder へは 0 を渡す)
 */
export type VideoPlayoutTimestampKind = "none" | "wallClock" | "mediaTime";

/**
 * 復号へ渡した映像 Object の情報
 *
 * 復号の出力 (`VideoFrame`) では Object の位置が分からないため、decoder へ渡すときの
 * TIMESTAMP で引けるように覚える。TIMESTAMP の種類は表示時刻を決められるかの判定に、
 * 位置は relay の cache から追いつく途中かどうか (devtools の `CatchUpGate`) の判定に使う。
 */
export interface VideoDecodeInput {
  /** TIMESTAMP の種類 */
  readonly timestampKind: VideoPlayoutTimestampKind;
  /** Object の位置 (Group ID と Object ID) */
  readonly location: Location;
}

/** `VideoDecodeInputs` の設定 */
export interface VideoDecodeInputsOptions {
  /**
   * 覚えておく上限 (件)
   *
   * 出力されなかった (decoder のエラーで捨てられたなど) 分が残り続けないよう、超えたら
   * 古い方から忘れる
   */
  readonly maxTracked: number;
  /**
   * 同じ TIMESTAMP の Object が重なったときに、その TIMESTAMP の分を忘れるか
   *
   * true のとき、同じ TIMESTAMP の Object が重なったらどちらの位置か決められないため
   * その TIMESTAMP の分を忘れる (位置を追いつきの判定に使うとき)。false のときは後から
   * 来た情報で上書きする (TIMESTAMP の種類しか使わないとき)。
   */
  readonly forgetOnDuplicate: boolean;
}

/**
 * 復号へ渡した Object の情報を、復号の出力で引けるように覚えておく対応表
 *
 * TIMESTAMP を持たない Object は、同じ TIMESTAMP (0) を共有しうる。位置を追いつきの判定に
 * 使うときは、種類が `none` の入力と、重なった TIMESTAMP の入力を覚えない
 * (`forgetOnDuplicate`)。復号の出力では位置が分からないものとして扱う。
 *
 * 1 つの購読に対して 1 つ作る。購読を始めるたびに `clear()` で消す。
 */
export class VideoDecodeInputs {
  private readonly inputs = new Map<number, VideoDecodeInput>();
  private readonly options: VideoDecodeInputsOptions;

  constructor(options: VideoDecodeInputsOptions) {
    this.options = options;
  }

  /** 覚えている件数 */
  get size(): number {
    return this.inputs.size;
  }

  /**
   * 復号へ渡した Object の情報を覚える
   *
   * @param timestamp - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param input - TIMESTAMP の種類と Object の位置
   */
  remember(timestamp: number, input: VideoDecodeInput): void {
    if (input.timestampKind === "none") {
      // 位置を一意に引けないため覚えない。既に覚えていた分 (同じ TIMESTAMP の先の Object) も
      // 忘れ、どちらも位置が分からないものとして扱う
      this.inputs.delete(timestamp);
      return;
    }
    if (this.inputs.has(timestamp)) {
      if (this.options.forgetOnDuplicate) {
        this.inputs.delete(timestamp);
        return;
      }
      // 上書きする。位置は使わないため、後から来た種類で上書きしてよい
      this.inputs.delete(timestamp);
    }
    this.inputs.set(timestamp, input);
    for (const oldest of this.inputs.keys()) {
      if (this.inputs.size <= this.options.maxTracked) {
        break;
      }
      this.inputs.delete(oldest);
    }
  }

  /**
   * 復号の出力の TIMESTAMP で引く (引いた分は忘れる)
   *
   * 1 つの TIMESTAMP につき 1 回だけ引ける。覚えていない (TIMESTAMP を持たない、重なった)
   * フレームは undefined であり、呼び出し側は種類 `none` として扱う。
   */
  take(timestamp: number): VideoDecodeInput | undefined {
    const input = this.inputs.get(timestamp);
    this.inputs.delete(timestamp);
    return input;
  }

  /** すべて忘れる (購読を始めるとき) */
  clear(): void {
    this.inputs.clear();
  }
}

/**
 * 捨てたフレームの記録先 (計器)
 *
 * ライブラリは映像の計器を持たないため省略できる。devtools は「受信から表示までの時間」の
 * 統計 (`devtools/src/utils/playbackTimingStats.ts`) へ記録する。
 */
export interface VideoPlayoutTiming {
  /** 表示待ちの上限を超えて捨てたフレーム */
  recordQueueDrop(timestamp: number): void;
  /**
   * 表示時刻を過ぎて間に合わなかったフレーム
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
   * フレームを表示する
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
   */
  isAvailable(): boolean;
}

/**
 * 表示の周期の進め方
 *
 * 出し先によって変える。ライブラリは `MediaStreamTrackGenerator` へ書くだけであり、
 * 表示の間隔はブラウザが TIMESTAMP から決める。devtools は canvas へ直接描くため、
 * 表示周期に 1 枚ずつに絞らないと、まとまって届いたフレームを早送りで描いてしまう。
 */
export interface VideoPlayoutPacing {
  /** フレームを積んだ時点で、表示周期を待たずに表示するか */
  readonly drainImmediately: boolean;
  /** 1 つの表示周期に表示する枚数の上限 (すべて表示するときは `Number.POSITIVE_INFINITY`) */
  readonly framesPerDrain: number;
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
  readonly timestampKind: VideoPlayoutTimestampKind;
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
  readonly timeline: PlaybackTimeline;
  /** 表示すると決めたフレームの出し先 */
  readonly output: VideoPlayoutOutput;
  /** 復号へ渡したフレームの情報の対応表 (呼び出し側が持ち、購読ごとに `clear()` する) */
  readonly decodeInputs: VideoDecodeInputs;
  /** 表示の周期の進め方 */
  readonly pacing: VideoPlayoutPacing;
  /** 捨てたフレームの記録先 (計器)。映像の計器を持たないときは省略する */
  readonly timing?: VideoPlayoutTiming;
  /** 表示待ちのキューの上限 (枚)。既定は `JITTER_BUFFER_MAX_QUEUED_FRAMES` */
  readonly maxQueuedFrames?: number;
  /** 表示の周期の予約。既定は `requestAnimationFrame` */
  readonly requestFrame?: (callback: () => void) => number;
  /** 表示の周期の予約の取り消し。既定は `cancelAnimationFrame` */
  readonly cancelFrame?: (handle: number) => void;
}

/**
 * 復号した映像フレームの表示
 *
 * 1 つの購読 (または表示) に対して 1 つ作る。時間軸とキューを作り直すときは、新しい
 * インスタンスを作る (古いインスタンスは `clear()` してから捨てる)。
 */
export class VideoPlayoutSession {
  /** 復号へ渡したフレームの情報の対応表 (呼び出し側も `remember` に使う) */
  readonly inputs: VideoDecodeInputs;
  /** 表示待ちのフレーム (検証と統計が読む) */
  readonly playout: PlayoutBuffer<VideoFrame>;
  private readonly timeline: PlaybackTimeline;
  private readonly output: VideoPlayoutOutput;
  private readonly pacing: VideoPlayoutPacing;
  private readonly timing: VideoPlayoutTiming | null;
  // 表示の周期の予約 (ブラウザ依存は注入する)
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  // 予約済みの表示周期。予約済みの間は積み増さない
  private frameRequest: number | null = null;

  constructor(options: VideoPlayoutSessionOptions) {
    this.timeline = options.timeline;
    this.output = options.output;
    this.pacing = options.pacing;
    this.timing = options.timing ?? null;
    this.inputs = options.decodeInputs;
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
    if (!this.output.isAvailable()) {
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
      // (src/playbackTimeline.ts)
      this.timeline.observe(
        "video",
        performance.timeOrigin + performance.now(),
        wallClockTimestamp,
      );
    }

    const overflow = this.playout.enqueue(frame, wallClockTimestamp);
    for (const dropped of overflow) {
      // あふれて捨てたフレームは表示されないため計器へ残す (timestamp は閉じる前に読む)
      this.timing?.recordQueueDrop(dropped.timestamp);
      dropped.close();
    }

    if (this.pacing.drainImmediately) {
      // 表示時刻を既に過ぎているフレームは、次の表示周期を待たずに出す
      this.drain();
    }
    this.scheduleDrain();
    return { status: "queued", wallClockTimestamp };
  }

  /**
   * 予約を取り消し、表示待ちのフレームと対応表を捨てる
   *
   * 購読の停止と、時間軸・キューを作り直す直前に呼ぶ。捨てたフレームは計器へ記録しない
   * (購読の停止で表示されなかった分は、停止の統計が別に数える)。
   */
  clear(): void {
    if (this.frameRequest !== null) {
      this.cancelFrame(this.frameRequest);
      this.frameRequest = null;
    }
    for (const frame of this.playout.clear()) {
      frame.close();
    }
    this.inputs.clear();
  }

  /**
   * 表示時刻を過ぎたフレームを表示する
   *
   * 表示周期に 1 枚に絞るときは 1 枚で止め、続きは次の周期へ任せる。
   */
  private drain(): void {
    let presentedFrames = 0;
    for (;;) {
      const nowMs = performance.now();
      const selection = this.playout.select(nowMs);
      for (const late of selection.late) {
        // 間に合わなかったフレームの表示時刻は、止まりの原因 (間に合わなかった段) を決めるのに
        // 使う。表示時刻は選択と同じ基準で求まる
        this.timing?.recordLateDrop(
          late.timestamp,
          this.playout.presentationTimeMs(late.timestamp) ?? nowMs,
        );
        late.close();
      }
      const draw = selection.draw;
      if (draw === null) {
        return;
      }
      // 表示すると出し先へ所有権が移る (devtools は閉じる) ため、記録に使う値は先に読む
      const timestamp = draw.timestamp;
      const presented = this.output.present(draw, selection.drawPresentationMs);
      if (presented && selection.drawPresentationMs !== null) {
        // 実際に表示した時刻を実績として記録する (同期ずれの推定に使う)。表示時刻を決めずに
        // 表示したフレームは音声と対応づけられないため記録しない。第 3 引数は Unix epoch マイクロ秒
        this.timeline.recordPresentation(
          "video",
          timestamp,
          BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000)),
        );
      }
      presentedFrames++;
      if (presentedFrames >= this.pacing.framesPerDrain) {
        return;
      }
    }
  }

  /**
   * 表示待ちが残っている間、表示周期ごとに表示を続ける
   *
   * 予約は 1 つだけ持ち、予約済みの間は積み増さない。出し先が無くなったときは表示待ちを
   * 捨てる (出せないフレームが decoder のメモリを占め続けないため)。
   */
  private scheduleDrain(): void {
    if (this.playout.size === 0 || this.frameRequest !== null) {
      return;
    }
    this.frameRequest = this.requestFrame(() => {
      this.frameRequest = null;
      if (!this.output.isAvailable()) {
        this.clear();
        return;
      }
      this.drain();
      this.scheduleDrain();
    });
  }
}
