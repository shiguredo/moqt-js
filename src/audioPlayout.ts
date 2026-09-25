/**
 * 復号した音声を鳴らす時刻を決める
 *
 * 復号した音声 (Opus なら 20 ms ごとの `AudioData`) を、復号の出力が届いたその場で
 * `AudioBufferSourceNode.start()` で鳴らすと、届く間隔の揺らぎ (経路と復号) で前の音と
 * 重なって足されるか、隙間が空いて、ノイズに聞こえる。音を再生の遅れだけ遅らせ、
 * timestamp の間隔どおりに途切れなく並べて鳴らす。
 *
 * - 最初の音で基準を決め、鳴らす時刻を「基準の時刻 + (timestamp - 基準の timestamp)」にする。
 *   基準の時刻は、最初の音が届いた時刻 + 再生の遅れ。音が抜けたときはその分の無音を残す
 * - timestamp が前の音より進んでいないとき (TIMESTAMP が無く 0 のまま、同じ値など) は、
 *   前の音のすぐ後ろに並べる。どの音も前の音の終わりより前には鳴らさない (重ねない)
 * - 鳴らす時刻が今 + 余裕より前になる音 (過ぎてから届いた音) では、基準を取り直し、
 *   今 + 再生の遅れに鳴らす
 * - 遅れ (鳴らす時刻 - 今) が上限を超える音は、並べる音が溜まりすぎているなら捨て、基準を
 *   その音の長さだけ前に寄せる。次の音が捨てた音の時刻に入るため、途切れずに遅れが縮む。
 *   溜まっていないのに timestamp が大きく飛んだ音 (送る側の再起動、長い抜けなど) は、
 *   捨て続けないよう基準を取り直して鳴らす
 *
 * 時刻は `AudioContext.currentTime` と同じ秒、timestamp は `AudioData.timestamp` と同じ
 * マイクロ秒で扱う。ブラウザ API に依存しない。
 */

/**
 * 再生の遅れ (秒)
 *
 * 届く間隔の揺らぎをこの範囲で吸収する。配備の relay で復号の出力の間隔は p95 約 33 ms、
 * 映像も配信しているときにまれに 160 ms 前後の途切れがある (2026-09-25 の実測)。80 ms では
 * その途切れの後に 1 回基準を取り直し、以降は途切れの分だけ遅れて鳴る
 */
export const AUDIO_PLAYOUT_DELAY_SECONDS = 0.08;

/** 遅れの上限 (秒)。超える分は捨てて縮める */
export const AUDIO_PLAYOUT_MAX_DELAY_SECONDS = 0.3;

/**
 * 鳴らす時刻を今からどれだけ先にするかの下限 (秒)
 *
 * AudioContext は 128 フレーム (48 kHz で約 2.7 ms) ずつ描くため、それより先の時刻を指定する。
 * 画面のスレッドが混んで `start()` が遅れる分も見込む
 */
export const AUDIO_PLAYOUT_MIN_LEAD_SECONDS = 0.01;

/** 再生の遅れ、上限、余裕 (省略時は既定の値) */
export interface AudioPlayoutOptions {
  delaySeconds?: number;
  maxDelaySeconds?: number;
  minLeadSeconds?: number;
}

/** 音を鳴らす時刻 (`AudioContext.currentTime` の秒)、または捨てる */
export type AudioPlayoutDecision = { kind: "play"; startAt: number } | { kind: "drop" };

/** 基準: この timestamp の音をこの時刻に鳴らす */
interface PlayoutAnchor {
  time: number;
  timestampMicroseconds: number;
}

export class AudioPlayoutScheduler {
  private readonly delaySeconds: number;
  private readonly maxDelaySeconds: number;
  private readonly minLeadSeconds: number;
  private anchor: PlayoutAnchor | null = null;
  // 直前に鳴らすと決めた音の終わりの時刻と timestamp
  private lastEnd: number | null = null;
  private lastTimestampMicroseconds: number | null = null;
  private rebaseCount = 0;
  private dropCount = 0;

  constructor(options: AudioPlayoutOptions = {}) {
    this.delaySeconds = options.delaySeconds ?? AUDIO_PLAYOUT_DELAY_SECONDS;
    this.maxDelaySeconds = options.maxDelaySeconds ?? AUDIO_PLAYOUT_MAX_DELAY_SECONDS;
    this.minLeadSeconds = options.minLeadSeconds ?? AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  }

  /** 基準を取り直した回数 (過ぎてから届いた音と、timestamp が大きく飛んだ音) */
  get rebases(): number {
    return this.rebaseCount;
  }

  /** 遅れが上限を超えたため捨てた音の数 */
  get drops(): number {
    return this.dropCount;
  }

  /**
   * 音を鳴らす時刻を決める
   *
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`)
   * @param timestampMicroseconds - 音の timestamp (`AudioData.timestamp`)
   * @param durationSeconds - 音の長さ (`AudioBuffer.duration`)
   */
  schedule(
    nowSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
  ): AudioPlayoutDecision {
    let startAt = this.expectedStartAt(nowSeconds, timestampMicroseconds);
    if (startAt < nowSeconds + this.minLeadSeconds) {
      // 過ぎてから届いた。前の音はすべて今より前に終わっているため、重ならない
      startAt = nowSeconds + this.delaySeconds;
      this.rebase(startAt, timestampMicroseconds);
    } else if (startAt - nowSeconds > this.maxDelaySeconds) {
      const earliest = Math.max(nowSeconds + this.delaySeconds, this.lastEnd ?? -Infinity);
      if (earliest - nowSeconds > this.maxDelaySeconds) {
        // 並べる音が溜まりすぎている。この音を捨て、次の音をこの音の時刻に入れる
        this.dropCount += 1;
        if (this.anchor !== null) {
          this.anchor.time -= durationSeconds;
        }
        return { kind: "drop" };
      }
      // timestamp が大きく飛んだ。前の音のすぐ後ろ (か今 + 再生の遅れ) から並べ直す
      startAt = earliest;
      this.rebase(startAt, timestampMicroseconds);
    }
    this.lastEnd = startAt + durationSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    return { kind: "play", startAt };
  }

  /** 基準を消す。次の音で作り直す (再生を止めた、購読し直したなど) */
  reset(): void {
    this.anchor = null;
    this.lastEnd = null;
    this.lastTimestampMicroseconds = null;
  }

  /** 基準と前の音から、この音を鳴らす時刻を求める (前の音の終わりより前にしない) */
  private expectedStartAt(nowSeconds: number, timestampMicroseconds: number): number {
    if (this.anchor === null) {
      this.anchor = {
        time: nowSeconds + this.delaySeconds,
        timestampMicroseconds,
      };
      return this.anchor.time;
    }
    const advanced =
      this.lastTimestampMicroseconds !== null &&
      timestampMicroseconds > this.lastTimestampMicroseconds;
    const byTimestamp =
      this.anchor.time + (timestampMicroseconds - this.anchor.timestampMicroseconds) / 1_000_000;
    const afterPrevious = this.lastEnd ?? byTimestamp;
    return advanced ? Math.max(byTimestamp, afterPrevious) : afterPrevious;
  }

  private rebase(time: number, timestampMicroseconds: number): void {
    this.anchor = { time, timestampMicroseconds };
    this.rebaseCount += 1;
  }
}
