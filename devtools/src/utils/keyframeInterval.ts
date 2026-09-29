/**
 * キーフレーム間隔の判定・値域・既定値の共有モジュール
 *
 * moqt-devtools (hooks/usePublisher.ts) と webcodecs-devtools (webcodecs-devtools/signals.ts)
 * は別の signal を持ちながら同じ判定をしており、剰余によるキーフレームの判定が 2 箇所に
 * 分かれていた。剰余の実装はライブラリの `shouldSendKeyFrame` に委譲し、値域の規則と既定値をここに
 * 1 箇所だけ置く。URL クエリの復元の検証は、select の選択肢と同じ許可リスト
 * (`KEYFRAME_INTERVAL_OPTIONS`) を渡した signals/connectionSettings.ts の
 * `resolveOptionNumber` が行う (許可リストの判定をここに二重実装しない)。
 */

import { shouldSendKeyFrame } from "../../../src/createMediaPublisher.ts";

/**
 * キーフレーム間隔の既定値 (frames)
 *
 * 30 fps で 120 秒ぶん。無効な間隔を正規化するときのフォールバックと、
 * webcodecs-devtools の signal の初期値に使う。moqt-devtools の 2 つの signal は
 * 画面ごとの既定 (接続設定は 300、配信側は 60) を持つため、この定数を初期値には
 * 使わない。値域の規則 (1 以上の整数) を満たす。
 */
export const DEFAULT_KEYFRAME_INTERVAL = 3600;

/**
 * moqt-devtools の Keyframe Interval の選択肢 (frames)
 *
 * ConnectionSettings の select はこの定数から option を生成し、URL クエリの検証
 * (signals/connectionSettings.ts の `resolveOptionNumber`) も同じ定数を使う。選択肢に
 * 無い値を URL が受理すると、select の表示が空になって表示と実際の設定が食い違う
 * (音声設定と同じ規則)。webcodecs-devtools の select は選択肢が異なる (30 / 60 / 90 /
 * 120) ため、この定数を参照せず、共有するのは判定と既定値だけにする。
 */
export const KEYFRAME_INTERVAL_OPTIONS: readonly number[] = [
  30, 60, 120, 240, 300, 900, 1800, 2700, 3600, 7200,
];

/**
 * キーフレーム間隔を値域の規則 (1 以上の整数) に正規化する
 *
 * 値域はライブラリの `resolveKeyframeInterval` と同じ規則に揃える。非整数の間隔では
 * 剰余による周期の要求が先頭の 1 回で止まる値があり、0 では剰余が NaN になって要求が
 * 一度も出ないため、有効な間隔だけをそのまま使う。
 *
 * @param keyframeInterval - 判定に渡された間隔
 * @returns 1 以上の整数ならその値、そうでなければ `DEFAULT_KEYFRAME_INTERVAL`
 */
function normalizeKeyframeInterval(keyframeInterval: number): number {
  return Number.isInteger(keyframeInterval) && keyframeInterval >= 1
    ? keyframeInterval
    : DEFAULT_KEYFRAME_INTERVAL;
}

/**
 * フレームにキーフレームを要求するかを判定する
 *
 * 先頭フレーム (framesEncoded = 0) と keyframeInterval フレームごとに要求する。
 * 要求しないフレームはエンコーダがデルタフレームとして符号化する。間隔を無視して
 * 全フレームをキーフレームにすると帯域を浪費し、逆に要求が一度も出ないと購読を
 * 開始できないため、境界を検証できる形にする。
 *
 * 間隔は 1 以上の整数だけを有効とし、0 / 負値 / 非整数 / NaN / ±Infinity は既定値
 * (`DEFAULT_KEYFRAME_INTERVAL`) として判定する。無効値を throw にしないのは、呼び出し側
 * (hooks/usePublisher.ts の processFrames) の try-catch が配信ループごと抜けてしまうため。
 *
 * @param framesEncoded - キーフレームの間隔を数えるフレーム数
 * @param keyframeInterval - キーフレームを要求する間隔 (frames)
 * @returns キーフレームを要求するなら true
 */
export function shouldRequestKeyFrame(framesEncoded: number, keyframeInterval: number): boolean {
  return shouldSendKeyFrame(framesEncoded, normalizeKeyframeInterval(keyframeInterval));
}
