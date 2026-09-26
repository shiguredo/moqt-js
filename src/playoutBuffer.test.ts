import { test, assert } from "vite-plus/test";
import {
  CATCH_UP_CHECK_INTERVAL_MS,
  JITTER_BUFFER_MAX_QUEUED_FRAMES,
  MAX_PRESENTATION_LAG_MS,
  MAX_PLAYOUT_DELAY_MS,
  PLAYOUT_DELAY_DECAY_MS_PER_SECOND,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlayoutBuffer,
  type PlayoutSelection,
} from "./playoutBuffer";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 のフレームの TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 受信側でメディア時刻 0 のフレームが揺らぎ無しで表示できるようになる時刻 (performance.now())
const LOCAL_ORIGIN_MS = 1_000;
// 30 fps のフレーム間隔 (ミリ秒)
const FRAME_MS = 1_000 / 30;
// TIMESTAMP (約 1.79e15 マイクロ秒) をミリ秒にしたときの浮動小数点の誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/**
 * メディア時刻 mediaMs のフレームを、揺らぎ jitterMs だけ遅れて表示できるようになった
 * ものとして積む。返り値はあふれて捨てたフレーム
 */
function enqueueAt(
  buffer: PlayoutBuffer<number>,
  index: number,
  jitterMs: number,
  frameMs = FRAME_MS,
): number[] {
  const mediaMs = index * frameMs;
  return buffer.enqueue(index, LOCAL_ORIGIN_MS + mediaMs + jitterMs, timestampOf(mediaMs));
}

// ============================================================================
// 表示時刻と選択
// ============================================================================

/**
 * 開始の後の追いつき中 (`CATCH_UP_CHECK_INTERVAL_MS` の間) を揺らぎ 0 のフレームで終え、
 * 積んだフレームを取り除く。以降のフレームの揺らぎは再生遅延の目標に使われる。
 * 返り値は次に積むフレームの番号
 */
function passCatchUp(buffer: PlayoutBuffer<number>): number {
  const frames = Math.ceil(CATCH_UP_CHECK_INTERVAL_MS / FRAME_MS) + 1;
  for (let index = 0; index < frames; index++) {
    enqueueAt(buffer, index, 0);
  }
  buffer.clear();
  return frames;
}

/**
 * 選択の結果から、描くフレームと捨てるフレームだけを取り出す (表示時刻は別のテストで確かめる)
 */
function drawAndLate<T>(selection: PlayoutSelection<T>): { draw: T | null; late: T[] } {
  return { draw: selection.draw, late: selection.late };
}

// 表示時刻 = TIMESTAMP + 基準の遅れ (揺らぎ無しで届いたフレームの遅れ) + 再生遅延。
// 表示時刻より前には描かず、過ぎた後の最初の選択で描く
test("select: 表示時刻より前は描かず、過ぎたら描く", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  // 揺らぎ 0 のフレームの後に 40 ms 遅れたフレームが届き、再生遅延が 40 ms になる
  const start = passCatchUp(buffer);
  enqueueAt(buffer, start, 40);
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 40, TOLERANCE_MS);
  buffer.clear();

  // 揺らぎ 0 で届いた 2 枚後のフレームは、届いてから 40 ms 待って描く
  const index = start + 2;
  enqueueAt(buffer, index, 0);
  const presentationMs = LOCAL_ORIGIN_MS + index * FRAME_MS + 40;
  assert.closeTo(
    buffer.presentationTimeMs(timestampOf(index * FRAME_MS)) ?? 0,
    presentationMs,
    TOLERANCE_MS,
  );
  assert.deepEqual(drawAndLate(buffer.select(presentationMs - 0.1)), { draw: null, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(presentationMs + TOLERANCE_MS)), {
    draw: index,
    late: [],
  });
  assert.equal(buffer.size, 0);
});

