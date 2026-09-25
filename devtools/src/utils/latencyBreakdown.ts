/**
 * 受信した映像フレームの遅延を区間ごとに分けて記録する
 *
 * 遅延が大きいとき、原因が publisher・経路・relay (sora-moq)・subscriber (moqt-js) のどれに
 * あるかを分けるため、描いたフレームごとに次の区間の時間を記録する。区間は同じフレームの
 * 時刻で測るため、フレームごとに「到着 + 保留 + 復号待ち + 復号 + 表示待ち = 表示の遅延」が
 * 成り立つ。
 *
 * - 到着 (arrival): TIMESTAMP から受信まで。publisher の符号化と送信、経路、relay を含む
 * - 保留 (hold): 受信から Group の切り替えの保留を出るまで
 * - 復号待ち (decodeWait): 保留を出てから decoder に渡すまで (復号の順序の待ちなど)
 * - 復号 (decode): decoder に渡してから出力まで
 * - 表示待ち (displayWait): decoder の出力から描くまで (jitter buffer の待ちと描画の周期)
 * - 表示の遅延 (displayLatency): TIMESTAMP から描くまで
 *
 * 到着と表示の遅延は、TIMESTAMP が壁時計 (draft-ietf-moq-loc-04 Section 2.3.1.1) のフレーム
 * だけで求める。LOC の TIMESTAMP は publisher がフレームを読んだ時刻の壁時計であり、別の
 * マシンでは publisher と subscriber の時計のずれを含む。
 *
 * ブラウザ API に依存しないよう、時刻は呼び出し側が引数で渡す (`performance.now()`)。
 */

import { TimedValues } from "./timedValues";

/** 区間の並び (表示の順) */
export const LATENCY_SEGMENTS = [
  "arrival",
  "hold",
  "decodeWait",
  "decode",
  "displayWait",
  "displayLatency",
] as const;

/** 区間 */
export type LatencySegment = (typeof LATENCY_SEGMENTS)[number];

/** 描くまでのフレームの時刻 (`performance.now()`、ミリ秒) */
interface FrameTimes {
  readonly receivedAtMs: number;
  readonly wallClock: boolean;
  releasedAtMs: number | null;
  decodeStartMs: number | null;
  decodedAtMs: number | null;
}

/**
 * 描いたフレームの区間ごとの時間を直近の窓で記録する
 */
export class LatencyBreakdown {
  private readonly windowMs: number;
  private readonly timeOriginMs: number;
  // TIMESTAMP (マイクロ秒) ごとの時刻。受け取った順に並ぶ
  private frames = new Map<number, FrameTimes>();
  private readonly values: Record<LatencySegment, TimedValues>;

  /**
   * @param windowMs - 区間の時間を残す直近の窓 (ミリ秒)。描かなかったフレームの時刻も
   *   この間だけ残す
   * @param timeOriginMs - `performance.timeOrigin`。受信と描いた時刻を壁時計に換算する
   */
  constructor(windowMs: number, timeOriginMs: number) {
    this.windowMs = windowMs;
    this.timeOriginMs = timeOriginMs;
    const values = {} as Record<LatencySegment, TimedValues>;
    for (const segment of LATENCY_SEGMENTS) {
      values[segment] = new TimedValues();
    }
    this.values = values;
  }

  /**
   * フレームを受け取ったことを記録する
   *
   * @param wallClock - TIMESTAMP が壁時計か。壁時計でなければ到着と表示の遅延を求めない
   */
  recordReceived(timestampMicros: number, nowMs: number, wallClock: boolean): void {
    this.pruneFrames(nowMs);
    if (this.frames.has(timestampMicros)) {
      return;
    }
    this.frames.set(timestampMicros, {
      receivedAtMs: nowMs,
      wallClock,
      releasedAtMs: null,
      decodeStartMs: null,
      decodedAtMs: null,
    });
  }

  /** Group の切り替えの保留を出たことを記録する */
  recordReleased(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.releasedAtMs === null) {
      frame.releasedAtMs = nowMs;
    }
  }

  /** decoder に渡したことを記録する */
  recordDecodeStart(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.decodeStartMs === null) {
      frame.decodeStartMs = nowMs;
    }
  }

  /** decoder が出力したことを記録する */
  recordDecodeOutput(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.decodedAtMs === null) {
      frame.decodedAtMs = nowMs;
    }
  }

  /**
   * フレームを描いたことを記録し、区間ごとの時間を加える
   *
   * 受信から出力までの時刻が揃っていないフレーム (記録の前に受け取った、窓を過ぎた) は
   * 加えない。区間の和が表示の遅延と一致しなくなるため
   */
  recordDisplayed(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame === undefined) {
      return;
    }
    this.frames.delete(timestampMicros);
    const { receivedAtMs, releasedAtMs, decodeStartMs, decodedAtMs } = frame;
    if (releasedAtMs === null || decodeStartMs === null || decodedAtMs === null) {
      return;
    }
    const timestampMs = timestampMicros / 1_000;
    if (frame.wallClock) {
      this.values.arrival.push(nowMs, this.timeOriginMs + receivedAtMs - timestampMs);
    }
    this.values.hold.push(nowMs, releasedAtMs - receivedAtMs);
    this.values.decodeWait.push(nowMs, decodeStartMs - releasedAtMs);
    this.values.decode.push(nowMs, decodedAtMs - decodeStartMs);
    this.values.displayWait.push(nowMs, nowMs - decodedAtMs);
    if (frame.wallClock) {
      this.values.displayLatency.push(nowMs, this.timeOriginMs + nowMs - timestampMs);
    }
  }

  /**
   * 直近の窓の区間ごとの時間 (描いた順)
   *
   * @param nowMs - 求める時刻 (`performance.now()`)。窓はこの時刻から遡る
   */
  current(nowMs: number): Record<LatencySegment, number[]> {
    const minAtMs = nowMs - this.windowMs;
    const result = {} as Record<LatencySegment, number[]>;
    for (const segment of LATENCY_SEGMENTS) {
      const values = this.values[segment];
      values.prune(minAtMs);
      result[segment] = values.current();
    }
    return result;
  }

  /** 記録をすべて捨てる */
  reset(): void {
    this.frames = new Map();
    for (const segment of LATENCY_SEGMENTS) {
      this.values[segment].clear();
    }
  }

  /**
   * 窓より前に受け取ったフレームの時刻を捨てる
   *
   * 描かなかったフレーム (捨てた、復号しなかった) の時刻が残り続けないようにする。
   * Map は受け取った順に並ぶため、先頭から窓の中に入るまで捨てる
   */
  private pruneFrames(nowMs: number): void {
    const minAtMs = nowMs - this.windowMs;
    for (const [timestampMicros, frame] of this.frames) {
      if (frame.receivedAtMs >= minAtMs) {
        break;
      }
      this.frames.delete(timestampMicros);
    }
  }
}
