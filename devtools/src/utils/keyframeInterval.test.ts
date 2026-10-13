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

// 有効な間隔での判定 (先頭フレーム、間隔の境界、timestamp の巻き戻り) は、委譲先の
// ライブラリ関数 (shouldSendKeyFrame) の境界として src/createMediaPublisher.test.ts が
// 固定している (この関数は正規化した間隔をそのまま渡すだけ)。ここでは devtools 固有の
// 正規化、つまり無効な間隔を既定値として判定することを固定する

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
