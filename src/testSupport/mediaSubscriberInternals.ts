/**
 * `MediaSubscriber` の内部形状をテストから読むための共有ヘルパー
 *
 * 購読 (`MediaSubscriberImpl`) の内部状態のうち、テストで共通に使うものだけをここに置く。
 * テストが内部の名前を直接持ち、実装の名前を変えたときに実行時 TypeError にならないよう
 * 1 か所にまとめる。このファイルは vitest の `test.include` (`src/**\/*.{test,prop}.ts`) に
 * 一致しない名前であり、ライブラリのビルド entry (`src/index.ts`) からも到達しないため、
 * 配布物には含まれない。
 */

import type { MediaPlayout } from "../playout/mediaPlayout";

/** 音声の出力 (`AudioContext` と出力先) の組 */
export interface SubscriberAudioOutput {
  readonly context: AudioContext;
  readonly destination: MediaStreamAudioDestinationNode;
}

/** `MediaSubscriber` の内部形状 (テストの中だけで使う) */
export interface MediaSubscriberInternals {
  /** 再生の入口 */
  readonly playout: MediaPlayout;
  /** 音声の出力 (まだ構成していないときは null) */
  audioOutput: SubscriberAudioOutput | null;
  /** 復号へ渡したが、まだ出力が届いていない音の通し番号 (投入順) */
  audioDecodeSubmitSequences: number[];
}

/** `MediaSubscriber` を内部形状へキャストする (テストの中だけで使う) */
export function subscriberInternalsOf(subscriber: unknown): MediaSubscriberInternals {
  return subscriber as MediaSubscriberInternals;
}

/**
 * 音声の出力 (AudioContext と出力先) をテスト用の最小オブジェクトで差し替える
 *
 * 実装は createOutputStream と同じ組を 1 つにまとめて持ち、入口 (MediaPlayout) へ渡す。
 * テストも同じ組を 1 回で設定する。AudioContext / MediaStreamAudioDestinationNode は
 * ブラウザ専用 API であり node 環境に実物が無いため、記録用の最小オブジェクトを注入する
 * (モジュール置換は行わない)。
 *
 * @param control - 駆動する MediaSubscriber の内部形状
 * @param context - 注入する AudioContext
 * @param destination - 注入する出力先
 */
export function installAudioOutput(
  control: Pick<MediaSubscriberInternals, "playout" | "audioOutput">,
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode,
): void {
  const audioOutput: SubscriberAudioOutput = { context, destination };
  control.audioOutput = audioOutput;
  control.playout.setAudioOutput(audioOutput);
}
