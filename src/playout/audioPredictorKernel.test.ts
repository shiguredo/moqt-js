/** 固定領域の ABI、解析解との一致、返した PCM の所有権を実 Wasm で検証する。 */
import { assert, test } from "vite-plus/test";
import { generateUnvoiced, prepareAudioPredictor } from "./audioPredictorKernel";

test("1 次の減衰の解析解と一致し、次の呼び出しで既存の結果を上書きしない", () => {
  prepareAudioPredictor();
  const coefficients = new Float64Array(12);
  coefficients[0] = 0.5;
  const history = new Float64Array(16);
  history[15] = 0.25;
  const options = { state: 731, innovation: 0, limit: 1, polarity: 1 };
  const output = generateUnvoiced(coefficients, history, 64, options);
  const expected = Float32Array.from({ length: 64 }, (_, index) => 0.25 * 0.5 ** (index + 1));
  assert.deepEqual(output, expected, "単一係数の減衰を解析解で確かめること");
  history[15] = 0.5;
  const second = generateUnvoiced(coefficients, history, 64, options);
  assert.deepEqual(
    second,
    expected.map((value) => value * 2),
  );
  assert.deepEqual(output, expected, "再利用する作業メモリーを結果として返さないこと");
});

test("固定領域を超える入力を拒否し、失敗後も正常な演算を行える", () => {
  const coefficients = new Float64Array(12),
    history = new Float64Array(16);
  const options = { state: 731, innovation: 0.1, limit: 0.3, polarity: 1 };
  assert.throws(() => generateUnvoiced(coefficients, history, 9601, options));
  assert.throws(() => generateUnvoiced(coefficients.subarray(1), history, 128, options));
  const output = generateUnvoiced(coefficients, history, 128, options);
  assert.isTrue(output.every((value) => Number.isFinite(value) && Math.abs(value) <= 0.3));
  assert.isTrue(
    output.some((value) => value !== 0),
    "失敗を無音で隠さないこと",
  );
});
