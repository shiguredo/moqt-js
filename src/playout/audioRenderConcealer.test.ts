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
    stopped.subarray(renderer.fadeFrames).every((value) => value === 0),
    "停止が届くまでに出した音の短いフェードだけで終了すること",
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

test("停止の制御が出力より遅れても、途中の予測音を段差で切らない", () => {
  const renderer = new AudioRenderConcealer(48000, { ranges: [{ start: 0, end: 120 }] });
  const first = new Float32Array(128);
  renderer.process([new Float32Array(128).fill(0.3)], [first], 0);
  // 実音は既に終わり、予測音を出力中に過去の停止時刻が届いた場合を固定する。
  renderer.control({ type: "stop", frame: 120 });
  const tail = new Float32Array(256);
  renderer.process([], [tail], 128);
  let previous = first.at(-1) ?? 0;
  for (const value of tail) {
    assert.isBelow(Math.abs(value - previous), 0.006, "停止通知の遅れでクリックを作らないこと");
    previous = value;
  }
  assert.isTrue(
    tail.subarray(96).every((value) => value === 0),
    "停止後は短いフェードだけで終了すること",
  );
  renderer.control({ type: "stop", frame: 120 });
  const after = new Float32Array(128);
  renderer.process([], [after], 384);
  assert.isTrue(
    after.every((value) => value === 0),
    "停止の再通知で音を再開しないこと",
  );
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

test("非周期音の欠落開始で、予測の励振をクリックとして出さない", () => {
  let state = 731;
  let previous = 0;
  const input = Float32Array.from({ length: 1440 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    previous = previous * 0.98 + (state / 0xffffffff - 0.5) * 0.01;
    return previous;
  });
  const renderer = new AudioRenderConcealer(48000, { ranges: [{ start: 0, end: input.length }] });
  const real = new Float32Array(input.length);
  renderer.process([input], [real], 0);
  const continuation = new Float32Array(128);
  renderer.process([], [continuation], input.length);
  let naturalStep = 0;
  for (let index = 1; index < input.length; index++)
    naturalStep = Math.max(naturalStep, Math.abs((input[index] ?? 0) - (input[index - 1] ?? 0)));
  assert.isAtMost(
    Math.abs((continuation[0] ?? 0) - (real.at(-1) ?? 0)),
    naturalStep,
    "入力の最大変化幅を超える予測開始の段差を接続すること",
  );
});

test("復帰フェードの途中で再度欠落しても、描画済みの音から補間を始める", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [
      { start: 0, end: 1440 },
      { start: 1488, end: 1512 },
    ],
  });
  renderer.process([new Float32Array(1440).fill(0.3)], [new Float32Array(1440)], 0);
  renderer.process([], [new Float32Array(48)], 1440);
  const resumed = new Float32Array(24);
  renderer.process([new Float32Array(24).fill(-0.3)], [resumed], 1488);
  const continuation = new Float32Array(128);
  renderer.process([], [continuation], 1512);
  assert.isBelow(
    Math.abs((continuation[0] ?? 0) - (resumed.at(-1) ?? 0)),
    0.01,
    "直前の描画値を未加工の PCM へ跳ばさないこと",
  );
});

test("欠落補間中に出力がステレオへ広がっても、既に鳴っている予測音を切らない", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [{ start: 0, end: 1440, channels: 1 }],
  });
  renderer.process([new Float32Array(1440).fill(0.3)], [new Float32Array(1440)], 0);
  const mono = new Float32Array(128);
  renderer.process([], [mono], 1440);
  const stereo = [new Float32Array(128), new Float32Array(128)];
  // 後続のステレオを先行予約すると、実音の開始前に Worklet の出力幅が変わる。
  // 欠落が続いている間も、モノラルの予測を両側へ同じレベルで引き継ぐ必要がある。
  renderer.process([], stereo, 1568);
  assert.isAbove(stereo[0]?.[0] ?? 0, 0.28, "チャンネルの増加で補間を無音へ落とさないこと");
  assert.closeTo(stereo[0]?.[0] ?? 0, mono.at(-1) ?? 0, 0.001, "描画済みの末尾から接続すること");
  assert.deepEqual(stereo[0], stereo[1], "モノラルの定位とレベルを保つこと");
});

test("停止のフェード中に出力が広がっても、描画した値からの減衰を引き継ぐ", () => {
  const renderer = new AudioRenderConcealer(48000, {
    ranges: [{ start: 0, end: 1440, channels: 1 }],
  });
  renderer.process([new Float32Array(1440).fill(0.3)], [new Float32Array(1440)], 0);
  renderer.control({ type: "stop", frame: 1440 });
  const mono = new Float32Array(32);
  renderer.process([], [mono], 1440);
  const stereo = [new Float32Array(128), new Float32Array(128)];
  renderer.process([], stereo, 1472);
  assert.closeTo(stereo[0]?.[0] ?? 0, mono.at(-1) ?? 0, 0.004, "停止の途中で値を捨てないこと");
  assert.deepEqual(stereo[0], stereo[1]);
  assert.isTrue(
    stereo[0]?.subarray(64).every((value) => value === 0),
    "停止を延長しないこと",
  );
});
