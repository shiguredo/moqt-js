/**
 * 復号した音声を鳴らす時刻を決める
 *
 * 復号した音声 (Opus なら 20 ms ごとの `AudioData`) を、復号の出力が届いたその場で
 * `AudioBufferSourceNode.start()` で鳴らすと、届く間隔の揺らぎ (経路と復号) で前の音と
 * 重なって足されるか、隙間が空いて、ノイズに聞こえる。鳴らす時刻は、映像と同じ
 * `src/playbackTimeline.ts` の時間軸が決めた目標の時刻に従う。
 *
 * - 目標の時刻は `AudioContext.currentTime` と同じ秒で受け取る。壁時計の TIMESTAMP を
 *   持たない音は目標を持たず、現在の基準の決め方 (最初の音の到着 + 再生の遅れ) を使う
 * - 目標の時刻を過ぎて届いた音、並べすぎの音、前の音と重なる音は捨てる。基準を取り直すと
 *   音声だけが後ろへずれ、共有の時間軸を使う映像とずれるため、取り直さない
 * - 音声だけを購読していて目標を守らないとき (`enforceTarget` が false) は、揃える相手が
 *   いないため、届かなかった音は捨てずに基準を取り直す (最初の実装の挙動)
 * - どの音も前の音の終わりより前には鳴らさない (重ねない)。前の音の終わりより後ろに
 *   空いた分は無音として残す
 * - 並べすぎの上限は「再生の遅れ + 余裕 (`AUDIO_PLAYOUT_BACKLOG_SECONDS`)」である
 *
 * 時刻は `AudioContext.currentTime` と同じ秒、timestamp は `AudioData.timestamp` と同じ
 * マイクロ秒で扱う。ブラウザ API に依存しない。
 */

import { AUDIO_PLAYOUT_DELAY_FLOOR_MS } from "./playbackTimeline";

/**
 * 再生の遅れ (秒)
 *
 * 目標の時刻を使わないとき (壁時計の TIMESTAMP を持たない音、音声だけの購読) の基準に使う。
 * 共有の時間軸が使う下限 (`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) と同じ値であり、定義は時間軸側に
 * 置く (揺らぎから求めた遅れをこの値で下限にするため)
 */
export const AUDIO_PLAYOUT_DELAY_SECONDS = AUDIO_PLAYOUT_DELAY_FLOOR_MS / 1_000;

/**
 * 再生の遅れの合計の上限 (秒)
 *
 * 並べすぎの判定に使う「再生の遅れ + 余裕」の合計。余裕はこの値から
 * `AUDIO_PLAYOUT_DELAY_SECONDS` を引いた分である
 */
export const AUDIO_PLAYOUT_MAX_DELAY_SECONDS = 0.3;

/** 並べすぎとみなす、再生の遅れを超える余裕 (秒) */
export const AUDIO_PLAYOUT_BACKLOG_SECONDS =
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS - AUDIO_PLAYOUT_DELAY_SECONDS;

/**
 * 鳴らす時刻を今からどれだけ先にするかの下限 (秒)
 *
 * AudioContext は 128 フレーム (48 kHz で約 2.7 ms) ずつ描くため、それより先の時刻を指定する。
 * 画面のスレッドが混んで `start()` が遅れる分も見込む
 */
export const AUDIO_PLAYOUT_MIN_LEAD_SECONDS = 0.01;

/**
 * 時計の対応付けをやり直す最小の差 (ミリ秒)
 *
 * `AudioContext.getOutputTimestamp()` はデバイスの位置の推定であり、読み取りごとに数 ms
 * 揺れる。libwebrtc の `video/stream_synchronization.cc` の不感帯 (`kMinDeltaMs` = 30 ms)
 * と同じ考え方で、これ未満の差は無視する。無視した分はそのまま A/V のずれとして残る
 */
export const AUDIO_CLOCK_DEADBAND_MS = 30;

/**
 * 時計の対応付けを 1 回で動かす上限 (ミリ秒)
 *
 * libwebrtc の `kMaxChangeMs` = 80 ms と同じ考え方。段差のある補正で音が飛ばないようにする
 */
export const AUDIO_CLOCK_MAX_CHANGE_MS = 80;

/** 再生の余裕、下限 (省略時は既定の値) */
export interface AudioPlayoutOptions {
  backlogSeconds?: number;
  minLeadSeconds?: number;
}

/**
 * 1 つの音を鳴らすときの目標
 *
 * 壁時計の TIMESTAMP を持たない音は `targetStartSeconds` を null にする
 */
