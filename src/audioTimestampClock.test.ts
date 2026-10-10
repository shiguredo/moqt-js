/**
 * 音声の TIMESTAMP を配信側の壁時計へ合わせる規則の単体テスト
 *
 * マイクや Web Audio の `AudioData.timestamp` は壁時計と同じ時計ではない。
 * 刻み (サンプルの間隔) はそのままに、原点だけを「読み出した壁時計 - timestamp」の窓の
 * 最小値へ合わせる。一定のずれ・ドリフト・段差・読み出しの遅れのそれぞれで、補正の動きを
 * 固定する。
 */

import { test, assert } from "vite-plus/test";
import { AudioTimestampClock } from "./audioTimestampClock";

/** 2026-09-25 付近の壁時計 (マイクロ秒)。`performance.timeOrigin + performance.now()` に相当する */
const EPOCH_MICROS = 1_790_263_445_000_000;

/** 音声のフレーム間隔 (マイクロ秒)。Opus の 20 ms フレーム */
const FRAME_MICROS = 20_000;

/** 音声の時計が壁時計から遅れている分 (マイクロ秒)。300 ms とする */
const CLOCK_LAG_MICROS = 300_000;

/** 撮ってから読むまでの、最も小さい遅れ (マイクロ秒) */
const MIN_READ_DELAY_MICROS = 5_000;

/**
 * 1 フレームを読んだものとして記録する
 *
 * フレームは 20 ms ごとに実時間どおりに届く。撮った時刻の壁時計は
 * 「フレームの番号 × 20 ms + 音声の時計の遅れ」であり、読んだ時刻はさらに読み出しの
 * 遅れだけ後になる。`audioMicros` に渡す値を変えることで、音声の時計のずれ・ドリフト・
 * 段差を表せる。
 *
 * @param clock - 記録する時計
 * @param index - フレームの番号
 * @param audioMicros - そのフレームの `AudioData.timestamp` (マイクロ秒)
 * @param readDelayMicros - 撮ってから読むまでの遅れ (マイクロ秒)
 */
function recordFrame(
  clock: AudioTimestampClock,
  index: number,
  audioMicros: number,
  readDelayMicros: number,
): void {
  const captureWallClockMicros = EPOCH_MICROS + index * FRAME_MICROS + CLOCK_LAG_MICROS;
  clock.record(BigInt(captureWallClockMicros + readDelayMicros), audioMicros);
}

/** いま使っている補正 (マイクロ秒)。壁時計の原点を引いてテストの中で読みやすくする */
function appliedOffsetMicros(clock: AudioTimestampClock): number {
  const applied = clock.appliedMicros;
  assert.isNotNull(applied);
  return Number(applied) - EPOCH_MICROS;
}

/** 一定のずれ (CLOCK_LAG_MICROS) で index 番目のフレームを読む */
function recordSteadyFrame(
  clock: AudioTimestampClock,
  index: number,
  readDelayMicros = MIN_READ_DELAY_MICROS,
): void {
  recordFrame(clock, index, index * FRAME_MICROS, readDelayMicros);
}

// 観測が 1 つも無いうちは補正できない。呼び出し側が従来の換算へ落とせるように null を返す
test("apply: 観測が無ければ null を返す", () => {
  const clock = new AudioTimestampClock();
  assert.isNull(clock.apply(0));
  assert.isNull(clock.appliedMicros);
  assert.isNull(clock.snapshot());
});

// 音声の時計が壁時計から一定にずれているとき、補正は最小の読み出しの遅れに落ち着き、
// そこから動かない。送る TIMESTAMP は「撮った時刻 + 最小の遅れ」になり、間隔は
// AudioData.timestamp の間隔そのままになる
test("apply: 一定のずれでは補正が動かず、間隔も変わらない", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 300; index++) {
    // 読み出しの遅れを 5 ms / 6 ms / 7 ms で揺らす
    recordSteadyFrame(clock, index, MIN_READ_DELAY_MICROS + (index % 3) * 1_000);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);

  // 20 ms の間隔がそのまま保たれる
  const first = clock.apply(0);
  const second = clock.apply(FRAME_MICROS);
  assert.isNotNull(first);
  assert.isNotNull(second);
  assert.equal(Number((second ?? 0n) - (first ?? 0n)), FRAME_MICROS);
  // TIMESTAMP は「撮った時刻 + 最小の遅れ」である
  assert.equal(first, BigInt(EPOCH_MICROS + CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS));
});

