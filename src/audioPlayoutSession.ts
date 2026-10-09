/**
 * 復号した音声の再生の組み立て (時間軸への記録・目標の決定・予約・計器への記録)
 *
 * 受信した復号済みの音声 (`AudioData`) と、その音の TIMESTAMP の種類 (壁時計かメディア時刻か)
 * を入れると、共有の時間軸 (`src/playbackTimeline.ts`) への記録から
 * `AudioPlayoutScheduler` での予約、計器 (`src/audioPlayoutTimingStats.ts`) への記録までを
 * 行う。鳴らす時刻の目標は、時間軸が決めた表示時刻と `AudioClockBridge` の対応から求める。
 *
 * 同じ組み立てを `src/createMediaSubscriber.ts` (ライブラリ) と
 * `devtools/src/hooks/useSubscriber.ts` (devtools) が別々に持つと、到着基準の遅れ・
 * 閉ループ・計器の修正を 2 か所へ入れる必要があり、片方だけを直すと挙動がずれる。
 * 組み立てはここ 1 か所に置き、両方がこれを使う。
 *
 * ブラウザ依存 (Web Audio の `AudioContext` とその時計) は `AudioPlayoutOutput` として
 * 注入する。`AudioContext` の時計と `performance.now()` の対応は既存の `AudioClockBridge` を
 * 境界に使うため、このクラス自体はブラウザ API の無い環境でも記録用の最小オブジェクトで
 * 検証できる。呼び出し側が devtools 固有の判断 (relay の cache から追いつく途中の音を
 * 鳴らさない、音声だけを購読している、再生の有効・無効、UI への反映) を持つ。
 *
 * 公開 API である (src/index.ts)。docs/HIGH_LEVEL_API.md の「音声の再生の組み立て」を参照。
 */

import {
  AudioClockBridge,
  AudioPlayoutScheduler,
  arrivalPlayoutDelaySeconds,
  concealmentEndGain,
} from "./audioPlayout";
import type { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { compressSamples, concealSamples, type AudioSamples } from "./audioTimeStretch";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, type PlaybackTimeline } from "./playbackTimeline";

/**
 * 音の TIMESTAMP の種類 (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)
 *
 * - `wallClock`: TIMESCALE が無い TIMESTAMP (Unix epoch マイクロ秒)。映像と同じ時間軸で
 *   表示時刻を決められる
 * - `mediaTime`: TIMESCALE がある TIMESTAMP。メディア時刻であり壁時計とは対応しない
 * - `none`: TIMESTAMP が無い (decoder へは 0 を渡す)
 */
export type AudioPlayoutTimestampKind = "none" | "wallClock" | "mediaTime";

/**
 * Web Audio のうち、音声の再生で使う部分
 *
 * `AudioContext` の実物をそのまま渡せる (必要なメソッドだけを持つ構造の型である)。
 * テストでは同じ形の記録用オブジェクトを注入する。
 */
export interface AudioPlayoutContext {
  /** `AudioContext.currentTime` (秒)。予約の基準であり、時計の対応を作るのにも使う */
  readonly currentTime: number;
  /**
   * `AudioContext.getOutputTimestamp()`
   *
   * まだ音を出していない (両方 0) ときは、呼び出し側が対応を作らない
   * (`AudioClockBridge.update` の JSDoc を参照)
   */
  getOutputTimestamp(): AudioTimestamp;
  /** `AudioContext.createBuffer`。鳴らす音と、欠落した区間の補間の両方に使う */
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  /** `AudioContext.createBufferSource` */
  createBufferSource(): AudioBufferSourceNode;
}

/**
 * 音声を鳴らす先
 *
 * `AudioContext` と、予約した音を繋ぐ出力 (`MediaStreamAudioDestinationNode` など) の組。
 * ブラウザ依存 (Web Audio) はこの境界に閉じ込める。まだ `AudioContext` が無い
 * (音声を再生しない) ときは null を渡す。
 */
