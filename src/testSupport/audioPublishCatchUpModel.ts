/**
 * 配信側の音声の符号化を模した共有ヘルパー
 *
 * `AudioPublishCatchUp` のテスト (src/audioPublishCatchUp.test.ts と
 * src/audioPublishCatchUp.prop.ts) で共有する。判定するのは本物の
 * `AudioPublishCatchUp` であり、このヘルパーは環境の側 (いつ読み出し、いつ符号化の出力が
 * 返るか) だけを作る。テスト本文を持たないため vitest の `test.include`
 * (`src/**\/*.{test,prop}.ts`) に一致しない名前にして、テストファイルとして収集されるのを
 * 避ける。ライブラリのビルド entry (`src/index.ts`) からも到達しないため、配布物には
 * 含まれない。
 */

import type { AudioPublishCatchUp } from "../audioPublishCatchUp";

/** `PacketizingEncoder` の設定 */
export interface PacketizingEncoderOptions {
  /** 投入する 1 フレームの長さ (マイクロ秒)。devtools の音声は 8 ms (128 フレーム / 16 kHz) */
  readonly frameMicros: number;
  /** 1 つの出力が覆う長さ (マイクロ秒)。opus の 1 パケットは 20 ms */
  readonly packetMicros: number;
  /** 1 パケットを出力するのにかかる時間 (ミリ秒)。実時間より大きいとキューが伸びる */
  drainMsPerPacket: number;
}

/**
 * 入力のフレームを opus のパケットへまとめる符号化器を模した装置
 *
 * 投入されたフレームの長さを足し合わせ、1 パケット分が溜まるたびに出力を返す。
 * `drainMsPerPacket` がパケットの覆う長さより大きいと、出力が実時間に追いつかずキューが
 * 伸びる (実測した「符号化が実時間に追いつかない状態」)。出力は投入の順に
 * `recordEncodedChunk()` へ渡す
 */
export class PacketizingEncoder {
  /** 投入されたが出力が返っていない音声の長さ (マイクロ秒) */
  private handedMicros = 0;
  /** 次に出力が返る時刻 (ミリ秒) */
  private nextOutputAtMs = Number.NEGATIVE_INFINITY;
  private readonly frameMicros: number;
  private readonly packetMicros: number;
  /** 1 パケットを出力するのにかかる時間 (ミリ秒) */
  public drainMsPerPacket: number;

  constructor(
    private readonly catchUp: AudioPublishCatchUp,
    options: PacketizingEncoderOptions,
  ) {
    this.frameMicros = options.frameMicros;
    this.packetMicros = options.packetMicros;
    this.drainMsPerPacket = options.drainMsPerPacket;
  }

  /** フレームを投入した (`nowMs` は投入した時刻) */
  encode(nowMs: number): void {
    this.handedMicros += this.frameMicros;
    this.nextOutputAtMs = Math.max(this.nextOutputAtMs, nowMs);
  }

  /** `nowMs` までに返るはずの出力を返す */
  drain(nowMs: number): void {
    while (this.handedMicros >= this.packetMicros && this.nextOutputAtMs <= nowMs) {
      this.catchUp.recordEncodedChunk({
        timestampMicros: 0,
        durationMicros: this.packetMicros,
        nowMs: this.nextOutputAtMs,
      });
      this.handedMicros -= this.packetMicros;
      this.nextOutputAtMs += this.drainMsPerPacket;
    }
  }

  /** 投入されたが出力が返っていない音声の長さ (ミリ秒) */
  get pendingMs(): number {
    return this.handedMicros / 1_000;
  }
}
