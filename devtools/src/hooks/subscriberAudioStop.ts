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
 * 二重に呼ばれた場合は同じ Promise を返す。停止の完了を待てない経路 (パネルの削除、
 * アンマウント、セッションの close 通知) は返値の Promise を待たずに呼び、`AudioContext`
 * はこの処理が必ず閉じる。
 *
 * preact の外へ出してあるのは、停止の順序と二重呼び出しの規則をブラウザ API 無しで
 * 検証するためである (既存の検証と同じく、注入する記録用オブジェクトで駆動する)。
 */

import type { MediaPlayoutDrainOptions } from "moqt-js";
import { AUDIO_PLAYOUT_DRAIN_MAX_MS } from "../../../src/playout/audioPlayoutSession.ts";

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
  /**
   * 前の停止で付けたままの flush の印を捨てる
   *
   * 復号の出力が落ちた (復号器の reset・復号の失敗・停止後に走るチェーンの末尾) 場合に
   * 印が残ると、次の停止で停止前投入分の出力がその印を消費し、drain が早く終わる
   */
  resetFlushedMarks?: () => void;
  /** `AudioContext` を閉じる (失敗は握り潰す) */
  closeAudioContext: () => Promise<void>;
  /** drain と close が終わったあとの後始末 (時間軸から音声の状態を消すなど) */
  onStopped?: () => void;
}

/** 購読の停止時に音声を鳴らし切る処理 */
export class SubscriberAudioStop {
  // 進行中の停止処理 (二重呼び出しで共有する)
  private stopPromise: Promise<void> | null = null;
  // flush したが、まだ復号の出力が届いていない Object の数
  private flushPending = 0;
  // 停止の処理中か (遅れて届く Object を復号へ積まないために呼び出し側が見る)
  private stoppingFlag = false;

  /**
   * flush した Object の復号の出力を待つのをやめる
   *
   * drain の間に復号器が作り直されると、flush 分の出力は届かない。残りの予約だけを
   * 待つようにして、上限まで空回りさせない
   */
  discardFlushedOutputs(): void {
    this.flushPending = 0;
  }

  /** 停止の処理中か */
  get isStopping(): boolean {
    return this.stoppingFlag;
  }

  /**
   * flush した Object の復号の出力が 1 つ届いた (待ちを減らす)
   *
   * 停止の前に復号器へ投入していた Object の出力では呼ばない。呼び出し側が flush 分の
   * 投入に印を付け、印の付いた出力だけで減らす
   */
  noteFlushedOutput(): void {
    if (this.flushPending > 0) {
      this.flushPending--;
    }
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
        // 前の停止で付けたままの印を捨てる (次の flush 分だけを数える)
        target.resetFlushedMarks?.();
        // 復号前の段の保持分を flush して復号へ流す。flush の通知先 (復号チェーン) を
        // 外すのは flush の後である (外すと flush した Object が復号へ流れない)
        let flushed = 0;
        try {
          flushed = target.flushAudio();
        } catch {
          // flush の失敗で停止そのものを失敗させない。AudioContext は下で必ず閉じる
        }
        this.flushPending = flushed;
        try {
          // 予約が尽き、かつ flush した分の復号の出力が届くまで待つ
          await target.drain({
            maxWaitMs: AUDIO_PLAYOUT_DRAIN_MAX_MS,
            isFlushSettled: () => this.flushPending === 0,
            flushedObjects: flushed,
            remainingFlushedObjects: () => this.flushPending,
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
          this.flushPending = 0;
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
