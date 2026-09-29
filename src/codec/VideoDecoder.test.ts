/**
 * VideoDecoderWrapper の configure() の追い越しと reset() の打ち切りのテスト
 *
 * Node には WebCodecs が無いため、その境界 (globalThis.VideoDecoder) だけを置き換え、
 * 対応確認の await で止まっている間に起きた操作との関係と、対応確認が非対応を返した
 * ときの打ち切り (Worker / VideoDecoder の破棄) だけを固定する。
 * 対応確認の判定規則 (isConfigSupported の解釈) は ./configSupport.test.ts が、実ブラウザの
 * Worker を含む経路は tests/e2e/codec-wrappers.spec.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { VideoDecoderWrapper } from "./VideoDecoder";
import { withVideoDecoder } from "../testSupport/helpers";

/** 置き換えた VideoDecoder が受けた呼び出しの記録 */
interface ObservedVideoDecoderCalls {
  /** 生成したデコーダーの数 */
  createdCount: number;
  /** configure() へ渡った設定 (呼び出し順) */
  configuredConfigs: VideoDecoderConfig[];
  /** close() された数 */
  closedCount: number;
}

/** 置き換える VideoDecoder と、その呼び出しの記録 */
interface ObservedVideoDecoder {
  /** globalThis.VideoDecoder へ代入する値 */
  decoder: unknown;
  /** 呼び出しの記録 */
  calls: ObservedVideoDecoderCalls;
}

/** 置き換える VideoDecoder の挙動 */
interface ObservedVideoDecoderOptions {
  /** 対応確認 (isConfigSupported) が返す対応可否 (省略時は常に対応あり) */
  isSupported?: () => boolean;
  /** close() を失敗させるか (省略時は成功する) */
  closeThrows?: boolean;
}

/**
 * 呼び出しを記録する VideoDecoder を組み立てる
 *
 * 境界の置き換えとして対応確認の結果と close() の成否を指定できる (既定は「常に対応あり・
 * close は成功」。非対応 codec の経路は実ブラウザの e2e が固定する)。解放のあとに
 * デコーダーが作られていないことを数えられるよう、生成と close も記録する
 * (解放は参照を切ってから閉じるため、作られると誰も破棄しないまま残る)。
 *
 * @param options - 対応確認の結果と close() の成否
 */
function createObservedVideoDecoder(
  options: ObservedVideoDecoderOptions = {},
): ObservedVideoDecoder {
  const isSupported = options.isSupported ?? (() => true);
  const closeThrows = options.closeThrows ?? false;
  const calls: ObservedVideoDecoderCalls = {
    createdCount: 0,
    configuredConfigs: [],
    closedCount: 0,
  };
  const decoder = class {
    readonly state = "configured";
    constructor() {
      calls.createdCount += 1;
    }
    static async isConfigSupported(): Promise<{ supported: boolean }> {
      return { supported: isSupported() };
    }
    configure(config: VideoDecoderConfig): void {
      calls.configuredConfigs.push(config);
    }
    decode(): void {}
    close(): void {
      calls.closedCount += 1;
      if (closeThrows) {
        // 破棄そのものが失敗する状況を再現する (呼び出し側は失敗しうる前提で扱う)
        throw new Error("video decoder close failed");
      }
    }
  };
  return { decoder, calls };
}

test("configure: 対応確認中に close したらデコーダーを作らない", async () => {
  const { decoder, calls } = createObservedVideoDecoder();
  await withVideoDecoder(decoder, async () => {
    let outputCount = 0;
    let errorCount = 0;
    const wrapper = new VideoDecoderWrapper(false, {
      output: () => {
        outputCount += 1;
      },
      error: () => {
        errorCount += 1;
      },
    });

    // await を挟まずに close() を呼ぶ。configure() は対応確認の await で止まるため、
    // 解放が対応確認の解決より先に走る
    const pending = wrapper.configure("vp8", 320, 240);
    wrapper.close();

    let thrown: unknown = null;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    // 解放のあとに作らないため、生成も configure も close も 0 件になる
    assert.instanceOf(thrown, Error);
    assert.equal(
      (thrown as Error).message,
      "video decoder configure superseded by newer generation",
    );
    assert.equal(calls.createdCount, 0);
    assert.deepEqual(calls.configuredConfigs, []);
    assert.equal(calls.closedCount, 0);
    // 解放のあとに configured へ戻らない (close() の終端契約) ことと、
    // configure() の失敗が error コールバックを呼ばないこと
    assert.equal(wrapper.state, "unconfigured");
    assert.equal(outputCount, 0);
    assert.equal(errorCount, 0);

    // やり直した configure() は成功する (解放で Wrapper は壊れない)
    await wrapper.configure("vp8", 320, 240);
    assert.equal(wrapper.state, "configured");
    assert.equal(calls.createdCount, 1);
    wrapper.close();
    assert.equal(calls.closedCount, 1);
  });
});

