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
 *
 * グループ管理 (allocateAudioObject / allocateVideoObject) とキーフレーム判定
 * (resolveKeyframeInterval / shouldSendKeyFrame)、Publisher Priority の定数は
 * 純関数として切り出しており、固定値で直接駆動する。
 */

import { test, assert } from "vite-plus/test";
import {
  MediaPublisherImpl,
  PRIORITY_AUDIO,
  PRIORITY_VIDEO_DELTA,
  PRIORITY_VIDEO_KEY,
  allocateAudioObject,
  allocateInitialGroupId,
  allocateVideoObject,
  resolveKeyframeInterval,
  shouldSendKeyFrame,
  type VideoGroupState,
} from "./createMediaPublisher";
import type { AudioEncoderWrapper } from "./codec/AudioEncoder";
import type { VideoEncoderWrapper } from "./codec/VideoEncoder";
import type { MediaPublisherState } from "./codec/types";
import type { VideoFrameSource } from "./frameSource";
import type { Publisher } from "./publisher";
import type { Session } from "./session";
import * as LOC from "./loc";

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

/**
 * Group ID 初期値の検証用の制御口
 */
interface PublisherGroupControl {
  audioGroupId: number;
  videoGroupId: number;
  audioPublisher: Publisher | null;
  videoPublisher: Publisher | null;
  handleAudioEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void;
  handleVideoEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void;
}

/**
 * 送信 Group ID 記録用の最小 Publisher
 */
function createRecordingSendPublisher(): {
  publisher: Publisher;
  sent: { groupId: number; objectId: number }[];
} {
  const sent: { groupId: number; objectId: number }[] = [];
  const publisher = {
    state: "active",
    sendObject: (params: { groupId: number; objectId: number }) => {
      sent.push({ groupId: params.groupId, objectId: params.objectId });
    },
  } as unknown as Publisher;
  return { publisher, sent };
}

test("初期 Group ID 生成は前回値を下回らない", () => {
  // 時刻依存は固定値で検証する。実時刻由来の確保が先行しても単調性は保たれる
  const first = allocateInitialGroupId(100);
  const second = allocateInitialGroupId(50);
  assert.equal(second, first + 1);
});

test("初期 Group ID 生成は非有限値を拒否する", () => {
  // 共有カウンタの汚染を防ぐための検証。拒否後に正常割当てを行い、
  // 単調性が壊れていないことも確認する
  const before = allocateInitialGroupId(200);
  for (const candidate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    let thrown: unknown = null;
    try {
      allocateInitialGroupId(candidate);
    } catch (error) {
      thrown = error;
    }
    assert.isTrue(thrown instanceof Error);
  }
  assert.equal(allocateInitialGroupId(100), before + 1);
});

test("新規インスタンスの開始 Group ID は前回を上回る", () => {
  // 同一 track の再 publish が 0 に戻らないことの検証
  const options = {
    namespace: ["live"],
    audio: { codec: "opus" as const, bitrate: 64000 },
    video: { codec: "vp8" as const, bitrate: 1000000 },
  };
  const first = new MediaPublisherImpl("moqt://example.com/live", options);
  const second = new MediaPublisherImpl("moqt://example.com/live", options);
  const firstGroups = first as unknown as { audioGroupId: number; videoGroupId: number };
  const secondGroups = second as unknown as { audioGroupId: number; videoGroupId: number };
  assert.isTrue(firstGroups.audioGroupId > 1_000_000_000_000);
  assert.isTrue(secondGroups.audioGroupId > firstGroups.audioGroupId);
  assert.isTrue(secondGroups.videoGroupId > firstGroups.videoGroupId);
});

test("音声・映像とも初回送信値は初期値である", () => {
  // 初回送信値が初期値 T に統一されることの検証。
  // 割当てから送信までの結合を見るため audio / video 付きで構築する
  const publisher = new MediaPublisherImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" as const, bitrate: 64000 },
    video: { codec: "vp8" as const, bitrate: 1000000 },
  });
  const control = publisher as unknown as PublisherGroupControl;
  const { publisher: audioPublisher, sent: audioSent } = createRecordingSendPublisher();
  const { publisher: videoPublisher, sent: videoSent } = createRecordingSendPublisher();
  control.audioPublisher = audioPublisher;
  control.videoPublisher = videoPublisher;
  const initialAudio = control.audioGroupId;
  const initialVideo = control.videoGroupId;

  control.handleAudioEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  control.handleVideoEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });

  assert.equal(audioSent[0].groupId, initialAudio);
  assert.equal(audioSent[0].objectId, 0);
  assert.equal(videoSent[0].groupId, initialVideo);
  assert.equal(videoSent[0].objectId, 0);

  // 音声は LOC draft-ietf-moq-loc-04 §4.1 に従いフレームごとに Group が進み、
  // Object ID は常に 0 のまま
  control.handleAudioEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  assert.equal(audioSent[1].groupId, initialAudio + 1);
  assert.equal(audioSent[1].objectId, 0);

  // 2 回目以降の key で加算されること
  control.handleVideoEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  assert.equal(videoSent[1].groupId, initialVideo + 1);
  assert.equal(videoSent[1].objectId, 0);
});

