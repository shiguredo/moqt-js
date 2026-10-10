/**
 * AudioPublishCatchUp の単体テスト
 *
 * 「配信側が足した遅れ」の観測と、遅れたときに古いフレームを捨てて live へ追いつく判定を
 * 固定する。値は実装に合わせて書くのではなく、実測 (実リレーへ同じページから配信と購読を
 * 行い、メインスレッドを 1 秒止めると、符号化の遅れが 10 ms から 910 ms へ伸び、負荷を
 * やめて 10 秒たっても戻らなかった) と同じ形の入力列を作って確かめる。
 *
 * 時刻は呼び出し側が渡すため、実時間を使わずに「健全な状態」「キューが伸びた状態」を
 * そのまま作れる。ブラウザ API は使わない。
 *
 * 入力列は、エンコーダーが読まれた順に 1 フレームずつ処理する FIFO として組み立てる。
 * 実測では、遅れが 910 ms になった後も出力の速さは実時間と同じままで、負荷をやめても
 * キューがはけなかった。そのため、キューが伸びたあとは捨てない限り戻らない。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_PUBLISH_CATCH_UP_GROWTH_MS,
  AUDIO_PUBLISH_CATCH_UP_MIN_MS,
  AudioPublishCatchUp,
} from "./audioPublishCatchUp";

/** 音声の 1 フレームの長さ (マイクロ秒)。opus のパケットと同じ 20 ms にする */
const FRAME_MICROS = 20_000;

/** フレームの間隔 (ミリ秒) */
const FRAME_INTERVAL_MS = 20;

/**
 * 健全な状態の「読み出しの遅れ」(マイクロ秒)
 *
 * `AudioTimestampClock` の補正は、読み出した壁時計と `AudioData.timestamp` の差の最小値へ
 * 合わせるため、健全なときの「読み出した壁時計 - (timestamp + 補正)」はほぼ 0 になる。
 * 実測でも 0.7 ms だった
 */
const HEALTHY_READ_DELAY_MICROS = 0;

/** 壁時計の原点 (Unix epoch マイクロ秒)。実時間と同じ桁にする */
const WALL_CLOCK_EPOCH_MICROS = 1_800_000_000_000_000;

/** TIMESTAMP に足す補正 (マイクロ秒)。読み出しの遅れの床であり、音声の時計とのずれ */
const APPLIED_OFFSET_MICROS = 1_000_000_000;

/** 1 フレームの読み出しと符号化の結果 */
interface Step {
  /** 符号化したか */
  readonly encode: boolean;
  /** 読み出した時刻 (ミリ秒) */
  readonly nowMs: number;
  /** 読み出したフレームの timestamp (マイクロ秒) */
  readonly timestampMicros: number;
}

/** 符号化したフレームと捨てたフレームに分ける */
function split(steps: readonly Step[]): { encoded: Step[]; dropped: Step[] } {
  return {
    encoded: steps.filter((step) => step.encode),
    dropped: steps.filter((step) => !step.encode),
  };
}

/** 読み出すフレーム 1 つ分の入力 */
interface FrameInput {
  /** 読み出した時刻 (ミリ秒) */
  readonly readAtMs: number;
  /** 読み出しの遅れ (ミリ秒)。撮ってから読むまでの時間 - 健全時の時間 */
  readonly readDelayMs: number;
}

/**
 * 一定の間隔で読み続ける入力列を作る
 *
 * @param startMs - 最初に読む時刻 (ミリ秒)
 * @param frames - フレーム数
 * @param readDelayMs - 読み出しの遅れ (ミリ秒)。既定は健全な状態 (0)
 */
function steadyFrames(startMs: number, frames: number, readDelayMs = 0): FrameInput[] {
  const inputs: FrameInput[] = [];
  for (let index = 0; index < frames; index++) {
    inputs.push({ readAtMs: startMs + index * FRAME_INTERVAL_MS, readDelayMs });
  }
  return inputs;
}

