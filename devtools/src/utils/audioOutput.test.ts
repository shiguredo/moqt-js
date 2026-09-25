/**
 * toAudioOutputDevices のテスト
 *
 * 再生先の一覧は audiooutput だけにする。空の deviceId はブラウザの既定なので
 * 画面の Default に任せ、一覧へは入れない。
 */

import { assert, test } from "vite-plus/test";
import { toAudioOutputDevices } from "./audioOutput";

test("toAudioOutputDevices: 音声出力だけを取り、空の deviceId は除く", () => {
  const listed = toAudioOutputDevices([
    { kind: "audioinput", deviceId: "mic", label: "Mic" },
    { kind: "audiooutput", deviceId: "", label: "Default" },
    { kind: "audiooutput", deviceId: "spk", label: "Headphones" },
    { kind: "videoinput", deviceId: "cam", label: "Camera" },
    { kind: "audiooutput", deviceId: "hdmi-out", label: "" },
  ]);

  assert.deepEqual(listed, [
    { deviceId: "spk", label: "Headphones" },
    // ラベルが無いときは deviceId の先頭で区別する
    { deviceId: "hdmi-out", label: "Output hdmi-out" },
  ]);
});

test("toAudioOutputDevices: 出力が無ければ空", () => {
  assert.deepEqual(
    toAudioOutputDevices([{ kind: "audioinput", deviceId: "mic", label: "Mic" }]),
    [],
  );
});
