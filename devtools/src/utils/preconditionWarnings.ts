/**
 * 実行時に「前提から外れた」状態を検出する
 *
 * A/V 同期と再生の判断 (合わせる量の上限、共有の解除の保持、ドリフトの検出、配信側の
 * 追いつきと TIMESTAMP の補正) は、それぞれ「こういう状態までは起きない」という前提の上に
 * 成り立っている。前提から外れると、閾値を触るべきか実装を直すべきかが分からなくなる。
 *
 * 前提から外れた状態は、既にある計器の値を組み合わせれば分かる (新しい計測は要らない)。
 * 判定は 1 秒ごとの観測で行う純関数にし、判定に時間が要るもの (上限に張り付いたまま、
 * 保持が続いたまま、追いつきが繰り返される) は前回の状態を引数で受けて数え直す。
 * 判定の根拠と、どうなったら何を見直すかは docs/AV_SYNC_DECISIONS.md が持つ。
 *
 * 出す文言は devtools の UI (英語) と「Copy for LLM」の両方に使うため英語にする。
 */

import type { AudioPublishCatchUpStats } from "../../../src/audioPublishCatchUp.ts";
import type { AudioTimestampOffsetStats } from "../../../src/audioTimestampClock.ts";
import {
  PLAYOUT_BASE_UNSHARED_HOLD_MS,
  PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
} from "../../../src/playbackTimeline.ts";
import type { AvSyncSnapshot } from "../signals/subscriber";

/** 警告の識別子 (devtools の説明とテストが参照する) */
export type PreconditionWarningId =
  // A/V 同期で合わせる量が上限に張り付いたまま戻らない
  | "syncExtraDelayPinnedAtLimit"
  // 基準の共有の解除を保持したまま長く続いている
  | "unsharedHoldContinues"
  // 配信側の TIMESTAMP の補正が動き続けている
  | "timestampOffsetKeepsMoving"
  // 配信側の追いつきが繰り返し始まっている
  | "catchUpKeepsStarting";

/**
 * 前提から外れた状態の警告 1 件
 *
 * 「どの判断の前提が外れたか」と「何が起きているか」を分けて持つ。画面では 1 行にまとめ、
 * 「Copy for LLM」では判断の名前から機械的に辿れるようにする。
 */
export interface PreconditionWarning {
  /** 警告の識別子 (英語の短い語。説明とテストが参照する) */
  readonly id: PreconditionWarningId;
  /** 見直す判断 (実装の定数名。どの値を疑うかを示す) */
  readonly decision: string;
  /** 何が起きているか (英語。画面と「Copy for LLM」に出る) */
  readonly message: string;
  /** 判定に使った値 (計器の名前 = 値。どの計器を見ればよいかを示す) */
  readonly values: readonly string[];
}

/**
 * 補償が上限に張り付いているとみなす幅 (ミリ秒)
 *
 * 上限に達すると、足す量は上限そのもの (100 ms) になる。観測と観測の間は毎秒
 * `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` (20 ms) だけ戻るが、観測の間隔は映像でも 33 ms で
 * あるため 1 ms も戻らない。5 ms の幅は、上限に達した状態と、達していない状態 (差が
 * 上限 + 不感帯より小さい) を分けるために十分である
 */
export const SYNC_PINNED_TOLERANCE_MS = 5;

/**
 * 上限に張り付いたまま警告を出すまでの時間 (ミリ秒)
 *
 * 張り付いた分は毎秒 20 ms で戻るため、100 ms の補償は 5 秒で戻り切る。その 2 倍を
 * 「戻らない」とみなす。一過性の差 (まとめて届いた山で一瞬開いた、など) では 10 秒も
 * 続かない
 */
export const SYNC_PINNED_MIN_MS = 10_000;

