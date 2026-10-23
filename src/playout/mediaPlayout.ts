/**
 * 復号済みの音声と映像を、共有の時間軸に沿って鳴らし・表示する共通の入口
 *
 * MOQT の受信側の再生 (playout) は、時間軸 (`src/playout/timeline.ts`)、音声の再生の
 * 組み立て (`src/playout/audioPlayoutSession.ts`)、映像の表示の組み立て
 * (`src/playout/videoPlayoutSession.ts`)、計器 (`src/playout/audioPlayoutTimingStats.ts`) に
 * 分かれている。これは修正を 1 か所へ閉じるための分割であり、使う側から見ると、時間軸・
 * 計器・セッション・復号の入力の対応表をすべて自分で組み立てる必要があった。
 *
 * このファイルはそれらの組み立てを 1 か所にまとめ、使う側には、普段の操作 (「復号へ渡した
 * 入力を記録する」「復号の出力を渡す」「統計を読む」) と、停止や `AudioContext` の作り直しに
 * 使うライフサイクルのメソッドだけを見せる。音声と映像の時間軸が同じであること、
 * 目標の開始時刻を守るかどうか、音声だけを購読しているときの到着基準の下限といった判断は、
 * すべてこの中で行う。
 *
 * 使い方 (作成・入力の記録・復号の出力の push・統計の読み方) と、停止や `AudioContext`
 * の作り直しの手順は docs/HIGH_LEVEL_API.md の「再生の入口 (MediaPlayout)」を参照。
 *
 * ブラウザ依存 (Web Audio、表示の出し先) は注入する (表示の周期は `requestAnimationFrame`
 * を使う)。ライブラリ
 * (`src/createMediaSubscriber.ts`) と moqt-devtools を含む呼び出し側が同じ実装を使うため、
 * 再生の修正はこの 1 か所 (と配下の各モジュール) へ入れる。呼び出し側が持つのは、復号
 * (WebCodecs)・受信・購読の管理・画面への反映である。
 *
 * 公開 API である (src/index.ts)。docs/HIGH_LEVEL_API.md の「再生の入口 (MediaPlayout)」を
 * 参照。
 */

import type { AvSyncStats } from "../codec/types";
import type { AudioDelayFeedbackSnapshot } from "./audioDelayFeedback";
import {
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AudioPlayoutTimingStats,
  type AudioPlayoutTimingSnapshot,
  type MediaPlayoutDrainOptions,
  type MediaPlayoutDrainStats,
} from "./audioPlayoutTimingStats";
import {
  AudioPlayoutSession,
  type AudioPlayoutContext,
  type AudioPlayoutOutput,
} from "./audioPlayoutSession";
import type { AudioReceiveCatchUpStats } from "./audioReceiveCatchUp";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./buffer";
import {
  AudioDecodeInputs,
  DEFAULT_MAX_TRACKED_DECODE_INPUTS,
  DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS,
  type AudioDecodeInputRecord,
  type PlayoutTimestampKind,
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
} from "./videoPlayoutSession";

/**
 * 復号へ渡した音声 Object の情報 (呼び出し側が記録する)
 *
 * TIMESTAMP の種類は、復号の出力 (`AudioData`) が持たないため記録する。位置・入力の遅れ・
 * 実際に保持した時間は、選別 (`admit`) と受信側の追いつきの判定に使う。測れない値は
 * 省略してよい (省略した値は null として扱う)。
 */
export type MediaPlayoutAudioDecodeInput = AudioDecodeInputRecord;

/**
 * 復号へ渡した映像 Object の情報 (呼び出し側が記録する)
 *
 * `VideoFrame` は TIMESTAMP の種類も Object の位置も持たないため、復号へ渡す直前に記録する。
 */
