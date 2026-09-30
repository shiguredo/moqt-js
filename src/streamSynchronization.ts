/**
 * 音声と映像の遅延を相対的に制御して同期させる
 *
 * libwebrtc の `video/stream_synchronization.cc` (および 1 秒ごとに呼ぶ
 * `video/rtp_streams_synchronizer2.cc` の `UpdateDelay`) の移植である。ブラウザの
 * 2 つの時計 (`performance.now()` と `AudioContext.currentTime`) を対応づける部分は
 * `src/audioPlayout.ts` の `AudioClockBridge` が持ち、ここは「どちらをどれだけ遅らせるか」
 * だけを決める。
 *
 * libwebrtc の考え方:
 *
 * - 音声と映像はそれぞれ自分の jitter buffer の遅延 (音声は NetEq の目標遅延、映像は
 *   `VCMTiming` の jitter + 復号 + render の遅延) を持ち、A/V 同期はその差だけを見る
 * - 同期の制御量は「映像の遅延 - 音声の遅延 + 経路の相対遅延」である。これは映像が
 *   音声よりどれだけ遅れて出るか (A/V のずれ) に等しい
 * - ずれが `SYNC_MIN_DELTA_MS` (30 ms) 未満の間は何もしない (不感帯)。このため映像は
 *   音声より最大 30 ms 先行してよい。音声の jitter buffer が映像より大きいとき、映像を
 *   音声に合わせて遅らせ続けないのはこの不感帯のためである
 * - ずれの推定は直近 4 回の平均 (`SYNC_FILTER_LENGTH`) で平滑化し、1 回に動かす量は
 *   `SYNC_MAX_CHANGE_MS` (80 ms) までにする。動かしたら平均を 0 に戻す (行き過ぎない)
 * - 動かすのは片側だけである。音声に余分な遅延があれば先にそれを削り、無ければ映像を
 *   遅らせる (逆も同じ)。映像の遅延は基準 (`setTargetBufferingDelay`) を下回らない
 *
 * 単位はミリ秒、時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 *
 * 参照:
 * - libwebrtc `video/stream_synchronization.cc` / `.h`
 * - libwebrtc `video/rtp_streams_synchronizer2.cc` (呼び出し間隔 1000 ms)
 */

/**
 * 1 回の制御で動かす量の上限 (ミリ秒)
 *
 * libwebrtc の `kMaxChangeMs` と同じ値
 */
export const SYNC_MAX_CHANGE_MS = 80;

/**
 * ずれの推定を捨てる閾値 (ミリ秒)
 *
 * libwebrtc の `kMaxDeltaDelayMs` と同じ値。これを超えるずれは、publisher の切り替えや
 * 時計の飛びとみなして制御しない (libwebrtc は推定そのものを失敗させる)
 */
export const SYNC_MAX_DELTA_DELAY_MS = 10_000;

/** ずれの平均を取るサンプル数。libwebrtc の `kFilterLength` と同じ値 */
export const SYNC_FILTER_LENGTH = 4;

/**
 * 制御を行うずれの下限 (ミリ秒)
 *
 * libwebrtc の `kMinDeltaMs` と同じ値。この不感帯の中では遅延を変えないため、映像は
 * 音声より最大この値だけ先行できる
 */
export const SYNC_MIN_DELTA_MS = 30;

/**
 * 同期の制御に使う 1 つのトラックの実測
 *
 * libwebrtc の `StreamSynchronization::Measurements` に対応する。受信の時刻と、
 * そのデータが撮られた時刻 (LOC の TIMESTAMP) の両方を持つ。
 */
export interface SyncMeasurement {
  /** 直近に受信 (復号の出力) した時刻 (受信側の壁時計、ミリ秒) */
  readonly latestReceiveTimeMs: number;
  /** そのデータの TIMESTAMP (送信側の壁時計、ミリ秒) */
  readonly latestCaptureTimeMs: number;
}

