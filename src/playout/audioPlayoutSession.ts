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
 * 出力時計の観測・計器の修正を 2 か所へ入れる必要があり、片方だけを直すと挙動がずれる。
 * 組み立てはここ 1 か所に置き、両方がこれを使う。
 *
 * ブラウザ依存 (Web Audio の `AudioContext` とその時計) は `AudioPlayoutOutput` として
 * 注入する。`AudioContext` の時計と `performance.now()` の対応は既存の `AudioClockBridge` を
 * 境界に使う。予約の計算は実クラスの単体テストで、出力との結合は実ブラウザで検証する。
 * 呼び出し側が devtools 固有の判断 (relay の cache から追いつく途中の音を
 * 鳴らさない、音声だけを購読している、再生の有効・無効、UI への反映) を持つ。
 *
 * 内部実装である (src/index.ts からは公開していない)。公開 API は再生の入口
 * (`MediaPlayout`) である。docs/HIGH_LEVEL_API.md の「内部実装」の「音声の再生の組み立て」を
 * 参照。
 */

import type { PlayoutTimestampKind } from "./decodeInputTimestamps";
import {
  AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_STRETCH_MIN_SECONDS,
  AudioClockBridge,
  AudioPlayoutScheduler,
  arrivalPlayoutDelaySeconds,
  type AudioPlayoutDecision,
  concealmentEndGain,
} from "./audioPlayout";
import {
  AUDIO_SPLICE_FADE_MS,
  crossFadeHead,
  smoothSpliceHead,
  fadeSpliceEdge,
  interpolateSpliceGap,
} from "../audioSpliceFade";
import { isTimeStretchAvailable } from "./audioTimeStretch";
import type {
  AudioPlayoutTimingStats,
  MediaPlayoutDrainOptions,
  MediaPlayoutDrainStats,
} from "./audioPlayoutTimingStats";
import { AudioReceiveCatchUp } from "./audioReceiveCatchUp";
import { compressSamples, concealSamples, type AudioSamples } from "./audioTimeStretch";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, type PlayoutTimeline } from "./timeline";

/**
 * Web Audio のうち、音声の再生で使う部分
 *
 * `AudioContext` の実物をそのまま渡せる (必要なメソッドだけを持つ構造の型である)。
 * 出力を使うテストでも実際の AudioContext を渡す。
 */
export interface AudioPlayoutContext {
  /** `AudioContext.currentTime` (秒)。予約の基準であり、時計の対応を作るのにも使う */
  readonly currentTime: number;
  /**
   * `AudioContext` のサンプルレート (Hz)
   *
   * 復号フレーム (`AudioData`) のレートと違うときは、`AudioBufferSourceNode` が
   * バッファごとにリサンプルする。境界の重なりは一定値の OfflineAudioContext で
   * 再現したが、実出力のクリックは波形でも確認する必要がある。
   * `recordSampleRate` へ渡し、レートの食い違いを数えられるようにする。
   */
  readonly sampleRate: number;
  /**
   * `AudioContext.getOutputTimestamp()`
   *
   * まだ音を出していない / 再開直後で performanceTime が 0 のときは対応を作らない
   * (内部の `AudioClockBridge` が判定する)
   */
  getOutputTimestamp(): AudioTimestamp;
  /** `AudioContext.createBuffer`。鳴らす音と、欠落した区間の補間の両方に使う */
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  /** `AudioContext.createBufferSource` */
  createBufferSource(): AudioBufferSourceNode;
  /** 途絶に備えた末尾フェードを予約し、後続が届いたら取り消すための実 GainNode */
  createGain(): GainNode;
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

/** 停止時に予約済みの音を鳴らし切るとき、最後の予約の終わりに足す余裕 (ミリ秒) */
export const AUDIO_PLAYOUT_DRAIN_MARGIN_MS = 100;

/** 通常の停止 (購読の stop) で drain を待つ上限 (ミリ秒) */
export const AUDIO_PLAYOUT_DRAIN_MAX_MS = 300;

/**
 * 終端の停止 (close / ピア起点の close) で drain を待つ上限 (ミリ秒)
 *
 * 終端は利用者やピアが再生を終える操作であり、エラー後の後始末でも通る。通常の停止より
 * 短くして、後始末が長くブロックしないようにする。この時間で鳴らし切れなかった分だけが
 * `missedByReason.stopped` に残る
 */
export const AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS = 150;

/** drain の待ち合わせで残りの予約を確認する間隔 (ミリ秒) */
export const AUDIO_PLAYOUT_DRAIN_POLL_MS = 25;

/**
 * drain の待ちを終えたとみなす許容誤差 (ミリ秒)
 *
 * 実時計 (`performance.now()`) の大きな値へポーリング間隔を足すと、浮動小数点の
 * 丸めで残り時間が 0 よりごくわずかに大きいまま時計が進まなくなる (例: 上限 300 ms
 * に対して 299.99999999999994 ms)。そのままでは待ちループが終わらず、ワーカーが
 * 止まる。この誤差以内なら待ち終えたものとして扱う
 */
const AUDIO_PLAYOUT_DRAIN_WAIT_EPSILON_MS = 1e-6;

/** 指定した時間だけ待つ (drain の待ち合わせで使う) */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  readonly timestampKind: PlayoutTimestampKind;
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
  // 直前に再生した媒体の終端。未到着の媒体と、到着の遅れによる穴を区別する。
  private previousMediaEndTimestampMicros: number | null = null;
  // 直前に予約したバッファ (補間を含む) の末尾のサンプル。境界の段差を測るために保持する。
  // 実音へ届く補間は波形を接続し、無音へ移る末尾は GainNode で 0 へ落とす。
  private lastScheduledTailSample: number | null = null;
  // 最後の予約の末尾は、後続が届かない場合だけ 0 へ落とす。連続する音では予約を取り消す。
  private lastScheduledEnvelope: {
    gain: GainNode;
    tailStartSeconds: number;
    endSeconds: number;
  } | null = null;
  // 音声のみは固定の深さを使う。共有の推定値と実際の適用値を計器で混同しない。
  private targetDelayValueMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS;

