/**
 * 音声出力デバイスの一覧
 *
 * 再生先は HTMLMediaElement.setSinkId で選ぶ。
 * https://w3c.github.io/mediacapture-output/#dom-htmlmediaelement-setsinkid
 * (この API は将来変わる可能性がある)
 *
 * deviceId が空の出力はブラウザの既定であり、画面の Default で表す。一覧には入れない。
 */

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

/** enumerateDevices の結果から音声出力だけを取り出す */
export function toAudioOutputDevices(
  devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>,
): AudioOutputDevice[] {
  const outputs: AudioOutputDevice[] = [];
  for (const device of devices) {
    if (device.kind !== "audiooutput" || device.deviceId === "") {
      continue;
    }
    outputs.push({
      deviceId: device.deviceId,
      label: device.label !== "" ? device.label : `Output ${device.deviceId.substring(0, 8)}`,
    });
  }
  return outputs;
}

/**
 * `<audio>` の再生先を選ぶ。deviceId が空のときはブラウザの既定に戻す。
 * setSinkId が無いブラウザでは何もしない。
 */
export async function applyAudioOutputSink(
  audio: HTMLMediaElement,
  deviceId: string,
): Promise<void> {
  if (typeof audio.setSinkId !== "function") {
    return;
  }
  await audio.setSinkId(deviceId);
}
