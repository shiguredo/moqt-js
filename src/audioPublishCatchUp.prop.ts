/**
 * AudioPublishCatchUp の Property-Based Tests
 *
 * 追いつきの状態が必ず解除されることを確かめる。実測 (devtools の配信、16 秒) では、
 * `AudioData.timestamp` が重複したときに記録が上書きされ、追いつきを始めた後はキューが
 * はけても解除されず、1805 フレーム (14440 ms) を捨てたまま音声が送られなくなった
 * (`catchingUp: true` / `catchUpStarts: 1` / `pendingMs: 32` / `pendingFrames: 0`)。
 *
 * ここでは timestamp の進み方 (実時間・重複・逆行・停滞) と読み出しの遅れ、符号化の速さを
 * 任意に作り、「キューがはけて読み出しが健全になれば、必ず投入を再開する」ことを確かめる。
 * 個別の規則と境界値は audioPublishCatchUp.test.ts が固定する。
 *
 * 期待値は実装と別に書く (このテストは状態機械の観測だけを見る)。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { AudioPublishCatchUp } from "./audioPublishCatchUp";
import { PacketizingEncoder } from "./testSupport/audioPublishCatchUpModel";

/** devtools の音声の 1 フレーム (128 フレーム / 16000 Hz = 8 ms) */
const FRAME_MICROS = 8_000;
/** opus の 1 パケット (20 ms) */
const PACKET_MICROS = 20_000;
/** 壁時計の原点。timestamp と同じ桁にして、補正が無くても遅れが小さい値になるようにする */
const WALL_CLOCK_EPOCH_MICROS = 1_800_000_000_000_000;
/** 健全な状態の読み出しの間隔 (マイクロ秒) */
const FRAME_ELAPSED_MICROS = 8_000;
/** 追いつきを確かめる前に流すフレームの数 */
const RECOVERY_FRAMES = 200;
/** 回復したとみなす、最後に見るフレームの数 */
const RECOVERY_TAIL_FRAMES = 50;

/** 読み出し 1 回の形 */
interface ReadStep {
  /** 読み出した壁時計が進む長さ (マイクロ秒) */
  readonly elapsedMicros: number;
  /** `AudioData.timestamp` が進む長さ (マイクロ秒)。0 なら同じ値が続く */
  readonly timestampStepMicros: number;
  /** このフレームを読むときの符号化の速さ (1 パケットあたりのミリ秒) */
  readonly drainMsPerPacket: number;
}

/**
 * 同じ形が続く区間
 *
 * 追いつきは「上限を超えた状態が続いた」ときに始まるため、1 フレームずつ乱数で選ぶと
 * 状態が始まらない。停滞・逆行・まとめて読む・実時間に追いつかない符号化のような状態を、
 * それぞれ数フレーム続く区間として作る
 */
interface ReadPhase {
  /** 区間のフレーム数 */
  readonly frames: number;
  /** 読み出した壁時計が 1 フレームで進む長さ (マイクロ秒) */
  readonly elapsedMicros: number;
  /** `AudioData.timestamp` が 1 フレームで進む長さ (マイクロ秒) */
  readonly timestampStepMicros: number;
  /** この区間の符号化の速さ (1 パケットあたりのミリ秒) */
  readonly drainMsPerPacket: number;
}

/**
 * 区間を作る
 *
 * - 読み出し: 実時間 (8000)、まとめて読む (1000)、停滞して遅れて読む (20000)
 * - timestamp: 実時間 (8000)、同じ値が続く (0)、逆行する (-8000)、現在へ飛ぶ (48000)
 * - 符号化: 実時間より速い (1)、実時間 (20)、実時間に追いつかない (60)
 */
const readPhaseArbitrary: fc.Arbitrary<ReadPhase> = fc.record({
  frames: fc.integer({ min: 1, max: 40 }),
  elapsedMicros: fc.constantFrom(1_000, 8_000, 8_000, 20_000),
  timestampStepMicros: fc.constantFrom(-8_000, 0, 8_000, 8_000, 48_000),
  drainMsPerPacket: fc.constantFrom(1, 20, 20, 60),
});

/** 区間を 1 フレームずつの読み出しの列へ展開する */
function expandPhases(phases: readonly ReadPhase[]): ReadStep[] {
  const steps: ReadStep[] = [];
  for (const phase of phases) {
    for (let index = 0; index < phase.frames; index++) {
      steps.push({
        elapsedMicros: phase.elapsedMicros,
        timestampStepMicros: phase.timestampStepMicros,
        drainMsPerPacket: phase.drainMsPerPacket,
      });
    }
  }
  return steps;
}

/** 読み出しの列 (区間を展開したもの) */
const readStepsArbitrary: fc.Arbitrary<ReadStep[]> = fc
  .array(readPhaseArbitrary, { minLength: 1, maxLength: 8 })
  .map((phases) => expandPhases(phases));

/**
 * 列を流す
 *
 * @param steps - 読み出しの列
 * @returns 追いつきを始めたか、回復した後に捨てたフレームの数、最後の観測
 */
