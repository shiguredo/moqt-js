/**
 * 前提から外れた状態の警告の組み立て (計器の読み出し・信号への反映・ログ) の単体テスト
 *
 * 判定そのものの境目は `utils/preconditionWarnings.test.ts` が見る。ここでは「どの計器を
 * 読んで、どこへ出すか」を確かめる。警告が出た時点と戻った時点がデバッグログに 1 件だけ
 * 残ることも見る (毎秒出ると、症状が出たときにログから追えない)。
 *
 * モックやスタブは使わない。配信側の追いつきは `AudioPublishCatchUp` に、符号化の出力が
 * 返らないままフレームを投入し続けた状態を作って実際に始めさせる。
 */

import { test, assert, beforeEach } from "vite-plus/test";
import { AudioPublishCatchUp } from "../../../src/audioPublishCatchUp.ts";
import { PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS } from "../../../src/playbackTimeline.ts";
import {
  CATCH_UP_WARN_STARTS,
  CATCH_UP_WARN_WINDOW_MS,
  SYNC_PINNED_MIN_MS,
  SYNC_PINNED_TOLERANCE_MS,
} from "../utils/preconditionWarnings.ts";
import { __resetLogStateForTest, getLogBuffer } from "./debugLog";
import { __resetPreconditionWatchForTest, evaluatePreconditions } from "./preconditionWatch";
import * as pub from "./publisher";
import { EMPTY_AV_SYNC, addSubscriber, getSubscriber, removeSubscriber } from "./subscriber";

/** 音声の 1 フレームの長さ (ミリ秒)。音声は 20 ms ごとに読む */
const AUDIO_FRAME_MS = 20;

/** 上限に張り付いている状態の補償量 (ミリ秒) */
const PINNED_EXTRA_MS = PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS - SYNC_PINNED_TOLERANCE_MS;

/** 内訳を上書きした同期の推定値を作る */
function avSyncWith(options: { sharingBases: boolean; videoExtraMs: number }) {
  return {
    ...EMPTY_AV_SYNC,
    delays: {
      ...EMPTY_AV_SYNC.delays,
      video: { ...EMPTY_AV_SYNC.delays.video, syncExtraDelayMs: options.videoExtraMs },
      sharingBases: options.sharingBases,
      unsharedReason: options.sharingBases ? ("none" as const) : ("hold" as const),
      baseDifferenceMs: 250,
    },
  };
}

/**
 * 実際の追いつきの判定を通して、追いつきを指定した回数だけ始めさせる
 *
 * 読み出しの遅れは 0 にする (補正が無い状態と同じ)。符号化の出力が返らないまま 20 ms の
 * フレームを投入し続けてキューに音声を溜め、上限を超えたところで追いつきが始まる。
 * キューがはけたところで投入を再開させる
 *
 * @param catchUp - 追いつきの判定
 * @param count - 始めさせる回数
 * @returns 追いつきを始めさせた回数
 */
function startCatchUps(catchUp: AudioPublishCatchUp, count: number): number {
  let timestampMicros = 0;
  // 実装が変わって終わらなくなったときにテストを止める
  let guard = 0;
  while (catchUp.snapshot().catchUpStarts < count && guard < 1_000) {
    guard++;
    // 入力の 1 周期分 (5 フレーム = 100 ms) を、出力が返らないまま投入する
    for (let index = 0; index < 5; index++) {
      catchUp.evaluate({
        timestampMicros,
        readWallClockMicros: 0n,
        // 補正がまだ決まっていない状態と同じにする (読み出しの遅れは 0 とみなす)
        appliedOffsetMicros: null,
        durationMicros: AUDIO_FRAME_MS * 1_000,
        nowMs: 0,
      });
      timestampMicros += AUDIO_FRAME_MS * 1_000;
    }
    // 出力が返ってキューがはけたことにする (追いつきをやめて投入を再開する)
    while (catchUp.snapshot().pendingMs > 0 && guard < 1_000) {
      guard++;
      catchUp.recordEncodedChunk({
        timestampMicros,
        durationMicros: AUDIO_FRAME_MS * 1_000,
        nowMs: 0,
      });
    }
  }
  return catchUp.snapshot().catchUpStarts;
}

/** ログの本文だけを取り出す */
function logMessages(): string[] {
  return getLogBuffer().map((entry) => entry.message);
}

beforeEach(() => {
  __resetLogStateForTest();
  __resetPreconditionWatchForTest();
  // 配信側の観測を作り直す (前のテストの追いつきを持ち越さない)
  pub.audioCatchUp.value = new AudioPublishCatchUp();
});

