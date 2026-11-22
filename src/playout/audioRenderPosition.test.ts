import { assert, test } from "vite-plus/test";
import { AUDIO_EXPANSION_SECONDS } from "./audioExpansion";
import { AudioRenderConcealer, audioRenderRangeOf } from "./audioRenderConcealer";
import { AudioRenderQueue, type AudioRenderBlock } from "./audioRenderQueue";

const OUTPUT_RATE = 48_000;
const MICROS_PER_FRAME = 1_000_000 / OUTPUT_RATE;
const MEDIA_START = 1_000_000;
const EPOCH = 7;

function sound(
  start: number,
  frames: number,
  presentation: AudioRenderBlock["presentation"],
  sampleRate = OUTPUT_RATE,
): AudioRenderBlock {
  return {
    start,
    sampleRate,
    channels: [
      Float32Array.from(
        { length: frames },
        (_, index) => Math.sin((index * 2 * Math.PI * 200) / sampleRate) * 0.1,
      ),
    ],
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function media(timestampMicroseconds: number, unmodified = true, epoch = EPOCH) {
  return { epoch, timestampMicroseconds, targetPerformanceMs: 0, unmodified };
}

/** 本番と同じ描画キュー、範囲変換、補間器を結び、実際に描画した出力だけを観測する。 */
function createRenderer() {
  const queue = new AudioRenderQueue(OUTPUT_RATE);
  const concealer = new AudioRenderConcealer(OUTPUT_RATE, { trackPositions: true });
  return {
    concealer,
    enqueue(block: AudioRenderBlock): void {
      queue.enqueue(block);
      concealer.control(audioRenderRangeOf(block, OUTPUT_RATE));
    },
    render(firstFrame: number, frames: number): Float32Array {
      const input = new Float32Array(frames);
      const output = new Float32Array(frames);
      queue.process([input], firstFrame);
      concealer.process([input], [output], firstFrame);
      return output;
    },
    reset(): void {
      queue.clear();
      concealer.control({ type: "reset" });
    },
  };
}

test("端数開始とレート変換を保ち、実音と予測音を描画量子をまたいでまとめる", () => {
  const renderer = createRenderer();
  // 24 kHz の 1,200 サンプルは、48 kHz では端数の開始位置から 2,400 サンプルを占める。
  const start = 120.25;
  const end = 2521;
  renderer.enqueue(sound(start, 1200, media(MEDIA_START), 24_000));
  renderer.render(0, 128);
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [],
    "先行予約と開始フェードは位置にしないこと",
  );
  renderer.render(128, 1024);
  renderer.render(1152, end - 1152 + 128);
  renderer.render(end + 128, 128);
  // 先頭 96 サンプルのフェードを除き、整数境界は半開で媒体時刻には端数分も反映する。
  const first = 121 + renderer.concealer.fadeFrames;
  assert.deepEqual(renderer.concealer.takePositions(), [
    {
      epoch: EPOCH,
      firstFrame: first,
      endFrame: end,
      timestampMicroseconds: MEDIA_START + (first - start) * MICROS_PER_FRAME,
      kind: "real",
    },
    {
      epoch: EPOCH,
      firstFrame: end,
      endFrame: end + 256,
      timestampMicroseconds: MEDIA_START + (end - start) * MICROS_PER_FRAME,
      kind: "concealed",
    },
  ]);
  renderer.render(end + 256, 128);
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [
      {
        epoch: EPOCH,
        firstFrame: end + 256,
        endFrame: end + 384,
        timestampMicroseconds: MEDIA_START + (end + 256 - start) * MICROS_PER_FRAME,
        kind: "concealed",
      },
    ],
    "報告を取り出しても連続する補間の基準は残すこと",
  );
});

test("補間の上限で位置を失い、復帰の混合を終えた後は実音の時刻を使う", () => {
  const renderer = createRenderer();
  renderer.enqueue(sound(0, 1440, media(MEDIA_START)));
  renderer.render(0, 1440);
  renderer.concealer.takePositions();
  const predictedFrames = Math.round(AUDIO_EXPANSION_SECONDS * OUTPUT_RATE);
  const nextStart = 1440 + predictedFrames + 128;
  renderer.render(1440, predictedFrames + 128);
  assert.equal(renderer.concealer.uncoveredFrames, 128);
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [
      {
        epoch: EPOCH,
        firstFrame: 1440,
        endFrame: 1440 + predictedFrames,
        timestampMicroseconds: MEDIA_START + 30_000,
        kind: "concealed",
      },
    ],
    "予測音の末尾までを含め、予測を使い切った後の無音は含めないこと",
  );

  // 復帰する媒体時刻は補間の外挿とは一致しない値を使う。
  const resumedMedia = MEDIA_START + 190_000;
  renderer.enqueue(sound(nextStart, 480, media(resumedMedia)));
  renderer.render(nextStart, 480);
  const fadeFrames = renderer.concealer.fadeFrames;
  assert.deepEqual(renderer.concealer.takePositions(), [
    {
      epoch: EPOCH,
      firstFrame: nextStart + fadeFrames,
      endFrame: nextStart + 480,
      timestampMicroseconds: resumedMedia + fadeFrames * MICROS_PER_FRAME,
      kind: "real",
    },
  ]);
});

