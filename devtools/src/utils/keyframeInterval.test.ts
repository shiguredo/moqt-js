import { test, assert } from "vite-plus/test";
import {
  DEFAULT_KEYFRAME_INTERVAL,
  KEYFRAME_INTERVAL_OPTIONS,
  shouldRequestKeyFrame,
} from "./keyframeInterval";

// ============================================================================
// 既定値と選択肢
// ============================================================================

// 無効な間隔を正規化するときのフォールバックは 2 秒。webcodecs-devtools の signal の
// 初期値もこの定数を参照する。moqt-devtools の 2 つの signal の初期値は画面ごとの値
// (接続設定は 10 秒、配信側は 2 秒) であり、この定数ではない
// (signal の初期値は signals/keyframeIntervalDefaults.test.ts が固定する)
test("DEFAULT_KEYFRAME_INTERVAL: 2 秒のまま変わらない", () => {
  assert.equal(DEFAULT_KEYFRAME_INTERVAL, 2);
});

// 選択肢は全て 0 より大きい有限数である。判定に渡す値の規則 (0 より大きい有限数) を
// 満たさない値が select から入ると、キーフレームの要求が意図した周期で出ない
test("KEYFRAME_INTERVAL_OPTIONS: 選択肢は 0 より大きい有限数だけ", () => {
  for (const interval of KEYFRAME_INTERVAL_OPTIONS) {
    assert.isTrue(Number.isFinite(interval) && interval > 0, `${interval} は 0 より大きい有限数`);
  }
});

// 選択肢は昇順で重複が無い。ConnectionSettings はこの順に option を並べるため、
// 順序が崩れると select が設定を探しにくい並びになる
test("KEYFRAME_INTERVAL_OPTIONS: 選択肢は昇順で重複しない", () => {
  const sorted = [...KEYFRAME_INTERVAL_OPTIONS].sort((left, right) => left - right);
  assert.deepEqual([...KEYFRAME_INTERVAL_OPTIONS], sorted);
  assert.equal(new Set(KEYFRAME_INTERVAL_OPTIONS).size, KEYFRAME_INTERVAL_OPTIONS.length);
});

// ============================================================================
// キーフレーム要求の判定
// ============================================================================

// 先頭フレーム (直前のキーフレームが無い) と、直前のキーフレームから間隔だけ経過した
// フレームにキーフレームを要求する。間隔を無視して全フレームをキーフレームにすると
// 帯域を浪費し、要求が一度も出ないと購読開始時に復号を始められない。境界 (先頭、
// 間隔 - 1 μs、間隔、間隔 + 1 μs、2 * 間隔 - 1 μs、2 * 間隔) を固定する
test("shouldRequestKeyFrame: 先頭フレームと間隔の経過で true になる", () => {
  const intervalSeconds = 10;
  const intervalUs = intervalSeconds * 1_000_000;
  assert.isTrue(shouldRequestKeyFrame(null, 0, intervalSeconds));
  assert.isTrue(shouldRequestKeyFrame(0, intervalUs, intervalSeconds));
  assert.isTrue(shouldRequestKeyFrame(0, intervalUs * 2, intervalSeconds));

  // 間隔に届く前はキーフレームを要求しない
  assert.isFalse(shouldRequestKeyFrame(0, 1, intervalSeconds));
  assert.isFalse(shouldRequestKeyFrame(0, intervalUs - 1, intervalSeconds));
  // 間隔に届いたフレームでは要求する (直前のキーフレームが 0 のままであれば、
  // 間隔を過ぎたどのフレームでも要求する)
  assert.isTrue(shouldRequestKeyFrame(0, intervalUs + 1, intervalSeconds));
  assert.isTrue(shouldRequestKeyFrame(0, intervalUs * 2 - 1, intervalSeconds));
});

// 直前のキーフレームが 0 でない場合も、経過時間だけで判定する
test("shouldRequestKeyFrame: 直前のキーフレームが 0 でなくても経過時間で判定する", () => {
  const baseUs = 5_000_000;
  assert.isFalse(shouldRequestKeyFrame(baseUs, baseUs + 9_999_999, 10));
  assert.isTrue(shouldRequestKeyFrame(baseUs, baseUs + 10_000_000, 10));
});

// timestamp が巻き戻ったフレーム (映像の入力が差し替わった) は先頭として扱う。
// 巻き戻りを無視すると、差し替え後にキーフレームが現れず購読側が復号を始められない
test("shouldRequestKeyFrame: timestamp が巻き戻ったら true になる", () => {
  assert.isTrue(shouldRequestKeyFrame(5_000_000, 0, 10));
});

// 0 を渡すと経過時間の比較が成立せず、キーフレームの要求が意図した周期で出ない。
// 0 / 負値 / NaN / ±Infinity は既定値の間隔として判定し、呼び出し側の配信ループを
// 抜けないよう throw はしない
test("shouldRequestKeyFrame: 無効な間隔は既定値の間隔として判定する", () => {
  const defaultIntervalUs = DEFAULT_KEYFRAME_INTERVAL * 1_000_000;
  for (const invalid of [0, -1, -10, Number.NaN, Infinity, -Infinity]) {
    assert.isTrue(shouldRequestKeyFrame(null, 0, invalid), `${invalid} の先頭フレームで要求する`);
    assert.isTrue(
      shouldRequestKeyFrame(0, defaultIntervalUs, invalid),
      `${invalid} の間隔で要求する`,
    );
    assert.isFalse(
      shouldRequestKeyFrame(0, defaultIntervalUs - 1, invalid),
      `${invalid} の間隔 - 1 では要求しない`,
    );
  }
});
