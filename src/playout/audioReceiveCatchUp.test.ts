/**
 * AudioReceiveCatchUp (受信側の音声の追いつき) の単体テスト
 *
 * 「復号の出力が送られた TIMESTAMP からどれだけ遅れているか」の観測と、遅れが健全時の値から
 * 一定を超えたまま続いたときに復号器を作り直させる判定を固定する。値は実装に合わせて書くの
 * ではなく、実測 (実リレーの E2E の失敗で、音声の基準の遅れが 116.4 ms から 256.2 ms へ
 * 段差で上がり、そのまま戻らなかった) と同じ形の入力列を作って確かめる。
 *
 * 時刻と値は呼び出し側が渡すため、実時間を使わずに「健全な状態」「遅れが段差で上がった状態」
 * 「作り直しが効いて戻った状態」をそのまま作れる。ブラウザ API は使わない。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS,
  AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS,
  AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS,
  AUDIO_RECEIVE_CATCH_UP_GROWTH_MS,
  AUDIO_RECEIVE_CATCH_UP_JUMP_MS,
  AUDIO_RECEIVE_CATCH_UP_MIN_MS,
  AudioReceiveCatchUp,
} from "./audioReceiveCatchUp";

/** 音声の 1 音の長さ (ミリ秒)。opus のパケットと同じ 20 ms にする */
const FRAME_INTERVAL_MS = 20;

/** テストで使う、意図した復号前の遅延 (ミリ秒) */
const INTENTIONAL_DELAY_MS = 2_000;

/** 復号の出力の timestamp の起点 (Unix epoch マイクロ秒)。実時間と同じ桁にする */
const TIMESTAMP_ORIGIN_MICROS = 1_800_000_000_000_000;

/**
 * 健全な状態の遅れ (ミリ秒)
 *
 * 実測 (手元の実リレー) では 18〜19 ms、実リレーの E2E の失敗では 116 ms 前後だった。
 * 下限 (`AUDIO_RECEIVE_CATCH_UP_MIN_MS` = 60 ms) より小さい値を使い、床が下限に当たる形と、
 * 床が下限を超える形の両方を作れるようにする
 */
const HEALTHY_LAG_MS = 20;

/** 実リレーの E2E の失敗で観測された、健全な状態の遅れ (ミリ秒) */
const RELAY_HEALTHY_LAG_MS = 116;

/** 実リレーの E2E の失敗で観測された、段差の後の遅れ (ミリ秒) */
const RELAY_STEPPED_LAG_MS = 256;

/** 観測 1 つ分の入力と判定 */
interface Step {
  /** 観測した時刻 (ミリ秒) */
  readonly nowMs: number;
  /** 復号の出力の遅れ (ミリ秒) */
  readonly lagMs: number;
  /** 復号の出力の timestamp (マイクロ秒) */
  readonly timestampMicros: number;
  /** この観測で復号器の作り直しを求めたか */
  readonly rebuildDecoder: boolean;
}

/**
 * 遅れの並びを 20 ms 間隔で観測し、判定を記録する
 *
 * 復号の出力の timestamp は 1 音ずつ (20 ms) 進む (健全な状態では音が飛ばない)。
 * `skipsMs[i]` を渡すと、その音の手前で飛んだ長さ (ミリ秒) として timestamp に足す
 * (復号器を作り直した直後に、飛んだ分だけ timestamp が跳ぶ形)。
 *
 * @param catchUp - 観測する追いつきの判定
 * @param lagsMs - 音ごとの遅れ (ミリ秒)
 * @param skipsMs - 音ごとの、手前で飛んだ長さ (ミリ秒)。省略時は飛ばない
 * @param startAtMs - 最初の音の時刻 (ミリ秒)。省略時は 0 (前の観測から続けて観測する)
 * @param inputLagsMs - 音ごとの入力の遅れ (ミリ秒)。null のときは渡さない (入力の遅れを
 *   導入する前の挙動になり、出力の遅れだけを見る)
 */
function observeSeries(
  catchUp: AudioReceiveCatchUp,
  lagsMs: readonly number[],
  skipsMs: readonly number[] = [],
  startAtMs = 0,
  inputLagsMs: readonly number[] | null = null,
): Step[] {
  const steps: Step[] = [];
  let skippedMicros = 0;
  for (let index = 0; index < lagsMs.length; index++) {
    const nowMs = startAtMs + index * FRAME_INTERVAL_MS;
    const lagMs = lagsMs[index] ?? 0;
    skippedMicros += (skipsMs[index] ?? 0) * 1_000;
    const timestampMicros =
      TIMESTAMP_ORIGIN_MICROS + index * FRAME_INTERVAL_MS * 1_000 + skippedMicros;
    const decision = catchUp.observe({
      nowMs,
      lagMs,
      inputLagMs: inputLagsMs === null ? null : (inputLagsMs[index] ?? 0),
      durationMs: FRAME_INTERVAL_MS,
      timestampMicros,
    });
    steps.push({ nowMs, lagMs, timestampMicros, rebuildDecoder: decision.rebuildDecoder });
  }
  return steps;
}

