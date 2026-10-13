/**
 * DecoderWrapper の Node で検証できる契約
 *
 * DecoderWrapper の本体は WebCodecs (VideoDecoder) と Dedicated Worker を使うため、
 * configure / decode / reset / Worker メッセージの往復は Node の vitest では実行できない
 * (この環境では `VideoDecoder is not defined` / `Worker is not defined` で失敗する)。
 * ここではブラウザ API に依存しない「未設定時の状態機械」と、
 * 設定が無い状態での reset の扱いだけを固定する。
 *
 * 実ブラウザでの configure / decode / reset の契約 (非対応 codec の事前確認・キーフレーム待ち・
 * resetKeyframeWait・復号フレーム・復帰の予算) は tests/e2e/codec-wrappers.spec.ts が、
 * この Wrapper とライブラリ側の VideoDecoderWrapper (src/codec/VideoDecoder.ts) の両方を
 * 実 Chromium で検証している。
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

// 設定が無い状態での reset() は再初期化せず false を返す (console.warn のみ)。
// デコーダエラーからの復帰が configure 前に走っても例外にせず、呼び出し側が
// 打ち切りとして扱えるようにする。
test("DecoderWrapper: 設定が無い状態の reset は例外を投げず false を返す", async () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    const restarted = await wrapper.reset();

    assert.isFalse(restarted);
    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.errors, 0);
  }
});

// configure 前の close() は何も破棄せず、状態を unconfigured のままにする。
// close() は冪等であり、停止経路とアンマウント経路の二重実行があり得る。
// 未生成の Worker / VideoDecoder への後始末が例外にならないことをここで確かめる
test("DecoderWrapper: configure 前の close は例外を投げず unconfigured のまま", () => {
  for (const useWorker of [false, true]) {
    const { callbacks, counts } = makeCallbacks();
    const wrapper = new DecoderWrapper(useWorker, callbacks);

    wrapper.close();
    // 二重に呼んでも同じ (close は終端であり、後始末は繰り返せる)
    wrapper.close();

    assert.equal(wrapper.state, "unconfigured");
    assert.equal(counts.errors, 0);
  }
});
