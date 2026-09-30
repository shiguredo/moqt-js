/**
 * キーフレーム間隔の判定・値域・既定値の共有モジュール
 *
 * moqt-devtools (hooks/usePublisher.ts) と webcodecs-devtools (webcodecs-devtools/signals.ts)
 * は別の signal を持ちながら同じ判定をしており、キーフレームの判定が 2 箇所に分かれていた。
 * 判定はライブラリの `shouldSendKeyFrame` に委譲し、値域の規則と既定値をここに 1 箇所だけ
 * 置く。URL クエリの復元の検証は、select の選択肢と同じ許可リスト
 * (`KEYFRAME_INTERVAL_OPTIONS`) を渡した signals/connectionSettings.ts の
 * `resolveOptionNumber` が行う (許可リストの判定をここに二重実装しない)。
 *
 * 間隔はフレーム数ではなく秒で持つ。フレーム数で持つと、framerate を変えたときに実際の
 * 間隔が変わる (30 fps の 300 フレームは 10 秒だが、60 fps では 5 秒になる)。
 */

import { shouldSendKeyFrame } from "../../../src/createMediaPublisher.ts";

/**
 * キーフレーム間隔の既定値 (秒)
 *
 * 無効な間隔を正規化するときのフォールバックと、webcodecs-devtools の signal の初期値に
 * 使う。moqt-devtools の 2 つの signal は画面ごとの既定 (接続設定は 10 秒、配信側は 2 秒) を
 * 持つため、この定数を初期値には使わない。値域の規則 (0 より大きい有限数) を満たす。
 */
export const DEFAULT_KEYFRAME_INTERVAL = 2;

/**
 * moqt-devtools の Keyframe Interval の選択肢 (秒)
 *
 * ConnectionSettings の select はこの定数から option を生成し、URL クエリの検証
 * (signals/connectionSettings.ts の `resolveOptionNumber`) も同じ定数を使う。選択肢に
 * 無い値を URL が受理すると、select の表示が空になって表示と実際の設定が食い違う
 * (音声設定と同じ規則)。webcodecs-devtools の select は選択肢が異なる (1 / 2 / 3 / 4) ため、
 * この定数を参照せず、共有するのは判定と既定値だけにする。
 */
export const KEYFRAME_INTERVAL_OPTIONS: readonly number[] = [1, 2, 4, 8, 10, 30, 60, 90, 120, 240];

/**
 * キーフレーム間隔を値域の規則 (0 より大きい有限数) に正規化する
 *
 * 値域はライブラリの `resolveKeyframeInterval` と同じ規則に揃える。0 以下 / NaN /
 * ±Infinity の間隔ではキーフレームの要求が意図した周期で出ないため、有効な間隔だけを
 * そのまま使う。
 *
 * @param keyframeInterval - 判定に渡された間隔 (秒)
 * @returns 0 より大きい有限数ならその値、そうでなければ `DEFAULT_KEYFRAME_INTERVAL`
 */
function normalizeKeyframeInterval(keyframeInterval: number): number {
  return Number.isFinite(keyframeInterval) && keyframeInterval > 0
    ? keyframeInterval
    : DEFAULT_KEYFRAME_INTERVAL;
}

/**
 * フレームにキーフレームを要求するかを判定する
 *
 * 先頭フレーム (直前のキーフレームが無い) と、直前のキーフレームから keyframeInterval 秒
 * 以上経過したフレームに要求する。要求しないフレームはエンコーダがデルタフレームとして
 * 符号化する。間隔を無視して全フレームをキーフレームにすると帯域を浪費し、逆に要求が
 * 一度も出ないと購読を開始できないため、境界を検証できる形にする。
 *
 * 間隔は 0 より大きい有限数だけを有効とし、0 / 負値 / NaN / ±Infinity は既定値
 * (`DEFAULT_KEYFRAME_INTERVAL`) として判定する。無効値を throw にしないのは、呼び出し側
 * (hooks/usePublisher.ts の processFrames) の try-catch が配信ループごと抜けてしまうため。
 *
 * @param lastKeyFrameTimestampUs - 直前のキーフレームの timestamp (マイクロ秒)。まだ
 *   キーフレームを要求していない場合は null
 * @param frameTimestampUs - 判定するフレームの timestamp (マイクロ秒)
 * @param keyframeInterval - キーフレームを要求する間隔 (秒)
 * @returns キーフレームを要求するなら true
 */
export function shouldRequestKeyFrame(
  lastKeyFrameTimestampUs: number | null,
  frameTimestampUs: number,
  keyframeInterval: number,
): boolean {
  return shouldSendKeyFrame(
    lastKeyFrameTimestampUs,
    frameTimestampUs,
    normalizeKeyframeInterval(keyframeInterval),
  );
}