// 描くフレームの表示時刻を返す。止まりの原因を決めるとき、フレームが表示時刻に間に合ったか
// (受け取り、復号) と、表示時刻そのものが遅れたか (再生遅延の増加) を見るために使う
test("select: 描くフレームの表示時刻を返す", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const start = passCatchUp(buffer);
  enqueueAt(buffer, start, 0);
  enqueueAt(buffer, start + 1, 40);
  const presentationMs = buffer.presentationTimeMs(timestampOf((start + 1) * FRAME_MS)) ?? 0;

  // 表示時刻の前は描かず、表示時刻も返さない
  assert.deepEqual(buffer.select(LOCAL_ORIGIN_MS + start * FRAME_MS), {
    draw: null,
    late: [],
    drawPresentationMs: null,
  });
  // 1 枚目の表示時刻に、1 枚目とその表示時刻を返す
  const first = buffer.select(presentationMs - FRAME_MS + TOLERANCE_MS);
  assert.equal(first.draw, start, "1 枚目を描くこと");
  assert.closeTo(
    first.drawPresentationMs ?? 0,
    presentationMs - FRAME_MS,
    TOLERANCE_MS,
    "1 枚目の表示時刻を返すこと",
  );
  // 2 枚目の表示時刻に、2 枚目とその表示時刻を返す
  const second = buffer.select(presentationMs + TOLERANCE_MS);
  assert.equal(second.draw, start + 1, "2 枚目を描くこと");
  assert.closeTo(
    second.drawPresentationMs ?? 0,
    presentationMs,
    TOLERANCE_MS,
    "2 枚目の表示時刻を返すこと",
  );
});

// 壁時計の TIMESTAMP を持たないフレームは表示時刻を決めずに届いた順に描くため、表示時刻は無い
test("select: TIMESTAMP の無いフレームの表示時刻は null にする", () => {
  const buffer = new PlayoutBuffer<string>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  buffer.enqueue("a", 0, null);

  assert.deepEqual(buffer.select(0), { draw: "a", late: [], drawPresentationMs: null });
});

// 表示時刻を過ぎたフレームが複数あるときは、表示時刻からの遅れが MAX_PRESENTATION_LAG_MS
// 以内のフレームを古い順に 1 枚ずつ描き、それより遅れたフレームは間に合わなかったフレーム
// として返す (捨てる)。最新の 1 枚は遅れていても描く。並べ替えはしない。
// 表示時刻を過ぎたフレームを最新の 1 枚だけにすると、配信 fps と表示周期が近いとき、
// 表示時刻と選択の位相の揺れや、取得の間隔の揺れで 2 枚以上が重なった周期のたびに捨てて、
// 次の周期は何も描けずに表示が飛ぶ
test("select: 表示時刻からの遅れが上限以内のフレームは古い順に描き、それより遅れたものを捨てる", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const frameMs = 1_000 / 120;
  for (let index = 0; index < 6; index++) {
    enqueueAt(buffer, index, 0, frameMs);
  }
  // フレーム 0 から 4 は表示時刻を過ぎ、フレーム 5 はまだ (再生遅延はほぼ 0)。
  // フレーム 0 と 1 は表示時刻から上限を超えて遅れている
  const nowMs = LOCAL_ORIGIN_MS + 4 * frameMs + 1;
  assert.isAbove(nowMs - (LOCAL_ORIGIN_MS + frameMs), MAX_PRESENTATION_LAG_MS);
  assert.isBelow(nowMs - (LOCAL_ORIGIN_MS + 2 * frameMs), MAX_PRESENTATION_LAG_MS);
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 2, late: [0, 1] });
  // 残したフレームは次の選択から古い順に描く
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 3, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 4, late: [] });
  assert.equal(buffer.size, 1);
});

// 30 fps では 2 枚が表示時刻を過ぎると古い方は上限を超えて遅れているため、最新を描いて
// 古い方を捨てる
test("select: 上限を超えて遅れたフレームを捨てて最新を描く", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  for (let index = 0; index < 4; index++) {
    enqueueAt(buffer, index, 0);
  }
  const nowMs = LOCAL_ORIGIN_MS + 2 * FRAME_MS + 1;
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 2, late: [0, 1] });
  assert.equal(buffer.size, 1);
});

