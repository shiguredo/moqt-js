/**
 * 復号済みの音声と映像を、共有の時間軸に沿って鳴らし・表示する共通の入口
 *
 * MOQT の受信側の再生 (playout) は、時間軸 (`src/playout/timeline.ts`)、音声の再生の
 * 組み立て (`src/playout/audioPlayoutSession.ts`)、映像の表示の組み立て
 * (`src/playout/videoPlayoutSession.ts`)、計器 (`src/playout/audioPlayoutTimingStats.ts`) に
 * 分かれている。これは修正を 1 か所へ閉じるための分割であり、使う側から見ると、時間軸・
 * 計器・セッション・復号の入力の対応表をすべて自分で組み立てる必要があった。
 *
 * このファイルはそれらの組み立てを 1 か所にまとめ、使う側には「復号へ渡した入力を記録する」
 * 「復号の出力を渡す」「統計を読む」だけを見せる。音声と映像の時間軸が同じであること、
 * 目標の開始時刻を守るかどうか、音声だけを購読しているときの到着基準の下限といった判断は、
 * すべてこの中で行う。
 *
 * 典型的な使い方は次のとおりである。
 *
 * ```ts
 * // 1. 再生の入口を作る。AudioContext と映像の出し先を渡すだけ
 * const playout = createMediaPlayout({
 *   audio: { context: audioContext, destination: audioContext.destination },
 *   video: {
 *     output: {
 *       isAvailable: () => true,
 *       present: (frame) => {
 *         // 受け取ったフレームはここで表示し、閉じる (所有権が移る)
 *         frame.close();
 *         return true;
 *       },
 *     },
 *   },
 * });
 *
 * // 2. 復号へ渡す直前に、その入力の情報を記録する (TIMESTAMP の種類など)
 * playout.trackAudioDecodeInput(timestampMicros, { timestampKind: "wallClock" });
 * playout.trackVideoDecodeInput(timestampMicros, {
 *   timestampKind: "wallClock",
 *   location: { group: groupId, object: objectId },
 * });
 *
 * // 3. 復号の出力を渡す。鳴らす / 表示する判断と記録はこの中で行う
 * const audioResult = playout.pushAudio(audioData); // AudioData は閉じない
 * const videoResult = playout.pushVideo(videoFrame); // 表示したら所有権が出し先へ移る
 *
 * // 4. 統計を読む
 * const stats = playout.getStats();
 * ```
 *
 * ブラウザ依存 (Web Audio、`requestAnimationFrame`、表示の出し先) は注入する。ライブラリ
 * (`src/createMediaSubscriber.ts`) と moqt-devtools を含む呼び出し側が同じ実装を使うため、
 * 再生の修正はこの 1 か所 (と配下の各モジュール) へ入れる。呼び出し側が持つのは、復号
 * (WebCodecs)・受信・購読の管理・画面への反映である。
 *
 * 公開 API である (src/index.ts)。docs/HIGH_LEVEL_API.md の「再生の入口 (MediaPlayout)」を
 * 参照。
 */

import type { AvSyncStats } from "../codec/types";
import type { Location } from "../message";
import type { AudioDelayFeedbackSnapshot } from "./audioDelayFeedback";
import {
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AudioPlayoutTimingStats,
  type AudioPlayoutDrainStats,
  type AudioPlayoutTimingSnapshot,
} from "./audioPlayoutTimingStats";
import {
  AudioPlayoutSession,
  type AudioPlayoutContext,
  type AudioPlayoutDrainOptions,
  type AudioPlayoutOutput,
  type AudioPlayoutTimestampKind,
} from "./audioPlayoutSession";
import type { AudioReceiveCatchUpStats } from "./audioReceiveCatchUp";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./buffer";
import {
  AudioDecodeInputs,
  type AudioDecodeInput,
  type AudioDecodeInputRecord,
} from "./decodeInputTimestamps";
import { AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS, PlayoutTimeline } from "./timeline";
import {
  VideoDecodeInputs,
  VideoPlayoutSession,
  type VideoDecodeInput,
  type VideoPlayoutOutput,
  type VideoPlayoutPacing,
  type VideoPlayoutSessionOptions,
  type VideoPlayoutTiming,
  type VideoPlayoutTimestampKind,
} from "./videoPlayoutSession";

/** 復号へ渡した音声 Object の情報 (呼び出し側が記録する) */
export type MediaPlayoutAudioDecodeInput = AudioDecodeInputRecord;

/**
 * 復号へ渡した映像 Object の情報 (呼び出し側が記録する)
 *
 * `src/playout/videoPlayoutSession.ts` の `VideoDecodeInput` をそのまま使える。
 */
export type MediaPlayoutVideoDecodeInput = VideoDecodeInput;

