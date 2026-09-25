/**
 * マイクから音を取るための getUserMedia の制約と、取れた音の形式
 *
 * マイクでは、サンプルレートとチャンネル数はデバイスが決める。設定の値は ideal として
 * 渡し、実際に取れた値 (`MediaStreamTrack.getSettings()`) を catalog と AudioEncoder に
 * 使う。設定の値を使うと、実際の音と食い違って符号化できない。
 */

/** マイクの取り方の設定 */
export interface MicrophoneOptions {
  // 選んだデバイス。空文字は選んでいない (ブラウザの既定のデバイスを使う)
  deviceId: string;
  sampleRate: number;
  channels: number;
  // ブラウザの音声処理 (エコー除去 / ノイズ抑制 / 自動ゲイン)
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** 音の形式 */
export interface AudioFormat {
  sampleRate: number;
  channels: number;
}

/**
 * getUserMedia の audio の制約を組み立てる
 *
 * デバイスは exact で指定する (ideal だと使えないときに別のデバイスへ黙って切り替わる)。
 * サンプルレートとチャンネル数はデバイスが決めるため ideal で渡す
 */
export function buildMicrophoneConstraints(options: MicrophoneOptions): MediaTrackConstraints {
  return {
    ...(options.deviceId === "" ? {} : { deviceId: { exact: options.deviceId } }),
    sampleRate: { ideal: options.sampleRate },
    channelCount: { ideal: options.channels },
    echoCancellation: options.echoCancellation,
    noiseSuppression: options.noiseSuppression,
    autoGainControl: options.autoGainControl,
  };
}

/**
 * 取れた音のサンプルレートとチャンネル数を決める
 *
 * ブラウザが値を返さない項目は、要求した値を使う
 */
export function resolveCapturedAudioFormat(
  trackSettings: Pick<MediaTrackSettings, "sampleRate" | "channelCount">,
  requested: AudioFormat,
): AudioFormat {
  return {
    sampleRate: trackSettings.sampleRate ?? requested.sampleRate,
    channels: trackSettings.channelCount ?? requested.channels,
  };
}