export interface AudioPlayoutOutput {
  readonly context: AudioPlayoutContext;
  readonly destination: AudioNode;
}

/** 復号した音 1 つ分の再生の依頼 */
export interface AudioPlayoutRequest {
  /**
   * 復号した音
   *
   * 所有権は呼び出し側に残る (この中では `close()` しない)
   */
  readonly data: AudioData;
  /**
   * 音の TIMESTAMP の種類
   *
   * `wallClock` のときだけ、共有の時間軸へ記録して目標の開始時刻を決める
   */
  readonly timestampKind: AudioPlayoutTimestampKind;
  /** 音声と映像で共有する表示時刻の時間軸 */
  readonly timeline: PlaybackTimeline;
  /**
   * 時間軸を使って鳴らすか (jitter buffer が有効なとき)
   *
   * false のときは共有の時間軸へ記録せず、到着基準で並べる (目標の開始時刻も使わない)。
   * jitter buffer が無効な購読では映像も時間軸へ記録しないため、音声だけを目標へ合わせると
   * 映像とずれる
   */
  readonly useTimeline: boolean;
  /**
   * 目標の開始時刻を守るか (揃える相手がいるか)
   *
   * false のとき (音声だけを購読していて揃える相手がいないとき、jitter buffer が無効な
   * とき) は、鳴らす時刻を過ぎて届いた音は基準を取り直して鳴らす。目標の開始時刻を
   * 決められなかったときも到着基準になる (結果は同じ)
   */
  readonly enforceTarget: boolean;
  /**
   * 鳴らす先。null のときは鳴らさず、時間軸への記録も計器への記録もしない
   * (音声を再生していないとき)
   */
  readonly output: AudioPlayoutOutput | null;
}

/**
 * 復号した音 1 つ分の再生の結果
 *
 * 呼び出し側は、鳴らなかった音の数 (devtools の `audioPlayoutDrops`) と、基準を取り直した
 * 回数 (`audioPlayoutRebases`) を、この結果から数える。計器への記録 (鳴るはずの時刻・
 * 鳴り始める時刻・鳴らなかった量) はこのクラスが済ませている
 */
export type AudioPlayoutResult =
  | {
      /** 鳴らすと決めて予約した */
      readonly status: "played";
      /** この音の予約で基準を取り直したか (`AudioPlayoutScheduler.rebases` が増えたか) */
      readonly rebased: boolean;
    }
  | {
      /** 並べすぎで捨てた (鳴らさなかった) */
      readonly status: "dropped";
      /** この音の予約で基準を取り直したか (捨てる判断と基準の取り直しは同時に起きない) */
      readonly rebased: boolean;
      /** 捨てた理由 */
      readonly reason: "backlog";
    }
  | {
      /** 鳴らす準備の途中で失敗した (計器には「鳴らなかった」として記録済み) */
      readonly status: "error";
      /** この音の予約で基準を取り直したか */
      readonly rebased: boolean;
      /** 失敗の内容。呼び出し側が onError やログへ流す */
      readonly error: Error;
    }
  | {
      /** 鳴らす先が無いため、何もしなかった (音声を再生していないとき) */
      readonly status: "skipped";
    };

/** `AudioPlayoutSession` の設定 */
export interface AudioPlayoutSessionOptions {
  /** 鳴らした音と鳴らなかった音の記録の入れ先 (計器) */
  readonly timing: AudioPlayoutTimingStats;
  /**
   * 鳴らした結果を閉ループ (音声の目標遅延の学習) へ渡すか
   *
   * true のとき、鳴らした直後と並べすぎで捨てた直後に、計器が求めた観測
   * (`AudioPlayoutTimingStats.audioDelayFeedback`) を時間軸へ渡す
   * (`PlaybackTimeline.observeAudioPlayout` / `src/audioDelayFeedback.ts`)。
   *
   * 既定は true (ライブラリの挙動)。devtools はこの閉ループをまだ流しておらず、
   * 表示している `AvSyncStats.delays.audioDelayFeedback` の値もその状態に依存するため、
   * 移設と共有化だけを行う段階では false を渡して値を変えない
   * (tests/e2e/devtools-av-sync.spec.ts の「まだ動いていない」も参照)
   */
  readonly audioDelayFeedback?: boolean;
}