/**
 * 音声の選別に渡す入力の情報
 *
 * 記録から引けなかった音では null が渡る。
 */
export type MediaPlayoutAdmitAudioInput = AudioDecodeInput;

/** 映像の選別に渡す入力の情報 */
export interface MediaPlayoutAdmitVideoInput {
  /** TIMESTAMP の種類 */
  readonly timestampKind: VideoPlayoutTimestampKind;
  /** Object の位置 */
  readonly location: Location;
}

/**
 * 音声の再生に必要なもの
 *
 * `AudioContext` と、予約した音を繋ぐ出力 (`MediaStreamAudioDestinationNode` や
 * `AudioContext.destination`) を渡す。`context` は `AudioContext` の実物をそのまま渡せる
 * (`src/playout/audioPlayoutSession.ts` の `AudioPlayoutContext` を参照)。
 *
 * 音声を使うが、まだ鳴らす先が無い (再生の開始を待っている) ときは `context` と
 * `destination` を省略する。このときも復号の入力の記録と選別は行い、`pushAudio` は
 * `status: "skipped"` を返す。鳴らし始めるときに `setAudioOutput` で出力を付ける。
 */
export interface MediaPlayoutAudioOptions {
  /** `AudioContext` (`AudioContext` は `AudioPlayoutContext` を構造的に満たす) */
  readonly context?: AudioPlayoutContext;
  /** 予約した音を繋ぐ出力 */
  readonly destination?: AudioNode;
  /**
   * 計器。省略すると内部で作る
   *
   * 「鳴らなかった量」を自分の実行周期で画面へ出したいときは、作ったものを渡して直接読む
   * (ライブラリと moqt-devtools は渡す)。
   */
  readonly timing?: AudioPlayoutTimingStats;
  /**
   * 鳴らすかどうかの選別 (省略するとすべて鳴らす)
   *
   * 引数は記録した入力の情報で、記録から引けなかったときは null である。false を返すと
   * その音は鳴らさず、`pushAudio` は `status: "notAdmitted"` を返す (時間軸へも計器へも
   * 記録しない。数えるかどうかは呼び出し側が決める)。
   * moqt-devtools が、relay の cache から追いつく途中の音を鳴らさないために使う。
   */
  readonly admit?: (input: MediaPlayoutAdmitAudioInput | null) => boolean;
  /**
   * 揃える相手 (映像) がいるかを返す。省略すると「映像の出力が構成されているか」で決める
   *
   * 揃える相手がいない (音声だけを購読している) ときは、目標の開始時刻を守らずに到着基準で
   * 並べ、揺らぎの推定が届いていない周期的な停滞を先に吸収する下限を足す。映像の出力を
   * 構成していても、catalog に映像のトラックが無い購読では揃える相手がいないため、
   * 呼び出し側が実際のトラックの有無を返す (ライブラリは
   * `() => this.videoTrackInfo !== null` を渡す)。
   */
  readonly counterpart?: () => boolean;
}

/**
 * 映像の表示に必要なもの
 *
 * 表示すると決めたフレームの出し先だけを渡す。ライブラリは `MediaStreamTrackGenerator`
 * の writer へ、moqt-devtools は canvas へ出す (`src/playout/videoPlayoutSession.ts` の
 * `VideoPlayoutOutput` を参照)。
 */
export interface MediaPlayoutVideoOptions {
  /** 表示すると決めたフレームの出し先 */
  readonly output: VideoPlayoutOutput;
  /**
   * 表示の周期の進め方。省略すると、表示時刻を過ぎたフレームをすべて出す
   *
   * `MediaStreamTrackGenerator` へ書くだけのライブラリは省略でき、canvas へ直接描く
   * moqt-devtools は `{ drainImmediately: false, framesPerDrain: 1 }` を渡す。
   */
  readonly pacing?: VideoPlayoutPacing;
  /** 捨てたフレームの記録先 (計器)。省略すると記録しない */
  readonly timing?: VideoPlayoutTiming;
  /**
   * 表示するかどうかの選別 (省略するとすべて表示する)
   *
   * 引数は記録した入力の情報で、記録から引けなかったときは null である。false を返すと
   * そのフレームは表示せずに閉じ、`pushVideo` は `status: "notAdmitted"` を返す。
   * moqt-devtools が、relay の cache から追いつく途中のフレームを描かないために使う。
   */
  readonly admit?: (input: MediaPlayoutAdmitVideoInput | null) => boolean;
}

/**
 * 復号へ渡した入力の対応表の設定
 *
 * 音声と映像の両方に同じ設定を使う。
 */
