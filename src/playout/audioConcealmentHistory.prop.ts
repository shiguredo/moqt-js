/** 履歴は既に届いた連続 PCM の末尾だけを保ち、入力の所有権を奪わない。 */
import { test, assert } from "vite-plus/test";
import { fc } from "@fast-check/vitest";
import {
  AudioConcealmentHistory,
  AUDIO_CONCEALMENT_HISTORY_SECONDS,
} from "./audioConcealmentHistory";

test("連続する入力の末尾をチャンネルごとに保持し、30 ms を超えない", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(8000, 16000, 44100, 48000),
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
        minLength: 1,
        maxLength: 2000,
      }),
      fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
        minLength: 1,
        maxLength: 2000,
      }),
      (sampleRate, channelCount, first, second) => {
        const history = new AudioConcealmentHistory();
        const channels = (values: number[]) =>
          Array.from({ length: channelCount }, () => Float32Array.from(values));
        const firstChannels = channels(first);
        const secondChannels = channels(second);
        history.append(firstChannels, sampleRate, 0);
        history.append(secondChannels, sampleRate, (first.length / sampleRate) * 1000000);
        const expected = Float32Array.from([...first, ...second]).slice(
          -Math.round(sampleRate * AUDIO_CONCEALMENT_HISTORY_SECONDS),
        );
        for (const channel of history.channels) assert.deepEqual(channel, expected);
        assert.equal(history.channels.length, channelCount);
        // 呼び出し元が入力を再利用しても、保持中の材料は変わらない。
        firstChannels.forEach((channel) => channel.fill(0));
        secondChannels.forEach((channel) => channel.fill(0));
        for (const channel of history.channels) assert.deepEqual(channel, expected);
      },
    ),
  );
});

test("媒体の欠落、時刻の逆行、形式変更では以前の音を繋がない", () => {
  for (const change of ["gap", "backward", "rate", "channels"] as const) {
    const history = new AudioConcealmentHistory();
    history.append([new Float32Array(960).fill(0.1)], 48000, 0);
    const rate = change === "rate" ? 44100 : 48000;
    const channels = Array.from({ length: change === "channels" ? 2 : 1 }, () =>
      new Float32Array(rate / 50).fill(0.2),
    );
    const timestamp = change === "gap" ? 40000 : change === "backward" ? 0 : 20000;
    history.append(channels, rate, timestamp);
    assert.deepEqual(history.channels, channels, `${change} の前後を連結しないこと`);
    history.clear();
    assert.deepEqual(history.channels, [], "出力の再開時に旧履歴を残さないこと");
  }
});
