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
 * (resolveKeyframeInterval / shouldSendKeyFrame)、Publisher Priority の定数と送信値、
 * Audio Config の再送判断 (resolveAudioConfigToSend) は純関数として切り出しており、
 * 固定値で直接駆動する。
 * Audio Config の再送は Forward State 変化のコールバック登録から
 * handleAudioEncodedChunk までを、publish 呼び出しを記録する最小セッションを
 * 注入して結合で検証する。
 * encode キューの閾値超過による破棄と droppedFrames の加算も検証する。
 */

import { test, assert } from "vite-plus/test";
import type { MediaPublisherOptions } from "./createMediaPublisher";
import {
  MediaPublisherImpl,
  PRIORITY_AUDIO,
  PRIORITY_CATALOG,
  PRIORITY_VIDEO_DELTA,
  PRIORITY_VIDEO_KEY,
  allocateAudioObject,
  allocateInitialGroupId,
  allocateVideoObject,
  resolveAudioConfigToSend,
  resolveKeyframeInterval,
  shouldSendKeyFrame,
  VIDEO_PUBLISH_OPTIONS,
  type VideoGroupState,
} from "./createMediaPublisher";
import type { AudioEncoderWrapper } from "./codec/AudioEncoder";
import type { VideoEncoderWrapper } from "./codec/VideoEncoder";
import type { MediaPublisherState } from "./codec/types";
import { resolveAudioPublishSettings, resolveVideoPublishSettings } from "./createMedia/settings";
import type {
  ResolvedAudioPublishSettings,
  ResolvedVideoPublishSettings,
} from "./createMedia/settings";
import type { VideoFrameSource } from "./frameSource";
import { CATALOG_TRACK_NAME, decodeCatalogMessage } from "./msf";
import type { Publisher } from "./publisher";
import type { PublishCallbacks, Session } from "./session";
import * as LOC from "./loc";
import { WallClockMapper } from "./mediaClock";

/**
 * 破棄検出付きのテスト用フレーム
 */
interface TestFrame {
  closed: boolean;
  // VideoFrame / AudioData の timestamp (マイクロ秒)
  timestamp: number;
  close(): void;
}

function createTestFrame(timestamp = 0): TestFrame {
  const frame: TestFrame = {
    closed: false,
    timestamp,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
}

/**
 * encode 呼び出し記録用の最小エンコーダー
 */
function createRecordingEncoder(encodeQueueSize = 0): {
  encoded: unknown[];
  keyFrames: boolean[];
  isClosed: () => boolean;
  encoder: {
    state: string;
    encodeQueueSize: number;
    encode: (frame: unknown, options?: { keyFrame?: boolean }) => void;
    close: () => void;
  };
} {
  const encoded: unknown[] = [];
  // encode ごとのキーフレームの指定 (encoded と同じ並び)
  const keyFrames: boolean[] = [];
  let closed = false;
  return {
    encoded,
    keyFrames,
    isClosed: () => closed,
    encoder: {
      state: "configured",
      // 閾値超過 (2 超) を固定するため引数で差し替えられるようにする
      encodeQueueSize,
      encode: (frame: unknown, options?: { keyFrame?: boolean }) => {
        encoded.push(frame);
        keyFrames.push(options?.keyFrame === true);
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
  requestKeyframe(): void;
  // 読んだ映像フレームの timestamp を壁時計に換算する
  videoWallClock: WallClockMapper;
}

function createLoopTestContext(options?: { video?: NonNullable<MediaPublisherOptions["video"]> }): {
  publisher: MediaPublisherImpl;
  control: PublisherLoopControl;
  errors: Error[];
} {
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"], ...(options?.video === undefined ? {} : { video: options.video }) },
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

function injectVideoLoop(
  control: PublisherLoopControl,
  encodeQueueSize = 0,
): {
  encoded: unknown[];
  keyFrames: boolean[];
  controller: ReadableStreamDefaultController<TestFrame>;
  isEncoderClosed: () => boolean;
} {
  const { stream, controller } = createFrameStream();
  const { encoder, encoded, keyFrames, isClosed } = createRecordingEncoder(encodeQueueSize);
  control.videoFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<VideoFrame>;
  control.videoEncoder = encoder as unknown as VideoEncoderWrapper;
  control.processingActive = true;
  return { encoded, keyFrames, controller, isEncoderClosed: isClosed };
}

test("processVideoFrames: encode キューの閾値 (2) を超えたフレームは破棄され droppedFrames に数える", async () => {
  // encodeQueueSize が 2 超の間は encode せず、フレームを閉じて破棄する (待たない)。
  // Worker モードでは encodeQueueSize が送信中のフレーム数になるため同じ判定で破棄される
  // 公開統計 (getStats) に droppedFrames が出ることを検証するため video 付きで作る
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000 },
  });
  // 3 > 2 のため全フレームが破棄対象になる
  const { encoded, controller } = injectVideoLoop(control, 3);

  const loop = control.processVideoFrames();
  const first = createTestFrame();
  const second = createTestFrame();
  controller.enqueue(first);
  controller.enqueue(second);
  // 破棄の記録後にストリームを閉じる (両者とも microtask のため確定的)
  await Promise.resolve();
  await Promise.resolve();
  controller.close();
  await loop;

  // encode は呼ばれず、両フレームとも閉じられる
  assert.equal(encoded.length, 0);
  assert.isTrue(first.closed);
  assert.isTrue(second.closed);
  assert.equal(errors.length, 0);
  assert.equal(publisher.getStats().video?.droppedFrames, 2);
});

test("processVideoFrames: encode キューの閾値以内なら破棄せず encode する", async () => {
  // 2 <= 2 のため破棄しない (droppedFrames は増えない)
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000 },
  });
  const { encoded, controller } = injectVideoLoop(control, 2);

  const loop = control.processVideoFrames();
  const frame = createTestFrame();
  controller.enqueue(frame);
  await Promise.resolve();
  await Promise.resolve();
  controller.close();
  await loop;

  assert.equal(encoded.length, 1);
  assert.strictEqual(encoded[0], frame);
  assert.isTrue(frame.closed);
  assert.equal(errors.length, 0);
  assert.equal(publisher.getStats().video?.droppedFrames, 0);
});

