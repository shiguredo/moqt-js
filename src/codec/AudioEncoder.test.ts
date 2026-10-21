/**
 * 音声エンコーダーの flush の検証
 *
 * Worker と WebCodecs の `AudioEncoder` はブラウザにしか無いため、既存の検証と同じく
 * 記録用のオブジェクトを注入する。Worker は `configure` の初期化と同じ経路 (onmessage)
 * で応答を流し、ラッパーが実際に使うメッセージ処理を通す。
 */

import { assert, test } from "vite-plus/test";
import type { AudioEncodedChunkData } from "./types";
import { AudioEncoderWrapper } from "./AudioEncoder";

/** 記録用の Worker (postMessage を記録し、onmessage で応答を流す) */
class RecordingWorker {
  static instances: RecordingWorker[] = [];

  readonly messages: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    RecordingWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Worker からの応答を 1 つ流す */
function respond(worker: RecordingWorker, data: unknown): void {
  worker.onmessage?.(new MessageEvent("message", { data }));
}

/** 記録用の Worker で構成したラッパーを作り、configure まで終える */
async function startRecordingWorker(): Promise<{
  wrapper: AudioEncoderWrapper;
  worker: RecordingWorker;
  outputs: AudioEncodedChunkData[];
  errors: Error[];
}> {
  RecordingWorker.instances.length = 0;
  const outputs: AudioEncodedChunkData[] = [];
  const errors: Error[] = [];
  const wrapper = new AudioEncoderWrapper(
    true,
    {
      output: (chunk) => {
        outputs.push(chunk);
      },
      error: (error) => {
        errors.push(error);
      },
    },
    // 実際の `?worker` import の代わりに記録用の Worker を返す
    async () => ({ default: RecordingWorker as unknown as new () => Worker }),
  );
  const configure = wrapper.configure("opus", 64_000, 48_000, 1);
  // Worker モジュールの読み込みは非同期。init が送られるまで待つ
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
  const worker = RecordingWorker.instances[RecordingWorker.instances.length - 1];
  assert.isDefined(worker, "記録用の Worker が作られること");
  // 初期化応答を流して configure を完了させる
  respond(worker as RecordingWorker, { type: "configured" });
  await configure;
  return { wrapper, worker: worker as RecordingWorker, outputs, errors };
}

test("flush: direct は WebCodecs の flush を待つ", async () => {
  const wrapper = new AudioEncoderWrapper(false, {
    output: () => {},
    error: () => {},
  });
  let flushed = 0;
  let resolveFlush: (() => void) | null = null;
  const control = wrapper as unknown as { configured: boolean; encoder: unknown };
  control.configured = true;
  control.encoder = {
    state: "configured",
    flush: (): Promise<void> =>
      new Promise<void>((resolve) => {
        flushed += 1;
        resolveFlush = resolve;
      }),
  };

  let settled = false;
  const pending = wrapper.flush().then(() => {
    settled = true;
  });
  // WebCodecs の flush が解決するまでは wrapper.flush() も解決しない
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
  assert.isFalse(settled, "WebCodecs の flush の解決を待つこと");
  assert.equal(flushed, 1, "WebCodecs の flush を 1 回呼ぶこと");
  (resolveFlush as unknown as (() => void) | null)?.();
  await pending;
  assert.isTrue(settled, "WebCodecs の flush が解決したら wrapper.flush() も解決すること");
});

test("flush: worker は flush の要求を 1 回送り、encoded の後 flushed で解決する", async () => {
  const { wrapper, worker, outputs, errors } = await startRecordingWorker();

  let settled = false;
  const first = wrapper.flush().then(() => {
    settled = true;
  });
  const second = wrapper.flush();
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });

  const flushRequests = worker.messages.filter(
    (message) => (message as { type?: string }).type === "flush",
  );
  assert.equal(flushRequests.length, 1, "flush の要求は 1 回だけ送ること");
  assert.isFalse(settled, "flushed を受けるまで解決しないこと");

  // worker は flush の出力 (encoded) を送ってから flushed を返す
  respond(worker, {
    type: "encoded",
    data: new ArrayBuffer(2),
    chunkType: "key",
    timestamp: 0,
    duration: 20_000,
  });
  assert.equal(outputs.length, 1, "flushed の前に encoded を出力へ渡すこと");
  assert.isFalse(settled, "encoded だけでは解決しないこと");

  respond(worker, { type: "flushed" });
  await Promise.all([first, second]);
  assert.isTrue(settled, "flushed で解決すること");
  assert.equal(errors.length, 0, "失敗を通知しないこと");
});

test("flush: close は待っている flush を reject する", async () => {
  const { wrapper, worker } = await startRecordingWorker();

  // flush の応答は返さない (worker が停止した状態)
  const pending = wrapper.flush();
  const rejected = pending.catch((error: unknown) => error);
  wrapper.close();

  assert.instanceOf(await rejected, Error, "待っている flush を reject すること");
  assert.isTrue(worker.terminated, "worker を終了すること");
});