/** 復号器の作り直しを求めた観測の時刻 (ミリ秒) */
function startTimesMs(steps: readonly Step[]): number[] {
  return steps.filter((step) => step.rebuildDecoder).map((step) => step.nowMs);
}

/** 健全な遅れが続く並びを作る */
function steadyLags(frames: number, lagMs: number): number[] {
  return Array.from({ length: frames }, () => lagMs);
}

/**
 * 完了条件: 健全な状態 (遅れが下限の内側) では始めない。床は観測した最小値であり、
 * 上限は床と `AUDIO_RECEIVE_CATCH_UP_GROWTH_MS` の大きい方になる。
 */
test("observe: 健全な状態では追いつきを始めない", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 20 ms の遅れが 5 秒続く (下限 60 ms の内側)
  const steps = observeSeries(catchUp, steadyLags(250, HEALTHY_LAG_MS));

  assert.deepEqual(startTimesMs(steps), []);
  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.lagMs, HEALTHY_LAG_MS);
  assert.isNull(snapshot.inputLagMs, "入力の遅れは渡していないこと");
  assert.equal(snapshot.decodeLagMs, HEALTHY_LAG_MS, "測れないときは出力の遅れそのものであること");
  assert.equal(snapshot.floorMs, HEALTHY_LAG_MS);
  // 床が下限より小さく観測されても、上限は下限を下回らない
  assert.equal(snapshot.limitMs, AUDIO_RECEIVE_CATCH_UP_MIN_MS);
  assert.equal(snapshot.catchingUp, false);
  assert.equal(snapshot.catchUpStarts, 0);
});

/**
 * 完了条件: 復号の出力の遅れが床から `AUDIO_RECEIVE_CATCH_UP_GROWTH_MS` を超えた環境
 * (実リレーの E2E の失敗と同じ 116 ms) では、上限が床 + 40 ms になり、下限 (60 ms) は
 * 使われない。段差 (実測の 256 ms) はこの上限を超える。
 */
test("observe: 床が下限を超える環境では、上限が床からの増加で決まる", () => {
  const catchUp = new AudioReceiveCatchUp();
  const steps = observeSeries(catchUp, steadyLags(50, RELAY_HEALTHY_LAG_MS));

  assert.deepEqual(startTimesMs(steps), []);
  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.floorMs, RELAY_HEALTHY_LAG_MS);
  assert.equal(snapshot.limitMs, RELAY_HEALTHY_LAG_MS + AUDIO_RECEIVE_CATCH_UP_GROWTH_MS);
  assert.isTrue(snapshot.limitMs < RELAY_STEPPED_LAG_MS, "段差 (実測の 256 ms) が上限を超えること");
});

/**
 * 完了条件: 上限を 1 音だけ超えても、音声を映像へ合わせられる範囲 (床 + 100 ms) なら始めない。
 * 経路と復号が一瞬つまずいただけの状態 (実測: 遅れが 65 ms 前後) で始めないための確認である。
 */
test("observe: 上限を 1 音だけ超えても始めない", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 上限 (60 ms) は超えるが、床 (20 ms) + 100 ms には届かない
  const spikeMs = AUDIO_RECEIVE_CATCH_UP_MIN_MS + 5;
  const lagsMs = [...steadyLags(50, HEALTHY_LAG_MS), spikeMs, ...steadyLags(50, HEALTHY_LAG_MS)];
  const steps = observeSeries(catchUp, lagsMs);

  assert.deepEqual(startTimesMs(steps), []);
  assert.equal(catchUp.snapshot().maxLagMs, spikeMs);
  assert.equal(catchUp.snapshot().catchingUp, false);
});

/**
 * 完了条件: 音声を映像へ合わせられない遅れ (床から `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` を
 * 超えた分) では、持続の確認を待たずに始める。実測 (実リレー) の到着の遅れ 233 ms のように、
 * 待つ間に映像だけが先へ進んで、表示時刻の差が予算 (150 ms) を超えるためである。
 */
test("observe: 音声を映像へ合わせられない遅れでは持続を待たずに始める", () => {
  const catchUp = new AudioReceiveCatchUp();
  const spikeMs = HEALTHY_LAG_MS + AUDIO_RECEIVE_CATCH_UP_JUMP_MS + 1;
  // 段差の 1 音だけで始まる (持続を待たない)
  const steps = observeSeries(catchUp, [
    ...steadyLags(5, HEALTHY_LAG_MS),
    spikeMs,
    ...steadyLags(20, HEALTHY_LAG_MS),
  ]);

  assert.deepEqual(startTimesMs(steps), [100], "段差の音 (100 ms) で始めること");
  assert.equal(catchUp.snapshot().catchUpStarts, 1);
});

/**
 * 完了条件: 床 + `AUDIO_RECEIVE_CATCH_UP_JUMP_MS` ちょうどでは始めず、超えたら始める
 * (持続を待たない経路の境界)。
 */