/**
 * draft-ietf-moq-transport-21 §10.6 / §9.20.20: 映像トラックは DYNAMIC_GROUPS=1 を広告し、
 * 購読者が NEW_GROUP_REQUEST で新しい Group を要求できるようにする
 */
test("VIDEO_PUBLISH_OPTIONS: 映像トラックは DYNAMIC_GROUPS を広告する", () => {
  assert.isTrue(VIDEO_PUBLISH_OPTIONS.dynamicGroups);
});

/**
 * draft-ietf-moq-transport-21 §9.20.20: NEW_GROUP_REQUEST を受けた publisher は、現在の Group を
 * 終えて新しい Group をできるだけ早く始める SHOULD。映像は onNewGroupRequest から
 * requestKeyframe() を呼び、次に符号化するフレームをキーフレーム (新しい Group の先頭) にする。
 * キーフレームの間隔 60 の途中 (3 枚目) で要求を受けると、4 枚目がキーフレームになり、
 * 以降は要求の後から数えた間隔に戻る
 */
test("processVideoFrames: 新しい Group の要求を受けると次のフレームをキーフレームにする", async () => {
  const { control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000, keyframeInterval: 60 },
  });
  const { keyFrames, controller } = injectVideoLoop(control);
  const loop = control.processVideoFrames();
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  for (let index = 0; index < 3; index++) {
    controller.enqueue(createTestFrame(index));
    await settle();
  }
  // PublishCallbacks.onNewGroupRequest と同じく requestKeyframe() を呼ぶ
  control.requestKeyframe();
  for (let index = 3; index < 6; index++) {
    controller.enqueue(createTestFrame(index));
    await settle();
  }
  controller.close();
  await loop;

  assert.deepEqual(keyFrames, [true, false, false, true, false, false]);
  assert.equal(errors.length, 0);
});

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

