/**
 * MediaPublisher の pause / resume 世代管理と stop / close / start 失敗時の
 * ライフサイクル後片付けのテスト
 *
 * 実 ReadableStream をフレーム reader に注入し、世代不一致の旧ループが
 * encode せず終了することと、pause / resume 繰り返しで onError が
 * 多重発火しないことを検証する。
 * 後片付けは全種リソースの参照 null 化と破棄呼び出し、失敗時の継続と
 * 再 throw、終端後の再 start 拒否を検証する。
 * エンコーダーは WebCodecs が node にないため encode 呼び出し記録用の
 * 最小オブジェクトを注入する (モジュール置換は行わず、実ストリームの
 * 並行分配は実物で検証する)。
 * 駆動は公開 pause() / resume() を使い、ループ起動・状態設定・フラグ設定・
 * reader / encoder 注入は start() が接続を要するため private 経由で行う。
 */

import { test, assert } from "vite-plus/test";
import { MediaPublisherImpl } from "./createMediaPublisher";
import type { AudioEncoderWrapper } from "./codec/AudioEncoder";
import type { VideoEncoderWrapper } from "./codec/VideoEncoder";
import type { MediaPublisherState } from "./codec/types";
import type { VideoFrameSource } from "./frameSource";
import type { Publisher } from "./publisher";
import type { Session } from "./session";

/**
 * 破棄検出付きのテスト用フレーム
 */
interface TestFrame {
  closed: boolean;
  close(): void;
}

