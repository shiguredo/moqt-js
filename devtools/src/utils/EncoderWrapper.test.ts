/**
 * EncoderWrapper の Node で検証できる契約
 *
 * EncoderWrapper の本体は WebCodecs (VideoEncoder) と Dedicated Worker を使うため、
 * configure / encode / Worker メッセージの往復は Node の vitest では実行できない
 * (この環境では `VideoEncoder is not defined` / `Worker is not defined` で失敗する)。
 * ここではブラウザ API に依存しない「未設定時の状態機械」だけを固定する。
 *
 * 実ブラウザでの encode 契約は tests/e2e/codec-wrappers.spec.ts が、ライブラリ側の
 * VideoEncoderWrapper (src/codec/VideoEncoder.ts) を実 Chromium で検証している。
 */

import { test, assert } from "vite-plus/test";
import { EncoderWrapper, type EncoderWrapperCallbacks } from "./EncoderWrapper";

/** 出力とエラーの呼び出し回数 */
interface CallbackCounts {
  outputs: number;
  errors: number;
}

/**
 * 呼び出し回数を数えるコールバックを作る
 *
 * 未設定時の検証では encode が実行されないため output / error は呼ばれない。
 * 呼ばれた場合にテストで検出できるよう、回数だけを記録する。
 */
function makeCallbacks(): { callbacks: EncoderWrapperCallbacks; counts: CallbackCounts } {
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

// configure 前は unconfigured であり、encodeQueueSize は 0 を返す。
// Worker モードはキューを Worker 内部で管理するため常に 0 になる契約。
test("EncoderWrapper: configure 前は unconfigured で encodeQueueSize は 0", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new EncoderWrapper(useWorker, callbacks);

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(wrapper.encodeQueueSize, 0);
    assert.equal(counts.outputs, 0);
    assert.equal(counts.errors, 0);
  }
});

// Worker の生成は configure 時まで遅延される。
// 生成が早まると Worker を持たない環境で wrapper の生成自体が失敗する。
test("EncoderWrapper: 生成しただけでは Worker を起動しない", () => {
  const { callbacks } = makeCallbacks();
  // Node には Worker が無いため、ここで生成されると ReferenceError になる
  const wrapper = new EncoderWrapper(true, callbacks);

  assert.equal(wrapper.state, "unconfigured");
});

// configure 前の close() は何も破棄せず、状態を unconfigured のままにする。
// プレビュー開始前の後始末 (cleanupPublisher) が configure 前に走る経路がある。
test("EncoderWrapper: configure 前の close は例外を投げず unconfigured のまま", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new EncoderWrapper(useWorker, callbacks);

    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(wrapper.encodeQueueSize, 0);
    assert.equal(counts.errors, 0);
  }
});

// close() は冪等である (停止経路とアンマウント経路の二重実行があり得る)。
test("EncoderWrapper: close を複数回呼んでも例外を投げない", () => {
  for (const useWorker of [false, true]) {
    const { callbacks } = makeCallbacks();
    const wrapper = new EncoderWrapper(useWorker, callbacks);

    wrapper.close();
    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
  }
});