/**
 * メインスレッドが一定の時間止まり、その間に届いたフレームを止まった後にまとめて読む入力列
 * を作る (実測した形そのもの)
 *
 * 止まっている間は `MediaStreamTrackProcessor` のキューにフレームが溜まり、止まった後に
 * 素早く読み出される。読み出しの遅れは、止まった長さぶんだけ大きくなる。
 */
function stalledFrames(options: {
  startMs: number;
  beforeFrames: number;
  stallMs: number;
  afterFrames: number;
}): FrameInput[] {
  const inputs = steadyFrames(options.startMs, options.beforeFrames);
  const lastReadAtMs = options.startMs + (options.beforeFrames - 1) * FRAME_INTERVAL_MS;
  const stallEndMs = lastReadAtMs + FRAME_INTERVAL_MS + options.stallMs;
  const stalledCount = Math.floor(options.stallMs / FRAME_INTERVAL_MS);
  // 止まった後に、溜まった分を 1 ms ごとに読む (読み出しは符号化より速い)
  for (let index = 0; index < stalledCount; index++) {
    const capturedAtMs = lastReadAtMs + FRAME_INTERVAL_MS + index * FRAME_INTERVAL_MS;
    const readAtMs = stallEndMs + index;
    inputs.push({ readAtMs, readDelayMs: readAtMs - capturedAtMs });
  }
  // 読み出しが追いついたら、また一定の間隔で読む
  const caughtUpAtMs = stallEndMs + stalledCount;
  for (let index = 0; index < options.afterFrames; index++) {
    inputs.push({ readAtMs: caughtUpAtMs + index * FRAME_INTERVAL_MS, readDelayMs: 0 });
  }
  return inputs;
}

/** エンコーダーの速さ。実測した 2 つの状態 (健全・キューが伸びた) を作る */
interface EncoderSpeed {
  /**
   * 読み出してから出力が返るまでの遅れ (ミリ秒)。キューが空でもかかる時間であり、
   * 環境 (runner の速さ) で決まる。実測では 10 ms だった
   */
  readonly latencyMs?: number;
  /**
   * 1 フレームの符号化にかかる時間 (ミリ秒)。フレームの間隔より大きければ、キューが
   * 実時間に追いつかず伸び続ける (実測: 遅れが 910 ms になった後、負荷をやめても
   * 戻らなかった)
   */
  readonly drainMsPerFrame?: number;
}

/**
 * 入力列を流す装置
 *
 * 符号化のキューは位相 (健全・キューが伸びた・はけた) をまたいで続くため、装置として
 * 1 つ持ち、`feed()` を繰り返し呼ぶ。判定するのは本物の `AudioPublishCatchUp` であり、
 * この装置は「いつ読み出し、いつ出力が返るか」という環境の側だけを作る。
 */