// draft-ietf-moq-loc-04 §2.3.1.1: Timescale を載せない TIMESTAMP は Unix epoch の壁時計である。
// VideoFrame の timestamp は取得元ごとに基準が異なる (canvas の captureStream() は stream の
// 開始、fake camera は別の大きな値) ため、読んだフレームの timestamp とそのときの壁時計を
// 記録し、換算に使う (撮ってから読むまでの遅れが最も小さいフレームに合わせる)
test("processVideoFrames: 読んだフレームの timestamp とそのときの壁時計を記録する", async () => {
  const { control } = createLoopTestContext({ video: { codec: "vp8", bitrate: 1000 } });
  const { controller } = injectVideoLoop(control);
  // 記録が無ければ換算できない
  assert.throws(() => control.videoWallClock.toWallClockMicroseconds(0));

  const before = performance.timeOrigin + performance.now();
  const loop = control.processVideoFrames();
  // fake camera 相当の大きな基準のフレーム
  controller.enqueue(createTestFrame(289_052_241_600));
  controller.enqueue(createTestFrame(289_052_274_933));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  controller.close();
  await loop;
  const after = performance.timeOrigin + performance.now();

  // 2 枚を同じころに読んだため、読んだときの壁時計と timestamp の差は 2 枚目の方が小さい。
  // 2 枚目の timestamp は、2 枚目を読んだ時刻に換算される
  const converted = Number(control.videoWallClock.toWallClockMicroseconds(289_052_274_933));
  assert.isAtLeast(converted, Math.floor(before * 1000));
  assert.isAtMost(converted, Math.ceil(after * 1000));
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
  // Forward State が 0 から 1 になった時点で立つ Audio Config の送り直し要求
  audioConfigResendRequested: boolean;
  // 直前に AUDIO_CONFIG として送った description (session を跨いで保持しない)
  lastSentAudioConfig: Uint8Array | null;
  // 直前に VIDEO_CONFIG として送った description
  lastSentVideoConfig: Uint8Array | null;
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
  // 破棄では session に紐づく Audio Config の保持値と要求を必ず忘れる。
  // 段階破棄が失敗しても忘れ漏らさないことを確認する
  lifecycle.lastSentAudioConfig = new Uint8Array([0x11, 0x90]);
  lifecycle.audioConfigResendRequested = true;

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
  assert.isNull(lifecycle.lastSentAudioConfig);
  assert.isFalse(lifecycle.audioConfigResendRequested);
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
 * 送信 Group / Object ID と Priority の記録用の最小 Publisher
 */
function createRecordingSendPublisher(): {
  publisher: Publisher;
  sent: { groupId: number; objectId: number; priority?: number }[];
} {
  const sent: { groupId: number; objectId: number; priority?: number }[] = [];
  const publisher = {
    state: "active",
    sendObject: (params: { groupId: number; objectId: number; priority?: number }) => {
      sent.push({
        groupId: params.groupId,
        objectId: params.objectId,
        priority: params.priority,
      });
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
    done: async () => {
      // 破棄は no-op (購読の無いテストでは書き込み完了を待つ対象が無い)
    },
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

// 映像の TIMESTAMP は、読んだフレームの壁時計との対応から換算する。timeOrigin に
// timestamp を足すと、canvas では stream の開始までの時間だけ古く、fake camera では
// 約 80 時間先の時刻になる
test("handleVideoEncodedChunk: TIMESTAMP を読んだフレームとの対応から壁時計に換算する", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;
  // timestamp 0 のフレームを 2026-09-25 付近の壁時計に読んだ
  control.videoWallClock.observe(0, 1_790_263_445_102.099);

  // sendVideoChunk は timestamp 1000 (マイクロ秒) の chunk を送る
  sendVideoChunk(control);

  assert.equal(sent.length, 1);
  const decoded = LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0));
  assert.equal(decoded.timestamp, 1_790_263_445_103_099n);
  // 壁時計として送るため Timescale は載せない
  assert.isUndefined(decoded.timescale);
});

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
 * 送られることを検証する。同じ値の重複送出は避けるが、Forward State が 0 から 1 に
 * なった時点の送り直し要求には同じ値でも 1 度だけ応じる。
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
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
 * 後から接続した購読者 (Forward State が 0 から 1 になった時点) のために、
 * 保持している Audio Config を次の Object に載せ直す契約を検証する。
 * 音声にはキーフレームが無いため、description の再出現では送り直せない。
 */
test("handleAudioEncodedChunk: 送り直し要求で保持している Audio Config を 1 Object 載せ直す", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  // 最初の chunk で Audio Config を送って保持する
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);

  // Forward State が 1 になった時点で立つ要求を再現する
  control.audioConfigResendRequested = true;
  sendAudioChunk(control);

  // 載せ直しは 1 Object に限る (要求は載せた時点で解消する)
  sendAudioChunk(control);

  assert.equal(sent.length, 3);
  assert.deepEqual(
    LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.deepEqual(
    LOC.decodeAudioProperties(sent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isUndefined(LOC.decodeAudioProperties(sent[2].properties ?? new Uint8Array(0)).config);
  assert.isFalse(control.audioConfigResendRequested);
});

test("handleAudioEncodedChunk: 保持値が無いまま要求されても次の description で載せる", () => {
  // Forward State が 1 になった時点で Audio Config をまだ持っていない場合でも、
  // 要求を捨てずに次の description で載せられることの検証
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  control.audioConfigResendRequested = true;
  sendAudioChunk(control);
  // 保持値が無いため要求は残る
  assert.isTrue(control.audioConfigResendRequested);
  assert.isUndefined(LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0)).config);

  // 次の description が現れた時点で載り、要求は解消する
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);
  assert.deepEqual(
    LOC.decodeAudioProperties(sent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isFalse(control.audioConfigResendRequested);
});

test("handleAudioEncodedChunk: stop 後の再開では同じ description でも AUDIO_CONFIG を載せる", async () => {
  // stop → start は新しい session と encoder を作るため、購読者は誰も前の
  // AUDIO_CONFIG を受け取っていない。保持値を破棄していないと新しい encoder の
  // description が同じ値として抑止され、再開後の購読者が AAC を復号できない。
  // 公開 stop() で破棄を駆動し (start() 自体は接続を要する)、
  // 再開後に同じ description が載ることを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: firstPublisher, sent: firstSent } = createCapturingPublisher();
  control.audioPublisher = firstPublisher;

  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);
  assert.deepEqual(
    LOC.decodeAudioProperties(firstSent[0].properties ?? new Uint8Array(0)).config,
    description,
  );

  // stop では session に紐づく Audio Config の保持値と要求を忘れる
  await publisher.stop();
  assert.equal(publisher.state, "stopped");
  assert.isNull(control.lastSentAudioConfig);
  assert.isFalse(control.audioConfigResendRequested);

  // 再開後 (新しい publisher) に同じ description が届いたら初出として載る
  const { publisher: resumedPublisher, sent: resumedSent } = createCapturingPublisher();
  control.audioPublisher = resumedPublisher;
  sendAudioChunk(control, new Uint8Array(description));

  assert.equal(resumedSent.length, 1);
  assert.deepEqual(
    LOC.decodeAudioProperties(resumedSent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
});

test("handleAudioEncodedChunk: publisher が active でない間は保持値も要求も変えない", () => {
  // 送信できない間に届いた chunk で保持値や要求を書き換えると、購読者が接続したのに
  // AUDIO_CONFIG を送り直せなくなる。入口ガードで何も変えないことを確認する。
  // 新しい description を渡すため、ガードが無ければ保持値の更新と要求の解消が起きる
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  // 送信できない状態 (active 以外) を作る
  (audioPublisher as unknown as { state: string }).state = "closed";
  control.audioPublisher = audioPublisher;
  const retained = new Uint8Array([0x11, 0x90]);
  control.lastSentAudioConfig = new Uint8Array(retained);
  control.audioConfigResendRequested = true;

  sendAudioChunk(control, new Uint8Array([0x12, 0x08]));

  assert.equal(sent.length, 0);
  assert.isTrue(control.audioConfigResendRequested);
  assert.deepEqual(control.lastSentAudioConfig, retained);
});

test("handleVideoEncodedChunk: publisher が active でない間は保持値を変えない", () => {
  // 音声側と同じ入口ガードを映像側も持つことの検証。送信できない間に届いた chunk で
  // 保持値を書き換えると、以降の VIDEO_CONFIG の送出が抑止されて映像を復号できなくなる
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  // 送信できない状態 (active 以外) を作る
  (videoPublisher as unknown as { state: string }).state = "closed";
  control.videoPublisher = videoPublisher;
  const retained = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  control.lastSentVideoConfig = new Uint8Array(retained);

  sendVideoChunk(control, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));

  assert.equal(sent.length, 0);
  assert.deepEqual(control.lastSentVideoConfig, retained);
});

/**
 * Forward State 変化の登録を検証するための制御口
 *
 * createPublishers() は接続を要する start() からしか呼べないため、publish 呼び出しを
 * 記録する最小セッションを注入して駆動する (モジュール置換は行わない)。
 */
interface PublisherForwardControl extends PublisherLifecycleControl {
  resolvedAudio: ResolvedAudioPublishSettings | null;
  createPublishers(): Promise<void>;
}

/**
 * publish 呼び出しを記録する最小セッション
 *
 * track 名で引く Publisher を返し、渡されたコールバックを記録する。
 * createPublishers() が Forward State 変化のコールバックを音声 Publisher に
 * 登録しているかを、実装の内部状態を経由せずに検証できるようにする。
 */
function createPublishRecordingSession(publishers: Map<string, Publisher>): {
  session: Session;
  callbacksByTrack: Map<string, PublishCallbacks>;
} {
  const callbacksByTrack = new Map<string, PublishCallbacks>();
  const session = {
    publish: async (
      _namespace: string[],
      trackName: string,
      callbacks?: PublishCallbacks,
    ): Promise<Publisher> => {
      callbacksByTrack.set(trackName, callbacks ?? {});
      const publisher = publishers.get(trackName);
      if (!publisher) {
        throw new Error(`unexpected track: ${trackName}`);
      }
      return publisher;
    },
  } as unknown as Session;
  return { session, callbacksByTrack };
}

test("createPublishers: Forward State が 1 になると Audio Config の送り直しを要求する", async () => {
  // 購読者が居ない状態から購読者が接続した場合の結合の検証。
  // createPublishers() が音声 Publisher に onForwardStateChange を登録し、
  // それが handleAudioEncodedChunk の載せ直しに繋がることを確認する
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  const audioSettings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  control.resolvedAudio = audioSettings;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const { publisher: audioPublisher, sent: audioSent } = createCapturingPublisher();
  const publishers = new Map<string, Publisher>([
    [CATALOG_TRACK_NAME, catalogPublisher],
    [audioSettings.trackName, audioPublisher],
  ]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  // Catalog が Object ID 0 で 1 件だけ publish されること
  assert.equal(catalogSent.length, 1);
  assert.equal(catalogSent[0].objectId, 0);

  // 音声 Publisher に Forward State 変化のコールバックが登録されていること
  const audioCallbacks = callbacksByTrack.get(audioSettings.trackName);
  assert.isDefined(audioCallbacks);
  assert.isDefined(audioCallbacks?.onForwardStateChange);

  // Forward State 0 (購読者なし) では要求が立たない
  audioCallbacks?.onForwardStateChange?.(false);
  assert.isFalse(control.audioConfigResendRequested);

  // Audio Config を送って保持したあと、Forward State 1 で要求が立つ
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);
  audioCallbacks?.onForwardStateChange?.(true);
  assert.isTrue(control.audioConfigResendRequested);

  // 要求に従って次の Object に保持値が載る
  sendAudioChunk(control);
  assert.deepEqual(
    LOC.decodeAudioProperties(audioSent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isFalse(control.audioConfigResendRequested);

  // 要求の寿命は送信で決まる。Forward State が 0 に戻っても保留中の要求は消さない
  // (消すと、次に 1 になったときの送り直しを取りこぼす)
  audioCallbacks?.onForwardStateChange?.(true);
  audioCallbacks?.onForwardStateChange?.(false);
  assert.isTrue(control.audioConfigResendRequested);
});

/**
 * グループ管理・キーフレーム判定・codec description 送出判断の純関数
 *
 * MediaPublisherImpl から切り出した払い出しロジックと判定ロジックを、実装クラスや
 * 構造の注入を介さず固定値で直接駆動する。Group ID が進む条件と Object ID が
 * 0 に戻る条件、キーフレーム間隔の解決と境界、Audio Config の再送判断、
 * Publisher Priority の定数を固定する。
 * Publisher Priority の送信値 (定数が送信に使われること) は、この節の後ろで
 * handleAudioEncodedChunk / handleVideoEncodedChunk と publishCatalog を private
 * 経由で駆動して固定する。
 */

test("resolveAudioConfigToSend: 初回と変化時だけ Audio Config を載せる", () => {
  // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config): description が現れた最初の chunk と、
  // 値が変わった chunk だけ載せる。同じ値を毎 Object 送らない
  const description = new Uint8Array([0x11, 0x90]);

  // 未送信の状態で description が現れたら載せ、保持する
  const first = resolveAudioConfigToSend(null, description, false);
  assert.deepEqual(first.config, description);
  assert.deepEqual(first.next, description);
  assert.isFalse(first.resendNext);

  // 保持値は複製する (呼び出し側が元の配列を書き換えても送出値が変わらない)
  const original = new Uint8Array([0x11, 0x90]);
  const mutable = new Uint8Array([0x11, 0x90]);
  const held = resolveAudioConfigToSend(null, mutable, false);
  assert.notStrictEqual(held.next, mutable);
  mutable.fill(0xff);
  assert.deepEqual(held.next, original);

  // 同じ値は載せず、保持値も変えない
  const same = resolveAudioConfigToSend(first.next, new Uint8Array([0x11, 0x90]), false);
  assert.isUndefined(same.config);
  assert.deepEqual(same.next, first.next);
  assert.isFalse(same.resendNext);

  // 値が変わったら載せて保持値を更新する
  const changed = resolveAudioConfigToSend(first.next, new Uint8Array([0x12, 0x08]), false);
  assert.deepEqual(changed.config, new Uint8Array([0x12, 0x08]));
  assert.deepEqual(changed.next, new Uint8Array([0x12, 0x08]));
  assert.isFalse(changed.resendNext);

  // description が無い chunk (opus) では載せず、保持値もそのままにする
  const withoutDescription = resolveAudioConfigToSend(first.next, undefined, false);
  assert.isUndefined(withoutDescription.config);
  assert.deepEqual(withoutDescription.next, first.next);
  assert.isFalse(withoutDescription.resendNext);
});

test("resolveAudioConfigToSend: 空の description は値なしとして扱う", () => {
  // 長さ 0 の description は AAC の AudioSpecificConfig として成立しないため、
  // 長さ 0 の AUDIO_CONFIG を送らず、opus の undefined と同じ扱いにする
  const previous = new Uint8Array([0x11, 0x90]);
  const empty = resolveAudioConfigToSend(previous, new Uint8Array(0), false);

  assert.isUndefined(empty.config);
  assert.deepEqual(empty.next, previous);
  assert.isFalse(empty.resendNext);

  // 保持値が無い状態でも空は載せない
  const firstEmpty = resolveAudioConfigToSend(null, new Uint8Array(0), false);
  assert.isUndefined(firstEmpty.config);
  assert.isNull(firstEmpty.next);
});

test("resolveAudioConfigToSend: 送り直し要求で保持している Audio Config を載せ直す", () => {
  // Forward State が 0 から 1 になった時点 (後着購読者の出現) の要求に、
  // 保持値を 1 Object だけ載せ直して応える
  const description = new Uint8Array([0x11, 0x90]);
  const sent = resolveAudioConfigToSend(null, description, false);

  // 要求が無い chunk では載らない
  const normal = resolveAudioConfigToSend(sent.next, undefined, false);
  assert.isUndefined(normal.config);
  assert.deepEqual(normal.next, sent.next);

  // 要求があると保持値を載せ直し、要求は解消する
  const resent = resolveAudioConfigToSend(normal.next, undefined, true);
  assert.deepEqual(resent.config, description);
  assert.deepEqual(resent.next, description);
  assert.isFalse(resent.resendNext);

  // 保持値は消さない (2 人目以降の購読者にも同じ要求で応えられる)
  const secondResend = resolveAudioConfigToSend(resent.next, undefined, true);
  assert.deepEqual(secondResend.config, description);
  assert.deepEqual(secondResend.next, description);
});

test("resolveAudioConfigToSend: 保持値が無いまま要求されたら要求を残す", () => {
  // 初回の description が現れる前に Forward State が 1 になった場合は載せる値が無いため、
  // 要求だけを残す (要求を消すと、次に description が現れても送り直しの意図が失われる)
  const pending = resolveAudioConfigToSend(null, undefined, true);

  assert.isUndefined(pending.config);
  assert.isNull(pending.next);
  assert.isTrue(pending.resendNext);

  // 要求が残ったまま次の description が現れたら、それを載せて要求は解消する
  const resolved = resolveAudioConfigToSend(pending.next, new Uint8Array([0x11, 0x90]), true);
  assert.deepEqual(resolved.config, new Uint8Array([0x11, 0x90]));
  assert.isFalse(resolved.resendNext);
});

test("resolveAudioConfigToSend: 送り直し要求より新しい description を優先する", () => {
  // 要求が立っている間に encoder の値が変わった場合は、保持値の再送ではなく
  // 新しい値を載せる (古い値を送ると購読側の復号設定と食い違う)
  const resent = resolveAudioConfigToSend(
    new Uint8Array([0x11, 0x90]),
    new Uint8Array([0x12, 0x08]),
    true,
  );

  assert.deepEqual(resent.config, new Uint8Array([0x12, 0x08]));
  assert.deepEqual(resent.next, new Uint8Array([0x12, 0x08]));
  assert.isFalse(resent.resendNext);
});

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

/**
 * draft-ietf-moq-transport-21 §5.1.1:
 * `sendObject` に渡す Priority が定数どおりであることを固定する (大小関係は
 * 並び順テストが固定する)。Publisher Priority は Subgroup 単位で 1 つに決まるため、
 * 実際に送信される値はキーフレームで開いた Subgroup の 0 になる (デルタフレームの
 * 128 はデルタフレームが先頭になるときだけ載る)。
 */
test("送信する Object の Priority 引数は各定数どおりになる", () => {
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

  control.handleAudioEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  // 音声は 1 フレーム 1 Group のため、2 件目以降も音声の値を載せる
  control.handleAudioEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  control.handleVideoEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  control.handleVideoEncodedChunk({
    data: new Uint8Array([2]),
    type: "delta",
    timestamp: 1,
    duration: null,
  });

  assert.equal(audioSent.length, 2);
  assert.equal(audioSent[0].priority, PRIORITY_AUDIO);
  assert.equal(audioSent[1].priority, PRIORITY_AUDIO);
  assert.equal(videoSent[0].priority, PRIORITY_VIDEO_KEY);
  assert.equal(videoSent[1].priority, PRIORITY_VIDEO_DELTA);
});

/**
 * publishCatalog を直接駆動するための制御口
 */
interface PublisherCatalogControl extends PublisherLifecycleControl {
  resolvedAudio: ResolvedAudioPublishSettings | null;
  // 映像トラックを載せるには解決済みの映像設定と mediaStream の両方が要る
  resolvedVideo: ResolvedVideoPublishSettings | null;
  publishCatalog(): Promise<void>;
}

/**
 * 送信 payload を記録する最小 Publisher
 *
 * Catalog の内容はエンコード済みの payload にしか残らない。createRecordingSendPublisher は
 * Group ID / Object ID / Priority だけを記録して payload を残さないため、payload をそのまま
 * 保持して呼び出し側が decodeCatalogMessage で読み戻せる制御口を別に用意する。
 */
function createRecordingCatalogSendPublisher(): {
  publisher: Publisher;
  sent: { groupId: number; objectId: number; payload: Uint8Array }[];
} {
  const sent: { groupId: number; objectId: number; payload: Uint8Array }[] = [];
  const publisher = {
    state: "active",
    sendObject: (params: { groupId: number; objectId: number; payload: Uint8Array }) => {
      sent.push({ groupId: params.groupId, objectId: params.objectId, payload: params.payload });
    },
  } as unknown as Publisher;
  return { publisher, sent };
}

/**
 * 送信 payload の Catalog から track の JSON オブジェクトを取り出す
 *
 * 符号化 (JSON.stringify) は値が undefined のキーを落とすため、キーが元から無いことは
 * decodeCatalogMessage を通した結果では区別できない。キーの有無は payload そのもので確かめる。
 */
function parseCatalogTrackObjects(payload: Uint8Array): Record<string, unknown>[] {
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("tracks" in parsed)) {
    throw new Error("expected a catalog object with tracks in the sent payload");
  }
  const tracks: unknown = parsed.tracks;
  if (!Array.isArray(tracks)) {
    throw new Error("expected a tracks array in the sent payload");
  }
  return tracks as Record<string, unknown>[];
}

/**
 * targetLatency / renderGroup を載せた Catalog の送信を駆動する制御口
 *
 * publishCatalog は接続を要する start() の中からしか呼ばれないため、解決済みの音声・映像
 * 設定と mediaStream、Catalog Publisher を private 経由で注入して直接駆動する。
 * 音声と映像の両方の track を載せ、payload を記録する。
 */
function createCatalogPublishContext(options: MediaPublisherOptions): {
  control: PublisherCatalogControl;
  sent: { groupId: number; objectId: number; payload: Uint8Array }[];
} {
  const publisher = new MediaPublisherImpl("moqt://example.com/live", options);
  const control = publisher as unknown as PublisherCatalogControl;
  control.currentState = "publishing";
  control.resolvedAudio = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  control.resolvedVideo = resolveVideoPublishSettings(
    { codec: "vp8", bitrate: 1000000, width: 1280, height: 720, framerate: 30 },
    undefined,
  );
  // 映像トラックは mediaStream があるときだけ載る
  control.mediaStream = {} as MediaStream;
  const { publisher: catalogPublisher, sent } = createRecordingCatalogSendPublisher();
  control.catalogPublisher = catalogPublisher;
  return { control, sent };
}

/**
 * 不正な targetLatency / renderGroup で publishCatalog を呼び、投げた Error と送信の記録を返す
 *
 * 検証の目的は例外を投げることだけでなく、購読側が復号できない catalog を送らないことである。
 * そのため送信済みの payload も返し、呼び出し側が「1 件も送っていない」ことを確かめられる
 * ようにする。投げなかったときはテストを失敗させる。
 */
async function captureCatalogPublishFailure(options: MediaPublisherOptions): Promise<{
  error: Error;
  sent: { groupId: number; objectId: number; payload: Uint8Array }[];
}> {
  const { control, sent } = createCatalogPublishContext(options);
  try {
    await control.publishCatalog();
  } catch (error) {
    if (!(error instanceof Error)) {
      // 元の例外を cause に残す (投げ直しで情報を落とさない)
      throw new Error(`expected an Error, got ${String(error)}`, { cause: error });
    }
    return { error, sent };
  }
  throw new Error("expected publishCatalog to throw, but it resolved");
}

/**
 * draft-ietf-moq-msf-01 §5.2.8 (targetLatency) / §5.2.11 (renderGroup):
 * 同じ render group と alternate group の track は同一の targetLatency でなければならない
 * (MUST)。publisher は値を 1 つだけ持ち、指定した値を catalog の音声と映像の両方の track に
 * 同じ値で載せることを、送信 payload の読み戻しで固定する。
 */
test("publishCatalog: 指定した targetLatency と renderGroup を音声と映像の両方の track に載せる", async () => {
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    targetLatency: 100,
    renderGroup: 1,
  });

  await control.publishCatalog();

  assert.equal(sent.length, 1);
  const decoded = decodeCatalogMessage(sent[0].payload);
  // delta update ではなく full catalog が返る
  if (!("version" in decoded)) {
    throw new Error("expected a full catalog, got a delta update");
  }
  assert.deepEqual(
    decoded.tracks.map((track) => track.role),
    ["audio", "video"],
  );
  for (const track of decoded.tracks) {
    assert.equal(track.targetLatency, 100);
    assert.equal(track.renderGroup, 1);
  }
});

/**
 * draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
 * 選んでよい MAY。指定しないときは catalog に載せず、購読側のフォールバックの経路にする。
 * 符号化は undefined の値を落とすため、キーの有無は復号後ではなく payload の JSON で確かめる。
 */
test("publishCatalog: 指定しないときは catalog にキーを載せない", async () => {
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
  });

  await control.publishCatalog();

  const trackObjects = parseCatalogTrackObjects(sent[0].payload);
  assert.equal(trackObjects.length, 2);
  for (const track of trackObjects) {
    assert.isFalse("targetLatency" in track);
    assert.isFalse("renderGroup" in track);
  }
});

