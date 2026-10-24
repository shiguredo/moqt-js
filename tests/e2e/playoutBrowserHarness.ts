/**
 * 再生の入口 (MediaPlayout) の E2E が実ブラウザで使う共通ヘルパー
 *
 * 実ブラウザの WebCodecs (`AudioData` / `VideoFrame`) と Web Audio (`AudioContext`) を
 * 作る組み立てをここへ集約する。スペックは `page.evaluate` の中でこのモジュールを動的
 * import する (E2E アプリの dev サーバーが配信する)。
 *
 * モック・スタブは使わない。ここで作るのはすべて実ブラウザの API の実物である。
 * 時刻を待つ処理も、固定の時間で眠らず、条件と期限で待つ。
 */

/** 音声 1 つの既定の長さ (マイクロ秒)。20 ms */
const AUDIO_FRAME_DURATION_MICROS = 20_000;

/** I420 のフレームの既定の幅 (px) */
const DEFAULT_FRAME_WIDTH = 64;

/** I420 のフレームの既定の高さ (px) */
const DEFAULT_FRAME_HEIGHT = 64;

/**
 * 今の壁時計 (Unix epoch マイクロ秒)
 *
 * LOC の壁時計の TIMESTAMP と同じ軸の値である。`offsetMs` で過去・未来へずらせる。
 */
export function wallClockNowMicros(offsetMs = 0): number {
  return Math.round((performance.timeOrigin + performance.now() + offsetMs) * 1_000);
}

/** `createAudioData` の設定 */
export interface CreateAudioDataOptions {
  /** サンプルレート (Hz)。既定は 48 kHz */
  readonly sampleRate?: number;
  /**
   * サンプル数。既定はサンプルレートの 20 ms 分
   *
   * `data` を渡したときは省略するか、`data` の長さと一致させる (一致しなければエラー)。
   * 実際のサンプル数は常に `data` の長さ (チャンネル数で割った値) から決まる。
   */
  readonly numberOfFrames?: number;
  /** チャンネル数。既定は 1 */
  readonly numberOfChannels?: number;
  /** 全サンプルの値 (省略すると 0 = 無音)。`data` を渡したときは使わない */
  readonly fill?: number;
  /** サンプル列を直接渡す (波形を作るとき) */
  readonly data?: Float32Array<ArrayBuffer>;
}

/**
 * 実ブラウザの AudioData を作る
 *
 * 復号の出力と同じ形 (f32) にする。TIMESTAMP は Unix epoch マイクロ秒で渡す。
 *
 * @param timestampMicros - 音の TIMESTAMP (Unix epoch マイクロ秒)
 * @param options - サンプルレート・長さ・波形
 * @returns 実ブラウザの AudioData
 */
export function createAudioData(
  timestampMicros: number,
  options: CreateAudioDataOptions = {},
): AudioData {
  const sampleRate = options.sampleRate ?? 48_000;
  const numberOfChannels = options.numberOfChannels ?? 1;
  let data: Float32Array<ArrayBuffer>;
  if (options.data !== undefined) {
    // サンプル数は data の長さから決める。numberOfFrames も渡されたときは、意味が
    // 2 つにならないよう一致を要求する
    if (
      options.numberOfFrames !== undefined &&
      options.numberOfFrames * numberOfChannels !== options.data.length
    ) {
      throw new Error(
        `data length ${options.data.length} does not match numberOfFrames * numberOfChannels ` +
          `(${options.numberOfFrames} * ${numberOfChannels})`,
      );
    }
    if (options.data.length % numberOfChannels !== 0) {
      throw new Error(
        `data length ${options.data.length} is not divisible by numberOfChannels ${numberOfChannels}`,
      );
    }
    data = options.data;
  } else {
    const numberOfFrames =
      options.numberOfFrames ?? Math.round((sampleRate * AUDIO_FRAME_DURATION_MICROS) / 1_000_000);
    data = new Float32Array(numberOfFrames * numberOfChannels).fill(options.fill ?? 0);
  }
  return new AudioData({
    format: "f32",
    sampleRate,
    numberOfFrames: data.length / numberOfChannels,
    numberOfChannels,
    timestamp: timestampMicros,
    data,
  });
}