/** 同期の制御が決めた、各トラックの遅延の下限 (ミリ秒) */
export interface SyncDelays {
  /** 音声の遅延の下限 (ミリ秒) */
  readonly audioDelayMs: number;
  /** 映像の遅延の下限 (ミリ秒) */
  readonly videoDelayMs: number;
}

/**
 * 音声と映像の経路の相対遅延 (ミリ秒) を求める
 *
 * libwebrtc の `StreamSynchronization::ComputeRelativeDelay` と同じ式である。正の値は
 * 映像の方が遅く届いている (映像が遅れている) ことを表す。
 *
 * 受信の時刻は受信側の壁時計、TIMESTAMP は送信側の壁時計であり、同じ送信者の 2 つの
 * トラックでは時計のずれが引き算で消える。
 *
 * @returns 相対遅延。`SYNC_MAX_DELTA_DELAY_MS` を超える場合は制御しないため null
 */
export function computeRelativeDelay(
  audio: SyncMeasurement,
  video: SyncMeasurement,
): number | null {
  const relativeDelayMs =
    video.latestReceiveTimeMs -
    audio.latestReceiveTimeMs -
    (video.latestCaptureTimeMs - audio.latestCaptureTimeMs);
  if (relativeDelayMs > SYNC_MAX_DELTA_DELAY_MS || relativeDelayMs < -SYNC_MAX_DELTA_DELAY_MS) {
    return null;
  }
  return relativeDelayMs;
}

/** 制御の対象にする遅延 (ミリ秒)。`extra` は基準に対する追加分、`last` は直前に決めた値 */
interface SynchronizationDelay {
  extraMs: number;
  lastMs: number;
}

/**
 * 音声と映像の遅延を相対的に制御する (トラックの組ごとに 1 つ持つ)
 *
 * libwebrtc の `StreamSynchronization` と同じ状態を持つ。`computeDelays` を 1 秒ごとに
 * 呼ぶ (`SYNC_INTERVAL_MS`)。映像と音声のどちらも購読していないときは作らない。
 */
export class StreamSynchronization {
  /** 基準の遅延 (ミリ秒)。`setTargetBufferingDelay` で決める。既定は 0 */
  private baseTargetDelayMs = 0;
  private audioDelay: SynchronizationDelay = { extraMs: 0, lastMs: 0 };
  private videoDelay: SynchronizationDelay = { extraMs: 0, lastMs: 0 };
  /** ずれの平均 (ミリ秒)。不感帯を超えたら 0 に戻す */
  private averageDiffMs = 0;