test("publishCatalog: targetLatency だけを指定すると renderGroup のキーは載らない", async () => {
  // targetLatency と renderGroup は独立の任意指定であるため、片方だけでもよい。
  // 指定した片方だけが載り、もう片方のキーは payload に現れない
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    targetLatency: 200,
  });

  await control.publishCatalog();

  const trackObjects = parseCatalogTrackObjects(sent[0].payload);
  assert.equal(trackObjects.length, 2);
  for (const track of trackObjects) {
    assert.equal(track.targetLatency, 200);
    assert.isFalse("renderGroup" in track);
  }
});

test("publishCatalog: renderGroup だけを指定すると targetLatency のキーは載らない", async () => {
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    renderGroup: 0,
  });

  await control.publishCatalog();

  const trackObjects = parseCatalogTrackObjects(sent[0].payload);
  assert.equal(trackObjects.length, 2);
  for (const track of trackObjects) {
    // renderGroup の 0 は有効値であり、未指定と同じ扱いにしない
    assert.equal(track.renderGroup, 0);
    assert.isFalse("targetLatency" in track);
  }
});

test("publishCatalog: targetLatency の 0 ms も未指定と区別して載せる", async () => {
  // 0 ms は「符号化から表示まで遅らせない」という有効な指定である。
  // 0 を偽値として落とすと、購読側は宣言が無いものとして遅延を自分で選んでしまう
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    targetLatency: 0,
  });

  await control.publishCatalog();

  const trackObjects = parseCatalogTrackObjects(sent[0].payload);
  assert.equal(trackObjects.length, 2);
  for (const track of trackObjects) {
    assert.equal(track.targetLatency, 0);
  }
});

