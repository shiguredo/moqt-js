/**
 * StallAnalyzer の単体テスト
 *
 * 止まりの原因の判定を、合成したフレームの時系列で原因ごとに固定する。時系列は 25 fps
 * (フレーム間隔 40 ms、止まりの閾値 60 ms) とし、前に表示したフレーム P を 1,000 ms に
 * 表示し、止まりの後のフレームを 1,100 ms に表示する。
 *
 * 受信の欠け (届かなかった Object と Group、RESET_STREAM で終わった stream) の数え方も
 * ここで固定する。原因ごとの回数の和が止まりの回数に一致することは
 * playbackTimingStats.prop.ts の PBT が固定する。
 */

import { test, assert } from "vite-plus/test";
import { MAX_TRACKED_GROUPS, StallAnalyzer, type ObjectPosition } from "./stallAnalysis";

// フレーム間隔 (マイクロ秒)
const FRAME_MICROS = 40_000;
// 止まりの閾値 (フレーム間隔の 1.5 倍、ミリ秒)
const STALL_THRESHOLD_MS = 60;
// 通常の復号時間 (ミリ秒)
const DECODE_MS = 2;
// フレームの記録を残す時間 (ミリ秒)
const WINDOW_MS = 10_000;
// P を表示した時刻と、止まりの後のフレームを表示した時刻
const PREVIOUS_DISPLAYED_AT_MS = 1_000;
const CURRENT_DISPLAYED_AT_MS = 1_100;

function position(groupId: bigint, objectId: bigint, priorObjectIdGap = 0n): ObjectPosition {
  return { groupId, objectId, priorObjectIdGap };
}

/** フレームの受け取りから復号の出力までの時刻 */
interface FrameTimes {
  readonly receivedAtMs: number;
  readonly releasedAtMs?: number;
  readonly decodedAtMs?: number;
}

/**
 * フレームを受け取り、保留から出し、復号して出力するまでを記録する
 *
 * 保留を解いた時刻を省けば受け取った時刻、復号の出力の時刻を省けば保留を解いてから
 * 通常の復号時間の後とする
 */
function receiveAndDecode(
  analyzer: StallAnalyzer,
  framePosition: ObjectPosition,
  timestampMicros: number,
  times: FrameTimes,
): void {
  const releasedAtMs = times.releasedAtMs ?? times.receivedAtMs;
  analyzer.recordReceived(framePosition, 0n, timestampMicros, times.receivedAtMs);
  analyzer.recordReleased(timestampMicros, releasedAtMs);
  analyzer.recordDecodeStart(timestampMicros);
  analyzer.recordDecodeOutput(timestampMicros, times.decodedAtMs ?? releasedAtMs + DECODE_MS);
}

/**
 * P (Group 0 の Object 5、TIMESTAMP 0) を受け取って 1,000 ms に表示した状態の analyzer を作る
 */
function analyzerWithPrevious(): StallAnalyzer {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  receiveAndDecode(analyzer, position(0n, 5n), 0, { receivedAtMs: 900 });
  analyzer.recordDisplayed(0, null);
  return analyzer;
}

/** P の後に、TIMESTAMP が timestampMicros のフレームを 1,100 ms に表示したときの原因 */
function classifyCurrent(analyzer: StallAnalyzer, timestampMicros: number): string {
  return analyzer.classify(
    { timestampMicros: 0, displayedAtMs: PREVIOUS_DISPLAYED_AT_MS },
    { timestampMicros, displayedAtMs: CURRENT_DISPLAYED_AT_MS },
    STALL_THRESHOLD_MS,
    DECODE_MS,
  );
}

// ============================================================================
// 間のフレームを受け取っていない (TIMESTAMP の差が閾値を超える)
// ============================================================================

// 位置が連続する (同じ Group で Object ID が続く) のに TIMESTAMP が 200 ms 飛んだ。
// publisher がフレームを撮れていない
test("classify: 位置が連続して TIMESTAMP が飛んだら source にする", () => {
  const analyzer = analyzerWithPrevious();
  receiveAndDecode(analyzer, position(0n, 6n), 5 * FRAME_MICROS, { receivedAtMs: 1_090 });
  analyzer.recordDisplayed(5 * FRAME_MICROS, null);

  assert.equal(classifyCurrent(analyzer, 5 * FRAME_MICROS), "source");
});

// Object 6 が届かず、Object 7 を表示した。間の Object が届いていない
test("classify: Group の中の Object ID が飛んだら loss にする", () => {
  const analyzer = analyzerWithPrevious();
  receiveAndDecode(analyzer, position(0n, 7n), 2 * FRAME_MICROS, { receivedAtMs: 1_090 });
  analyzer.recordDisplayed(2 * FRAME_MICROS, null);

  assert.equal(classifyCurrent(analyzer, 2 * FRAME_MICROS), "loss");
});

