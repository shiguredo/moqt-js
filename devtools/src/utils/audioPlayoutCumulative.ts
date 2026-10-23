/**
 * 音声の再生の累積の計器 (時間圧縮・補間) と、再生を始めた時点からの差
 *
 * 再生の入口 (MediaPlayout) の統計は、AudioContext を作り直しても購読の統計として累積を
 * 引き継ぐ (ライブラリの createMediaSubscriber と同じ)。devtools の画面は再生を始めるたびに
 * 0 から数えていたため、再生を始めた時点の値を覚えておき、表示するときに差を出す。
 */

/** 音声の再生の累積の計器 (時間圧縮・補間) */
export interface AudioPlayoutCumulative {
  compressedMs: number;
  concealedMs: number;
  concealments: number;
}

/**
 * 音声の再生の累積の計器の差を求める
 *
 * baseline が null (入口を作り直した直後で、まだ再生を始めていない) のときは、ミリ秒を
 * 丸めた累積を返す。ミリ秒は画面の表示に合わせて整数へ丸める (差を求めてから丸める。
 * 累積と基準をそれぞれ丸めて引くと、丸めの境目で 1 ずれる)。回数はそのまま返す。
 *
 * テストから呼べるよう export する (パッケージ公開 API ではない)。
 *
 * @param cumulative - 入口の統計から読んだ累積
 * @param baseline - 再生を始めた時点の累積。まだ始めていなければ null
 */
export function subtractAudioPlayoutCumulative(
  cumulative: AudioPlayoutCumulative,
  baseline: AudioPlayoutCumulative | null,
): AudioPlayoutCumulative {
  if (baseline === null) {
    return {
      compressedMs: Math.round(cumulative.compressedMs),
      concealedMs: Math.round(cumulative.concealedMs),
      concealments: cumulative.concealments,
    };
  }
  return {
    compressedMs: Math.round(cumulative.compressedMs - baseline.compressedMs),
    concealedMs: Math.round(cumulative.concealedMs - baseline.concealedMs),
    concealments: cumulative.concealments - baseline.concealments,
  };
}
