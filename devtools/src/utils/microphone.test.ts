/**
 * マイクの getUserMedia の制約と、取れた音の形式の単体テスト
 *
 * 入力の組み合わせは有限 (デバイスの指定の有無と 3 つの音声処理) なので、代表の値で固定する。
 */

import { test, assert } from "vite-plus/test";
import { buildMicrophoneConstraints, resolveCapturedAudioFormat } from "./microphone";

// デバイスは exact で指定する (ideal だと別のデバイスへ黙って切り替わる)。サンプルレートと
// チャンネル数はデバイスが決めるため ideal で渡す。音声処理は設定の値をそのまま渡す
test("buildMicrophoneConstraints: デバイスを exact、形式を ideal、音声処理を設定の値で渡す", () => {
  assert.deepEqual(
    buildMicrophoneConstraints({
      deviceId: "mic-1",
      sampleRate: 48_000,
      channels: 2,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    }),
    {
      deviceId: { exact: "mic-1" },
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    },
  );
});

// デバイスの一覧を取る前 (選んでいない) は、ブラウザの既定のデバイスを使う
test("buildMicrophoneConstraints: デバイスを選んでいなければ deviceId を載せない", () => {
  const constraints = buildMicrophoneConstraints({
    deviceId: "",
    sampleRate: 48_000,
    channels: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  assert.notProperty(constraints, "deviceId");
  assert.deepEqual(constraints.channelCount, { ideal: 1 });
});

// 実際に取れたサンプルレートとチャンネル数を catalog と AudioEncoder に使う。
// 設定の値を使うと、実際の音と食い違って符号化できない
test("resolveCapturedAudioFormat: 取れた音のサンプルレートとチャンネル数を使う", () => {
  assert.deepEqual(
    resolveCapturedAudioFormat(
      { sampleRate: 44_100, channelCount: 1 },
      { sampleRate: 48_000, channels: 2 },
    ),
    { sampleRate: 44_100, channels: 1 },
  );
});

// ブラウザが値を返さない項目は、要求した値 (設定の値) を使う
test("resolveCapturedAudioFormat: 取れた音の値が無い項目は要求した値を使う", () => {
  assert.deepEqual(resolveCapturedAudioFormat({}, { sampleRate: 48_000, channels: 2 }), {
    sampleRate: 48_000,
    channels: 2,
  });
  assert.deepEqual(
    resolveCapturedAudioFormat({ channelCount: 1 }, { sampleRate: 48_000, channels: 2 }),
    { sampleRate: 48_000, channels: 1 },
  );
});