test("observe: 床 + 100 ms ちょうどでは始めず、超えたら始める", () => {
  for (const extraMs of [AUDIO_RECEIVE_CATCH_UP_JUMP_MS, AUDIO_RECEIVE_CATCH_UP_JUMP_MS + 1]) {
    const catchUp = new AudioReceiveCatchUp();
    const steps = observeSeries(catchUp, [
      ...steadyLags(5, HEALTHY_LAG_MS),
      ...steadyLags(20, HEALTHY_LAG_MS + extraMs),
    ]);
    // ちょうどのときは、上限を超えた状態が 100 ms 続いてから始まる (t=200)
    const expected =
      extraMs > AUDIO_RECEIVE_CATCH_UP_JUMP_MS ? [100] : [AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS + 100];
    assert.deepEqual(startTimesMs(steps), expected, `床 + ${extraMs} ms`);
  }
});

/**
 * 完了条件: 上限を超えた状態が `AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS` (100 ms) 続いて
 * 初めて始める。境界 (4 音 = 80 ms では始めず、5 音 = 100 ms で始める) を固定する。
 */
test("observe: 上限を超えた状態が 100 ms 続いて初めて始める", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 5 音目 (index 5) で 100 ms へ上がる。上限 (60 ms) は超えるが、床 (20 ms) + 100 ms には
  // 届かないため、持続の確認を待つ経路になる
  const lagsMs = [...steadyLags(5, HEALTHY_LAG_MS), ...steadyLags(40, 100)];
  const steps = observeSeries(catchUp, lagsMs);

  // 段差の音 (index 5、100 ms) から 80 ms たった index 9 (180 ms) ではまだ始めない
  assert.equal(steps[9]?.rebuildDecoder, false, "80 ms では始めないこと");
  // 100 ms たった index 10 (200 ms) で始める
  assert.deepEqual(startTimesMs(steps), [200]);
  assert.equal(catchUp.snapshot().catchingUp, true);
  assert.equal(catchUp.snapshot().catchUpStarts, 1);
});

/**
 * 完了条件: 遅れの上限ちょうどでは始めず、超えたら始める (境界の比較)。
 */
test("observe: 上限ちょうどでは始めず、超えたら始める", () => {
  for (const lagMs of [AUDIO_RECEIVE_CATCH_UP_MIN_MS, AUDIO_RECEIVE_CATCH_UP_MIN_MS + 1]) {
    const catchUp = new AudioReceiveCatchUp();
    const steps = observeSeries(catchUp, [
      ...steadyLags(5, HEALTHY_LAG_MS),
      ...steadyLags(40, lagMs),
    ]);
    const expected = lagMs > AUDIO_RECEIVE_CATCH_UP_MIN_MS ? [200] : [];
    assert.deepEqual(startTimesMs(steps), expected, `遅れ ${lagMs} ms`);
  }
});

/**
 * 完了条件: 作り直しが効いて遅れが上限へ戻ったら、追いつきをやめる。やめた後の健全な
 * 状態では始めない (「頻発しないこと」の確認)。
 */
test("observe: 遅れが上限へ戻ったら追いつきをやめる", () => {
  const catchUp = new AudioReceiveCatchUp();
  const lagsMs = [
    ...steadyLags(5, HEALTHY_LAG_MS),
    ...steadyLags(20, 200),
    // 復号器を作り直した直後 (遅れが戻る)
    ...steadyLags(100, HEALTHY_LAG_MS),
  ];
  const steps = observeSeries(catchUp, lagsMs);

  assert.deepEqual(startTimesMs(steps), [100]);
  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.catchingUp, false, "遅れが戻ったら追いつきをやめること");
  assert.equal(snapshot.catchUpStarts, 1, "戻った後に始め直さないこと");
  // 観測した最大の遅れは残る (記録として読める)
  assert.equal(snapshot.maxLagMs, 200);
});

/**
 * 完了条件: 遅れが上限へ戻るまで、`AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS` (1 秒) ごとに
 * 始め直す。負荷の間に 1 回作り直しても戻らない状態 (実測: 6 倍に遅くした CPU で
 * メインスレッドを 60 ms 占有 / 40 ms 明け渡す負荷を 10 秒) から戻すための確認である。
 *
 * 間隔を伸ばす案 (効かないまま繰り返すときだけ 2 倍にする) と、穴 (timestamp の跳び) の
 * 直後は始めない案の両方を実装して測ったが、どちらもパケロス 5 % で作り直しの回数は
 * 変わらなかった (40 秒に 30〜31 回)。穴の直後を 60 秒間始めないようにすると作り直しは
 * 1 回になるが、遅れが 1458 ms まで育ち、鳴らした長さも 30 秒で 27835 ms へ落ちた。
 * 作り直しは、損失下でも live を保つ役目を果たしている (詳細は
 * `docs/AUDIO_PLAYOUT_LATENCY.md`)
 */