class AudioFrameStream {
  // 符号化のキュー。読まれた順に並ぶ
  private readonly queue: { timestampMicros: number; outputAtMs: number }[] = [];
  private lastOutputAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly catchUp: AudioPublishCatchUp) {}

  /**
   * @param inputs - 読み出すフレームの入力列
   * @param speed - エンコーダーの速さ (省略すると実時間にちょうど追いつく速さ)
   */
  feed(inputs: readonly FrameInput[], speed: EncoderSpeed = {}): Step[] {
    const latencyMs = speed.latencyMs ?? 0;
    const drainMsPerFrame = speed.drainMsPerFrame ?? FRAME_INTERVAL_MS;
    const steps: Step[] = [];
    for (const input of inputs) {
      // 出力は次のフレームを読む前に返る (FIFO)
      while ((this.queue[0]?.outputAtMs ?? Number.POSITIVE_INFINITY) <= input.readAtMs) {
        const frame = this.queue.shift();
        if (frame === undefined) {
          break;
        }
        this.catchUp.recordEncodedChunk({
          timestampMicros: frame.timestampMicros,
          durationMicros: FRAME_MICROS,
          nowMs: frame.outputAtMs,
        });
      }

      // 読み出した壁時計 (Unix epoch マイクロ秒) は実時間どおりに進む。補正は
      // 「読み出した壁時計 - AudioData.timestamp」の床であり、実測と同じく一定にする
      const readWallClockMicros = WALL_CLOCK_EPOCH_MICROS + Math.round(input.readAtMs * 1_000);
      // フレームの timestamp は、読み出した壁時計から補正・健全時の読み出しの遅れ・
      // このフレームの読み出しの遅れを引いた値になる
      const timestampMicros =
        readWallClockMicros -
        APPLIED_OFFSET_MICROS -
        HEALTHY_READ_DELAY_MICROS -
        Math.round(input.readDelayMs * 1_000);
      const encode = this.catchUp.evaluate({
        timestampMicros,
        readWallClockMicros: BigInt(readWallClockMicros),
        appliedOffsetMicros: BigInt(APPLIED_OFFSET_MICROS),
        durationMicros: FRAME_MICROS,
        nowMs: input.readAtMs,
      });
      steps.push({ encode, nowMs: input.readAtMs, timestampMicros });
      if (encode) {
        const outputAtMs = Math.max(
          input.readAtMs + latencyMs,
          this.lastOutputAtMs + drainMsPerFrame,
        );
        this.lastOutputAtMs = outputAtMs;
        this.queue.push({ timestampMicros, outputAtMs });
      }
    }
    return steps;
  }
}

test("AudioPublishCatchUp: 読み出しも符号化も遅れていないフレームは捨てない", () => {
  // 実測した定常状態 (読み出しの遅れ 0.7 ms、符号化は実時間に追いついている) では捨てない
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  const steps = stream.feed(steadyFrames(1_000, 50));
  assert.strictEqual(split(steps).dropped.length, 0, "健全な状態でフレームを捨てた");
  const stats = catchUp.snapshot();
  assert.strictEqual(stats.droppedFrames, 0, "健全な状態で捨てた数が 0 でない");
  assert.strictEqual(stats.droppedMs, 0, "健全な状態で捨てた長さが 0 でない");
  assert.isFalse(stats.catchingUp, "健全な状態で追いつき中になっている");
  assert.strictEqual(stats.catchUpStarts, 0, "健全な状態で追いつきを始めている");
  // 最後の 1 フレームはまだ出力が返っていない (次のフレームを読む前に返る)
  assert.isAtMost(stats.pendingFrames, 1, "健全な状態でキューにフレームが溜まっている");
  assert.strictEqual(stats.lagMs, 0, "健全な状態で遅れがある");
  assert.strictEqual(stats.floorMs, 0, "健全時の遅れ (床) が違う");
});

test("AudioPublishCatchUp: 符号化のキューが伸びたら捨て始め、はけてきたらやめる", () => {
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  // 健全な状態で床を作る
  stream.feed(steadyFrames(1_000, 20));
  assert.strictEqual(catchUp.snapshot().floorMs, 0, "床が作れていない");

  // 符号化が実時間に追いつかなくなり、キューが伸びる (1 フレーム 30 ms かかる)。
  // キューに溜まった音声が上限 (60 ms) を超えると、1 フレームを符号化した後に捨て始める
  const backlog = stream.feed(steadyFrames(2_000, 60), { drainMsPerFrame: 30 });
  const backlogSplit = split(backlog);
  assert.isAbove(backlogSplit.dropped.length, 0, "キューが伸びているのに捨てていない");
  const during = catchUp.snapshot();
  assert.isAtLeast(during.catchUpStarts, 1, "追いつきを始めていない");
  assert.isAbove(during.droppedFrames, 0, "捨てた数が増えていない");
  assert.isAbove(during.droppedMs, 0, "捨てた長さが増えていない");
  // 遅れは上限 (60 ms) の近くで止まる (実測の 910 ms のように伸び続けない)。上限を超えた
  // ことは次のフレームを読むまで分からないため、上限 + 1 フレームまで伸びる
  assert.isAtMost(
    during.maxLagMs ?? Number.POSITIVE_INFINITY,
    AUDIO_PUBLISH_CATCH_UP_MIN_MS + FRAME_INTERVAL_MS,
    "遅れが上限を超えて伸び続けている",
  );

  // 符号化が実時間より速くなると、キューがはけて遅れが下がり、捨てるのをやめる
  const recovered = stream.feed(steadyFrames(10_000, 30), { drainMsPerFrame: 5 });
  assert.strictEqual(split(recovered.slice(-10)).dropped.length, 0, "はけたのに捨て続けている");
  const after = catchUp.snapshot();
  assert.isFalse(after.catchingUp, "はけたのに追いつき中になっている");
  // 最後の 1 フレームはまだ出力が返っていない (次のフレームを読む前に返る)
  assert.isAtMost(after.pendingFrames, 1, "はけたのにキューにフレームが残っている");
});

