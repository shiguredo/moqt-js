/**
 * 音声 Object を datagram で送るか
 *
 * draft-ietf-moq-transport-21 §2.2 / §11.2: 同じトラックで Subgroup と Datagram を併用できる。
 * draft-ietf-webtrans-http2 は datagram を運ばないため、reliability が "reliable-only"
 * (WT-H2) のときは Subgroup に戻す。値の意味は仕様が変わる可能性がある。
 */

import type { AudioDelivery } from "../types";

export function shouldSendAudioAsDatagram(
  delivery: AudioDelivery,
  reliability: string | undefined,
): boolean {
  if (delivery !== "datagram") {
    return false;
  }
  return reliability !== "reliable-only";
}
