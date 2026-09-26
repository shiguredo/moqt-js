import type { AudioSourceType, VideoSourceType } from "../types";

/**
 * 配信するトラックの名前と、catalog に載るかどうかの判定
 *
 * Tracks カードが「どのトラックを、どの名前で広告するか」を出すための純関数。
 *
 * トラック名は draft-ietf-moq-msf-01 §5.2.3 で Required であり、catalog の中で
 * namespace ごとに一意でなければならない MUST のため、空名と同名を配信の前に拒否する。
 * 検証をこの 1 か所に置き、画面の警告 (`resolveTrackNameProblem`) と配信前の検証
 * (`assertTrackNames`) が同じ規則を見るようにする。
 *
 * 広告の有無は、設定から決まるもの (入力が None) と環境から決まるもの
 * (MediaStreamTrackProcessor が無いブラウザでは音声を取り出せない) だけを扱う。
 * カメラとマイクの許可、AudioEncoder の対応は配信を始めるまで確定しないため、
 * ここでは扱わない (結果は配信時のログと status message に出す)。
 */

/** トラック名の問題 */
export type TrackNameProblem = "empty" | "duplicate";

/**
 * 配信する予定のトラック名の問題を返す (問題が無ければ null)
 *
 * 配信する予定のトラックの名前だけを渡す。配信しないトラックの名前は検証しない
 * (映像の入力が None のとき、映像トラック名が空でも配信の内容は変わらない)。
 */
export function resolveTrackNameProblem(names: readonly string[]): TrackNameProblem | null {
  // 空名は catalog の name が Required に反する。同名は namespace 内の一意性に反する
  if (names.includes("")) {
    return "empty";
  }
  if (new Set(names).size !== names.length) {
    return "duplicate";
  }
  return null;
}

/**
 * 配信する予定のトラック名を検証する (問題があれば throw する)
 *
 * 0 件 (トラックを 1 つも配信しない設定) は問題無しとする。トラックの無い catalog を
 * 作らないことは `buildPublisherCatalog` の別の検証が担う。
 */
export function assertTrackNames(names: readonly string[]): void {
  const problem = resolveTrackNameProblem(names);
  if (problem === "empty") {
    throw new Error("track name must not be empty per draft-ietf-moq-msf-01 §5.2.3");
  }
  if (problem === "duplicate") {
    throw new Error("track names must be unique per namespace per draft-ietf-moq-msf-01 §5.2.3");
  }
}

/** トラックを広告するかどうかと、広告しない理由 */
export type TrackAdvertisement =
  | { advertised: true }
  | { advertised: false; reason: "source-none" | "browser-unsupported" };

/** 映像トラックを catalog に載せる予定かどうか (映像の入力が None なら載せない) */
export function resolveVideoAdvertisement(videoSource: VideoSourceType): TrackAdvertisement {
  if (videoSource === "none") {
    return { advertised: false, reason: "source-none" };
  }
  return { advertised: true };
}

/**
 * 音声トラックを catalog に載せる予定かどうか
 *
 * MediaStreamTrackProcessor が無いブラウザ (Safari / Firefox) では音声を取り出せないため、
 * 入力が None でなくても載せない。判定は映像の入力と同じく `src/frameSource.ts` の
 * `isMediaStreamTrackProcessorAvailable` を使い、呼び出し側がその結果を渡す。
 */
export function resolveAudioAdvertisement(
  audioSource: AudioSourceType,
  mediaStreamTrackProcessorAvailable: boolean,
): TrackAdvertisement {
  if (audioSource === "none") {
    return { advertised: false, reason: "source-none" };
  }
  if (!mediaStreamTrackProcessorAvailable) {
    return { advertised: false, reason: "browser-unsupported" };
  }
  return { advertised: true };
}
