/**
 * 前提から外れた状態の警告を、既にある計器の値から 1 秒ごとに組み立てる
 *
 * 判定そのものは `utils/preconditionWarnings.ts` が持つ。ここは「どの計器を読むか」と
 * 「どこへ出すか」だけを決める。
 *
 * - 配信側: 音声の TIMESTAMP の補正 (`audioTimestampClock`) と追いつき (`audioCatchUp`)
 * - 受信側: 購読ごとの同期の推定 (`SubscriberInstance.avSync`)
 *
 * 判定に時間が要るものは、前回の状態をここで持ち回る。警告になった時点と、戻った時点は
 * デバッグログにも 1 件だけ残す (`utils/avSyncTransition.ts` と同じ考え方。症状が出た
 * ときに、いつ前提から外れたかをログから辿れるようにする)。
 *
 * 新しい計測は行わない。値はすべて上の計器が既に出しているものである。
 */

import { addLog } from "./debugLog";
import * as pub from "./publisher";
import { subscriberInstances } from "./subscriber";
import {
  detectPublisherWarnings,
  detectSubscriberWarnings,
  type PreconditionWarning,
  type PublisherWarningState,
  type SubscriberWarningState,
} from "../utils/preconditionWarnings.ts";

/**
 * 判定の間隔 (ミリ秒)
 *
 * 統計の表示が 1 秒ごとに読み直すのに合わせる。判定に使う時間は 10 秒 (補償が上限に
 * 張り付いたまま)、20 秒 (保持が続いたまま)、60 秒 (追いつきの頻度) であり、1 秒の
 * 粒度で足りる
 */
const PRECONDITION_CHECK_INTERVAL_MS = 1_000;

/** 購読ごとの判定の状態と、直前に出した警告 (ログの増減を比べるために持つ) */
interface SubscriberWatch {
  readonly state: SubscriberWarningState;
  readonly warnings: readonly PreconditionWarning[];
}

// 購読 ID ごとの状態。購読が消えたら捨てる
const subscriberWatches = new Map<string, SubscriberWatch>();
// 配信側の状態
let publisherState: PublisherWarningState | null = null;
let publisherWarnings: readonly PreconditionWarning[] = [];

// 判定の interval。アプリで 1 本だけ起動する
let started = false;
// テスト用に状態を初期状態へ戻すための世代。interval の判定を無効にする
let generation = 0;

/** 2 つの警告の一覧が同じ内容か (信号への代入とログを減らす) */
function sameWarnings(
  previous: readonly PreconditionWarning[],
  current: readonly PreconditionWarning[],
): boolean {
  if (previous.length !== current.length) {
    return false;
  }
  return previous.every((warning, index) => {
    const other = current[index];
    return (
      other !== undefined &&
      warning.id === other.id &&
      warning.decision === other.decision &&
      warning.message === other.message &&
      warning.values.length === other.values.length &&
      warning.values.every((value, valueIndex) => value === other.values[valueIndex])
    );
  });
}

/**
 * 警告の増減をログへ残す
 *
 * 前提から外れた時点は `warn`、戻った時点は `info` にする。どちらも判定に使った値を
 * 一緒に残し、ログだけで「どの計器がどう動いたか」を辿れるようにする。
 *
 * @param target - ログの本文へ付ける識別子 (subscriber ID か "publisher")
 * @param previous - 直前に出していた警告
 * @param current - 今の警告
 */
function logWarningChanges(
  target: string,
  previous: readonly PreconditionWarning[],
  current: readonly PreconditionWarning[],
): void {
  for (const warning of current) {
    if (previous.some((item) => item.id === warning.id)) {
      continue;
    }
    addLog("warn", `[${target}] precondition broken: ${warning.id}`, {
      decision: warning.decision,
      message: warning.message,
      values: warning.values,
    });
  }
  for (const warning of previous) {
    if (current.some((item) => item.id === warning.id)) {
      continue;
    }
    addLog("info", `[${target}] precondition restored: ${warning.id}`, {
      values: warning.values,
    });
  }
}

/**
 * 1 回分の判定を行う
 *
 * 1 秒ごとの interval とテストの両方から呼ぶ。時刻は引数で受ける
 * (`performance.now()` と同じ軸のミリ秒)。
 *
 * @param nowMs - 今の時刻 (ミリ秒)
 */
export function evaluatePreconditions(nowMs: number): void {
  // 配信側。音声を配信していない間は観測が無いため、警告も出ない
  const publisherUpdate = detectPublisherWarnings(
    publisherState,
    {
      timestampOffset: pub.audioTimestampClock.value.snapshot(),
      catchUp: pub.audioCatchUp.value.snapshot(),
    },
    nowMs,
  );
  publisherState = publisherUpdate.state;
  if (!sameWarnings(publisherWarnings, publisherUpdate.warnings)) {
    logWarningChanges("publisher", publisherWarnings, publisherUpdate.warnings);
    pub.preconditionWarnings.value = publisherUpdate.warnings;
    publisherWarnings = publisherUpdate.warnings;
  }

  // 受信側。購読ごとの同期の推定を読む
  const instances = subscriberInstances.value;
  for (const [id, instance] of instances) {
    const previous = subscriberWatches.get(id);
    const update = detectSubscriberWarnings(previous?.state ?? null, instance.avSync.value, nowMs);
    subscriberWatches.set(id, { state: update.state, warnings: update.warnings });
    if (!sameWarnings(previous?.warnings ?? [], update.warnings)) {
      logWarningChanges(id, previous?.warnings ?? [], update.warnings);
      instance.preconditionWarnings.value = update.warnings;
    }
  }
  // 消えた購読の状態を捨てる (次の購読の判定に持ち越さない)
  for (const id of Array.from(subscriberWatches.keys())) {
    if (!instances.has(id)) {
      subscriberWatches.delete(id);
    }
  }
}

/** 判定の interval を起動する (アプリで 1 回だけ動く) */
export function startPreconditionWatch(): void {
  if (started) {
    return;
  }
  started = true;
  const startedGeneration = generation;
  setInterval(() => {
    // テストが状態を戻した後の interval は判定しない (`__resetPreconditionWatchForTest` の
    // 後に、前のテストの値を読んで警告を出さないようにする)
    if (startedGeneration !== generation) {
      return;
    }
    evaluatePreconditions(performance.now());
  }, PRECONDITION_CHECK_INTERVAL_MS);
}

/** テスト用に判定の状態と警告を初期状態へ戻す */
export function __resetPreconditionWatchForTest(): void {
  generation += 1;
  subscriberWatches.clear();
  publisherState = null;
  publisherWarnings = [];
  pub.preconditionWarnings.value = [];
  for (const instance of subscriberInstances.value.values()) {
    instance.preconditionWarnings.value = [];
  }
}