export type MediaPlayoutVideoDecodeInput = VideoDecodeInput;

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
 * `context` と `destination` は同時に指定する (片方だけでは鳴らせない)。
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
   * (`new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin)`)。
   * ライブラリと moqt-devtools は渡す。
   */
  readonly timing?: AudioPlayoutTimingStats;
  /**
   * 鳴らすかどうかの選別 (省略するとすべて鳴らす)
   *
   * 引数は記録した入力の情報で、記録から引けなかったときは null である。false を返すと
   * その音は鳴らさず、`pushAudio` は `status: "notAdmitted"` を返す (時間軸へも計器へも
   * 記録しない。数えるかどうかは呼び出し側が決める)。鳴らす先が無いときは `skipped` が
   * 優先されるが、選別はその場合も呼ばれる (追いつきの状態を進める副作用を落とさない)。
   * このコールバックは throw しないこと。throw した場合は `status: "error"` として返す。
   * moqt-devtools が、relay の cache から追いつく途中の音を鳴らさないために使う。
   */
  readonly admit?: (input: MediaPlayoutAudioDecodeInput | null) => boolean;
  /**
   * 揃える相手 (映像) がいるかを返す。省略すると「映像の出力が構成されているか」で決める
   *
   * 揃える相手がいない (音声だけを購読している) ときは、目標の開始時刻を守らずに到着基準で
   * 並べ、揺らぎの推定が届いていない周期的な停滞を先に吸収する下限を足す。映像の出力を
   * 構成していても catalog に映像のトラックが無い購読では揃える相手がいないため、呼び出し側が
   * 実際のトラックの有無を返す (ライブラリは `() => this.videoTrackInfo !== null` を渡す)。
   * 映像の出力を構成していないときは、このコールバックの値によらず揃える相手はいない。
   * このコールバックは throw しないこと。throw した場合は `status: "error"` として返す。
   */
  readonly hasCounterpart?: () => boolean;
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
   * このコールバック (および `output.isAvailable`) は throw しないこと。throw した場合は
   * フレームを閉じて `status: "skipped"` を返す (表示しない扱いにする)。
   */
  readonly admit?: (input: MediaPlayoutVideoDecodeInput | null) => boolean;
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
   * 古い方から忘れる。relay の cache からまとめて復号する購読では、復号へ渡してから出力が
   * 届くまでの件数が増えるため、大きい値を指定する (moqt-devtools は 8192)。
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

export type { MediaPlayoutDrainOptions, MediaPlayoutDrainStats } from "./audioPlayoutTimingStats";
export type { PlayoutTimestampKind } from "./decodeInputTimestamps";

