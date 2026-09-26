/**
 * PlayoutBuffer の単体テスト
 *
 * 復号したフレームを積み、共有の時間軸 (PlaybackTimeline) が決めた表示時刻で選ぶ。
 * 個々の規則 (表示時刻より前に描かない、表示時刻を過ぎたフレームの捨て方、TIMESTAMP を
 * 持たないフレームの到着順の再生、キューの上限、clear) をここで固定する。
 *
 * 表示時刻の式と学習 (基準の遅れ、再生遅延、フレーム間隔) は playbackTimeline.test.ts が
 * 固定する。このテストは時間軸を実物で作り、キューが学習の結果に従うことだけを見る。
 *
 * 時刻の軸は 2 つある。時間軸へ渡す観測の時刻は受信側の壁時計 (`EPOCH_MS + 経過`) で、
 * キューへ渡す選択の時刻は `performance.now()` (経過) である。表示時刻は
 * `presentationTimeMs` が `performance.now()` の軸で返す。
 */

import { test, assert } from "vite-plus/test";
import {
  JITTER_BUFFER_MAX_QUEUED_FRAMES,
  MAX_PRESENTATION_LAG_MS,
  PlayoutBuffer,
  type PlayoutSelection,
} from "./playoutBuffer";
import {
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  MAX_PLAYOUT_DELAY_MS,
  PLAYBACK_DISCONTINUITY_MS,
  PlaybackTimeline,
} from "./playbackTimeline";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 のフレームの TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 受信側の観測の軸 (`performance.now()`) の原点。メディア時刻 0 のフレームが揺らぎ無しで
// 復号の出力へ出る時刻
const LOCAL_ORIGIN_MS = 1_000;
// 30 fps のフレーム間隔 (ミリ秒)
const FRAME_MS = 1_000 / 30;
// TIMESTAMP (約 1.79e15 マイクロ秒) とミリ秒の変換で生じる誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/** `performance.now()` の時刻 (ミリ秒) を、時間軸へ渡す壁時計 (Unix epoch ミリ秒) にする */
function epochOf(localMs: number): number {
  return EPOCH_MS + localMs;
}

/**
 * 表示時刻を決める時間軸を作る
 *
 * `audioDelayFloorMs: 0` を渡したときは音声の下限を外す。映像だけの遅れを確かめたい
 * テストで使う
 */
function createTimeline(audioDelayFloorMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS): PlaybackTimeline {
  return new PlaybackTimeline({
    // 受信側の壁時計は `EPOCH_MS + 経過`、観測の軸 (`performance.now()`) は経過そのものである。
    // `presentationTimeMs` は「メディア時刻 + 表示の遅れ」を返す
    timeOriginMs: EPOCH_MS,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
    audioDelayFloorMs,
  });
}

/**
 * 復号の出力を時間軸へ観測させる
 *
 * `createMediaSubscriber` は復号の出力のたびに `timeline.observe` を呼ぶ。時間軸を実物で
 * 使うテストでは、キューへ積む前に同じ観測を与える。
 *
 * @param mediaMs - 復号の出力の TIMESTAMP のメディア時刻 (ミリ秒)
 * @param jitterMs - 経路と復号の揺らぎ (ミリ秒)。基準の遅れと再生遅延の元になる
 */
function observeFrame(
  timeline: PlaybackTimeline,
  mediaMs: number,
  jitterMs: number,
  stream: "audio" | "video" = "video",
): void {
  const localMs = LOCAL_ORIGIN_MS + mediaMs + jitterMs;
  timeline.observe(stream, epochOf(localMs), timestampOf(mediaMs));
}

/**
 * 音声の下限を効かせた時間軸を作る
 *
 * 共有の再生遅延の下限 (80 ms) は音声を購読しているときにだけ入る。映像だけを扱うテスト
 * でも本番と同じ下限にするため、映像と同じメディア時刻の音声を揺らぎ無しで観測しておく
 * (音声の基準の遅れも映像と同じ `LOCAL_ORIGIN_MS` になるため、基準の差は生じない)
 */
function createSharedTimeline(): PlaybackTimeline {
  const timeline = createTimeline();
  observeFrame(timeline, 0, 0, "audio");
  observeFrame(timeline, 0, 0);
  return timeline;
}

/**
 * 映像のフレームを積むたびに、同じメディア時刻の音声も観測する時間軸を作る
 *
 * 音声の下限 (80 ms) を効かせたまま、映像のフレーム間隔からキューが吸収できる長さが
 * 決まるようにする (音声の基準の遅れは映像と同じ値になる)
 */