function createTestFrame(): TestFrame {
  const frame: TestFrame = {
    closed: false,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
}

/**
 * encode 呼び出し記録用の最小エンコーダー
 */
function createRecordingEncoder(): {
  encoded: unknown[];
  isClosed: () => boolean;
  encoder: {
    state: string;
    encodeQueueSize: number;
    encode: (frame: unknown) => void;
    close: () => void;
  };
} {
  const encoded: unknown[] = [];
  let closed = false;
  return {
    encoded,
    isClosed: () => closed,
    encoder: {
      state: "configured",
      encodeQueueSize: 0,
      encode: (frame: unknown) => {
        encoded.push(frame);
      },
      close: () => {
        closed = true;
      },
    },
  };
}

/**
 * 処理ループ駆動用の最小コンテキスト
 *
 * 実 ReadableStream の reader と記録用エンコーダーを注入する。
 * currentState の設定のみ private への直接代入であり、
 * start() の接続なしに publishing 状態を作るためである。
 */
interface PublisherLoopControl {
  audioFrameReader: ReadableStreamDefaultReader<AudioData> | null;
  audioEncoder: AudioEncoderWrapper | null;
  videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null;
  videoEncoder: VideoEncoderWrapper | null;
  processingActive: boolean;
  processingGeneration: number;
  currentState: MediaPublisherState;
  processAudioFrames(): Promise<void>;
  processVideoFrames(): Promise<void>;
}

function createLoopTestContext(): {
  publisher: MediaPublisherImpl;
  control: PublisherLoopControl;
  errors: Error[];
} {
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = publisher as unknown as PublisherLoopControl;
  control.currentState = "publishing";
  return { publisher, control, errors };
}

function createFrameStream(): {
  stream: ReadableStream<TestFrame>;
  controller: ReadableStreamDefaultController<TestFrame>;
} {
  let controller!: ReadableStreamDefaultController<TestFrame>;
  const stream = new ReadableStream<TestFrame>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

function injectAudioLoop(control: PublisherLoopControl): {
  encoded: unknown[];
  controller: ReadableStreamDefaultController<TestFrame>;
  isEncoderClosed: () => boolean;
} {
  const { stream, controller } = createFrameStream();
  const { encoder, encoded, isClosed } = createRecordingEncoder();
  control.audioFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<AudioData>;
  control.audioEncoder = encoder as unknown as AudioEncoderWrapper;
  control.processingActive = true;
  return { encoded, controller, isEncoderClosed: isClosed };
}

function injectVideoLoop(control: PublisherLoopControl): {
  encoded: unknown[];
  controller: ReadableStreamDefaultController<TestFrame>;
  isEncoderClosed: () => boolean;
} {
  const { stream, controller } = createFrameStream();
  const { encoder, encoded, isClosed } = createRecordingEncoder();
  control.videoFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<VideoFrame>;
  control.videoEncoder = encoder as unknown as VideoEncoderWrapper;
  control.processingActive = true;
  return { encoded, controller, isEncoderClosed: isClosed };
}

test("processAudioFrames: pause 後の旧ループは encode せず終了する", async () => {
  // 公開 pause() で世代を進めた旧ループにフレームが届く場合を再現する
  const { publisher, control, errors } = createLoopTestContext();
  const { encoded, controller } = injectAudioLoop(control);

  const loop = control.processAudioFrames();
  publisher.pause();
  const frame = createTestFrame();
  controller.enqueue(frame);
  await loop;

  // encode せず、フレームを閉じて終了し、onError も発火しない
  assert.equal(encoded.length, 0);
  assert.isTrue(frame.closed);
  assert.equal(errors.length, 0);
});

test("processVideoFrames: pause 後の旧ループは encode せず終了する", async () => {
  // 公開 pause() で世代を進めた旧ループにフレームが届く場合を再現する
  const { publisher, control, errors } = createLoopTestContext();
  const { encoded, controller } = injectVideoLoop(control);

  const loop = control.processVideoFrames();
  publisher.pause();
  const frame = createTestFrame();
  controller.enqueue(frame);
  await loop;

  // encode せず、フレームを閉じて終了し、onError も発火しない
  assert.equal(encoded.length, 0);
  assert.isTrue(frame.closed);
  assert.equal(errors.length, 0);
});

test("processAudioFrames: 現世代ループは encode して継続する", async () => {
  // 世代一致時は従来どおり encode し、ストリーム終了で抜ける
  const { control, errors } = createLoopTestContext();
  const { encoded, controller } = injectAudioLoop(control);

  const loop = control.processAudioFrames();
  const frame = createTestFrame();
  controller.enqueue(frame);
  // encode 記録後にストリームを閉じる (両者とも microtask のため確定的)
  await Promise.resolve();
  await Promise.resolve();
  controller.close();
  await loop;

  assert.equal(encoded.length, 1);
  assert.strictEqual(encoded[0], frame);
  assert.isTrue(frame.closed);
  assert.equal(errors.length, 0);
});

test("pause 中の旧ループと resume 後の新ループで encode は 1 回だけである", async () => {
  // 同一 reader への read() 要求は待機順に充足されるため、
  // 先に待機した旧ループが先着分、新ループが後続分を受け取る。
  // 旧ループは先着分を破棄し、新ループの 1 回だけ encode される
  const { publisher, control, errors } = createLoopTestContext();
  const { encoded, controller } = injectAudioLoop(control);

  const oldLoop = control.processAudioFrames();
  publisher.pause();
  publisher.resume();
  // resume() 内で新ループが read() 待機に入った後に 2 フレームを届ける
  await Promise.resolve();
  await Promise.resolve();
  const first = createTestFrame();
  const second = createTestFrame();
  controller.enqueue(first);
  controller.enqueue(second);
  controller.close();
  // resume() の新ループは fire-and-forget のため、タイマーで終了を待つ。
  // タイマーは microtask 排出後に発火するため、両ループの settled 後に判定する
  await oldLoop;
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });

  // 旧ループは先着分を破棄し、新ループの 1 回だけ encode される
  assert.equal(encoded.length, 1);
  assert.strictEqual(encoded[0], second);
  assert.isTrue(first.closed);
  assert.isTrue(second.closed);
  assert.equal(errors.length, 0);
});