/**
 * 共有の解除を保持したまま警告を出すまでの時間 (ミリ秒)
 *
 * 解除のきっかけが去って差が戻れば、保持は `PLAYOUT_BASE_UNSHARED_RELEASE_MS` (2 秒) で
 * 解除される。2 秒で解除されずに保持が続くのは、差が戻っていない (きっかけが去っていない)
 * 場合か、差が同じ水準のままで閾値だけが動いた場合である。保持そのものは
 * `PLAYOUT_BASE_UNSHARED_HOLD_MS` (30 秒) で満了するため、満了の手前 (2/3) で出して
 * 「A/V の基準が 20 秒以上共有されていない」ことを見えるようにする
 */
export const UNSHARED_HOLD_WARN_MS = (PLAYOUT_BASE_UNSHARED_HOLD_MS / 3) * 2;

/**
 * 配信側の補正が動き続けているとみなす傾き (ミリ秒 / 秒)
 *
 * 実リレーの E2E (tests/e2e/relay/audio-timestamp.spec.ts の
 * `TIMESTAMP_SLOPE_MAX_MS_PER_SECOND`) が「一定のずれに収まっている」ことの上限に使って
 * いる値である。実測では定常状態の傾きは 0.0 ms/秒であり、壁時計からずれていく場合は
 * 20 ms/秒 を超える (10 秒で 217 ms ずれた)。読み出しの遅れの段差 (実測で 160 ms) でも
 * この値には届かない。
 *
 * この速さで補正が動くと、受信側の基準の差は 1 秒に 5 ms 動き、ドリフトの判定
 * (`PLAYOUT_BASE_DRIFT_MS` = 50 ms が `PLAYOUT_BASE_DRIFT_CONFIRM_MS` = 6 秒続く) に
 * 10 秒ほどで届く
 */
export const TIMESTAMP_SLOPE_WARN_MS_PER_SECOND = 5;

/**
 * 傾きを判定するのに要る観測の数
 *
 * 短い方の傾きの窓 (`AUDIO_TIMESTAMP_SLOPE_WINDOW_MS` = 10 秒) を埋める数にする。音声は
 * 20 ms ごとに観測するため 10 秒で約 500 個である (src/audioTimestampClock.ts の
 * 「2 秒の窓には約 100 個」と同じ割合)。これより少ないと、傾きがまだ出ていない配信の
 * 直後を判定してしまう
 */
export const TIMESTAMP_SLOPE_MIN_SAMPLES = 500;

/**
 * 追いつきが頻発しているとみなす窓 (ミリ秒)
 *
 * 1 分にする。1 分あれば、上限 (床 + 40 ms) を超えて溜まった遅れが、キューに溜まった分を
 * はき切るまでに何回往復したかを数えられる
 */
export const CATCH_UP_WARN_WINDOW_MS = 60_000;

/**
 * 窓の中で許す追いつきの開始回数
 *
 * 追いつきが 1 回始まると、キューが 1 パケット (20 ms) 以下まで減るまで捨て続ける。
 * 捨てる量は少なくとも上限を超えた分であり、上限の下限 (`AUDIO_PUBLISH_CATCH_UP_MIN_MS`
 * = 60 ms) のときで 3 パケット分にあたる。1 分に 3 回始まるなら、少なくとも 1 分に
 * 9 パケット (180 ms) の音が欠ける。音声は実時間で符号化できるという前提が崩れている。
 *
 * 開始は上限を超えた状態が `AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` (100 ms) 続いた後か、
 * 符号化のキューが単独で上限を超えた状態が `AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES`
 * (2 フレーム) 続いた後である (audioPublishCatchUp.ts)。一過性の超過 (実測: 最長 18 ms)
 * では始まらないため、これが 1 分に 3 回来るのは、上限を超えた状態が繰り返し続いている
 * ことを意味する
 */
export const CATCH_UP_WARN_STARTS = 3;

/** 受信側の警告の判定の状態 (観測のたびに持ち回る) */
export interface SubscriberWarningState {
  /** 同期の補償が上限に張り付き始めた時刻 (ミリ秒)。張り付いていなければ null */
  readonly syncPinnedSinceMs: number | null;
  /** 共有の解除の保持が始まった時刻 (ミリ秒)。保持していなければ null */
  readonly unsharedHoldSinceMs: number | null;
}