// 配信 fps と表示周期が同じ (120 fps を 120 Hz で表示) で、表示時刻と選択の位相が
// ±0.3 ms 揺れる。ある周期に 2 枚が表示時刻を過ぎ、次の周期には 1 枚も過ぎないことが
// 繰り返されても、フレームを捨てずに全周期で 1 枚ずつ描く
test("select: 配信 fps と表示周期が同じで位相が揺れてもフレームを捨てない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const frameMs = 1_000 / 120;
  const frames = 120 * 3;
  const draws: number[] = [];
  const late: number[] = [];
  let enqueued = 0;
  for (let tick = 0; tick < frames; tick++) {
    // 選択の時刻は表示時刻 (揺らぎ 0.6 ms の再生遅延の後) の前後 0.3 ms に揺れる
    const tickMs = LOCAL_ORIGIN_MS + tick * frameMs + 0.6 + (tick % 2 === 0 ? 0.3 : -0.3);
    while (enqueued < frames && LOCAL_ORIGIN_MS + enqueued * frameMs + 0.6 <= tickMs) {
      // 2 枚に 1 枚が 0.6 ms 遅れて届く
      enqueueAt(buffer, enqueued, enqueued % 2 === 1 ? 0.6 : 0, frameMs);
      enqueued++;
    }
    const selection = buffer.select(tickMs);
    late.push(...selection.late);
    if (selection.draw !== null) {
      draws.push(selection.draw);
    }
  }
  // 揺らぎを覚えるまでの最初の 1 秒を除き、フレームを捨てず、描いたフレームは連番である
  const steady = draws.filter((index) => index >= 120);
  assert.deepEqual(
    late.filter((index) => index >= 120),
    [],
  );
  for (let position = 1; position < steady.length; position++) {
    assert.equal((steady[position] ?? 0) - (steady[position - 1] ?? 0), 1);
  }
  assert.isAbove(steady.length, 120 * 2 - 3);
});

// TIMESTAMP を壁時計として使えないフレーム (Timescale あり / TIMESTAMP 無し) は、
// 従来どおり届いた順に 1 回の選択で 1 枚ずつ描く
test("select: TIMESTAMP の無いフレームは届いた順に 1 枚ずつ描く", () => {
  const buffer = new PlayoutBuffer<string>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  buffer.enqueue("a", 0, null);
  buffer.enqueue("b", 0, null);
  buffer.enqueue("c", 0, null);
  assert.deepEqual(drawAndLate(buffer.select(0)), { draw: "a", late: [] });
  assert.deepEqual(drawAndLate(buffer.select(0)), { draw: "b", late: [] });
  assert.deepEqual(drawAndLate(buffer.select(0)), { draw: "c", late: [] });
  assert.deepEqual(drawAndLate(buffer.select(0)), { draw: null, late: [] });
  assert.isNull(buffer.playoutDelayMs());
});

// キューの上限を超えたら古い方から捨てる
test("enqueue: キューの上限を超えたら古い方から返す", () => {
  const buffer = new PlayoutBuffer<string>(2);
  assert.deepEqual(buffer.enqueue("a", 0, null), []);
  assert.deepEqual(buffer.enqueue("b", 0, null), []);
  assert.deepEqual(buffer.enqueue("c", 0, null), ["a"]);
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.clear(), ["b", "c"]);
  assert.equal(buffer.size, 0);
});

// ============================================================================
// 再生遅延
// ============================================================================

// 揺らぎが増えたら直ちに追従し、減ったときは毎秒 PLAYOUT_DELAY_DECAY_MS_PER_SECOND で
// ゆっくり戻す (急に戻すと表示時刻が前へ飛び、フレームを捨てることになる)
test("playoutDelayMs: 揺らぎが増えたら直ちに上げ、減ったらゆっくり下げる", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  let index = 0;
  // 揺らぎ 0 のフレームを 1 秒分積む
  for (; index < 30; index++) {
    enqueueAt(buffer, index, 0);
    buffer.clear();
  }
  assert.closeTo(buffer.playoutDelayMs() ?? -1, 0, TOLERANCE_MS);
  // 100 ms 遅れたフレームが 2 枚 (32 枚中の p95 に入る) 届くと直ちに 100 ms にする
  enqueueAt(buffer, index++, 100);
  enqueueAt(buffer, index++, 100);
  buffer.clear();
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 100, TOLERANCE_MS);

  // 揺らぎ 0 のフレームが続き、p95 が 0 に戻った後は毎秒 20 ms ずつ下げる
  const delays: { atMs: number; delayMs: number }[] = [];
  for (; index < 32 + 30 * 3; index++) {
    enqueueAt(buffer, index, 0);
    buffer.clear();
    delays.push({
      atMs: LOCAL_ORIGIN_MS + index * FRAME_MS,
      delayMs: buffer.playoutDelayMs() ?? 0,
    });
  }
  const last = delays[delays.length - 1];
  assert.isDefined(last);
  // 3 秒で 100 ms から 0 まで一気には下げない (下げる速さは毎秒 20 ms まで)
  assert.isAbove(last?.delayMs ?? 0, 100 - PLAYOUT_DELAY_DECAY_MS_PER_SECOND * 3 - 1);
  assert.isBelow(last?.delayMs ?? 0, 100);
});

