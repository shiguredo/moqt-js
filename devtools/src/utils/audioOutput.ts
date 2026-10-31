/**
 * 音声出力デバイスの一覧
 *
 * 再生先は AudioContext.setSinkId で選ぶ。
 * https://webaudio.github.io/web-audio-api/#dom-audiocontext-setsinkid
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
 * Context の再生先を選ぶ。deviceId が空のときはブラウザの既定に戻す。
 * 未対応のブラウザでは既定出力だけを許可し、選択した機器を黙って無視しない。
 */
export async function applyAudioOutputSink(context: AudioContext, deviceId: string): Promise<void> {
  // Web Audio API 1.1 の追加機能は DOM の型定義にまだ無いため、実ブラウザで存在を調べる。
  const output = context as AudioContext & {
    readonly sinkId?: string | { readonly type: string };
    setSinkId?: (id: string) => Promise<void>;
  };
  if (typeof output.setSinkId !== "function") {
    if (deviceId !== "") throw new Error("AudioContext output device selection is unavailable");
    return;
  }
  // 生成時点の既定出力も含め、選択済みの機器へは切り替え直さない。
  // Chrome は setSinkId 後に明示選択として扱うため、機器一覧が空の環境では
  // 同じ既定出力の再指定だけでも devicechange 後に再生を停止する。
  if (context.state !== "closed" && output.sinkId === deviceId) return;
  await output.setSinkId(deviceId);
}