  /**
   * 遅延の制御を行う
   *
   * libwebrtc の `StreamSynchronization::ComputeDelays` と同じ計算である。
   *
   * @param relativeDelayMs - `computeRelativeDelay` が求めた経路の相対遅延 (ミリ秒)
   * @param currentAudioDelayMs - 音声が今使っている遅延 (ミリ秒。NetEq の目標遅延に相当)
   * @param currentVideoDelayMs - 映像が今使っている遅延 (ミリ秒)
   * @returns 各トラックの遅延の下限。不感帯の中、または動かせないときは null
   */
  computeDelays(
    relativeDelayMs: number,
    currentAudioDelayMs: number,
    currentVideoDelayMs: number,
  ): SyncDelays | null {
    // 映像がどれだけ遅れているか (A/V のずれ)。libwebrtc と同じ式
    const currentDiffMs = currentVideoDelayMs - currentAudioDelayMs + relativeDelayMs;
    // C++ の整数除算と同じ丸め (0 へ切り捨て) にする
    this.averageDiffMs = Math.trunc(
      ((SYNC_FILTER_LENGTH - 1) * this.averageDiffMs + currentDiffMs) / SYNC_FILTER_LENGTH,
    );
    if (Math.abs(this.averageDiffMs) < SYNC_MIN_DELTA_MS) {
      // 不感帯の中。映像は音声より最大 SYNC_MIN_DELTA_MS だけ先行できる
      return null;
    }
    // 1 回に動かす量。平均の半分を上限で切る
    let diffMs = Math.trunc(this.averageDiffMs / 2);
    diffMs = Math.min(diffMs, SYNC_MAX_CHANGE_MS);
    diffMs = Math.max(diffMs, -SYNC_MAX_CHANGE_MS);
    // 動かしたら平均を戻す (行き過ぎない)
    this.averageDiffMs = 0;

    if (diffMs > 0) {
      // 映像が音声より遅れている。映像の余分な遅延を削るか、音声を遅らせる
      if (this.videoDelay.extraMs > this.baseTargetDelayMs) {
        this.videoDelay.extraMs -= diffMs;
        this.audioDelay.extraMs = this.baseTargetDelayMs;
      } else {
        this.audioDelay.extraMs += diffMs;
        this.videoDelay.extraMs = this.baseTargetDelayMs;
      }
    } else {
      // 映像が音声より進んでいる。音声の余分な遅延を削るか、映像を遅らせる
      if (this.audioDelay.extraMs > this.baseTargetDelayMs) {
        this.audioDelay.extraMs += diffMs;
        this.videoDelay.extraMs = this.baseTargetDelayMs;
      } else {
        this.videoDelay.extraMs -= diffMs;
        this.audioDelay.extraMs = this.baseTargetDelayMs;
      }
    }

    // 映像は基準の遅延を下回らない
    this.videoDelay.extraMs = Math.max(this.videoDelay.extraMs, this.baseTargetDelayMs);

    // 変更していない側は前回の値を保つ (一度に片側だけを動かす)
    const newVideoDelayMs =
      this.videoDelay.extraMs > this.baseTargetDelayMs
        ? this.videoDelay.extraMs
        : this.videoDelay.lastMs;
    const newAudioDelayMs =
      this.audioDelay.extraMs > this.baseTargetDelayMs
        ? this.audioDelay.extraMs
        : this.audioDelay.lastMs;

    // 基準を下回らない
    const clampedVideoDelayMs = Math.min(
      Math.max(newVideoDelayMs, this.videoDelay.extraMs),
      this.baseTargetDelayMs + SYNC_MAX_DELTA_DELAY_MS,
    );
    const clampedAudioDelayMs = Math.min(
      Math.max(newAudioDelayMs, this.audioDelay.extraMs),
      this.baseTargetDelayMs + SYNC_MAX_DELTA_DELAY_MS,
    );

    this.videoDelay.lastMs = clampedVideoDelayMs;
    this.audioDelay.lastMs = clampedAudioDelayMs;
    return { audioDelayMs: clampedAudioDelayMs, videoDelayMs: clampedVideoDelayMs };
  }

  /**
   * 基準の遅延を決める (ミリ秒)
   *
   * libwebrtc の `StreamSynchronization::SetTargetBufferingDelay` と同じである。音声と
   * 映像の両方が最低でもこの値だけ遅れる。MSF の `targetLatency`
   * (draft-ietf-moq-msf-01 §5.2.8) を渡すために使う。
   */
  setTargetBufferingDelay(targetDelayMs: number): void {
    const differenceMs = targetDelayMs - this.baseTargetDelayMs;
    this.audioDelay.extraMs += differenceMs;
    this.audioDelay.lastMs += differenceMs;
    this.videoDelay.lastMs += differenceMs;
    this.videoDelay.extraMs += differenceMs;
    this.baseTargetDelayMs = targetDelayMs;
  }

  /** 音声の余分な遅延を 10% 減らす (libwebrtc の `ReduceAudioDelay`) */
  reduceAudioDelay(): void {
    this.audioDelay.extraMs = Math.trunc(this.audioDelay.extraMs * 0.9);
  }

  /** 映像の余分な遅延を 10% 減らす (libwebrtc の `ReduceVideoDelay`) */
  reduceVideoDelay(): void {
    this.videoDelay.extraMs = Math.trunc(this.videoDelay.extraMs * 0.9);
  }
}