/**
 * 100 枚に 2 枚が 30 ms 遅れて届く到着列を frameMs の間隔で積み、最後の再生遅延を返す
 */
function delayForTwoPercentLate(frameMs: number): number | null {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  let available = 0;
  for (let index = 0; index < 1_000; index++) {
    const late = index % 100 === 17 || index % 100 === 67;
    // 復号は順に行うため、到着は前のフレームより早くならない
    available = Math.max(available, LOCAL_ORIGIN_MS + index * frameMs + (late ? 30 : 0));
    buffer.enqueue(index, available, timestampOf(index * frameMs));
    buffer.clear();
  }
  return buffer.playoutDelayMs();
}

// 見る側が感じるのは 1 秒あたりの止まりの数である。表示時刻の後に届くフレームを 1 秒に
// 1 枚までにするため、再生遅延の目標にする揺らぎの百分位を配信 fps から決める
// (30 fps で約 96.7%、120 fps で約 99.2%、下限は 95%)。
// 2% のフレームが 30 ms 遅れる経路では、30 fps (1 秒に 0.6 枚) は遅れを許して再生遅延を
// 上げず、120 fps (1 秒に 2.4 枚) は遅れを吸収するよう再生遅延を 30 ms にする
test("playoutDelayMs: 表示時刻の後に届くフレームが 1 秒に 1 枚までになるよう配信 fps から百分位を決める", () => {
  assert.closeTo(delayForTwoPercentLate(1_000 / 30) ?? -1, 0, TOLERANCE_MS);
  assert.closeTo(delayForTwoPercentLate(1_000 / 120) ?? -1, 30, TOLERANCE_MS);
});

// 上限 (500 ms) を超える揺らぎは再生遅延では吸収できないため、再生遅延の目標に使わない。
// 使うと再生遅延が上限に張り付き、常に大きく遅れて表示することになる
test("playoutDelayMs: 上限を超える揺らぎは再生遅延に使わない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  let available = 0;
  for (let index = 0; index < 60; index++) {
    // 2 枚に 1 枚が 900 ms 遅れる (復号は順に行うため、到着は前のフレームより早くならない)
    available = Math.max(
      available,
      LOCAL_ORIGIN_MS + index * FRAME_MS + (index % 2 === 1 ? 900 : 0),
    );
    buffer.enqueue(index, available, timestampOf(index * FRAME_MS));
    buffer.clear();
  }
  assert.isAtMost(buffer.playoutDelayMs() ?? Infinity, MAX_PLAYOUT_DELAY_MS);
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 900);
});

// 購読の開始では relay の cache から Group の先頭以降のフレームがまとめて届く
// (cache replay)。これは経路の揺らぎではないため、再生遅延の目標に使わない。
// 古いフレームは表示時刻から大きく遅れているため捨て、すぐに追いつく
test("enqueue: 購読の開始にまとめて届いた古いフレームを再生遅延に使わない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  // Group の先頭から 20 枚 (約 0.67 秒前から現在まで) が、同じ時刻にまとめて届く
  const burstAtMs = LOCAL_ORIGIN_MS + 20 * FRAME_MS;
  for (let index = 0; index < 20; index++) {
    buffer.enqueue(index, burstAtMs + index * 0.1, timestampOf(index * FRAME_MS));
  }
  // 表示時刻から上限を超えて遅れたフレーム (フレーム 18 まで) を捨てて最新を描く
  const selection = buffer.select(burstAtMs + 3);
  assert.equal(selection.draw, 19);
  assert.equal(selection.late.length, 19);
  // 以降は揺らぎ無しで届く
  for (let index = 20; index < 80; index++) {
    enqueueAt(buffer, index, 0);
    buffer.clear();
  }
  assert.closeTo(buffer.playoutDelayMs() ?? -1, 0, TOLERANCE_MS);
});

