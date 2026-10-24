/**
 * 購読の停止時に音声を鳴らし切る (drain) 処理
 *
 * 停止の要求を受けたら、新規の音声 Object を復号へ積むのを止め、復号前の段に保持して
 * いる Object を flush して復号へ流し、予約済みの音が鳴り終わるまで待ってから
 * `AudioContext` を閉じる。待ち時間の上限は `AUDIO_PLAYOUT_DRAIN_MAX_MS`。
 *
 * 復号前の段の flush の通知先は復号チェーン (非同期) であり、flush した Object の復号の
 * 出力が予約されるのは drain の待ちが始まった後になる。何件 flush したかを覚えておき、
 * 復号の出力が届くたびに減らして 0 になるまで待つ (予約が尽きているだけでは終えない)。
 *
 * flush した Object と復号の出力の対応は、復号へ渡す直前に採番する通し番号で行う
 * (復号の出力は投入順に届くため、出力ごとに先頭の通し番号を取り出す)。停止の開始時に
 * 番号を消さず、停止の開始時点の番号を境界にして「その後に復号へ渡した flush 分だけ」を
 * 待つ。前の停止の flush 分が出力待ちのまま残っていても、今の停止の待ちに含めないためである。
 * 通し番号を捨てるのは購読の開始時 (`resetDrainTracking`) と、復号器が未処理の入力を
 * 捨てたとき (`discardFlushedOutputs`) だけである。
 *
 * 二重に呼ばれた場合は同じ Promise を返す。停止の完了を待てない経路 (パネルの削除、
 * アンマウント、セッションの close 通知) は返値の Promise を待たずに呼び、`AudioContext`
 * はこの処理が必ず閉じる。
 *
 * preact の外へ出してあるのは、停止の順序と二重呼び出しの規則をブラウザ API 無しで
 * 検証するためである (既存の検証と同じく、注入する記録用オブジェクトで駆動する)。
 */

import { AUDIO_PLAYOUT_DRAIN_MAX_MS, type MediaPlayoutDrainOptions } from "moqt-js";

/** 停止処理が使う対象 (フックから渡す) */
export interface SubscriberAudioStopTarget {
  /**
   * 復号前の段の音声を flush して復号へ流す
   *
   * @returns 復号へ流した Object の件数
   */
  flushAudio: () => number;
  /**
   * 予約済みの音が鳴り終わるまで待つ (`MediaPlayout.drainAudio`)
   *
   * 引数は `MediaPlayoutDrainOptions` のうち、待ちの上限 (`maxWaitMs`) と、flush した
   * Object の復号の出力を待つ条件 (`isFlushSettled` / `flushedObjects` /
   * `remainingFlushedObjects`) だけである。
   *
   * これらの項目は停止の経路が必ず渡すため、公開の設定 (すべて省略可能) から実際に渡す
   * 項目だけを取り出し、必須にする
   */
  drain: (
    options: Required<
      Pick<
        MediaPlayoutDrainOptions,
        "maxWaitMs" | "isFlushSettled" | "flushedObjects" | "remainingFlushedObjects"
      >
    >,
  ) => Promise<void>;
  /** `AudioContext` を閉じる (失敗は握り潰す) */
  closeAudioContext: () => Promise<void>;
  /** drain と close が終わったあとの後始末 (時間軸から音声の状態を消すなど) */
  onStopped?: () => void;
}

/** 購読の停止時に音声を鳴らし切る処理 */
export class SubscriberAudioStop {
  // 進行中の停止処理 (二重呼び出しで共有する)
  private stopPromise: Promise<void> | null = null;
  // 復号へ渡した音の通し番号 (復号の出力は投入順に届くため、出力と対応させる)
  private audioDecodeSequence = 0;
  // 復号へ渡したが、まだ出力が届いていない音の通し番号 (投入順)
  private readonly audioDecodeSequences: number[] = [];
  // 停止の flush で復号へ渡した音の通し番号。出力が届くか、捨てるまで残す
  private readonly flushedAudioSequences = new Set<number>();
  // 今の停止で flush した Object の件数 (復号へ渡る前の分を含む)
  private flushedObjects = 0;
  // 今の停止で復号へ渡した flush 分の件数
  private flushedSubmitted = 0;
  // flush したが復号へ渡らなかった件数 (undecodedFlushedObjects に含める)
  private discardedFlushedObjects = 0;
  // 今の停止で待つ flush 分の通し番号の境界 (停止の開始時点の番号。これ以降の分だけ待つ)
  private flushSequenceBoundary = 0;
  // 停止の処理中か (遅れて届く Object を復号へ積まないために呼び出し側が見る)
  private stoppingFlag = false;

  /**
   * 購読を始めるときに、復号の通し番号と flush の待ちを初期化する
   *
   * 停止の開始時には消さない。前の停止の flush 分が出力待ちのまま残っていても、今の停止は
   * 通し番号の境界で区別する。復号器を作り直したときは `discardFlushedOutputs` で外す。
   */
  resetDrainTracking(): void {
    this.audioDecodeSequence = 0;
    this.audioDecodeSequences.length = 0;
    this.flushedAudioSequences.clear();
    this.flushedObjects = 0;
    this.flushedSubmitted = 0;
    this.discardedFlushedObjects = 0;
    this.flushSequenceBoundary = 0;
  }