test("AudioPublishCatchUp: メインスレッドが止まって溜まったフレームをまとめて読んだときも追いつく", () => {
  // 実測した形そのもの。1 秒止まると、符号化の遅れは 910 ms へ伸びる
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  const steps = stream.feed(
    stalledFrames({
      startMs: 1_000,
      beforeFrames: 20,
      stallMs: 1_000,
      afterFrames: 40,
    }),
  );
  const stats = catchUp.snapshot();
  assert.isAbove(stats.droppedFrames, 0, "溜まったフレームを捨てていない");
  assert.isFalse(stats.catchingUp, "停止の後も追いつき中が続いている");
  // 停止の間に溜まった 50 フレームのうち、遅れが上限を超えた分だけを捨て、最後は読み出しに
  // 追いついて符号化を再開している
  const tail = steps.slice(-20);
  assert.strictEqual(split(tail).dropped.length, 0, "追いついた後も捨てている");
  assert.isBelow(stats.pendingMs, 60, "追いついた後にキューへ音声が残っている");
  // 捨てた長さは、止まった長さ (1 秒) を超えない (溜まった分だけを捨てている)
  assert.isAtMost(stats.droppedMs, 1_000, "止まった長さより多く捨てている");
});

test("AudioPublishCatchUp: 追いつきはキューが 1 パケット以下になるまで続く", () => {
  // 上限を少し下回ったところで再開すると、キューに残った分がはけないまま次のフレームが入り、
  // 捨てるかどうかが 1 フレームごとに往復する。実測では、その往復で投入が出力のたびに
  // 1 フレームだけになり、音声がほとんど送られなくなった。1 パケット以下まで捨て続ける
  const catchUp = new AudioPublishCatchUp();
  const readAt = (index: number, nowMs: number): boolean =>
    catchUp.evaluate({
      timestampMicros: WALL_CLOCK_EPOCH_MICROS + index * FRAME_MICROS,
      readWallClockMicros: BigInt(WALL_CLOCK_EPOCH_MICROS + index * FRAME_MICROS),
      appliedOffsetMicros: 0n,
      durationMicros: FRAME_MICROS,
      nowMs,
    });
  const outputAt = (index: number, nowMs: number): number | null =>
    catchUp.recordEncodedChunk({
      timestampMicros: WALL_CLOCK_EPOCH_MICROS + index * FRAME_MICROS,
      durationMicros: FRAME_MICROS,
      nowMs,
    }).timestampMicros;

  // 出力が返らないまま 4 フレーム読む。上限 (60 ms) を超えるのは次のフレームを読んだ
  // ときであり、そこまで符号化する
  assert.isTrue(readAt(0, 1_000), "1 つ目のフレームを捨てた");
  assert.isTrue(readAt(1, 1_020), "2 つ目のフレームを捨てた");
  assert.isTrue(readAt(2, 1_040), "3 つ目のフレームを捨てた");
  assert.isTrue(readAt(3, 1_060), "4 つ目のフレームを捨てた");
  assert.isFalse(readAt(4, 1_080), "上限を超えたのに捨てていない");
  assert.isTrue(catchUp.snapshot().catchingUp, "追いつき中になっていない");
  assert.strictEqual(catchUp.snapshot().catchUpStarts, 1, "追いつきを始めた回数が 1 回でない");

  // キューが 1 パケット (20 ms) より多く残っている間は捨て続ける
  outputAt(0, 1_081);
  assert.isFalse(readAt(5, 1_100), "キューが残っているのに捨てるのをやめている");
  outputAt(1, 1_101);
  assert.strictEqual(catchUp.snapshot().pendingMs, 40, "キューの長さが違う");
  assert.isFalse(readAt(6, 1_120), "1 パケットより多く残っているのに捨てるのをやめている");
  assert.isTrue(catchUp.snapshot().catchingUp, "キューが残っているのに追いつき中が解けている");

  // 1 パケット以下まで減ると投入を再開し、その後は捨てない
  outputAt(2, 1_121);
  outputAt(3, 1_122);
  assert.strictEqual(catchUp.snapshot().pendingMs, 0, "キューの長さが違う");
  assert.isTrue(readAt(7, 1_140), "1 パケット以下まで減ったのに捨てている");
  assert.isFalse(catchUp.snapshot().catchingUp, "減ったのに追いつき中になっている");
  assert.isTrue(readAt(8, 1_160), "再開した後に捨てている");
  outputAt(7, 1_180);
  assert.isTrue(readAt(9, 1_180), "再開した後に捨てている");
  assert.strictEqual(catchUp.snapshot().catchUpStarts, 1, "追いつきを始め直している");
});