function observeAudioWithVideo(
  timeline: PlaybackTimeline,
  mediaMs: number,
  jitterMs: number,
): void {
  observeFrame(timeline, mediaMs, jitterMs, "audio");
}

/**
 * 観測の時刻 (`performance.now()` のミリ秒) から、そのメディア時刻のフレームの表示時刻を
 * 求める。時間軸の `presentationPerformanceMs` は「観測の時刻 - 原点」ではなく
 * 「メディア時刻 + 表示の遅れ」を返すため、選択の時刻に直すには原点とメディア時刻を足す
 */
function selectionTimeOf(timeline: PlaybackTimeline, mediaMs: number): number {
  const presentationMs = timeline.presentationPerformanceMs("video", timestampOf(mediaMs));
  assert.isNotNull(presentationMs, "表示時刻が決まること");
  return (presentationMs ?? 0) + LOCAL_ORIGIN_MS - mediaMs;
}

/** 表示時刻を過ぎたフレームが 2 枚以上あるときの選択を確かめるための結果 */
function drawAndLate<T>(selection: PlayoutSelection<T>): { draw: T | null; late: T[] } {
  return { draw: selection.draw, late: selection.late };
}

// ============================================================================
// 表示時刻と選択
// ============================================================================

// 表示時刻 = TIMESTAMP + 基準の遅れ + 再生遅延。表示時刻より前は描かず、過ぎた後の最初の
// 選択で描く。表示時刻は共有の時間軸が決め、キューは自分では決めない
test("select: 表示時刻より前は描かず、過ぎたら描く", () => {
  const timeline = createSharedTimeline();
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  // 揺らぎ 0 のフレームが 3 枚届き、時間軸が音声の下限 (80 ms) を再生遅延にする
  for (let index = 0; index < 3; index++) {
    observeFrame(timeline, index * FRAME_MS, 0);
    buffer.enqueue(index, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);

  // 表示時刻 = メディア時刻 + 基準の遅れ + 再生遅延 (performance.now() の軸)。
  // 表示時刻は 1 フレーム間隔で進む
  const firstMs = buffer.presentationTimeMs(timestampOf(0)) ?? 0;
  const secondMs = buffer.presentationTimeMs(timestampOf(FRAME_MS)) ?? 0;
  assert.closeTo(secondMs - firstMs, FRAME_MS, TOLERANCE_MS);
  // 表示時刻より前の選択では何も描かない
  assert.deepEqual(buffer.select(firstMs - 1), {
    draw: null,
    late: [],
    drawPresentationMs: null,
  });
  // 表示時刻を過ぎたら描く。表示時刻からの遅れが上限以内なので捨てない
  const selection = buffer.select(firstMs + TOLERANCE_MS);
  assert.equal(selection.draw, 0, "表示時刻を過ぎた 1 枚目を描くこと");
  assert.deepEqual(selection.late, []);
  assert.closeTo(
    selection.drawPresentationMs ?? 0,
    firstMs,
    TOLERANCE_MS,
    "描くフレームの表示時刻を返すこと",
  );
});

// 描くフレームの表示時刻を返す。止まりの原因を決めるとき、フレームが表示時刻に間に合ったか
// (受け取り、復号) と、表示時刻そのものが遅れたか (再生遅延の増加) を見るために使う
test("select: 描くフレームの表示時刻を返す", () => {
  const timeline = createSharedTimeline();
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  observeFrame(timeline, 0, 0);
  observeFrame(timeline, FRAME_MS, 0);
  buffer.enqueue(0, timestampOf(0));
  buffer.enqueue(1, timestampOf(FRAME_MS));

  const firstMs = buffer.presentationTimeMs(timestampOf(0)) ?? 0;
  const secondMs = buffer.presentationTimeMs(timestampOf(FRAME_MS)) ?? 0;
  // 表示時刻の前は描かず、表示時刻も返さない
  assert.deepEqual(buffer.select(firstMs - 1), {
    draw: null,
    late: [],
    drawPresentationMs: null,
  });
  // 1 枚目の表示時刻に、1 枚目とその表示時刻を返す
  const first = buffer.select(firstMs + TOLERANCE_MS);
  assert.equal(first.draw, 0, "1 枚目を描くこと");
  assert.closeTo(
    first.drawPresentationMs ?? 0,
    firstMs,
    TOLERANCE_MS,
    "1 枚目の表示時刻を返すこと",
  );
  // 2 枚目の表示時刻に、2 枚目とその表示時刻を返す
  const second = buffer.select(secondMs + TOLERANCE_MS);
  assert.equal(second.draw, 1, "2 枚目を描くこと");
  assert.closeTo(
    second.drawPresentationMs ?? 0,
    secondMs,
    TOLERANCE_MS,
    "2 枚目の表示時刻を返すこと",
  );
});

// 表示時刻を過ぎたフレームが複数あるときは、表示時刻からの遅れが MAX_PRESENTATION_LAG_MS
// 以内のフレームを古い順に 1 枚ずつ描き、それより遅れたフレームは間に合わなかったフレーム
// として返す (捨てる)。最新の 1 枚は遅れていても描く。並べ替えはしない。
// 表示時刻を過ぎたフレームを最新の 1 枚だけにすると、配信 fps と表示周期が近いとき、
// 表示時刻と選択の位相の揺れや、取得の間隔の揺れで 2 枚以上が重なった周期のたびに捨てて、
// 次の周期は何も描けずに表示が飛ぶ
test("select: 表示時刻からの遅れが上限以内のフレームは古い順に描き、それより遅れたものを捨てる", () => {
  const frameMs = 1_000 / 120;
  // 基準の遅れを 0 ms、再生遅延を音声の下限 (80 ms) にする
  const timeline = createTimeline();
  observeAudioWithVideo(timeline, 0, 0);
  observeFrame(timeline, 0, 0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const presentationTimes: number[] = [];
  for (let index = 0; index < 6; index++) {
    observeAudioWithVideo(timeline, index * frameMs, 0);
    observeFrame(timeline, index * frameMs, 0);
    buffer.enqueue(index, timestampOf(index * frameMs));
    presentationTimes.push(buffer.presentationTimeMs(timestampOf(index * frameMs)) ?? 0);
  }
  // フレーム 0 から 4 が表示時刻を過ぎ、フレーム 5 はまだ。フレーム 0 と 1 は表示時刻から
  // 上限を超えて遅れている
  const nowMs = (presentationTimes[4] ?? 0) + 1;
  assert.isAbove(nowMs - (presentationTimes[1] ?? 0), MAX_PRESENTATION_LAG_MS);
  assert.isBelow(nowMs - (presentationTimes[2] ?? 0), MAX_PRESENTATION_LAG_MS);
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 2, late: [0, 1] });
  // 残したフレームは次の選択から古い順に描く
  assert.deepEqual(drawAndLate(buffer.select(nowMs + 2)), { draw: 3, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(nowMs + 2)), { draw: 4, late: [] });
  assert.equal(buffer.size, 1);
});

