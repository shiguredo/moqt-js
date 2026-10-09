/**
 * 音声の TIMESTAMP を配信側の壁時計から作る
 *
 * LOC の TIMESTAMP は Timescale を付けない場合、取得した時刻の壁時計 (Unix epoch
 * マイクロ秒) である (draft-ietf-moq-loc-04 §2.3.1.1)。ところがマイクから届く
 * `AudioData.timestamp` は壁時計と同じ時計ではなく、数百 ms ずれたり、段差で動いたり、
 * 少しずつずれていったりする (issues/0754)。
 *
 * そのまま壁時計として送ると、受信側は「音声は数百 ms 遅れて届いている」と解釈し、
 * リップシンクを取るために映像をその分だけ遅らせる。実測では音声の基準が 313 ms・映像が
 * 13 ms になり、映像の表示の遅延が 483 ms まで伸びていた。
 *
 * そこで、MediaStreamTrackProcessor から**読み出した時刻** (`performance.now()`) を壁時計の
 * 基準にし、`AudioData.timestamp` は読み出しの中でのサンプル位置 (連続する 20 ms の間隔) を
 * 保つためだけに使う。読み出しは音声の処理 (AEC/NS/AGC とオーディオサービス) の分だけ
 * 遅れるため、作った値は真の取得時刻より数十 ms 古くなる (受信側の不感帯 30 ms に収まる側へ
 * 倒す)。
 *
 * ブラウザ API に依存しない (時刻は呼び出し側が渡す)。
 */

/**
 * 読み出しの壁時計を覚えておく数の上限
 *
 * 符号化へ渡してから出力されるまでの間だけ覚える。符号化されなかった (エラーの、
 * 停止した) 分が残り続けないよう、上限を超えたら古い方から忘れる。
 */
export const AUDIO_WALL_CLOCK_MAX_ENTRIES = 64;

/** 読み出しの壁時計の記録 */
interface ReadWallClock {
  /** 壁時計の読み出し時刻 (Unix epoch ミリ秒) */
  readonly wallClockMs: number;
}

export class AudioWallClockTimeline {
  // `AudioData.timestamp` (マイクロ秒) から読み出しの壁時計を引く
  private readonly readWallClocks = new Map<number, ReadWallClock>();

  /**
   * 読み出した `AudioData` の壁時計を記録する
   *
   * @param timestampMicros - `AudioData.timestamp` (マイクロ秒)。符号化された chunk の
   *   timestamp と同じ値であり、この値で引く
   * @param wallClockMs - 読み出した時刻の壁時計 (Unix epoch ミリ秒)
   */
  record(timestampMicros: number, wallClockMs: number): void {
    this.readWallClocks.set(timestampMicros, { wallClockMs });
    while (this.readWallClocks.size > AUDIO_WALL_CLOCK_MAX_ENTRIES) {
      const oldest = this.readWallClocks.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.readWallClocks.delete(oldest.value);
    }
  }

  /**
   * 符号化された chunk の LOC TIMESTAMP (Unix epoch マイクロ秒)
   *
   * @param timestampMicros - 符号化された chunk の timestamp (マイクロ秒)。WebCodecs は
   *   符号化へ渡した `AudioData` の timestamp をそのまま返すため、読み出しの記録を引ける
   * @returns 記録が無ければ null (呼び出し側が従来の換算へフォールバックする)
   */
  wallClockMicrosOf(timestampMicros: number): bigint | null {
    const record = this.readWallClocks.get(timestampMicros);
    if (record === undefined) {
      return null;
    }
    return BigInt(Math.round(record.wallClockMs * 1_000));
  }

  /** 符号化へ渡した記録を消す (停止、やり直し) */
  clear(): void {
    this.readWallClocks.clear();
  }
}