/** 受信側の判定の結果 */
export interface SubscriberWarningUpdate {
  /** 次の判定に使う状態 */
  readonly state: SubscriberWarningState;
  /** 前提から外れている状態 (外れていなければ空) */
  readonly warnings: readonly PreconditionWarning[];
}

/** 配信側の追いつきの記録 1 件 */
interface CatchUpSample {
  /** 観測した時刻 (ミリ秒) */
  readonly atMs: number;
  /** そのときの `catchUpStarts` の値 */
  readonly starts: number;
}

/** 配信側の警告の判定の状態 */
export interface PublisherWarningState {
  /**
   * 追いつきの開始回数の記録 (古い順、`CATCH_UP_WARN_WINDOW_MS` の分だけ)
   *
   * 累積の値だけでは「増え続けている」かどうかが分からないため、観測のたびに記録して
   * 窓の中の増加を数える
   */
  readonly catchUpSamples: readonly CatchUpSample[];
}

/** 配信側の判定の入力 */
export interface PublisherWarningInput {
  /** 音声の TIMESTAMP の補正の観測。まだ観測していなければ null */
  readonly timestampOffset: AudioTimestampOffsetStats | null;
  /** 音声の追いつきの観測 */
  readonly catchUp: AudioPublishCatchUpStats;
}

/** 配信側の判定の結果 */
export interface PublisherWarningUpdate {
  /** 次の判定に使う状態 */
  readonly state: PublisherWarningState;
  /** 前提から外れている状態 (外れていなければ空) */
  readonly warnings: readonly PreconditionWarning[];
}

/** 空の状態 (購読や配信を始める前) */
export const EMPTY_SUBSCRIBER_WARNING_STATE: SubscriberWarningState = {
  syncPinnedSinceMs: null,
  unsharedHoldSinceMs: null,
};

/** 空の状態 (配信を始める前) */
export const EMPTY_PUBLISHER_WARNING_STATE: PublisherWarningState = {
  catchUpSamples: [],
};

/** 数値を 1 桁のミリ秒で書く (計器の表示と桁を合わせる) */
function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

/**
 * 受信側 (A/V 同期) の前提から外れた状態を検出する
 *
 * 見るのは次の 2 つである。どちらも「合わせる量の上限」と「共有の解除の保持」という、
 * この 1 週間で入れた判断の前提が崩れたことを示す。
 *
 * - 同期の補償 (`syncExtraDelayMs`) が上限に張り付いたまま戻らない。差が上限より大きい
 *   ため、残りは A/V のずれとして残っている
 * - 基準を共有できていない理由 (`unsharedReason`) が `hold` のまま長く続いている。解除の
 *   きっかけが去っていれば 2 秒で解除されるため、続くのは差が戻っていないか、閾値だけが
 *   動いた解除が繰り返されているかである
 *
 * @param previous - 前回の状態。まだ無ければ null
 * @param snapshot - 今の同期の推定値
 * @param nowMs - 今の時刻 (ミリ秒)
 */