export interface MediaPlayoutDecodeInputOptions {
  /**
   * 覚えておく上限 (件)。既定は 256
   *
   * 出力されなかった (decoder のエラーで捨てられたなど) 分が残り続けないよう、超えたら
   * 古い方から忘れる。
   */
  readonly maxTracked?: number;
  /**
   * 同じ TIMESTAMP の入力が重なったときに、その TIMESTAMP の分を忘れるか。既定は false
   *
   * true のとき、位置 (Object の位置) を選別に使う呼び出し側向けである。同じ TIMESTAMP の
   * Object が重なったらどちらの位置か決められないため忘れる。false のときは後から来た
   * 種類で上書きする (種類しか使わないとき)。moqt-devtools は true を渡す。
   */
  readonly forgetOnDuplicate?: boolean;
}

/** `MediaPlayout` の設定 */
export interface MediaPlayoutOptions {
  /** 音声の再生。省略すると音声を鳴らさない */
  readonly audio?: MediaPlayoutAudioOptions | null;
  /** 映像の表示。省略すると映像を表示しない */
  readonly video?: MediaPlayoutVideoOptions | null;
  /**
   * 共有の時間軸 (jitter buffer) を使うか。既定は true
   *
   * false のときは時間軸へ記録せず、届いた順に鳴らし・表示する。
   */
  readonly jitterBuffer?: boolean;
  /**
   * 時刻原点の壁時計 (ミリ秒)。既定は `performance.timeOrigin`
   *
   * 統計の時刻を同じ軸で読むために、呼び出し側が持つ値を渡せる。
   */
  readonly timeOriginMs?: number;
  /**
   * catalog から解決した表示の遅れの目標 (ミリ秒)。既定は null
   *
   * draft-ietf-moq-msf-01 §5.2.8 の `targetLatency`。音声と映像の両方に同じ値を使う。
   * 購読の途中で catalog が更新されたときは `setTargetLatencyMs` で変える。
   */
  readonly targetLatencyMs?: number | null;
  /**
   * 映像の表示待ちのキューの上限 (枚)
   *
   * 省略すると `JITTER_BUFFER_MAX_QUEUED_FRAMES`。時間軸が許す表示の遅れの上限もこの値から
   * 決まる。
   */
  readonly maxQueuedFrames?: number;
  /**
   * 復号の出力で入力が引けなかったときに使う、意図した復号前の遅延 (ミリ秒)。既定は 0
   *
   * 復号前の遅延の段 (`MediaSubscriberOptions.preDecodeDelayMs`) を使う呼び出し側は、
   * その設定値を渡す。記録から引けた音は、記録した実際の保持時間を使う。
   */
  readonly intentionalDelayMs?: number;
  /** 復号へ渡した入力の対応表の設定 */
  readonly decodeInputs?: MediaPlayoutDecodeInputOptions;
  /** 映像の表示周期の予約。既定は `requestAnimationFrame` */
  readonly requestFrame?: (callback: () => void) => number;
  /** 映像の表示周期の予約の取り消し。既定は `cancelAnimationFrame` */
  readonly cancelFrame?: (handle: number) => void;
}

/** 音声の再生の結果 */
export type MediaPlayoutAudioResult =
  | {
      /** 鳴らすと決めて予約した */
      readonly status: "played";
      /** この音の予約で基準を取り直したか */
      readonly rebased: boolean;
      /** 受信側の追いつきを始めたか (呼び出し側が復号器を作り直す) */
      readonly catchUpStarted: boolean;
      /** 使った TIMESTAMP の種類 (記録から引けなければ直前に分かっている種類) */
      readonly timestampKind: AudioPlayoutTimestampKind;
    }
  | {
      /** 並べすぎで鳴らさずに捨てた */
      readonly status: "dropped";
      readonly rebased: boolean;
      readonly catchUpStarted: boolean;
      /** 捨てた理由 */
      readonly reason: "backlog";
      readonly timestampKind: AudioPlayoutTimestampKind;
    }
  | {
      /** 鳴らす準備の途中で失敗した (計器には「鳴らなかった」として記録済み) */
      readonly status: "error";
      readonly rebased: boolean;
      readonly catchUpStarted: boolean;
      /** 失敗の内容。呼び出し側が onError やログへ流す */
      readonly error: Error;
      readonly timestampKind: AudioPlayoutTimestampKind;
    }
  | {
      /**
       * `MediaPlayoutAudioOptions.admit` が false を返したため鳴らさなかった
       *
       * 時間軸へも計器へも記録していない。鳴らなかったことを数えるかどうかは呼び出し側が
       * 決める (moqt-devtools は追いつきの間の音として数える)。
       */
      readonly status: "notAdmitted";
      readonly timestampKind: AudioPlayoutTimestampKind;
    }
  | {
      /** 鳴らす先が無いため何もしなかった (音声を再生していない) */
      readonly status: "skipped";
      readonly timestampKind: AudioPlayoutTimestampKind;
    };

