/** PCM の所有権、欠落、形式変更の境界を実キューで検証する。 */
import { test, assert } from "vite-plus/test";
import { AudioRenderQueue } from "./audioRenderQueue";

test("連続フレームの境界では次の実サンプルを使って補間する", () => {
  const queue = new AudioRenderQueue(48000);
  queue.enqueue({ start: 0, sampleRate: 16000, channels: [new Float32Array([0, 0.1])] });
  queue.enqueue({ start: 6, sampleRate: 16000, channels: [new Float32Array([0.2, 0.3])] });
  const output = [new Float32Array(12)];
  queue.process(output, 0);
  // 2 フレーム目が既に届いているので、境界の手前を端点の引き延ばしへ変えない。
  assert.closeTo(output[0]?.[5] ?? 0, (0.1 * 5) / 3, 1e-7);
  assert.closeTo(output[0]?.[6] ?? 0, 0.2, 1e-7);
});

test("欠落を挟んだフレームから補間用の先読みをしない", () => {
  const queue = new AudioRenderQueue(48000);
  queue.enqueue({ start: 0, sampleRate: 16000, channels: [new Float32Array([0, 0.1])] });
  queue.enqueue({ start: 9, sampleRate: 16000, channels: [new Float32Array([-0.8, -0.9])] });
  const output = [new Float32Array(12)];
  queue.process(output, 0);
  assert.closeTo(output[0]?.[5] ?? 0, 0.1, 1e-7, "未着の次サンプルは最後の実音で延長すること");
  assert.equal(output[0]?.[6], 0, "実音のない区間は後段の補間に委ねること");
});

test("reset で未再生 PCM を解放し、旧世代の音を再生しない", () => {
  const queue = new AudioRenderQueue(48000);
  queue.enqueue({ start: 0, sampleRate: 48000, channels: [new Float32Array(960).fill(0.3)] });
  queue.clear();
  const output = [new Float32Array(128).fill(1)];
  queue.process(output, 0);
  assert.isTrue(output[0]?.every((value) => value === 0));
});

test("モノラルは左右へ同じ値を出し、ステレオは相殺しない", () => {
  const queue = new AudioRenderQueue(48000);
  queue.enqueue({
    start: 0,
    sampleRate: 48000,
    channels: [new Float32Array([0.2]), new Float32Array([-0.2])],
  });
  queue.enqueue({ start: 1, sampleRate: 48000, channels: [new Float32Array([0.1])] });
  const output = [new Float32Array(2), new Float32Array(2)];
  queue.process(output, 0);
  assert.deepEqual(output[0], new Float32Array([0.2, 0.1]));
  assert.deepEqual(output[1], new Float32Array([-0.2, 0.1]));
});

test("5.1 出力ではモノラルを中央、4 チャンネルの後方音を後方へ割り当てる", () => {
  const queue = new AudioRenderQueue(48000);
  queue.enqueue({ start: 0, sampleRate: 48000, channels: [new Float32Array([0.1])] });
  queue.enqueue({
    start: 1,
    sampleRate: 48000,
    channels: [0.1, 0.2, 0.3, 0.4].map((value) => new Float32Array([value])),
  });
  const output = Array.from({ length: 6 }, () => new Float32Array(2));
  queue.process(output, 0);
  assert.deepEqual(
    output.map((channel) => channel[0]),
    Array.from(new Float32Array([0, 0, 0.1, 0, 0, 0])),
  );
  assert.deepEqual(
    output.map((channel) => channel[1]),
    Array.from(new Float32Array([0.1, 0.2, 0, 0, 0.3, 0.4])),
  );
});

test("数時間後の出力時計でも連続フレームの境界を丸め誤差で切らない", () => {
  const outputRate = 44100;
  const inputRate = 48000;
  let startSeconds = (2 ** 30 + 0.37) / outputRate;
  const queue = new AudioRenderQueue(outputRate);
  let offset = 0;
  for (let sequence = 0; sequence < 10; sequence++) {
    const frames = 960 - (sequence % 7) * 13;
    const blockOffset = offset;
    queue.enqueue({
      start: startSeconds * outputRate,
      sampleRate: inputRate,
      channels: [
        Float32Array.from(
          { length: frames },
          (_, index) => Math.sin((blockOffset + index) * 0.4) * 0.2,
        ),
      ],
    });
    offset += frames;
    startSeconds += frames / inputRate;
  }
  const first = Math.ceil(2 ** 30 + 0.37);
  const output = [new Float32Array(7000)];
  queue.process(output, first);
  let maximumError = 0;
  for (let index = 0; index < 6900; index++) {
    const position = ((first + index - (2 ** 30 + 0.37)) * inputRate) / outputRate;
    const before = Math.floor(position);
    const fraction = position - before;
    const expected =
      (1 - fraction) * Math.fround(Math.sin(before * 0.4) * 0.2) +
      fraction * Math.fround(Math.sin((before + 1) * 0.4) * 0.2);
    maximumError = Math.max(maximumError, Math.abs((output[0]?.[index] ?? 0) - expected));
  }
  assert.isBelow(maximumError, 1e-6, "時刻の引き算の誤差を可聴の境界へ変えないこと");
});