/**
 * 復号した音声の再生
 *
 * 1 つの音声の購読 (または再生) に対して 1 つ作る。`AudioContext` を作り直すときは
 * `reset()` で基準を消してから使い続ける (作り直すたびに作り直してもよい)。
 */
export class AudioPlayoutSession {
  /**
   * 鳴らす時刻の予約。基準を取り直した回数と捨てた音の数を読む
   *
   * 検証 (基準の取り直しと捨ての数を直接駆動する) と統計 (`AudioReceiverStats`) が読む
   */
  readonly playout: AudioPlayoutScheduler;
  /**
   * `AudioContext` の時計と `performance.now()` の対応
   *
   * 同期の推定 (`AvSyncStats.audioClockFallback`) が読む
   */
  readonly clock: AudioClockBridge;
  /** 鳴らした音と鳴らなかった音の記録の入れ先 (計器) */
  private readonly timing: AudioPlayoutTimingStats;
  /** 鳴らした結果を閉ループ (音声の目標遅延の学習) へ渡すか */
  private readonly audioDelayFeedback: boolean;
  // 直前に鳴らした音のサンプルとサンプルレート。欠落した区間の補間を作るために保持する
  private previousChannels: AudioSamples[] | null = null;
  private previousSampleRate = 0;

  constructor(options: AudioPlayoutSessionOptions) {
    this.timing = options.timing;
    this.audioDelayFeedback = options.audioDelayFeedback ?? true;
    this.playout = new AudioPlayoutScheduler();
    this.clock = new AudioClockBridge();
  }

