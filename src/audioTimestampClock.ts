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
 * 窓の最小値は 3 つの動きに追従する。
 *
 * - ゆっくりしたドリフト: 窓が滑るにつれて最小値が動く。上がり方の速さが
 *   `AUDIO_TIMESTAMP_OFFSET_MAX_CLOCK_RISE_MS_PER_SECOND` の中にあるため、そのまま採用する
 * - 段差: 直近の窓の最小値が適用中の値より `AUDIO_TIMESTAMP_OFFSET_STEP_MICROS` 以上
 *   大きくなったら、古い観測を捨ててその値へ取り直す。段差は音声の時計そのものが飛んだ
 *   のであり、遅れが増えたのではない。取り直しを入れるのは、窓が埋まるまで TIMESTAMP が
 *   実際より古いままになり、受信側の再生の目標が過去へずれて音が捨てられるためである
 * - 読み出しの遅れの増加: 遅れが一瞬増えると、窓がその遅れで入れ替わって最小値が上がる。
 *   これは時計のずれではなく、そのまま採用すると送る TIMESTAMP が遅れの分だけ動く
 *   (実測では 95 ms)。受信側はこれを時計のずれとみなして基準の共有を 30 秒解除するため、
 *   遅れが `AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS` 続くまで採用しない
 *
 * この 3 つの規則でも、補正の値は「観測した最大値と最小値の差」の範囲でしか動かない。
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

/**
 * 補正の上昇が「時計のずれ」として速すぎるかどうかを見る間隔 (ミリ秒)
 *
 * この間隔だけ離れた 2 つの窓の最小値を比べる。短くするほど、読み出しの遅れの揺らぎで
 * 差が動きやすくなる。音声は 20 ms ごとに読むため、0.5 秒の間隔には約 25 個の観測が入る
 */
export const AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS = 500;

/**
 * 時計のずれとして追従する、補正の上昇の速さの上限 (ミリ秒 / 秒)
 *
 * 実測したドリフトの速さは 20〜50 ms/秒 (0754) である。その 2 倍を上限にする。これを
 * 超える上昇は、読み出した壁時計と `AudioData.timestamp` の間で読み出しの遅れが増えた
 * のであり、音声の時計が動いたのではないとみなす
 */
export const AUDIO_TIMESTAMP_OFFSET_MAX_CLOCK_RISE_MS_PER_SECOND = 100;

/**
 * 速すぎる上昇を採用する前に、その水準が続くのを待つ時間 (ミリ秒)
 *
 * 読み出しの遅れが一瞬増えて戻る場合、遅れが戻れば窓の最小値も戻るため、この時間の間に
 * 採用を見送れば送る TIMESTAMP は動かない。遅れが戻らず定着した場合 (機械が遅くなった、
 * 読み出しの経路が変わったなど) だけ、その水準を採用する。待つ時間は、2 秒の窓が遅れで
 * 入れ替わるまでの分 (2 秒) と合わせて、読み出しの遅れが 7 秒未満なら動かない長さにする
 */
export const AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS = 5_000;

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
  // 時計のずれにしては速い上昇を採用せずに待ち始めた時刻 (マイクロ秒)。待っていなければ null
  private riseHoldSinceMicros: number | null = null;
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
    this.riseHoldSinceMicros = null;
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
   * なり、受信側の再生の目標が過去へずれて音が捨てられる。
   *
   * 上がる方向にはもう 1 つ条件を置く。読み出しが一瞬遅れただけでも、その遅れで窓が
   * 入れ替わると最小値が上がり、送る TIMESTAMP が遅れの分だけ動く。受信側はこれを時計の
   * ずれとみなして基準の共有を 30 秒解除するため、時計のずれにしては速い上昇は、その水準が
   * `AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS` 続くまで採用しない。下がる方向 (より早く読めた)
   * は今までどおり即座に合わせる
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
        this.riseHoldSinceMicros = null;
        // 古い観測を捨てる。残すと次の記録でまた古い床へ戻ってしまう
        this.prune(readMicros - AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS * 1_000);
        return;
      }
    }

    if (appliedMicros !== null && window.minMicros > appliedMicros) {
      // 上がる方向。待っている最中は、その水準が続く限り採用しない。待ち始めの判断を
      // 毎回やり直すと、窓が遅れで入れ替わった後は「2 つの窓の最小値の差」が 0 になり、
      // 待つのをやめてしまう (遅れの分だけ観測の壁時計も後ろへずれるため、比べる窓から
      // 古い観測が外れる)
      const heldSinceMicros = this.riseHoldSinceMicros;
      if (heldSinceMicros !== null) {
        if (readMicros - heldSinceMicros < AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS * 1_000) {
          return;
        }
      } else if (this.riseIsTooFastForClock(readMicros, window.minMicros)) {
        // 時計のずれにしては速い。読み出しの遅れが増えたとみなして待ち始める
        this.riseHoldSinceMicros = readMicros;
        return;
      }
    }

    // 床へ合わせる。下がる方向 (より早く読めた) も、速くない上昇 (ドリフト) も同じ規則で
    // ある。補正が実際より大きくなる (TIMESTAMP が実際より新しくなる) と、受信側の再生の
    // 目標が過去になって音が捨てられるため、常に観測した床を超えない値にする
    this.riseHoldSinceMicros = null;
    this.appliedOffsetMicros = window.minMicros;
  }

  /**
   * 窓の最小値の上昇が、時計のずれとして考えられる速さを超えているか
   *
   * 「直近の窓の最小値」と「`AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS` 前の窓の最小値」を
   * 比べる。どちらも同じ長さの窓の最小値であるため、読み出しの遅れの揺らぎは両方に同じ
   * ように乗り、差には残らない。ゆっくりしたドリフトでは差が「ドリフトの速さ × 間隔」
   * になるのに対し、読み出しの遅れが増えたときは、窓が入れ替わる時に遅れの増加分がそのまま
   * 差になる。観測がまだ無い間隔 (起動直後や、読み出しが止まっていた後) は判断しない
   *
   * @param readMicros - 読み出したときの壁時計 (Unix epoch マイクロ秒)
   * @param windowMinMicros - 直近の窓の最小値 (マイクロ秒)
   */
  private riseIsTooFastForClock(readMicros: number, windowMinMicros: number): boolean {
    const previous = this.offsetWindowBetween(
      readMicros -
        (AUDIO_TIMESTAMP_OFFSET_WINDOW_MS + AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS) * 1_000,
      readMicros - AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS * 1_000,
    );
    if (previous === null) {
      return false;
    }
    // 速さ (ミリ秒 / 秒) × 間隔 (ミリ秒) が、その間隔で許す上昇 (マイクロ秒) になる
    const allowedMicros =
      AUDIO_TIMESTAMP_OFFSET_MAX_CLOCK_RISE_MS_PER_SECOND * AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS;
    return windowMinMicros - previous.minMicros > allowedMicros;
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
