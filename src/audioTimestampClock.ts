/**
 * 音声の TIMESTAMP を配信側の壁時計へ合わせる
 *
 * LOC の TIMESTAMP は Timescale を載せないとき、取得した時刻の壁時計 (Unix epoch
 * マイクロ秒) である (draft-ietf-moq-loc-04 §2.3.1.1)。ところがマイクや Web Audio から
 * 届く `AudioData.timestamp` は `performance.now()` と同じ時計ではない。
 * そのまま `performance.timeOrigin` で換算して送ると、受信側は「音声は数百 ms 遅れて
 * 届いている」と解釈し、リップシンクのために映像をその分だけ遅らせる。
 *
 * そこで `AudioData.timestamp` の刻み (サンプルの間隔) はそのまま使い、原点 (オフセット)
 * だけを壁時計へ合わせる。オフセットは「読み出した壁時計 - `AudioData.timestamp`」であり、
 * これは「音声の時計と壁時計のずれ」と「撮ってから読むまでの遅れ (0 以上)」の和である。
 * 遅れの最小値を窓で取り直すことで、ずれに最小の遅れを足した値を推定する。
 *
 * 窓の最小値は 2 つの動きに追従する。
 *
 * - ゆっくりしたドリフト: 窓が滑るにつれて最小値が動く
 * - 段差: 直近の窓の最小値が適用中の値より `AUDIO_TIMESTAMP_OFFSET_STEP_MICROS` 以上
 *   大きくなったら、古い観測を捨ててその値へ取り直す。段差は音声の時計そのものが飛んだ
 *   のであり、遅れが増えたのではない。取り直しを入れるのは、窓が埋まるまで TIMESTAMP が
 *   実際より古いままになり、受信側の再生の目標が過去へずれて音が捨てられるためである。
 *
 * この 2 つの規則でも、補正の値は「観測した最大値と最小値の差」の範囲でしか動かない。
 * 段差やドリフトの量そのものは `snapshot()` が返す生の観測の統計 (現在値・最小・最大・
 * 傾き) で確かめる。
 *
 * ブラウザ API に依存しない (時刻は呼び出し側が渡す)。
 */

/**
 * 補正に使う観測の窓 (ミリ秒)
 *
 * 短くするほどドリフトと段差への追従が速くなり、経路ではなく読み出しの揺らぎで最小値が
 * 動きやすくなる。音声は 20 ms ごとに読むため、2 秒の窓には約 100 個の観測が入る。
 * 読み出しの揺らぎは数 ms であり、最小値はほぼ一定になる
 */
export const AUDIO_TIMESTAMP_OFFSET_WINDOW_MS = 2_000;

/**
 * 段差とみなす、適用中の補正からの上振れ (マイクロ秒)
 *
 * ドリフトでも「直近の窓の最小値」は「補正の窓の最小値」より大きくなる。その差は
 * ドリフトの速さ × (補正の窓 - 直近の窓) であり、実測した速さ (50 ms/秒 程度) でも
 * 100 ms に届かない。読み出しの遅れが 200 ms 以上ぶれて、その状態が 0.5 秒続くことは
 * 考えにくいため、段差と遅れの増加をこの値で分ける
 */
export const AUDIO_TIMESTAMP_OFFSET_STEP_MICROS = 200_000;

/** 段差を見る直近の窓 (ミリ秒) */
export const AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS = 500;

/**
 * 段差とみなすのに必要な、直近の窓の観測の数
 *
 * 音声は 20 ms ごとに届くため、0.5 秒の窓には約 25 個入る。5 個未満では
 * 「たまたま遅れて読めた数個」だけで取り直してしまう
 */
export const AUDIO_TIMESTAMP_OFFSET_STEP_MIN_SAMPLES = 5;

/** 傾きを求める短い窓 (ミリ秒) */
export const AUDIO_TIMESTAMP_SLOPE_WINDOW_MS = 10_000;

/** 傾きを求める長い窓 (ミリ秒) */
export const AUDIO_TIMESTAMP_SLOPE_LONG_WINDOW_MS = 60_000;