export function detectSubscriberWarnings(
  previous: SubscriberWarningState | null,
  snapshot: AvSyncSnapshot,
  nowMs: number,
): SubscriberWarningUpdate {
  const state = previous ?? EMPTY_SUBSCRIBER_WARNING_STATE;
  const delays = snapshot.delays;
  const warnings: PreconditionWarning[] = [];

  // 上限に張り付いたままか。基準を共有している間だけ意味を持つ (共有していない間は
  // 足した分を戻すため、上限に留まらない)
  const extraMs = Math.max(delays.audio.syncExtraDelayMs, delays.video.syncExtraDelayMs);
  const pinned =
    delays.sharingBases &&
    extraMs >= PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS - SYNC_PINNED_TOLERANCE_MS;
  const syncPinnedSinceMs = pinned ? (state.syncPinnedSinceMs ?? nowMs) : null;
  if (syncPinnedSinceMs !== null && nowMs - syncPinnedSinceMs >= SYNC_PINNED_MIN_MS) {
    warnings.push({
      id: "syncExtraDelayPinnedAtLimit",
      decision: "PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS",
      message:
        `A/V sync compensation stayed within ${SYNC_PINNED_TOLERANCE_MS} ms of the limit for ` +
        `${Math.round((nowMs - syncPinnedSinceMs) / 1000)} s. The difference between the two ` +
        "tracks is larger than the compensable amount, so the rest is left as A/V skew. " +
        "Reconsider the limit, or the TIMESTAMP clock of the track with the larger baseDelayMs.",
      values: [
        `syncExtraDelayMs=${formatMs(extraMs)}`,
        `limitMs=${PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS}`,
        `heldMs=${Math.round(nowMs - syncPinnedSinceMs)}`,
        `baseDifferenceMs=${delays.baseDifferenceMs === null ? "-" : formatMs(delays.baseDifferenceMs)}`,
        `sharingBases=${delays.sharingBases}`,
      ],
    });
  }

  // 共有の解除を保持したままか
  const holding = delays.unsharedReason === "hold";
  const unsharedHoldSinceMs = holding ? (state.unsharedHoldSinceMs ?? nowMs) : null;
  if (unsharedHoldSinceMs !== null && nowMs - unsharedHoldSinceMs >= UNSHARED_HOLD_WARN_MS) {
    warnings.push({
      id: "unsharedHoldContinues",
      decision: "PLAYOUT_BASE_UNSHARED_HOLD_MS",
      message:
        `The bases have stayed unshared for ${Math.round((nowMs - unsharedHoldSinceMs) / 1000)} s ` +
        "while the reason is hold. The early release (the difference returned for " +
        "PLAYOUT_BASE_UNSHARED_RELEASE_MS after the trigger went away) did not happen, so the " +
        "difference never came back to the compensable range. Reconsider the hold, or why the " +
        "difference keeps moving (baseDriftMsPerSecond) or stays out of range.",
      values: [
        `unsharedReason=${delays.unsharedReason}`,
        `heldMs=${Math.round(nowMs - unsharedHoldSinceMs)}`,
        `baseDifferenceMs=${delays.baseDifferenceMs === null ? "-" : formatMs(delays.baseDifferenceMs)}`,
        `baseDriftMsPerSecond=${delays.baseDriftMsPerSecond === null ? "-" : formatMs(delays.baseDriftMsPerSecond)}`,
        `baseUnsharedReturnMs=${delays.baseUnsharedReturnMs === null ? "-" : formatMs(delays.baseUnsharedReturnMs)}`,
        `presentationDelayCapMs=${formatMs(delays.presentationDelayCapMs)}`,
      ],
    });
  }

  return { state: { syncPinnedSinceMs, unsharedHoldSinceMs }, warnings };
}

/**
 * 配信側 (TIMESTAMP の補正と追いつき) の前提から外れた状態を検出する
 *
 * 見るのは次の 2 つである。
 *
 * - 「読み出した壁時計 - `AudioData.timestamp`」の傾きが 0 から離れている。音声の時計と
 *   壁時計が同じ速さでは進まないという前提が崩れており、補正が動き続ける
 * - 追いつきの開始回数が窓の中で増え続けている。音声は実時間で符号化できるという前提が
 *   崩れており、古いフレームを捨て続けている
 *
 * @param previous - 前回の状態。まだ無ければ null
 * @param input - 今の観測
 * @param nowMs - 今の時刻 (ミリ秒)
 */