export interface AudioPlayoutTarget {
  /** 目標の開始時刻 (`AudioContext.currentTime` の秒) */
  targetStartSeconds: number | null;
  /**
   * 目標を守るか
   *
   * false のとき (音声だけを購読していて揃える相手がいないとき) は、目標に届かなければ
   * 基準を取り直して鳴らす
   */
  enforceTarget: boolean;
  /** 目標を使わないときと取り直すときに使う再生の遅れ (秒) */
  delaySeconds: number;
  /**
   * 表示に使っている遅れ (秒)。`max(targetLatency, 再生遅延)` を上限で切った値
   *
   * 目標の表示時刻は今からこの値だけ先にあるため、並べすぎの上限はこの値から決める
   */
  presentationDelaySeconds: number;
}

/** 音を鳴らす時刻 (`AudioContext.currentTime` の秒)、または捨てる */
export type AudioPlayoutDecision = { kind: "play"; startAt: number } | { kind: "drop" };

/** 基準: この timestamp の音をこの時刻に鳴らす */
interface PlayoutAnchor {
  time: number;
  timestampMicroseconds: number;
}

export class AudioPlayoutScheduler {
  private readonly backlogSeconds: number;
  private readonly minLeadSeconds: number;
  private anchor: PlayoutAnchor | null = null;
  // 直前に鳴らすと決めた音の終わりの時刻と timestamp
  private lastEnd: number | null = null;
  private lastTimestampMicroseconds: number | null = null;
  private rebaseCount = 0;
  private dropCount = 0;

  constructor(options: AudioPlayoutOptions = {}) {
    this.backlogSeconds = options.backlogSeconds ?? AUDIO_PLAYOUT_BACKLOG_SECONDS;
    this.minLeadSeconds = options.minLeadSeconds ?? AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  }

  /** 基準を取り直した回数 (目標を使わないときの、過ぎてから届いた音) */
  get rebases(): number {
    return this.rebaseCount;
  }

  /** 捨てた音の数 (目標を過ぎた音、並べすぎの音、基準の取り直しで溢れた音) */
  get drops(): number {
    return this.dropCount;
  }

  /**
   * 音を鳴らす時刻を決める
   *
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`)
   * @param timestampMicroseconds - 音の timestamp (`AudioData.timestamp`)
   * @param durationSeconds - 音の長さ (`AudioBuffer.duration`)
   * @param target - 目標の開始時刻と、それを守るか
   */
  schedule(
    nowSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    target: AudioPlayoutTarget,
  ): AudioPlayoutDecision {
    if (target.targetStartSeconds === null || !target.enforceTarget) {
      return this.scheduleByArrival(nowSeconds, timestampMicroseconds, durationSeconds, target);
    }
    const startAt = target.targetStartSeconds;
    if (startAt < nowSeconds + this.minLeadSeconds) {
      // 目標の時刻を過ぎて届いた。取り直さずに捨て、次の音から目標へ戻る
      this.dropCount += 1;
      return { kind: "drop" };
    }
    const limit =
      Math.max(target.delaySeconds, target.presentationDelaySeconds) + this.backlogSeconds;
    if (startAt > nowSeconds + limit) {
      // 並べる音が溜まりすぎている
      this.dropCount += 1;
      return { kind: "drop" };
    }
    if (this.lastEnd !== null && startAt < this.lastEnd) {
      // 前の音と重なる (目標が前の音の終わりより前)。重ねるとノイズになる
      this.dropCount += 1;
      return { kind: "drop" };
    }
    this.lastEnd = startAt + durationSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    return { kind: "play", startAt };
  }

  /** 基準を消す。次の音で作り直す (購読のやり直し、AudioContext の作り直し) */
  reset(): void {
    this.anchor = null;
    this.lastEnd = null;
    this.lastTimestampMicroseconds = null;
  }

  /**
   * 目標を使わないときの決め方
   *
   * 最初の音で基準を決め、timestamp の間隔どおりに並べる。過ぎてから届いた音は基準を
   * 取り直し、並べすぎの音は捨てる
   */
  private scheduleByArrival(
    nowSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    target: AudioPlayoutTarget,
  ): AudioPlayoutDecision {
    const delaySeconds = target.delaySeconds;
    const limitSeconds = delaySeconds + this.backlogSeconds;
    let startAt = this.expectedStartAt(timestampMicroseconds, nowSeconds, delaySeconds);
    if (startAt < nowSeconds + this.minLeadSeconds) {
      // 過ぎてから届いた。前の音はすべて今より前に終わっているため、重ならない
      startAt = nowSeconds + delaySeconds;
      this.rebase(startAt, timestampMicroseconds);
    } else if (startAt > nowSeconds + limitSeconds) {
      const earliest = Math.max(nowSeconds + delaySeconds, this.lastEnd ?? -Infinity);
      if (earliest > nowSeconds + limitSeconds) {
        // 並べる音が溜まりすぎている。捨てて次の音を目標へ戻す
        this.dropCount += 1;
        return { kind: "drop" };
      }
      // timestamp が大きく飛んだ。前の音のすぐ後ろ (か今 + 再生の遅れ) から並べ直す
      startAt = earliest;
      this.rebase(startAt, timestampMicroseconds);
    }
    this.lastEnd = startAt + durationSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    return { kind: "play", startAt };
  }

