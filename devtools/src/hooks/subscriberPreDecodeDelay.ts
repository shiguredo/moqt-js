/**
 * moqt-devtools の購読側で復号前の再生遅延を扱う
 *
 * 高レベル API の `MediaSubscriberOptions.preDecodeDelayMs` は生成時に固定するが、
 * moqt-devtools では購読を止めずに再生遅延を変えて挙動を確かめたい。そこで、音声と映像の
 * `PreDecodeDelayStage` をまとめて持ち、購読の開始・停止と、購読中の動的な遅延の変更を
 * 1 か所で扱う。
 *
 * 遅延を 0 にしたときは、保持中の Object を待たずに期限の通知先へ流してから段を止める。
 * 遅延を大きくしたときは段の期限を計算し直し、小さくしたときは保持中の Object の期限も
 * 新しい値で計算し直す。購読していない間の変更は覚えるだけで、次の購読の開始時に使う。
 *
 * 時計とタイマーは差し替えられる。テストでは決定的な実装を渡し、実時間を待たずに動的な
 * 変更とキューへの反映を検証する。
 */

import {
  PreDecodeDelayStage,
  type PreDecodeDelayStageClock,
  type PreDecodeDelayStageOverflow,
} from "../../../src/playout/preDecodeDelayStage.ts";

/** 上限超過の内容 (どちらのメディアの段かを含む) */
export interface SubscriberPreDecodeDelayOverflow extends PreDecodeDelayStageOverflow {
  readonly media: "audio" | "video";
}

/** `SubscriberPreDecodeDelay` の設定 */
export interface SubscriberPreDecodeDelayOptions<TVideo, TAudio> {
  /** 映像 Object が占めるバイト数 */
  readonly bytesOfVideo: (item: TVideo) => number;
  /** 音声 Object が占めるバイト数 */
  readonly bytesOfAudio: (item: TAudio) => number;
  /** 映像の期限が来た Object (積んだ順) */
  readonly onVideoDue: (items: readonly TVideo[]) => void;
  /** 音声の期限が来た Object (積んだ順) */
  readonly onAudioDue: (items: readonly TAudio[]) => void;
  /** 上限超過の通知。購読期間あたりメディアごとに 1 回 */
  readonly onOverflow: (overflow: SubscriberPreDecodeDelayOverflow) => void;
  /** 期限の通知で起きた失敗の通知先 */
  readonly onDueError?: (error: unknown) => void;
  /** 時計とタイマー。省略するとブラウザの実時間を使う */
  readonly clock?: PreDecodeDelayStageClock;
  /** 段が保持してよいバイト数の上限。省略すると段の既定値を使う (テストで小さくする) */
  readonly maxBytes?: number;
  /** 段が保持してよい件数の上限。省略すると段の既定値を使う (テストで小さくする) */
  readonly maxObjects?: number;
}

/**
 * 購読中の復号前の再生遅延 (音声と映像) をまとめて扱う
 *
 * 購読していない間は段を持たない (`isActive` が false)。その間は Object を積まず、
 * 呼び出し側が直接復号へ流す。`start` で段を作り、`stop` で破棄する。
 */
export class SubscriberPreDecodeDelay<TVideo, TAudio> {
  private readonly options: SubscriberPreDecodeDelayOptions<TVideo, TAudio>;
  private videoStage: PreDecodeDelayStage<TVideo> | null = null;
  private audioStage: PreDecodeDelayStage<TAudio> | null = null;
  private delayMsValue = 0;

  /**
   * @param options - 期限の通知先、バイト数の数え方、時計
   */
  constructor(options: SubscriberPreDecodeDelayOptions<TVideo, TAudio>) {
    this.options = options;
  }

  /** 段を持っているか (購読中で遅延が 0 より大きいか) */
  get isActive(): boolean {
    return this.videoStage !== null || this.audioStage !== null;
  }

  /** 現在の遅延 (ミリ秒)。段を持っていない間も最後に設定した値を返す */
  get delayMs(): number {
    return this.delayMsValue;
  }