// 30 fps では 2 枚が表示時刻を過ぎると古い方は上限を超えて遅れているため、最新を描いて
// 古い方を捨てる
test("select: 上限を超えて遅れたフレームを捨てて最新を描く", () => {
  // 基準の遅れを 0 ms、再生遅延を音声の下限 (80 ms) にする
  const timeline = createTimeline();
  observeAudioWithVideo(timeline, 0, 0);
  observeFrame(timeline, 0, 0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const presentationTimes: number[] = [];
  for (let index = 0; index < 4; index++) {
    observeAudioWithVideo(timeline, index * FRAME_MS, 0);
    observeFrame(timeline, index * FRAME_MS, 0);
    buffer.enqueue(index, timestampOf(index * FRAME_MS));
    presentationTimes.push(buffer.presentationTimeMs(timestampOf(index * FRAME_MS)) ?? 0);
  }
  // フレーム 0 から 2 が表示時刻を過ぎ、0 と 1 は上限を超えて遅れている
  const nowMs = (presentationTimes[2] ?? 0) + 1;
  assert.deepEqual(drawAndLate(buffer.select(nowMs)), { draw: 2, late: [0, 1] });
  assert.equal(buffer.size, 1);
});

// 配信 fps と表示周期が同じ (120 fps を 120 Hz で表示) で、表示時刻と選択の位相が
// ±0.3 ms 揺れる。ある周期に 2 枚が表示時刻を過ぎ、次の周期には 1 枚も過ぎないことが
// 繰り返されても、フレームを捨てずに全周期で 1 枚ずつ描く
test("select: 配信 fps と表示周期が同じで位相が揺れてもフレームを捨てない", () => {
  const frameMs = 1_000 / 120;
  // 再生遅延は音声の下限 (80 ms) になる。表示時刻は「基準の遅れ 0 ms + 再生遅延」から
  // 始まるため、選択の時刻も基準の遅れの分だけずらす
  const timeline = createTimeline();
  observeAudioWithVideo(timeline, 0, 0);
  observeFrame(timeline, 0, 0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const baseMs = buffer.presentationTimeMs(timestampOf(0)) ?? 0;
  const frames = 120 * 3;
  const draws: number[] = [];
  const late: number[] = [];
  let enqueued = 0;
  for (let tick = 0; tick < frames; tick++) {
    // 選択の時刻は表示時刻の前後 0.3 ms に揺れる
    const tickMs = baseMs + tick * frameMs + (tick % 2 === 0 ? 0.3 : -0.3);
    while (enqueued < frames && baseMs + enqueued * frameMs <= tickMs) {
      // 2 枚に 1 枚が 0.6 ms 遅れて届く (基準の遅れが 0.6 ms 動く)
      observeAudioWithVideo(timeline, enqueued * frameMs, enqueued % 2 === 1 ? 0.6 : 0);
      observeFrame(timeline, enqueued * frameMs, enqueued % 2 === 1 ? 0.6 : 0);
      buffer.enqueue(enqueued, timestampOf(enqueued * frameMs));
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

// TIMESTAMP を壁時計として使えないフレーム (TIMESTAMP 無し) は、届いた順に 1 回の選択で
// 1 枚ずつ描く。表示時刻を決めないため、表示時刻は返さない
test("select: TIMESTAMP の無いフレームは届いた順に 1 枚ずつ描く", () => {
  const timeline = createSharedTimeline();
  const buffer = new PlayoutBuffer<string>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  buffer.enqueue("a", null);
  buffer.enqueue("b", null);
  buffer.enqueue("c", null);
  assert.deepEqual(buffer.select(LOCAL_ORIGIN_MS), {
    draw: "a",
    late: [],
    drawPresentationMs: null,
  });
  assert.deepEqual(buffer.select(LOCAL_ORIGIN_MS), {
    draw: "b",
    late: [],
    drawPresentationMs: null,
  });
  assert.deepEqual(buffer.select(LOCAL_ORIGIN_MS), {
    draw: "c",
    late: [],
    drawPresentationMs: null,
  });
  assert.deepEqual(buffer.select(LOCAL_ORIGIN_MS), {
    draw: null,
    late: [],
    drawPresentationMs: null,
  });
  assert.isNull(buffer.presentationTimeMs(null));
});

// 時間軸がまだ基準を持たない (1 枚も観測していない) のときは表示時刻を決められないため、
// 届いた順に 1 枚ずつ描く
test("select: 時間軸が基準を持たないときは届いた順に描く", () => {
  const timeline = createTimeline();
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  buffer.enqueue(0, timestampOf(0));
  buffer.enqueue(1, timestampOf(FRAME_MS));
  assert.isNull(buffer.presentationTimeMs(timestampOf(0)));
  assert.isNull(buffer.playoutDelayMs());
  assert.deepEqual(drawAndLate(buffer.select(LOCAL_ORIGIN_MS)), { draw: 0, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(LOCAL_ORIGIN_MS)), { draw: 1, late: [] });
  assert.deepEqual(drawAndLate(buffer.select(LOCAL_ORIGIN_MS)), { draw: null, late: [] });
});

// 時間軸がそのトラックの TIMESTAMP を使わない (2 つのトラックの基準の差が閾値を超えた側)
// ときは表示時刻を決められないため、届いた順に 1 枚ずつ描く
test("select: 時間軸がそのトラックの TIMESTAMP を使わないときは届いた順に描く", () => {
  const timeline = createTimeline();
  // 映像の基準 0 ms、音声の基準 1 秒 (TIMESTAMP が壁時計からずれている側)
  observeFrame(timeline, 0, 0);
  observeFrame(timeline, 0, 1_000, "audio");
  assert.isFalse(timeline.sharingBases);
  assert.isNull(timeline.presentationPerformanceMs("audio", timestampOf(0)));

  const audio = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline, "audio");
  audio.enqueue(0, timestampOf(0));
  audio.enqueue(1, timestampOf(FRAME_MS));
  assert.isNull(audio.presentationTimeMs(timestampOf(0)));
  assert.deepEqual(drawAndLate(audio.select(LOCAL_ORIGIN_MS)), { draw: 0, late: [] });
  assert.deepEqual(drawAndLate(audio.select(LOCAL_ORIGIN_MS)), { draw: 1, late: [] });
  // もう片方のトラックは自分の基準で表示時刻を決められる
  const video = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  video.enqueue(0, timestampOf(0));
  assert.isNotNull(video.presentationTimeMs(timestampOf(0)));
});

// 表示時刻は共有の時間軸が決める。時間軸は音声の下限 (80 ms) を再生遅延に入れるため、
// 映像のキューもその値で選ぶ
test("presentationTimeMs: 表示時刻は共有の時間軸が決める", () => {
  const timeline = createSharedTimeline();
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const delayMs = timeline.presentationDelayMs ?? 0;
  assert.closeTo(delayMs, AUDIO_PLAYOUT_DELAY_FLOOR_MS + LOCAL_ORIGIN_MS, TOLERANCE_MS);
  buffer.enqueue(0, timestampOf(0));
  const presentationMs = buffer.presentationTimeMs(timestampOf(0)) ?? 0;
  // 表示時刻は performance.now() の軸で返る (基準の遅れは 0 ms、再生遅延は下限の 80 ms)
  assert.closeTo(presentationMs, LOCAL_ORIGIN_MS + AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 共有の時間軸が決めた表示時刻 (performance.now() の軸) の前は描かず、過ぎたら描く
  assert.deepEqual(buffer.select(presentationMs - 1), {
    draw: null,
    late: [],
    drawPresentationMs: null,
  });
  const selection = buffer.select(presentationMs + TOLERANCE_MS);
  assert.equal(selection.draw, 0);
  assert.closeTo(selection.drawPresentationMs ?? 0, presentationMs, TOLERANCE_MS);
  assert.equal(selection.drawPresentationMs, buffer.presentationTimeMs(timestampOf(0)));
});

// ============================================================================
// キューの上限と clear
// ============================================================================

// キューの上限を超えたら古い方から捨てる
test("enqueue: キューの上限を超えたら古い方から返す", () => {
  const buffer = new PlayoutBuffer<string>(2, createTimeline());
  assert.deepEqual(buffer.enqueue("a", null), []);
  assert.deepEqual(buffer.enqueue("b", null), []);
  assert.deepEqual(buffer.enqueue("c", null), ["a"]);
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.clear(), ["b", "c"]);
  assert.equal(buffer.size, 0);
});

// ============================================================================
// 再生遅延
// ============================================================================

// 揺らぎが増えたら直ちに追従する (共有の時間軸の再生遅延を返す)
test("playoutDelayMs: 揺らぎが増えたら直ちに上げる", () => {
  const timeline = createSharedTimeline();
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  // 揺らぎ 0 のフレームを 1 秒分観測し、キューは空にする
  for (let index = 0; index < 30; index++) {
    observeFrame(timeline, index * FRAME_MS, 0);
    buffer.clear();
  }
  assert.closeTo(buffer.playoutDelayMs() ?? -1, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 100 ms 遅れたフレームが 2 枚 (窓の p95 に入る) 届くと直ちに 100 ms にする
  observeFrame(timeline, 30 * FRAME_MS, 100);
  observeFrame(timeline, 31 * FRAME_MS, 100);
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 100, TOLERANCE_MS);
});

// 表示時刻の後に届くフレームを 1 秒に 1 枚までにするため、再生遅延の目標にする揺らぎの
// 百分位を配信 fps から決める (30 fps で約 96.7%、120 fps で約 99.2%、下限は 95%)。
// 2% のフレームが 30 ms 遅れる経路では、30 fps (1 秒に 0.6 枚) は遅れを許して再生遅延を
// 上げず、120 fps (1 秒に 2.4 枚) は遅れを吸収する。音声の下限は外して映像の遅れだけを見る
test("playoutDelayMs: 配信 fps から百分位を決める", () => {
  for (const frameMs of [1_000 / 30, 1_000 / 120]) {
    const timeline = createTimeline(0);
    const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
    let jitterMs = 0;
    for (let index = 0; index < 1_000; index++) {
      const late = index % 100 === 17 || index % 100 === 67;
      // 復号は順に行うため、復号の出力は前のフレームより早くならない
      jitterMs = Math.max(jitterMs - frameMs, late ? 30 : 0);
      observeFrame(timeline, index * frameMs, jitterMs);
      buffer.clear();
    }
    // 30 fps は 1 秒に 0.6 枚しか遅れないため吸収せず、120 fps は 2.4 枚あるため吸収する
    const expectedMs = frameMs === 1_000 / 30 ? 0 : 30;
    assert.closeTo(buffer.playoutDelayMs() ?? 0, expectedMs, TOLERANCE_MS);
  }
});

// 上限 (500 ms) を超える揺らぎは再生遅延では吸収できないため、再生遅延の目標に使わない。
// 使うと再生遅延が上限に張り付き、常に大きく遅れて表示することになる
test("playoutDelayMs: 上限を超える揺らぎは再生遅延に使わない", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  let jitterMs = 0;
  for (let index = 0; index < 60; index++) {
    // 2 枚に 1 枚が 900 ms 遅れる (復号は順に行うため、到着は前のフレームより早くならない)
    jitterMs = Math.max(jitterMs - FRAME_MS, index % 2 === 1 ? 900 : 0);
    observeFrame(timeline, index * FRAME_MS, jitterMs);
    buffer.clear();
  }
  assert.isAtMost(buffer.playoutDelayMs() ?? Infinity, MAX_PLAYOUT_DELAY_MS);
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 900);
});

// 表示待ちのキューには上限があるため、フレーム間隔が短いほど長く待てない。
// 再生遅延は (上限 - 余裕) 枚分のフレーム間隔までに抑える
test("playoutDelayMs: キューの上限を超えない長さに抑える", () => {
  const frameMs = 1_000 / 120;
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  for (let index = 0; index < 240; index++) {
    // 2 枚に 1 枚が 100 ms 遅れる。窓の p95 が 100 ms になるが、キューが吸収できる長さは
    // 8.33 ms × 20 枚 = 166.7 ms であり、遅れは上限に収まる
    observeFrame(timeline, index * frameMs, index % 2 === 0 ? 0 : 100);
    buffer.clear();
  }
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 100, TOLERANCE_MS);
});

// 購読の開始では relay の cache から古いフレームが実時間より速く届いて live に追いつく。
// これは経路の揺らぎではないため、再生遅延の目標に使わない
test("playoutDelayMs: 購読の開始にまとめて届いた古いフレームを再生遅延に使わない", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  // Group の先頭から 20 枚 (約 0.67 秒前から現在まで) が、同じ時刻にまとめて届く
  const burstJitterMs = 20 * FRAME_MS;
  for (let index = 0; index < 20; index++) {
    observeFrame(timeline, index * FRAME_MS, burstJitterMs);
    buffer.enqueue(index, timestampOf(index * FRAME_MS));
  }
  // 表示時刻を過ぎたフレーム (フレーム 18 まで) を捨てて最新を描く。表示時刻は
  // 基準の遅れ (バーストの遅れ) + 再生遅延 0 ms + メディア時刻である
  const lastPresentationMs = buffer.presentationTimeMs(timestampOf(19 * FRAME_MS)) ?? 0;
  const selection = buffer.select(lastPresentationMs);
  assert.equal(selection.draw, 19);
  assert.equal(selection.late.length, 19);
  // 以降は揺らぎ無しで届く
  for (let index = 20; index < 80; index++) {
    observeFrame(timeline, index * FRAME_MS, 0);
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

/** 実測の列の最初のフレームの、TIMESTAMP から復号の出力までの遅れ (ms) */
const JOIN_FIRST_OFFSET_MS = 957.1;

/** 実測の列を時間軸へ観測させ、キューへ積む。返り値は最後のフレームの観測の時刻と番号 */
function enqueueJoinCatchUp(
  buffer: PlayoutBuffer<number>,
  timeline: PlaybackTimeline,
): { localMs: number; index: number } {
  let last = { localMs: LOCAL_ORIGIN_MS, index: -1 };
  JOIN_CATCH_UP_ARRIVALS.forEach(([arrivalMs, mediaMs], index) => {
    // 最初のフレームは TIMESTAMP から JOIN_FIRST_OFFSET_MS 遅れて復号の出力へ出る
    const localMs = LOCAL_ORIGIN_MS + JOIN_FIRST_OFFSET_MS + arrivalMs;
    observeFrame(timeline, mediaMs, localMs - LOCAL_ORIGIN_MS - mediaMs);
    buffer.enqueue(index, timestampOf(mediaMs));
    buffer.clear();
    last = { localMs, index };
  });
  // 観測の時刻 (localMs) は「復号の出力の時刻 - メディア時刻」を含む
  return last;
}

// 購読の開始では、relay の cache から古いフレームが実時間より速く届いて live に追いつく。
// 追いつく途中のフレームの遅れは経路の揺らぎではない。まとまって届いたとみなせない間隔
// (フレーム間隔の半分以上) で届くものも、再生遅延の目標に使わない。使うと再生遅延が
// 数百ミリ秒になり、窓 (10 秒) から抜けた後も毎秒 20 ms でしか下がらない
test("playoutDelayMs: 購読の開始に cache から追いつく途中のフレームの遅れを再生遅延に使わない", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  enqueueJoinCatchUp(buffer, timeline);
  // live の揺らぎ (約 20 ms) 程度に収まる。追いつく途中の遅れを学習すると 400 ms を超える
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 50);
});

// 別の publisher への切り替えなどで TIMESTAMP が飛ぶと基準を取り直す。取り直した後も、
// cache から追いつく途中のフレームの遅れは再生遅延に使わない
test("playoutDelayMs: 基準を取り直した後も cache から追いつく途中のフレームの遅れを使わない", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  // 1 時間前の TIMESTAMP のフレームが、実時間より速く届いて live に追いつく (cache の再生)
  const hourMs = 3_600_000;
  for (let index = 0; index < 60; index++) {
    const mediaMs = index * FRAME_MS;
    const localMs = LOCAL_ORIGIN_MS + mediaMs + 500;
    observeFrame(timeline, mediaMs - hourMs, localMs - LOCAL_ORIGIN_MS - (mediaMs - hourMs));
    buffer.clear();
  }
  assert.isAtLeast(PLAYBACK_DISCONTINUITY_MS, 2_000);
  // TIMESTAMP が 1 時間進んだフレームが届き、基準を取り直す。取り直した後の遅れ (500 ms) を
  // 学習しない (追いつく途中のフレームの遅れは経路の揺らぎではない)
  for (let index = 0; index < 60; index++) {
    const mediaMs = 2_000 + index * FRAME_MS;
    const localMs = LOCAL_ORIGIN_MS + mediaMs + 500;
    observeFrame(timeline, mediaMs, localMs - LOCAL_ORIGIN_MS - mediaMs);
    buffer.clear();
  }
  assert.isBelow(buffer.playoutDelayMs() ?? Infinity, 50);
});

// 追いついた後の経路の遅延の跳ねは、従来どおり再生遅延に使う
test("playoutDelayMs: cache から追いついた後の経路の遅延の跳ねは再生遅延に使う", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const last = enqueueJoinCatchUp(buffer, timeline);
  const lastMediaMs = JOIN_CATCH_UP_ARRIVALS[JOIN_CATCH_UP_ARRIVALS.length - 1]?.[1] ?? 0;
  // 以降は 30 枚に 3 枚が 100 ms 遅れる (復号は順に行うため、出力は前のフレームより早くならない)
  let jitterMs = last.localMs - LOCAL_ORIGIN_MS - lastMediaMs;
  for (let step = 1; step <= 90; step++) {
    const late = step % 30 === 10 || step % 30 === 20 || step % 30 === 25;
    jitterMs = Math.max(jitterMs - FRAME_MS, late ? 100 : 0);
    observeFrame(timeline, lastMediaMs + step * FRAME_MS, jitterMs);
    buffer.clear();
  }
  assert.isAtLeast(buffer.playoutDelayMs() ?? 0, 90);
});