  /** 基準と前の音から、この音を鳴らす時刻を求める (前の音の終わりより前にしない) */
  private expectedStartAt(
    timestampMicroseconds: number,
    nowSeconds: number,
    delaySeconds: number,
  ): number {
    if (this.anchor === null) {
      this.anchor = {
        time: nowSeconds + delaySeconds,
        timestampMicroseconds,
      };
      return this.anchor.time;
    }
    const advanced =
      this.lastTimestampMicroseconds !== null &&
      timestampMicroseconds > this.lastTimestampMicroseconds;
    const byTimestamp =
      this.anchor.time + (timestampMicroseconds - this.anchor.timestampMicroseconds) / 1_000_000;
    const afterPrevious = this.lastEnd ?? byTimestamp;
    return advanced ? Math.max(byTimestamp, afterPrevious) : afterPrevious;
  }

  private rebase(time: number, timestampMicroseconds: number): void {
    this.anchor = { time, timestampMicroseconds };
    this.rebaseCount += 1;
  }
}

/** `AudioContext.getOutputTimestamp()` が返す対応 */
export interface AudioClockMapping {
  /** デバイスが今鳴らしている位置 (`getOutputTimestamp().contextTime`、秒) */
  contextTime: number;
  /** その位置を `performance.now()` と同じ原点で表した時刻 (ミリ秒) */
  performanceTime: number;
}

/**
 * `AudioContext` の時計と `performance.now()` の対応
 *
 * 音声は `AudioContext.currentTime` の秒で予約し、映像は `performance.now()` のミリ秒で
 * 表示する。2 つは別の時計であり、`AudioContext.getOutputTimestamp()` が返す
 * `{ contextTime, performanceTime }` だけが仕様に定められた対応である
 * (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 *
 * - 対応は予約のたびに取り直し、直前の値との差が `AUDIO_CLOCK_DEADBAND_MS` 未満なら無視し、
 *   大きくても 1 回の変更を `AUDIO_CLOCK_MAX_CHANGE_MS` までにする
 * - `getOutputTimestamp()` が未開始 (両方 0) のときは `currentTime` と `performance.now()` の
 *   差で代用する。この差は音声の出力遅延を含まないため、鳴るのは目標より出力遅延の分だけ
 *   後ろになる (`usingFallback` で分かる)
 *
 * ブラウザ API に依存せず、値は引数で受ける。
 */
export class AudioClockBridge {
  private offsetMs: number | null = null;
  private fallback = false;

  /**
   * 対応を取り直す (予約のたびに呼ぶ)
   *
   * @param mapping - `getOutputTimestamp()` の値。未開始のときは null
   * @param currentTimeSeconds - `AudioContext.currentTime` (秒)
   * @param performanceNowMs - `performance.now()` (ミリ秒)
   */
  update(
    mapping: AudioClockMapping | null,
    currentTimeSeconds: number,
    performanceNowMs: number,
  ): void {
    const observedMs =
      mapping === null
        ? currentTimeSeconds * 1_000 - performanceNowMs
        : mapping.contextTime * 1_000 - mapping.performanceTime;
    if (this.offsetMs === null) {
      this.offsetMs = observedMs;
    } else {
      const differenceMs = observedMs - this.offsetMs;
      if (Math.abs(differenceMs) >= AUDIO_CLOCK_DEADBAND_MS) {
        const stepMs = Math.min(Math.abs(differenceMs), AUDIO_CLOCK_MAX_CHANGE_MS);
        this.offsetMs += Math.sign(differenceMs) * stepMs;
      }
    }
    this.fallback = mapping === null;
  }

  /**
   * `performance.now()` の軸の時刻 (ミリ秒) を `AudioContext` の秒へ換算する
   *
   * @returns `AudioContext.currentTime` と同じ座標の秒。まだ対応が無ければ null
   */
  toAudioSeconds(presentationMs: number): number | null {
    if (this.offsetMs === null) {
      return null;
    }
    return (presentationMs + this.offsetMs) / 1_000;
  }

  /**
   * `AudioContext` の秒を `performance.now()` の軸の時刻 (ミリ秒) へ換算する
   *
   * @returns `performance.now()` と同じ座標のミリ秒。まだ対応が無ければ null
   */
  toPerformanceMs(audioSeconds: number): number | null {
    if (this.offsetMs === null) {
      return null;
    }
    return audioSeconds * 1_000 - this.offsetMs;
  }

  /** `getOutputTimestamp()` を使えず、`currentTime` で代用しているか */
  get usingFallback(): boolean {
    return this.fallback;
  }

  /** 今の対応 (ミリ秒)。まだ取り直していなければ null */
  get currentOffsetMs(): number | null {
    return this.offsetMs;
  }
}