// Prior Object ID Gap で publisher が示した Object は存在しないため、飛びではない
test("classify: Prior Object ID Gap で示した飛びは連続とみなし source にする", () => {
  const analyzer = analyzerWithPrevious();
  receiveAndDecode(analyzer, position(0n, 7n, 1n), 2 * FRAME_MICROS, { receivedAtMs: 1_090 });
  analyzer.recordDisplayed(2 * FRAME_MICROS, null);

  assert.equal(classifyCurrent(analyzer, 2 * FRAME_MICROS), "source");
});

/**
 * P (Group 0 の最後の Object 5) の後に、次の Group の先頭 (Group 1 の Object 0) を
 * TIMESTAMP 80 ms で表示したときの原因
 *
 * @param end - Group 0 の stream の終わり方。null なら終わりが通知されていない
 */
function classifyGroupSwitch(end: "fin" | "reset" | null): string {
  const analyzer = analyzerWithPrevious();
  if (end !== null) {
    analyzer.recordSubgroupEnd(0n, 0n, end);
  }
  receiveAndDecode(analyzer, position(1n, 0n), 2 * FRAME_MICROS, { receivedAtMs: 1_090 });
  analyzer.recordDisplayed(2 * FRAME_MICROS, null);
  return classifyCurrent(analyzer, 2 * FRAME_MICROS);
}

// Group 0 の stream が FIN で終わり、P がその最後の Object なら、次の Group の先頭と連続する
test("classify: FIN で終わった Group の最後の Object から次の Group の先頭へは連続とみなす", () => {
  assert.equal(classifyGroupSwitch("fin"), "source");
});

// Group 0 の stream が reset で終わった、または終わりが通知されていない (後半が届いていない
// かもしれない) なら、次の Group の先頭と連続するとは言えない
test("classify: reset で終わった、終わっていない Group から次の Group へは loss にする", () => {
  assert.equal(classifyGroupSwitch("reset"), "loss", "reset で終わった Group");
  assert.equal(classifyGroupSwitch(null), "loss", "終わりが通知されていない Group");
});

// Group 1 を飛ばして Group 2 の先頭を表示した
test("classify: Group ID が飛んだら loss にする", () => {
  const analyzer = analyzerWithPrevious();
  analyzer.recordSubgroupEnd(0n, 0n, "fin");
  receiveAndDecode(analyzer, position(2n, 0n), 2 * FRAME_MICROS, { receivedAtMs: 1_090 });
  analyzer.recordDisplayed(2 * FRAME_MICROS, null);

  assert.equal(classifyCurrent(analyzer, 2 * FRAME_MICROS), "loss");
});

// ============================================================================
// 次のフレームを受け取ったが表示しなかった
// ============================================================================

/**
 * P の次のフレーム N (Group 0 の Object 6、TIMESTAMP 40 ms) の行方を決め、その次の
 * フレーム (Object 7、TIMESTAMP 80 ms) を 1,100 ms に表示したときの原因
 */
function classifyAfterNext(recordNext: (analyzer: StallAnalyzer) => void): string {
  const analyzer = analyzerWithPrevious();
  recordNext(analyzer);
  receiveAndDecode(analyzer, position(0n, 7n), 2 * FRAME_MICROS, { receivedAtMs: 1_000 });
  analyzer.recordDisplayed(2 * FRAME_MICROS, null);
  return classifyCurrent(analyzer, 2 * FRAME_MICROS);
}

// N を受け取ったが、Group の切り替えの保留から出ていない
test("classify: 次のフレームが保留から出ていなければ groupSwitchHold にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    analyzer.recordReceived(position(0n, 6n), 0n, FRAME_MICROS, 1_000);
  });
  assert.equal(cause, "groupSwitchHold");
});

// N を受け取ったが、Group の順序と欠落などで復号せずに捨てた
test("classify: 次のフレームを復号せずに捨てたら discarded にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    analyzer.recordReceived(position(0n, 6n), 0n, FRAME_MICROS, 1_000);
    analyzer.recordReleased(FRAME_MICROS, 1_000);
    analyzer.recordDiscarded(FRAME_MICROS);
  });
  assert.equal(cause, "discarded");
});

// decoder が受け付けなかったフレーム (decoder に渡した後に失敗した) も捨てたフレームである
test("classify: decoder に渡した後に失敗したフレームも discarded にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    analyzer.recordReceived(position(0n, 6n), 0n, FRAME_MICROS, 1_000);
    analyzer.recordReleased(FRAME_MICROS, 1_000);
    analyzer.recordDecodeStart(FRAME_MICROS);
    analyzer.recordDiscarded(FRAME_MICROS);
  });
  assert.equal(cause, "discarded");
});