/** `MediaPlayout` の設定 */
export interface MediaPlayoutOptions {
  /**
   * 音声の再生。省略すると音声を構成しない (`pushAudio` は `skipped` を返す)
   *
   * `audio: {}` のように指定すると、鳴らす先が無くても音声を構成する
   * (`getStats().audio` が非 null になり、`setAudioOutput` で後から出力を足せる)。
   */
  readonly audio?: MediaPlayoutAudioOptions | null;
  /** 映像の表示。省略すると映像を構成しない (`pushVideo` はフレームを閉じて `skipped` を返す) */
  readonly video?: MediaPlayoutVideoOptions | null;
  /**
   * 共有の時間軸 (jitter buffer) を使うか。既定は true
   *
   * false のときは TIMESTAMP の対応付けと表示時刻の決定をせず、届いた順に鳴らし・表示する
   * (音声の目標遅延の閉ループは動き続ける。時間軸の学習だけを使わない)。
   */
  readonly jitterBuffer?: boolean;
  /**
   * catalog から解決した表示の遅れの目標 (ミリ秒)。既定は null
   *
   * `draft-ietf-moq-msf-01 §5.2.8` の `targetLatency`。MUST は同じ render group と
   * alternate group の track が同じ値を持つことであり、音声と映像で同じ値を使うこと自体は
   * MUST ではない。この入口は 1 つの値しか持てないため、呼び出し側が同じ group の track に
   * 同じ値を載せて渡す (ライブラリは catalog から解決した 1 値を渡す)。購読の途中で
   * 変わったときは `setTargetLatencyMs` で変える。
   */
  readonly targetLatencyMs?: number | null;
  /**
   * 映像の表示待ちのキューの上限 (枚)。既定は `JITTER_BUFFER_MAX_QUEUED_FRAMES` (24)
   *
   * 時間軸が許す表示の遅れの上限もこの値から決まる。1 以上の整数を指定する。
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
      readonly timestampKind: PlayoutTimestampKind;
    }
  | {
      /** 並べすぎで鳴らさずに捨てた */
      readonly status: "dropped";
      readonly rebased: boolean;
      readonly catchUpStarted: boolean;
      /** 捨てた理由 */
      readonly reason: "backlog";
      readonly timestampKind: PlayoutTimestampKind;
    }
  | {
      /** 鳴らす準備の途中で失敗した。選別の失敗は計器に記録しない */
      readonly status: "error";
      readonly rebased: boolean;
      readonly catchUpStarted: boolean;
      /** 失敗の内容。呼び出し側が onError やログへ流す */
      readonly error: Error;
      readonly timestampKind: PlayoutTimestampKind;
    }
  | {
      /**
       * `MediaPlayoutAudioOptions.admit` が false を返したため鳴らさなかった
       *
       * 時間軸へも計器へも記録していない。鳴らなかったことを数えるかどうかは呼び出し側が
       * 決める (moqt-devtools は追いつきの間の音として数える)。
       */
      readonly status: "notAdmitted";
      readonly timestampKind: PlayoutTimestampKind;
    }
  | {
      /** 鳴らす先が無いか、音声を構成していないため何もしなかった */
      readonly status: "skipped";
      readonly timestampKind: PlayoutTimestampKind;
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
      /**
       * 表示しなかった (フレームは閉じてある)
       *
       * 出し先が無い、映像を構成していない、または選別 (`admit` / `output.isAvailable`) が
       * throw したときである。
       */
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
  /** 音声の目標遅延の閉ループの内訳 (音声だけを使うときに読む) */
  readonly delayFeedback: AudioDelayFeedbackSnapshot;
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
  /** 音声の再生の統計 (音声を構成していないときだけ null) */
  readonly audio: MediaPlayoutAudioStats | null;
  /** 映像の表示の統計 (映像を構成していないときだけ null) */
  readonly video: MediaPlayoutVideoStats | null;
  /**
   * 音声と映像の同期の推定値
   *
   * 音声か映像の片方を構成していないとき、時間軸を使わないときは null。壁時計の TIMESTAMP
   * を観測しているかどうかの判断は、購読しているトラックを知っている呼び出し側が行う
   * (`createMediaSubscriber` は音声と映像の両方で壁時計の TIMESTAMP を観測するまで null を
   * 返す)。
   */
  readonly avSync: AvSyncStats | null;
}

/** 表示待ちのキューの上限の下限 (枚)。0 以下では 1 枚も保持できない */
const MIN_MAX_QUEUED_FRAMES = 1;

/**
 * 数値の設定を検証する
 *
 * 公開 API の数値は、範囲外の値で無限ループや無音を起こさないよう入口で弾く
 * (`preDecodeDelayMs` の検証と同じ方針)。
 *
 * @param name - 設定の名前 (エラーメッセージに使う)
 * @param value - 検証する値
 * @param minimum - 許す最小値
 * @throws 有限数でない、または最小値より小さい場合
 */
function validateNumberOption(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}, got ${value}`);
  }
}

/**
 * 整数の設定を検証する
 *
 * @param name - 設定の名前 (エラーメッセージに使う)
 * @param value - 検証する値
 * @param minimum - 許す最小値
 * @throws 整数でない、または最小値より小さい場合
 */
function validateIntegerOption(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, got ${value}`);
  }
}

