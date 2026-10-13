/**
 * AudioData ソースの抽象化
 *
 * 音声の取り出し方はブラウザで分かれる。
 *
 * - `MediaStreamTrackProcessor` をメインスレッドに公開しているブラウザ (Chromium 系) は、
 *   トラックから直接 `AudioData` を読む
 * - 公開していないブラウザ (Safari / Firefox) は、Web Audio API の `AudioWorklet` で生の
 *   サンプルを取り出し、`AudioData` を組み立てる
 *
 * 2 経路が要るのは、ブラウザの実装が揃っていないためである。
 *
 * - WebKit は `MediaStreamTrackProcessor` を `Exposed=DedicatedWorker` で定義しており、
 *   メインスレッドからは見えない (WebKit の MediaStreamTrackProcessor.idl)。さらに
 *   WebKit の実装は映像トラック専用で、音声トラックを渡すと `TypeError: Track is not video`
 *   を投げる (WebKit の MediaStreamTrackProcessor.cpp)
 * - Worker へ逃げる道も無い。WebKit は `MediaStreamTrack` を Worker へ渡せず
 *   (DataCloneError)、音声の処理を Worker 側へ移せない
 * - Firefox は `MediaStreamTrackProcessor` そのものを実装していない
 *
 * そのため、この 2 つのブラウザでは Web Audio 経由で取り出す。Web Audio 経路のサンプル
 * レートとチャンネル数は、`AudioContext` と `AudioWorkletNode` の設定で決まるため、
 * 呼び出し側が要求した値をそのまま使える (`AudioFrameSource.sampleRate` / `.channels`)。
 * マイクの形式をデバイスに決めさせない分、符号器の設定とずれない。
 *
 * https://www.w3.org/TR/mediacapture-transform/#mediastreamtrackprocessor
 * https://www.w3.org/TR/webcodecs/
 * https://www.w3.org/TR/webaudio/#AudioWorklet
 */

import { isMediaStreamTrackProcessorAvailable } from "./frameSource";

/** 音声を取り出すときに要求する形式 */
export interface AudioFrameSourceOptions {
  /** 要求するサンプルレート (Web Audio 経路では AudioContext のサンプルレートになる) */
  sampleRate: number;
  /** 要求するチャンネル数。Web Audio 経路では AudioWorkletNode の channelCount になる */
  channels: number;
}

/**
 * `AudioData` の ReadableStream を生成するためのリソース
 *
 * `readable` は読み出し側が cancel したときに後始末をするため、呼び出し側は `close()` を
 * 呼ばなくてもよい。ただし、読み出しを始めないまま捨てる場合だけは `close()` を呼ぶ。
 */
export interface AudioFrameSource {
  readonly readable: ReadableStream<AudioData>;
  /**
   * 実際に流れる `AudioData` のサンプルレート
   *
   * マイクの形式をデバイスが決める経路 (MediaStreamTrackProcessor) では、要求した値とは
   * 限らない。Catalog の `samplerate` と AudioEncoder の設定には必ずこの値を使う
   */
  readonly sampleRate: number;
  /** 実際に流れる `AudioData` のチャンネル数。使い道は `sampleRate` と同じ */
  readonly channels: number;
  /** 後始末をする (readable の cancel でも呼ばれる。2 回呼んでも安全) */
  close(): void;
}

/**
 * Web Audio 経路で 1 つの `AudioData` にまとめる長さ (ミリ秒)
 *
 * 音声の計器 (audioTimestampClock / audioPublishCatchUp / audioLevelTimeline) は
 * `AudioData` 1 つを 1 フレームとして数える。Chromium の MediaStreamTrackProcessor が
 * マイクから読む `AudioData` は約 10 ms であるため、Web Audio 経路も同じ長さに揃える。
 */
export const AUDIO_FRAME_BLOCK_MS = 10;

/**
 * `AudioWorklet` の量子の長さ (サンプル数)
 *
 * 仕様で 128 に固定されている。入力の無い量子を無音として数えるときに使う
 */
const AUDIO_WORKLET_QUANTUM_FRAMES = 128;

/** Web Audio 経路の AudioWorklet プロセッサの名前 */
const AUDIO_CAPTURE_PROCESSOR_NAME = "moqt-audio-capture";

/**
 * 1 つの `AudioData` にまとめるフレーム数
 *
 * サンプルレートから決まるため、ブラウザ API に依存しない純関数にしてある
 */
