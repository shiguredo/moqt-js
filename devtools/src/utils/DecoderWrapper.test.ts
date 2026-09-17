/**
 * DecoderWrapper の Node で検証できる契約
 *
 * DecoderWrapper の本体は WebCodecs (VideoDecoder) と Dedicated Worker を使うため、
 * configure / decode / reset / Worker メッセージの往復は Node の vitest では実行できない
 * (この環境では `VideoDecoder is not defined` / `Worker is not defined` で失敗する)。
 * ここではブラウザ API に依存しない「未設定時の状態機械」と、
 * 設定が無い状態での reset の扱いだけを固定する。
 *
 * 実ブラウザでの decode 契約 (キーフレーム待ち・resetKeyframeWait・復号フレーム) は
 * tests/e2e/codec-wrappers.spec.ts が、ライブラリ側の VideoDecoderWrapper
 * (src/codec/VideoDecoder.ts) を実 Chromium で検証している。
 */

import { test, assert } from "vite-plus/test";
import { DecoderWrapper, type DecoderWrapperCallbacks } from "./DecoderWrapper";

/** 出力とエラーの呼び出し回数 */
interface CallbackCounts {
  outputs: number;
  errors: number;
}

/**
 * 呼び出し回数を数えるコールバックを作る
 *
 * 未設定時の検証では decode が実行されないため output / error は呼ばれない。
 * 呼ばれた場合にテストで検出できるよう、回数だけを記録する。
 */
function makeCallbacks(): { callbacks: DecoderWrapperCallbacks; counts: CallbackCounts } {
  const counts: CallbackCounts = { outputs: 0, errors: 0 };
  return {
    callbacks: {
      output: () => {
        counts.outputs += 1;
      },
      error: () => {
        counts.errors += 1;
      },
    },
    counts,
  };
}

// configure 前は unconfigured である。
// 購読開始直後の handleObject は state を見て decode をスキップする。
test("DecoderWrapper: configure 前は unconfigured", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.outputs, 0);
    assert.equal(counts.errors, 0);
  }
});

// Worker の生成は configure 時まで遅延される。
// 生成が早まると Worker を持たない環境で wrapper の生成自体が失敗する。
test("DecoderWrapper: 生成しただけでは Worker を起動しない", () => {
  const { callbacks } = makeCallbacks();
  // Node には Worker が無いため、ここで生成されると ReferenceError になる
  const wrapper = new DecoderWrapper(true, callbacks);

  assert.equal(wrapper.state, "unconfigured");
});

// 設定が無い状態での reset() は何もせずに戻る (console.warn のみ)。
// デコーダエラーからの復帰が configure 前に走っても例外にしない。
test("DecoderWrapper: 設定が無い状態の reset は例外を投げない", async () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    await wrapper.reset();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.errors, 0);
  }
});

// resetKeyframeWait() は Worker 未生成 / 未設定でも例外を投げない
// (デコーダエラー時の復帰経路から呼ばれる)。
test("DecoderWrapper: configure 前の resetKeyframeWait は例外を投げない", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    wrapper.resetKeyframeWait();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.errors, 0);
  }
});

// configure 前の close() は何も破棄せず、状態を unconfigured のままにする。
test("DecoderWrapper: configure 前の close は例外を投げず unconfigured のまま", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.errors, 0);
  }
});

// close() は冪等である (停止経路とアンマウント経路の二重実行があり得る)。
test("DecoderWrapper: close を複数回呼んでも例外を投げない", () => {
  for (const useWorker of [false, true]) {
    const { callbacks } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    wrapper.close();
    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
  }
});
