import { test, assert } from "vite-plus/test";
import { WallClockMapper } from "./mediaClock";

// 2026-09-25 付近の壁時計 (ミリ秒)。performance.timeOrigin + performance.now() の値に相当する。
// メディア時刻 (VideoFrame の timestamp) 0 のフレームをこの時刻に撮ったとする
const CAPTURE_ORIGIN_MILLIS = 1_790_263_445_000;
// 撮った時刻の壁時計 (マイクロ秒)
const CAPTURE_ORIGIN_MICROS = 1_790_263_445_000_000;
// 30 fps のフレーム間隔 (マイクロ秒)
const FRAME_MICROS = 33_333;

/** index 番目のフレームを、撮ってから readDelayMs 遅れて読んだものとして記録する */
function observeFrame(mapper: WallClockMapper, index: number, readDelayMs: number): void {
  mapper.observe(
    index * FRAME_MICROS,
    CAPTURE_ORIGIN_MILLIS + (index * FRAME_MICROS) / 1_000 + readDelayMs,
  );
}

/** index 番目のフレームの換算した TIMESTAMP と、撮った時刻の差 (マイクロ秒) */
function biasOf(mapper: WallClockMapper, index: number): number {
  const converted = mapper.toWallClockMicroseconds(index * FRAME_MICROS);
  return Number(converted) - (CAPTURE_ORIGIN_MICROS + index * FRAME_MICROS);
}

// draft-ietf-moq-loc-04 Section 2.3.1.1: Timescale を載せない TIMESTAMP は Unix epoch の
// マイクロ秒の壁時計である。撮ってから読むまでの遅れが最も小さいフレームに合わせて換算する。
// 最初のフレームだけで対応をとると、開始時の大きな遅れ (encoder の初期化など) の分だけ
// 以降の TIMESTAMP が未来にずれ、受信側の遅延が小さく (負に) 出る
test("toWallClockMicroseconds: 読み取りの遅れが最も小さいフレームに合わせる", () => {
  const mapper = new WallClockMapper();
  // 最初のフレームは 300 ms 遅れて読み、以降は 2 ms で読む
  observeFrame(mapper, 0, 300);
  observeFrame(mapper, 1, 2);
  observeFrame(mapper, 2, 2);
  // 最初の換算では、それまでに読んだフレームの最小の遅れ (2 ms) に合わせる
  assert.closeTo(biasOf(mapper, 0), 2_000, 1);
  assert.closeTo(biasOf(mapper, 1), 2_000, 1);
});

// 換算の途中で遅れの小さいフレームを読んでも、換算した TIMESTAMP は前のフレームより
// 戻らない。対応は 1 回の換算で timestamp の差の半分未満だけ動かし、最小の遅れへ近づける
test("toWallClockMicroseconds: 対応を動かしても単調に増え、最小の遅れへ近づく", () => {
  const mapper = new WallClockMapper();
  observeFrame(mapper, 0, 300);
  const converted: bigint[] = [mapper.toWallClockMicroseconds(0)];
  assert.closeTo(biasOf(mapper, 0), 300_000, 1);
  // 以降は 2 ms で読み、読んだ直後に換算する
  for (let index = 1; index < 60; index++) {
    observeFrame(mapper, index, 2);
    converted.push(mapper.toWallClockMicroseconds(index * FRAME_MICROS));
  }
  for (let position = 1; position < converted.length; position++) {
    const step = Number((converted[position] ?? 0n) - (converted[position - 1] ?? 0n));
    // 1 回で動かすのは timestamp の差の半分未満なので、差は半分より大きい
    assert.isAbove(step, FRAME_MICROS / 2);
  }
  // 298 ms の差は、1 回あたり半フレーム (約 16.7 ms) 未満で約 18 回かけて埋まる
  assert.closeTo(biasOf(mapper, 59), 2_000, 1);
});

// 後から遅れの大きいフレームを読んでも、対応は大きくする向きには動かさない
test("toWallClockMicroseconds: 遅れの大きいフレームでは対応を動かさない", () => {
  const mapper = new WallClockMapper();
  observeFrame(mapper, 0, 2);
  assert.closeTo(biasOf(mapper, 0), 2_000, 1);
  observeFrame(mapper, 1, 80);
  assert.closeTo(biasOf(mapper, 1), 2_000, 1);
});

// timestamp の基準は取得元ごとに異なる (canvas の captureStream() は stream の開始、
// fake camera は大きな値)。対応は差で求めるため、基準に依らない
test("toWallClockMicroseconds: timestamp の基準が大きな値でも換算できる", () => {
  const mapper = new WallClockMapper();
  const base = 289_052_241_600;
  mapper.observe(base, CAPTURE_ORIGIN_MILLIS + 5);
  assert.equal(
    mapper.toWallClockMicroseconds(base + FRAME_MICROS),
    BigInt(CAPTURE_ORIGIN_MICROS + 5_000 + FRAME_MICROS),
  );
});

// LOC の TIMESTAMP は vi64 で負を表せないため、Unix epoch より前にはしない
test("toWallClockMicroseconds: Unix epoch より前にはしない", () => {
  const mapper = new WallClockMapper();
  mapper.observe(1_000_000, 0.5);
  assert.equal(mapper.toWallClockMicroseconds(0), 0n);
});

// フレームを 1 つも読まずに換算する (呼び出し順の誤り) ときは、その時点の壁時計で対応をとる
test("toWallClockMicroseconds: 読んだフレームが無ければ渡した壁時計で対応をとる", () => {
  const mapper = new WallClockMapper();
  assert.equal(
    mapper.toWallClockMicroseconds(1_000, CAPTURE_ORIGIN_MILLIS),
    BigInt(CAPTURE_ORIGIN_MICROS),
  );
});
