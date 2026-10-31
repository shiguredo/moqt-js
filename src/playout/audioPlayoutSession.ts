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
} from "./audioPlayout";
import { smoothSpliceHead } from "../audioSpliceFade";
import { isTimeStretchAvailable } from "./audioTimeStretch";
import type {
  AudioPlayoutTimingStats,
  MediaPlayoutDrainOptions,
  MediaPlayoutDrainStats,
} from "./audioPlayoutTimingStats";
import { AudioReceiveCatchUp } from "./audioReceiveCatchUp";
import { AudioOutputRenderer } from "./audioOutputRenderer";
import { compressSamples, type AudioSamples } from "./audioTimeStretch";
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
  /** `AudioContext.createBuffer`。実音の予約に使う */
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
  // 媒体の欠落が遅れたキューに吸収された場合も、非連続な波形だけを接続する。
  private previousMediaEndTimestampMicros: number | null = null;
  private renderer: AudioOutputRenderer | null = null;
  private lastRenderEndSeconds = 0;
  private draining = false;
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
    let planned: { arrivalMs: number; targetMs: number | null; durationSeconds: number } | null =
      null;
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
        planned = { arrivalMs: performance.now(), targetMs: null, durationSeconds: 0 };
        throw new Error("AudioData must be open and contain audio frames");
      }
      // レートが違うと AudioBufferSourceNode がバッファごとにリサンプルする。
      // 境界の重なりは OfflineAudioContext で再現したが、実出力のクリックとは区別する。
      // 鳴らす前の 2 つのレートを計器へ残し、波形を調べる条件を特定できるようにする。
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
      planned = { arrivalMs, targetMs: null, durationSeconds };
      this.getRenderer(output).assertReady();
      const channels = this.copyChannels(data);

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
        return { status: "dropped", rebased, reason: decision.reason, catchUpStarted };
      }
      // 鳴らすと決めたが、鳴らし始める前に失敗したら数える (catch 句)
      planned = { arrivalMs, targetMs, durationSeconds };
      // 時間圧縮・補間・フェードを行い、実際に鳴らすバッファを予約する
      const playResult = this.playSound(output, decision, data, channels);
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
          durationMs: planned.durationSeconds * 1_000,
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

  /** 予約を変更する前に PCM をコピーし、非有限値を出力側へ渡さない。 */
  private copyChannels(data: AudioData): AudioSamples[] {
    const { numberOfChannels, numberOfFrames } = data;
    const channels: AudioSamples[] = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames);
      data.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
      const invalid = channelData.findIndex((value) => !Number.isFinite(value));
      if (invalid !== -1)
        throw new Error(
          `Expected finite audio samples: channel=${channel}, sample=${invalid}, actual=${channelData[invalid]}`,
        );
      channels.push(channelData);
    }
    return channels;
  }

  /**
   * 検証済みの実音を時間圧縮し、Native Web Audio へ予約する。
   * 未着と復帰の接続は出力側が所有し、到着時に補間を作る別経路は持たない。
   * AudioData とコピーした PCM は同期処理中だけ参照し、元の AudioData は閉じない。
   */
  private playSound(
    output: AudioPlayoutOutput,
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    data: AudioData,
    channels: AudioSamples[],
  ): { playedSeconds: number; startAtSeconds: number } {
    const { numberOfChannels, sampleRate, numberOfFrames } = data;
    const mediaGapMicros =
      this.previousMediaEndTimestampMicros === null
        ? 0
        : data.timestamp - this.previousMediaEndTimestampMicros;
    // AAC などの整数マイクロ秒への丸めは欠落に数えない。
    const missingMediaMs = mediaGapMicros > 1 ? mediaGapMicros / 1000 : 0;
    // 目標を過ぎて届いた分は、波形の周期を使って詰める (NetEq の accelerate)。遅れて
    // 届いた音を捨てると音が途切れるため、鳴らす時刻をずらした分だけ詰めて目標へ戻す
    // 詰めてよい長さは、目標に対して遅れている分までにする (削りすぎて「早すぎる」側へ
    // 振れ、詰める操作が往復するのを防ぐ。src/playout/audioTimeStretch.ts の compressSamples)
    const stretched =
      decision.compressSeconds > 0
        ? compressSamples(channels, sampleRate, Math.round(decision.compressSeconds * sampleRate))
        : { channels, lengthChangeSamples: 0 };
    // 実際に詰められた長さを返す (詰められなかった分は遅れとして残る)
    this.playout.confirmStretch(-stretched.lengthChangeSamples / sampleRate);

    // 欠落は出力側が判断する。未着に備えた補間を毎フレーム作らず、実音の予約を先に済ませる。
    // 媒体が飛んでも予約に穴が無い場合は、その波形の非連続だけを短く接続する。
    const playChannels =
      decision.totalGapSeconds <= 1e-9 &&
      missingMediaMs >= (500 * numberOfFrames) / sampleRate &&
      this.previousChannels !== null &&
      this.previousChannels.length === channels.length &&
      this.previousSampleRate === sampleRate
        ? smoothSpliceHead(this.previousChannels, stretched.channels, sampleRate)
        : stretched.channels;
    const frames = playChannels[0]?.length ?? numberOfFrames;
    const started = this.startBuffer(
      output,
      numberOfChannels,
      playChannels,
      frames,
      sampleRate,
      decision.startAt,
    );
    this.playout.confirmPlayoutEnd(started.startAtSeconds + frames / sampleRate);
    this.previousChannels = channels;
    this.previousSampleRate = sampleRate;
    this.previousMediaEndTimestampMicros = data.timestamp + (numberOfFrames / sampleRate) * 1000000;
    return { playedSeconds: frames / sampleRate, startAtSeconds: started.startAtSeconds };
  }

  /** 最初の音から出力側の補間を使うため、非同期のモジュール準備を待つ。 */
  prepareOutput(output: AudioPlayoutOutput): Promise<void> {
    return this.getRenderer(output).prepare();
  }

  /** 出力 graph を 1 つだけ所有し、Context の変更では旧 graph を実音の終端で閉じる。 */
  private getRenderer(output: AudioPlayoutOutput): AudioOutputRenderer {
    if (
      this.renderer !== null &&
      this.renderer.output.context === output.context &&
      this.renderer.output.destination === output.destination
    )
      return this.renderer;
    if (this.renderer !== null)
      this.renderer.dispose(
        Math.max(this.renderer.output.context.currentTime, this.lastRenderEndSeconds),
      );
    this.lastRenderEndSeconds = 0;
    this.renderer = new AudioOutputRenderer(output, (statistics) => {
      this.playout.recordRenderedConcealment(
        statistics.concealedFrames / output.context.sampleRate,
        statistics.concealments,
      );
      this.timing.recordRenderedGap(
        (statistics.uncoveredFrames * 1000) / output.context.sampleRate,
        statistics.gaps,
        (statistics.uncoveredMaxFrames * 1000) / output.context.sampleRate,
      );
      this.timing.recordRenderedBoundary(statistics.boundaryStepMax, statistics.boundaryStepCount);
    });
    return this.renderer;
  }

  /** drain が分かったら、予測音を止める位置を出力時計で知らせる。 */
  private stopContinuation(): void {
    if (this.renderer !== null)
      this.renderer.stop(
        Math.max(this.renderer.output.context.currentTime, this.lastRenderEndSeconds),
      );
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
    this.draining = true;
    this.stopContinuation();
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
      if (isFlushSettled()) this.stopContinuation();
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
    this.draining = false;
    return result;
  }

  /** 時計の対応と直前の音を消す (AudioContext を作り直した / 閉じたとき) */
  private forgetAudioContext(): void {
    this.stopContinuation();
    this.draining = false;
    this.targetDelayValueMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS;
    this.clock.reset();
    this.previousChannels = null;
    this.previousSampleRate = 0;
    this.previousMediaEndTimestampMicros = null;
    if (this.renderer !== null)
      this.renderer.dispose(
        Math.max(this.renderer.output.context.currentTime, this.lastRenderEndSeconds),
      );
    this.renderer = null;
    this.lastRenderEndSeconds = 0;
  }

  /** 実音だけを予約する。補間と復帰のフェードは出力側が所有する。 */
  private startBuffer(
    output: AudioPlayoutOutput,
    channelCount: number,
    channels: readonly AudioSamples[],
    frames: number,
    sampleRate: number,
    whenSeconds: number,
  ): { startAtSeconds: number; pushed: boolean } {
    const renderer = this.getRenderer(output);
    renderer.assertReady();
    // ネイティブのリサンプラーが終端の外側をゼロとして読まないよう、短い端点の延長を置く。
    // 発音は実音の終端で止めるため、この余白を音声として再生しない。
    const padding = 64;
    const buffer = output.context.createBuffer(channelCount, frames + padding, sampleRate);
    for (let channel = 0; channel < channelCount; channel++) {
      const samples = channels[channel];
      if (samples !== undefined) {
        buffer.copyToChannel(samples, channel);
        buffer.getChannelData(channel).fill(samples[frames - 1] ?? 0, frames);
      }
    }
    const source = output.context.createBufferSource();
    source.buffer = buffer;
    source.connect(renderer.input);
    const nowSeconds = output.context.currentTime;
    const startAtSeconds = Math.max(
      whenSeconds,
      nowSeconds + AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS,
    );
    const pushed = startAtSeconds > whenSeconds;
    if (pushed) {
      this.timing.recordPushStart((startAtSeconds - whenSeconds) * 1000);
      if (nowSeconds > whenSeconds) this.timing.recordLateStart((nowSeconds - whenSeconds) * 1000);
    }
    const endSeconds = startAtSeconds + frames / sampleRate;
    renderer.reserve(startAtSeconds, endSeconds, channelCount, this.draining);
    source.start(startAtSeconds);
    // Web Audio のレート変換が境界の末尾を長く鳴らしても、次の実音へ加算しない。
    source.stop(endSeconds);
    source.onended = () => source.disconnect();
    this.lastRenderEndSeconds = endSeconds;
    return { startAtSeconds, pushed };
  }
}