// N の表示時刻は 1,040 ms。N は 1,080 ms に届き、間に合わずに捨てた。経路の遅れである
test("classify: 間に合わずに捨てた次のフレームが遅れて届いていたら arrival にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    receiveAndDecode(analyzer, position(0n, 6n), FRAME_MICROS, { receivedAtMs: 1_080 });
    analyzer.recordLateDropped(FRAME_MICROS, 1_040);
  });
  assert.equal(cause, "arrival");
});

// N は表示時刻 (1,040 ms) の前に表示できる状態だったが、描画の周期が来ずに間に合わなくなった
test("classify: 間に合わずに捨てた次のフレームが表示時刻の前に表示できたなら render にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    receiveAndDecode(analyzer, position(0n, 6n), FRAME_MICROS, { receivedAtMs: 1_000 });
    analyzer.recordLateDropped(FRAME_MICROS, 1_040);
  });
  assert.equal(cause, "render");
});

// jitter buffer が無効で、表示キューがあふれて N を捨てた。N の表示の時刻は P の表示から
// TIMESTAMP の差の後 (1,040 ms) であり、N はそれより後に届いた
test("classify: キューのあふれで捨てた次のフレームが遅れて届いていたら arrival にする", () => {
  const cause = classifyAfterNext((analyzer) => {
    receiveAndDecode(analyzer, position(0n, 6n), FRAME_MICROS, { receivedAtMs: 1_080 });
    analyzer.recordQueueDropped(FRAME_MICROS);
  });
  assert.equal(cause, "arrival");
});

// ============================================================================
// 今回表示したフレームが表示の時刻に間に合わなかった
// ============================================================================

/**
 * P の次のフレーム (Group 0 の Object 6、TIMESTAMP 40 ms) を 1,100 ms に表示したときの原因
 *
 * 表示の時刻は、jitter buffer の表示時刻 (presentationMs) か、無ければ P の表示から
 * TIMESTAMP の差の後 (1,040 ms) である
 */
function classifyLateCurrent(times: FrameTimes, presentationMs: number | null): string {
  const analyzer = analyzerWithPrevious();
  receiveAndDecode(analyzer, position(0n, 6n), FRAME_MICROS, times);
  analyzer.recordDisplayed(FRAME_MICROS, presentationMs);
  return classifyCurrent(analyzer, FRAME_MICROS);
}

// 表示の時刻 1,040 ms に対し、1,090 ms に届いた。経路と relay の遅れである
test("classify: 表示したフレームが表示の時刻の後に届いたら arrival にする", () => {
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_090 }, null), "arrival");
});

// 表示の時刻から通常の復号時間 (2 ms) を引いた時刻より後に届いたら、復号が普通に
// 終わっても間に合わない
test("classify: 通常の復号時間を見込んで間に合わない到着は arrival にする", () => {
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_039, decodedAtMs: 1_041 }, null), "arrival");
});

// 1,010 ms に届いたが、Group の切り替えの保留を 1,090 ms まで出られなかった
test("classify: 保留を解くのが表示の時刻に間に合わなければ groupSwitchHold にする", () => {
  assert.equal(
    classifyLateCurrent({ receivedAtMs: 1_010, releasedAtMs: 1_090 }, null),
    "groupSwitchHold",
  );
});

// 1,010 ms に届いて保留もされなかったが、復号の出力が 1,095 ms になった
test("classify: 復号の出力が表示の時刻に間に合わなければ decode にする", () => {
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_010, decodedAtMs: 1_095 }, null), "decode");
});

// 1,012 ms に表示できる状態だったが、jitter buffer の表示時刻が 1,100 ms だった。P の表示
// から 100 ms 後であり、閾値 (60 ms) を超える。再生遅延が増えた
test("classify: jitter buffer の表示時刻そのものが遅れたら playout にする", () => {
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_010 }, 1_100), "playout");
});

// 1,012 ms に表示できる状態で、表示時刻 1,040 ms を迎えたが、描いたのは 1,100 ms だった
test("classify: 表示時刻を迎えても描くのが遅れたら render にする", () => {
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_010 }, 1_040), "render", "jitter buffer");
  assert.equal(classifyLateCurrent({ receivedAtMs: 1_010 }, null), "render", "jitter buffer 無し");
});

// ============================================================================
// 記録が無い
// ============================================================================

// 受け取った記録の無いフレームの表示 (窓より古い、TIMESTAMP が無い) では原因を決められない
test("classify: 記録の無いフレームは unknown にする", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  assert.equal(classifyCurrent(analyzer, FRAME_MICROS), "unknown");
});

