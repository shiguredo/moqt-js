/*
 * 固定 12 次の非周期励振と線形予測の積和だけを実行する。
 * JavaScript の演算順序と Float32 への丸めを保ち、音量制約と減衰は呼び出し側で行う。
 * 動的確保を行わず、1 回の処理が返った後に次のチャンネルへ作業領域を再利用する。
 */
typedef unsigned int u32;

static double coefficients[12];
static double history[16];
static float samples[9600];

u32 coefficients_address(void) { return (u32)coefficients; }
u32 history_address(void) { return (u32)history; }
u32 samples_address(void) { return (u32)samples; }

u32 generate(u32 frames, u32 state, double innovation, double limit, double polarity) {
  if (frames > 9600) return 0;
  u32 head = 0;
  for (u32 index = 0; index < frames; index++) {
    state = state * 1664525u + 1013904223u;
    double value = (((double)state / 4294967295.0) * 2.0 - 1.0) *
                   1.7320508075688772 * innovation * polarity;
    /* 再結合や積和融合を使わず、JavaScript と同じ順に加算する。 */
    for (u32 order = 0; order < 12; order++)
      value += coefficients[order] * history[(head - 1u - order) & 15u];
    if (value > limit) value = limit;
    if (value < -limit) value = -limit;
    history[head] = value;
    head = (head + 1u) & 15u;
    samples[index] = (float)value;
  }
  return frames;
}