test("observe: 戻らない間はクールダウンごとに始め直す", () => {
  const catchUp = new AudioReceiveCatchUp();
  const lagsMs = [...steadyLags(5, HEALTHY_LAG_MS), ...steadyLags(300, 300)];
  const steps = observeSeries(catchUp, lagsMs);

  // 段差の音 (100 ms) で始まり、その後はクールダウンごとに始め直す。段差の 5 秒後
  // (5000 ms の床の窓が 300 ms で埋まる時点) に床が上がって始まらなくなる
  const expectedStartTimes = [0, 1, 2, 3, 4].map(
    (index) => 100 + index * AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS,
  );
  assert.deepEqual(startTimesMs(steps), expectedStartTimes);
  assert.equal(catchUp.snapshot().catchUpStarts, expectedStartTimes.length);
});

test("observe: 追いつきで飛んだ音の長さを timestamp の跳びから測る", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 実測の段差 (116 ms から 256 ms へ) を作る。段差の分 (140 ms) の音が溜まっている
  const lagsMs = [
    ...steadyLags(5, RELAY_HEALTHY_LAG_MS),
    ...steadyLags(20, RELAY_STEPPED_LAG_MS),
    ...steadyLags(20, RELAY_HEALTHY_LAG_MS),
  ];
  // index 25 = 作り直しの直後の音。手前で 140 ms 分 (7 音) が捨てられている
  const skipsMs = lagsMs.map((_, index) => (index === 25 ? 140 : 0));
  const steps = observeSeries(catchUp, lagsMs, skipsMs);

  assert.deepEqual(startTimesMs(steps), [100]);
  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.skippedFrames, 7, "飛んだ音の数 (140 ms / 20 ms)");
  assert.closeTo(snapshot.skippedMs, 140, 1e-6, "飛んだ音の長さ");
  assert.closeTo(snapshot.lastSkippedMs ?? 0, 140, 1e-6);
  // 遅れが戻っているため、この観測で追いつきは終わる
  assert.equal(snapshot.catchingUp, false);
});

/**
 * 完了条件: 追いつきの最中でないときの timestamp の跳び (配信側の欠落、relay の cache の
 * 再送など) は、追いつきで捨てた音として数えない。
 */
test("observe: 追いつきの最中でない跳びは数えない", () => {
  const catchUp = new AudioReceiveCatchUp();
  const lagsMs = steadyLags(50, HEALTHY_LAG_MS);
  // index 25 の手前で 140 ms 分が欠けている (追いつきは始まっていない)
  const skipsMs = lagsMs.map((_, index) => (index === 25 ? 140 : 0));
  observeSeries(catchUp, lagsMs, skipsMs);

  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.skippedFrames, 0);
  assert.equal(snapshot.skippedMs, 0);
  assert.isNull(snapshot.lastSkippedMs);
  assert.equal(snapshot.catchUpStarts, 0);
});

/**
 * 完了条件: 床は直近の窓 (`AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS` = 5 秒) の最小値で
 * あり、遅れが上がったまま窓が埋まると上限も上がって始まらなくなる (「頻発しないこと」の
 * 確認)。環境が恒久的に悪化した状態で作り直しを繰り返さないための性質である。
 */
test("observe: 床は直近の窓の最小値であり、上がったままなら始めなくなる", () => {
  const catchUp = new AudioReceiveCatchUp();
  const frames = 400; // 8 秒
  const windowFrames = AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS / FRAME_INTERVAL_MS;
  const lagsMs = Array.from({ length: frames }, (_, index) => (index < 5 ? HEALTHY_LAG_MS : 300));
  const steps = observeSeries(catchUp, lagsMs);

  // 5 秒の窓が 300 ms で埋まるまでは始め直す
  const starts = startTimesMs(steps);
  const lastStartMs = starts[starts.length - 1] ?? Number.NaN;
  assert.isBelow(lastStartMs, windowFrames * FRAME_INTERVAL_MS, "窓が埋まるまでは始めること");
  assert.isAbove(starts.length, 1, "1 回では戻らないため始め直すこと");
  // 窓が埋まった後は、上限が 300 + 40 ms になるため始まらない
  assert.deepEqual(
    steps.filter((step) => step.rebuildDecoder && step.nowMs > windowFrames * FRAME_INTERVAL_MS),
    [],
    "窓が埋まった後は始めないこと",
  );
  assert.equal(catchUp.snapshot().floorMs, 300);
  assert.equal(catchUp.snapshot().limitMs, 300 + AUDIO_RECEIVE_CATCH_UP_GROWTH_MS);
});

/**
 * 完了条件: `reset()` は観測と累積を消し、次の観測から床を作り直す (購読のやり直し)。
 */
