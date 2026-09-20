/** ダミー音声のトーン周波数 (Hz)。無音だと復号結果が無音でも気付けないため可聴のトーンにする */
export const TONE_FREQUENCY_HZ = 440;

/**
 * 振幅のエンベロープ周期 (秒)
 *
 * 振幅を一定にすると符号化後の値も一定になり、経路が途中で止まっても気付きにくい。
 * ゆっくり変化させることで、受信側のレベル表示が時間とともに動く。
 * AudioBuffer の長さもこの値に合わせ、ループの継ぎ目で振幅が飛ばないようにする。
 */
export const TONE_ENVELOPE_PERIOD_SECONDS = 2;

/** トーンの最小振幅 */
const TONE_MIN_AMPLITUDE = 0.2;

/** トーンの振幅の振れ幅 (最小振幅から最大振幅までの幅) */
const TONE_AMPLITUDE_SWING = 0.1;

/**
 * RFC 6464 §3 のデジタル無音
 *
 * 同節は「デジタル無音の audio level は符号化形式のダイナミックレンジに関わらず
 * 127 (-127 dBov) としなければならない (MUST)」と定める。
 */
export const AUDIO_LEVEL_SILENCE = 127;

/** voiceActivity とみなすピーク振幅のしきい値 */
const VOICE_ACTIVITY_PEAK_THRESHOLD = 0.05;

export interface DummyAudioGenerator {
  stream: MediaStream;
  stop: () => void;
}

/** トーンから求めた LOC Audio Level (draft-ietf-moq-loc-04 §2.3.3.2) */
export interface ToneAudioLevel {
  /** -dBov (0 が最大、127 がデジタル無音) */
  level: number;
  /** 音声アクティビティの有無 (RFC 6464 §3 の V ビットに対応する) */
  voiceActivity: boolean;
}

/**
 * トーンのサンプル列を作る純関数
 *
 * 生成したサンプル列をそのまま `AudioBuffer` に載せて鳴らすため、単体テストが守る値と
 * 実際に符号化される値が一致する。Node 環境でも動くよう、ブラウザ API は使わない。
 *
 * 並びは f32-planar (チャンネルごとに連続) とし、`AudioBuffer.copyToChannel` へ
 * そのまま渡せるようにする。
 *
 * @param sampleRate - サンプルレート (Hz)
 * @param channels - チャンネル数
 * @param frameCount - 生成するフレーム数 (1 フレーム = 全チャンネル 1 サンプルずつ)
 * @param startFrame - 生成を始める絶対フレーム位置。連続したサンプル列を作るときに使う
 */
export function createToneSamples(
  sampleRate: number,
  channels: number,
  frameCount: number,
  startFrame = 0,
): Float32Array {
  const samples = new Float32Array(frameCount * channels);
  const envelopePeriodFrames = sampleRate * TONE_ENVELOPE_PERIOD_SECONDS;
  const angularFrequency = (2 * Math.PI * TONE_FREQUENCY_HZ) / sampleRate;
  const envelopeStep = (2 * Math.PI) / envelopePeriodFrames;

  for (let frame = 0; frame < frameCount; frame++) {
    const absoluteFrame = startFrame + frame;
    // 振幅は TONE_MIN_AMPLITUDE 〜 TONE_MIN_AMPLITUDE + TONE_AMPLITUDE_SWING の間で
    // ゆっくり変化させる (最小値に振れ幅の半分を足した正弦波)
    const envelope =
      TONE_MIN_AMPLITUDE +
      (TONE_AMPLITUDE_SWING / 2) * (1 + Math.sin(envelopeStep * absoluteFrame));
    const value = envelope * Math.sin(angularFrequency * absoluteFrame);
    for (let channel = 0; channel < channels; channel++) {
      samples[channel * frameCount + frame] = value;
    }
  }

  return samples;
}