  /**
   * 復号した音を鳴らす
   *
   * 到着 (復号の出力を受け取った) 時刻から、時間軸へ記録し、目標の開始時刻を決め、
   * `AudioContext` の秒へ予約し、計器へ記録する。鳴らなかった音は理由と長さを計器へ残す。
   * 失敗しても throw せず、結果 (`status: "error"`) で返す (呼び出し側が onError や
   * ログへ流す)。`AudioData` は閉じない。
   *
   * @param request - 復号した音と、その音の TIMESTAMP の種類、鳴らす先
   * @returns 鳴らした / 捨てた / 失敗した / 何もしなかったの別
   */
  handleDecodedAudio(request: AudioPlayoutRequest): AudioPlayoutResult {
    const output = request.output;
    if (output === null) {
      // 音声を再生していない。時間軸への記録もできない (基準が無いため)
      return { status: "skipped" };
    }
    const { context } = output;
    const data = request.data;
    // 鳴らすと決めたが鳴らし始める前に失敗した音を数えるための状態。失敗はこれまで
    // onError にしか現れず、鳴らなかった量として数えられていなかった
    let planned: { arrivalMs: number; targetMs: number | null; durationMs: number } | null = null;
    let played = false;
    // 基準を取り直したかをこの音の前後で比べる (呼び出し側が回数として数える)
    const rebasesBefore = this.playout.rebases;

    try {
      const numberOfChannels = data.numberOfChannels;
      const sampleRate = data.sampleRate;
      const numberOfFrames = data.numberOfFrames;
      // 到着 (復号の出力を受け取った) 時刻。時間軸への記録と観測値の両方に同じ値を使う
      const arrivalMs = performance.now();

      // 目標の開始時刻を使うのは、壁時計の TIMESTAMP を持ち、時間軸を使っているときだけである。
      // メディア時刻 (TIMESCALE あり) と TIMESTAMP 無しの音は映像の表示時刻と対応しない
      const wallClockTimestamp =
        request.useTimeline && request.timestampKind === "wallClock" ? data.timestamp : null;
      if (wallClockTimestamp !== null) {
        // 復号の出力を共有の時間軸へ記録し、映像と同じ式で表示時刻を求める
        // (src/playbackTimeline.ts)
        request.timeline.observe("audio", performance.timeOrigin + arrivalMs, wallClockTimestamp);
      }

      // AudioContext の時計と performance.now() の対応を取り直す。まだ描画が始まって
      // いない (currentTime が 0 で getOutputTimestamp も 0) ときは対応を作らない
      const mapping = context.getOutputTimestamp();
      const contextTime = mapping.contextTime ?? 0;
      const performanceTime = mapping.performanceTime ?? 0;
      const hasMapping = contextTime !== 0 || performanceTime !== 0;
      if (hasMapping || context.currentTime > 0) {
        this.clock.update(
          hasMapping ? { contextTime, performanceTime } : null,
          context.currentTime,
          arrivalMs,
        );
      }
      const targetMs =
        wallClockTimestamp === null
          ? null
          : request.timeline.presentationPerformanceMs("audio", wallClockTimestamp);
      const targetStartSeconds = targetMs === null ? null : this.clock.toAudioSeconds(targetMs);
      // 予約に使う今の時刻 (`AudioContext.currentTime`)。鳴り始める時刻を performance 軸へ
      // 換算するときの基準にも使う
      const contextNowSeconds = context.currentTime;
      // 到着した音が「まだ鳴っていない位置」(`AudioContext.currentTime` の秒)。AudioContext の
      // 時計は、既に出力のバッファへ積まれた分だけ実際に鳴る位置より先に進む。到着基準の
      // 遅れをこれではなく今 (currentTime) から数えると、実際に鳴るのは「到着 + 遅れ +
      // バッファの分」になる (実測では 100 ms の目標に対して 195.5 ms 鳴っていた)
      const arrivalSeconds = this.clock.toAudioSeconds(arrivalMs) ?? contextNowSeconds;
      const durationSeconds = numberOfFrames / sampleRate;
      // 音声を観測していないとき (壁時計の TIMESTAMP を持たない / Track の TIMESCALE を
      // 使う) は共有の再生遅延に下限が入らないため、ここで下限を必ず適用する
      const playoutDelaySeconds =
        Math.max(
          request.timeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
          AUDIO_PLAYOUT_DELAY_FLOOR_MS,
        ) / 1_000;
      const decision = this.playout.schedule(contextNowSeconds, data.timestamp, durationSeconds, {
        targetStartSeconds,
        // 到着した音がまだ鳴っていない位置。到着基準の遅れはここから数える
        arrivalSeconds,
        // 揃える相手がいて、目標の開始時刻を決められたときだけ目標を守る。決められなかった
        // ときは到着基準になり、`enforceTarget` の値によらず結果は同じである
        enforceTarget: request.enforceTarget && targetStartSeconds !== null,
        delaySeconds: playoutDelaySeconds,
        // 目標を使えないとき (到着基準) の再生の遅れ。共有の時間軸が学習した値は、
        // TIMESTAMP が壁時計からずれているトラックではそのずれの分だけ大きく育つため、
        // 上限で切った小さな値を使う
        arrivalDelaySeconds: arrivalPlayoutDelaySeconds(playoutDelaySeconds),
        presentationDelaySeconds:
          (request.timeline.presentationExtraDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS) / 1_000,
      });
      const rebased = this.playout.rebases !== rebasesBefore;
      if (decision.kind === "drop") {
        // 鳴らさなかった音を、理由と長さと一緒に数える。累積のカウンタ (`playoutDrops`) は
        // 件数しか持たず、何ミリ秒分の音が鳴らなかったかが分からない
        const missedAtMs = performance.now();
        this.timing.recordMiss({
          atMs: missedAtMs,
          reason: decision.reason,
          durationMs: durationSeconds * 1_000,
          targetMs,
          arrivalMs,
        });
        // 並べすぎで捨てた量は、目標を増やす判断にも使う
        this.observeDelayFeedback(missedAtMs, request.timeline);
        return { status: "dropped", rebased, reason: decision.reason };
      }
      // 鳴らすと決めたが、鳴らし始める前に失敗したら数える (catch 句)
      planned = { arrivalMs, targetMs, durationMs: durationSeconds };
      // 鳴り始める時刻 (performance 軸)。時計の対応がまだ無いときは、予約に使った
      // (performance.now(), currentTime) の組で換算する (`AudioClockBridge` の代用と
      // 同じ求め方)
      const startMs =
        this.clock.toPerformanceMs(decision.startAt) ??
        arrivalMs + (decision.startAt - contextNowSeconds) * 1_000;

      // 目標を過ぎて届いた分は、波形の周期を使って詰める (NetEq の accelerate)。遅れて
      // 届いた音を捨てると音が途切れるため、鳴らす時刻をずらした分だけ詰めて目標へ戻す
      const channels: AudioSamples[] = [];
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames);
        data.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
        channels.push(channelData);
      }
      const stretched =
        decision.compressSeconds > 0
          ? compressSamples(channels, sampleRate)
          : { channels, lengthChangeSamples: 0 };
      // 実際に詰められた長さを返す (詰められなかった分は遅れとして残る)
      this.playout.confirmStretch(-stretched.lengthChangeSamples / sampleRate);