/**
 * JSON.stringify は非有限値を null に落とし、購読側の検証 (src/msf/catalogTrackValidation.ts)
 * は typeof null !== "number" で例外にする。拒否しないと自分の出力を自分で復号できない
 * catalog を送ってしまうため、符号化と送信の前に拒否する。あわせて payload を 1 件も
 * 送っていないことも固定する。
 */
test("publishCatalog: targetLatency の非有限値を拒否する", async () => {
  for (const targetLatency of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const { error, sent } = await captureCatalogPublishFailure({
      namespace: ["live"],
      audio: { codec: "aac", bitrate: 64000 },
      video: { codec: "vp8", bitrate: 1000000 },
      targetLatency,
    });

    // どちらのフィールドが原因かをメッセージから読み取れる
    assert.isTrue(error.message.includes("targetLatency"));
    assert.isTrue(error.message.includes(String(targetLatency)));
    assert.equal(sent.length, 0);
  }
});

test("publishCatalog: renderGroup の非有限値を拒否する", async () => {
  for (const renderGroup of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
    const { error, sent } = await captureCatalogPublishFailure({
      namespace: ["live"],
      audio: { codec: "aac", bitrate: 64000 },
      video: { codec: "vp8", bitrate: 1000000 },
      renderGroup,
    });

    assert.isTrue(error.message.includes("renderGroup"));
    assert.isTrue(error.message.includes(String(renderGroup)));
    assert.equal(sent.length, 0);
  }
});