/** 観測した 1 つの音声フレームの対応 */
interface AudioTimestampObservation {
  /** 読み出したときの壁時計 (Unix epoch マイクロ秒) */
  readonly readWallClockMicros: number;
  /** 読み出した壁時計 - `AudioData.timestamp` (マイクロ秒) */
  readonly offsetMicros: number;
}

/** 窓の中の観測のまとめ */
interface OffsetWindow {
  /** 最小のオフセット (マイクロ秒) */
  readonly minMicros: number;
  /** 窓の中の観測の数 */
  readonly count: number;
}

/**
 * 音声の TIMESTAMP を壁時計へ合わせる (配信の音声ごとに 1 つ持つ)
 *
 * 読み出した `AudioData` ごとに `record()` を呼び、符号化された chunk の timestamp を
 * `apply()` で壁時計のマイクロ秒へ換算する。
 */
export class AudioTimestampClock {
  // 直近の観測。時刻の昇順に入る
  private observations: AudioTimestampObservation[] = [];
  // 捨てた先頭の位置。配列を詰め直さないために持つ
  private head = 0;
  // TIMESTAMP に足している補正 (マイクロ秒)。まだ観測が無ければ null
  private appliedOffsetMicros: number | null = null;
  // 観測した最小値と最大値 (マイクロ秒)。補正の取り直しでは消さない
  private minOffsetMicros: number | null = null;
  private maxOffsetMicros: number | null = null;
  // 観測した数 (セッション中)
  private sampleCount = 0;

  /**
   * 読み出した音声フレームの対応を記録する
   *
   * @param readWallClockMicros - 読み出したときの壁時計 (Unix epoch マイクロ秒)。
   *   呼び出し側が `performance.timeOrigin + performance.now()` から求める
   * @param audioTimestampMicros - `AudioData.timestamp` (マイクロ秒)
   */
  record(readWallClockMicros: bigint, audioTimestampMicros: number): void {
    const readMicros = Number(readWallClockMicros);
    const offsetMicros = readMicros - audioTimestampMicros;

    this.observations.push({ readWallClockMicros: readMicros, offsetMicros });
    this.sampleCount++;
    this.minOffsetMicros =
      this.minOffsetMicros === null ? offsetMicros : Math.min(this.minOffsetMicros, offsetMicros);
    this.maxOffsetMicros =
      this.maxOffsetMicros === null ? offsetMicros : Math.max(this.maxOffsetMicros, offsetMicros);

    // 統計と補正に使う窓の外の観測を捨てる
    const observationWindowMs = Math.max(
      AUDIO_TIMESTAMP_SLOPE_LONG_WINDOW_MS,
      AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS,
    );
    this.prune(readMicros - observationWindowMs * 1_000);

    this.updateAppliedOffset(readMicros);
  }

  /**
   * 符号化された chunk の timestamp を壁時計 (Unix epoch マイクロ秒) へ換算する
   *
   * 補正は記録のたびにしか動かないため、同じ補正を当てた chunk どうしの間隔は
   * `AudioData.timestamp` の間隔そのままになる。補正を当てる前 (観測が 1 つも無い) は
   * null を返し、呼び出し側が従来の換算へ落とせるようにする
   *
   * @param audioTimestampMicros - 符号化された chunk の timestamp (マイクロ秒)
   */
  apply(audioTimestampMicros: number): bigint | null {
    const appliedOffsetMicros = this.appliedOffsetMicros;
    if (appliedOffsetMicros === null) {
      return null;
    }
    // LOC の TIMESTAMP は vi64 で負を表せないため、Unix epoch より前にはしない
    return BigInt(Math.max(0, Math.round(audioTimestampMicros + appliedOffsetMicros)));
  }

  /** いま使っている補正 (マイクロ秒)。まだ決まっていなければ null */
  get appliedMicros(): bigint | null {
    return this.appliedOffsetMicros === null ? null : BigInt(this.appliedOffsetMicros);
  }

