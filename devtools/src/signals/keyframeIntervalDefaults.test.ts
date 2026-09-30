import { test, assert } from "vite-plus/test";
import { keyframeInterval as connectionSettingsKeyframeInterval } from "./connectionSettings";
import { keyframeInterval as publisherKeyframeInterval } from "./publisher";
import { keyframeInterval as webcodecsKeyframeInterval } from "../webcodecs-devtools/signals";
import { DEFAULT_KEYFRAME_INTERVAL, KEYFRAME_INTERVAL_OPTIONS } from "../utils/keyframeInterval";

// 画面ごとの Keyframe Interval の初期値 (秒)。値そのものを変えると利用者に見える
// 既定値が変わるため、実測値として固定する。moqt-devtools の接続設定は 10 秒、配信側の
// signal は 2 秒 (配信の開始時に接続設定の値で上書きする)、webcodecs-devtools は
// 共有モジュールの既定値 (2 秒)。無効な間隔を正規化するときの既定値そのものは
// utils/keyframeInterval.test.ts が固定する
test("keyframeInterval の初期値: 各画面で 10 / 2 / 2 秒のまま変わらない", () => {
  // moqt-devtools の Keyframe Interval (接続設定)
  assert.equal(connectionSettingsKeyframeInterval.value, 10, "接続設定の初期値");

  // 配信側の signal。配信の開始時に接続設定の値で上書きする
  assert.equal(publisherKeyframeInterval.value, 2, "配信側の signal の初期値");

  // webcodecs-devtools は共有モジュールの既定値を参照する
  assert.equal(
    webcodecsKeyframeInterval.value,
    DEFAULT_KEYFRAME_INTERVAL,
    "webcodecs-devtools は既定値を共有モジュールから取る",
  );
});

// moqt-devtools の Keyframe Interval は初期値のまま Copy URL で持ち出せる必要がある。
// 初期値が許可リストに無いと、Copy URL が載せた値を読み直したときに無視され、
// リロードで設定が戻ってしまう (select の表示も空になる)
test("KEYFRAME_INTERVAL_OPTIONS: moqt-devtools の初期値を含む", () => {
  assert.isTrue(
    KEYFRAME_INTERVAL_OPTIONS.includes(connectionSettingsKeyframeInterval.value),
    `${connectionSettingsKeyframeInterval.value} を許可リストに含む`,
  );
});

// webcodecs-devtools の select の選択肢 (1 / 2 / 3 / 4 秒) は ConfigPanel に直書きされている。
// 初期値がその範囲外だと、開いた直後の select が空表示になり、表示と実際の設定が食い違う
test("webcodecs-devtools の初期値は select の選択肢に含まれる", () => {
  assert.isTrue(
    [1, 2, 3, 4].includes(webcodecsKeyframeInterval.value),
    `${webcodecsKeyframeInterval.value} を選択肢に含む`,
  );
});