/**
 * renderGroup の整数性は decode 側で見ないため、encode 側が整数性を守る唯一の防波堤になる。
 * 同じ値でも 1 は整数、1.5 は整数でないため、有限性の検証だけでは防げない。
 */
test("publishCatalog: renderGroup の非整数を拒否する", async () => {
  for (const renderGroup of [1.5, -0.5]) {
    const { error, sent } = await captureCatalogPublishFailure({
      namespace: ["live"],
      audio: { codec: "aac", bitrate: 64000 },
      video: { codec: "vp8", bitrate: 1000000 },
      renderGroup,
    });

    assert.isTrue(error.message.includes("renderGroup"));
    assert.isTrue(error.message.includes(String(renderGroup)));
    assert.equal(sent.length, 0);
  }
});

/**
 * 0 ms と renderGroup の 0 はどちらも有効値である (未指定とは別の指定)。
 * 検証を「偽値」や「0 より大きい」で書くと 0 が落ちるため、検証を足しても 0 が通ることと、
 * 0 のまま catalog に載ることを回帰として固定する。
 */
test("publishCatalog: targetLatency と renderGroup の 0 は検証を通り catalog に載る", async () => {
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    targetLatency: 0,
    renderGroup: 0,
  });

  await control.publishCatalog();

  const trackObjects = parseCatalogTrackObjects(sent[0].payload);
  assert.equal(trackObjects.length, 2);
  for (const track of trackObjects) {
    assert.equal(track.targetLatency, 0);
    assert.equal(track.renderGroup, 0);
  }
});

