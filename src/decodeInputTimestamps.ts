/**
 * 復号へ渡した timestamp から、復号の出力を引く
 *
 * 音声の TIMESTAMP の種類 (壁時計かメディア時刻か) は、復号へ渡した時に覚えて復号の出力で
 * 引く。`AudioData` は種類を持たないためである (`src/createMediaSubscriber.ts` と
 * `devtools/src/hooks/useSubscriber.ts`)。ところが WebCodecs の `AudioDecoder` は、出力する
 * `AudioData.timestamp` を入力の timestamp と完全には一致させない。実測 (実リレー、Opus、
 * 48 kHz) では出力が入力より 100 マイクロ秒だけ大きかった。
 *
 * 完全一致で引くと、この 100 マイクロ秒のずれで引けなくなり、種類を失った音が共有の時間軸へ
 * 記録されなくなる。実測 (CI の runner、run 38026081292) では、音声の基準の遅れが 116 ms の
 * まま更新されなくなり、次に一致した観測で 630 ms、836 ms へ飛んで、A/V の基準の共有が解除
 * された。出力は投入の順に返るため、一致する記録が無いときは最も古い記録を、timestamp が
 * 許容の中にある場合だけ引く。ずれて引く (順番で決め打ちする) と、出力が欠けたときに以降の
 * 対応が 1 つずつずれ、位置の判定を誤る。
 */

/**
 * 復号の出力の timestamp と、復号へ渡した timestamp の差として許す上限 (マイクロ秒)
 *
 * 実測したずれは 100 マイクロ秒である。Opus の最短のフレームは 2.5 ms であり、その半分より
 * 十分に小さい値にして、隣のフレームと取り違えないようにする
 */
export const DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS = 1_000;

/**
 * 復号の出力の timestamp に対応する記録を 1 つ取り出す (取り出した分は忘れる)
 *
 * 完全一致する記録があればそれを取り出す。無ければ、`DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS`
 * より古い記録を捨て (その出力にも後続の出力にも対応しない)、最も古い記録を timestamp の差が
 * 許容以内のときだけ取り出す。対応が無ければ undefined を返す (呼び出し側は種類 `none` として
 * 扱う)。
 *
 * 古い記録を捨てるのは、対応が一度ずれると (出力が欠けた、最初の出力が投入と対応しないなど)
 * 最も古い記録が永久に一致しなくなり、以降の対応がすべて引けなくなるためである。
 *
 * @param entries - 復号へ渡した timestamp をキーにした記録 (記録した順に並ぶ)
 * @param outputTimestampMicros - 復号の出力の timestamp (マイクロ秒)
 */
export function takeDecodeInputEntry<T>(
  entries: Map<number, T>,
  outputTimestampMicros: number,
): T | undefined {
  const exact = entries.get(outputTimestampMicros);
  if (exact !== undefined) {
    entries.delete(outputTimestampMicros);
    return exact;
  }
  // この出力より許容以上に古い記録は、この出力にも後続の出力にも対応しない
  for (const [timestamp] of entries) {
    if (outputTimestampMicros - timestamp <= DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS) {
      break;
    }
    entries.delete(timestamp);
  }
  // 一致する記録が無いときは、最も古い記録だけを候補にする。出力は投入の順に返るため、
  // 次に引くべき記録は最も古いものである
  const oldest = entries.keys().next();
  if (oldest.done === true) {
    return undefined;
  }
  const oldestTimestamp = oldest.value;
  if (
    Math.abs(oldestTimestamp - outputTimestampMicros) > DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS
  ) {
    return undefined;
  }
  const value = entries.get(oldestTimestamp);
  entries.delete(oldestTimestamp);
  return value;
}
