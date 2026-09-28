/**
 * 配信 / 購読ステータスのメッセージ
 *
 * `Publishing: <audio>, <video>` のように、確立したメディアトラックの Full Track Name を
 * 並べる。並びは audio → video で、Catalog と Tracks カードの並びに揃える。
 * Full Track Name の文字列表現は src/fullTrackName.ts の formatFullTrackName が作る
 * (draft-ietf-moq-transport-21 §8.8 / draft-ietf-moq-msf-01 §11.1.2)。
 */

import { formatFullTrackName } from "../../../src/fullTrackName.ts";

/** 配信 / 購読ステータスのラベル */
export type TrackStatusLabel = "Publishing" | "Subscribed";

/** 確立したメディアトラックの名前 (確立していないトラックは省略する) */
export interface EstablishedMediaTrackNames {
  audio?: string;
  video?: string;
}

/**
 * 確立したメディアトラックからステータスメッセージを組み立てる
 *
 * `<label>: <fullTrackName>, ...` の形式にする。オブジェクトのプロパティ順ではなく
 * audio → video の順に並べる。トラックが 1 つも無いときはラベルだけになるため、
 * 呼び出し側は確立したトラックがあるときだけ呼ぶ。
 */
export function buildMediaTrackStatusMessage(
  label: TrackStatusLabel,
  trackNamespace: readonly string[],
  tracks: EstablishedMediaTrackNames,
): string {
  const fullTrackNames: string[] = [];
  if (tracks.audio !== undefined) {
    fullTrackNames.push(formatFullTrackName(trackNamespace, tracks.audio));
  }
  if (tracks.video !== undefined) {
    fullTrackNames.push(formatFullTrackName(trackNamespace, tracks.video));
  }
  return `${label}: ${fullTrackNames.join(", ")}`;
}
