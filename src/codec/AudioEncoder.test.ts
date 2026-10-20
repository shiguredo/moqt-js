/**
 * 音声エンコーダーの flush の検証
 *
 * Worker の送受信と WebCodecs の `AudioEncoder` はブラウザにしか無いため、既存の検証と
 * 同じく記録用のオブジェクトを注入して、ラッパーが flush をどの順序で待つかだけを確かめる。
 */

import { assert, test } from "vite-plus/test";
import { AudioEncoderWrapper } from "./AudioEncoder";

/** 呼び出しを記録するだけのコールバック */
function createCallbacks(): { output: () => void; error: (error: Error) => void; errors: Error[] } {
  const errors: Error[] = [];
  return {
    output: () => {},
    error: (error: Error) => {
      errors.push(error);
    },
    errors,
  };
}

test("flush: direct は WebCodecs の flush を待つ", async () => {
  const callbacks = createCallbacks();
  const wrapper = new AudioEncoderWrapper(false, callbacks);
  let flushed = 0;
  const control = wrapper as unknown as { configured: boolean; encoder: unknown };
  control.configured = true;
  control.encoder = {
    state: "configured",
    flush: async (): Promise<void> => {
      flushed += 1;
    },
  };

  await wrapper.flush();

  assert.equal(flushed, 1, "WebCodecs の flush を 1 回呼ぶこと");
  assert.equal(callbacks.errors.length, 0, "失敗を通知しないこと");
});

test("flush: worker は flush を送り、二重呼び出しは同じ応答を共有する", async () => {
  const callbacks = createCallbacks();
  const wrapper = new AudioEncoderWrapper(true, callbacks);
  const control = wrapper as unknown as {
    configured: boolean;
    worker: unknown;
    pendingFlushResolve: (() => void) | null;
  };
  control.configured = true;
  const messages: unknown[] = [];
  control.worker = {
    postMessage: (message: unknown): void => {
      messages.push(message);
      // worker は flush の出力を encoded として送ってから flushed を返す。本体は
      // flushed を受け取った時点で resolve する
      queueMicrotask(() => {
        control.pendingFlushResolve?.();
      });
    },
    terminate: (): void => {},
  };

  const first = wrapper.flush();
  const second = wrapper.flush();
  await Promise.all([first, second]);

  assert.equal(messages.length, 1, "flush の要求は 1 回だけ送ること");
  assert.deepEqual(messages[0], { type: "flush" });
  assert.equal(callbacks.errors.length, 0, "失敗を通知しないこと");
});

test("flush: close は待っている flush を reject する", async () => {
  const callbacks = createCallbacks();
  const wrapper = new AudioEncoderWrapper(true, callbacks);
  const control = wrapper as unknown as { configured: boolean; worker: unknown };
  control.configured = true;
  control.worker = {
    postMessage: (): void => {},
    terminate: (): void => {},
  };

  // flush の応答は返さない (worker が停止した状態)
  const pending = wrapper.flush();
  const rejected = pending.catch((error: unknown) => error);
  wrapper.close();

  assert.instanceOf(await rejected, Error, "待っている flush を reject すること");
});