// ============================================================================
// TIMESTAMP の飛び
// ============================================================================

// TIMESTAMP が大きく戻ると (publisher の時計の変更や別の publisher への切り替え)、以降の
// フレームがすべて遅れて見え、再生遅延が上限に張り付く。時間軸が基準を取り直し、積んで
// いたフレームは届いた順に描く
test("enqueue: TIMESTAMP が大きく戻ったら基準を取り直す", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  observeFrame(timeline, 0, 0);
  observeFrame(timeline, FRAME_MS, 0);
  buffer.enqueue(0, timestampOf(0));
  buffer.enqueue(1, timestampOf(FRAME_MS));
  const nowMs = 2 * FRAME_MS;
  // 1 時間前の TIMESTAMP のフレームが、フレーム 2 の時刻に復号の出力へ出る (基準を取り直す)
  timeline.observe("video", epochOf(nowMs), timestampOf(2 * FRAME_MS - 3_600_000));
  buffer.enqueue(2, timestampOf(2 * FRAME_MS - 3_600_000));
  // 取り直した後の表示時刻は、新しい基準 (観測の時刻 - TIMESTAMP) で決まる。この基準は
  // 飛びの前のフレームの TIMESTAMP を大きく過去にするため、積んでいたフレームの表示時刻は
  // 未来へ進み、新しく届いたフレームの表示時刻 (nowMs) より後になる
  // 取り直した後の表示時刻は、新しい基準 (観測の時刻 - TIMESTAMP) で決まる
  assert.closeTo(
    buffer.presentationTimeMs(timestampOf(2 * FRAME_MS - 3_600_000)) ?? 0,
    nowMs,
    TOLERANCE_MS,
  );
  // 取り直す前に積んでいたフレームは新しい基準では表示時刻を決められないため、
  // 届いた順に 1 枚ずつ描く (取り直し前の PlayoutBuffer の扱いと同じ)
  assert.deepEqual(buffer.select(nowMs), { draw: 0, late: [], drawPresentationMs: null });
  assert.deepEqual(buffer.select(nowMs), { draw: 1, late: [], drawPresentationMs: null });
  // 取り直した後のフレームは、新しい基準の表示時刻を過ぎたら描く
  const jumpedMediaMs = 2 * FRAME_MS - 3_600_000;
  const selection = buffer.select(selectionTimeOf(timeline, jumpedMediaMs) + 1);
  assert.equal(selection.draw, 2, "表示時刻を過ぎた新しいフレームを描くこと");
  assert.deepEqual(selection.late, []);
});