  get targetDelayMs(): number {
    return this.targetDelayValueMs;
  }

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
      // close 済みの AudioData は各寸法が 0 になる。0 / 0 の長さを予約へ渡すと
      // 終端と計器が NaN になり、後続の正常な音も再生できなくなる。時間軸・予約の
      // 副作用より前に拒否し、長さが不明な失敗として件数だけを記録する。
      if (!(numberOfChannels > 0 && sampleRate > 0 && numberOfFrames > 0)) {
        planned = { arrivalMs: performance.now(), targetMs: null, durationMs: 0 };
        throw new Error("AudioData must be open and contain audio frames");
      }
      // AudioContext と復号フレームのレートが違うと、AudioBufferSourceNode がバッファごとに
      // リサンプルし、20 ms の境界ごとに 1 サンプルの重なり (毎秒 50 回の +6 dB スパイク) が
      // 生まれる (docs/AUDIO_GLITCH_CAUSES.md の A1)。鳴らす前の 2 つのレートを計器へ残す。
      // AudioContext がレートを持たない (実物には必ずあるが、境界の型を満たすだけの
      // オブジェクトを渡された) ときは記録しない
      if (Number.isFinite(context.sampleRate) && context.sampleRate > 0) {
        this.timing.recordSampleRate(context.sampleRate, sampleRate);
      }
      const durationSeconds = numberOfFrames / sampleRate;
      // 時間圧縮と補間を使えないサンプルレートでは、遅れが目標へ
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