test("pause 中に滞留したフレームは resume 後に新ループが encode する", async () => {
  // pause 中に届いた先着分は旧ループが破棄し、滞留分は新ループが
  // stale フレームとして encode する (許容仕様として固定する)
  const { publisher, control, errors } = createLoopTestContext();
  const { encoded, controller } = injectAudioLoop(control);

  const oldLoop = control.processAudioFrames();
  publisher.pause();
  const first = createTestFrame();
  const second = createTestFrame();
  controller.enqueue(first);
  controller.enqueue(second);
  await oldLoop;
  publisher.resume();
  controller.close();
  // resume() の新ループは fire-and-forget のため、タイマーで終了を待つ。
  // タイマーは microtask 排出後に発火するため、settled 後に判定する
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });

  assert.equal(encoded.length, 1);
  assert.strictEqual(encoded[0], second);
  assert.isTrue(first.closed);
  assert.isTrue(second.closed);
  assert.equal(errors.length, 0);
});

test("pause / resume を繰り返しても onError は 1 回だけ発火する", async () => {
  // 3 往復で 4 世代の待機が蓄積した状態でストリーム失敗させても、
  // 現世代ループのみ通知し、旧世代 3 件は抑止される
  const { publisher, control, errors } = createLoopTestContext();
  const { controller } = injectAudioLoop(control);

  const firstLoop = control.processAudioFrames();
  publisher.pause();
  publisher.resume();
  publisher.pause();
  publisher.resume();
  publisher.pause();
  publisher.resume();
  const failure = new Error("stream failed");
  controller.error(failure);
  await firstLoop;
  // resume() 内の新ループ群は fire-and-forget のため、タイマーで終了を待つ。
  // タイマーは microtask 排出後に発火するため、全ループの settled 後に判定する
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });

  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], failure);
});

test("stop は世代を進める", async () => {
  // stop 後の cancel 解決と再 start 後の新ループが同一世代を共有しないこと
  const { publisher, control, errors } = createLoopTestContext();
  injectAudioLoop(control);

  const before = control.processingGeneration;
  await publisher.stop();

  assert.equal(control.processingGeneration, before + 1);
  assert.equal(errors.length, 0);
});