// TIMESTAMP が大きく進むと、フレームが先の時刻で待ち続ける。基準を取り直す
test("enqueue: TIMESTAMP が大きく進んだら基準を取り直す", () => {
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  observeFrame(timeline, 0, 0);
  buffer.enqueue(0, timestampOf(0));
  const nowMs = FRAME_MS;
  timeline.observe("video", epochOf(nowMs), timestampOf(FRAME_MS + 3_600_000));
  buffer.enqueue(1, timestampOf(FRAME_MS + 3_600_000));
  // 取り直した後の表示時刻は nowMs 以降になる (飛びの前の値ではない)
  assert.closeTo(
    buffer.presentationTimeMs(timestampOf(FRAME_MS + 3_600_000)) ?? 0,
    nowMs,
    TOLERANCE_MS,
  );
  // 取り直した後の表示時刻 (観測の時刻) を過ぎたら描ける
  const jumpedMediaMs = FRAME_MS + 3_600_000;
  const selection = buffer.select(selectionTimeOf(timeline, jumpedMediaMs) + TOLERANCE_MS);
  assert.isNotNull(selection.draw, "表示時刻を過ぎたフレームを描くこと");
});

// ============================================================================
// 揺らぎの吸収
// ============================================================================

// 30 fps で 3 枚に 1 枚が 40 ms 遅れて届く。到着のタイミングのまま描くと表示間隔が
// 揺れるが、再生遅延 40 ms で TIMESTAMP の間隔どおりに描く (1 ms の選択の刻みの誤差のみ)
test("select: 揺らぎのある到着を TIMESTAMP の間隔どおりに描く", () => {
  // 音声の下限を外し、映像の揺らぎ (40 ms) がそのまま再生遅延になるようにする
  const timeline = createTimeline(0);
  const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
  const frames = 30 * 5;
  const arrivals: { localMs: number; index: number }[] = [];
  let jitterMs = 0;
  for (let index = 0; index < frames; index++) {
    // 復号は順に行うため、復号の出力は前のフレームより早くならない
    jitterMs = Math.max(jitterMs - FRAME_MS, index % 3 === 2 ? 40 : 0);
    arrivals.push({ localMs: LOCAL_ORIGIN_MS + index * FRAME_MS + jitterMs, index });
  }
  const draws: { localMs: number; index: number }[] = [];
  const late: number[] = [];
  let next = 0;
  for (let nowMs = 0; nowMs < frames * FRAME_MS + 100; nowMs++) {
    while (next < arrivals.length && (arrivals[next]?.localMs ?? Infinity) <= nowMs) {
      const arrival = arrivals[next];
      if (arrival !== undefined) {
        const mediaMs = arrival.index * FRAME_MS;
        observeFrame(timeline, mediaMs, arrival.localMs - LOCAL_ORIGIN_MS - mediaMs);
        buffer.enqueue(arrival.index, timestampOf(mediaMs));
      }
      next++;
    }
    const selection = buffer.select(nowMs);
    late.push(...selection.late);
    if (selection.draw !== null) {
      draws.push({ localMs: nowMs, index: selection.draw });
    }
  }
  // 最初の 1 秒 (揺らぎを覚えるまで) を除いて、表示間隔は 1 フレーム ± 1 ms で、捨てない。
  // 選択の時刻は表示時刻の軸ではなく 1 ms ごとの実時間であるため、間隔の誤差は 1 ms 以内
  const steady = draws.filter((draw) => draw.index >= 30);
  assert.isAbove(steady.length, 30 * 3);
  for (let position = 1; position < steady.length; position++) {
    const interval = (steady[position]?.localMs ?? 0) - (steady[position - 1]?.localMs ?? 0);
    assert.isAtLeast(interval, FRAME_MS - 1);
    assert.isAtMost(interval, FRAME_MS + 1);
  }
  assert.deepEqual(
    late.filter((index) => index >= 30),
    [],
  );
  assert.closeTo(buffer.playoutDelayMs() ?? 0, 40, TOLERANCE_MS);
});