test("reset: 観測と累積を消す", () => {
  const catchUp = new AudioReceiveCatchUp();
  observeSeries(catchUp, [...steadyLags(5, HEALTHY_LAG_MS), ...steadyLags(20, 200)]);
  catchUp.reset();

  const snapshot = catchUp.snapshot();
  assert.isNull(snapshot.lagMs);
  assert.isNull(snapshot.inputLagMs);
  assert.isNull(snapshot.decodeLagMs);
  assert.isNull(snapshot.floorMs);
  assert.isNull(snapshot.maxLagMs);
  assert.equal(snapshot.catchUpStarts, 0);
  assert.equal(snapshot.catchingUp, false);

  // 消した後の観測から床を作り直す。床は消えるため、最初の観測ではその遅れ自身が床に
  // なり (上限 = 遅れ + 40 ms)、その状態では始まらない
  const steps = observeSeries(catchUp, [...steadyLags(5, 200), ...steadyLags(20, 200)]);
  assert.deepEqual(startTimesMs(steps), [], "床が消えているため、最初は始めないこと");
  // 消した後の健全な観測で床が下がれば、その後の段差では始める
  const catchUp2 = new AudioReceiveCatchUp();
  const steps2 = observeSeries(catchUp2, [
    ...steadyLags(5, HEALTHY_LAG_MS),
    ...steadyLags(20, 200),
  ]);
  assert.deepEqual(startTimesMs(steps2), [100]);
});

/**
 * 完了条件: 遅れが戻った後の観測で床が下がり、上限も戻る (作り直しが効いた後の状態)。
 * 戻った直後にもう一度段差が来たら、また始められる。
 */
test("observe: 戻った後の段差でも、また始められる", () => {
  const catchUp = new AudioReceiveCatchUp();
  const lagsMs = [
    ...steadyLags(5, HEALTHY_LAG_MS),
    ...steadyLags(20, 200),
    ...steadyLags(100, HEALTHY_LAG_MS),
    ...steadyLags(20, 200),
  ];
  const steps = observeSeries(catchUp, lagsMs);

  const starts = startTimesMs(steps);
  assert.equal(starts.length, 2);
  assert.equal(starts[0], 100);
  // 2 回目は 2 度目の段差 (index 125 = 2500 ms) の音
  assert.equal(starts[1], 2_500);
  assert.equal(catchUp.snapshot().catchUpStarts, 2);
});

/**
 * 完了条件: 観測が窓 (`AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS`) より長く途切れた後も、
 * 途切れる前の床を保つ。途切れている間に溜まった分をそのまま床にすると、遅れが健全な値と
 * みなされ、追いつきが始まらなくなる (実測: 途切れた後、遅れが 150 ms のまま固定され、
 * 始まらなかった)。
 */
test("observe: 観測が途切れた後も、途切れる前の床を保つ", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 健全な状態 (床 20 ms) を 2 秒観測する
  observeSeries(catchUp, steadyLags(100, HEALTHY_LAG_MS));
  assert.equal(catchUp.snapshot().floorMs, HEALTHY_LAG_MS);

  // 窓 (5 秒) より長く途切れ、その間に溜まった分が 150 ms の遅れとして現れる
  const resumeAtMs = 100 * FRAME_INTERVAL_MS + AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS + 1;
  const steps = observeSeries(catchUp, steadyLags(20, 150), [], resumeAtMs);

  // 途切れる前の床 (20 ms) が保たれるため、150 ms は上限 (60 ms) を超え、かつ床 + 100 ms も
  // 超えるので、その場で始まる
  assert.deepEqual(startTimesMs(steps), [resumeAtMs]);
  assert.equal(catchUp.snapshot().catchUpStarts, 1);
});

// ============================================================================
// 入力の遅れ (Object の到着 - LOC TIMESTAMP) で「経路が遅い」と「受信側が溜めている」を分ける
// ============================================================================

/** 健全なときの入力の遅れ (ミリ秒)。受信の入口で測る Object の到着 - LOC TIMESTAMP */
const HEALTHY_INPUT_LAG_MS = 25;

/** 健全なときの、到着から復号の出力までの分 (ミリ秒)。出力の遅れは 30 ms になる */
const HEALTHY_DECODE_LAG_MS = 5;

/** 受信側がまとめて遅れている間の入力の遅れ (ミリ秒)。実測の段差 (250 ms 前後) に合わせる */
const BLOCKED_INPUT_LAG_MS = 250;

/** 復号器に溜まる分 (ミリ秒)。出力の遅れ 250 ms - 入力の遅れ 25 ms。実時間でしか出てこない */
const STUCK_DECODE_LAG_MS = 225;

/** 受信側がまとめて遅れ始める時刻 (ミリ秒)。8 秒 */
const BLOCK_START_MS = 8_000;

/** 受信側の遅れが直る時刻 (ミリ秒)。20 秒。復号器に溜まった分は残る */
const RECOVERY_MS = 20_000;

/** この節の観測の長さ (ミリ秒)。60 秒 */
const STUCK_SCENARIO_MS = 60_000;