  /**
   * 観測の統計 (現在値・最小・最大・10 秒と 60 秒の傾き)
   *
   * 値はすべて「読み出した壁時計 - `AudioData.timestamp`」の生の観測である (補正を
   * 当てる前の値)。まだ観測が無ければ null
   */
  snapshot(): AudioTimestampOffsetStats | null {
    const latest = this.latestObservation();
    if (latest === null) {
      return null;
    }
    return {
      currentMs: latest.offsetMicros / 1_000,
      minMs: (this.minOffsetMicros ?? latest.offsetMicros) / 1_000,
      maxMs: (this.maxOffsetMicros ?? latest.offsetMicros) / 1_000,
      slope10sMsPerSecond: this.slopeMsPerSecond(AUDIO_TIMESTAMP_SLOPE_WINDOW_MS),
      slope60sMsPerSecond: this.slopeMsPerSecond(AUDIO_TIMESTAMP_SLOPE_LONG_WINDOW_MS),
      appliedMs: this.appliedOffsetMicros === null ? null : this.appliedOffsetMicros / 1_000,
      samples: this.sampleCount,
    };
  }

  /** 観測と補正を消す (配信のやり直し) */
  reset(): void {
    this.observations = [];
    this.head = 0;
    this.appliedOffsetMicros = null;
    this.minOffsetMicros = null;
    this.maxOffsetMicros = null;
    this.sampleCount = 0;
  }

  /**
   * 補正を窓の最小値へ合わせる。段差なら窓を取り直す
   *
   * 窓の最小値へ合わせるのは、ゆっくりしたドリフトでも補正が止まらないようにするためである
   * (窓が滑るにつれて最小値が動く)。段差 (時計そのものが飛んだ) のときだけ、2 秒の窓が
   * 埋まるのを待たずに直近の窓から取り直す。待つと、その間だけ TIMESTAMP が実際より古く
   * なり、受信側の再生の目標が過去へずれて音が捨てられる
   */
  private updateAppliedOffset(readMicros: number): void {
    const window = this.offsetWindow(readMicros, AUDIO_TIMESTAMP_OFFSET_WINDOW_MS);
    if (window === null) {
      return;
    }
    const appliedMicros = this.appliedOffsetMicros;

    // 段差かどうか。直近の窓がすべて適用中の値より上にあるときだけ取り直す
    if (appliedMicros !== null) {
      const recent = this.offsetWindow(readMicros, AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS);
      if (
        recent !== null &&
        recent.count >= AUDIO_TIMESTAMP_OFFSET_STEP_MIN_SAMPLES &&
        recent.minMicros - appliedMicros >= AUDIO_TIMESTAMP_OFFSET_STEP_MICROS
      ) {
        this.appliedOffsetMicros = recent.minMicros;
        // 古い観測を捨てる。残すと次の記録でまた古い床へ戻ってしまう
        this.prune(readMicros - AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS * 1_000);
        return;
      }
    }

    // 床へ合わせる。下がる方向 (より早く読めた) も上がる方向 (ドリフト) も同じ規則である。
    // 補正が実際より大きくなる (TIMESTAMP が実際より新しくなる) と、受信側の再生の目標が
    // 過去になって音が捨てられるため、常に観測した床を超えない値にする
    this.appliedOffsetMicros = window.minMicros;
  }

  /** 直近の窓の最小値と観測の数 */
  private offsetWindow(readMicros: number, windowMs: number): OffsetWindow | null {
    return this.offsetWindowBetween(readMicros - windowMs * 1_000, readMicros);
  }

  /** 指定した範囲 (マイクロ秒、両端を含む) の最小値と観測の数 */
  private offsetWindowBetween(sinceMicros: number, untilMicros: number): OffsetWindow | null {
    let minMicros: number | null = null;
    let count = 0;
    for (let index = this.observations.length - 1; index >= this.head; index--) {
      const observation = this.observations[index];
      if (observation === undefined) {
        continue;
      }
      if (observation.readWallClockMicros < sinceMicros) {
        break;
      }
      if (observation.readWallClockMicros > untilMicros) {
        continue;
      }
      minMicros =
        minMicros === null
          ? observation.offsetMicros
          : Math.min(minMicros, observation.offsetMicros);
      count++;
    }
    if (minMicros === null) {
      return null;
    }
    return { minMicros, count };
  }

