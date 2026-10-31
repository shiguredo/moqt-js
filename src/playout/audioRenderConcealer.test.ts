/** 到着前の見込みではなく、出力した補間と停止を実クラスで検証する。 */
import { test, assert } from "vite-plus/test";
import { AudioRenderConcealer } from "./audioRenderConcealer";

function tone(length: number, offset = 0): Float32Array {
  return Float32Array.from(
    { length },
    (_, index) => Math.sin(((offset + index) * 2 * Math.PI) / 240) * 0.1,
  );
}

test("正常区間では補間を作らず、各サンプルをそのまま出力する", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [{ start: 0, end: 1920 }],
    stopFrame: 1920,
  });
  const input = tone(1920),
    output = new Float32Array(1920);
  renderer.process([input], [output], 0);
  assert.deepEqual(output.subarray(96, 1824), input.subarray(96, 1824));
  assert.equal(renderer.concealedFrames, 0);
  assert.equal(renderer.concealments, 0, "正常到着では補間の解析や生成へ入らないこと");
});

test("出力した欠落だけを数え、停止を繰り返しても予測音を再開しない", () => {
  const renderer = new AudioRenderConcealer(48000, { ranges: [{ start: 0, end: 1440 }] });
  renderer.process([tone(1440)], [new Float32Array(1440)], 0);
  renderer.process([], [new Float32Array(960)], 1440);
  assert.equal(renderer.concealedFrames, 960);
  assert.equal(renderer.concealments, 1);
  renderer.control({ type: "stop", frame: 2400 });
  renderer.control({ type: "stop", frame: 2880 });
  const stopped = new Float32Array(480);
  renderer.process([], [stopped], 2400);
  assert.isTrue(
    stopped.every((value) => value === 0),
    "停止位置を後から延長しないこと",
  );
});

test("reset 後は古い声を補間せず、次の実音まで無音にする", () => {
  const renderer = new AudioRenderConcealer(48000, { ranges: [{ start: 0, end: 1440 }] });
  renderer.process([tone(1440)], [new Float32Array(1440)], 0);
  renderer.control({ type: "reset" });
  const output = new Float32Array(1920);
  renderer.process([], [output], 1440);
  assert.isTrue(output.every((value) => value === 0));
  assert.equal(renderer.concealedFrames, 0);
});

test("チャンネル形式の変更は欠落に数えず、後続の実音へ接続する", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [
      { start: 0, end: 4800, channels: 2 },
      { start: 4800, end: 9600, channels: 1 },
    ],
    stopFrame: 9600,
  });
  renderer.process(
    [new Float32Array(4800).fill(0.2), new Float32Array(4800).fill(-0.2)],
    [new Float32Array(4800), new Float32Array(4800)],
    0,
  );
  const output = [new Float32Array(4800), new Float32Array(4800)];
  renderer.process(
    [new Float32Array(4800).fill(0.1), new Float32Array(4800).fill(0.1)],
    output,
    4800,
  );
  assert.closeTo(output[0]?.[960] ?? 0, 0.1, 1e-6);
  assert.closeTo(output[1]?.[960] ?? 0, 0.1, 1e-6);
  assert.equal(renderer.concealments, 0);
  assert.equal(renderer.concealedFrames, 0);
});

test("報告時計が一量子遅れても、実入力のサンプル位置を後退させない", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [
      { start: 0, end: 64 },
      { start: 64, end: 384 },
    ],
  });
  renderer.process([tone(128)], [new Float32Array(128)], 0);
  const second = new Float32Array(128);
  renderer.process([tone(128, 128)], [second], 0);
  assert.deepEqual(second, tone(128, 128), "入力は次の量子なので、古い出力を繰り返さないこと");
  assert.equal(renderer.concealments, 0, "正常区間を欠落へ変えないこと");
  const next = new Float32Array(128);
  renderer.process([tone(128, 256)], [next], 256);
  assert.deepEqual(next, tone(128, 256), "報告時計が追いついた後も実音を変更しないこと");
});