      // 欠落した区間を、直前に鳴らした音の末尾を伸ばして埋める (src/audioTimeStretch.ts)。
      // 実際に補間した長さだけを統計へ返す
      let concealedSeconds = 0;
      if (decision.gapSeconds > 0 && this.previousChannels !== null) {
        // 長い補間ほど末尾の振幅を下げる (繰り返しの音を目立たなくする)
        const endGain = concealmentEndGain(decision.gapSeconds);
        const concealed = concealSamples(
          this.previousChannels,
          this.previousSampleRate,
          decision.gapSeconds,
          endGain,
        );
        const concealedFrames = concealed.channels[0]?.length ?? 0;
        if (concealedFrames > 0) {
          this.startBuffer(
            output,
            concealed.channels.length,
            concealed.channels,
            concealedFrames,
            this.previousSampleRate,
            decision.gapStartSeconds,
          );
          concealedSeconds = concealed.generatedSamples / this.previousSampleRate;
        }
      }
      this.playout.confirmConcealment(concealedSeconds);

      const frames = stretched.channels[0]?.length ?? numberOfFrames;
      this.startBuffer(
        output,
        numberOfChannels,
        stretched.channels,
        frames,
        sampleRate,
        decision.startAt,
      );
      // 鳴らすと決めた音を記録する。長さは詰めた後 (実際に鳴る長さ) である
      played = true;
      this.timing.recordPlay(
        arrivalMs,
        targetMs,
        startMs,
        (frames / sampleRate) * 1_000,
        decision.basis,
      );
      // 実際に鳴った結果 (予定をどれだけ過ぎたか) を、目標を決める閉ループへ渡す
      this.observeDelayFeedback(performance.now(), request.timeline);

      // 次の音の補間のために、実際に鳴らしたサンプルを保持する
      this.previousChannels = stretched.channels;
      this.previousSampleRate = sampleRate;

