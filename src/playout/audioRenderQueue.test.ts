/** PCM の所有権、欠落、形式変更の境界を実キューで検証する。 */
import { test, assert } from "vite-plus/test";
import { AudioRenderQueue } from "./audioRenderQueue";

test("再生位置の通知は予約時に出さず、実際に描画した先頭だけを出す", () => {
  const queue = new AudioRenderQueue(48000);
  const presented: number[] = [];
  queue.enqueue({
    start: 128.37,
    sampleRate: 48000,
    channels: [new Float32Array(240)],
    presentation: { epoch: 0, timestampMicroseconds: 1000000, targetPerformanceMs: 50 },
  });
  const output = [new Float32Array(128)];
  const record = (block: { start: number }) => presented.push(block.start);
  queue.process(output, 0, record);
  assert.deepEqual(presented, [], "未来の予約を出力実績にしないこと");
  queue.process(output, 128, record);
  queue.process(output, 256, record);
  assert.deepEqual(presented, [128.37], "端数開始も 1 回だけ通知すること");
  queue.clear();
  queue.enqueue({
    start: 400,
    sampleRate: 48000,
    channels: [new Float32Array(240)],
    presentation: { epoch: 0, timestampMicroseconds: 2000000, targetPerformanceMs: 100 },
  });
  queue.process(output, 512, record);
  assert.deepEqual(presented, [128.37], "途中からしか描画できなかった媒体先頭を実績と偽らないこと");
});

for (const [inputRate, outputRate, rejectedHz] of [
  [96000, 48000, 30000],
  [48000, 44100, 23500],
] as const) {
  test(`ダウンサンプリングで通過帯域を保ち帯域外の折り返しを抑える: ${inputRate} → ${outputRate}`, () => {
    for (const frequency of [1000, 20000, outputRate / 2 + 100, rejectedHz]) {
      const queue = new AudioRenderQueue(outputRate);
      const length = inputRate / 10;
      const input = Float32Array.from(
        { length },
        (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / inputRate),
      );
      // サンプル格子からずれた開始と、フレームをまたぐフィルターの履歴も通す。
      for (let offset = 0; offset < length; offset += 127) {
        queue.enqueue({
          start: 0.37 + (offset * outputRate) / inputRate,
          sampleRate: inputRate,
          channels: [input.slice(offset, offset + 127)],
        });
      }
      const output = new Float32Array(outputRate / 10);
      queue.process([output], 0);
      let energy = 0;
      let error = 0;
      for (let index = 100; index < output.length - 100; index++) {
        const value = output[index] ?? 0;
        energy += value * value;
        error = Math.max(
          error,
          Math.abs(value - 0.5 * Math.sin((2 * Math.PI * frequency * (index - 0.37)) / outputRate)),
        );
      }
      if (frequency === 1000) assert.isBelow(error, 1e-4, "通過帯域の音を遅らせず振幅を保つこと");
      else if (frequency === 20000)
        assert.isBelow(error, 0.001, "可聴帯域の上端まで振幅を保つこと");
      else
        assert.isBelow(
          Math.sqrt(energy / (output.length - 200)),
          0.00035,
          "帯域外成分を 60 dB 以上抑えること",
        );
    }
  });
}

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

test("ダウンサンプリングの履歴と先読みは欠落・形式変更・reset を越えない", () => {
  for (const boundary of ["gap", "rate", "channels", "reset"] as const) {
    const queue = new AudioRenderQueue(48000);
    queue.enqueue({ start: 0, sampleRate: 96000, channels: [new Float32Array(256).fill(0.2)] });
    const start = boundary === "gap" ? 256 : 128;
    if (boundary === "reset") {
      queue.process([new Float32Array(128)], 0);
      queue.clear();
    }
    const channels = [new Float32Array(256).fill(-0.4)];
    if (boundary === "channels") channels.push(new Float32Array(256).fill(0.1));
    queue.enqueue({ start, sampleRate: boundary === "rate" ? 88200 : 96000, channels });
    const output = new Float32Array(128);
    queue.process([output], start);
    assert.isTrue(
      output.every((sample) => Math.abs(sample + 0.4) < 1e-7),
      `${boundary} の前後の音を混ぜないこと`,
    );
  }
});

test("次の予約が描画後に届いてもダウンサンプリングの履歴を残す", () => {
  const input = Float32Array.from({ length: 960 }, (_, index) => Math.sin(index * 0.12) * 0.2);
  const continuous = new AudioRenderQueue(48000);
  const incremental = new AudioRenderQueue(48000);
  continuous.enqueue({ start: 0, sampleRate: 96000, channels: [input] });
  incremental.enqueue({ start: 0, sampleRate: 96000, channels: [input.slice(0, 256)] });
  incremental.process([new Float32Array(128)], 0);
  incremental.enqueue({ start: 128, sampleRate: 96000, channels: [input.slice(256)] });
  const expected = new Float32Array(128);
  const actual = new Float32Array(128);
  continuous.process([expected], 128);
  incremental.process([actual], 128);
  // 過去側は再描画しないが、次の量子では既に消費した実サンプルを参照できる。
  for (let index = 0; index < actual.length; index++)
    assert.closeTo(actual[index] ?? 0, expected[index] ?? 0, 1e-7);
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
  // 端点の延長が影響する開始直後を除き、元の連続時間の正弦波と比較する。
  for (let index = 100; index < 6900; index++) {
    const position = ((first + index - (2 ** 30 + 0.37)) * inputRate) / outputRate;
    const expected = Math.sin(position * 0.4) * 0.2;
    maximumError = Math.max(maximumError, Math.abs((output[0]?.[index] ?? 0) - expected));
  }
  assert.isBelow(maximumError, 1e-6, "時刻の引き算の誤差を可聴の境界へ変えないこと");
});
