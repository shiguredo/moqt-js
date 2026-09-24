/**
 * 映像フレームのメディア時刻を Unix epoch の壁時計に換算する
 *
 * draft-ietf-moq-loc-04 Section 2.3.1.1: Timescale を載せない TIMESTAMP は
 * Unix epoch からのマイクロ秒 (壁時計) として解釈される。
 *
 * MediaStreamTrackProcessor から読んだ VideoFrame の timestamp は取得元ごとに基準が
 * 異なる (Chromium では canvas の captureStream() が stream の開始、fake camera が
 * performance.now() とも stream の開始とも異なる大きな値)。`performance.timeOrigin` を
 * 足すだけでは壁時計にならないため、フレームを読んだときの壁時計と timestamp の差
 * (対応) を求めて換算する。
 *
 * フレームは撮ってから読むまでに遅れる。遅れは開始時に大きい (encoder の初期化など、
 * 開発モードではさらに大きい)。1 つのフレームだけで対応をとると、その遅れの分だけ
 * 以降のすべての TIMESTAMP が撮った時刻より未来にずれ、受信側の遅延が小さく (負に) 出る。
 * そのため、読んだフレームの差の最小値 (撮ってから読むまでの遅れが最も小さいフレーム) を
 * 対応にする。
 *
 * VideoFrame の timestamp と `performance.now()` は同じ単調な時計に基づく (Chromium の
 * canvas の captureStream と fake camera で確かめた) ため、対応は時間とともにずれない。
 * そのため対応は小さくする向きにだけ動かす。
 */

/**
 * フレームの timestamp を壁時計に換算する (映像のトラックごとに 1 つ持つ)
 *
 * 時刻は呼び出し側が引数で渡す (`performance.timeOrigin + performance.now()`)。
 */
export class WallClockMapper {
  // 読んだときの壁時計 - timestamp の最小値 (マイクロ秒)。換算に使う対応の目標
  private targetOffsetMicros: number | null = null;
  // 換算に使っている対応 (マイクロ秒)。目標へ向けて少しずつ動かす
  private appliedOffsetMicros: number | null = null;
  // 直前に換算したフレームの timestamp (マイクロ秒)
  private lastConvertedMediaMicros: number | null = null;

  /**
   * 読んだフレームを記録する (フレームを読むたびに呼ぶ)
   *
   * @param mediaMicros - フレームの timestamp (マイクロ秒)
   * @param wallClockMillis - フレームを読んだときの壁時計 (Unix epoch ミリ秒。呼び出し側が
   *   `performance.timeOrigin + performance.now()` を渡す)
   */
  observe(mediaMicros: number, wallClockMillis: number): void {
    const offsetMicros = Math.round(wallClockMillis * 1_000) - mediaMicros;
    if (this.targetOffsetMicros === null || offsetMicros < this.targetOffsetMicros) {
      this.targetOffsetMicros = offsetMicros;
    }
  }

  /**
   * フレームの timestamp を壁時計 (Unix epoch マイクロ秒) に換算する
   *
   * 対応を後から小さくすると、換算した TIMESTAMP が前のフレームより戻ることがある
   * (受信側は TIMESTAMP の順と間隔を再生に使う)。換算に使う対応は目標 (最小値) へ向けて
   * 動かすが、1 回の換算で動かす量を前に換算したフレームとの timestamp の差の半分未満に
   * 抑える。換算した TIMESTAMP の差は timestamp の差の半分より大きく保たれ、単調に増える。
   * 30 fps では 1 回あたり約 16.7 ms 未満であり、開始時の数百 ms の遅れは 1 秒ほどで
   * 埋まる。LOC の TIMESTAMP は vi64 で負を表せないため、Unix epoch より前にはしない。
   *
   * @param mediaMicros - フレームの timestamp (マイクロ秒)
   * @param fallbackWallClockMillis - まだフレームを 1 つも記録していないときに、このフレームを
   *   その時刻に読んだとみなす壁時計 (Unix epoch ミリ秒)
   * @throws Error フレームを記録しておらず fallbackWallClockMillis も無い場合
   */
  toWallClockMicroseconds(mediaMicros: number, fallbackWallClockMillis?: number): bigint {
    if (this.targetOffsetMicros === null) {
      if (fallbackWallClockMillis === undefined) {
        throw new Error("no video frame observed before converting its timestamp to wall clock");
      }
      this.observe(mediaMicros, fallbackWallClockMillis);
    }
    const targetOffsetMicros = this.targetOffsetMicros ?? 0;
    let appliedOffsetMicros = this.appliedOffsetMicros ?? targetOffsetMicros;
    if (targetOffsetMicros < appliedOffsetMicros && this.lastConvertedMediaMicros !== null) {
      // timestamp の差の半分未満 (1 マイクロ秒引く) だけ動かす
      const maxStepMicros = Math.max(0, (mediaMicros - this.lastConvertedMediaMicros) / 2 - 1);
      appliedOffsetMicros = Math.max(targetOffsetMicros, appliedOffsetMicros - maxStepMicros);
    }
    this.appliedOffsetMicros = appliedOffsetMicros;
    this.lastConvertedMediaMicros = mediaMicros;
    return BigInt(Math.max(0, Math.round(mediaMicros + appliedOffsetMicros)));
  }
}