/** 音を鳴らさない実ブラウザの音声出力 */
export interface SilentAudioOutput {
  /** 実ブラウザの AudioContext */
  readonly context: AudioContext;
  /** 予約した音を繋ぐ出力 (gain 0) */
  readonly destination: GainNode;
  /** MediaStream 経由で再生する `<audio>`。`mediaStream: true` のときだけ非 null */
  readonly element: HTMLAudioElement | null;
  /** `<audio>` へ渡す MediaStream の出力。`mediaStream: true` のときだけ非 null */
  readonly mediaStreamDestination: MediaStreamAudioDestinationNode | null;
}

/** `createSilentAudioOutput` の設定 */
export interface SilentAudioOutputOptions {
  /** サンプルレート (Hz)。既定は 48 kHz */
  readonly sampleRate?: number;
  /** AudioContext の遅延の指定 */
  readonly latencyHint?: AudioContextLatencyCategory;
  /**
   * 利用側と同じ MediaStream → `<audio>` の経路を通すか
   *
   * true のときは `AudioContext.destination` ではなく
   * `MediaStreamAudioDestinationNode` へ繋ぎ、`<audio>` の `srcObject` に設定する。
   */
  readonly mediaStream?: boolean;
}

/** `mediaStream: true` で作った音声出力 (MediaStream の要素が非 null) */
export interface SilentStreamAudioOutput extends SilentAudioOutput {
  readonly element: HTMLAudioElement;
  readonly mediaStreamDestination: MediaStreamAudioDestinationNode;
}

/**
 * 実ブラウザの AudioContext を作り、音を鳴らさない出力を返す
 *
 * `await context.resume()` まで済ませる (自動再生ポリシーの下でも時計を進める)。
 * 音は gain 0 で繋ぐため、テスト中は実際には鳴らないが、出力のグラフと時計は動かす。
 *
 * @param options - サンプルレート・遅延・MediaStream 経由の有無
 * @returns 音声出力
 */
export async function createSilentAudioOutput(
  options: SilentAudioOutputOptions & { readonly mediaStream: true },
): Promise<SilentStreamAudioOutput>;
export async function createSilentAudioOutput(
  options?: SilentAudioOutputOptions,
): Promise<SilentAudioOutput>;
export async function createSilentAudioOutput(
  options: SilentAudioOutputOptions = {},
): Promise<SilentAudioOutput> {
  const contextOptions: AudioContextOptions = { sampleRate: options.sampleRate ?? 48_000 };
  if (options.latencyHint !== undefined) {
    contextOptions.latencyHint = options.latencyHint;
  }
  const context = new AudioContext(contextOptions);
  await context.resume();
  const destination = context.createGain();
  destination.gain.value = 0;
  if (options.mediaStream !== true) {
    destination.connect(context.destination);
    return { context, destination, element: null, mediaStreamDestination: null };
  }
  const mediaStreamDestination = context.createMediaStreamDestination();
  destination.connect(mediaStreamDestination);
  const element = document.createElement("audio");
  element.srcObject = mediaStreamDestination.stream;
  document.body.append(element);
  await element.play();
  return { context, destination, element, mediaStreamDestination };
}

/**
 * 音声出力を閉じる
 *
 * `<audio>` を止めて MediaStream のトラックを停止し、`AudioContext` を閉じる。
 * テストの終わりと、`AudioContext` を作り直す直前に呼ぶ。
 *
 * @param output - `createSilentAudioOutput` が返した音声出力
 */
export async function closeSilentAudioOutput(output: SilentAudioOutput): Promise<void> {
  if (output.element !== null) {
    output.element.pause();
    output.element.srcObject = null;
  }
  for (const track of output.mediaStreamDestination?.stream.getTracks() ?? []) {
    track.stop();
  }
  if (output.context.state !== "closed") {
    await output.context.close();
  }
}

/** 実 canvas へ描く映像の出し先 */
export interface CanvasVideoOutput {
  /** present が実際に描く canvas (実 VideoFrame の元にも使える) */
  readonly canvas: HTMLCanvasElement;
  /** 再生の入口へ渡す出し先 */
  readonly output: {
    isAvailable(): boolean;
    present(frame: VideoFrame, presentationMs: number | null): boolean;
  };
  /** `present` が呼ばれた回数 (呼ばれていないことの確認に使う) */
  presentCalls(): number;
  /** canvas へ描いて閉じたフレームの表示時刻 (古い順) */
  presentations(): (number | null)[];
}