      this.updateOutputClock(context, request.timeline, arrivalMs);
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
      // 音声だけの購読では、共有の推定値によって常時の待ちを増やさず、
      // 到着基準の深さを音声だけの予算内へ収める。
      const arrivalDelaySeconds = request.enforceTarget
        ? arrivalPlayoutDelaySeconds(playoutDelaySeconds)
        : AUDIO_PLAYOUT_DELAY_SECONDS;
      this.targetDelayValueMs =
        (targetStartSeconds !== null && request.enforceTarget
          ? playoutDelaySeconds
          : arrivalDelaySeconds) * 1000;
      const decision = this.playout.schedule(contextNowSeconds, data.timestamp, durationSeconds, {
        targetStartSeconds,
        stretchMinSeconds: request.timeline.compressionDeadbandSeconds(
          AUDIO_PLAYOUT_STRETCH_MIN_SECONDS,
        ),
        // 到着した音がまだ鳴っていない位置。到着基準の遅れはここから数える
        arrivalSeconds,
        // 揃える相手がいて、目標の開始時刻を決められたときだけ目標を守る。決められなかった
        // ときは到着基準になり、`enforceTarget` の値によらず結果は同じである
        enforceTarget: request.enforceTarget && targetStartSeconds !== null,
        delaySeconds: playoutDelaySeconds,
        // 目標を使えないとき (到着基準) の再生の遅れ。共有の時間軸が学習した値は、
        // TIMESTAMP が壁時計からずれているトラックではそのずれの分だけ大きく育つため、
        // 上限で切った小さな値を使う。音声だけの購読は固定の 50 ms にする
        arrivalDelaySeconds,
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
        return { status: "dropped", rebased, reason: decision.reason, catchUpStarted };
      }
      // 鳴らすと決めたが、鳴らし始める前に失敗したら数える (catch 句)
      planned = { arrivalMs, targetMs, durationMs: durationSeconds };
      // 時間圧縮・補間・フェードを行い、実際に鳴らすバッファを予約する
      const playResult = this.playSound(
        output,
        decision,
        data,
        numberOfChannels,
        sampleRate,
        numberOfFrames,
      );
      played = true;
      // 鳴り始める時刻 (performance 軸)。開始を押し直したときは押し直した後の時刻を使う。
      // 時計の対応がまだ無いときは、予約に使った (performance.now(), currentTime) の組で
      // 換算する (`AudioClockBridge` の代用と同じ求め方)
      const startMs =
        this.clock.toPerformanceMs(playResult.startAtSeconds) ??
        arrivalMs + (playResult.startAtSeconds - contextNowSeconds) * 1_000;
      // 鳴らすと決めた音を記録する。長さは詰めた後 (実際に鳴る長さ) である
      this.timing.recordPlay(
        arrivalMs,
        targetMs,
        startMs,
        playResult.playedSeconds * 1_000,
        decision.basis,
      );
      // 実際に鳴らす時刻を実績として記録する (同期ずれの推定に使う)。捨てた音は鳴らない
      // ため記録しない。目標の表示時刻を決められなかった音 (基準を共有できず到着基準で
      // 並べた音) も記録しない。同期ずれの推定は共有している間のずれを読むための値で
      // あり、制御されていない再生を混ぜると意味が変わる。映像側も、表示時刻を決めて
      // いないフレームの実績を作らない (src/playout/videoPlayoutSession.ts)。第 3 引数は Unix
      // epoch マイクロ秒
      if (targetMs !== null && wallClockTimestamp !== null) {
        const presentedMs = this.clock.toPerformanceMs(playResult.startAtSeconds);
        if (presentedMs !== null) {
          request.timeline.recordPresentation(
            "audio",
            wallClockTimestamp,
            BigInt(Math.round((performance.timeOrigin + presentedMs) * 1_000)),
            // 出力の時計で換算できた場合だけ、予約時点の予定に対する残差を同期へ渡す。
            // currentTime での代用は出力遅延を含まないため補正の根拠にしない
            this.clock.usingFallback
              ? undefined
              : BigInt(Math.round((performance.timeOrigin + targetMs) * 1_000)),
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

  /** 出力の実時計を予約の軸へ対応付け、有効な観測だけを再生予算へ渡す。 */
  private updateOutputClock(
    context: AudioPlayoutContext,
    timeline: PlayoutTimeline,
    arrivalMs: number,
  ): void {
    // AudioContext の時計と performance.now() の対応を取り直す。まだ描画が始まって
    // いない (currentTime が 0 で getOutputTimestamp も 0) ときは対応を作らない
    const mapping = context.getOutputTimestamp();
    const contextTime = mapping.contextTime ?? 0;
    const performanceTime = mapping.performanceTime ?? 0;
    // 再開直後の Chromium は contextTime だけ非ゼロ、performanceTime は 0 の組を
    // 返すことがある。これは出力時刻の対応ではなく、採用すると予約がページの経過時間分
    // だけ未来へ飛ぶ。有効な performance 軸の観測が届くまでは currentTime で代用する。
    const hasMapping =
      Number.isFinite(contextTime) &&
      contextTime >= 0 &&
      Number.isFinite(performanceTime) &&
      performanceTime > 0;
    if (hasMapping || context.currentTime > 0) {
      // 出力の対応が無い間は現在の 2 時計をそのまま使う。同じ Context の停止中も
      // performance は進むため、古い offset から徐々に戻すと再開直後の予約が未来へ
      // 飛んで backlog になる。代用値は出力遅延の推定ではなく、平滑化して引き継がない。
      if (!hasMapping) this.clock.reset();
      this.clock.update(
        hasMapping ? { contextTime, performanceTime } : null,
        context.currentTime,
        arrivalMs,
      );
    }
    if (hasMapping) {
      const arrivalSeconds = this.clock.toAudioSeconds(arrivalMs) ?? context.currentTime;
      timeline.observeAudioOutputLead(
        (context.currentTime + AUDIO_PLAYOUT_MIN_LEAD_SECONDS - arrivalSeconds) * 1000,
        performance.timeOrigin + arrivalMs,
      );
    }
  }

  /**
   * 時間圧縮・補間・フェードを行い、実際に鳴らすバッファを予約する
   *
   * 補間で埋める隙間は、補間の末尾を 2 ms で 0 へ落とし、直後の音声の先頭を 2 ms で
   * フェードインする。予約できる最も早い時刻より前に無音がある場合は、補間の先頭も
   * フェードインする。
   * 穴が無い通常の境界にはフェードを入れない (20 ms 周期の振幅変調になるため)。
   * 実際に無音で出る穴、予約の追い越し、バッファ境界の段差は計器へ記録する
   *
   * @param output - 鳴らす先
   * @param decision - 鳴らすと決めた時刻と隙間の情報
   * @param data - 復号した音 (サンプルの取り出し元)
   * @param numberOfChannels - チャンネル数
   * @param sampleRate - サンプルレート (Hz)
   * @param numberOfFrames - 復号した音のサンプル数
   * @returns 実際に鳴らす長さ (秒。詰めた分を引いた後) と、実際に鳴り始める時刻 (秒)
   */
  private playSound(
    output: AudioPlayoutOutput,
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    data: AudioData,
    numberOfChannels: number,
    sampleRate: number,
    numberOfFrames: number,
  ): { playedSeconds: number; startAtSeconds: number } {
    const mediaGapMicros =
      this.previousMediaEndTimestampMicros === null
        ? 0
        : data.timestamp - this.previousMediaEndTimestampMicros;
    // AAC などの整数マイクロ秒への丸めは欠落に数えない。
    const missingMediaMs = mediaGapMicros > 1 ? mediaGapMicros / 1000 : 0;
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
    // 補間バッファの終わりの時刻 (秒)。押し直しで後ろへずれた場合に、実音をその後に置く
    let concealmentEndSeconds: number | null = null;
    // 補間の続きを実音の先頭へ混ぜる。短い穴でも両側を 0 にして音量を周期変調しない。
    let continuation: AudioSamples[] | null = null;
    if (decision.gapSeconds > 0 && this.previousChannels !== null) {
      // 長い補間ほど末尾の振幅を下げる (繰り返しの音を目立たなくする)
      const endGain = concealmentEndGain(decision.gapSeconds);
      const canMerge =
        this.previousSampleRate === sampleRate && this.previousChannels.length === numberOfChannels;
      const mergeSeconds = canMerge ? AUDIO_SPLICE_FADE_MS / 1000 : 0;
      let concealed = concealSamples(
        this.previousChannels,
        this.previousSampleRate,
        decision.gapSeconds + mergeSeconds,
        endGain,
      );
      if (
        concealed.generatedSamples === 0 &&
        canMerge &&
        decision.gapSeconds <= AUDIO_SPLICE_FADE_MS / 1000
      ) {
        // 子音のように周期がない場合も、既存のフェード幅以内の短い目標移動で
        // 無音と両側フェードを繰り返さない。既に届いている両端を直接繋ぐ。
        const gapFrames = Math.round(decision.gapSeconds * sampleRate);
        const interpolated = interpolateSpliceGap(
          this.previousChannels,
          stretched.channels,
          gapFrames,
        );
        concealed = {
          generatedSamples: gapFrames,
          channels: interpolated.map((channel, index) => {
            const head = stretched.channels[index] ?? new Float32Array(0);
            const merged = new Float32Array(gapFrames + head.length);
            merged.set(channel);
            merged.set(head, gapFrames);
            return merged;
          }),
        };
      }
      const concealedFrames = Math.min(
        concealed.channels[0]?.length ?? 0,
        Math.round(decision.gapSeconds * this.previousSampleRate),
      );
      if (concealedFrames > 0) {
        // 周期推定が許容した接続でも、直前の自然な変化幅を超える段差だけは抑える。
        // 実際の無音を挟む場合は、後段の 0 からの立ち上がりを使う。
        if (decision.unrecoverableGapSeconds === 0) {
          concealed = {
            ...concealed,
            channels: smoothSpliceHead(
              this.previousChannels,
              concealed.channels,
              this.previousSampleRate,
            ),
          };
        }
        // 実音と同じ形式なら、穴の先まで予測した末尾を実音の先頭へ混ぜる。
        // 形式が変わる場合は従来どおり無音へフェードして安全に接続する。
        let concealedChannels = concealed.channels.map((channel) =>
          channel.slice(0, concealedFrames),
        );
        if (canMerge) {
          continuation = concealed.channels.map((channel) => channel.slice(concealedFrames));
        } else {
          concealedChannels = fadeSpliceEdge(concealedChannels, this.previousSampleRate, "tail");
        }
        // 補間の先頭が前の音の末尾と接していない (予約できる最も早い時刻より前の無音が
        // ある) ときは、無音から補間音へ立ち上がる段差を消すため先頭もフェードインする。
        // 前の音と連続しているときはフェードしない (波形の続きをそのまま鳴らす)
        const startsAfterSilence = decision.unrecoverableGapSeconds > 0;
        if (startsAfterSilence) {
          concealedChannels = fadeSpliceEdge(concealedChannels, this.previousSampleRate, "head");
        }
        const concealedStart = this.startBuffer(
          output,
          concealedChannels.length,
          concealedChannels,
          concealedFrames,
          this.previousSampleRate,
          decision.gapStartSeconds,
        );
        const previousTail = this.lastScheduledTailSample;
        // 直前のバッファの末尾と補間の先頭の段差。無音を挟むときは無音へ落ちる分だけが
        // 段差として残る。押し直したときも、前の音の末尾はフェードできないため段差は
        // 残り得る (数える)
        if (previousTail !== null) {
          const step =
            startsAfterSilence || concealedStart.pushed
              ? Math.abs(previousTail)
              : Math.abs((concealedChannels[0]?.[0] ?? 0) - previousTail);
          this.timing.recordBoundaryStep(step);
        }
        concealedSeconds = concealedFrames / this.previousSampleRate;
        concealedScheduled = true;
        concealmentEndSeconds =
          concealedStart.startAtSeconds + concealedFrames / this.previousSampleRate;
        this.lastScheduledTailSample = concealedChannels[0]?.[concealedFrames - 1] ?? 0;
      }
    }
    this.playout.confirmConcealment(concealedSeconds);

    // 予約できた隙間のうち補間で埋まらなかった分 (予約できる最も早い時刻より前の分、
    // 補間の失敗、補間の上限を超えた分) を、無音で出る穴として数える。補間の生成長は
    // 半サンプル以内で丸められる (src/playout/audioTimeStretch.ts の
    // concealSamples の Math.round) ため、その分は補間で埋まったものとして扱う
    this.recordUncoveredGap(decision, concealedSeconds, concealedScheduled);

    const join = this.joinAfterConcealment(decision.startAt, concealmentEndSeconds, sampleRate);
    // 補間の上限を超えて実音まで届かないときは、補間の続きを無音の後へ持ち込まない。
    if (!join.continuous) continuation = null;
    // 補間で連続する境界は予測から混ぜ、実際に無音を挟む境界だけ 0 から立ち上げる。
    const hasGap = decision.totalGapSeconds > 0;
    const playChannels = this.spliceRealAudio(
      stretched.channels,
      continuation,
      hasGap,
      missingMediaMs,
      sampleRate,
      numberOfFrames,
    );
    const frames = playChannels[0]?.length ?? numberOfFrames;
    const started = this.startBuffer(
      output,
      numberOfChannels,
      playChannels,
      frames,
      sampleRate,
      join.startAt,
    );
    // 補間の丸めで開始をわずかに早めた分も含め、次の予約を実際の終わりへ繋ぐ。
    this.playout.confirmPlayoutEnd(started.startAtSeconds + frames / sampleRate);
    // クロスフェード後のサンプル列の境界を測る。無音を挟んだ場合の末尾フェードは
    // startBuffer が lastScheduledTailSample へ反映する。
    if (this.lastScheduledTailSample !== null) {
      const head = playChannels[0]?.[0] ?? 0;
      // 押し直した音は無音からフェードインするため、実際に鳴る段差は前の音の末尾が
      // 無音へ落ちる分である (今回の先頭は 0 から立ち上がる)
      const step = started.pushed
        ? Math.abs(this.lastScheduledTailSample)
        : Math.abs(head - this.lastScheduledTailSample);
      this.timing.recordBoundaryStep(step);
    }
    this.lastScheduledTailSample = playChannels[0]?.[frames - 1] ?? 0;
    // 圧縮で解析窓を縮めない。圧縮は中央を削り、末尾の生の波形はそのまま残すため、
    // 圧縮前のフレームで末尾の周期を推定できる。次の欠落時に必要な長さを保持する。
    this.previousChannels = channels;
    this.previousSampleRate = sampleRate;
    this.previousMediaEndTimestampMicros = data.timestamp + (numberOfFrames / sampleRate) * 1000000;
    return {
      playedSeconds: (playChannels[0]?.length ?? numberOfFrames) / sampleRate,
      startAtSeconds: started.startAtSeconds,
    };
  }

  /** 予約上の隙間と、遅れたキューに吸収された媒体の欠落の両方を接続する。 */
  private spliceRealAudio(
    channels: AudioSamples[],
    continuation: AudioSamples[] | null,
    hasGap: boolean,
    missingMediaMs: number,
    sampleRate: number,
    rawFrames: number,
  ): AudioSamples[] {
    if (continuation !== null) return crossFadeHead(continuation, channels, sampleRate);
    if (hasGap) return fadeSpliceEdge(channels, sampleRate, "head");
    if (
      missingMediaMs >= (500 * rawFrames) / sampleRate &&
      this.previousChannels !== null &&
      this.previousSampleRate === sampleRate
    ) {
      // キューが遅れていると欠落分を詰めて再生できるが、元の波形は非連続である。
      // 無音を増やさず、直前の自然な変化幅を超えた先頭だけを滑らかにする。
      // 半フレーム未満の小さな時計補正では、元の音の立ち上がりを加工しない。
      return smoothSpliceHead(this.previousChannels, channels, sampleRate);
    }
    return channels;
  }

  /** 補間のサンプル丸めの後にも、1 サンプルの無音を残さず実音へ繋ぐ。 */
  private joinAfterConcealment(
    startAt: number,
    concealmentEnd: number | null,
    sampleRate: number,
  ): { startAt: number; continuous: boolean } {
    if (concealmentEnd !== null && concealmentEnd >= startAt - 0.5 / sampleRate) {
      return { startAt: concealmentEnd, continuous: true };
    }
    return { startAt, continuous: false };
  }

  /** 表示用の欠落と、待ちを増やせば防げる欠落を分けて記録する。 */
  private recordUncoveredGap(
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    concealedSeconds: number,
    concealedScheduled: boolean,
  ): void {
    const totalGapMs = decision.totalGapSeconds * 1000;
    if (totalGapMs <= 0) return;
    const roundToleranceMs =
      concealedScheduled && this.previousSampleRate > 0 ? 500 / this.previousSampleRate : 0;
    const uncoveredMs = Math.max(0, totalGapMs - concealedSeconds * 1000);
    if (uncoveredMs <= roundToleranceMs) return;
    this.timing.recordGap({
      uncoveredMs,
      unrecoverableMs: decision.unrecoverableGapSeconds * 1000,
    });
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
   * 予約済みの音を鳴らし切ってから止める (停止時の drain)
   *
   * 停止の要求時点で予約されている音の最後が鳴り終わるまで待ち、そのあとに
   * `recordStopped` で切った量を計器へ残す。待ち時間は「最後の予約の終わり - 現在 +
   * 余裕」を上限 (`maxWaitMs`。既定は通常の停止の 300 ms) で切った値である。
   * `isFlushSettled` が false の間は、復号前の段から flush した Object の復号出力が
   * まだ届いていないため、予約が尽きていても終えない。
   *
   * 待って鳴らせた量と上限で切った量は、計器の `lastDrain` に残す。
   * `missedByReason.stopped` の意味 (切った量) は変えない。
   *
   * @param options - 待ちの上限と、flush した Object の復号出力を待つ条件
   * @returns 待った結果 (鳴らせた量と切った量)
   */
  async drainReserved(options: MediaPlayoutDrainOptions = {}): Promise<MediaPlayoutDrainStats> {
    const maxWaitMs = Math.max(0, options.maxWaitMs ?? AUDIO_PLAYOUT_DRAIN_MAX_MS);
    const flushedObjects = Math.max(0, options.flushedObjects ?? 0);
    // 注入されたコールバックは throw しない契約である。それでも drain を失敗させず、
    // 記録 (`lastDrain`) を残すため、throw は「待ち終えた / 残り 0」として扱う
    const isFlushSettled = (): boolean => {
      try {
        return options.isFlushSettled?.() ?? true;
      } catch {
        return true;
      }
    };
    const remainingFlushedObjects = (): number => {
      try {
        return options.remainingFlushedObjects?.() ?? 0;
      } catch {
        return 0;
      }
    };
    const startMs = performance.now();
    const pendingMsAtStart = this.timing.pendingMs(startMs);
    const pendingEndMs = this.timing.pendingEndMs(startMs);
    const playedMsAtStart = this.timing.snapshot(startMs).playedMs;
    // 最後の予約が鳴り終わるまでの時間に余裕を足す。flush した Object があるときは、
    // その復号出力の予約がこれから増えるため、余裕の分は必ず待つ (復号の速さに依存させない)
    let requestedMs = Math.max(
      0,
      (pendingEndMs === null ? 0 : pendingEndMs - startMs) + AUDIO_PLAYOUT_DRAIN_MARGIN_MS,
    );
    if (flushedObjects > 0 || !isFlushSettled()) {
      // flush した Object の復号は非同期に済む。予約が無くても復号の出力を待てるよう、
      // 上限まで待つ (復号が終われば isFlushSettled が true になり早く終わる)
      requestedMs = Math.max(requestedMs, maxWaitMs);
    }
    requestedMs = Math.min(maxWaitMs, requestedMs);

    for (;;) {
      const nowMs = performance.now();
      const elapsedMs = nowMs - startMs;
      const endMs = this.timing.pendingEndMs(nowMs);
      const reservedDone = endMs === null || endMs <= nowMs;
      if (reservedDone && isFlushSettled()) {
        break;
      }
      if (elapsedMs >= requestedMs - AUDIO_PLAYOUT_DRAIN_WAIT_EPSILON_MS) {
        break;
      }
      await sleep(Math.min(AUDIO_PLAYOUT_DRAIN_POLL_MS, requestedMs - elapsedMs));
    }

    const finishedMs = performance.now();
    // 待っても鳴り終わらなかった予約が、切った量である (`recordStopped` が数える)
    const cutMs = this.timing.pendingMs(finishedMs);
    // 鳴らせた量 = 停止時に予約されていた長さ + drain 中に増えた予約 - 切った長さ
    const reservedDuringDrainMs = Math.max(
      0,
      this.timing.snapshot(finishedMs).playedMs - playedMsAtStart,
    );
    const playedMs = Math.max(0, pendingMsAtStart + reservedDuringDrainMs - cutMs);
    this.timing.recordStopped(finishedMs);
    const result: MediaPlayoutDrainStats = {
      pendingMsAtStart,
      requestedMs,
      waitedMs: Math.max(0, finishedMs - startMs),
      playedMs,
      cutMs,
      flushedObjects,
      undecodedFlushedObjects: Math.max(0, remainingFlushedObjects()),
    };
    this.timing.recordDrain(result);
    return result;
  }

  /** 時計の対応と直前の音を消す (AudioContext を作り直した / 閉じたとき) */
  private forgetAudioContext(): void {
    this.targetDelayValueMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS;
    this.clock.reset();
    this.previousChannels = null;
    this.previousSampleRate = 0;
    this.previousMediaEndTimestampMicros = null;
    // 予約済みのバッファは AudioContext と一緒に捨てられるため、境界の段差の基準も消す
    this.lastScheduledTailSample = null;
    this.lastScheduledEnvelope = null;
  }

  /**
   * 先頭と、後続が途絶えた末尾だけを滑らかにする。先読みの遅延は追加しない。
   * 各バッファの末尾にフェードを仮予約し、後続を連続して予約できたら実行前に取り消す。
   * 通常のフレーム境界にはフェードを残さず、20 ms ごとの音量変調を作らない。
   */
  private connectWithEnvelope(
    output: AudioPlayoutOutput,
    source: AudioBufferSourceNode,
    startSeconds: number,
    durationSeconds: number,
    sampleRate: number,
  ): void {
    const previous = this.lastScheduledEnvelope;
    const contiguous =
      previous !== null && Math.abs(startSeconds - previous.endSeconds) <= 0.5 / sampleRate;
    const cancelled = contiguous && output.context.currentTime < previous.tailStartSeconds;
    if (cancelled) {
      previous.gain.gain.cancelScheduledValues(previous.tailStartSeconds);
      previous.gain.gain.setValueAtTime(1, previous.tailStartSeconds);
    } else if (previous !== null) {
      // 取り消せなかった末尾は実際に 0 へ落ちる。計器も生の末尾の値を使わない。
      this.lastScheduledTailSample = 0;
    }
    const gain = output.context.createGain();
    source.connect(gain);
    gain.connect(output.destination);
    const fadeSeconds = Math.min(AUDIO_SPLICE_FADE_MS / 1000, durationSeconds / 2);
    if (previous === null || (contiguous && !cancelled)) {
      // start の端数時刻で source が 1 サンプル早く出ても、既定の gain 1 を通さない。
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, startSeconds);
      gain.gain.linearRampToValueAtTime(1, startSeconds + fadeSeconds);
    }
    const endSeconds = startSeconds + durationSeconds;
    const tailStartSeconds = endSeconds - fadeSeconds;
    gain.gain.setValueAtTime(1, tailStartSeconds);
    gain.gain.linearRampToValueAtTime(0, endSeconds);
    this.lastScheduledEnvelope = { gain, tailStartSeconds, endSeconds };
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
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
   * @returns 実際に鳴らし始める時刻 (秒) と、押し直したか
   */
  private startBuffer(
    output: AudioPlayoutOutput,
    channelCount: number,
    channels: readonly AudioSamples[],
    frames: number,
    sampleRate: number,
    whenSeconds: number,
  ): { startAtSeconds: number; pushed: boolean } {
    const audioBuffer = output.context.createBuffer(channelCount, frames, sampleRate);
    const source = output.context.createBufferSource();
    source.buffer = audioBuffer;
    // まず素のサンプルをコピーする。押し直すと決まったときだけフェード版で上書きする
    for (let channel = 0; channel < channelCount; channel++) {
      audioBuffer.copyToChannel(channels[channel] ?? new Float32Array(frames), channel);
    }
    // コピーの直後に currentTime を取り直し、押し直しの要否を決める。予約した時刻が余裕
    // (`AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS`。レンダリング量子 128 フレーム = 48 kHz で
    // 約 2.7 ms を踏まえた 3 ms) より近いと、次の量子で即時開始になり、直前の音と
    // 重なり得るため、余裕の先へ押し直す
    const nowSeconds = output.context.currentTime;
    const earliestSeconds = nowSeconds + AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS;
    if (whenSeconds >= earliestSeconds) {
      // 大きなコピーを挟まず、出力の端の予約だけを済ませて開始する。
      this.connectWithEnvelope(output, source, whenSeconds, frames / sampleRate, sampleRate);
      source.start(whenSeconds);
      return { startAtSeconds: whenSeconds, pushed: false };
    }

    // 押し直すと決まった。押し直しで生じた無音から鳴り始める段差を消すため、先頭 2 ms を
    // フェードインする。このコピーは重いため、終わった後にもう一度 currentTime を取り直す。
    // 取り直した時点で押し直した時刻を再び追い越していれば、開始時刻だけを新しい
    // 「今 + 余裕」へ再調整する (バッファのコピーはやり直さない)
    const playChannels = fadeSpliceEdge(channels, sampleRate, "head");
    for (let channel = 0; channel < channelCount; channel++) {
      audioBuffer.copyToChannel(playChannels[channel] ?? new Float32Array(frames), channel);
    }
    const finalNowSeconds = output.context.currentTime;
    const finalEarliestSeconds = finalNowSeconds + AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS;
    // 再調整した後の開始時刻で start する。ここから start までに重い処理を挟まない
    const startAtSeconds = Math.max(earliestSeconds, finalEarliestSeconds);
    // 押し直しの計器は、再調整した後の最終的な値で 1 回だけ記録する (二重計上しない)。
    // 予約した時刻を currentTime が追い越していたら、追い越した長さも残す
    const lateMs = (finalNowSeconds - whenSeconds) * 1_000;
    if (lateMs > 0) {
      this.timing.recordLateStart(lateMs);
    }
    // 押し直した量 (余裕より近かっただけの場合も含む) を計器に残す
    this.timing.recordPushStart((startAtSeconds - whenSeconds) * 1_000);
    this.connectWithEnvelope(output, source, startAtSeconds, frames / sampleRate, sampleRate);
    source.start(startAtSeconds);
    return { startAtSeconds, pushed: true };
  }
}