test("AudioPublishCatchUp: 読み出しの遅れでも捨てる", () => {
  // 符号化のキューは空でも、読み出しが 1 秒遅れていると、その分は受信側の基準の遅れに
  // なる (実測: メインスレッドを止めると、読み出しは 1 秒分まとめて読まれる)
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  stream.feed(steadyFrames(1_000, 20));
  const delayed = stream.feed(steadyFrames(2_000, 30, 1_000));
  assert.strictEqual(split(delayed).dropped.length, 30, "読み出しの遅れが上回ったのに捨てていない");
  const stats = catchUp.snapshot();
  assert.strictEqual(stats.droppedFrames, 30, "捨てた数が違う");
  assert.strictEqual(stats.readLagMs, 1_000, "読み出しの遅れの観測が違う");
  // 遅れは「読み出しの遅れ + キューに溜まっている音声」になる
  assert.isAtLeast(stats.lagMs ?? 0, 1_000, "遅れの観測が読み出しの遅れより小さい");
  // 読み出しだけが遅れている場合、キューは空のままなので追いつきの状態は持ち越さない
  assert.strictEqual(stats.pendingMs, 0, "キューに音声が溜まっている");
  // 読み出しが追いついたら捨てるのをやめる
  const caughtUp = stream.feed(steadyFrames(4_000, 10));
  assert.strictEqual(split(caughtUp).dropped.length, 0, "読み出しが追いついたのに捨てている");
});

test("AudioPublishCatchUp: 補正がまだ決まっていない間は読み出しの遅れを判定しない", () => {
  // TIMESTAMP の補正 (AudioTimestampClock) が決まるまでは、読み出しの遅れを測れない。
  // キューが空なら遅れは 0 とみなすため、捨てない
  const catchUp = new AudioPublishCatchUp();
  const baseWallClockMicros = WALL_CLOCK_EPOCH_MICROS;
  const evaluate = (index: number, appliedOffsetMicros: bigint | null): boolean =>
    catchUp.evaluate({
      timestampMicros: baseWallClockMicros + index * FRAME_MICROS,
      readWallClockMicros: BigInt(baseWallClockMicros + index * FRAME_MICROS + 5_000_000),
      appliedOffsetMicros,
      durationMicros: FRAME_MICROS,
      nowMs: 1_000 + index * FRAME_INTERVAL_MS,
    });
  // 補正が未確定のうちは、5 秒遅れて読んでいても捨てない
  assert.isTrue(evaluate(0, null), "補正が決まる前に捨てている");
  assert.strictEqual(catchUp.snapshot().readLagMs, 0, "補正が決まる前に読み出しの遅れを測った");
  assert.strictEqual(catchUp.snapshot().droppedFrames, 0, "補正が決まる前に捨てた");
  // 補正が決まった後は、同じ読み出しの遅れで捨てる
  assert.isFalse(evaluate(1, 0n), "補正が決まった後に読み出しの遅れを捨てていない");
  assert.strictEqual(catchUp.snapshot().readLagMs, 5_000, "読み出しの遅れの観測が違う");
});