/** 映像の表示の結果 */
export type MediaPlayoutVideoResult =
  | {
      /** 表示待ちのキューへ積んだ */
      readonly status: "queued";
      /** 表示時刻に使った壁時計の TIMESTAMP。使わなかったときは null */
      readonly wallClockTimestamp: number | null;
    }
  | {
      /**
       * `MediaPlayoutVideoOptions.admit` が false を返したため表示しなかった
       *
       * フレームは閉じてある。数えるかどうかは呼び出し側が決める。
       */
      readonly status: "notAdmitted";
    }
  | {
      /** 出し先が無いか、映像を表示しない設定のため、表示せずに閉じた */
      readonly status: "skipped";
    };

/** 音声の再生の統計 */
export interface MediaPlayoutAudioStats {
  /** 鳴らす時刻の基準を取り直した回数 */
  readonly rebases: number;
  /** 並べすぎなどで鳴らさなかった音の数 */
  readonly drops: number;
  /** 補間した回数 */
  readonly concealments: number;
  /** 波形を詰めた合計 (ミリ秒) */
  readonly compressedMs: number;
  /** 補間した合計 (ミリ秒) */
  readonly concealedMs: number;
  /** 目標を守る並べ方で最後に並べた音の遅れ (ミリ秒) */
  readonly latenessMs: number;
  /** 再生の観測値 (鳴るはずの時刻・鳴り始める時刻・鳴らなかった量) */
  readonly timing: AudioPlayoutTimingSnapshot;
  /** 受信側の追いつきの観測値 */
  readonly catchUp: AudioReceiveCatchUpStats;
}

/** 映像の表示の統計 */
export interface MediaPlayoutVideoStats {
  /** 表示待ちのフレーム数 */
  readonly queuedFrames: number;
  /** 表示待ちのフレームの遅れ (ミリ秒)。決められなければ null */
  readonly playoutDelayMs: number | null;
}

/** 再生の統計 */
export interface MediaPlayoutStats {
  /** 音声の再生の統計 (音声を再生していないときは null) */
  readonly audio: MediaPlayoutAudioStats | null;
  /** 映像の表示の統計 (映像を表示していないときは null) */
  readonly video: MediaPlayoutVideoStats | null;
  /**
   * 音声と映像の同期の推定値
   *
   * 音声か映像の片方しか使わないとき、時間軸を使わないときは null。壁時計の TIMESTAMP を
   * 観測しているかどうかの判断は、購読しているトラックを知っている呼び出し側が行う
   * (`createMediaSubscriber` は音声と映像の両方で壁時計の TIMESTAMP を観測するまで null を
   * 返す)。
   */
  readonly avSync: AvSyncStats | null;
}

/** 復号へ渡した入力の対応表の既定の上限 (件) */
const DEFAULT_MAX_TRACKED_DECODE_INPUTS = 256;

/**
 * 復号の出力から入力を引き当てるときの、timestamp のずれの下限の許容 (マイクロ秒)
 *
 * 音 1 つの長さが分からない (0 以下) ときに使う。実測のずれは最大 0.40 ミリ秒であり、
 * 負荷時は 9.7 ミリ秒まで広がる (`src/playout/decodeInputTimestamps.ts`)。
 */
const MIN_AUDIO_TIMESTAMP_TOLERANCE_MICROS = 1_000;

/**
 * 復号済みの音声と映像の再生の入口
 *
 * 1 つの購読 (または再生) に対して 1 つ作る。音声と映像は同じ時間軸を共有するため、
 * 片方だけを渡しても、後から `setAudioOutput` で音声を足せる。
 */
export class MediaPlayout {
  /** 復号へ渡した音声 Object の対応表 (呼び出し側が直接使うことは想定しない) */
  private readonly audioInputs: AudioDecodeInputs;
  /** 復号へ渡した映像 Object の対応表 (呼び出し側が直接使うことは想定しない) */
  private readonly videoInputs: VideoDecodeInputs;
  /** 音声と映像で共有する表示時刻の時間軸 */
  private readonly timeline: PlayoutTimeline;
  /** 時間軸 (jitter buffer) を使うか */
  private readonly useTimeline: boolean;
  /** 映像の表示待ちのキューの上限 (枚)。時間軸と表示の組み立てで同じ値を使う */
  private readonly maxQueuedFrames: number;
  /** 映像の表示周期の予約 (ブラウザ依存)。テストは注入する */
  private readonly requestFrame: (callback: () => void) => number;
  /** 映像の表示周期の予約の取り消し (ブラウザ依存)。テストは注入する */
  private readonly cancelFrame: (handle: number) => void;
  /**
   * 復号の出力で入力が引けなかったときに使う、意図した復号前の遅延 (ミリ秒)
   *
   * 購読の途中で復号前の遅延の設定が変わったときは `setIntentionalDelayMs` で更新する。
   */
  private fallbackIntentionalDelayMs: number;
  // 音声の再生 (音声を使わないときは null)
  private readonly audioSession: AudioPlayoutSession | null;
  private readonly audioTiming: AudioPlayoutTimingStats | null;
  private readonly audioAdmit: ((input: AudioDecodeInput | null) => boolean) | null;
  /** 揃える相手 (映像) がいるかを返す。null なら映像の出力の有無で決める */
  private readonly audioCounterpart: (() => boolean) | null;
  // 鳴らす先 (後から付け外しできる)
  private audioOutput: AudioPlayoutOutput | null;
  // 映像の表示 (映像を使わないときは null)
  private readonly videoSession: VideoPlayoutSession | null;
  private readonly videoAdmit: ((input: MediaPlayoutAdmitVideoInput | null) => boolean) | null;