/**
 * 購読を始めたときの、復号の出力の時刻と TIMESTAMP の列 (実測)
 *
 * 2026-09-25 に配備 relay (prewarm 有効) で dummy の映像 (30 fps、2 秒の Group) を購読した
 * ときの最初の 90 枚。[最初のフレームからの受信側の経過 (ms), 最初のフレームからのメディア
 * 時刻 (ms)] の組である。relay は cache から Group の先頭以降を送り、最初のフレームは
 * TIMESTAMP から `JOIN_FIRST_OFFSET_MS` 遅れて届いた。以降は実時間の約 2 倍の速さで届き
 * (届く間隔の多くはフレーム間隔の半分以上ある)、55 枚目 (約 0.89 秒後) で live に追いついた
 * (遅れ約 57 ms)。その後は live で、経路の揺らぎは約 20 ms 以内である
 */
const JOIN_CATCH_UP_ARRIVALS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.8, 16.9],
  [1.5, 47.4],
  [2.1, 80.3],
  [5.1, 112.9],
  [5.1, 147.8],
  [5.1, 187.8],
  [30, 217.2],
  [46.4, 255.3],
  [65.8, 286.3],
  [84, 318.4],
  [102, 347.3],
  [113.9, 383],
  [121.8, 412.9],
  [154.9, 448.5],
  [156.5, 489.4],
  [202, 512.6],
  [203.6, 546.2],
  [233.9, 580.3],
  [240.4, 621.4],
  [276.6, 654.2],
  [279.5, 687.2],
  [304.7, 721.1],
  [323, 748.1],
  [324.6, 788.6],
  [353.6, 819.6],
  [370.7, 854.6],
  [388.7, 886.2],
  [404.9, 918.6],
  [440.2, 954.3],
  [442, 979.1],
  [479.7, 1022.4],
  [484.5, 1054.4],
  [522.4, 1079.5],
  [528.9, 1112.3],
  [561, 1156],
  [563.4, 1185.7],
  [595.8, 1219.6],
  [599.6, 1253.3],
  [640.1, 1287.3],
  [641.9, 1321.4],
  [681.7, 1346.2],
  [683.5, 1387.8],
  [718.9, 1412.8],
  [722.9, 1450.5],
  [734.9, 1487.9],
  [754.7, 1519.5],
  [772.7, 1554.8],
  [790.6, 1581.8],
  [796.4, 1621.5],
  [814.3, 1653],
  [836.6, 1679.5],
  [842.6, 1721.8],
  [856.6, 1746],
  [888.9, 1788.4],
  [918.9, 1812.8],
  [960.1, 1853.5],
  [982.7, 1887.5],
  [1015, 1919.7],
  [1039.9, 1946],
  [1074.2, 1984.7],
  [1121.5, 2012.8],
  [1154.6, 2046.1],
  [1192.6, 2087.8],
  [1222.8, 2119.4],
  [1248.5, 2154.4],
  [1276.3, 2179.6],
  [1309.6, 2219],
  [1340.1, 2246.4],
  [1374.6, 2279.6],
  [1404.8, 2313],
  [1445.3, 2355.2],
  [1473.3, 2379.6],
  [1518.6, 2420.9],
  [1546.5, 2452.8],
  [1582.6, 2487.8],
  [1608.8, 2512.8],
  [1634.7, 2546.1],
  [1675.2, 2582.4],
  [1726.7, 2621.5],
  [1740, 2646.3],
  [1776.5, 2679.6],
  [1818.7, 2718.1],
  [1845.2, 2753.1],
  [1886.9, 2788.1],
  [1905.1, 2814.8],
  [1953.6, 2855.2],
  [1970.2, 2879.7],
  [2018.9, 2920.2],
  [2045.1, 2946.2],
];

/** 実測の列の最初のフレームの、TIMESTAMP から表示できるようになるまでの遅れ (ms) */
const JOIN_FIRST_OFFSET_MS = 957.1;

