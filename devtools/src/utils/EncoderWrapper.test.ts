/**
 * EncoderWrapper の Node で検証できる契約
 *
 * EncoderWrapper の本体は WebCodecs (VideoEncoder) と Dedicated Worker を使うため、
 * configure / encode / Worker メッセージの往復は Node の vitest では実行できない
 * (この環境では `VideoEncoder is not defined` / `Worker is not defined` で失敗する)。
 * ここではブラウザ API に依存しない「未設定時の状態機械」だけを固定する。
 *
 * 実ブラウザでの encode 契約は tests/e2e/codec-wrappers.spec.ts が検証している。ライブラリ側の
 * VideoEncoderWrapper (src/codec/VideoEncoder.ts) と、この devtools の EncoderWrapper の
 * Worker モード (devtools/src/codec-test/ の runner 経由) を実 Chromium で駆動する。
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
// Worker モードの encodeQueueSize は Worker へ送信してまだ encoded 応答が返っていない
// フレーム数であり、0 を返す条件は「未設定」または「送信中 0 件」である。
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

// configure 前の close() は何も破棄せず、状態を unconfigured のままにする。
// プレビュー開始前の後始末 (cleanupPublisher) が configure 前に走る経路がある。
// close() は冪等であり、停止経路とアンマウント経路の二重実行があり得る
test("EncoderWrapper: configure 前の close は例外を投げず unconfigured のまま", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new EncoderWrapper(useWorker, callbacks);

    wrapper.close();
    // 二重に呼んでも同じ (close は終端であり、後始末は繰り返せる)
    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(wrapper.encodeQueueSize, 0);
    assert.equal(counts.errors, 0);
  }
});