export function resolveAudioBlockFrames(sampleRate: number): number {
  return Math.max(1, Math.round((sampleRate * AUDIO_FRAME_BLOCK_MS) / 1_000));
}

/**
 * フレーム数を経過マイクロ秒へ換算する
 *
 * `AudioData.timestamp` はマイクロ秒の整数でなければならないため、ここで丸める。
 * 1 ブロックごとに丸めるので、丸め誤差が積み上がらない
 */
export function audioFrameOffsetMicros(frames: number, sampleRate: number): number {
  return Math.round((frames * 1_000_000) / sampleRate);
}

/**
 * チャンネルごとのサンプルを `f32-planar` の並びへ連結する
 *
 * `AudioData` の `f32-planar` は、全チャンネルを連結した 1 つの配列で受け取る
 * (チャンネルごとに連続。インターリーブではない)。Web Audio の `AudioWorklet` は
 * チャンネルごとに配列を渡してくるため、ここで並べ直す。
 *
 * 長さが揃っていない入力をそのまま渡すと、`f32-planar` の解釈がずれて音が崩れる。
 * 黙って壊れた音を送らないよう例外にする。
 */
export function concatPlanarChannels(channels: readonly Float32Array[]): Float32Array<ArrayBuffer> {
  const first = channels[0];
  if (first === undefined) {
    throw new Error("audio block has no channel");
  }
  const frames = first.length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new Error(
        `audio block channels must have the same length: ${channel.length} !== ${frames}`,
      );
    }
  }
  const planar = new Float32Array(frames * channels.length);
  for (let index = 0; index < channels.length; index++) {
    const channel = channels[index];
    if (channel === undefined) {
      continue;
    }
    planar.set(channel, index * frames);
  }
  return planar;
}

/** `AudioData` を組み立てる入力 */
export interface BuildAudioDataInitOptions {
  /** ブロックの先頭のフレーム位置 (音声の時計) */
  startFrame: number;
  sampleRate: number;
  channels: number;
  /** タイムスタンプの原点 (Unix epoch マイクロ秒) */
  originMicros: number;
  /** `f32-planar` の並びに連結済みのサンプル */
  planar: Float32Array<ArrayBuffer>;
}

/**
 * 連結済みのサンプルから `AudioData` の初期化子を組み立てる
 *
 * フレーム数は配列の長さとチャンネル数から決める。`numberOfFrames` を別に渡すと、
 * 実際のサンプル数と食い違ったときに黙って壊れた音になるため、1 か所で決める。
 */
export function buildAudioDataInit(options: BuildAudioDataInitOptions): AudioDataInit {
  const { planar, channels, sampleRate, startFrame, originMicros } = options;
  if (channels < 1 || !Number.isInteger(channels)) {
    throw new Error(`audio channels must be a positive integer: ${channels}`);
  }
  if (planar.length % channels !== 0) {
    throw new Error(
      `planar audio block length must be a multiple of channels: ${planar.length} % ${channels}`,
    );
  }
  return {
    format: "f32-planar",
    sampleRate,
    numberOfFrames: planar.length / channels,
    numberOfChannels: channels,
    // 音声の時計のフレーム位置を壁時計へ写す。丸めはここで 1 度だけ行う
    timestamp: originMicros + audioFrameOffsetMicros(startFrame, sampleRate),
    data: planar,
  };
}

/**
 * 音声の取り出し経路がこのブラウザにあるかどうかを判定する
 *
 * 配信の可否 (Catalog に音声トラックを載せるか) を接続の前に決めるために使う。
 * 経路が無いのに Catalog へ載せると、購読側は object が来ないまま待ち続ける。
 */
export function isAudioFrameSourceAvailable(): boolean {
  return isMediaStreamTrackProcessorAvailable() || isWebAudioCaptureAvailable();
}

