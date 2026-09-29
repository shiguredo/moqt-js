import { test, assert } from "vite-plus/test";
import { DEFAULT_VIDEO_FRAMERATE } from "../../../src/codec/config.ts";
import {
  DEFAULT_KEYFRAME_INTERVAL,
  KEYFRAME_INTERVAL_OPTIONS,
  shouldRequestKeyFrame,
} from "./keyframeInterval";

// ============================================================================
// 既定値と選択肢
// ============================================================================

// 無効な間隔を正規化するときのフォールバックは 3600 フレーム (30 fps で 120 秒ぶん)。
// webcodecs-devtools の signal の初期値もこの定数を参照する。moqt-devtools の 2 つの
// signal の初期値は画面ごとの値 (300 / 60) であり、この定数ではない
// (signal の初期値は signals/keyframeIntervalDefaults.test.ts が固定する)
test("DEFAULT_KEYFRAME_INTERVAL: 3600 のまま変わらない", () => {
  assert.equal(DEFAULT_KEYFRAME_INTERVAL, 3600);
});

// 選択肢は全て 1 以上の整数である。判定に渡す値の規則 (1 以上の整数) を満たさない値が
// select から入ると、そのままではキーフレームの要求が出ない
test("KEYFRAME_INTERVAL_OPTIONS: 選択肢は 1 以上の整数だけ", () => {
  for (const interval of KEYFRAME_INTERVAL_OPTIONS) {
    assert.isTrue(Number.isInteger(interval) && interval >= 1, `${interval} は 1 以上の整数`);
  }
});

// ConnectionSettings は選択肢の値を既定 framerate で割った秒数をラベルにする。
// 倍数でない選択肢があるとラベルが整数秒にならず、画面の表示が崩れる
test("KEYFRAME_INTERVAL_OPTIONS: 選択肢は既定 framerate の倍数だけ", () => {
  for (const interval of KEYFRAME_INTERVAL_OPTIONS) {
    assert.equal(
      interval % DEFAULT_VIDEO_FRAMERATE,
      0,
      `${interval} は ${DEFAULT_VIDEO_FRAMERATE} の倍数`,
    );
  }
});

// ============================================================================
// キーフレーム要求の判定
// ============================================================================

// 先頭フレームと keyframeInterval フレームごとにキーフレームを要求する。
// 間隔を無視して全フレームをキーフレームにすると帯域を浪費し、
// 要求が一度も出ないと購読開始時に復号を始められない。
// 境界 (先頭フレーム、間隔、2 * 間隔、間隔 ± 1、2 * 間隔 - 1) を固定する
test("shouldRequestKeyFrame: 先頭フレームと keyframeInterval ごとに true になる", () => {
  assert.isTrue(shouldRequestKeyFrame(0, DEFAULT_KEYFRAME_INTERVAL));
  assert.isTrue(shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL, DEFAULT_KEYFRAME_INTERVAL));
  assert.isTrue(shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2, DEFAULT_KEYFRAME_INTERVAL));

  // 間隔の途中はキーフレームを要求しない
  assert.isFalse(shouldRequestKeyFrame(1, DEFAULT_KEYFRAME_INTERVAL));
  assert.isFalse(shouldRequestKeyFrame(2, DEFAULT_KEYFRAME_INTERVAL));
  assert.isFalse(shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL - 1, DEFAULT_KEYFRAME_INTERVAL));
  assert.isFalse(shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL + 1, DEFAULT_KEYFRAME_INTERVAL));
  assert.isFalse(
    shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2 - 1, DEFAULT_KEYFRAME_INTERVAL),
  );
});

// 値域の下限 (1) は有効な間隔であり、0 と区別する。間隔 1 では間隔 - 1 が先頭フレーム、
// 間隔 + 1 が 2 * 間隔、2 * 間隔 - 1 が間隔と重なり、いずれもキーフレームになる
test("shouldRequestKeyFrame: 間隔 1 では境界を含む全てのフレームで true になる", () => {
  for (const framesEncoded of [0, 1, 2]) {
    assert.isTrue(shouldRequestKeyFrame(framesEncoded, 1), `${framesEncoded} フレーム目で要求する`);
  }
});

// 0 を渡すと framesEncoded % 0 が NaN になり、先頭フレームを含めてキーフレームの要求が
// 一度も出なくなる (購読側が復号を始められない)。0 / 負値 / 非整数 / NaN / ±Infinity は
// 既定値の間隔として判定し、呼び出し側の配信ループを抜けないよう throw はしない
test("shouldRequestKeyFrame: 無効な間隔は既定値の間隔として判定する", () => {
  for (const invalid of [0, -1, -3600, 0.5, 1.5, Number.NaN, Infinity, -Infinity]) {
    assert.isTrue(shouldRequestKeyFrame(0, invalid), `${invalid} の先頭フレームで要求する`);
    assert.isTrue(
      shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL, invalid),
      `${invalid} の間隔で要求する`,
    );
    assert.isTrue(
      shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2, invalid),
      `${invalid} の 2 * 間隔で要求する`,
    );
    assert.isFalse(
      shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL - 1, invalid),
      `${invalid} の間隔 - 1 では要求しない`,
    );
    assert.isFalse(
      shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL + 1, invalid),
      `${invalid} の間隔 + 1 では要求しない`,
    );
    assert.isFalse(
      shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2 - 1, invalid),
      `${invalid} の 2 * 間隔 - 1 では要求しない`,
    );
  }
});