/** 受信側が溜めたまま戻らない状態を駆動した結果 */
interface StuckDecoderRun {
  /** 作り直しを求めた時刻 (ミリ秒) */
  readonly startTimesMs: number[];
  /** 受信側の遅れが直った後 (20 秒以降) に作り直しを求めた時刻 (ミリ秒) */
  readonly afterRecoveryStartTimesMs: number[];
  /** 受信側の遅れが直った後に観測した出力の遅れの最小値 (ミリ秒) */
  readonly minLagAfterRecoveryMs: number;
  /** 最後に観測した出力の遅れ (ミリ秒) */
  readonly finalLagMs: number;
  /** 最後の床 (ミリ秒) */
  readonly finalFloorMs: number | null;
  /** 最後の「復号が足している遅れ」 (ミリ秒) */
  readonly finalDecodeLagMs: number | null;
}

/**
 * 受信側が溜めたまま戻らない状態を、実装を駆動して作る
 *
 * - 0〜8 秒: 健全。入力の遅れ 25 ms、復号の出力の遅れ 30 ms
 * - 8〜20 秒: 受信側がまとめて遅れる。Object の到着も復号の出力も 250 ms 前後遅れるが、
 *   復号器の中には溜まっていない (入力の遅れも同じだけ上がる)
 * - 20 秒以降: 受信側は直り、入力の遅れは 25 ms へ戻る。ところが、遅れていた間に届いた
 *   Object がまとめて復号へ入り、復号器の中に 225 ms が溜まったままになる (実時間でしか
 *   出てこない)。作り直すと捨てられて、出力の遅れは 30 ms へ戻る
 *
 * @param catchUp - 観測する追いつきの判定
 * @param useInputLag - 入力の遅れを渡すか。false のときは導入前の挙動 (出力の遅れだけを見る)
 */
function observeStuckDecoder(catchUp: AudioReceiveCatchUp, useInputLag: boolean): StuckDecoderRun {
  const startTimes: number[] = [];
  let stuckDecodeLagMs = 0;
  let wasBlocked = false;
  let minLagAfterRecoveryMs = Number.POSITIVE_INFINITY;
  let finalLagMs = 0;
  for (let index = 0; index < STUCK_SCENARIO_MS / FRAME_INTERVAL_MS; index++) {
    const nowMs = index * FRAME_INTERVAL_MS;
    const blocked = nowMs >= BLOCK_START_MS && nowMs < RECOVERY_MS;
    const inputLagMs = blocked ? BLOCKED_INPUT_LAG_MS : HEALTHY_INPUT_LAG_MS;
    if (wasBlocked && !blocked) {
      // 遅れていた分がまとめて復号へ入り、復号器の中に溜まる
      stuckDecodeLagMs = STUCK_DECODE_LAG_MS;
    }
    wasBlocked = blocked;
    const lagMs = inputLagMs + HEALTHY_DECODE_LAG_MS + stuckDecodeLagMs;
    finalLagMs = lagMs;
    if (nowMs >= RECOVERY_MS) {
      minLagAfterRecoveryMs = Math.min(minLagAfterRecoveryMs, lagMs);
    }
    const decision = catchUp.observe({
      nowMs,
      lagMs,
      inputLagMs: useInputLag ? inputLagMs : null,
      durationMs: FRAME_INTERVAL_MS,
      timestampMicros: TIMESTAMP_ORIGIN_MICROS + nowMs * 1_000,
    });
    if (decision.rebuildDecoder) {
      startTimes.push(nowMs);
      // 復号器を作り直した。溜まっていた分は捨てられる
      stuckDecodeLagMs = 0;
    }
  }
  const snapshot = catchUp.snapshot();
  return {
    startTimesMs: startTimes,
    afterRecoveryStartTimesMs: startTimes.filter((atMs) => atMs >= RECOVERY_MS),
    minLagAfterRecoveryMs:
      minLagAfterRecoveryMs === Number.POSITIVE_INFINITY ? 0 : minLagAfterRecoveryMs,
    finalLagMs,
    finalFloorMs: snapshot.floorMs,
    finalDecodeLagMs: snapshot.decodeLagMs,
  };
}

/**
 * 完了条件 (欠陥 4): 入力の遅れが健全なまま、復号の出力の遅れだけが大きい状態 (受信側が
 * 溜めている) では、20 秒に受信側が直った時点で作り直しを求め、復号器に溜まった音を捨てて
 * 出力の遅れを 30 ms へ戻す。床は「復号が足している遅れ」の最小値であるため、出力の遅れが
 * 250 ms のまま 5 秒続いても 5 ms のまま上がらない。
 *
 * 受信側が遅れている間 (8〜20 秒) は、入力の遅れも同じだけ上がるため作り直しを求めない
 * (経路が遅いだけの状態で、作り直しても戻らない)。
 */