/** 実測の列を積む。返り値は最後のフレームの受信側の時刻と番号 */
function enqueueJoinCatchUp(buffer: PlayoutBuffer<number>): { atMs: number; index: number } {
  let last = { atMs: LOCAL_ORIGIN_MS, index: -1 };
  JOIN_CATCH_UP_ARRIVALS.forEach(([arrivalMs, mediaMs], index) => {
    const atMs = LOCAL_ORIGIN_MS + JOIN_FIRST_OFFSET_MS + arrivalMs;
    buffer.enqueue(index, atMs, timestampOf(mediaMs));
    buffer.clear();
    last = { atMs, index };
  });
  return last;
}

// 購読の開始では、relay の cache から古いフレームが実時間より速く届いて live に追いつく。
// 追いつく途中のフレームの遅れは経路の揺らぎではない。まとまって届いたとみなせない間隔
// (フレーム間隔の半分以上) で届くものも、再生遅延の目標に使わない。使うと再生遅延が
// 数百ミリ秒になり、窓 (10 秒) から抜けた後も毎秒 20 ms でしか下がらない
test("playoutDelayMs: 購読の開始に cache から追いつく途中のフレームの遅れを再生遅延に使わない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  enqueueJoinCatchUp(buffer);
  // live の揺らぎ (約 20 ms) 程度に収まる。追いつく途中の遅れを学習すると 400 ms を超える
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 50);
});

// 別の publisher への切り替えなどで TIMESTAMP が飛ぶと基準を取り直す。取り直した後も、
// cache から追いつく途中のフレームの遅れは再生遅延に使わない
test("playoutDelayMs: 基準を取り直した後も cache から追いつく途中のフレームの遅れを使わない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  // 1 時間前の TIMESTAMP で 2 秒分、揺らぎ 0 のフレームを積む
  const hourMs = 3_600_000;
  for (let index = 0; index < 60; index++) {
    buffer.enqueue(
      index,
      LOCAL_ORIGIN_MS + index * FRAME_MS,
      timestampOf(index * FRAME_MS - hourMs),
    );
    buffer.clear();
  }
  // TIMESTAMP が 1 時間進み (基準を取り直す)、cache から追いつく実測の列が続く
  JOIN_CATCH_UP_ARRIVALS.forEach(([arrivalMs, mediaMs], index) => {
    const atMs = LOCAL_ORIGIN_MS + 60 * FRAME_MS + JOIN_FIRST_OFFSET_MS + arrivalMs;
    buffer.enqueue(60 + index, atMs, timestampOf(60 * FRAME_MS + mediaMs));
    buffer.clear();
  });
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 50);
});

// 追いついた後の経路の遅延の跳ねは、従来どおり再生遅延に使う
test("playoutDelayMs: cache から追いついた後の経路の遅延の跳ねは再生遅延に使う", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const last = enqueueJoinCatchUp(buffer);
  const lastMediaMs = JOIN_CATCH_UP_ARRIVALS[JOIN_CATCH_UP_ARRIVALS.length - 1]?.[1] ?? 0;
  // 以降は最後のフレームと同じ遅れで届き、30 枚に 3 枚が 100 ms 遅れる
  // (復号は順に行うため、到着は前のフレームより早くならない)
  let available = last.atMs;
  for (let step = 1; step <= 90; step++) {
    const mediaMs = lastMediaMs + step * FRAME_MS;
    const late = step % 30 === 10 || step % 30 === 20 || step % 30 === 25;
    available = Math.max(available, last.atMs + step * FRAME_MS + (late ? 100 : 0));
    buffer.enqueue(last.index + step, available, timestampOf(mediaMs));
    buffer.clear();
  }
  assert.isAtLeast(buffer.playoutDelayMs() ?? 0, 90);
});

// 表示待ちのキューには上限があるため、フレーム間隔が短いほど長く待てない。
// 再生遅延は (上限 - 余裕) 枚分のフレーム間隔までに抑える
test("playoutDelayMs: キューの上限を超えない長さに抑える", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const frameMs = 1_000 / 120;
  for (let index = 0; index < 240; index++) {
    enqueueAt(buffer, index, index % 2 === 0 ? 0 : 400, frameMs);
    buffer.clear();
  }
  const expected = (JITTER_BUFFER_MAX_QUEUED_FRAMES - PLAYOUT_QUEUE_HEADROOM_FRAMES) * frameMs;
  // フレーム間隔は TIMESTAMP (マイクロ秒に丸めた値) の差から求めるため、丸めの誤差を許す
  assert.closeTo(buffer.playoutDelayMs() ?? 0, expected, 0.05);
});

