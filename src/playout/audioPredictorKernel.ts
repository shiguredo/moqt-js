import { audioPredictorBytes } from "./wasm/audioPredictorBytes";

interface KernelExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly coefficients_address: () => number;
  readonly history_address: () => number;
  readonly samples_address: () => number;
  readonly generate: (
    frames: number,
    state: number,
    innovation: number,
    limit: number,
    polarity: number,
  ) => number;
}
interface Kernel {
  readonly exports: KernelExports;
  readonly coefficients: Float64Array;
  readonly history: Float64Array;
  readonly samples: Float32Array;
}
let prepared: Kernel | null = null;

/** 各実行環境に 1 個の固定領域を持ち、同期の呼び出しが終わってから再利用する。 */
function kernelOf(): Kernel {
  if (prepared !== null) return prepared;
  const module = new WebAssembly.Module(audioPredictorBytes);
  const instance = new WebAssembly.Instance(module);
  // 同梱するカーネルの ABI の境界。外部の任意モジュールは受け付けない。
  const exports = instance.exports as KernelExports;
  const { buffer } = exports.memory;
  prepared = {
    exports,
    coefficients: new Float64Array(buffer, exports.coefficients_address(), 12),
    history: new Float64Array(buffer, exports.history_address(), 16),
    samples: new Float32Array(buffer, exports.samples_address(), 9600),
  };
  return prepared;
}

/** 媒体の投入前に数値カーネルをコンパイルし、初回の未着時に行わない。 */
export function prepareAudioPredictor(): void {
  kernelOf();
}

/**
 * 予測器の固定次数の積和を Wasm で実行する。係数の解析、励振の種、演算順序と
 * Float32 への丸めは従来どおりであり、音声の方式を負荷対策で変えない。
 * 作業領域は返さず、結果を所有する配列へコピーする。
 */
export function generateUnvoiced(
  coefficients: Float64Array,
  history: Float64Array,
  frames: number,
  options: { state: number; innovation: number; limit: number; polarity: number },
): Float32Array<ArrayBuffer> {
  if (
    coefficients.length !== 12 ||
    history.length !== 16 ||
    !Number.isInteger(frames) ||
    frames < 0 ||
    frames > 9600
  )
    throw new Error("Audio predictor input exceeds its fixed capacity");
  const kernel = kernelOf();
  kernel.coefficients.set(coefficients);
  kernel.history.set(history);
  const generated = kernel.exports.generate(
    frames,
    options.state,
    options.innovation,
    options.limit,
    options.polarity,
  );
  if (generated !== frames) throw new Error("Audio predictor failed to generate samples");
  return kernel.samples.slice(0, frames);
}