      // 実際に鳴らす時刻を実績として記録する (同期ずれの推定に使う)。捨てた音は鳴らない
      // ため記録しない。第 3 引数は Unix epoch マイクロ秒
      if (wallClockTimestamp !== null) {
        const presentedMs = this.clock.toPerformanceMs(decision.startAt);
        if (presentedMs !== null) {
          request.timeline.recordPresentation(
            "audio",
            wallClockTimestamp,
            BigInt(Math.round((performance.timeOrigin + presentedMs) * 1_000)),
          );
        }
      }
      return { status: "played", rebased };
    } catch (error) {
      // 鳴らす準備の途中で失敗した音は、これまで onError にしか現れなかった
      if (planned !== null && !played) {
        this.timing.recordMiss({
          atMs: performance.now(),
          reason: "error",
          durationMs: planned.durationMs * 1_000,
          targetMs: planned.targetMs,
          arrivalMs: planned.arrivalMs,
        });
      }
      return {
        status: "error",
        rebased: this.playout.rebases !== rebasesBefore,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * 予約の基準と時計の対応と直前の音を消す (AudioContext を作り直したとき)
   *
   * 予約の基準は `AudioContext.currentTime` の秒であり、作り直した `AudioContext` では
   * 0 から始まる。古い基準を使い続けると目標の時刻がずれる (`AudioClockBridge.reset` の
   * JSDoc を参照)。統計の累積 (基準を取り直した回数、捨てた音、詰めた合計、補間した合計) は
   * 消さない (購読をやり直しても引き継ぐ)。
   */
  reset(): void {
    this.playout.reset();
    this.forgetAudioContext();
  }

  /**
   * `AudioContext` を閉じた後始末をする (時計の対応と直前の音を消す)
   *
   * 開いたままの `AudioContext` を閉じる直前に呼ぶ。時計の対応は `AudioContext` ごとに
   * 異なるため残さず、直前の音も残さない (閉じた `AudioContext` の音を補間に使わない)。
   * 予約の基準は消さない (統計の `playoutLatenessMs` が読む最後の値を残す)。
   */
  releaseAudioContext(): void {
    this.forgetAudioContext();
  }

  /**
   * 予約済みでまだ鳴り始めていない音を、鳴らなかった分として数える
   *
   * `AudioContext` を閉じると、予約した音は鳴らないまま切り捨てられる。この分はどの統計にも
   * 現れないため、閉じる直前に呼ぶ。
   */
  recordStopped(): void {
    this.timing.recordStopped(performance.now());
  }

  /**
   * 鳴らした結果 (予定をどれだけ過ぎたか、並べすぎで捨てた量) を閉ループへ渡す
   *
   * 目標を動かすのは毎秒 1 回までであり、呼ぶ側は間隔を気にしない
   * (`src/audioDelayFeedback.ts`)。`audioDelayFeedback` が false のときは何もしない。
   */
  private observeDelayFeedback(atMs: number, timeline: PlaybackTimeline): void {
    if (!this.audioDelayFeedback) {
      return;
    }
    timeline.observeAudioPlayout(this.timing.audioDelayFeedback(atMs));
  }

  /** 時計の対応と直前の音を消す (AudioContext を作り直した / 閉じたとき) */
  private forgetAudioContext(): void {
    this.clock.reset();
    this.previousChannels = null;
    this.previousSampleRate = 0;
  }

  /**
   * バッファを組んで出力へ予約する (鳴らす音と、欠落した区間の補間の共通処理)
   *
   * 予約した時刻に鳴らない場合 (並べすぎ、`AudioContext` の停止) はブラウザが捨てる。
   * その分は `recordStopped` とブラウザの判断で計器に現れる。
   *
   * @param output - 鳴らす先
   * @param channelCount - バッファのチャンネル数
   * @param channels - 鳴らすサンプル (チャンネルごと)。足りない分は無音で埋める
   * @param frames - バッファの長さ (サンプル数)
   * @param sampleRate - サンプルレート (補間は直前の音のレートで鳴らす)
   * @param whenSeconds - 鳴らし始める時刻 (`AudioContext.currentTime` の秒)
   */
  private startBuffer(
    output: AudioPlayoutOutput,
    channelCount: number,
    channels: readonly AudioSamples[],
    frames: number,
    sampleRate: number,
    whenSeconds: number,
  ): void {
    const audioBuffer = output.context.createBuffer(channelCount, frames, sampleRate);
    for (let channel = 0; channel < channelCount; channel++) {
      audioBuffer.copyToChannel(channels[channel] ?? new Float32Array(frames), channel);
    }
    const source = output.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(output.destination);
    source.start(whenSeconds);
  }
}