test("close は世代を進める", async () => {
  // close 後の cancel 解決と再 start 後の新ループが同一世代を共有しないこと
  const { publisher, control, errors } = createLoopTestContext();
  const { encoder, isClosed } = createRecordingEncoder();
  control.audioEncoder = encoder as unknown as AudioEncoderWrapper;
  control.processingActive = true;

  const before = control.processingGeneration;
  await publisher.close();

  assert.equal(control.processingGeneration, before + 1);
  // エンコーダーの close まで到達すること
  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

/**
 * ライフサイクル全体の後片付け検証用の制御口
 *
 * stop / close / 失敗巻き戻しで残留しないことを参照 null で検証する。
 * start() 自体は接続を要するため、失敗巻き戻しは start 失敗時に
 * 使う資源破棄ヘルパーを private 経由で直接駆動する
 * (start() の catch 配線は別テストで検証する)。
 */
interface PublisherLifecycleControl extends PublisherLoopControl {
  session: Session | null;
  catalogPublisher: Publisher | null;
  audioPublisher: Publisher | null;
  videoPublisher: Publisher | null;
  // {} 代入のための緩和であり検証対象外である (実装型はプロセッサ型)
  audioTrackProcessor: unknown;
  videoFrameSource: VideoFrameSource | null;
  mediaStream: MediaStream | null;
  disposeAllResources(): Promise<void>;
}

/**
 * 破棄記録付きの最小 Publisher
 */
function createRecordingPublisher(): {
  publisher: Publisher;
  doneCount: () => number;
} {
  let count = 0;
  const publisher = {
    state: "active",
    done: async () => {
      count++;
    },
  } as unknown as Publisher;
  return { publisher, doneCount: () => count };
}

/**
 * 破棄記録付きの最小セッション
 */
function createRecordingSession(): {
  session: Session;
  isClosed: () => boolean;
} {
  let closed = false;
  const session = {
    close: async () => {
      closed = true;
    },
  } as unknown as Session;
  return { session, isClosed: () => closed };
}

/**
 * 破棄記録付きの最小 VideoFrameSource
 */
function createRecordingFrameSource(): {
  source: VideoFrameSource;
  isClosed: () => boolean;
} {
  let closed = false;
  const stream = new ReadableStream<VideoFrame>();
  const source: VideoFrameSource = {
    readable: stream,
    close: () => {
      closed = true;
    },
  };
  return { source, isClosed: () => closed };
}

test("stop は encoder・source・processor・Publisher・session を残さない", async () => {
  // start / stop 繰り返しでリークしないことの検証。全種のリソースを注入し、
  // stop() 後に参照が null 化され破棄が呼ばれていることを確認する
  const { publisher, control } = createLoopTestContext();
  const lifecycle = control as unknown as PublisherLifecycleControl;
  const { isEncoderClosed: isAudioEncoderClosed } = injectAudioLoop(control);
  const { isEncoderClosed: isVideoEncoderClosed } = injectVideoLoop(control);
  const { session, isClosed: isSessionClosed } = createRecordingSession();
  const { publisher: catalogPublisher, doneCount: catalogDoneCount } = createRecordingPublisher();
  const { publisher: audioPublisher, doneCount: audioDoneCount } = createRecordingPublisher();
  const { publisher: videoPublisher, doneCount: videoDoneCount } = createRecordingPublisher();
  const { source, isClosed: isSourceClosed } = createRecordingFrameSource();
  lifecycle.session = session;
  lifecycle.catalogPublisher = catalogPublisher;
  lifecycle.audioPublisher = audioPublisher;
  lifecycle.videoPublisher = videoPublisher;
  lifecycle.videoFrameSource = source;
  lifecycle.audioTrackProcessor = {};
  lifecycle.mediaStream = {} as MediaStream;

  await publisher.stop();

  // 参照が残らないこと
  assert.isNull(lifecycle.session);
  assert.isNull(lifecycle.catalogPublisher);
  assert.isNull(lifecycle.audioPublisher);
  assert.isNull(lifecycle.videoPublisher);
  assert.isNull(lifecycle.audioEncoder);
  assert.isNull(lifecycle.videoEncoder);
  assert.isNull(lifecycle.videoFrameSource);
  assert.isNull(lifecycle.audioTrackProcessor);
  assert.isNull(lifecycle.audioFrameReader);
  assert.isNull(lifecycle.videoFrameReader);
  // 破棄が呼ばれていること
  assert.isTrue(isSessionClosed());
  assert.equal(catalogDoneCount(), 1);
  assert.equal(audioDoneCount(), 1);
  assert.equal(videoDoneCount(), 1);
  assert.isTrue(isSourceClosed());
  assert.isTrue(isAudioEncoderClosed());
  assert.isTrue(isVideoEncoderClosed());
  assert.isNull(lifecycle.mediaStream);
  assert.isFalse(control.processingActive);
  assert.equal(publisher.state, "stopped");
});

test("close は stop と同一破棄を行い以後 start 不可の終端にする", async () => {
  // close が stop を内包することと、終端後に再 start できないことの検証
  const { publisher, control } = createLoopTestContext();
  const lifecycle = control as unknown as PublisherLifecycleControl;
  injectAudioLoop(control);
  const { session, isClosed: isSessionClosed } = createRecordingSession();
  const { publisher: catalogPublisher, doneCount: catalogDoneCount } = createRecordingPublisher();
  lifecycle.session = session;
  lifecycle.catalogPublisher = catalogPublisher;

  await publisher.close();

  assert.isNull(lifecycle.session);
  assert.isNull(lifecycle.catalogPublisher);
  assert.isNull(lifecycle.audioEncoder);
  assert.isNull(lifecycle.audioFrameReader);
  assert.isTrue(isSessionClosed());
  assert.equal(catalogDoneCount(), 1);
  assert.equal(publisher.state, "closed");

  // 終端後の start は拒否されること
  let startError: unknown = null;
  try {
    await publisher.start({} as MediaStream);
  } catch (error) {
    startError = error;
  }
  assert.instanceOf(startError, Error);
});

test("資源破棄ヘルパー直接駆動では確保済みを破棄し state を変えない", async () => {
  // start() 自体は接続を要するため、start 失敗時に使う資源破棄ヘルパーを
  // 部分確保状態で直接駆動し、巻き戻りと再 start 可能状態を検証する
  // (start() の catch 配線は別テストで検証する)
  const { publisher, control } = createLoopTestContext();
  const lifecycle = control as unknown as PublisherLifecycleControl;
  lifecycle.currentState = "stopped";
  const { session, isClosed: isSessionClosed } = createRecordingSession();
  const { publisher: catalogPublisher, doneCount: catalogDoneCount } = createRecordingPublisher();
  const { encoder } = createRecordingEncoder();
  lifecycle.session = session;
  lifecycle.catalogPublisher = catalogPublisher;
  lifecycle.audioEncoder = encoder as unknown as AudioEncoderWrapper;

  await lifecycle.disposeAllResources();

  assert.isNull(lifecycle.session);
  assert.isNull(lifecycle.catalogPublisher);
  assert.isNull(lifecycle.audioEncoder);
  assert.isTrue(isSessionClosed());
  assert.equal(catalogDoneCount(), 1);
  // 失敗後の state は変わらず再 start 可能であること
  assert.equal(publisher.state, "stopped");
});

test("start 失敗時は巻き戻し・通知・再 throw を行い state を変えない", async () => {
  // start() の catch 配線自体の検証。node 環境に WebTransport がないため
  // connect 失敗で catch に入り、巻き戻し・onError 通知・再 throw を通る
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );

  let thrown: unknown = null;
  try {
    await publisher.start({} as MediaStream);
  } catch (error) {
    thrown = error;
  }

  assert.isTrue(thrown instanceof Error);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  assert.equal(publisher.state, "created");
  // 巻き戻しを通ったこと (mediaStream の null 化で観測する)
  const lifecycle = publisher as unknown as { mediaStream: MediaStream | null };
  assert.isNull(lifecycle.mediaStream);
});

test("破棄段階の失敗は後続を止めず最初の失敗を throw し旧 state が残る", async () => {
  // guard 集約パスの検証。catalog の done 失敗でも session 等の破棄は継続し、
  // 参照は切り離され、state は旧来のまま残り再試行できることを確認する
  const { publisher, control } = createLoopTestContext();
  const lifecycle = control as unknown as PublisherLifecycleControl;
  const catalogFailure = new Error("catalog done failure");
  const rejectingCatalog = {
    state: "active",
    done: async () => {
      throw catalogFailure;
    },
  } as unknown as Publisher;
  const { publisher: audioPublisher, doneCount: audioDoneCount } = createRecordingPublisher();
  const { session, isClosed: isSessionClosed } = createRecordingSession();
  lifecycle.catalogPublisher = rejectingCatalog;
  lifecycle.audioPublisher = audioPublisher;
  lifecycle.session = session;

  let thrown: unknown = null;
  try {
    await publisher.stop();
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, catalogFailure);
  // 失敗段階以降も破棄が継続し参照が残らないこと
  assert.equal(audioDoneCount(), 1);
  assert.isTrue(isSessionClosed());
  assert.isNull(lifecycle.catalogPublisher);
  assert.isNull(lifecycle.audioPublisher);
  assert.isNull(lifecycle.session);
  // 旧 state のまま残るため再試行できること
  assert.equal(publisher.state, "publishing");
  await publisher.stop();
  assert.equal(publisher.state, "stopped");
});

test("直列の二重 close は単発で終わり onClose は 1 回だけ発火する", async () => {
  // 終端契約の検証。二重 close の早期 return と通知の単発性を確認する
  let closeCount = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onClose: () => {
        closeCount++;
      },
    },
  );

  await publisher.close();
  await publisher.close();

  assert.equal(publisher.state, "closed");
  assert.equal(closeCount, 1);
});