// 音声の時計がゆっくり遅れていくとき、窓の最小値は窓の分だけ古い床を指す。補正は
// 止まらずに動き続け、受信側から見た「TIMESTAMP が壁時計から遅れる量」は窓の幅で抑えられる
test("apply: ゆっくりしたドリフトへ窓の最小値で追従する", () => {
  const clock = new AudioTimestampClock();
  // 音声の時計が 1 フレーム (20 ms) ごとに 1 ms 遅れる (50 ms / 秒 のドリフト)
  const driftPerFrameMicros = 1_000;
  const frames = 400;
  for (let index = 0; index < frames; index++) {
    recordFrame(
      clock,
      index,
      index * FRAME_MICROS - index * driftPerFrameMicros,
      MIN_READ_DELAY_MICROS,
    );
  }

  // 2 秒 (100 フレーム) の窓の分だけ古い床を使う
  const expectedMicros =
    CLOCK_LAG_MICROS + (frames - 1 - 100) * driftPerFrameMicros + MIN_READ_DELAY_MICROS;
  assert.closeTo(appliedOffsetMicros(clock), expectedMicros, 2 * driftPerFrameMicros);
  // 最初の床に張り付かず、ドリフトへ動いている
  assert.isAbove(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS + 200_000);
});

// 音声の時計が 500 ms 遅れる段差では、2 秒の窓が埋まるのを待たずに直近の窓から取り直す。
// 待つと、その間だけ TIMESTAMP が実際より古くなり、受信側の再生の目標が過去へずれて音が捨てられる
test("apply: 音声の時計が遅れる段差は直近の窓から取り直す", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 100; index++) {
    recordSteadyFrame(clock, index);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);

  // 音声の時計が 500 ms 後ろへ飛んだ (読み出しの壁時計は実時間どおりに進む)
  const stepMicros = 500_000;
  for (let index = 100; index < 125; index++) {
    recordFrame(clock, index, index * FRAME_MICROS - stepMicros, MIN_READ_DELAY_MICROS);
  }
  // 直近の 0.5 秒の窓にまだ古い観測が残っている間は取り直さない
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);

  // 直近の 0.5 秒 (25 フレーム) が段差後の観測だけになると取り直す
  recordFrame(clock, 125, 125 * FRAME_MICROS - stepMicros, MIN_READ_DELAY_MICROS);
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + stepMicros + MIN_READ_DELAY_MICROS);
});

// 音声の時計が前に飛ぶ段差 (床が下がる) は、待たずに即座へ合わせる。TIMESTAMP が実際より
// 新しくなると、受信側は音声を「まだ鳴らす時刻ではない」と扱い、再生が遅れる
test("apply: 音声の時計が前に飛ぶ段差は即座に合わせる", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 100; index++) {
    recordSteadyFrame(clock, index);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);

  // 音声の時計が 500 ms 前に飛んだ (ずれが 500 ms 減った)
  recordFrame(clock, 100, 100 * FRAME_MICROS + 500_000, MIN_READ_DELAY_MICROS);
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS - 500_000 + MIN_READ_DELAY_MICROS);
});

// 読み出しの遅れが 200 ms 未満ぶれても、段差とはみなさない。段差として取り直すと
// TIMESTAMP が実際より新しくなり、受信側の基準が動く
test("apply: 読み出しの遅れのぶれでは補正を取り直さない", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 100; index++) {
    recordSteadyFrame(clock, index);
  }
  // 150 ms 遅れて読めたフレームが 1 秒続く
  for (let index = 100; index < 150; index++) {
    recordSteadyFrame(clock, index, MIN_READ_DELAY_MICROS + 150_000);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);
  // ぶれが戻っても補正は動かない
  for (let index = 150; index < 200; index++) {
    recordSteadyFrame(clock, index);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);
});

// 一過性の遅れ: 読み出しが 95 ms 遅れた状態が 3 秒続いて戻っても、補正 (送る TIMESTAMP) を
// 動かさない。遅れが 2 秒の窓より長く続くと、窓が遅れで入れ替わって最小値が上がる。それを
// そのまま採用すると送る TIMESTAMP が 95 ms 動き、受信側は時計のずれとみなして基準の共有を
// 30 秒解除する (CI の実リレーテストで起きた)
test("apply: 一過性の読み出しの遅れでは補正を動かさない", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 100; index++) {
    recordSteadyFrame(clock, index);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);

  // 95 ms 遅れて読めたフレームが 3 秒続く (窓の 2 秒より長い)
  for (let index = 100; index < 250; index++) {
    recordSteadyFrame(clock, index, MIN_READ_DELAY_MICROS + 95_000);
  }
  assert.equal(
    appliedOffsetMicros(clock),
    CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS,
    "窓が遅れで入れ替わっても補正を動かさないこと",
  );

  // 遅れが戻った後も動かない
  for (let index = 250; index < 350; index++) {
    recordSteadyFrame(clock, index);
  }
  assert.equal(appliedOffsetMicros(clock), CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS);
  // 送る TIMESTAMP は「撮った時刻 + 最小の遅れ」のままである
  assert.equal(
    clock.apply(300 * FRAME_MICROS),
    BigInt(EPOCH_MICROS + 300 * FRAME_MICROS + CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS),
  );
});

