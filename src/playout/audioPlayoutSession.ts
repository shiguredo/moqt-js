/**
 * 復号した音声の再生の組み立て (時間軸への記録・目標の決定・予約・計器への記録)
 *
 * 受信した復号済みの音声 (`AudioData`) と、その音の TIMESTAMP の種類 (壁時計かメディア時刻か)
 * を入れると、共有の時間軸 (`src/playout/timeline.ts`) への記録から
 * `AudioPlayoutScheduler` での予約、計器 (`src/playout/audioPlayoutTimingStats.ts`) への記録までを
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
  AUDIO_PLAYOUT_STRETCH_MIN_SECONDS,
  AudioClockBridge,
  AudioPlayoutScheduler,
  arrivalPlayoutDelaySeconds,
  type AudioPlayoutDecision,
  concealmentEndGain,
} from "./audioPlayout";
import { fadeSpliceEdge } from "../audioSpliceFade";
import { isTimeStretchAvailable } from "./audioTimeStretch";
import type { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { AudioReceiveCatchUp } from "./audioReceiveCatchUp";
import { compressSamples, concealSamples, type AudioSamples } from "./audioTimeStretch";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, type PlayoutTimeline } from "./timeline";

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
  /**
   * 受信の入口で測った入力の遅れ (ミリ秒)。測れないときは null / 省略
   *
   * Object の到着の壁時計 - LOC TIMESTAMP である。受信側の追いつき (`catchUp`) が、出力の
   * 遅れからこの値と `intentionalDelayMs` を引いた「復号が足している遅れ」で復号器の
   * 作り直しを決めるために使う (src/playout/audioReceiveCatchUp.ts の先頭のコメントを
   * 参照)。経路が遅いだけの状態
   * (入力の遅れも出力の遅れも同じだけ上がる) では作り直さず、受信側が溜めたまま戻らない
   * 状態 (入力の遅れは健全で出力の遅れだけが大きい) で作り直す。
   *
   * TIMESTAMP が無い / Timescale がある (メディア時刻である) 音では測れないため、呼び出し
   * 側が null を渡す。省略したときは出力の遅れだけを使う (入力の遅れを導入する前と同じ挙動)
   */
  readonly inputLagMs?: number | null;
  /**
   * 意図した復号前の遅延 (ミリ秒)。省略したときは 0
   *
   * 購読側が `MediaSubscriberOptions.preDecodeDelayMs` で復号を意図的に遅らせているとき、
   * その分は復号器に溜まった遅れではない。受信側の追いつきは、出力の遅れから入力の遅れと
   * この値を引いた「復号が足している遅れ」で復号器の作り直しを決める
   */
  readonly intentionalDelayMs?: number;
  /** 音声と映像で共有する表示時刻の時間軸 */
  readonly timeline: PlayoutTimeline;
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
 * 鳴り始める時刻・鳴らなかった量) はこのクラスが済ませている。
 *
 * `catchUpStarted` が true のときは、受信側の追いつきを始めているため、呼び出し側は復号器を
 * 作り直す (`AudioDecoderWrapper.reset()`)。復号器の中に溜まった古い音は、鳴らさずに捨てる
 * だけでは減らないためである。鳴らす音は捨てない (音を飛ばすのは復号器であり、飛んだ分は
 * `AudioPlayoutSession.catchUp` の観測値に出る)。詳しい根拠は src/playout/audioReceiveCatchUp.ts の
 * 先頭のコメントを参照
 */