/** `createCanvasVideoOutput` の設定 */
export interface CanvasVideoOutputOptions {
  /** canvas の幅 (px)。既定は 16 */
  readonly width?: number;
  /** canvas の高さ (px)。既定は 16 */
  readonly height?: number;
  /** 出し先を使えるかの判定。省略すると canvas が DOM に繋がっているか */
  readonly isAvailable?: () => boolean;
  /**
   * `present` の振る舞い。省略すると canvas へ描いてフレームを閉じる
   *
   * throw しても入口が握る (表示しなかった扱いになる)。そのため検証では、
   * 呼ばれたこと自体を `presentCalls()` で確かめる。
   */
  readonly onPresent?: (frame: VideoFrame, presentationMs: number | null) => boolean;
}

/**
 * 実 canvas への映像の出し先を作る
 *
 * 既定の `present` は、受け取ったフレームを canvas へ描いて閉じる (所有権を受け取る)。
 * `isAvailable` を差し替えると、出し先が使えない場合の経路を通せる。
 *
 * @param options - canvas の大きさ・利用可否・present の振る舞い
 * @returns canvas と、再生の入口へ渡す出し先
 */
export function createCanvasVideoOutput(options: CanvasVideoOutputOptions = {}): CanvasVideoOutput {
  const canvas = document.createElement("canvas");
  canvas.width = options.width ?? 16;
  canvas.height = options.height ?? 16;
  document.body.append(canvas);
  const drawing = canvas.getContext("2d");
  if (drawing === null) {
    throw new Error("failed to create the canvas 2D context");
  }
  let presentCallCount = 0;
  const presented: (number | null)[] = [];
  const isAvailable = options.isAvailable ?? (() => canvas.isConnected);
  const onPresent = options.onPresent;
  return {
    canvas,
    output: {
      isAvailable,
      present: (frame, presentationMs) => {
        presentCallCount++;
        if (onPresent !== undefined) {
          return onPresent(frame, presentationMs);
        }
        drawing.drawImage(frame, 0, 0);
        presented.push(presentationMs);
        frame.close();
        return true;
      },
    },
    presentCalls: () => presentCallCount,
    presentations: () => presented,
  };
}

/**
 * 復号の出力と同じ形の I420 の実 VideoFrame を作る
 *
 * @param timestampMicros - フレームの TIMESTAMP (マイクロ秒)
 * @param width - 幅 (px)。偶数
 * @param height - 高さ (px)。偶数
 * @returns 実ブラウザの VideoFrame
 */
export function createI420Frame(
  timestampMicros: number,
  width = DEFAULT_FRAME_WIDTH,
  height = DEFAULT_FRAME_HEIGHT,
): VideoFrame {
  const luma = new Uint8Array(width * height).fill(128);
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);
  const data = new Uint8Array(luma.length + chroma.length + chroma.length);
  data.set(luma, 0);
  data.set(chroma, luma.length);
  data.set(chroma, luma.length + chroma.length);
  return new VideoFrame(data, {
    format: "I420",
    codedWidth: width,
    codedHeight: height,
    timestamp: timestampMicros,
  });
}

/**
 * フレームが閉じているかを返す
 *
 * 閉じた VideoFrame の clone は実ブラウザで InvalidStateError になる。この失敗で
 * 「入口が出し先へ渡さずに閉じた」ことを確かめる (閉じていないときは clone を閉じて捨てる)。
 *
 * @param frame - 調べるフレーム
 * @returns 閉じていれば true
 */
export function isFrameClosed(frame: VideoFrame): boolean {
  try {
    const clone = frame.clone();
    clone.close();
    return false;
  } catch {
    return true;
  }
}

/**
 * 条件が満たされるまで期限付きで待つ
 *
 * 固定の時間で眠らず、10 ms ごとに条件を確かめる。期限を過ぎたら最後の判定結果を返す
 * (呼び出し側が `false` を失敗として扱えるようにする)。
 *
 * @param condition - 満たされるのを待つ条件
 * @param timeoutMs - 待つ上限 (ミリ秒)
 * @returns 期限内に満たされたら true
 */
export async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadlineMs = performance.now() + timeoutMs;
  while (performance.now() < deadlineMs) {
    if (condition()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return condition();
}

/**
 * 条件が満たされるまで期限付きで待ち、満たされなければ throw する
 *
 * 待てなかった時点でテストを失敗させたい準備 (時計の対応ができるまで、など) に使う。
 *
 * @param condition - 満たされるのを待つ条件
 * @param timeoutMs - 待つ上限 (ミリ秒)
 * @param description - 待っていたもの (日本語のエラーメッセージに使う)
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const satisfied = await waitUntil(condition, timeoutMs);
  if (!satisfied) {
    throw new Error(`${description}が ${timeoutMs} ms 以内に起きませんでした`);
  }
}