for (const presentation of [media(MEDIA_START + 30_000, false), undefined]) {
  const reason = presentation === undefined ? "時刻のない" : "伸縮した";
  test(`${reason}実音と、それに続く補間へ古い媒体時刻を割り当てない`, () => {
    const renderer = createRenderer();
    renderer.enqueue(sound(0, 1440, media(MEDIA_START)));
    renderer.enqueue(sound(1440, 1440, presentation));
    renderer.render(0, 1440);
    assert.lengthOf(renderer.concealer.takePositions(), 1);
    renderer.render(1440, 1440 + 128);
    assert.equal(renderer.concealer.concealedFrames, 128, "補間音自体は従来どおり出力すること");
    assert.deepEqual(renderer.concealer.takePositions(), []);
  });
}

test("履歴不足時の短い音つなぎを媒体位置の推定に使わない", () => {
  const renderer = createRenderer();
  // 実音の一部はフェードの外だが、予測器の最低 10 ms の履歴には足りない。
  renderer.enqueue(sound(0, 192, media(MEDIA_START)));
  renderer.render(0, 192);
  assert.lengthOf(renderer.concealer.takePositions(), 1);
  const output = renderer.render(192, 128);
  assert.isTrue(
    output.some((value) => value !== 0),
    "音つなぎはそのまま出力すること",
  );
  assert.deepEqual(renderer.concealer.takePositions(), []);
});

test("出力時計が飛ぶと古い基準を失い、リセットでは未送信の実績も消す", () => {
  const renderer = createRenderer();
  renderer.enqueue(sound(0, 1440, media(MEDIA_START)));
  renderer.render(0, 1440);
  assert.lengthOf(renderer.concealer.takePositions(), 1);
  const predicted = renderer.render(1448, 128);
  assert.isTrue(
    predicted.some((value) => value !== 0),
    "時計が飛んでも従来の予測音を変えないこと",
  );
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [],
    "描画していない 8 サンプルを越えないこと",
  );

  renderer.enqueue(sound(1576, 480, media(MEDIA_START + 40_000, true, EPOCH + 1)));
  renderer.render(1576, 480);
  renderer.reset();
  renderer.render(2056, 128);
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [],
    "リセット前の基準と未送信区間を捨てること",
  );
});

test("同じ媒体の対応だけをつなげ、TIMESTAMP や世代が変わる境界は残す", () => {
  const renderer = createRenderer();
  renderer.enqueue(sound(0, 480, media(MEDIA_START)));
  renderer.enqueue(sound(480, 480, media(MEDIA_START + 10_000)));
  renderer.enqueue(sound(960, 480, media(MEDIA_START + 30_000)));
  renderer.enqueue(sound(1440, 480, media(MEDIA_START + 40_000, true, EPOCH + 1)));
  renderer.render(0, 1920);
  const fadeFrames = renderer.concealer.fadeFrames;
  assert.deepEqual(renderer.concealer.takePositions(), [
    {
      epoch: EPOCH,
      firstFrame: fadeFrames,
      endFrame: 960,
      timestampMicroseconds: MEDIA_START + fadeFrames * MICROS_PER_FRAME,
      kind: "real",
    },
    {
      epoch: EPOCH,
      firstFrame: 960,
      endFrame: 1440,
      timestampMicroseconds: MEDIA_START + 30_000,
      kind: "real",
    },
    {
      epoch: EPOCH + 1,
      firstFrame: 1440,
      endFrame: 1920,
      timestampMicroseconds: MEDIA_START + 40_000,
      kind: "real",
    },
  ]);
});

test("停止の減衰と停止後のサンプルに媒体位置を割り当てない", () => {
  const renderer = createRenderer();
  renderer.enqueue(sound(0, 1440, media(MEDIA_START)));
  renderer.concealer.control({ type: "stop", frame: 1440 });
  renderer.render(0, 1440 + 128);
  const fadeFrames = renderer.concealer.fadeFrames;
  assert.deepEqual(
    renderer.concealer.takePositions(),
    [
      {
        epoch: EPOCH,
        firstFrame: fadeFrames,
        endFrame: 1440 - fadeFrames + 1,
        timestampMicroseconds: MEDIA_START + fadeFrames * MICROS_PER_FRAME,
        kind: "real",
      },
    ],
    "停止ゲインが 1 未満になった位置から未観測にすること",
  );
});