  /**
   * 復号へ渡す音の通し番号を採番する (復号へ渡す直前に同期で呼ぶ)
   *
   * 通し番号は復号の出力と投入順で対応させるために使う。停止の flush で復号へ流した音は、
   * 出力が届くまで drain の待ちに残す。
   *
   * @param flushed - 停止の flush で復号へ流した音か
   * @returns 採番した通し番号
   */
  noteAudioDecode(flushed: boolean): number {
    const sequence = this.audioDecodeSequence;
    this.audioDecodeSequence += 1;
    this.audioDecodeSequences.push(sequence);
    // 前の停止の flush 分 (今の停止の開始より前の採番) は、今の停止の待ちに含めない
    if (flushed && sequence >= this.flushSequenceBoundary) {
      this.flushedAudioSequences.add(sequence);
      this.flushedSubmitted += 1;
    }
    return sequence;
  }

  /**
   * 復号の出力が 1 つ届いた
   *
   * 復号の出力は投入順に届くため、先頭の通し番号を取り出して flush の待ちから外す。
   */
  noteAudioDecoded(): void {
    const sequence = this.audioDecodeSequences.shift();
    if (sequence !== undefined) {
      this.flushedAudioSequences.delete(sequence);
    }
  }

  /**
   * 復号器が未処理の投入と未到着の出力を捨てた (復号器の reset・復号の失敗)
   *
   * flush 分の通し番号が残ったままだと drain が上限まで待ち続け、実際は届かない出力を
   * 「復号されなかった flush 分」として数えられない。捨てた分は `undecodedFlushedObjects`
   * に含めるため、待ちから外しても残りに数える。
   */
  discardFlushedOutputs(): void {
    this.audioDecodeSequences.length = 0;
    this.discardedFlushedObjects += this.pendingFlushedObjects();
    this.flushedAudioSequences.clear();
  }

  /**
   * flush した Object のうち、復号の出力がまだ届いていない数
   *
   * 復号へまだ渡っていない flush 分 (通し番号がまだ無い) も含む。drain の結果の
   * `undecodedFlushedObjects` に使う。
   */
  get remainingFlushedObjects(): number {
    return (
      Math.max(0, this.flushedObjects - this.flushedSubmitted) +
      this.pendingFlushedObjects() +
      this.discardedFlushedObjects
    );
  }

  /** drain の完了判定。今の停止の flush 分の復号の出力がすべて届いたか */
  get isFlushSettled(): boolean {
    return (
      Math.max(0, this.flushedObjects - this.flushedSubmitted) + this.pendingFlushedObjects() === 0
    );
  }

  /** 停止の処理中か */
  get isStopping(): boolean {
    return this.stoppingFlag;
  }

  /** 今の停止で待つ flush 分のうち、復号の出力がまだ届いていない数 */
  private pendingFlushedObjects(): number {
    let pending = 0;
    for (const sequence of this.flushedAudioSequences) {
      if (sequence >= this.flushSequenceBoundary) {
        pending += 1;
      }
    }
    return pending;
  }

  /**
   * 音声を鳴らし切ってから止める
   *
   * 二重に呼ばれた場合は同じ Promise を返す。処理が終わったあとに呼ぶと、新しい停止として
   * また flush と drain を行う (flush する Object が無ければ drain はすぐ終わる)。
   *
   * @param target - flush・drain・close の対象
   * @returns 停止の完了
   */
  stop(target: SubscriberAudioStopTarget): Promise<void> {
    const inFlight = this.stopPromise;
    if (inFlight !== null) {
      return inFlight;
    }
    const stopping = (async (): Promise<void> => {
      this.stoppingFlag = true;
      try {
        // 前の停止の flush 分は消さず、今の停止で流す分だけを待つ。停止の開始時点の番号より
        // 後に復号へ渡った音だけが、今の停止の flush 分である
        this.flushSequenceBoundary = this.audioDecodeSequence;
        this.flushedObjects = 0;
        this.flushedSubmitted = 0;
        this.discardedFlushedObjects = 0;
        // 復号前の段の保持分を flush して復号へ流す。flush の通知先 (復号チェーン) を
        // 外すのは flush の後である (外すと flush した Object が復号へ流れない)
        let flushed = 0;
        try {
          flushed = target.flushAudio();
        } catch {
          // flush の失敗で停止そのものを失敗させない。AudioContext は下で必ず閉じる
        }
        this.flushedObjects = flushed;
        try {
          // 予約が尽き、かつ flush した分の復号の出力が届くまで待つ
          await target.drain({
            maxWaitMs: AUDIO_PLAYOUT_DRAIN_MAX_MS,
            isFlushSettled: () => this.isFlushSettled,
            flushedObjects: flushed,
            remainingFlushedObjects: () => this.remainingFlushedObjects,
          });
        } catch {
          // drain の失敗で停止そのものを失敗させない。切った量は計器に残らず、残りの
          // 予約は AudioContext を閉じた時点で切られる
        }
      } finally {
        // flush や drain が失敗しても AudioContext は必ず閉じる
        try {
          await target.closeAudioContext();
        } finally {
          target.onStopped?.();
          this.stoppingFlag = false;
        }
      }
    })();
    this.stopPromise = stopping;
    // 完了したら参照を外す (次の購読でまた停止できるようにする)
    const clear = (): void => {
      if (this.stopPromise === stopping) {
        this.stopPromise = null;
      }
    };
    stopping.then(clear, clear);
    return stopping;
  }
}

/** 停止の処理中に画面へ出す文言 (停止中であることを利用者へ示す) */
export const SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE = "Finishing audio playback...";