// 窓より前に受け取ったフレームの記録は捨てる
test("recordReceived: 窓より前に受け取ったフレームの記録を捨てる", () => {
  const analyzer = analyzerWithPrevious();
  // P は 900 ms に受け取っており、窓 (10 秒) を過ぎた後に次のフレームを受け取る
  receiveAndDecode(analyzer, position(0n, 6n), FRAME_MICROS, { receivedAtMs: 900 + WINDOW_MS + 1 });
  analyzer.recordDisplayed(FRAME_MICROS, null);

  assert.isNull(analyzer.positionOf(0), "P の記録を捨てること");
  assert.equal(classifyCurrent(analyzer, FRAME_MICROS), "unknown");
});

// ============================================================================
// 受信の欠け
// ============================================================================

// Object 2 が届かなければ 1 つ欠け、後から届けば欠けではなくなる。重複は数えない
test("receptionGaps: Group の中の Object ID の飛びを数え、後から届いたら戻す", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  for (const objectId of [0n, 1n, 3n]) {
    analyzer.recordReceived(position(0n, objectId), 0n, null, 0);
  }
  assert.equal(analyzer.receptionGaps().missingObjects, 1);

  analyzer.recordReceived(position(0n, 2n), 0n, null, 0);
  analyzer.recordReceived(position(0n, 2n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingObjects, 0);
});

// 購読は Group の途中から始まりうるため、最初の Group の先頭の欠けは数えない。
// 2 つ目以降の Group は Object 0 から数える
test("receptionGaps: 最初の Group は最初に受け取った Object から、以降の Group は先頭から数える", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  analyzer.recordReceived(position(5n, 30n), 0n, null, 0);
  analyzer.recordReceived(position(5n, 31n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingObjects, 0, "最初の Group の途中からの開始");

  analyzer.recordReceived(position(6n, 2n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingObjects, 2, "次の Group の先頭 2 つの欠け");
});

// Prior Object ID Gap で publisher が示した Object は存在しないため、欠けに数えない
test("receptionGaps: Prior Object ID Gap で示した飛びは数えない", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  analyzer.recordReceived(position(0n, 0n), 0n, null, 0);
  analyzer.recordReceived(position(0n, 3n, 2n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingObjects, 0);
});

// Group 1 と 2 が届かなければ 2 つ欠け、Group 1 が後から届けば 1 つに戻る。購読の最初の
// Group より前の Group は数えない
test("receptionGaps: Group ID の飛びを数え、後から届いたら戻す", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  analyzer.recordReceived(position(10n, 0n), 0n, null, 0);
  analyzer.recordReceived(position(13n, 0n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingGroups, 2);

  analyzer.recordReceived(position(11n, 0n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingGroups, 1);

  analyzer.recordReceived(position(9n, 0n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingGroups, 1, "最初の Group より前は数えない");
});

// 古い Group の記録は忘れるが、忘れた Group の Object が後から届いても二重に数えない
test("receptionGaps: 忘れた Group の Object が届いても二重に数えない", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  for (let groupId = 0n; groupId <= BigInt(MAX_TRACKED_GROUPS); groupId++) {
    analyzer.recordReceived(position(groupId, 0n), 0n, null, 0);
  }
  assert.equal(analyzer.receptionGaps().missingGroups, 0);

  // Group 0 は忘れている。重複して届いても、受け取った Group として数え直さない
  analyzer.recordReceived(position(0n, 0n), 0n, null, 0);
  assert.equal(analyzer.receptionGaps().missingGroups, 0);
});

// RESET_STREAM で終わった stream は、Object を受け取っていない stream も数える
test("receptionGaps: RESET_STREAM で終わった Subgroup の stream を数える", () => {
  const analyzer = new StallAnalyzer(WINDOW_MS);
  analyzer.recordReceived(position(0n, 0n), 0n, null, 0);
  analyzer.recordSubgroupEnd(0n, 0n, "reset");
  analyzer.recordSubgroupEnd(1n, undefined, "reset");
  analyzer.recordSubgroupEnd(2n, undefined, "fin");
  assert.equal(analyzer.receptionGaps().subgroupStreamResets, 2);
});

// 購読を始め直したときは、前の購読の記録を持ち越さない
test("reset: 記録と受信の欠けを初期状態に戻す", () => {
  const analyzer = analyzerWithPrevious();
  analyzer.recordReceived(position(0n, 9n), 0n, null, 0);
  analyzer.recordSubgroupEnd(0n, 0n, "reset");
  analyzer.reset();

  assert.deepEqual(analyzer.receptionGaps(), {
    missingObjects: 0,
    missingGroups: 0,
    subgroupStreamResets: 0,
  });
  assert.isNull(analyzer.positionOf(0));
});