test("新規割当ては送信済み最大値を上回る", () => {
  // 送信加算を進めた後に新規割当てを行い、前回送信最大値を上回ることの検証
  const publisher = new MediaPublisherImpl("moqt://example.com/live", {
    namespace: ["live"],
    video: { codec: "vp8" as const, bitrate: 1000000 },
  });
  const control = publisher as unknown as PublisherGroupControl;
  const { publisher: videoPublisher, sent: videoSent } = createRecordingSendPublisher();
  control.videoPublisher = videoPublisher;
  const initialVideo = control.videoGroupId;
  // video のみの構成では audio 側を採番しないこと
  assert.equal(control.audioGroupId, 0);

  control.handleVideoEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  control.handleVideoEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  assert.equal(videoSent[1].groupId, initialVideo + 1);

  assert.equal(allocateInitialGroupId(1), initialVideo + 2);
});

test("未使用 track は Group ID を採番しない", () => {
  // 条件付き割当ての分岐の検証。未使用 track は 0 のまま送信されない
  const publisher = new MediaPublisherImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: { codec: "opus" as const, bitrate: 64000 },
  });
  const control = publisher as unknown as PublisherGroupControl;
  assert.isTrue(control.audioGroupId > 0);
  assert.equal(control.videoGroupId, 0);
});

/**
 * draft-ietf-moq-loc-04 §2.3.2.1 (Video Config):
 * encoder が返す description (avcC / hvcC などの extradata) が VIDEO_CONFIG として
 * 送られることを検証する。description は keyframe の metadata にのみ現れるため、
 * 同じ値は再送せず、変化したときだけ載せる。
 */
function createCapturingPublisher(): {
  publisher: Publisher;
  sent: Array<{ properties?: Uint8Array }>;
} {
  const sent: Array<{ properties?: Uint8Array }> = [];
  const publisher = {
    state: "active",
    sendObject: async (params: { properties?: Uint8Array }) => {
      sent.push(params);
    },
  } as unknown as Publisher;
  return { publisher, sent };
}

/** Video Config の description を含む chunk を handleVideoEncodedChunk に流す */
function sendVideoChunk(control: PublisherLifecycleControl, description?: Uint8Array): void {
  const handler = (
    control as unknown as {
      handleVideoEncodedChunk(chunk: {
        data: Uint8Array;
        type: "key" | "delta";
        timestamp: number;
        duration: number | null;
        description?: Uint8Array;
      }): void;
    }
  ).handleVideoEncodedChunk.bind(control);
  handler({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 1000,
    duration: null,
    description,
  });
}

test("handleVideoEncodedChunk: description が VIDEO_CONFIG として送られる", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);

  assert.equal(sent.length, 1);
  const decoded = LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0));
  assert.deepEqual(decoded.config, description);
});

test("handleVideoEncodedChunk: 同じ description は再送しない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);
  sendVideoChunk(control, new Uint8Array(description));

  assert.equal(sent.length, 2);
  // 1 件目だけが VIDEO_CONFIG を持ち、2 件目は持たない
  assert.deepEqual(
    LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isUndefined(LOC.decodeVideoProperties(sent[1].properties ?? new Uint8Array(0)).config);
});

test("handleVideoEncodedChunk: description が変わったら再送する", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  const first = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  const second = new Uint8Array([0x01, 0x42, 0xc0, 0x2a]);
  sendVideoChunk(control, first);
  sendVideoChunk(control, second);

  assert.deepEqual(
    LOC.decodeVideoProperties(sent[1].properties ?? new Uint8Array(0)).config,
    second,
  );
});

test("handleVideoEncodedChunk: description が無い chunk は VIDEO_CONFIG を載せない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  sendVideoChunk(control);

  assert.isUndefined(LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0)).config);
});

