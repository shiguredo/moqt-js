/**
 * ダウンサンプリング用の Blackman 窓付き sinc。
 * 根拠: Julius O. Smith, Physical Audio Signal Processing,
 * 「Windowed Sinc Interpolation」。係数と遮断周波数は本実装の品質・負荷の選択であり、
 * Web Audio の規定ではない。通過帯域と阻止帯域は実際の出力で検証する。
 */
export class AudioResampleKernel {
  // 出力側の半幅を固定し、レート比が変わっても参照する時間を増やさない。
  static readonly OUTPUT_RADIUS = 64;
  static readonly PHASES = 128;
  readonly radius: number;
  readonly taps: number;
  readonly weights: Float32Array;

  constructor(readonly ratio: number) {
    this.radius = Math.ceil(AudioResampleKernel.OUTPUT_RADIUS / ratio);
    this.taps = this.radius * 2 + 1;
    this.weights = new Float32Array((AudioResampleKernel.PHASES + 1) * this.taps);
    const cutoff = ratio * 0.95;
    // 係数はフレームの受信時に一度だけ用意する。描画中に三角関数や配列生成を行わない。
    for (let phase = 0; phase <= AudioResampleKernel.PHASES; phase++) {
      const fraction = phase / AudioResampleKernel.PHASES;
      const offset = phase * this.taps;
      let sum = 0;
      for (let tap = 0; tap < this.taps; tap++) {
        const distance = tap - this.radius - fraction;
        const angle = Math.PI * cutoff * distance;
        const window =
          Math.abs(distance) > this.radius
            ? 0
            : 0.42 +
              0.5 * Math.cos((Math.PI * distance) / this.radius) +
              0.08 * Math.cos((2 * Math.PI * distance) / this.radius);
        const weight = cutoff * (angle === 0 ? 1 : Math.sin(angle) / angle) * window;
        this.weights[offset + tap] = weight;
        sum += weight;
      }
      // DC の振幅を位相に依存させない。
      for (let tap = 0; tap < this.taps; tap++) {
        this.weights[offset + tap] = (this.weights[offset + tap] ?? 0) / sum;
      }
    }
  }
}