test("AudioPublishCatchUp: 方針が keep のときは捨てずに観測だけ続ける", () => {
  // 音楽や効果音のように、間引くと内容が壊れる用途では捨てない
  const catchUp = new AudioPublishCatchUp({ policy: "keep" });
  const stream = new AudioFrameStream(catchUp);
  const steps = stream.feed(steadyFrames(1_000, 20, 2_000), { drainMsPerFrame: 1 });
  assert.strictEqual(split(steps).dropped.length, 0, "方針が keep なのに捨てている");
  const stats = catchUp.snapshot();
  assert.strictEqual(stats.policy, "keep", "方針が違う");
  assert.strictEqual(stats.droppedFrames, 0, "方針が keep なのに捨てた数が 0 でない");
  assert.isFalse(stats.catchingUp, "方針が keep なのに追いつき中になっている");
  // 遅れそのものは観測して統計に出す
  assert.strictEqual(stats.readLagMs, 2_000, "方針が keep のときに読み出しの遅れを観測していない");
  assert.strictEqual(stats.lagMs, 2_000, "方針が keep のときに遅れを観測していない");
  assert.strictEqual(stats.maxLagMs, 2_000, "方針が keep のときに最大の遅れを観測していない");
});

test("AudioPublishCatchUp: 健全時の遅れが大きい環境では、その遅れを上限まで使う", () => {
  // 符号化の出力が返るまで 50 ms かかる環境 (遅い runner) でも、実時間には追いついていれば
  // 健全な状態であり、捨てない。上限は絶対値の下限 (60 ms) と床 + 40 ms の大きい方になる
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  // 出力が返るまで 50 ms かかる (遅い runner) が、実時間には追いついている状態
  const healthy = stream.feed(steadyFrames(1_000, 20), { latencyMs: 50 });
  assert.strictEqual(split(healthy).encoded.length, 20, "遅い環境の健全な状態で捨てている");
  assert.isAtLeast(catchUp.snapshot().lagMs ?? 0, 40, "遅い環境の遅れを観測していない");
  // この環境でキューが伸びると、床 + 40 ms を超えた時点で捨て始める
  const backlog = stream.feed(steadyFrames(3_000, 20), { drainMsPerFrame: 60 });
  assert.isAbove(split(backlog).dropped.length, 0, "キューが伸びたのに捨てていない");
  assert.isAtLeast(catchUp.snapshot().catchUpStarts, 1, "追いつきを始めていない");
  assert.isAbove(
    AUDIO_PUBLISH_CATCH_UP_MIN_MS,
    AUDIO_PUBLISH_CATCH_UP_GROWTH_MS,
    "絶対値の下限が床からの増加以下になっている",
  );
  assert.isAbove(
    AUDIO_PUBLISH_CATCH_UP_GROWTH_MS,
    0,
    "健全時の遅れからの増加が 0 以下になっている",
  );
});

