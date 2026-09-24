/**
 * 映像フレームのメディア時刻を Unix epoch の壁時計に換算する
 *
 * draft-ietf-moq-loc-04 Section 2.3.1.1: Timescale を載せない TIMESTAMP は
 * Unix epoch からのマイクロ秒 (壁時計) として解釈される。
 *
 * MediaStreamTrackProcessor から読んだ VideoFrame の timestamp は取得元ごとに基準が
 * 異なる (Chromium では canvas の captureStream() が stream の開始、fake camera が
 * performance.now() とも stream の開始とも異なる大きな値)。`performance.timeOrigin` を
 * 足すだけでは壁時計にならないため、最初に読んだフレームの timestamp とそのときの
 * 壁時計の対応をとり、以降のフレームは timestamp の差を足して換算する。
 * フレームは取得の直後に読むため、換算した壁時計と実際の取得時刻の差は小さい。
 */

/**
 * メディア時刻と壁時計の対応
 */
export interface WallClockAnchor {
  /** 対応をとったフレームの timestamp (マイクロ秒) */
  readonly mediaMicros: number;
  /** そのフレームを読んだときの壁時計 (Unix epoch マイクロ秒、整数) */
  readonly wallClockMicros: number;
}

/**
 * フレームの timestamp とそのフレームを読んだときの壁時計から対応を作る
 *
 * @param mediaMicros - フレームの timestamp (マイクロ秒)
 * @param wallClockMillis - フレームを読んだときの壁時計 (Unix epoch ミリ秒。呼び出し側が
 *   `performance.timeOrigin + performance.now()` を渡す)
 */
export function createWallClockAnchor(
  mediaMicros: number,
  wallClockMillis: number,
): WallClockAnchor {
  return { mediaMicros, wallClockMicros: Math.round(wallClockMillis * 1000) };
}

/**
 * フレームの timestamp を壁時計 (Unix epoch マイクロ秒) に換算する
 *
 * 対応をとったフレームの壁時計に timestamp の差を足す。LOC の TIMESTAMP は vi64 で
 * 負を表せないため、Unix epoch より前にはしない。
 *
 * @param mediaMicros - フレームの timestamp (マイクロ秒)
 * @param anchor - `createWallClockAnchor` で作った対応
 */
export function toWallClockMicroseconds(mediaMicros: number, anchor: WallClockAnchor): bigint {
  const offset = Math.round(mediaMicros - anchor.mediaMicros);
  return BigInt(Math.max(0, anchor.wallClockMicros + offset));
}