// 読み出しの遅れが定着した場合 (機械が遅くなった、読み出しの経路が変わった) は、待った後で
// その水準へ合わせる。合わせないと、送る TIMESTAMP が実際より古いままになり、受信側の
// 基準の遅れがその分だけ伸びる (0754 の症状)
test("apply: 読み出しの遅れが定着したら補正を合わせる", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 100; index++) {
    recordSteadyFrame(clock, index);
  }
  // 95 ms 遅れて読める状態が 8 秒続く
  for (let index = 100; index < 500; index++) {
    recordSteadyFrame(clock, index, MIN_READ_DELAY_MICROS + 95_000);
  }
  assert.equal(
    appliedOffsetMicros(clock),
    CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS + 95_000,
    "遅れが定着したら補正をその水準へ合わせること",
  );
});

// 統計は「一定か、ドリフトか、段差か」を実機で読み分けるための値である。現在値・最小・
// 最大は生の観測 (補正を当てる前) を出し、傾きは 10 秒と 60 秒の窓で出す
test("snapshot: 現在値・最小・最大と 10 秒 / 60 秒の傾きを出す", () => {
  const clock = new AudioTimestampClock();
  const driftPerFrameMicros = 1_000;
  const frames = 1_000;
  for (let index = 0; index < frames; index++) {
    recordFrame(
      clock,
      index,
      index * FRAME_MICROS - index * driftPerFrameMicros,
      MIN_READ_DELAY_MICROS,
    );
  }

  const stats = clock.snapshot();
  assert.isNotNull(stats);
  const current = CLOCK_LAG_MICROS + (frames - 1) * driftPerFrameMicros + MIN_READ_DELAY_MICROS;
  assert.closeTo((stats?.currentMs ?? 0) - EPOCH_MICROS / 1_000, current / 1_000, 0.001);
  assert.closeTo(
    (stats?.minMs ?? 0) - EPOCH_MICROS / 1_000,
    (CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS) / 1_000,
    0.001,
  );
  assert.closeTo((stats?.maxMs ?? 0) - EPOCH_MICROS / 1_000, current / 1_000, 0.001);
  // 50 ms / 秒 のドリフトを、10 秒と 60 秒のどちらの窓でも読み取れる
  assert.closeTo(stats?.slope10sMsPerSecond ?? 0, 50, 0.1);
  assert.closeTo(stats?.slope60sMsPerSecond ?? 0, 50, 0.1);
  // 補正は窓の分だけ古い床を指す
  assert.closeTo(
    (stats?.appliedMs ?? 0) - EPOCH_MICROS / 1_000,
    appliedOffsetMicros(clock) / 1_000,
    0.001,
  );
  assert.equal(stats?.samples, frames);
});

// 一定のずれでは傾きは 0 になる (ドリフトと読み分けられる)
test("snapshot: 一定のずれでは傾きが 0 になる", () => {
  const clock = new AudioTimestampClock();
  for (let index = 0; index < 600; index++) {
    recordSteadyFrame(clock, index, MIN_READ_DELAY_MICROS + (index % 3) * 1_000);
  }
  const stats = clock.snapshot();
  assert.closeTo(stats?.slope10sMsPerSecond ?? 1, 0, 0.1);
  assert.closeTo(stats?.slope60sMsPerSecond ?? 1, 0, 0.1);
});

// 観測が窓 (60 秒) より短いうちは、傾きを出すだけの幅が無い
test("snapshot: 窓が埋まる前でも現在値と最小・最大は出す", () => {
  const clock = new AudioTimestampClock();
  recordSteadyFrame(clock, 0);
  const stats = clock.snapshot();
  assert.isNotNull(stats);
  assert.closeTo(
    (stats?.currentMs ?? 0) - EPOCH_MICROS / 1_000,
    (CLOCK_LAG_MICROS + MIN_READ_DELAY_MICROS) / 1_000,
    0.001,
  );
  assert.isNull(stats?.slope60sMsPerSecond);
});

// 配信をやり直したら、前の配信の観測と補正を持ち越さない
test("reset: 観測と補正を消す", () => {
  const clock = new AudioTimestampClock();
  recordSteadyFrame(clock, 0);
  assert.isNotNull(clock.snapshot());
  clock.reset();
  assert.isNull(clock.snapshot());
  assert.isNull(clock.apply(0));
});
