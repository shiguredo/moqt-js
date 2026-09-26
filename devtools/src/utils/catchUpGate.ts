/**
 * relay の cache から追いつく途中の Object を、SUBSCRIBE_OK の LARGEST_OBJECT を境界に選別する
 *
 * draft-ietf-moq-transport-21 Section 9.20.18 の LARGEST_OBJECT は、購読した時点で publisher
 * (relay) が持っていた最新の Location である (Object が publish されていれば必須)。この
 * Location 以前の Object は購読より前に publish された分であり、relay は cache から実時間より
 * 速く配る。この Location より後の Object は購読より後に publish された分、つまり live である。
 *
 * 追いつく途中の Object を再生すると、映像は早送りになり、音声は古い内容が鳴る。購読を始める
 * たびに何十秒も前から再生し直すことになり、見る人には意味が無い。このクラスは、境界以前の
 * Object を再生しないための判定だけを持つ。推定を使わないため、jitter buffer の設定や
 * TIMESTAMP の種類に依らない。
 *
 * 境界が無い (購読の時点で Object が無く、LARGEST_OBJECT が省略された) ときは、すべて live
 * として扱う。
 *
 * 根拠の仕様はドラフトであり、将来変更される可能性がある。
 */

import type { Location } from "moqt-js";
import { compareLocations } from "../../../src/session/params.ts";

/**
 * 位置が再生してよいものかどうかの判定
 */
export interface CatchUpDecision {
  /**
   * 再生してよいか。false は cache から届いた分であり、映像は描かず音声は鳴らさない
   */
  readonly live: boolean;
  /**
   * この判定で境界を越えたか (境界より後の最初の Object か)
   *
   * true を返すのは 1 つの購読につき 1 回だけである。境界を越えたことをログに残したり、
   * 画面の「Catching up」を消したりする契機に使う。
   */
  readonly boundaryReached: boolean;
}

/** 境界を越えた後の判定 (毎回作らない) */
const LIVE: CatchUpDecision = { live: true, boundaryReached: false };

/** 境界以前の判定 (毎回作らない) */
const CACHE: CatchUpDecision = { live: false, boundaryReached: false };

/**
 * Track ごとの追いつきの境界
 *
 * 映像と音声は別の Track であり、それぞれの SUBSCRIBE_OK が別の LARGEST_OBJECT を返すため、
 * Track ごとに 1 つ持つ。
 */
export class CatchUpGate {
  /** 境界。未設定、または購読の時点で Object が無いときは null */
  private boundary: Location | null = null;

  /** 境界を越えたか (境界が無いときは追いつく対象が無いため true) */
  private completed = true;

  /**
   * 境界を設定する (SUBSCRIBE_OK の LARGEST_OBJECT)
   *
   * `null` は「購読の時点で Object が無い」であり、追いつく対象が無いため完了として扱う。
   */
  setBoundary(boundary: Location | null): void {
    this.boundary = boundary;
    this.completed = boundary === null;
  }

  /** 境界を越えたか。画面の「Catching up」を消してよいかの判定に使う */
  get catchUpCompleted(): boolean {
    return this.completed;
  }

  /**
   * 位置が分からない Object を再生したことを知らせる
   *
   * 復号の出力から位置を引けない Object (TIMESTAMP を持たないなど) は境界と比べられない。
   * 判定できないまま「Catching up」を出し続けないよう、追いつきを終えたものとして扱う。
   * 境界は消さないため、位置が分かる Object の判定は続く。
   */
  markPositionUnknown(): void {
    this.completed = true;
  }

  /**
   * 位置が再生してよいものかを判定する
   *
   * 境界より後の最初の Object でだけ `boundaryReached` を立てる。境界を越えた後でも、
   * 境界以前の位置の Object (遅着した cache の分) は再生しない。
   */
  evaluate(position: Location): CatchUpDecision {
    if (this.boundary === null) {
      return LIVE;
    }
    if (compareLocations(position, this.boundary) > 0) {
      if (this.completed) {
        return LIVE;
      }
      this.completed = true;
      return { live: true, boundaryReached: true };
    }
    return CACHE;
  }

  /** 購読を始める前の状態に戻す (境界が無く、追いつきは完了している) */
  reset(): void {
    this.boundary = null;
    this.completed = true;
  }
}