test("observe: 受信側が溜めたまま戻らない状態では、直った時点で作り直しを求める", () => {
  const run = observeStuckDecoder(new AudioReceiveCatchUp(), true);

  // 受信側が遅れている間は、入力の遅れも上がるため求めない
  assert.deepEqual(
    run.startTimesMs.filter((atMs) => atMs < RECOVERY_MS),
    [],
    "経路が遅いだけの状態では作り直さないこと",
  );
  // 受信側が直った時点で、復号器に溜まった分 (225 ms) を捨てる
  assert.deepEqual(run.afterRecoveryStartTimesMs, [RECOVERY_MS], "直った時点で作り直すこと");
  // 作り直しが効いて、遅れは 30 ms 前後へ戻る
  assert.equal(run.minLagAfterRecoveryMs, HEALTHY_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS);
  assert.equal(run.finalLagMs, HEALTHY_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS);
  // 床は健全な値 (復号が足している 5 ms) のままで、出力の遅れ (250 ms) へ追いつかない
  assert.equal(run.finalFloorMs, HEALTHY_DECODE_LAG_MS);
  assert.equal(run.finalDecodeLagMs, HEALTHY_DECODE_LAG_MS);
});

/**
 * 完了条件 (欠陥 4 の再現): 入力の遅れを渡さない (導入前の挙動) と同じ入力では、出力の遅れが
 * 250 ms のまま 5 秒続いた時点で床が 250 ms へ追いつき、それ以降は作り直しを求めなくなる。
 * 20 秒に受信側が直っても、復号器に溜まった音は実時間でしか出てこないため、40 秒間 250 ms の
 * まま固定される (実装を駆動した再現と同じ形)。
 */
test("observe: 入力の遅れを渡さないと、床が出力の遅れへ追いついて求めなくなる", () => {
  const run = observeStuckDecoder(new AudioReceiveCatchUp(), false);

  // 段差の直後は作り直しを求める (入力の遅れが無いため、経路の遅れも段差に見える)
  assert.isAbove(run.startTimesMs.length, 1, "段差の直後は作り直しを求めること");
  // 5 秒の窓が 250 ms で埋まると、床が上がって求めなくなる
  assert.deepEqual(run.afterRecoveryStartTimesMs, [], "直った後も作り直しを求めないこと");
  assert.equal(run.finalFloorMs, BLOCKED_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS);
  assert.equal(run.finalLagMs, BLOCKED_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS, "250 ms のまま");
});

/**
 * 完了条件 (欠陥 4): 経路が恒久的に悪化した状態 (入力の遅れも出力の遅れも同じだけ上がる) では、
 * 作り直しを求めない。復号器の中に溜まっていないため、作り直しても遅れは戻らず、音を飛ばす
 * だけになる。
 */
test("observe: 経路が恒久的に悪化した状態では作り直しを求めない", () => {
  const catchUp = new AudioReceiveCatchUp();
  const frames = 3_000;
  // 5 音の健全な状態の後に、経路が恒久的に 250 ms 遅くなる。Object の到着も復号の出力も
  // 同じだけ遅れる (復号器の中には溜まっていない)
  const lagsMs = [
    ...steadyLags(5, HEALTHY_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS),
    ...steadyLags(frames - 5, BLOCKED_INPUT_LAG_MS + HEALTHY_DECODE_LAG_MS),
  ];
  const inputLagsMs = [
    ...steadyLags(5, HEALTHY_INPUT_LAG_MS),
    ...steadyLags(frames - 5, BLOCKED_INPUT_LAG_MS),
  ];
  const steps = observeSeries(catchUp, lagsMs, [], 0, inputLagsMs);

  assert.deepEqual(startTimesMs(steps), [], "入力の遅れも同じだけ上がるため求めないこと");
  assert.equal(catchUp.snapshot().decodeLagMs, HEALTHY_DECODE_LAG_MS);
  // 入力の遅れを渡さない場合は、同じ入力でも段差として作り直しを求める (導入前の挙動)。
  // 床が出力の遅れへ追いつくまで、クールダウンごとに繰り返す
  const legacy = observeSeries(new AudioReceiveCatchUp(), lagsMs);
  assert.isAbove(startTimesMs(legacy).length, 1, "導入前は段差で作り直しを繰り返すこと");
});

/**
 * 完了条件: 入力の遅れが測れないとき (TIMESTAMP が無い、Timescale がある) は、出力の遅れを
 * そのまま使う。入力の遅れを導入する前と同じ挙動であり、測れないことを理由に作り直しを
 * 止めない。
 */
test("observe: 入力の遅れが測れないときは、出力の遅れをそのまま使う", () => {
  const catchUp = new AudioReceiveCatchUp();
  // TIMESTAMP が無い / Timescale がある (メディア時刻である) 音では測れないため、呼び出し側は
  // null を渡す
  const startTimes: number[] = [];
  let timestampMicros = TIMESTAMP_ORIGIN_MICROS;
  for (let index = 0; index < 25; index++) {
    const nowMs = index * FRAME_INTERVAL_MS;
    const lagMs = index < 5 ? HEALTHY_LAG_MS : 200;
    const decision = catchUp.observe({
      nowMs,
      lagMs,
      inputLagMs: null,
      durationMs: FRAME_INTERVAL_MS,
      timestampMicros,
    });
    if (decision.rebuildDecoder) {
      startTimes.push(nowMs);
    }
    timestampMicros += FRAME_INTERVAL_MS * 1_000;
  }

  assert.deepEqual(startTimes, [100], "測れないときも、出力の遅れで判定すること");
  const snapshot = catchUp.snapshot();
  assert.isNull(snapshot.inputLagMs, "測れなかったことが残ること");
  assert.equal(snapshot.decodeLagMs, 200, "入力の遅れが無いときは出力の遅れそのもの");
});