test("AudioPublishCatchUp: 出力の timestamp が投入より古くても、投入した timestamp を返す", () => {
  // devtools の音声は 10 ms の `AudioData` を読み、opus の packet は 20 ms になる。出力 1 つで
  // 投入 2 つが消費される。符号化の出力の timestamp は「符号化したサンプル数」から作る連続した
  // 値であり、フレームを捨てると投入より古くなる
  const catchUp = new AudioPublishCatchUp();
  const baseWallClockMicros = WALL_CLOCK_EPOCH_MICROS;
  const first = catchUp.evaluate({
    timestampMicros: baseWallClockMicros,
    readWallClockMicros: BigInt(baseWallClockMicros),
    appliedOffsetMicros: 0n,
    durationMicros: 10_000,
    nowMs: 1_000,
  });
  assert.isTrue(first, "1 つ目のフレームを捨てた");
  const second = catchUp.evaluate({
    timestampMicros: baseWallClockMicros + 10_000,
    readWallClockMicros: BigInt(baseWallClockMicros + 10_000),
    appliedOffsetMicros: 0n,
    durationMicros: 10_000,
    nowMs: 1_010,
  });
  assert.isTrue(second, "2 つ目のフレームを捨てた");
  assert.strictEqual(catchUp.snapshot().pendingFrames, 2, "投入したフレームが記録されていない");
  assert.strictEqual(catchUp.snapshot().pendingMs, 20, "キューの長さが違う");

  // 出力は投入の順に返る。timestamp は投入より古い (連続した値) が、覆う最初の投入の
  // timestamp を返す
  const result = catchUp.recordEncodedChunk({
    timestampMicros: baseWallClockMicros - 500_000,
    durationMicros: 20_000,
    nowMs: 1_030,
  });
  assert.strictEqual(
    result.timestampMicros,
    baseWallClockMicros,
    "覆う最初の投入の timestamp を返していない",
  );
  assert.strictEqual(catchUp.snapshot().pendingFrames, 0, "出力が覆う投入の記録が残っている");
  assert.strictEqual(catchUp.snapshot().pendingMs, 0, "出力が覆う投入の長さが残っている");
});

test("AudioPublishCatchUp: 投入が 2 つの出力にまたがっても、順番で対応づける", () => {
  // 符号化の出力の長さが投入の長さの倍数でない場合でも、順番で消費する
  const catchUp = new AudioPublishCatchUp();
  const baseWallClockMicros = WALL_CLOCK_EPOCH_MICROS;
  const evaluate = (index: number, durationMicros: number): boolean =>
    catchUp.evaluate({
      timestampMicros: baseWallClockMicros + index * durationMicros,
      readWallClockMicros: BigInt(baseWallClockMicros + index * durationMicros),
      appliedOffsetMicros: 0n,
      durationMicros,
      nowMs: 1_000 + index,
    });
  assert.isTrue(evaluate(0, 30_000), "1 つ目のフレームを捨てた");
  // 20 ms の出力は 30 ms の投入を覆いきれない。残りは次に持ち越す
  const first = catchUp.recordEncodedChunk({
    timestampMicros: baseWallClockMicros,
    durationMicros: 20_000,
    nowMs: 1_010,
  });
  assert.strictEqual(first.timestampMicros, baseWallClockMicros, "覆う最初の投入が違う");
  assert.strictEqual(catchUp.snapshot().pendingMs, 10, "覆いきれない分が残っていない");
  // 次の出力は、残り 10 ms と次の投入 30 ms を覆う
  assert.isTrue(evaluate(1, 30_000), "2 つ目のフレームを捨てた");
  const second = catchUp.recordEncodedChunk({
    timestampMicros: baseWallClockMicros + 30_000,
    durationMicros: 40_000,
    nowMs: 1_020,
  });
  assert.strictEqual(second.timestampMicros, baseWallClockMicros, "持ち越した投入の順番が違う");
  assert.strictEqual(catchUp.snapshot().pendingMs, 0, "キューの長さが違う");
});