function run(steps: readonly ReadStep[]): {
  started: boolean;
  /** 回復の最後の `RECOVERY_TAIL_FRAMES` フレームで捨てた数 */
  dropsInRecoveryTail: number;
  final: ReturnType<AudioPublishCatchUp["snapshot"]>;
} {
  const catchUp = new AudioPublishCatchUp();
  const encoder = new PacketizingEncoder(catchUp, {
    frameMicros: FRAME_MICROS,
    packetMicros: PACKET_MICROS,
    drainMsPerPacket: 20,
  });
  let wallClockMicros = WALL_CLOCK_EPOCH_MICROS;
  let timestampMicros = WALL_CLOCK_EPOCH_MICROS;
  let nowMs = 1_000;

  /** 1 フレーム読む */
  const read = (step: ReadStep): boolean => {
    wallClockMicros += step.elapsedMicros;
    timestampMicros += step.timestampStepMicros;
    encoder.drainMsPerPacket = step.drainMsPerPacket;
    const encode = catchUp.evaluate({
      timestampMicros,
      readWallClockMicros: BigInt(wallClockMicros),
      appliedOffsetMicros: 0n,
      durationMicros: FRAME_MICROS,
      nowMs,
    });
    if (encode) {
      encoder.encode(nowMs);
    }
    encoder.drain(nowMs);
    nowMs += FRAME_MICROS / 1_000;
    // 記録が無いのにキューに残っている長さがあると、追いつきをやめる条件に届かなくなる
    const stats = catchUp.snapshot();
    if (stats.pendingFrames === 0) {
      assert.isAtMost(stats.pendingMs, 0.001, "記録が無いのにキューに長さが残っている");
    }
    return encode;
  };

  for (const step of steps) {
    read(step);
  }
  const started = catchUp.snapshot().catchUpStarts > 0;

  // 読み出しが健全になり、符号化が実時間より速い状態を続ける。音声の時計が停滞していた
  // 場合も、時計が壁時計へ戻った (読み出しの遅れが 0 になった) 状態から確かめる
  timestampMicros = wallClockMicros;
  const recovered: boolean[] = [];
  for (let index = 0; index < RECOVERY_FRAMES; index++) {
    recovered.push(
      read({
        elapsedMicros: FRAME_ELAPSED_MICROS,
        timestampStepMicros: FRAME_MICROS,
        drainMsPerPacket: 1,
      }),
    );
  }
  const tail = recovered.slice(recovered.length - RECOVERY_TAIL_FRAMES);
  return {
    started,
    dropsInRecoveryTail: tail.filter((encode) => !encode).length,
    final: catchUp.snapshot(),
  };
}

test("キューがはけて読み出しが健全になれば、どんな timestamp の並びでも追いつきをやめる", () => {
  // 実測では、符号化が実時間に追いつかなくなって追いつきを始めた後、キューがはけても
  // 解除されず、捨てたフレームだけが増え続けた。timestamp が重複しても解除されること
  fc.assert(
    fc.property(readStepsArbitrary, (steps) => {
      const result = run(steps);
      assert.isFalse(
        result.final.catchingUp,
        `キューがはけたのに追いつき中が続いている (started=${result.started})`,
      );
      assert.isAtMost(result.final.pendingMs, 20, "キューがはけたのに長さが残っている");
      assert.strictEqual(result.dropsInRecoveryTail, 0, "読み出しが健全なのにフレームを捨てている");
    }),
  );
});

test("このテストの入力列は、実際に追いつきを始める (性質が空振りしないことの確認)", () => {
  // 追いつきが始まらない入力だけでは、上の性質は何も確かめていないことになる。実測と
  // 同じ形 (符号化が 1 パケット 60 ms で実時間に追いつかず、キューが伸びる) を固定で置く
  const overload: ReadPhase = {
    frames: 40,
    elapsedMicros: FRAME_ELAPSED_MICROS,
    timestampStepMicros: FRAME_MICROS,
    drainMsPerPacket: 60,
  };
  const result = run(expandPhases([overload, overload]));
  assert.isTrue(result.started, "前提にした入力列で追いつきが始まっていない");
  assert.isFalse(result.final.catchingUp, "キューがはけたのに追いつき中が続いている");
});

test("追いつきを始めても、キューに残っている長さが記録した分を超えない", () => {
  // 長さの集計が記録より大きくなると、追いつきをやめる条件 (20 ms 以下) に届かなくなる
  fc.assert(
    fc.property(readStepsArbitrary, (steps) => {
      const catchUp = new AudioPublishCatchUp();
      const encoder = new PacketizingEncoder(catchUp, {
        frameMicros: FRAME_MICROS,
        packetMicros: PACKET_MICROS,
        drainMsPerPacket: 20,
      });
      let wallClockMicros = WALL_CLOCK_EPOCH_MICROS;
      let timestampMicros = WALL_CLOCK_EPOCH_MICROS;
      let nowMs = 1_000;
      for (const step of steps) {
        wallClockMicros += step.elapsedMicros;
        timestampMicros += step.timestampStepMicros;
        encoder.drainMsPerPacket = step.drainMsPerPacket;
        if (
          catchUp.evaluate({
            timestampMicros,
            readWallClockMicros: BigInt(wallClockMicros),
            appliedOffsetMicros: 0n,
            durationMicros: FRAME_MICROS,
            nowMs,
          })
        ) {
          encoder.encode(nowMs);
        }
        encoder.drain(nowMs);
        nowMs += FRAME_MICROS / 1_000;
        const stats = catchUp.snapshot();
        // 投入した分と出力が覆った分の差が、符号化のキューに残っている長さになる
        assert.isAtMost(
          stats.pendingMs,
          encoder.pendingMs + 0.001,
          "キューに残っている長さが、投入したまま出力が返っていない分を超えている",
        );
      }
    }),
  );
});