  /** 映像の段が保持している件数 (テストと計器の確認用) */
  get videoSize(): number {
    return this.videoStage?.size ?? 0;
  }

  /** 音声の段が保持している件数 (テストと計器の確認用) */
  get audioSize(): number {
    return this.audioStage?.size ?? 0;
  }

  /**
   * 購読の開始時に、現在の設定で段を作る
   *
   * 前の購読の段は先に破棄する。遅延が 0 以下なら段を作らず、呼び出し側は直接復号へ流す。
   *
   * @param delayMs - 購読を始めるときの遅延 (ミリ秒)
   */
  start(delayMs: number): void {
    this.stop();
    this.delayMsValue = delayMs;
    if (delayMs <= 0) {
      return;
    }
    this.videoStage = this.createVideoStage(delayMs);
    this.audioStage = this.createAudioStage(delayMs);
  }

  /** 購読の停止時に、段とタイマーを破棄する */
  stop(): void {
    this.videoStage?.stop();
    this.videoStage = null;
    this.audioStage?.stop();
    this.audioStage = null;
  }

  /**
   * 遅延を変更する
   *
   * 0 以下にしたときは、保持中の Object を待たずに期限の通知先へ流してから段を止める
   * (ライブへ追いつく)。0 より大きい値にしたときは、段が無ければ作り、あれば期限を
   * 計算し直す。
   *
   * @param value - 新しい遅延 (ミリ秒)
   */
  setDelayMs(value: number): void {
    this.delayMsValue = value;
    if (value <= 0) {
      this.videoStage?.flush();
      this.videoStage?.stop();
      this.videoStage = null;
      this.audioStage?.flush();
      this.audioStage?.stop();
      this.audioStage = null;
      return;
    }
    if (this.videoStage === null) {
      this.videoStage = this.createVideoStage(value);
    } else {
      this.videoStage.setDelayMs(value);
    }
    if (this.audioStage === null) {
      this.audioStage = this.createAudioStage(value);
    } else {
      this.audioStage.setDelayMs(value);
    }
  }

  /**
   * 映像 Object を段へ積む
   *
   * @param item - 復号前に保持する Object
   * @returns 段が無くて積まなかったときは false (呼び出し側が直接復号へ流す)
   */
  pushVideo(item: TVideo): boolean {
    if (this.videoStage === null) {
      return false;
    }
    this.videoStage.push(item);
    return true;
  }

  /**
   * 音声 Object を段へ積む
   *
   * @param item - 復号前に保持する Object
   * @returns 段が無くて積まなかったときは false (呼び出し側が直接復号へ流す)
   */
  pushAudio(item: TAudio): boolean {
    if (this.audioStage === null) {
      return false;
    }
    this.audioStage.push(item);
    return true;
  }

  /** 映像の段を作る */
  private createVideoStage(delayMs: number): PreDecodeDelayStage<TVideo> {
    return new PreDecodeDelayStage<TVideo>({
      delayMs,
      bytesOf: this.options.bytesOfVideo,
      onDue: this.options.onVideoDue,
      onOverflow: (overflow) => this.options.onOverflow({ media: "video", ...overflow }),
      ...(this.options.onDueError === undefined ? {} : { onDueError: this.options.onDueError }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.maxBytes === undefined ? {} : { maxBytes: this.options.maxBytes }),
      ...(this.options.maxObjects === undefined ? {} : { maxObjects: this.options.maxObjects }),
    });
  }

  /** 音声の段を作る */
  private createAudioStage(delayMs: number): PreDecodeDelayStage<TAudio> {
    return new PreDecodeDelayStage<TAudio>({
      delayMs,
      bytesOf: this.options.bytesOfAudio,
      onDue: this.options.onAudioDue,
      onOverflow: (overflow) => this.options.onOverflow({ media: "audio", ...overflow }),
      ...(this.options.onDueError === undefined ? {} : { onDueError: this.options.onDueError }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.maxBytes === undefined ? {} : { maxBytes: this.options.maxBytes }),
      ...(this.options.maxObjects === undefined ? {} : { maxObjects: this.options.maxObjects }),
    });
  }
}