  constructor(options: MediaPlayoutOptions) {
    const audioOptions = options.audio ?? null;
    const videoOptions = options.video ?? null;
    if (audioOptions === null && videoOptions === null) {
      throw new Error("at least one of audio or video must be specified");
    }
    this.useTimeline = options.jitterBuffer ?? true;
    this.fallbackIntentionalDelayMs = options.intentionalDelayMs ?? 0;
    this.maxQueuedFrames = options.maxQueuedFrames ?? JITTER_BUFFER_MAX_QUEUED_FRAMES;
    // 表示周期の予約はブラウザ依存である。注入口を用意するのは、ブラウザ API の無い環境で
    // 検証できるようにするため
    this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    const timeOriginMs = options.timeOriginMs ?? performance.timeOrigin;
    this.timeline = new PlayoutTimeline({ timeOriginMs, maxQueuedFrames: this.maxQueuedFrames });
    // 目標の遅延は音声と映像で同じ値を使う (draft-ietf-moq-msf-01 §5.2.8 の MUST)
    this.timeline.setTargetLatencyMs(options.targetLatencyMs ?? null);

    const decodeInputOptions = options.decodeInputs ?? {};
    const maxTracked = decodeInputOptions.maxTracked ?? DEFAULT_MAX_TRACKED_DECODE_INPUTS;
    const forgetOnDuplicate = decodeInputOptions.forgetOnDuplicate ?? false;
    this.audioInputs = new AudioDecodeInputs({ maxTracked, forgetOnDuplicate });
    this.videoInputs = new VideoDecodeInputs({ maxTracked, forgetOnDuplicate });

    if (audioOptions !== null) {
      this.audioTiming =
        audioOptions.timing ??
        new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, timeOriginMs);
      this.audioSession = new AudioPlayoutSession({ timing: this.audioTiming });
      this.audioAdmit = audioOptions.admit ?? null;
      this.audioCounterpart = audioOptions.counterpart ?? null;
      const context = audioOptions.context;
      const destination = audioOptions.destination;
      if ((context === undefined) !== (destination === undefined)) {
        // 片方だけでは鳴らせない。黙って鳴らさない設定にすると、呼び出し側は鳴っている
        // つもりで気付かない
        throw new Error(
          "audio context and destination must be specified together: " +
            `context=${context === undefined ? "missing" : "present"}, ` +
            `destination=${destination === undefined ? "missing" : "present"}`,
        );
      }
      this.audioOutput =
        context !== undefined && destination !== undefined ? { context, destination } : null;
    } else {
      this.audioTiming = null;
      this.audioSession = null;
      this.audioAdmit = null;
      this.audioCounterpart = null;
      this.audioOutput = null;
    }

