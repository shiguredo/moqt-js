/**
 * A/V 同期の状態が変わったことを検出する
 *
 * 2 つのトラックを同じ時計として扱えているか (`sharingBases` と `unsharedReason`) が
 * 変わった時点が、A/V のずれが広がる (または戻る) 原因になる。数値を一緒にログへ残し、
 * relay のログと突き合わせて解析できるようにする。
 *
 * 500 ms ごとに読む snapshot から、変わったときだけ 1 件を作る純関数にしてある
 * (数値そのものは devtools/src/hooks/useSubscriber.ts が時間軸から読む)。
 */

import type { AvSyncSnapshot } from "../signals/subscriber";
import type { LogLevel } from "../signals/debugLog";

/** 直前の状態と比べるための、同期の状態だけを取り出した値 */
export interface AvSyncState {
  sharing: boolean;
  reason: AvSyncSnapshot["delays"]["unsharedReason"];
}

/** ログに残す 1 件 */
export interface AvSyncTransitionLog {
  level: LogLevel;
  message: string;
  data: unknown;
}

/** 状態の変化の判定結果 */
export interface AvSyncTransition {
  /** 次の判定に使う状態 */
  state: AvSyncState;
  /** ログに残す内容。状態が変わっていなければ null */
  log: AvSyncTransitionLog | null;
}

/** snapshot から状態だけを取り出す */
export function avSyncStateOf(snapshot: AvSyncSnapshot): AvSyncState {
  return {
    sharing: snapshot.delays.sharingBases,
    reason: snapshot.delays.unsharedReason,
  };
}

/**
 * 状態が変わったかを判定し、ログに残す内容を決める
 *
 * 最初の 1 回 (`previous` が null) は「変わったとき」ではないためログを出さない。
 * 共有が切れたときは A/V のずれが広がり得るため `warn`、戻ったときは原因究明の手掛かりに
 * なるため `info` にする。数値は、ずれが「時計のずれ」によるものか「経路の遅れ」に
 * よるものかをログだけから辿れるように入れる。
 *
 * @param previous - 直前の状態。まだ無ければ null
 * @param snapshot - 今の snapshot
 * @param subscriberId - ログの本文へ付ける識別子
 */
export function detectAvSyncTransition(
  previous: AvSyncState | null,
  snapshot: AvSyncSnapshot,
  subscriberId: string,
): AvSyncTransition {
  const state = avSyncStateOf(snapshot);
  if (
    previous === null ||
    (previous.sharing === state.sharing && previous.reason === state.reason)
  ) {
    return { state, log: null };
  }
  const from = previous.sharing ? "shared" : "unshared";
  const to = state.sharing ? "shared" : "unshared";
  return {
    state,
    log: {
      level: state.sharing ? "info" : "warn",
      message: `[${subscriberId}] A/V sync bases ${from} -> ${to}`,
      data: {
        reason: state.reason,
        skewMs: snapshot.skewMs,
        baseDifferenceMs: snapshot.delays.baseDifferenceMs,
        baseDriftMsPerSecond: snapshot.delays.baseDriftMsPerSecond,
        audio: snapshot.delays.audio,
        video: snapshot.delays.video,
      },
    },
  };
}