export function detectPublisherWarnings(
  previous: PublisherWarningState | null,
  input: PublisherWarningInput,
  nowMs: number,
): PublisherWarningUpdate {
  const state = previous ?? EMPTY_PUBLISHER_WARNING_STATE;
  const warnings: PreconditionWarning[] = [];

  // 補正の傾き。観測が窓を埋めるまでは判定しない
  const offset = input.timestampOffset;
  if (offset !== null && offset.samples >= TIMESTAMP_SLOPE_MIN_SAMPLES) {
    const slopeMsPerSecond = offset.slope60sMsPerSecond ?? offset.slope10sMsPerSecond;
    if (
      slopeMsPerSecond !== null &&
      Math.abs(slopeMsPerSecond) >= TIMESTAMP_SLOPE_WARN_MS_PER_SECOND
    ) {
      warnings.push({
        id: "timestampOffsetKeepsMoving",
        decision: "AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS",
        message:
          "The audio TIMESTAMP offset keeps moving. The audio clock and the wall clock do not " +
          "tick at the same rate, so the correction has to follow it and the receiver sees the " +
          "base difference moving. Reconsider how much of the movement is treated as a clock " +
          "drift (the rise limit and the rise hold), or the audio clock itself.",
        values: [
          `slope60sMsPerSecond=${offset.slope60sMsPerSecond === null ? "-" : formatMs(offset.slope60sMsPerSecond)}`,
          `slope10sMsPerSecond=${offset.slope10sMsPerSecond === null ? "-" : formatMs(offset.slope10sMsPerSecond)}`,
          `limitMsPerSecond=${TIMESTAMP_SLOPE_WARN_MS_PER_SECOND}`,
          `currentMs=${formatMs(offset.currentMs)}`,
          `minMs=${formatMs(offset.minMs)}`,
          `maxMs=${formatMs(offset.maxMs)}`,
          `appliedMs=${offset.appliedMs === null ? "-" : formatMs(offset.appliedMs)}`,
          `samples=${offset.samples}`,
        ],
      });
    }
  }

  // 追いつきの開始回数。配信をやり直すと 0 に戻るため、減ったら記録を捨てる
  const restarted = state.catchUpSamples.some(
    (sample) => sample.starts > input.catchUp.catchUpStarts,
  );
  const kept = restarted ? [] : state.catchUpSamples;
  // 窓の端の記録も残す。落とすと、1 秒ごとの観測では窓が 59 秒にしかならず、60 秒たつまで
  // 判定が始まらない
  const catchUpSamples = [
    ...kept.filter((sample) => sample.atMs >= nowMs - CATCH_UP_WARN_WINDOW_MS),
    { atMs: nowMs, starts: input.catchUp.catchUpStarts },
  ];
  const oldest = catchUpSamples[0];
  if (
    oldest !== undefined &&
    nowMs - oldest.atMs >= CATCH_UP_WARN_WINDOW_MS &&
    input.catchUp.catchUpStarts - oldest.starts >= CATCH_UP_WARN_STARTS
  ) {
    warnings.push({
      id: "catchUpKeepsStarting",
      decision: "AUDIO_PUBLISH_CATCH_UP_GROWTH_MS",
      message:
        `Audio catch-up started ${input.catchUp.catchUpStarts - oldest.starts} times in the last ` +
        `${Math.round(CATCH_UP_WARN_WINDOW_MS / 1000)} s. Each start drops the queued audio down ` +
        "to one packet, so the encoder is not keeping real time. Reconsider the catch-up " +
        "thresholds, or whether dropping is the right policy for this content (audioCatchUp).",
      values: [
        `catchUpStarts=${input.catchUp.catchUpStarts}`,
        `startsInWindow=${input.catchUp.catchUpStarts - oldest.starts}`,
        `windowMs=${CATCH_UP_WARN_WINDOW_MS}`,
        `policy=${input.catchUp.policy}`,
        `droppedFrames=${input.catchUp.droppedFrames}`,
        `droppedMs=${formatMs(input.catchUp.droppedMs)}`,
        `floorMs=${input.catchUp.floorMs === null ? "-" : formatMs(input.catchUp.floorMs)}`,
        `lagMs=${input.catchUp.lagMs === null ? "-" : formatMs(input.catchUp.lagMs)}`,
      ],
    });
  }

  return { state: { catchUpSamples }, warnings };
}

/**
 * 警告 1 件を画面 1 行にする
 *
 * 識別子で始め、判定に使った値を括弧の中に並べる。どの計器を見ればよいかが行だけで分かる
 */
export function formatPreconditionWarning(warning: PreconditionWarning): string {
  const values = warning.values.length === 0 ? "" : ` (${warning.values.join(", ")})`;
  return `${warning.id}: ${warning.message}${values}`;
}
