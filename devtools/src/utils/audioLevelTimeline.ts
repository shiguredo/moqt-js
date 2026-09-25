/**
 * 符号化へ渡した音声のサンプルを時刻つきで記録し、符号化された chunk の LOC Audio Level を
 * 求める
 *
 * RFC 6464 Section 3 は audio level を「ペイロードが符号化するサンプルの RMS」で -dBov と
 * して測ると定める (draft-ietf-moq-loc-04 Section 2.3.3.2 の LOC Audio Level はこれに従う)。
 * 音声のトラックから読む AudioData (マイクでは 10 ms など) と、AudioEncoder が出す chunk
 * (Opus では 20 ms など) は区切りが違うため、AudioData ごとの二乗和、数、peak を記録し、
 * chunk の時間の範囲に重なる分を足し合わせて求める。時刻は AudioData と chunk の timestamp
 * (マイクロ秒) である。
 */

import {
  levelFromSampleStats,
  sampleStatsOf,
  type SampleStats,
  type ToneAudioLevel,
} from "../webcodecs-devtools/utils/dummyAudio";

/** duration が分からない chunk の範囲 (マイクロ秒)。Opus の既定のフレーム長 */
const DEFAULT_CHUNK_DURATION_US = 20_000;

/**
 * 記録の上限 (件数)。chunk が出てこない (符号化が止まった) 間も際限なく溜めない。
 * 10 ms の AudioData で 5 秒分
 */
const DEFAULT_MAX_ENTRIES = 500;

interface TimelineEntry extends SampleStats {
  startUs: number;
  endUs: number;
}

export class AudioLevelTimeline {
  private entries: TimelineEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** 記録している件数 */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 符号化へ渡すサンプル列を記録する
   *
   * @param timestampUs - AudioData の timestamp (マイクロ秒)
   * @param durationUs - AudioData の duration (マイクロ秒)
   * @param samples - 全チャンネルのサンプル列
   */
  record(timestampUs: number, durationUs: number, samples: Float32Array): void {
    this.entries.push({
      ...sampleStatsOf(samples),
      startUs: timestampUs,
      endUs: timestampUs + durationUs,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /**
   * 符号化された chunk の LOC Audio Level を求める
   *
   * chunk の範囲 (timestamp から duration の間) に重なる記録を足し合わせる。重なる記録が
   * 無ければ 127 (デジタル無音) である。求めた後は、この chunk より前に終わる記録を捨てる
   *
   * @param timestampUs - chunk の timestamp (マイクロ秒)
   * @param durationUs - chunk の duration (マイクロ秒)。分からなければ null (20 ms とみなす)
   */
  levelFor(timestampUs: number, durationUs: number | null): ToneAudioLevel {
    const endUs = timestampUs + (durationUs ?? DEFAULT_CHUNK_DURATION_US);
    const total: SampleStats = { sumOfSquares: 0, count: 0, peak: 0 };
    for (const entry of this.entries) {
      if (entry.endUs <= timestampUs || entry.startUs >= endUs) {
        continue;
      }
      total.sumOfSquares += entry.sumOfSquares;
      total.count += entry.count;
      total.peak = Math.max(total.peak, entry.peak);
    }
    this.entries = this.entries.filter((entry) => entry.endUs > timestampUs);
    return levelFromSampleStats(total);
  }
}