/**
 * 完了条件: 購読側が意図して復号を遅らせている場合、その遅延は復号器に溜まった遅れではない。
 * 出力の遅れから意図した遅延を引いた値が健全な範囲なら、追いつきを始めない。
 */
test("observe: 意図した復号前の遅延は復号器の詰まりとして扱わない", () => {
  const catchUp = new AudioReceiveCatchUp();
  // 2 秒遅らせている。出力の遅れは「意図した遅延 + 入力の遅れ + 健全な復号の遅れ」になる
  const inputLagMs = 10;
  const lagMs = INTENTIONAL_DELAY_MS + inputLagMs + HEALTHY_LAG_MS;
  const startTimes: number[] = [];
  let timestampMicros = TIMESTAMP_ORIGIN_MICROS;
  for (let index = 0; index < 25; index++) {
    const nowMs = index * FRAME_INTERVAL_MS;
    const decision = catchUp.observe({
      nowMs,
      lagMs,
      inputLagMs,
      intentionalDelayMs: INTENTIONAL_DELAY_MS,
      durationMs: FRAME_INTERVAL_MS,
      timestampMicros,
    });
    if (decision.rebuildDecoder) {
      startTimes.push(nowMs);
    }
    timestampMicros += FRAME_INTERVAL_MS * 1_000;
  }

  assert.deepEqual(startTimes, [], "意図した遅延では作り直さないこと");
  const snapshot = catchUp.snapshot();
  assert.equal(snapshot.lagMs, lagMs, "観測した出力の遅れはそのまま残ること");
  assert.equal(snapshot.inputLagMs, inputLagMs);
  assert.equal(snapshot.decodeLagMs, HEALTHY_LAG_MS, "意図した遅延と入力の遅れを引くこと");
  assert.equal(snapshot.catchUpStarts, 0);
});

/**
 * 完了条件: TIMESTAMP が無い / Timescale がある音では入力の遅れを測れない。その場合でも
 * 意図した遅延だけは差し引き、復号器の詰まりと誤判定しない。
 */
test("observe: 入力の遅れが測れなくても意図した遅延を差し引く", () => {
  const catchUp = new AudioReceiveCatchUp();
  const decision = catchUp.observe({
    nowMs: 0,
    lagMs: INTENTIONAL_DELAY_MS + HEALTHY_LAG_MS,
    inputLagMs: null,
    intentionalDelayMs: INTENTIONAL_DELAY_MS,
    durationMs: FRAME_INTERVAL_MS,
    timestampMicros: TIMESTAMP_ORIGIN_MICROS,
  });

  assert.isFalse(decision.rebuildDecoder, "意図した遅延では作り直さないこと");
  const snapshot = catchUp.snapshot();
  assert.isNull(snapshot.inputLagMs);
  assert.equal(snapshot.decodeLagMs, HEALTHY_LAG_MS, "出力の遅れから意図した遅延を引くこと");
});

/**
 * 完了条件: 意図した遅延を差し引いた後に復号器が実際に詰まったら、従来どおり追いつきを
 * 始める。意図した遅延が判定を覆い隠さない。
 */
test("observe: 意図した遅延を超えて復号器が遅れたら追いつきを始める", () => {
  const catchUp = new AudioReceiveCatchUp();
  const inputLagMs = 10;
  const healthyLagMs = INTENTIONAL_DELAY_MS + inputLagMs + HEALTHY_LAG_MS;
  let timestampMicros = TIMESTAMP_ORIGIN_MICROS;
  const observe = (nowMs: number, lagMs: number) => {
    const decision = catchUp.observe({
      nowMs,
      lagMs,
      inputLagMs,
      intentionalDelayMs: INTENTIONAL_DELAY_MS,
      durationMs: FRAME_INTERVAL_MS,
      timestampMicros,
    });
    timestampMicros += FRAME_INTERVAL_MS * 1_000;
    return decision;
  };

  // 5 秒間は健全な復号の遅れ (20 ms) が続く
  for (let index = 0; index < 250; index++) {
    assert.isFalse(
      observe(index * FRAME_INTERVAL_MS, healthyLagMs).rebuildDecoder,
      "健全な間は作り直さないこと",
    );
  }
  // 復号器が 150 ms 余計に詰まる。意図した遅延を引いても 170 ms の遅れが残る
  const decision = observe(250 * FRAME_INTERVAL_MS, healthyLagMs + 150);

  assert.isTrue(decision.rebuildDecoder, "意図した遅延を超えたら作り直すこと");
  assert.equal(catchUp.snapshot().decodeLagMs, HEALTHY_LAG_MS + 150);
});