// ============================================================================
// TIMESTAMP の飛び
// ============================================================================

// TIMESTAMP が大きく戻ると (publisher の時計の変更や別の publisher への切り替え)、以降の
// フレームがすべて遅れて見え、再生遅延が上限に張り付く。基準を取り直し、積んでいた
// フレームは届いた順に描く
test("enqueue: TIMESTAMP が大きく戻ったら基準を取り直す", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  enqueueAt(buffer, 0, 0);
  enqueueAt(buffer, 1, 40);
  // 1 時間前の TIMESTAMP のフレームが、フレーム 2 の時刻に届く
  const nowMs = LOCAL_ORIGIN_MS + 2 * FRAME_MS;
  buffer.enqueue(2, nowMs, timestampOf(2 * FRAME_MS - 3_600_000));
  assert.closeTo(buffer.playoutDelayMs() ?? -1, 0, TOLERANCE_MS);
  // 積んでいたフレームは届いた順に 1 枚ずつ、新しいフレームは届いた時刻に描く
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 0, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 1, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(nowMs + TOLERANCE_MS)), { draw: 2, late: [] });
});

// TIMESTAMP が大きく進むと、フレームが先の時刻で待ち続ける。基準を取り直す
test("enqueue: TIMESTAMP が大きく進んだら基準を取り直す", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  enqueueAt(buffer, 0, 0);
  const nowMs = LOCAL_ORIGIN_MS + FRAME_MS;
  buffer.enqueue(1, nowMs, timestampOf(FRAME_MS + 3_600_000));
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 0, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(nowMs + TOLERANCE_MS)), { draw: 1, late: [] });
});

// ============================================================================
// 揺らぎの吸収
// ============================================================================

// 30 fps で 3 枚に 1 枚が 40 ms 遅れて届く。到着のタイミングのまま描くと表示間隔が
// 揺れるが、再生遅延 40 ms で TIMESTAMP の間隔どおりに描く (1 ms の選択の刻みの誤差のみ)
test("select: 揺らぎのある到着を TIMESTAMP の間隔どおりに描く", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  const frames = 30 * 5;
  const arrivals: { atMs: number; index: number }[] = [];
  let available = 0;
  for (let index = 0; index < frames; index++) {
    // 復号は順に行うため、前のフレームより先には表示できるようにならない
    available = Math.max(
      available,
      LOCAL_ORIGIN_MS + index * FRAME_MS + (index % 3 === 2 ? 40 : 0),
    );
    arrivals.push({ atMs: available, index });
  }
  const draws: { atMs: number; index: number }[] = [];
  const late: number[] = [];
  let next = 0;
  for (let nowMs = LOCAL_ORIGIN_MS; nowMs < LOCAL_ORIGIN_MS + frames * FRAME_MS + 100; nowMs++) {
    while (next < arrivals.length && (arrivals[next]?.atMs ?? Infinity) <= nowMs) {
      const arrival = arrivals[next];
      if (arrival !== undefined) {
        buffer.enqueue(arrival.index, arrival.atMs, timestampOf(arrival.index * FRAME_MS));
      }
      next++;
    }
    const selection = buffer.select(nowMs);
    late.push(...selection.late);
    if (selection.draw !== null) {
      draws.push({ atMs: nowMs, index: selection.draw });
    }
  }
  // 最初の 1 秒 (揺らぎを覚えるまで) を除いて、表示間隔は 1 フレーム ± 1 ms で、捨てない
  const steady = draws.filter((draw) => draw.index >= 30);
  for (let position = 1; position < steady.length; position++) {
    const interval = (steady[position]?.atMs ?? 0) - (steady[position - 1]?.atMs ?? 0);
    assert.isAtLeast(interval, FRAME_MS - 1);
    assert.isAtMost(interval, FRAME_MS + 1);
  }
  assert.deepEqual(
    late.filter((index) => index >= 30),
    [],
  );
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 40, TOLERANCE_MS);
});