test("configure: 対応確認中に新しい configure が始まったら先発は構成しない", async () => {
  const { decoder, calls } = createObservedVideoDecoder();
  await withVideoDecoder(decoder, async () => {
    let errorCount = 0;
    const wrapper = new VideoDecoderWrapper(false, {
      output: () => {},
      error: () => {
        errorCount += 1;
      },
    });

    // await を挟まずに 2 回呼ぶ。どちらも対応確認の await で止まり、後発が先に
    // lastConfig を差し替える (先発は自分の設定が置き換わったことを検出する)
    const first = wrapper.configure("vp8", 320, 240);
    const second = wrapper.configure("vp8", 640, 480);

    let firstError: unknown = null;
    try {
      await first;
    } catch (error) {
      firstError = error;
    }
    await second;

    // 後発の configure() だけが構成し、先発の設定は残らない
    assert.instanceOf(firstError, Error);
    assert.equal(
      (firstError as Error).message,
      "video decoder configure superseded by newer generation",
    );
    assert.equal(calls.createdCount, 1);
    assert.deepEqual(calls.configuredConfigs, [
      { codec: "vp8", codedWidth: 640, codedHeight: 480 },
    ]);
    assert.equal(wrapper.state, "configured");
    assert.equal(errorCount, 0);
    wrapper.close();
    assert.equal(calls.closedCount, 1);
  });
});

test("reset: 対応確認が非対応になったらデコーダーを破棄して unconfigured にする", async () => {
  // 対応確認は最初は対応ありを返し、configure() の後に非対応へ切り替える。
  // reset() の対応確認が解決した時点で、同じ設定が非対応と判定される状態を作る
  let configSupported = true;
  const { decoder, calls } = createObservedVideoDecoder({
    isSupported: () => configSupported,
  });
  await withVideoDecoder(decoder, async () => {
    let outputCount = 0;
    let errorCount = 0;
    const wrapper = new VideoDecoderWrapper(false, {
      output: () => {
        outputCount += 1;
      },
      error: () => {
        errorCount += 1;
      },
    });

    await wrapper.configure("vp8", 320, 240);
    assert.equal(wrapper.state, "configured");
    assert.equal(calls.createdCount, 1);
    assert.equal(calls.closedCount, 0);

    // 予算は 1 回分も消費していないため、打ち切りの理由は対応確認の結果だけになる
    configSupported = false;
    const resetReturned = await wrapper.reset();

    // false を返すだけでなく、生成済みの decoder を閉じて configured を false にする。
    // 破棄しないと state が configured のまま残り、以降の decode() が復号を続ける
    // (打ち切りは close() と同じ後始末であり、reset() の中で完結する)
    assert.isFalse(resetReturned);
    assert.equal(calls.createdCount, 1);
    assert.equal(calls.closedCount, 1);
    assert.equal(wrapper.state, "unconfigured");

    // 打ち切りは error コールバックを呼ばない (呼ぶと恒久エラーで通知が止まらない)
    assert.equal(outputCount, 0);
    assert.equal(errorCount, 0);
  });
});

test("reset: 破棄が失敗しても reject せず unconfigured にする", async () => {
  // close() が throw する VideoDecoder を境界に置く。実際の破棄 (VideoDecoder の close() /
  // Worker の terminate()) は失敗しうるため、失敗しても reset() の契約 (例外を投げない・
  // 打ち切ったら configured を false にする) が守られることを固定する
  let configSupported = true;
  const { decoder, calls } = createObservedVideoDecoder({
    isSupported: () => configSupported,
    closeThrows: true,
  });
  await withVideoDecoder(decoder, async () => {
    let errorCount = 0;
    const wrapper = new VideoDecoderWrapper(false, {
      output: () => {},
      error: () => {
        errorCount += 1;
      },
    });

    await wrapper.configure("vp8", 320, 240);
    assert.equal(wrapper.state, "configured");

    configSupported = false;
    let resetRejected = false;
    let resetReturned = true;
    try {
      resetReturned = await wrapper.reset();
    } catch {
      resetRejected = true;
    }

    // 破棄の失敗は警告に残すだけで reject させない (呼び出し側は reject が起きない前提で
    // catch を置かないため、reject させると未処理の rejection になる)
    assert.isFalse(resetRejected);
    assert.isFalse(resetReturned);
    // 破棄が失敗しても保持している参照と configured は先に落ちているため、
    // 打ち切り後の state は unconfigured になり復号を続けない
    assert.equal(calls.closedCount, 1);
    assert.equal(wrapper.state, "unconfigured");
    assert.equal(errorCount, 0);
  });
});
