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
 *
 * 許容の中でも引けない状態が続くことがある。実測 (実リレー、CPU を 6 倍に遅くした再現、音声
 * 50 個/秒) では、記録と復号の出力の timestamp の格子が 9.7 ms ずれ、その差がそのまま
 * 残った (記録と出力の双方が 20 ms ごとに進むため、差は縮まらない)。このとき記録は残り
 * (この出力より古い記録は捨てる規則は、出力より新しい記録を消さない)、同じ判定が出力ごとに
 * 繰り返されて、以後の出力がすべて引けなくなる (実測: 対応が引けた 635 回の後、831 回続けて
 * 引けなくなった)。格子がずれるきっかけは経路ではなく配信側の TIMESTAMP の補正の段差と
 * relay の cache の再送であり (実測: 入力の timestamp の間隔に -120 ms から +190 ms の跳びが
 * 20 秒間に 30 回)、実装で防げる性質ではない。
 *
 * そこで、引けないときは直前に分かっている種類を使う (`LastTimestampKind`)。種類は
 * TIMESTAMP の Timescale の有無で決まり、ストリームの途中で変わるものではないため、直前の
 * 種類を当てても実害は無い。値が離れているとき (TIMESTAMP が無い音の 0 など) だけは、別の
 * 時間軸の値であり当てにしない。
 */

/**
 * 復号の出力の timestamp と、復号へ渡した timestamp の差として許す上限 (マイクロ秒)
 *
 * 実測したずれは 100 マイクロ秒である (実リレー、1014 件の出力のうち完全一致は 1〜3 件で、
 * 最も近い記録との差は p50 0.30 ms、p99 0.40 ms、最大 0.40 ms。2026-10-15)。Opus の最短の
 * フレームは 2.5 ms であり、その半分より十分に小さい値にして、隣のフレームと取り違えない
 * ようにする。
 *
 * CPU を 6 倍に遅くした再現では 9.7 ms のずれが観測されており、この枠では引けない (その
 * 場合は種類だけを引き継ぐ)。フレームの長さに合わせて枠を広げるのは、フレームの長さを
 * 受け取る形にしてからにする
 */
export const DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS = 1_000;

/**
 * 対応が引けないときに、直前に分かっている種類を使ってよい、値の隔たりの上限 (マイクロ秒)
 *
 * 復号の出力の timestamp が、保留している記録からこの値より離れているときは、直前の種類を
 * 当てにしない。TIMESTAMP が無い音は decoder へ 0 を渡すため、その出力は壁時計の値では
 * なく、直前の種類 (壁時計) を当てると 1970 年からの時刻として共有の時間軸へ記録してしまう。
 *
 * 10 秒は、復号が数秒遅れて出る場合 (実測: 負荷時に 0.5 秒) を許しつつ、別の時間軸の値
 * (0、メディア時刻、ミリ秒とマイクロ秒の取り違え) と区別できる大きさである
 */
export const DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS = 10_000_000;

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
 * @param toleranceMicros - 対応とみなす差の上限 (マイクロ秒。既定は
 *   `DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS`)。呼び出し側が音 1 つの長さの半分を渡すと、
 *   隣のフレームと取り違えない範囲で最大まで広げられる (`audioPlayoutSession` ではなく復号の
 *   出力を持つ呼び出し側が渡す。実測: CPU を 6 倍に遅くすると 9.7 ms ずれ、既定の 1 ms では
 *   引けない)
 */
export function takeDecodeInputEntry<T>(
  entries: Map<number, T>,
  outputTimestampMicros: number,
  toleranceMicros = DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS,
): T | undefined {
  const exact = entries.get(outputTimestampMicros);
  if (exact !== undefined) {
    entries.delete(outputTimestampMicros);
    return exact;
  }
  // この出力より許容以上に古い記録は、この出力にも後続の出力にも対応しない
  for (const [timestamp] of entries) {
    if (outputTimestampMicros - timestamp <= toleranceMicros) {
      break;
    }
    entries.delete(timestamp);
  }
  // 一致する記録が無いときは、許容の中では最も近い記録を対応させる。復号の出力の timestamp は
  // 投入した値と小数だけずれるため (実測: 実リレーで 1014 件の出力のうち完全一致は 1 件、
  // 最も近い記録との差は p50 0.30 ms、p99 0.40 ms、最大 0.40 ms)、完全一致では引けない。
  //
  // 最も古い記録だけを候補にすると、出力が返らなかった記録が 1 つ残っただけで、その記録が
  // 永久に一致せず、以降の対応がすべて引けなくなる。許容 (1 ms) は音 1 つの間隔 (20 ms) より
  // 十分小さいため、複数の記録が候補になることはない
  let nearest: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [timestamp] of entries) {
    const distance = Math.abs(timestamp - outputTimestampMicros);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = timestamp;
    }
  }
  if (nearest === null || nearestDistance > toleranceMicros) {
    return undefined;
  }
  const value = entries.get(nearest);
  entries.delete(nearest);
  return value;
}

/**
 * 直前に分かっている TIMESTAMP の種類を覚え、対応が引けない出力に使う
 *
 * `takeDecodeInputEntry` が undefined を返したときに `fallbackFor` を呼ぶ。保留している
 * 記録のどれかが `DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS` の中にあれば、その出力は
 * 同じ時間軸の値であり、直前に分かっている種類を当ててよい。離れているときは別の時間軸の値
 * (TIMESTAMP が無い音は decoder へ 0 を渡すため、その出力は 0 である) であり、当てると
 * 誤った時刻で共有の時間軸へ記録するため null を返す。
 *
 * 記録が 1 つも無いときも null を返す。まだ何も分かっていないためである。
 *
 * 引けない状態が続くと記録は減らないため、ここで見る記録は実リレーの再現では 1〜2 件で
 * あった。記録が多いとき (relay の cache からまとめて復号しているとき) は線形に走査するが、
 * その間は対応が引けているため `fallbackFor` は呼ばれない。
 *
 * 種類は Timescale の有無で決まり、ストリームの途中で変わるものではない。変わったときに
 * 古い種類を使い続けないよう、`update` は種類が分かるたびに上書きする。
 */
export class LastTimestampKind<K extends string> {
  private value: K | null = null;

  /**
   * 分かった種類で上書きする
   *
   * 種類が分からない (`TIMESTAMP` が無い) ときは渡さない。0 の出力に古い種類を当てないため
   * である。
   */
  update(kind: K | null): void {
    if (kind !== null) {
      this.value = kind;
    }
  }

  /** 購読を始めるときなど、覚えている種類を捨てる */
  reset(): void {
    this.value = null;
  }

  /**
   * 対応が引けなかった出力に使う種類。使えなければ null
   *
   * @param entries - 復号へ渡した timestamp をキーにした記録
   * @param outputTimestampMicros - 復号の出力の timestamp (マイクロ秒)
   */
  fallbackFor<T>(entries: ReadonlyMap<number, T>, outputTimestampMicros: number): K | null {
    if (this.value === null) {
      return null;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const timestamp of entries.keys()) {
      nearest = Math.min(nearest, Math.abs(outputTimestampMicros - timestamp));
    }
    return nearest <= DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS ? this.value : null;
  }
}
