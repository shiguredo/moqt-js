import { test, assert } from "vite-plus/test";
import {
  JITTER_BUFFER_MAX_QUEUED_FRAMES,
  MAX_PLAYOUT_DELAY_MS,
  PLAYOUT_DELAY_DECAY_MS_PER_SECOND,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlayoutBuffer,
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

// 表示時刻 = TIMESTAMP + 基準の遅れ (揺らぎ無しで届いたフレームの遅れ) + 再生遅延。
// 表示時刻より前には描かず、過ぎた後の最初の選択で描く
test("select: 表示時刻より前は描かず、過ぎたら描く", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  // 揺らぎ 0 のフレームと 40 ms 遅れたフレームで、再生遅延が 40 ms になる
  enqueueAt(buffer, 0, 0);
  enqueueAt(buffer, 1, 40);
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 40, TOLERANCE_MS);
  buffer.clear();

  // 揺らぎ 0 で届いたフレーム 3 は、届いてから 40 ms 待って描く
  enqueueAt(buffer, 3, 0);
  const presentationMs = LOCAL_ORIGIN_MS + 3 * FRAME_MS + 40;
  assert.closeTo(
    buffer.presentationTimeMs(timestampOf(3 * FRAME_MS)) ?? 0,
    presentationMs,
    TOLERANCE_MS,
  );
  assert.deepEqual(buffer.select(presentationMs - 0.1), { draw: null, late: [] });
  assert.deepEqual(buffer.select(presentationMs + TOLERANCE_MS), { draw: 3, late: [] });
  assert.equal(buffer.size, 0);
});

// 表示時刻を過ぎたフレームが複数あるときは、最新の 1 枚を次の選択に残してその 1 つ前を
// 描き、それより古いものは間に合わなかったフレームとして返す (捨てる)。並べ替えはしない。
// 最新を描いて 1 つ前も捨てると、配信 fps と表示周期が近いとき、位相の揺れで 2 枚が重なった
// 周期のたびに 1 枚を捨て、次の周期は何も描けずに表示が飛ぶ
test("select: 表示時刻を過ぎたフレームが複数あれば最新を残して 1 つ前を描き、古いものを捨てる", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  for (let index = 0; index < 4; index++) {
    enqueueAt(buffer, index, 0);
  }
  // フレーム 0 から 2 は表示時刻を過ぎ、フレーム 3 はまだ (再生遅延はほぼ 0)
  const nowMs = LOCAL_ORIGIN_MS + 2 * FRAME_MS + 1;
  assert.deepEqual(buffer.select(nowMs), { draw: 1, late: [0] });
  // 残したフレーム 2 は次の選択で描く
  assert.deepEqual(buffer.select(nowMs), { draw: 2, late: [] });
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
  assert.deepEqual(buffer.select(0), { draw: "a", late: [] });
  assert.deepEqual(buffer.select(0), { draw: "b", late: [] });
  assert.deepEqual(buffer.select(0), { draw: "c", late: [] });
  assert.deepEqual(buffer.select(0), { draw: null, late: [] });
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
// 古いフレームは表示時刻を過ぎているため、最新とその 1 つ前を除いて捨て、すぐに追いつく
test("enqueue: 購読の開始にまとめて届いた古いフレームを再生遅延に使わない", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  // Group の先頭から 20 枚 (約 0.67 秒前から現在まで) が、同じ時刻にまとめて届く
  const burstAtMs = LOCAL_ORIGIN_MS + 20 * FRAME_MS;
  for (let index = 0; index < 20; index++) {
    buffer.enqueue(index, burstAtMs + index * 0.1, timestampOf(index * FRAME_MS));
  }
  const selection = buffer.select(burstAtMs + 3);
  assert.equal(selection.draw, 18);
  assert.equal(selection.late.length, 18);
  assert.equal(buffer.select(burstAtMs + 3).draw, 19);
  // 以降は揺らぎ無しで届く
  for (let index = 20; index < 80; index++) {
    enqueueAt(buffer, index, 0);
    buffer.clear();
  }
  assert.closeTo(buffer.playoutDelayMs() ?? -1, 0, TOLERANCE_MS);
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
  assert.deepEqual(buffer.select(nowMs), { draw: 0, late: [] });
  assert.deepEqual(buffer.select(nowMs), { draw: 1, late: [] });
  assert.deepEqual(buffer.select(nowMs + TOLERANCE_MS), { draw: 2, late: [] });
});

// TIMESTAMP が大きく進むと、フレームが先の時刻で待ち続ける。基準を取り直す
test("enqueue: TIMESTAMP が大きく進んだら基準を取り直す", () => {
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
  enqueueAt(buffer, 0, 0);
  const nowMs = LOCAL_ORIGIN_MS + FRAME_MS;
  buffer.enqueue(1, nowMs, timestampOf(FRAME_MS + 3_600_000));
  assert.deepEqual(buffer.select(nowMs), { draw: 0, late: [] });
  assert.deepEqual(buffer.select(nowMs + TOLERANCE_MS), { draw: 1, late: [] });
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