test("AudioPublishCatchUp: 出力が返らないままの記録は、一定の時間で捨てる", () => {
  // エンコーダーのエラーなどで出力が返らなかったフレームの記録が残り続けると、記録と
  // キューの長さが増え続ける。一定の時間より古い記録は捨てる
  const catchUp = new AudioPublishCatchUp({ pendingTimeoutMs: 1_000 });
  const evaluate = (nowMs: number, index: number): boolean =>
    catchUp.evaluate({
      timestampMicros: WALL_CLOCK_EPOCH_MICROS + index * FRAME_MICROS,
      readWallClockMicros: BigInt(WALL_CLOCK_EPOCH_MICROS + index * FRAME_MICROS),
      appliedOffsetMicros: 0n,
      durationMicros: FRAME_MICROS,
      nowMs,
    });
  assert.isTrue(evaluate(10_000, 0), "1 つ目のフレームを捨てた");
  assert.isTrue(evaluate(10_020, 1), "2 つ目のフレームを捨てた");
  assert.strictEqual(catchUp.snapshot().pendingFrames, 2, "投入したフレームが記録されていない");
  // 1 秒より古い記録は捨てられる
  assert.isTrue(evaluate(11_100, 2), "3 つ目のフレームを捨てた");
  assert.strictEqual(catchUp.snapshot().pendingFrames, 1, "古い記録が残っている");
  assert.strictEqual(catchUp.snapshot().pendingMs, 20, "古い記録の長さが残っている");
});

test("AudioPublishCatchUp: フレームの長さが分からなくても、直前の長さで捨てた量を数える", () => {
  // `AudioData.duration` は null になりうる。長さが分からないときは直前のフレームと同じ
  // 長さとみなす (捨てた長さの集計が 0 のままにならないようにする)
  const catchUp = new AudioPublishCatchUp({ minMs: 0, growthMs: 0 });
  const readWallClockMicros = WALL_CLOCK_EPOCH_MICROS;
  assert.isTrue(
    catchUp.evaluate({
      timestampMicros: readWallClockMicros,
      readWallClockMicros: BigInt(readWallClockMicros),
      appliedOffsetMicros: 0n,
      durationMicros: FRAME_MICROS,
      nowMs: 0,
    }),
    "1 つ目のフレームを捨てた",
  );
  // 出力が返らないまま次のフレームを読むと、キューに溜まっている音声があるため捨てる
  const dropped = catchUp.evaluate({
    timestampMicros: readWallClockMicros + FRAME_MICROS,
    readWallClockMicros: BigInt(readWallClockMicros + FRAME_MICROS),
    appliedOffsetMicros: 0n,
    durationMicros: null,
    nowMs: 1,
  });
  assert.isFalse(dropped, "遅れているのに捨てていない");
  assert.strictEqual(catchUp.snapshot().droppedMs, 20, "長さが分からないフレームの長さが違う");
});

test("AudioPublishCatchUp: reset で観測と統計を消す", () => {
  // 配信のやり直しで前の配信の観測を持ち越さない
  const catchUp = new AudioPublishCatchUp();
  const stream = new AudioFrameStream(catchUp);
  stream.feed(steadyFrames(1_000, 20), { drainMsPerFrame: 60 });
  assert.isAbove(catchUp.snapshot().droppedFrames, 0, "捨てた数が増えていない");
  catchUp.reset();
  const stats = catchUp.snapshot();
  assert.strictEqual(stats.droppedFrames, 0, "捨てた数が消えていない");
  assert.strictEqual(stats.droppedMs, 0, "捨てた長さが消えていない");
  assert.strictEqual(stats.lagMs, null, "遅れの観測が消えていない");
  assert.strictEqual(stats.floorMs, null, "床が消えていない");
  assert.strictEqual(stats.maxLagMs, null, "最大の遅れが消えていない");
  assert.strictEqual(stats.pendingFrames, 0, "投入の記録が消えていない");
  assert.strictEqual(stats.pendingMs, 0, "キューの長さが消えていない");
  assert.strictEqual(stats.readLagMs, 0, "読み出しの遅れが消えていない");
  assert.isFalse(stats.catchingUp, "追いつき中の状態が消えていない");
  assert.strictEqual(stats.catchUpStarts, 0, "追いつきを始めた回数が消えていない");
});