/**
 * トーンのサンプル列から LOC Audio Level を求める純関数
 *
 * RFC 6464 §3 は audio level を「ペイロードが符号化するサンプルの RMS」で測り、
 * -dBov で 0〜127 (0 が最大、127 がデジタル無音) と定める。voiceActivity の判定方法は
 * 同節で実装依存とされているため、ダミー音声ではピーク振幅のしきい値で決める。
 *
 * @param samples - RMS を求めるサンプル列 (createToneSamples の出力)
 */
export function summarizeToneLevel(samples: Float32Array): ToneAudioLevel {
  if (samples.length === 0) {
    // サンプルが無い場合は測定不能のため無音として扱う (NaN を wire に載せない)
    return { level: AUDIO_LEVEL_SILENCE, voiceActivity: false };
  }

  let sumOfSquares = 0;
  let peak = 0;
  for (const value of samples) {
    sumOfSquares += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  const rms = Math.sqrt(sumOfSquares / samples.length);
  // 無音 (rms 0) と、NaN / Infinity を含む異常な入力は測定不能として無音に丸める
  // (NaN を wire に載せない)
  if (!Number.isFinite(rms) || rms === 0) {
    return { level: AUDIO_LEVEL_SILENCE, voiceActivity: false };
  }

  const dbov = -20 * Math.log10(rms);
  const level = Math.min(AUDIO_LEVEL_SILENCE, Math.max(0, Math.round(dbov)));
  return { level, voiceActivity: peak >= VOICE_ACTIVITY_PEAK_THRESHOLD };
}

/**
 * ダミー音声の `MediaStream` を作る
 *
 * 440 Hz のトーンを `AudioBuffer` に載せ、`AudioBufferSourceNode` で鳴らして
 * `MediaStreamAudioDestinationNode` のトラックを得る。`OscillatorNode` を使わないのは、
 * 単体テストで固定できる純関数 (createToneSamples) を実際の信号経路そのものにするため。
 *
 * 利用側は `stop()` を呼び、`AudioContext` と音源を止める。
 */
export function createDummyAudioStream(sampleRate: number, channels: number): DummyAudioGenerator {
  const context = new AudioContext({ sampleRate });

  // 自動再生ポリシーで suspended のまま作られることがある。呼び出し元は
  // クリック操作の中から呼ぶため、ここで resume しても policy には抵触しない
  if (context.state === "suspended") {
    void context.resume().catch(() => {
      // resume できない環境 (自動再生ポリシー) では無音のまま流れる
    });
  }

  const frameCount = sampleRate * TONE_ENVELOPE_PERIOD_SECONDS;
  const samples = createToneSamples(sampleRate, channels, frameCount);
  const buffer = context.createBuffer(channels, frameCount, sampleRate);
  for (let channel = 0; channel < channels; channel++) {
    const offset = channel * frameCount;
    // copyToChannel は ArrayBuffer 裏付けの Float32Array を要求するため、
    // subarray をそのまま渡さず新しい配列へ写す
    const channelData = new Float32Array(frameCount);
    channelData.set(samples.subarray(offset, offset + frameCount));
    buffer.copyToChannel(channelData, channel);
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const destination = context.createMediaStreamDestination();
  // MediaStreamAudioDestinationNode の既定は 2ch で、createBuffer を 1ch で作っても
  // トラックからは 2ch の AudioData が出る。そのまま 1ch の Encoder へ渡すと
  // Chromium は "Input audio buffer is incompatible with codec parameters" で
  // 符号化を止めるため、生成したバッファと同じチャンネル数を明示する
  destination.channelCount = channels;
  destination.channelCountMode = "explicit";
  source.connect(destination);
  source.start();

  return {
    stream: destination.stream,
    stop: (): void => {
      try {
        source.stop();
      } catch {
        // 既に停止済みなら無視する
      }
      source.disconnect();
      void context.close().catch(() => {
        // 既に閉じている場合は無視する
      });
    },
  };
}