export type AudioPlayoutResult =
  | {
      /** 鳴らすと決めて予約した */
      readonly status: "played";
      /** この音の予約で基準を取り直したか (`AudioPlayoutScheduler.rebases` が増えたか) */
      readonly rebased: boolean;
      /** 受信側の追いつきを始めたか (`catchUpStarted` の説明を参照) */
      readonly catchUpStarted: boolean;
    }
  | {
      /** 並べすぎで鳴らさずに捨てた */
      readonly status: "dropped";
      /** この音の予約で基準を取り直したか (捨てる判断と基準の取り直しは同時に起きない) */
      readonly rebased: boolean;
      /** 捨てた理由 */
      readonly reason: "backlog";
      /** 受信側の追いつきを始めたか (`catchUpStarted` の説明を参照) */
      readonly catchUpStarted: boolean;
    }
  | {
      /** 鳴らす準備の途中で失敗した (計器には「鳴らなかった」として記録済み) */
      readonly status: "error";
      /** この音の予約で基準を取り直したか */
      readonly rebased: boolean;
      /** 受信側の追いつきを始めたか (`catchUpStarted` の説明を参照) */
      readonly catchUpStarted: boolean;
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
  /**
   * 受信側の音声の追いつきの判定と観測 (src/playout/audioReceiveCatchUp.ts)
   *
   * 復号の出力が送られた TIMESTAMP から遅れ続けたときに、復号器を作り直して live へ戻す。
   * 作り直しそのものは、結果 (`AudioPlayoutResult.catchUpStarted`) を受けた呼び出し側が行う
   * (復号器を持っているのは呼び出し側である)。表示とテスト用 API は `snapshot()` を読む
   */
  readonly catchUp: AudioReceiveCatchUp;
  /** 鳴らした音と鳴らなかった音の記録の入れ先 (計器) */
  private readonly timing: AudioPlayoutTimingStats;
  // 直前に鳴らした音のサンプルとサンプルレート。欠落した区間の補間を作るために保持する
  private previousChannels: AudioSamples[] | null = null;
  private previousSampleRate = 0;
  // 直前に予約したバッファ (補間を含む) の末尾のサンプル。境界の段差を測るために保持する。
  // 補間の末尾は 2 ms フェードで 0 にしてから予約するため、補間の後は 0 になる
  private lastScheduledTailSample: number | null = null;
  // 閉ループへ渡した圧縮 (時間圧縮) の累積 (ミリ秒)。前回からの増分を渡す
  private lastCompressedMs = 0;

  constructor(options: AudioPlayoutSessionOptions) {
    this.timing = options.timing;
    this.playout = new AudioPlayoutScheduler();
    this.clock = new AudioClockBridge();
    this.catchUp = new AudioReceiveCatchUp();
  }

  /**
   * 復号した音を鳴らす
   *
   * 到着 (復号の出力を受け取った) 時刻から、時間軸へ記録し、目標の開始時刻を決め、
   * `AudioContext` の秒へ予約し、計器へ記録する。鳴らなかった音は理由と長さを計器へ残す。
   * 併せて受信側の追いつきを判定する (`AudioPlayoutResult.catchUpStarted`)。
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
    // この音で受信側の追いつきを始めたか (呼び出し側が復号器を作り直すきっかけにする)
    let catchUpStarted = false;
    // 基準を取り直したかをこの音の前後で比べる (呼び出し側が回数として数える)
    const rebasesBefore = this.playout.rebases;

    try {
      const numberOfChannels = data.numberOfChannels;
      const sampleRate = data.sampleRate;
      const numberOfFrames = data.numberOfFrames;
      const durationSeconds = numberOfFrames / sampleRate;
      // 時間圧縮と補間を使えないサンプルレート (44.1 kHz の AAC など) では、遅れが目標へ
      // 戻らず、欠落した区間も補間されない。落ちずに「操作しない」を返すため区別できないので、
      // 計器に数えて気付けるようにする (src/playout/audioTimeStretch.ts)
      if (!isTimeStretchAvailable(sampleRate)) {
        this.timing.recordStretchUnavailable();
      }
      // 到着 (復号の出力を受け取った) 時刻。時間軸への記録と観測値の両方に同じ値を使う
      const arrivalMs = performance.now();

      // 目標の開始時刻を使うのは、壁時計の TIMESTAMP を持ち、時間軸を使っているときだけである。
      // メディア時刻 (TIMESCALE あり) と TIMESTAMP 無しの音は映像の表示時刻と対応しない
      const wallClockTimestamp =
        request.useTimeline && request.timestampKind === "wallClock" ? data.timestamp : null;

      // 受信側の追いつき。復号の出力が送られた TIMESTAMP から遅れ続けたら、復号器を作り直して
      // live へ戻す (src/playout/audioReceiveCatchUp.ts)。ここでは作り直すかどうかだけを決め、鳴らす
      // 音は捨てない (捨てても復号器の中の分は減らない)。壁時計の TIMESTAMP を持つ音でだけ
      // 測れる (メディア時刻は壁時計と対応しない)
      //
      // 後から届いた復旧の分を推定から除く案は、TIMESTAMP の古さでも位置の順序でも
      // 改善しなかった (docs/AUDIO_PLAYOUT_LATENCY.md)
      if (wallClockTimestamp !== null) {
        catchUpStarted = this.catchUp.observe({
          nowMs: arrivalMs,
          lagMs: performance.timeOrigin + arrivalMs - wallClockTimestamp / 1_000,
          // 復号が足している遅れ (出力の遅れ - 入力の遅れ - 意図した遅延) で作り直しを
          // 決める。入力の遅れは呼び出し側が Object の到着時点で測り、復号の出力で引いて
          // ここへ渡す。
          // 測れないとき (TIMESTAMP が無い、Timescale がある、対応が引けない) は null に
          // なっており、そのときは出力の遅れだけを使う
          inputLagMs: request.inputLagMs ?? null,
          // 意図した復号前の遅延は復号器に溜まった遅れではない。追いつきの判定から差し引く
          intentionalDelayMs: request.intentionalDelayMs ?? 0,
          durationMs: durationSeconds * 1_000,
          timestampMicros: wallClockTimestamp,
        }).rebuildDecoder;
      }

      if (wallClockTimestamp !== null) {
        // 復号の出力を共有の時間軸へ記録し、映像と同じ式で表示時刻を求める
        // (src/playout/timeline.ts)
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
        return { status: "dropped", rebased, reason: decision.reason, catchUpStarted };
      }
      // 鳴らすと決めたが、鳴らし始める前に失敗したら数える (catch 句)
      planned = { arrivalMs, targetMs, durationMs: durationSeconds };
      // 鳴り始める時刻 (performance 軸)。時計の対応がまだ無いときは、予約に使った
      // (performance.now(), currentTime) の組で換算する (`AudioClockBridge` の代用と
      // 同じ求め方)
      const startMs =
        this.clock.toPerformanceMs(decision.startAt) ??
        arrivalMs + (decision.startAt - contextNowSeconds) * 1_000;

      // 時間圧縮・補間・フェードを行い、実際に鳴らすバッファを予約する
      const playedSeconds = this.playSound(
        output,
        decision,
        data,
        numberOfChannels,
        sampleRate,
        numberOfFrames,
      );
      played = true;
      // 鳴らすと決めた音を記録する。長さは詰めた後 (実際に鳴る長さ) である
      this.timing.recordPlay(arrivalMs, targetMs, startMs, playedSeconds * 1_000, decision.basis);
      // 実際に鳴った結果 (予定をどれだけ過ぎたか) を、目標を決める閉ループへ渡す
      this.observeDelayFeedback(performance.now(), request.timeline);

      // 実際に鳴らす時刻を実績として記録する (同期ずれの推定に使う)。捨てた音は鳴らない
      // ため記録しない。目標の表示時刻を決められなかった音 (基準を共有できず到着基準で
      // 並べた音) も記録しない。同期ずれの推定は共有している間のずれを読むための値で
      // あり、制御されていない再生を混ぜると意味が変わる。映像側も、表示時刻を決めて
      // いないフレームの実績を作らない (src/playout/videoPlayoutSession.ts)。第 3 引数は Unix
      // epoch マイクロ秒
      if (targetMs !== null && wallClockTimestamp !== null) {
        const presentedMs = this.clock.toPerformanceMs(decision.startAt);
        if (presentedMs !== null) {
          request.timeline.recordPresentation(
            "audio",
            wallClockTimestamp,
            BigInt(Math.round((performance.timeOrigin + presentedMs) * 1_000)),
          );
        }
      }
      return { status: "played", rebased, catchUpStarted };
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
        catchUpStarted,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * 時間圧縮・補間・フェードを行い、実際に鳴らすバッファを予約する
   *
   * 補間で埋める隙間は、補間の末尾を 2 ms で 0 へ落とし、直後の音声の先頭を 2 ms で
   * フェードインする。予約時点で既に過去の無音がある場合は、補間の先頭もフェードインする。
   * 穴が無い通常の境界にはフェードを入れない (20 ms 周期の振幅変調になるため)。
   * 実際に無音で出る穴、予約の追い越し、バッファ境界の段差は計器へ記録する
   *
   * @param output - 鳴らす先
   * @param decision - 鳴らすと決めた時刻と隙間の情報
   * @param data - 復号した音 (サンプルの取り出し元)
   * @param numberOfChannels - チャンネル数
   * @param sampleRate - サンプルレート (Hz)
   * @param numberOfFrames - 復号した音のサンプル数
   * @returns 実際に鳴らす長さ (秒。詰めた分を引いた後)
   */
  private playSound(
    output: AudioPlayoutOutput,
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    data: AudioData,
    numberOfChannels: number,
    sampleRate: number,
    numberOfFrames: number,
  ): number {
    // 目標を過ぎて届いた分は、波形の周期を使って詰める (NetEq の accelerate)。遅れて
    // 届いた音を捨てると音が途切れるため、鳴らす時刻をずらした分だけ詰めて目標へ戻す
    const channels: AudioSamples[] = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames);
      data.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
      channels.push(channelData);
    }
    // 詰めてよい長さは、目標に対して遅れている分までにする (削りすぎて「早すぎる」側へ
    // 振れ、詰める操作が往復するのを防ぐ。src/playout/audioTimeStretch.ts の compressSamples)
    const stretched =
      decision.compressSeconds > 0
        ? compressSamples(channels, sampleRate, Math.round(decision.compressSeconds * sampleRate))
        : { channels, lengthChangeSamples: 0 };
    // 実際に詰められた長さを返す (詰められなかった分は遅れとして残る)
    this.playout.confirmStretch(-stretched.lengthChangeSamples / sampleRate);

    // 欠落した区間を、直前に鳴らした音の末尾を伸ばして埋める (src/playout/audioTimeStretch.ts)。
    // 実際に補間した長さだけを統計へ返す
    let concealedSeconds = 0;
    let concealedScheduled = false;
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
        // 補間の末尾は必ず 2 ms で 0 へ落とす。そのまま鳴らすと、繰り返しの位相が
        // 次の音と揃わないときに段差になるためである。長さの違う音との継ぎ目を
        // フェードで繋ぐ既存の処理と同じものを使う
        let concealedChannels = fadeSpliceEdge(concealed.channels, this.previousSampleRate, "tail");
        // 補間の先頭が前の音の末尾と接していない (予約時点で既に過去の無音がある) ときは、
        // 無音から補間音へ立ち上がる段差を消すため先頭もフェードインする。前の音と
        // 連続しているときはフェードしない (波形の続きをそのまま鳴らす)
        const startsAfterSilence = decision.unrecoverableGapSeconds > 0;
        if (startsAfterSilence) {
          concealedChannels = fadeSpliceEdge(concealedChannels, this.previousSampleRate, "head");
        }
        // 直前のバッファの末尾と補間の先頭の段差。無音を挟むときは無音へ落ちる分だけが
        // 段差として残る
        if (this.lastScheduledTailSample !== null) {
          const step = startsAfterSilence
            ? Math.abs(this.lastScheduledTailSample)
            : Math.abs((concealedChannels[0]?.[0] ?? 0) - this.lastScheduledTailSample);
          this.timing.recordBoundaryStep(step);
        }
        this.startBuffer(
          output,
          concealedChannels.length,
          concealedChannels,
          concealedFrames,
          this.previousSampleRate,
          decision.gapStartSeconds,
        );
        concealedSeconds = concealed.generatedSamples / this.previousSampleRate;
        concealedScheduled = true;
        this.lastScheduledTailSample = concealedChannels[0]?.[concealedFrames - 1] ?? 0;
      }
    }
    this.playout.confirmConcealment(concealedSeconds);

    // 予約できた隙間のうち補間で埋まらなかった分 (予約できなかったアンダーラン、補間の
    // 失敗、補間の上限を超えた分) を、実際に無音で出る穴として数える
    const totalGapMs = decision.totalGapSeconds * 1_000;
    if (totalGapMs > 0) {
      const concealedMs = concealedSeconds * 1_000;
      // 補間の生成長は秒へ丸めるため 1 サンプル未満の差が出る。1 µs 未満は数えない
      const silentMs = Math.max(0, totalGapMs - concealedMs);
      if (silentMs >= 0.001) {
        this.timing.recordGap({
          silentMs,
          unrecoverableMs: decision.unrecoverableGapSeconds * 1_000,
        });
      }
    }

    // 穴を挟む境界は、次の音の先頭を 2 ms フェードインして、無音から鳴り始める段差を
    // 消す。穴が無い通常の境界には入れない (20 ms 周期の振幅変調になるため)
    const hasGap = decision.totalGapSeconds > 0;
    const playChannels = hasGap
      ? fadeSpliceEdge(stretched.channels, sampleRate, "head")
      : stretched.channels;
    const frames = playChannels[0]?.length ?? numberOfFrames;
    // 実音の先頭と、直前に予約したバッファの末尾の段差を測る。補間を挟んだ境界は
    // 両側とも 0 にフェードしてあるため段差は 0 になる。穴を挟むときは無音へ落ちる
    // 直前の振幅が残る
    if (this.lastScheduledTailSample !== null) {
      const head = playChannels[0]?.[0] ?? 0;
      let step: number;
      if (concealedScheduled) {
        step = Math.abs(head - this.lastScheduledTailSample);
      } else if (hasGap) {
        step = Math.max(Math.abs(this.lastScheduledTailSample), Math.abs(head));
      } else {
        step = Math.abs(head - this.lastScheduledTailSample);
      }
      this.timing.recordBoundaryStep(step);
    }
    this.startBuffer(output, numberOfChannels, playChannels, frames, sampleRate, decision.startAt);
    this.lastScheduledTailSample = playChannels[0]?.[frames - 1] ?? 0;
    // 次の音の補間のために、実際に鳴らしたサンプル (フェードする前の生のサンプル) を
    // 保持する。補間は末尾の周期を繰り返すため、先頭のフェードは影響しない
    this.previousChannels = stretched.channels;
    this.previousSampleRate = sampleRate;
    return (playChannels[0]?.length ?? numberOfFrames) / sampleRate;
  }

  /**
   * 予約の基準と時計の対応と直前の音を消す (AudioContext を作り直したとき)
   *
   * 予約の基準は `AudioContext.currentTime` の秒であり、作り直した `AudioContext` では
   * 0 から始まる。古い基準を使い続けると目標の時刻がずれる (`AudioClockBridge.reset` の
   * JSDoc を参照)。予約の統計の累積 (基準を取り直した回数、捨てた音、詰めた合計、補間した
   * 合計) は消さない (購読をやり直しても引き継ぐ)。受信側の追いつきの観測と累積
   * (`AudioReceiveCatchUp.reset`) は消す。再生そのものをやり直すためであり、遅れの床も
   * 作り直した `AudioContext` では意味を持たない
   */
  reset(): void {
    this.playout.reset();
    this.catchUp.reset();
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
   * 目標へ戻すために詰めた (時間圧縮した) 音の合計 (秒)
   *
   * 詰める操作は波形の周期を 1 つ削って繋ぐため、続けて起きると音が粗くなる。ノイズの
   * 切り分けのため、量を読めるようにする (減らした分は遅れとして残さず、目標へ寄せる)
   */
  get compressedSeconds(): number {
    return this.playout.compressed;
  }

  /**
   * 欠落した区間を、直前の音の末尾を繰り返して補間した合計 (秒)
   *
   * 補間は繰り返しの継ぎ目が耳につくため、量を読めるようにする。隙間の長さには上限があり
   * (src/playout/audioPlayout.ts の AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS)、超えた分は無音のまま残る
   */
  get concealedSeconds(): number {
    return this.playout.concealed;
  }

  /** 補間した回数 (同じ長さの補間でも、回数が多いほど継ぎ目が増える) */
  get concealments(): number {
    return this.playout.concealments;
  }

  /**
   * 予約した音のうち、まだ鳴っていない分を鳴らなかった音として数える
   *
   * `AudioContext` を閉じると、予約した音は鳴らないまま切り捨てられる。この分はどの統計にも
   * 現れないため、閉じる直前に呼ぶ。既に鳴り始めている音は、残りの長さだけを数える
   * (`AudioPlayoutTimingStats.recordStopped` を参照)。
   */
  recordStopped(): void {
    this.timing.recordStopped(performance.now());
  }

  /**
   * 鳴らした結果 (予定をどれだけ過ぎたか、並べすぎで捨てた量) を閉ループへ渡す
   *
   * 目標を動かすのは毎秒 1 回までであり、呼ぶ側は間隔を気にしない
   * (`src/playout/audioDelayFeedback.ts`)。実測 (2026-10-14、実リレー経由の 60 秒) では、
   * 渡さないと目標が実際の到着に合わず、遅れが数 ms 残って時間圧縮が 58 秒で 1691 ms
   * 動き続けた (声が粗くなる) ため、常に渡す
   */
  private observeDelayFeedback(atMs: number, timeline: PlayoutTimeline): void {
    const feedback = this.timing.audioDelayFeedback(atMs);
    // 圧縮 (時間圧縮、粗さ) の増分を閉ループへ渡す。閉ループは「圧縮か無音の穴が続く
    // ときだけ目標の上限を 160 ms へ広げる」判断に使う
    // (`src/playout/audioDelayFeedback.ts`)。累積ではなく増分を渡すのは、購読のやり直しで
    // 累積が 0 に戻っても負の差を作らないためである。穴の累積は `feedback` に含まれる
    // (`AudioPlayoutTimingStats.audioDelayFeedback`)
    const compressedMs = this.playout.compressed * 1_000;
    const compressionMs = Math.max(0, compressedMs - this.lastCompressedMs);
    this.lastCompressedMs = compressedMs;
    // 不感帯の中の遅れは playout が意図して残す分である (`AUDIO_PLAYOUT_STRETCH_MIN_SECONDS`)。
    // これを学習へ渡すと、playout は詰めないのに目標だけが上がり続け、遅延が伸びる
    // (実測: 20 ms の不感帯で 60 秒後に目標 289 ms、遅延 296 ms まで上がった)。不感帯を
    // 引いた分だけを遅れとして渡す
    const deadbandMs = AUDIO_PLAYOUT_STRETCH_MIN_SECONDS * 1_000;
    timeline.observeAudioPlayout({
      ...feedback,
      compressionMs,
      // 見るのは p50 (遅れの代表値) だけである。p95 と max は揺らぎの裾であり、
      // 不感帯を引くと「たまに大きく遅れた」事実まで消えてしまう
      latenessMs:
        feedback.latenessMs === null
          ? null
          : { ...feedback.latenessMs, p50: Math.max(0, feedback.latenessMs.p50 - deadbandMs) },
    });
  }

  /** 時計の対応と直前の音を消す (AudioContext を作り直した / 閉じたとき) */
  private forgetAudioContext(): void {
    this.clock.reset();
    this.previousChannels = null;
    this.previousSampleRate = 0;
    // 予約済みのバッファは AudioContext と一緒に捨てられるため、境界の段差の基準も消す
    this.lastScheduledTailSample = null;
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
    // 予約した時刻を currentTime が追い越していたら、Web Audio は即時開始にして直前の音と
    // 重なり得る。押し直しは行わず、計器に残して気付けるようにする
    const nowSeconds = output.context.currentTime;
    if (whenSeconds < nowSeconds) {
      this.timing.recordLateStart((nowSeconds - whenSeconds) * 1_000);
    }
    source.start(whenSeconds);
  }
}