    if (videoOptions !== null) {
      this.videoSession = new VideoPlayoutSession(this.buildVideoSessionOptions(videoOptions));
      this.videoAdmit = videoOptions.admit ?? null;
    } else {
      this.videoSession = null;
      this.videoAdmit = null;
    }
  }

  /**
   * 映像の表示の組み立ての設定を組み立てる
   *
   * 既定はライブラリの使い方 (書いた時点では表示されず、表示の間隔はブラウザが TIMESTAMP から
   * 決める) にする。exactOptionalPropertyTypes のため、省略された値は載せない。
   */
  private buildVideoSessionOptions(options: MediaPlayoutVideoOptions): VideoPlayoutSessionOptions {
    const base: VideoPlayoutSessionOptions = {
      timeline: this.timeline,
      output: options.output,
      decodeInputs: this.videoInputs,
      pacing: options.pacing ?? {
        drainImmediately: true,
        framesPerDrain: Number.POSITIVE_INFINITY,
      },
      maxQueuedFrames: this.maxQueuedFrames,
      requestFrame: this.requestFrame,
      cancelFrame: this.cancelFrame,
    };
    if (options.timing !== undefined) {
      return { ...base, timing: options.timing };
    }
    return base;
  }

  /**
   * 復号へ渡した音声 Object の情報を記録する
   *
   * `AudioDecoder.decode()` へ渡す直前に呼ぶ。復号の出力 (`AudioData`) には TIMESTAMP の
   * 種類が無いため、この記録を `pushAudio` が引く。
   *
   * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param input - TIMESTAMP の種類と、測れた付加情報
   */
  trackAudioDecodeInput(timestampMicros: number, input: MediaPlayoutAudioDecodeInput): void {
    this.audioInputs.remember(timestampMicros, input);
  }

  /**
   * 復号へ渡した映像 Object の情報を記録する
   *
   * `VideoDecoder.decode()` へ渡す直前に呼ぶ。復号の出力 (`VideoFrame`) では Object の位置が
   * 分からないため、この記録を `pushVideo` が引く。位置は選別
   * (`MediaPlayoutVideoOptions.admit`) にだけ使う。
   *
   * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param input - TIMESTAMP の種類と Object の位置
   */
  trackVideoDecodeInput(timestampMicros: number, input: MediaPlayoutVideoDecodeInput): void {
    this.videoInputs.remember(timestampMicros, input);
  }

  /**
   * 復号した音声を鳴らす
   *
   * 時間軸への記録、目標の開始時刻の決定、予約、計器への記録はこの中で行う。`AudioData` は
   * 閉じない (所有権は呼び出し側に残る)。
   *
   * 音声だけを使うとき (映像を表示しないとき) は、揃える相手がいないため目標の開始時刻を
   * 守らず、揺らぎの推定が届いていない周期的な停滞を先に吸収する下限を足す。これは
   * ライブラリと moqt-devtools で同じ規則である。
   *
   * @param data - 復号した音
   */
  pushAudio(data: AudioData): MediaPlayoutAudioResult {
    const session = this.audioSession;
    if (session === null) {
      throw new Error("audio is not configured: pass MediaPlayoutOptions.audio");
    }
    // 復号の出力の timestamp に対応する入力を引く。対応とみなす差の上限は音 1 つの長さの
    // 半分にする (隣の音と取り違えない範囲で最大まで広げられる)
    //
    // close 済みの AudioData は寸法を読めない実装がありうる。この入口で throw させず、
    // 復号の組み立てへ渡して「鳴らせない」結果 (status: "error") として返す
    let inputTimestamp = 0;
    let frameDurationMicros = 0;
    try {
      inputTimestamp = data.timestamp;
      if (data.numberOfFrames > 0 && data.sampleRate > 0) {
        frameDurationMicros = (data.numberOfFrames / data.sampleRate) * 1_000_000;
      }
    } catch {
      // 読めない値は使わない。対応表を引かず、種類 none として渡す
    }
    const toleranceMicros =
      frameDurationMicros > 0
        ? Math.max(MIN_AUDIO_TIMESTAMP_TOLERANCE_MICROS, Math.floor(frameDurationMicros / 2))
        : MIN_AUDIO_TIMESTAMP_TOLERANCE_MICROS;
    const resolved = this.audioInputs.resolve(inputTimestamp, toleranceMicros);
    const timestampKind: AudioPlayoutTimestampKind = resolved.timestampKind ?? "none";
    const matched = resolved.input;

    // 選別は鳴らす先があるかどうかに関わらず行う。呼び出し側の選別は追いつきの状態を進める
    // 副作用を持ちうるため、再生していない間も判定を飛ばさない (moqt-devtools が使う)。
    // 記録から引けなかった音も渡す (位置が分からないため、呼び出し側が従来どおり鳴らす側に
    // 倒せるようにする)
    const admitted = this.audioAdmit === null || this.audioAdmit(matched);
    if (this.audioOutput === null) {
      // 鳴らす先が無いため何もしない。計器へも時間軸へも記録しない
      return { status: "skipped", timestampKind };
    }
    if (!admitted) {
      return { status: "notAdmitted", timestampKind };
    }

    // 揃える相手 (映像) がいるときだけ目標の開始時刻を守る。音声だけのときは到着基準で
    // 並べ、下限を足して周期的な停滞を先に吸収する
    const hasCounterpart =
      this.videoSession !== null && (this.audioCounterpart === null || this.audioCounterpart());
    const result = session.handleDecodedAudio({
      data,
      timestampKind,
      // 入力の遅れは、記録から引けた音だけ使う。種類を直前の値で補った出力では、どの音の
      // 遅れか決められない
      inputLagMs: matched?.inputLagMs ?? null,
      // 意図した復号前の遅延は、記録した実際の保持時間を優先し、無ければ設定値を使う
      intentionalDelayMs: matched?.intentionalDelayMs ?? this.fallbackIntentionalDelayMs,
      timeline: this.timeline,
      useTimeline: this.useTimeline,
      enforceTarget: this.useTimeline && hasCounterpart,
      // 映像に合わせる相手がいるときは渡さない (映像とのずれの原因になる)
      ...(hasCounterpart ? {} : { arrivalDelayFloorMs: AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS }),
      output: this.audioOutput,
    });
    return { ...result, timestampKind };
  }

  /**
   * 復号した映像フレームを表示待ちへ渡す
   *
   * 時間軸への記録、表示待ちのキューへの積み込み、表示周期ごとの選択、計器への記録は
   * この中で行う。表示するとフレームの所有権は出し先へ移る (この中では閉じない)。
   * 表示しないと決めたときは閉じる。
   *
   * @param frame - 復号したフレーム
   */
  pushVideo(frame: VideoFrame): MediaPlayoutVideoResult {
    const session = this.videoSession;
    if (session === null) {
      throw new Error("video is not configured: pass MediaPlayoutOptions.video");
    }
    const input = this.videoInputs.take(frame.timestamp);
    if (this.videoAdmit !== null) {
      // 記録から引けなかったフレームも渡す (位置が分からないため、呼び出し側が従来どおり
      // 表示する側に倒せるようにする)
      const forAdmit: MediaPlayoutAdmitVideoInput | null =
        input === undefined
          ? null
          : { timestampKind: input.timestampKind, location: input.location };
      if (!this.videoAdmit(forAdmit)) {
        frame.close();
        return { status: "notAdmitted" };
      }
    }
    return session.handleDecodedFrame({
      frame,
      timestampKind: input?.timestampKind ?? "none",
      useTimeline: this.useTimeline,
    });
  }

  /**
   * 鳴らす先を差し替える
   *
   * `AudioContext` を作り直したときや、音声の再生を止めるときに使う。null を渡すと鳴らさず、
   * 以降の `pushAudio` は `status: "skipped"` を返す (時間軸へも計器へも記録しない)。
   * `AudioContext` を作り直したときは、続けて `releaseAudioContext` を呼ぶ。
   *
   * @param output - 新しい出力。null で鳴らさない
   */
  setAudioOutput(output: AudioPlayoutOutput | null): void {
    this.audioOutput = output;
  }

  /**
   * 出力の時計の対応を捨てる
   *
   * `AudioContext` を閉じたときに呼ぶ。次に音を鳴らすときに、新しい `AudioContext` の時計で
   * 対応を作り直す。
   */
  releaseAudioContext(): void {
    this.audioSession?.releaseAudioContext();
  }

  /**
   * 表示の遅れの目標を変える
   *
   * 購読の途中で catalog の `targetLatency` が変わったときに呼ぶ。
   *
   * @param value - 目標 (ミリ秒)。null で目標を使わない
   */
  setTargetLatencyMs(value: number | null): void {
    this.timeline.setTargetLatencyMs(value);
  }

  /**
   * 復号の出力で入力が引けなかったときに使う、意図した復号前の遅延を変える
   *
   * 購読の途中で復号前の遅延の段の設定 (`MediaSubscriberOptions.preDecodeDelayMs`) が
   * 変わったときに呼ぶ。記録から引けた音は、記録した実際の保持時間を使うため影響しない。
   * 引けなかった音 (復号の出力の timestamp が入力の格子から外れた音) の追いつきの判定に
   * 使う差し引き値だけが変わる。
   *
   * @param value - 意図した復号前の遅延 (ミリ秒)。0 以上
   */
  setIntentionalDelayMs(value: number): void {
    this.fallbackIntentionalDelayMs = value;
  }

  /**
   * 音声の目標遅延の閉ループの内訳を読む
   *
   * 音声だけを使うときは同期の推定値 (`getStats().avSync`) を作らないため、目標の内訳だけを
   * ここから読む (moqt-devtools が使う)。
   */
  getAudioDelayFeedback(): AudioDelayFeedbackSnapshot {
    return this.timeline.audioDelayFeedbackStats();
  }

  /**
   * 表示時刻の基準を取り直す
   *
   * 復号前の遅延の段の設定を変えたときに呼ぶ。基準の遅れは「復号の出力の時刻 -
   * TIMESTAMP」の直近 10 秒の最小値であり、復号の出力の時刻が遅延の分だけ動いても古い
   * 基準が残る。古い基準のままだと表示時刻が実際の復号より遅延の分だけ前になり、映像が
   * 表示時刻を過ぎたフレームとして捨てられる。音声の追いつきの床 (直近の遅れの最小値) も
   * 古い遅延のまま残るため、観測も消す。
   */
  reset(): void {
    this.timeline.reset();
    this.clearVideo();
    this.audioSession?.catchUp.reset();
  }

  /**
   * 時間軸から音声の状態を消す
   *
   * 音声の再生を止めたときに呼ぶ。残すと共有の再生遅延に音声の下限
   * (`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) が残り、映像の表示が音声を一度も再生していない購読より
   * 遅れたまま固定される。世代は進めない (積んでいる映像フレームを到着順に落とさない)。
   */
  resetAudioStream(): void {
    this.timeline.resetStream("audio");
  }

  /**
   * 音声の再生の状態を取り直す
   *
   * 予約の基準・出力の時計の対応・追いつきの観測を消す。`AudioContext` を作り直したときに
   * 呼ぶ。計器の累積 (鳴った量・鳴らなかった量) は購読の統計として引き継ぐため消さない。
   */
  resetAudio(): void {
    this.audioSession?.reset();
  }

  /**
   * 購読の停止で使う状態を捨てる
   *
   * 時間軸の基準と学習、復号へ渡した入力の対応表、映像の表示待ちを消す。計器の累積
   * (再生の観測・受信側の追いつきの観測) は、停止直後の統計として読めるよう残す
   * (次に `resetAudio` を呼んだときに消える)。`AudioContext` の時計の対応は
   * `releaseAudioContext` で別に消す。
   */
  clear(): void {
    this.timeline.reset();
    this.audioInputs.clear();
    this.videoInputs.clear();
    this.videoSession?.clear();
  }

  /**
   * 予約済みで鳴り終わっていない音を「切った量」として計器へ残す
   *
   * 鳴らす先を閉じる直前に呼ぶ。閉じると予約は鳴らないまま消えるため、計器に残さないと
   * 「鳴らなかった量」に現れない。
   */
  recordAudioStopped(): void {
    this.audioSession?.recordStopped();
  }

  /**
   * 予約済みの音が鳴り終わるまで待つ
   *
   * 停止のときに呼ぶ。待ち時間の上限で鳴り終わらなかった分は「切った量」として計器に残る。
   *
   * @param options - 待ち時間と、flush した Object の復号の出力を待つ条件
   */
  drainAudio(options: AudioPlayoutDrainOptions = {}): Promise<AudioPlayoutDrainStats> {
    const session = this.audioSession;
    if (session === null) {
      // 音声を鳴らさない設定では、待つ予約が無い
      return Promise.resolve({
        pendingMsAtStart: 0,
        requestedMs: 0,
        waitedMs: 0,
        playedMs: 0,
        cutMs: 0,
        flushedObjects: 0,
        undecodedFlushedObjects: 0,
      });
    }
    return session.drainReserved(options);
  }

  /** 表示待ちの映像を捨て、予約した表示を取り消す */
  clearVideo(): void {
    this.videoSession?.clear();
  }

  /**
   * 統計を読む
   *
   * 時間軸 (直近の窓) の値は呼び出した時点で求める。
   */
  getStats(): MediaPlayoutStats {
    const audio = this.audioSession;
    const video = this.videoSession;
    return {
      audio:
        audio === null || this.audioTiming === null
          ? null
          : {
              rebases: audio.playout.rebases,
              drops: audio.playout.drops,
              concealments: audio.playout.concealments,
              compressedMs: audio.playout.compressed * 1_000,
              concealedMs: audio.playout.concealed * 1_000,
              latenessMs: audio.playout.lateness * 1_000,
              timing: this.audioTiming.snapshot(performance.now()),
              catchUp: audio.catchUp.snapshot(),
            },
      video:
        video === null
          ? null
          : {
              queuedFrames: video.playout.size,
              playoutDelayMs: video.playout.playoutDelayMs(),
            },
      avSync: this.buildAvSyncStats(),
    };
  }

  /**
   * 音声と映像の同期の推定値
   *
   * 片方しか使わないとき、時間軸を使わないときは null。壁時計の TIMESTAMP を観測している
   * かどうかは、購読しているトラックを知っている呼び出し側が判定する
   * (`createMediaSubscriber` を参照)。
   */
  private buildAvSyncStats(): AvSyncStats | null {
    const audio = this.audioSession;
    if (!this.useTimeline || audio === null || this.videoSession === null) {
      return null;
    }
    return {
      skewMs: this.timeline.skewMs(),
      presentationDelayMs: this.timeline.presentationDelayMs,
      targetLatencyMs: this.timeline.targetLatencyMs,
      targetLatencyLimitedMs: this.timeline.targetLatencyLimitedMs,
      // 音声を再生していない間は AudioContext が無く、時計の代用も起きていない
      audioClockFallback: this.audioOutput !== null && audio.clock.usingFallback,
      delays: this.timeline.delayBreakdown,
    };
  }
}

/**
 * 復号済みの音声と映像の再生の入口を作る
 *
 * @param options - 音声の出力と映像の出し先、時間軸の設定
 * @returns 再生の入口
 */
export function createMediaPlayout(options: MediaPlayoutOptions): MediaPlayout {
  return new MediaPlayout(options);
}