  /** 窓の中の最小の観測。無ければ null */
  private minObservationBetween(
    sinceMicros: number,
    untilMicros: number,
  ): AudioTimestampObservation | null {
    let best: AudioTimestampObservation | null = null;
    for (let index = this.observations.length - 1; index >= this.head; index--) {
      const observation = this.observations[index];
      if (observation === undefined) {
        continue;
      }
      if (observation.readWallClockMicros < sinceMicros) {
        break;
      }
      if (observation.readWallClockMicros > untilMicros) {
        continue;
      }
      if (best === null || observation.offsetMicros < best.offsetMicros) {
        best = observation;
      }
    }
    return best;
  }

  /**
   * 窓の傾き (ミリ秒 / 秒)
   *
   * 窓を前半と後半に分け、それぞれの最小の観測の差から求める。両端とも最小値 (床) を
   * 使うため、読み出しの遅れの揺らぎを受けにくい。観測がまだ窓を埋めていないときは、
   * 観測がある範囲で求める (傾きを出せるだけの幅が無いときは null)
   */
  private slopeMsPerSecond(windowMs: number): number | null {
    const latest = this.latestObservation();
    const oldest = this.oldestObservation();
    if (latest === null || oldest === null) {
      return null;
    }
    const sinceMicros = Math.max(
      latest.readWallClockMicros - windowMs * 1_000,
      oldest.readWallClockMicros,
    );
    const middleMicros = sinceMicros + (latest.readWallClockMicros - sinceMicros) / 2;
    const older = this.minObservationBetween(sinceMicros, middleMicros);
    const newer = this.minObservationBetween(middleMicros, latest.readWallClockMicros);
    if (older === null || newer === null) {
      return null;
    }
    const spanMicros = newer.readWallClockMicros - older.readWallClockMicros;
    if (spanMicros <= 0) {
      return null;
    }
    return ((newer.offsetMicros - older.offsetMicros) / spanMicros) * 1_000;
  }

  /** 直近の観測。無ければ null */
  private latestObservation(): AudioTimestampObservation | null {
    for (let index = this.observations.length - 1; index >= this.head; index--) {
      const observation = this.observations[index];
      if (observation !== undefined) {
        return observation;
      }
    }
    return null;
  }

  /** 最も古い観測。無ければ null */
  private oldestObservation(): AudioTimestampObservation | null {
    for (let index = this.head; index < this.observations.length; index++) {
      const observation = this.observations[index];
      if (observation !== undefined) {
        return observation;
      }
    }
    return null;
  }

  /** 指定した時刻より古い観測を捨てる */
  private prune(oldestMicros: number): void {
    while (this.head < this.observations.length) {
      const observation = this.observations[this.head];
      if (observation === undefined || observation.readWallClockMicros >= oldestMicros) {
        break;
      }
      this.head++;
    }
    if (this.head > 0 && this.head * 2 >= this.observations.length) {
      this.observations = this.observations.slice(this.head);
      this.head = 0;
    }
  }
}

/** 観測の統計 (配信側の Publisher 統計と devtools に出す) */
export interface AudioTimestampOffsetStats {
  /** 直近に観測した「読み出しの壁時計 - `AudioData.timestamp`」(ミリ秒) */
  currentMs: number;
  /** 観測した最小値 (ミリ秒)。補正の取り直しでは消えない */
  minMs: number;
  /** 観測した最大値 (ミリ秒)。補正の取り直しでは消えない */
  maxMs: number;
  /**
   * 直近 10 秒の傾き (ミリ秒 / 秒)。一定なら 0、ずれ続けるなら 0 から離れる。
   * 観測が足りなければ null
   */
  slope10sMsPerSecond: number | null;
  /** 直近 60 秒の傾き (ミリ秒 / 秒)。観測が足りなければ null */
  slope60sMsPerSecond: number | null;
  /** TIMESTAMP に足している補正 (ミリ秒)。まだ決まっていなければ null */
  appliedMs: number | null;
  /** 観測した数 */
  samples: number;
}