/**
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
 * encoder が返す description (AAC の AudioSpecificConfig) が AUDIO_CONFIG として
 * 送られることを検証する。映像の VIDEO_CONFIG と同じ扱いで、同じ値は再送しない。
 */
function sendAudioChunk(control: PublisherLifecycleControl, description?: Uint8Array): void {
  const handler = (
    control as unknown as {
      handleAudioEncodedChunk(chunk: {
        data: Uint8Array;
        type: "key" | "delta";
        timestamp: number;
        duration: number | null;
        description?: Uint8Array;
      }): void;
    }
  ).handleAudioEncodedChunk.bind(control);
  handler({
    data: new Uint8Array([0xbb]),
    type: "key",
    timestamp: 1000,
    duration: null,
    description,
  });
}

test("handleAudioEncodedChunk: description が AUDIO_CONFIG として送られる", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  // AAC の AudioSpecificConfig 相当 (2 バイト)
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);

  assert.equal(sent.length, 1);
  const decoded = LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0));
  assert.deepEqual(decoded.config, description);
});

test("handleAudioEncodedChunk: 同じ description は再送しない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);
  sendAudioChunk(control, new Uint8Array(description));

  assert.equal(sent.length, 2);
  assert.deepEqual(
    LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isUndefined(LOC.decodeAudioProperties(sent[1].properties ?? new Uint8Array(0)).config);
});

test("handleAudioEncodedChunk: description が変わったら再送する", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  const first = new Uint8Array([0x11, 0x90]);
  const second = new Uint8Array([0x11, 0x88]);
  sendAudioChunk(control, first);
  sendAudioChunk(control, second);

  assert.deepEqual(
    LOC.decodeAudioProperties(sent[1].properties ?? new Uint8Array(0)).config,
    second,
  );
});

test("handleAudioEncodedChunk: description が無い chunk は AUDIO_CONFIG を載せない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  sendAudioChunk(control);

  assert.isUndefined(LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0)).config);
});

/**
 * グループ管理とキーフレーム判定の純関数
 *
 * MediaPublisherImpl から切り出した払い出しロジックと判定ロジックを、実装クラスや
 * 構造の注入を介さず固定値で直接駆動する。Group ID が進む条件と Object ID が
 * 0 に戻る条件、キーフレーム間隔の解決と境界、Publisher Priority の値を固定する。
 */

test("resolveKeyframeInterval: 映像オプションが無ければ既定 framerate の 2 倍になる", () => {
  // framerate の既定値 30 から 60 を導出することの検証 (映像を配信しない場合も同じ値)
  assert.equal(resolveKeyframeInterval(undefined), 60);
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000 }), 60);
});

test("resolveKeyframeInterval: framerate 指定時はその 2 倍になる", () => {
  // 既定値ではなく指定した framerate から間隔を導出することの検証
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, framerate: 25 }), 50);
});

test("resolveKeyframeInterval: keyframeInterval 指定時は framerate より優先する", () => {
  // 明示指定が framerate 由来の既定を上書きすることの検証
  assert.equal(
    resolveKeyframeInterval({
      codec: "vp8",
      bitrate: 1000000,
      framerate: 25,
      keyframeInterval: 15,
    }),
    15,
  );
  // framerate 未指定でも明示指定を尊重すること
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, keyframeInterval: 1 }), 1);
});

test("shouldSendKeyFrame: フレーム番号 0 はキーフレームになる", () => {
  // 初回フレームと requestKeyframe() 直後 (フレーム番号を 0 に戻す) が
  // キーフレームになることの検証
  assert.isTrue(shouldSendKeyFrame(0, 60));
  assert.isTrue(shouldSendKeyFrame(0, 1));
});

test("shouldSendKeyFrame: 間隔の倍数の前後でキーフレーム判定が切り替わる", () => {
  // 間隔 60 の境界 (59 / 60 / 61) と 2 周期目 (120) を固定する
  assert.isFalse(shouldSendKeyFrame(59, 60));
  assert.isTrue(shouldSendKeyFrame(60, 60));
  assert.isFalse(shouldSendKeyFrame(61, 60));
  assert.isFalse(shouldSendKeyFrame(119, 60));
  assert.isTrue(shouldSendKeyFrame(120, 60));
});

test("allocateAudioObject: 初回フレームは割当済みの初期 Group の Object ID 0 になる", () => {
  // LOC draft-ietf-moq-loc-04 §4.1 (Application with one audio track) は音声 chunk 1 つを
  // Object 1 つ・Group 1 つに対応させる。初回フレームは割当済みの初期 Group ID を
  // そのまま使い、Object ID は 0 になる
  const first = allocateAudioObject({ groupId: 1000, started: false });
  assert.equal(first.groupId, 1000);
  assert.equal(first.objectId, 0);
  assert.isFalse(first.groupAdvanced);
  assert.deepEqual(first.state, { groupId: 1000, started: true });
});