// 受信側の警告は、購読ごとの同期の推定 (avSync) から組み立てて信号へ入れる
test("evaluatePreconditions: 受信側の警告を信号へ入れ、外れた時点をログに残す", () => {
  const id = addSubscriber();
  const instance = getSubscriber(id)!;
  instance.avSync.value = avSyncWith({ sharingBases: true, videoExtraMs: PINNED_EXTRA_MS });

  // 上限に張り付いた直後は、まだ「戻らない」とは言えない
  evaluatePreconditions(0);
  assert.deepEqual(instance.preconditionWarnings.value, []);
  assert.deepEqual(logMessages(), []);

  // 張り付いたまま `SYNC_PINNED_MIN_MS` 続いたら警告にする
  evaluatePreconditions(SYNC_PINNED_MIN_MS);
  assert.lengthOf(instance.preconditionWarnings.value, 1);
  assert.equal(instance.preconditionWarnings.value[0]?.id, "syncExtraDelayPinnedAtLimit");
  // 外れた時点は 1 件だけ残す (毎秒出るとログから追えなくなる)
  assert.deepEqual(logMessages(), [`[${id}] precondition broken: syncExtraDelayPinnedAtLimit`]);
  assert.equal(getLogBuffer()[0]?.level, "warn");

  evaluatePreconditions(SYNC_PINNED_MIN_MS + 1_000);
  assert.lengthOf(logMessages(), 1);

  // 前提が戻ったら警告を消し、戻った時点をログに残す
  instance.avSync.value = EMPTY_AV_SYNC;
  evaluatePreconditions(SYNC_PINNED_MIN_MS + 2_000);
  assert.deepEqual(instance.preconditionWarnings.value, []);
  assert.deepEqual(logMessages(), [
    `[${id}] precondition broken: syncExtraDelayPinnedAtLimit`,
    `[${id}] precondition restored: syncExtraDelayPinnedAtLimit`,
  ]);
  assert.equal(getLogBuffer()[1]?.level, "info");

  removeSubscriber(id);
});

// 購読中でも前提から外れていなければ警告は空のままにする (購読しているだけで警告が出ると、
// 症状が出たときに読む値が分からなくなる)
test("evaluatePreconditions: 前提から外れていなければ警告を出さない", () => {
  const id = addSubscriber();
  const instance = getSubscriber(id)!;
  instance.avSync.value = avSyncWith({ sharingBases: true, videoExtraMs: 30 });

  evaluatePreconditions(0);
  evaluatePreconditions(60_000);
  assert.deepEqual(instance.preconditionWarnings.value, []);
  assert.deepEqual(logMessages(), []);

  removeSubscriber(id);
});

// 配信側の警告は、実際に追いつきを始めさせた観測から組み立てる。窓 (60 秒) の中で
// 開始回数が増えたときにだけ出る
test("evaluatePreconditions: 配信側の追いつきの頻発を検出する", () => {
  // 追いつきの回数を数え始める (窓の最初の記録)
  evaluatePreconditions(0);
  assert.deepEqual(pub.preconditionWarnings.value, []);

  const catchUp = new AudioPublishCatchUp();
  const starts = startCatchUps(catchUp, CATCH_UP_WARN_STARTS);
  assert.equal(starts, CATCH_UP_WARN_STARTS);
  pub.audioCatchUp.value = catchUp;

  // 窓が埋まるまでは判定しない
  evaluatePreconditions(CATCH_UP_WARN_WINDOW_MS - 1);
  assert.deepEqual(pub.preconditionWarnings.value, []);

  evaluatePreconditions(CATCH_UP_WARN_WINDOW_MS);
  assert.lengthOf(pub.preconditionWarnings.value, 1);
  assert.equal(pub.preconditionWarnings.value[0]?.id, "catchUpKeepsStarting");
  assert.deepEqual(logMessages(), ["[publisher] precondition broken: catchUpKeepsStarting"]);
  assert.equal(getLogBuffer()[0]?.level, "warn");

  // 配信をやり直すと回数が 0 に戻る。記録を捨てて警告も消す
  pub.audioCatchUp.value = new AudioPublishCatchUp();
  evaluatePreconditions(CATCH_UP_WARN_WINDOW_MS + 1_000);
  assert.deepEqual(pub.preconditionWarnings.value, []);
  assert.deepEqual(logMessages(), [
    "[publisher] precondition broken: catchUpKeepsStarting",
    "[publisher] precondition restored: catchUpKeepsStarting",
  ]);
});