/** Web Audio 経由で生サンプルを取り出せるかどうかを判定する */
function isWebAudioCaptureAvailable(): boolean {
  return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

/**
 * 音声トラックから `AudioData` の ReadableStream を作成する
 *
 * `MediaStreamTrackProcessor` があればそれを使い、無ければ Web Audio 経由で組み立てる。
 * どちらを使ったかは `sampleRate` と `channels` に現れる (呼び出し側はこの値を Catalog と
 * AudioEncoder に使う)。
 */
export async function createAudioFrameSource(
  track: MediaStreamTrack,
  options: AudioFrameSourceOptions,
): Promise<AudioFrameSource> {
  if (isMediaStreamTrackProcessorAvailable()) {
    return createProcessorAudioFrameSource(track, options);
  }
  if (!isWebAudioCaptureAvailable()) {
    throw new Error(
      "audio capture requires MediaStreamTrackProcessor or Web Audio AudioWorklet, but neither is available in this browser",
    );
  }
  return createWebAudioFrameSource(track, options);
}

/**
 * `MediaStreamTrackProcessor` を使った AudioFrameSource
 *
 * トラックの形式はデバイスが決めるため、実際に取れた値を `getSettings()` から読む
 * (値が無い項目は要求した値とみなす)
 */
function createProcessorAudioFrameSource(
  track: MediaStreamTrack,
  options: AudioFrameSourceOptions,
): AudioFrameSource {
  const settings = track.getSettings();
  const processor = new MediaStreamTrackProcessor<AudioData>({ track });
  return {
    readable: processor.readable,
    sampleRate: settings.sampleRate ?? options.sampleRate,
    channels: settings.channelCount ?? options.channels,
    close(): void {
      // トラックが終わると readable が自動で閉じるため、明示的な破棄は不要
    },
  };
}

/**
 * `AudioWorklet` のモジュールのソース
 *
 * AudioWorklet は別ファイルのモジュールを要求するが、ライブラリは dist に追加の
 * アセットを持てないため、ソースを文字列で持ち Blob URL として読み込む。コメントは
 * 生成されるモジュールにも残るため日本語で書く。
 */
const AUDIO_CAPTURE_WORKLET_SOURCE = String.raw`
class MoqtAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    // チャンネル数は AudioWorkletNode の channelCount で固定している。
    // マイクがモノラルでも符号器の設定と同じチャンネル数で出す
    this.channelCount = processorOptions.channels;
    // 1 つの AudioData にまとめるフレーム数
    this.blockFrames = processorOptions.blockFrames;
    // まとめ中のブロック (チャンネルごと) と、書き込み済みのフレーム数
    this.block = [];
    this.filled = 0;
    // ブロックの先頭が、このプロセッサが見た先頭から何フレーム目か
    this.blockStartFrame = 0;
    this.consumedFrames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // 入力の無い量子 (トラックが止まった後など) も無音として数える。数えないと、
    // ブロックの位置が音声の時計から遅れて、タイムスタンプが実際より古くなる
    const quantumFrames =
      typeof renderQuantumSize === "number" ? renderQuantumSize : ${AUDIO_WORKLET_QUANTUM_FRAMES};
    const frames = input && input[0] ? input[0].length : quantumFrames;
    let offset = 0;
    while (offset < frames) {
      if (this.block.length === 0) {
        this.beginBlock();
      }
      const take = Math.min(frames - offset, this.blockFrames - this.filled);
      for (let channel = 0; channel < this.block.length; channel++) {
        const source = input ? input[channel] : undefined;
        const target = this.block[channel];
        if (source) {
          target.set(source.subarray(offset, offset + take), this.filled);
        } else {
          // チャンネルが足りない量子は無音で埋める (無音のまま符号器を止めない)
          target.fill(0, this.filled, this.filled + take);
        }
      }
      this.filled += take;
      this.consumedFrames += take;
      offset += take;
      if (this.filled === this.blockFrames) {
        this.postBlock();
      }
    }
    return true;
  }

  beginBlock() {
    const block = [];
    for (let channel = 0; channel < this.channelCount; channel++) {
      block.push(new Float32Array(this.blockFrames));
    }
    this.block = block;
    this.filled = 0;
    // 消費したフレーム数がそのまま音声の時計になる
    this.blockStartFrame = this.consumedFrames;
  }

  postBlock() {
    const block = this.block;
    const startFrame = this.blockStartFrame;
    this.block = [];
    this.filled = 0;
    // バッファは移譲する (音声のスレッドでコピーを作らない)
    const transfer = [];
    for (const channel of block) {
      transfer.push(channel.buffer);
    }
    this.port.postMessage({ startFrame, channels: block }, transfer);
  }
}

registerProcessor("moqt-audio-capture", MoqtAudioCaptureProcessor);
`;

/** AudioWorklet へ読み込ませるモジュールの Blob URL (ページで 1 つだけ作る) */
let audioCaptureWorkletUrl: string | null = null;

/** Web Audio 経路のモジュール URL を返す (初回だけ作る) */
function resolveAudioCaptureWorkletUrl(): string {
  audioCaptureWorkletUrl ??= URL.createObjectURL(
    new Blob([AUDIO_CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }),
  );
  return audioCaptureWorkletUrl;
}

/** AudioWorklet から届く、まとめ終わった 1 ブロック */
interface AudioCaptureBlockMessage {
  /** ブロックの先頭のフレーム位置 */
  readonly startFrame: number;
  /** チャンネルごとのサンプル */
  readonly channels: Float32Array[];
}

/**
 * Web Audio 経由の AudioFrameSource
 *
 * `AudioContext` を要求されたサンプルレートで作り、マイクの音を `AudioWorkletNode` へ
 * 通して生サンプルを取り出す。`AudioWorkletNode` の `channelCount` を明示して
 * チャンネル数を要求どおりに固定する (既定の `channelCountMode` は入力に合わせるため、
 * モノラルのマイクでは 1 チャンネルになり、符号器の設定と食い違う)。
 */
async function createWebAudioFrameSource(
  track: MediaStreamTrack,
  options: AudioFrameSourceOptions,
): Promise<AudioFrameSource> {
  const channels = Math.max(1, Math.floor(options.channels));
  const blockFrames = resolveAudioBlockFrames(options.sampleRate);
  const context = new AudioContext({ sampleRate: options.sampleRate });
  const sampleRate = context.sampleRate;
  const stream = new MediaStream([track]);
  const sourceNode = context.createMediaStreamSource(stream);
  const muteNode = context.createGain();
  let workletNode: AudioWorkletNode | null = null;
  let trackEndedListener: (() => void) | null = null;
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (trackEndedListener !== null) {
      track.removeEventListener("ended", trackEndedListener);
      trackEndedListener = null;
    }
    if (workletNode !== null) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
      workletNode = null;
    }
    sourceNode.disconnect();
    muteNode.disconnect();
    // AudioContext の close は Promise を返すが、待つ相手が居ないため待たない
    void context.close();
  };

  // タイムスタンプの原点。AudioContext の時計は resume() で 0 から進み始めるため、
  // resume() の直前の壁時計を取る。ここが数 ms ずれても、LOC の TIMESTAMP に使う補正は
  // 読み出しの遅れの最小値を観測して決めるため (src/audioTimestampClock.ts)、ずれは
  // そのまま読み出しの遅れとして吸収される
  let originMicros = 0;

  try {
    await context.audioWorklet.addModule(resolveAudioCaptureWorkletUrl());
    workletNode = new AudioWorkletNode(context, AUDIO_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: channels,
      // 入力のチャンネル数に合わせず、要求した数へ寄せる
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { channels, blockFrames },
    });
    if (workletNode.port === undefined) {
      throw new Error("audio worklet node has no message port");
    }
    // 出力を destination へ繋がないと処理が回らない実装があるため、ミュートしたゲインを
    // 経由して繋ぐ (マイクの音をスピーカーへ出さない)
    muteNode.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(context.destination);
    originMicros = Math.round((performance.timeOrigin + performance.now()) * 1_000);
    // 生成した時点で AudioContext は suspended のことがある (自動再生ポリシー)
    await context.resume();
  } catch (error) {
    close();
    throw error;
  }

  const node = workletNode;

  const readable = new ReadableStream<AudioData>({
    start(controller): void {
      trackEndedListener = (): void => {
        // トラックが終わったら readable も閉じる (MediaStreamTrackProcessor と同じ振る舞い)
        controller.close();
        close();
      };
      track.addEventListener("ended", trackEndedListener);
      // プロセッサが例外を投げると、このノードは以後無音を出すだけになる。黙って止まると
      // 「音声が届かない」だけが残るため、読み出し側へ失敗として伝える
      node.onprocessorerror = (): void => {
        controller.error(new Error("audio worklet processor failed"));
        close();
      };
      node.port.onmessage = (event: MessageEvent<AudioCaptureBlockMessage>): void => {
        const block = event.data;
        controller.enqueue(
          new AudioData(
            buildAudioDataInit({
              startFrame: block.startFrame,
              sampleRate,
              channels,
              originMicros,
              planar: concatPlanarChannels(block.channels),
            }),
          ),
        );
      };
    },
    cancel(): void {
      close();
    },
  });

  return {
    readable,
    sampleRate,
    channels,
    close,
  };
}