/**
 * draft-ietf-moq-transport-21 §5.1.1 / draft-ietf-moq-msf-01 §5:
 * カタログはトラック構成を知らせる制御情報であり、届かないと購読が始まらないため
 * 最高優先 (0) で送ることを固定する。
 */
test("publishCatalog: カタログは最高優先で送られる", async () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogControl;
  control.resolvedAudio = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  const { publisher: catalogPublisher, sent } = createRecordingSendPublisher();
  control.catalogPublisher = catalogPublisher;

  await control.publishCatalog();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].objectId, 0);
  assert.equal(sent[0].priority, PRIORITY_CATALOG);
});

test("Publisher Priority の定数はドキュメントの値である", () => {
  // docs/HIGH_LEVEL_API.md の Priority 表の値 (カタログ 0 / 映像キーフレーム 0 /
  // 音声 64 / 映像デルタフレーム 128) を固定する
  assert.equal(PRIORITY_CATALOG, 0);
  assert.equal(PRIORITY_VIDEO_KEY, 0);
  assert.equal(PRIORITY_AUDIO, 64);
  assert.equal(PRIORITY_VIDEO_DELTA, 128);
});

test("Publisher Priority は数値が小さいほど高優先になる順に並ぶ", () => {
  // draft-ietf-moq-transport-21 §5.1.1: 0-255 の符号無し整数で数値が小さいほど
  // 高優先である。キーフレーム < 音声 < デルタフレームの順になることを固定する
  // (デルタフレームは draft-ietf-moq-transport-21 §10.4 の既定 128 のまま据え置く)
  assert.isTrue(PRIORITY_CATALOG <= PRIORITY_VIDEO_KEY);
  assert.isTrue(PRIORITY_VIDEO_KEY < PRIORITY_AUDIO);
  assert.isTrue(PRIORITY_AUDIO < PRIORITY_VIDEO_DELTA);
});