/**
 * 復号済みの音声と映像の再生の入口
 *
 * 1 つの再生のまとまりに対して 1 つ作る。音声と映像は同じ時間軸を共有する。購読の
 * やり直しでは作り直してもよいし、`resetPlayout` / `resetAudioPlayback` で状態を取り直して
 * 再利用してもよい (ライブラリは購読者ごとに 1 つ作って再利用する)。
 * 音声は `audio` オプションを渡して構成しておき、鳴らす先 (`context` / `destination`) だけを
 * 後から `setAudioOutput` で付ける。`audio` を省略した場合は音声を構成しないため、
 * 後から出力を足すことはできない (映像だけを使う)。
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
  /** 復号の出力で入力が引けなかったときに使う、意図した復号前の遅延 (ミリ秒) */
  private fallbackIntentionalDelayMs: number;
  /** 映像の表示待ちのキューの上限 (枚)。時間軸の上限と映像キューへ同じ値を渡す */
  private readonly maxQueuedFrames: number;
  // 音声の再生 (音声を構成していないときは null)。音声の計器と選別は音声の有無と
  // 同じ寿命であり、別々に null を判定すると到達しない防御が残るため 1 つにまとめる
  private readonly audio: {
    readonly session: AudioPlayoutSession;
    readonly timing: AudioPlayoutTimingStats;
    readonly admit: ((input: MediaPlayoutAudioDecodeInput | null) => boolean) | null;
    readonly hasCounterpart: (() => boolean) | null;
  } | null;
  // 鳴らす先 (後から付け外しできる)
  private audioOutput: AudioPlayoutOutput | null;
  // 映像の表示 (映像を構成していないときは null)
  private readonly video: {
    readonly session: VideoPlayoutSession;
    readonly admit: ((input: MediaPlayoutVideoDecodeInput | null) => boolean) | null;
  } | null;

  constructor(options: MediaPlayoutOptions) {
    const audioOptions = options.audio ?? null;
    const videoOptions = options.video ?? null;
    if (audioOptions === null && videoOptions === null) {
      throw new Error("at least one of audio or video must be specified");
    }
    // 数値の設定は、範囲外の値でハングや無音を起こさないよう先に検証する
    if (options.targetLatencyMs !== undefined && options.targetLatencyMs !== null) {
      validateNumberOption("targetLatencyMs", options.targetLatencyMs, 0);
    }
    if (options.maxQueuedFrames !== undefined) {
      validateIntegerOption("maxQueuedFrames", options.maxQueuedFrames, MIN_MAX_QUEUED_FRAMES);
    }
    if (options.intentionalDelayMs !== undefined) {
      validateNumberOption("intentionalDelayMs", options.intentionalDelayMs, 0);
    }
    const decodeInputOptions = options.decodeInputs ?? {};
    if (decodeInputOptions.maxTracked !== undefined) {
      validateIntegerOption("decodeInputs.maxTracked", decodeInputOptions.maxTracked, 1);
    }

    this.useTimeline = options.jitterBuffer ?? true;
    this.fallbackIntentionalDelayMs = options.intentionalDelayMs ?? 0;
    // 時間軸の上限と映像キューの上限は同じ値にする。片方だけに渡すと、公開オプションが
    // どちらの意味で効いているか読めなくなる
    this.maxQueuedFrames = options.maxQueuedFrames ?? JITTER_BUFFER_MAX_QUEUED_FRAMES;
    this.timeline = new PlayoutTimeline({
      timeOriginMs: performance.timeOrigin,
      maxQueuedFrames: this.maxQueuedFrames,
    });
    // 目標の遅延は音声と映像で同じ値を使う (同じ render group または alternate group の
    // track は同じ値でなければならない MUST。この入口は 1 値しか持てないため、呼び出し側が
    // 解決した値を渡す)
    this.timeline.setTargetLatencyMs(options.targetLatencyMs ?? null);

    const maxTracked = decodeInputOptions.maxTracked ?? DEFAULT_MAX_TRACKED_DECODE_INPUTS;
    const forgetOnDuplicate = decodeInputOptions.forgetOnDuplicate ?? false;
    this.audioInputs = new AudioDecodeInputs({ maxTracked, forgetOnDuplicate });
    this.videoInputs = new VideoDecodeInputs({ maxTracked, forgetOnDuplicate });

    if (audioOptions !== null) {
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
      const timing =
        audioOptions.timing ??
        new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, performance.timeOrigin);
      this.audio = {
        session: new AudioPlayoutSession({ timing }),
        timing,
        admit: audioOptions.admit ?? null,
        hasCounterpart: audioOptions.hasCounterpart ?? null,
      };
      this.audioOutput =
        context !== undefined && destination !== undefined ? { context, destination } : null;
    } else {
      this.audio = null;
      this.audioOutput = null;
    }

    if (videoOptions !== null) {
      this.video = {
        session: new VideoPlayoutSession(this.buildVideoSessionOptions(videoOptions)),
        admit: videoOptions.admit ?? null,
      };
    } else {
      this.video = null;
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
      maxQueuedFrames: this.maxQueuedFrames,
      // 既定はライブラリの使い方 (書いた時点では表示せず、表示の間隔はブラウザが決める)
      pacing: options.pacing ?? {
        drainImmediately: true,
        framesPerDrain: Number.POSITIVE_INFINITY,
      },
    };
    if (options.timing === undefined) {
      return base;
    }
    return { ...base, timing: options.timing };
  }

  /**
   * 復号へ渡した音声 Object の情報を記録する
   *
   * `AudioDecoder.decode()` へ渡す直前に呼ぶ。復号の出力 (`AudioData`) には TIMESTAMP の
   * 種類が無いため、この記録を `pushAudio` が引く。`timestampKind` が `"none"` の音は、
   * 同じ TIMESTAMP に残った古い記録を消す (種類も位置も一意に引けないため)。
   * 音声を構成していないときは何もしない。
   *
   * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param input - TIMESTAMP の種類と、測れた付加情報
   */
  trackAudioDecodeInput(timestampMicros: number, input: MediaPlayoutAudioDecodeInput): void {
    if (this.audio === null) {
      return;
    }
    this.audioInputs.remember(timestampMicros, input);
  }

  /**
   * 復号へ渡した映像 Object の情報を記録する
   *
   * `VideoDecoder.decode()` へ渡す直前に呼ぶ。復号の出力 (`VideoFrame`) では Object の位置が
   * 分からないため、この記録を `pushVideo` が引く。位置は選別
   * (`MediaPlayoutVideoOptions.admit`) にだけ使う。映像を構成していないときは何もしない。
   *
   * @param timestampMicros - decoder へ渡した TIMESTAMP (マイクロ秒)
   * @param input - TIMESTAMP の種類と Object の位置
   */
  trackVideoDecodeInput(timestampMicros: number, input: MediaPlayoutVideoDecodeInput): void {
    if (this.video === null) {
      return;
    }
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
   * `admit` だけは鳴らす先が無いときも呼ぶ (追いつきの状態を進める副作用を落とさない)。
   * 戻り値は `skipped` が優先される (`notAdmitted` より先に判定する)。
   *
   * @param data - 復号した音
   */
  pushAudio(data: AudioData): MediaPlayoutAudioResult {
    const audio = this.audio;
    if (audio === null) {
      // 音声を構成していない。AudioData は呼び出し側の所有物なので触らない
      return { status: "skipped", timestampKind: "none" };
    }
    const session = audio.session;
    // 復号の出力の timestamp に対応する入力を引く。対応とみなす差の上限は音 1 つの長さの
    // 半分にする (隣の音と取り違えない範囲で最大まで広げられる)
    //
    // close 済みの AudioData は寸法を読めない実装がありうる。読めないときは対応表を引かず、
    // 種類 "none" として復号の組み立てへ渡す (その中で「鳴らせない」結果になる)
    let inputTimestamp = 0;
    let frameDurationMicros = 0;
    let readable = true;
    try {
      inputTimestamp = data.timestamp;
      if (data.numberOfFrames > 0 && data.sampleRate > 0) {
        frameDurationMicros = (data.numberOfFrames / data.sampleRate) * 1_000_000;
      }
    } catch {
      readable = false;
    }
    const toleranceMicros =
      frameDurationMicros > 0
        ? Math.max(DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS, Math.floor(frameDurationMicros / 2))
        : DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS;
    const resolved = readable
      ? this.audioInputs.resolve(inputTimestamp, toleranceMicros)
      : { timestampKind: null, input: null };
    const timestampKind: PlayoutTimestampKind = resolved.timestampKind ?? "none";
    const matched = resolved.input;

    // 選別は鳴らす先があるかどうかに関わらず行う。呼び出し側の選別は追いつきの状態を進める
    // 副作用を持ちうるため、再生していない間も判定を飛ばさない (moqt-devtools が使う)
    let admitted: boolean;
    try {
      admitted = audio.admit === null || audio.admit(matched);
    } catch (error) {
      // コールバックは throw しない契約である。それでも状態を壊さず結果で返す
      return {
        status: "error",
        rebased: false,
        catchUpStarted: false,
        error: error instanceof Error ? error : new Error(String(error)),
        timestampKind,
      };
    }
    if (this.audioOutput === null) {
      // 鳴らす先が無いため何もしない。計器へも時間軸へも記録しない
      return { status: "skipped", timestampKind };
    }
    if (!admitted) {
      return { status: "notAdmitted", timestampKind };
    }

    // 揃える相手 (映像) がいるときだけ目標の開始時刻を守る。音声だけのときは到着基準で
    // 並べ、下限を足して周期的な停滞を先に吸収する
    let counterpartPresent: boolean;
    try {
      counterpartPresent =
        this.video !== null && (audio.hasCounterpart === null || audio.hasCounterpart());
    } catch (error) {
      return {
        status: "error",
        rebased: false,
        catchUpStarted: false,
        error: error instanceof Error ? error : new Error(String(error)),
        timestampKind,
      };
    }
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
      enforceTarget: this.useTimeline && counterpartPresent,
      // 映像に合わせる相手がいるときは渡さない (映像とのずれの原因になる)
      ...(counterpartPresent ? {} : { arrivalDelayFloorMs: AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS }),
      output: this.audioOutput,
    });
    return { ...result, timestampKind };
  }

  /**
   * 復号した映像フレームを表示待ちへ渡す
   *
   * 時間軸への記録、表示待ちのキューへの積み込み、表示周期ごとの選択、計器への記録は
   * この中で行う。表示するとフレームの所有権は出し先へ移る (この中では閉じない)。
   * 表示しないと決めたとき、映像を構成していないとき、選別が throw したときは閉じる。
   *
   * @param frame - 復号したフレーム
   */
  pushVideo(frame: VideoFrame): MediaPlayoutVideoResult {
    const video = this.video;
    if (video === null) {
      // 映像を構成していない。フレームは入口が所有して閉じる
      frame.close();
      return { status: "skipped" };
    }
    const session = video.session;
    const input = this.videoInputs.take(frame.timestamp);
    if (video.admit !== null) {
      // 記録から引けなかったフレームも渡す (位置が分からないため、呼び出し側が従来どおり
      // 表示する側に倒せるようにする)
      let admitted: boolean;
      try {
        admitted = video.admit(input ?? null);
      } catch {
        // コールバックは throw しない契約である。それでも状態を壊さず、フレームを閉じて
        // 表示しなかった (skipped) として返す
        frame.close();
        return { status: "skipped" };
      }
      if (!admitted) {
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
   * null を渡したときは、出力の時計の対応と直前の音も捨てる (閉じた `AudioContext` の
   * 時計で次の音を予約しないため)。
   *
   * 予約済みの音は null を渡しても止まらない (鳴り続ける)。止めるには `AudioContext` を
   * 閉じる。待って鳴らし切る場合は先に `drainAudio` を呼ぶ。
   *
   * `AudioContext` を作り直したときは、新しい出力を付けたあとに `resetAudioPlayback` を
   * 呼ぶ。ここで捨てる時計の対応は null を渡したときだけで、新しい出力を差し替えただけでは
   * 旧 `AudioContext` の対応は残る (`resetAudioPlayback` が捨てる)。
   *
   * @param output - 新しい出力。null で鳴らさない
   * @throws 音声を構成していない (MediaPlayoutOptions.audio を省略した) 場合
   */
  setAudioOutput(output: AudioPlayoutOutput | null): void {
    const audio = this.audio;
    if (audio === null) {
      throw new Error("audio is not configured: pass MediaPlayoutOptions.audio");
    }
    if (output === null) {
      // 閉じた Context の時計の対応を残すと、次に鳴らすときに古い対応で予約する
      audio.session.releaseAudioContext();
    }
    this.audioOutput = output;
  }

  /**
   * 表示の遅れの目標を変える
   *
   * 購読の途中で catalog の `targetLatency` が変わったときに呼ぶ。
   *
   * @param value - 目標 (ミリ秒)。null で目標を使わない
   */
  setTargetLatencyMs(value: number | null): void {
    if (value !== null) {
      validateNumberOption("targetLatencyMs", value, 0);
    }
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
    validateNumberOption("intentionalDelayMs", value, 0);
    this.fallbackIntentionalDelayMs = value;
  }

  /**
   * 再生の状態を取り直す
   *
   * 時間軸の基準と学習を取り直し、映像の表示待ちと復号へ渡した映像入力の対応表を捨て、
   * 音声の追いつきの観測を消す。復号前の遅延の段の設定を変えたときや、購読を始めるときに
   * 呼ぶ。音声の予約の基準と計器の累積は消さない (`resetAudioPlayback` と
   * `MediaPlayoutAudioStats` を参照)。
   */
  resetPlayout(): void {
    this.timeline.reset();
    this.clearVideoQueue();
    this.audio?.session.catchUp.reset();
  }

  /**
   * 時間軸から音声の状態を消す
   *
   * 音声の再生を止めたときに呼ぶ。残すと共有の再生遅延に音声の下限
   * (`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) が残り、映像の表示が音声を一度も再生していない購読より
   * 遅れたまま固定される。世代は進めない (積んでいる映像フレームを到着順に落とさない)。
   */
  resetAudioTimeline(): void {
    this.timeline.resetStream("audio");
  }

  /**
   * 音声の再生の状態を取り直す
   *
   * 予約の基準・出力の時計の対応・追いつきの観測を消す。`AudioContext` を作り直したときに
   * 呼ぶ。計器の累積 (鳴った量・鳴らなかった量・詰め・補間・基準の取り直し・捨て) は購読の
   * 統計として引き継ぐため消さない。
   */
  resetAudioPlayback(): void {
    this.audio?.session.reset();
  }

  /**
   * 購読の停止で使う状態を捨てる
   *
   * 時間軸の基準と学習、復号へ渡した入力の対応表、映像の表示待ちを消す。計器の累積
   * (再生の観測・受信側の追いつきの観測) は、停止直後の統計として読めるよう残す
   * (次に `resetAudioPlayback` で音声の再生の状態を取り直すときに、追いつきの観測も消える)。
   * `AudioContext` の時計の対応は `setAudioOutput(null)` で消す。
   */
  clearAll(): void {
    this.timeline.reset();
    this.audioInputs.clear();
    this.videoInputs.clear();
    this.video?.session.clear();
  }

  /**
   * 予約済みで鳴り終わっていない音を「切った量」として計器へ残す
   *
   * 鳴らす先を閉じる直前に呼ぶ。閉じると予約は鳴らないまま消えるため、計器に残さないと
   * 「鳴らなかった量」に現れない。すぐに閉じる場合の後始末であり、待つ必要がある場合は
   * `drainAudio` を使う。
   */
  recordAudioStopped(): void {
    this.audio?.session.recordStopped();
  }

  /**
   * 予約済みの音が鳴り終わるまで待つ
   *
   * 停止のときに呼ぶ。待ち時間の上限で鳴り終わらなかった分は「切った量」として計器に残る。
   *
   * @param options - 待ち時間と、flush した Object の復号の出力を待つ条件
   */
  async drainAudio(options: MediaPlayoutDrainOptions = {}): Promise<MediaPlayoutDrainStats> {
    if (options.maxWaitMs !== undefined) {
      validateNumberOption("maxWaitMs", options.maxWaitMs, 0);
    }
    const session = this.audio?.session;
    if (session === undefined) {
      // 音声を構成していないため、待つ予約が無い
      return emptyDrainStats();
    }
    return session.drainReserved(options);
  }

  /**
   * 表示待ちの映像を捨て、予約した表示を取り消す
   *
   * 復号へ渡した映像入力の対応表も消える (表示しないフレームの入力はもう引けないため)。
   * 停止のときは `clearAll` を使う。
   */
  clearVideoQueue(): void {
    this.videoInputs.clear();
    this.video?.session.clear();
  }

  /**
   * 統計を読む
   *
   * 時間軸 (直近の窓) の値は呼び出した時点で求める。
   */
  getStats(): MediaPlayoutStats {
    const audio = this.audio;
    const video = this.video;
    return {
      audio:
        audio === null
          ? null
          : {
              rebases: audio.session.playout.rebases,
              drops: audio.session.playout.drops,
              concealments: audio.session.playout.concealments,
              compressedMs: audio.session.playout.compressed * 1_000,
              concealedMs: audio.session.playout.concealed * 1_000,
              latenessMs: audio.session.playout.lateness * 1_000,
              timing: audio.timing.snapshot(performance.now()),
              catchUp: audio.session.catchUp.snapshot(),
              delayFeedback: this.timeline.audioDelayFeedbackStats(),
            },
      video:
        video === null
          ? null
          : {
              queuedFrames: video.session.playout.size,
              playoutDelayMs: video.session.playout.playoutDelayMs(),
            },
      avSync: this.buildAvSyncStats(),
    };
  }

  /**
   * 音声と映像の同期の推定値
   *
   * 片方を構成していないとき、時間軸を使わないときは null。壁時計の TIMESTAMP を観測して
   * いるかどうかは、購読しているトラックを知っている呼び出し側が判定する
   * (`createMediaSubscriber` を参照)。
   */
  private buildAvSyncStats(): AvSyncStats | null {
    const audio = this.audio;
    if (!this.useTimeline || audio === null || this.video === null) {
      return null;
    }
    return {
      skewMs: this.timeline.skewMs(),
      presentationDelayMs: this.timeline.presentationDelayMs,
      targetLatencyMs: this.timeline.targetLatencyMs,
      targetLatencyLimitedMs: this.timeline.targetLatencyLimitedMs,
      // 音声を再生していない間は AudioContext が無く、時計の代用も起きていない
      audioClockFallback: this.audioOutput !== null && audio.session.clock.usingFallback,
      delays: this.timeline.delayBreakdown,
    };
  }
}

/** 音声の drain をしない (構成していない) ときの結果 */
function emptyDrainStats(): MediaPlayoutDrainStats {
  return {
    pendingMsAtStart: 0,
    requestedMs: 0,
    waitedMs: 0,
    playedMs: 0,
    cutMs: 0,
    flushedObjects: 0,
    undecodedFlushedObjects: 0,
  };
}

/**
 * 復号済みの音声と映像の再生の入口を作る
 *
 * 音声は `audio` オプションを渡して構成し、鳴らす先だけを後から `setAudioOutput` で付ける。
 *
 * @param options - 音声の出力と映像の出し先、時間軸の設定
 * @returns 再生の入口
 */
export function createMediaPlayout(options: MediaPlayoutOptions): MediaPlayout {
  return new MediaPlayout(options);
}