test("allocateAudioObject: 2 回目以降はフレームごとに Group が進み Object ID は 0 のまま", () => {
  // 音声 chunk ごとに新しい Group を開始し、Object ID を常に 0 にすることの検証。
  // 直前の Group ID を引き継がず +1 される
  const second = allocateAudioObject({ groupId: 1000, started: true });
  assert.equal(second.groupId, 1001);
  assert.equal(second.objectId, 0);
  assert.isTrue(second.groupAdvanced);
  assert.deepEqual(second.state, { groupId: 1001, started: true });

  // 返り値の state を再度渡しても Group ID が単調に増え続ける
  const third = allocateAudioObject(second.state);
  assert.equal(third.groupId, 1002);
  assert.equal(third.objectId, 0);
  assert.isTrue(third.groupAdvanced);
  assert.deepEqual(third.state, { groupId: 1002, started: true });
});

test("allocateVideoObject: 初回キーフレームは割当済みの初期 Group の Object ID 0 になる", () => {
  // 初回オブジェクトは Group を加算せず初期値を送ることの検証
  const first = allocateVideoObject({ groupId: 1000, objectId: 0, started: false }, true);
  assert.equal(first.groupId, 1000);
  assert.equal(first.objectId, 0);
  assert.isFalse(first.groupAdvanced);
  assert.deepEqual(first.state, { groupId: 1000, objectId: 1, started: true });
});

test("allocateVideoObject: 差分フレームは Group を進めず Object ID だけ進める", () => {
  // キーフレーム以外では Group が変わらず、同じ Group 内で Object ID が
  // インクリメントされることの検証
  const delta = allocateVideoObject({ groupId: 1000, objectId: 1, started: true }, false);
  assert.equal(delta.groupId, 1000);
  assert.equal(delta.objectId, 1);
  assert.isFalse(delta.groupAdvanced);
  assert.deepEqual(delta.state, { groupId: 1000, objectId: 2, started: true });
});

test("allocateVideoObject: 2 回目以降のキーフレームで Group が進み Object ID が 0 に戻る", () => {
  // 開始済みの状態で届いたキーフレームが Group ID を +1 し、Object ID を
  // 0 から振り直すことの検証
  const key = allocateVideoObject({ groupId: 1000, objectId: 5, started: true }, true);
  assert.equal(key.groupId, 1001);
  assert.equal(key.objectId, 0);
  assert.isTrue(key.groupAdvanced);
  assert.deepEqual(key.state, { groupId: 1001, objectId: 1, started: true });
});

test("allocateVideoObject: 差分フレームだけでは Group を進めない", () => {
  // キーフレームが来ない限り Group が進まないことの検証
  // (差分フレームを複数送っても Group は初期値のまま)
  let state: VideoGroupState = { groupId: 1000, objectId: 0, started: false };
  for (let frame = 0; frame < 3; frame++) {
    const allocation = allocateVideoObject(state, false);
    assert.equal(allocation.groupId, 1000);
    assert.isFalse(allocation.groupAdvanced);
    state = allocation.state;
  }
  assert.deepEqual(state, { groupId: 1000, objectId: 3, started: true });
});

test("allocateVideoObject: 差分フレームが先行した場合の初回キーフレームは Group を進める", () => {
  // 実運用経路は初回をキーフレームで要求するが、差分フレームが先行した場合は
  // 開始済みになるため、初回キーフレームが初期値 + 1 の Group になることの検証
  const delta = allocateVideoObject({ groupId: 1000, objectId: 0, started: false }, false);
  assert.isFalse(delta.groupAdvanced);

  const key = allocateVideoObject(delta.state, true);
  assert.equal(key.groupId, 1001);
  assert.equal(key.objectId, 0);
  assert.isTrue(key.groupAdvanced);
});

test("Publisher Priority の定数はドキュメントの値である", () => {
  // docs/HIGH_LEVEL_API.md の Priority 表の値 (音声 192 / 映像キーフレーム 255 /
  // 映像差分 128) を固定する
  assert.equal(PRIORITY_AUDIO, 192);
  assert.equal(PRIORITY_VIDEO_KEY, 255);
  assert.equal(PRIORITY_VIDEO_DELTA, 128);
});
