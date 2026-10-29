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
 * 並行分配は実物で検証する)。setupEncoders が自分で作る映像エンコーダーだけは
 * 注入できないため、WebCodecs の境界 (VideoEncoder / MediaStreamTrackProcessor) を
 * テストの前後で置き換え、解放が configure の await に重なる窓を作る
 * (実ブラウザの WebCodecs を駆動する経路は e2e で確認する)。
 * 音声も同じ理由で境界 (AudioEncoder / MediaStreamTrackProcessor) を置き換え、
 * 取り出し経路が返した形式が catalog と configure の両方に使われること・経路が start ごとに
 * 1 度だけ作られること・取り出した形式が非対応なら catalog を送る前に失敗することを検証する。
 * 駆動は公開 pause() / resume() を使い、ループ起動・状態設定・フラグ設定・
 * reader / encoder 注入は start() が接続を要するため private 経由で行う。
 *
 * グループ管理 (allocateAudioObject / allocateVideoObject) とキーフレーム判定
 * (resolveKeyframeInterval / shouldSendKeyFrame)、Publisher Priority の定数と送信値、
 * Audio Config / Video Config の再送判断 (resolveAudioConfigToSend /
 * resolveVideoConfigToSend) は純関数として切り出しており、固定値で直接駆動する。
 * Audio Config / Video Config の再送は forwardState 変化のコールバック登録から
 * handleAudioEncodedChunk / handleVideoEncodedChunk までを、publish 呼び出しを記録する
 * 最小セッションを注入して結合で検証する。
 * catalog の送り直しは、forwardState 変化のコールバック登録から新しい Group の先頭 Object の
 * 送信までと、定期送り直しの予約 (実時間のタイマー) と解放による取り消しを検証する。
 * encode キューの閾値超過による破棄と droppedFrames の加算、破棄したフレームの
 * 新しい Group の開始が次に encode するフレームへ移ることも検証する。
 * session の close 通知は private の通知処理 (handleSessionClose) を世代番号を与えて
 * 直接駆動し、自己起点の解放で届く通知と解放のあとに届く旧 session の通知が捨てられ、
 * 世代番号が一致する通知 (ピア起点の close) だけが解放してから "closed" と onClose を
 * 通知することを検証する。ピア起点の close の解放と利用者の stop() / close() が重なった
 * 場合は進行中の解放を共有し、終端をどちらの経路が決めるかを固定する。
 * connectToServer が実際に作る onSessionClose の閉包は、接続の境界 (openSession) を
 * 置き換えて start() を駆動し、接続時点の世代番号を捕捉することと、閉包の回収経路が
 * 通知の失敗を onError へ流すことを検証する。start の実行中に解放が先行した場合は、
 * それ以上リソースを作らず "closed" を優先して失敗することも同じ駆動で検証する。
 * 解放の完了を待って呼び直した start は、解放が終端 ("closed") へ進んだあとだと世代番号が
 * 一致していても中止すること (終端の state も中止の条件であること) も検証する。
 */

import { test, assert } from "vite-plus/test";
import { recordEncodeGeneration, type EncodeGenerationRecords } from "./encodeGeneration";
import type { MediaPublisherCallbacks, MediaPublisherOptions } from "./createMediaPublisher";
import {
  MediaPublisherImpl,
  createMediaPublisher,
  CATALOG_MAX_CACHE_DURATION_MS,
  CATALOG_REPUBLISH_DEFAULT_INTERVAL_MS,
  PRIORITY_AUDIO,
  PRIORITY_CATALOG,
  PRIORITY_VIDEO_DELTA,
  PRIORITY_VIDEO_KEY,
  AUDIO_TAIL_PUBLISH_DONE_GRACE_MS,
  allocateAudioObject,
  allocateInitialGroupId,
  allocateVideoObject,
  noteGroupId,
  resolveAudioConfigToSend,
  selectCodecDescription,
  resolveKeyframeInterval,
  resolveVideoConfigToSend,
  shouldSendKeyFrame,
  VIDEO_PUBLISH_OPTIONS,
  type VideoGroupState,
} from "./createMediaPublisher";
import type { AudioEncoderWrapper } from "./codec/AudioEncoder";
import type { VideoEncoderWrapper } from "./codec/VideoEncoder";
import { DEFAULT_KEYFRAME_INTERVAL_SECONDS } from "./codec/config";
import type { MediaPublisherState } from "./codec/types";
import type { MediaConnectSettings } from "./createMedia/connect";
import { resolveAudioPublishSettings, resolveVideoPublishSettings } from "./createMedia/settings";
import type {
  ResolvedAudioPublishSettings,
  ResolvedVideoPublishSettings,
} from "./createMedia/settings";
import type { VideoFrameSource } from "./frameSource";
import type { AudioFrameSource } from "./audioSource";
import { CATALOG_TRACK_NAME, decodeCatalogMessage, type Catalog } from "./msf";
import { PublisherImpl, isErrorNotifiedByPublisher, type Publisher } from "./publisher";
import type { PublishCallbacks, PublishOptions, Session } from "./session";
import { ProtocolViolationError } from "./error";
import { ObjectStatus } from "./message/types";
import { AuthorizationTokenAliasType } from "./message/authorizationToken";
import * as LOC from "./loc";
import { WallClockMapper } from "./mediaClock";
import {
  useValueToken,
  waitForUnhandledRejectionDetection,
  withUnhandledRejectionWatch,
} from "./testSupport/helpers";
import type { AuthorizationToken } from "./message/authorizationToken";

/**
 * 破棄検出付きのテスト用フレーム
 */
interface TestFrame {
  closed: boolean;
  // close() が呼ばれた回数 (二重 close と閉じ忘れの検出用)
  closeCount: number;
  // VideoFrame / AudioData の timestamp (マイクロ秒)
  timestamp: number;
  close(): void;
}

function createTestFrame(timestamp = 0): TestFrame {
  const frame: TestFrame = {
    closed: false,
    closeCount: 0,
    timestamp,
    close: () => {
      frame.closed = true;
      frame.closeCount++;
    },
  };
  return frame;
}

/**
 * encode 呼び出し記録用の最小エンコーダー
 *
 * `encodeQueueSize` はキュー滞留の変化を再現できるよう、初期値の引数と更新関数の
 * 両方を持つ (閾値超過で破棄した後にキューが空いて次のフレームが encode される経路を
 * 検証するため)。`keyFrames` は encode の options の `keyFrame` を記録し、破棄した
 * フレームの新しい Group の開始が次に encode するフレームへ移ったかを観測できるようにする。
 * `setEncoderState` はループの途中で実行時エラー後の状態 (configured 以外) に変え、
 * ループ条件の状態判定と読み取り中の状態判定の両方を検証できるようにする。
 * `failNextEncode` は次の encode を 1 回だけ同期 throw させ、実エンコーダー
 * (`VideoEncoderWrapper.encode` は `encoder.encode` / `worker.postMessage` の例外を
 * そのまま伝える) が失敗したときのフレームの close と通し番号の据え置きを
 * 検証できるようにする。
 */
function createRecordingEncoder(encodeQueueSize = 0): {
  encoded: unknown[];
  keyFrames: boolean[];
  isClosed: () => boolean;
  setEncodeQueueSize: (value: number) => void;
  setEncoderState: (value: string) => void;
  failNextEncode: (error: Error) => void;
  encoder: {
    readonly state: string;
    readonly encodeQueueSize: number;
    encode: (frame: unknown, options?: { keyFrame?: boolean }) => void;
    close: () => void;
  };
} {
  const encoded: unknown[] = [];
  // encode ごとのキーフレームの指定 (encoded と同じ並び)
  const keyFrames: boolean[] = [];
  let closed = false;
  // ループの途中でキュー滞留を変えられるよう、読み出しは getter にする
  let queueSize = encodeQueueSize;
  // ループの途中で実行時エラー後の状態に変えられるよう、読み出しは getter にする
  let state = "configured";
  // 次の encode で同期 throw させるエラー (使い捨てであり、1 回投げたら消える)
  let nextEncodeError: Error | null = null;
  return {
    encoded,
    keyFrames,
    isClosed: () => closed,
    setEncodeQueueSize: (value: number) => {
      queueSize = value;
    },
    setEncoderState: (value: string) => {
      state = value;
    },
    failNextEncode: (error: Error) => {
      nextEncodeError = error;
    },
    encoder: {
      get state(): string {
        return state;
      },
      get encodeQueueSize(): number {
        return queueSize;
      },
      encode: (frame: unknown, options?: { keyFrame?: boolean }) => {
        // 実エンコーダーと同じく、throw した encode は記録に残さない
        const error = nextEncodeError;
        if (error !== null) {
          nextEncodeError = null;
          throw error;
        }
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
 * 処理ループの駆動と private 状態の直接操作のための制御口
 */
interface PublisherLoopControl {
  audioFrameReader: ReadableStreamDefaultReader<AudioData> | null;
  audioEncoder: AudioEncoderWrapper | null;
  videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null;
  videoEncoder: VideoEncoderWrapper | null;
  processingActive: boolean;
  processingGeneration: number;
  // 直前のキーフレームの timestamp (resume() が新しい Group を始めるかの確認に使う)
  lastKeyFrameTimestampUs: number | null;
  currentState: MediaPublisherState;
  processAudioFrames(): Promise<void>;
  processVideoFrames(): Promise<void>;
  startNewGroup(): void;
  // 読んだ映像フレームの timestamp を壁時計に換算する
  videoWallClock: WallClockMapper;
}

/**
 * 処理ループ駆動用の最小コンテキスト
 *
 * 実 ReadableStream の reader と記録用エンコーダーを注入する。
 * currentState の設定のみ private への直接代入であり、
 * start() の接続なしに publishing 状態を作るためである。
 * onError は呼び出しを記録するために常に付ける。onStateChange / onClose など残りの
 * コールバックは呼び出し側が足せる (state の遷移と終端の通知を記録するテストのため)。
 */
function createLoopTestContext(
  options?: { video?: NonNullable<MediaPublisherOptions["video"]> },
  callbacks: Omit<MediaPublisherCallbacks, "onError"> = {},
): {
  publisher: MediaPublisherImpl;
  control: PublisherLoopControl;
  errors: Error[];
} {
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"], ...(options?.video === undefined ? {} : { video: options.video }) },
    {
      ...callbacks,
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = publisher as unknown as PublisherLoopControl;
  control.currentState = "publishing";
  return { publisher, control, errors };
}

/**
 * 音声の送信内容を Subgroup で検証するテストのために、解決済みの音声設定を Subgroup で与える
 *
 * 音声の配送方式の既定は Datagram である。Subgroup の sendObject へ渡す引数や Audio Config の
 * 載り方を見るテストは、明示的に Subgroup を選ぶ。Datagram 経路は専用のテストで固定する
 */
function setSubgroupAudioDelivery(control: unknown): void {
  const internal = control as {
    resolvedAudio: ReturnType<typeof resolveAudioPublishSettings> | null;
  };
  internal.resolvedAudio = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64_000,
    delivery: "subgroup",
  });
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

/**
 * 処理ループが投入したフレームを 1 枚処理し終えるまで microtask を排出する
 *
 * ループは `reader.read()` の解決とその後の処理で 2 段の microtask を要するため
 * 2 回 await する (タイマーは使わない。テストを実時間に依存させないため)。
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
  setEncodeQueueSize: (value: number) => void;
  setEncoderState: (value: string) => void;
  failNextEncode: (error: Error) => void;
  controller: ReadableStreamDefaultController<TestFrame>;
  isEncoderClosed: () => boolean;
} {
  const { stream, controller } = createFrameStream();
  const {
    encoder,
    encoded,
    keyFrames,
    setEncodeQueueSize,
    setEncoderState,
    failNextEncode,
    isClosed,
  } = createRecordingEncoder(encodeQueueSize);
  control.videoFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<VideoFrame>;
  control.videoEncoder = encoder as unknown as VideoEncoderWrapper;
  control.processingActive = true;
  return {
    encoded,
    keyFrames,
    setEncodeQueueSize,
    setEncoderState,
    failNextEncode,
    controller,
    isEncoderClosed: isClosed,
  };
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

  // encode は呼ばれず、両フレームとも閉じられる (close は 1 回だけ)
  assert.equal(encoded.length, 0);
  assert.equal(first.closeCount, 1);
  assert.equal(second.closeCount, 1);
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
  assert.equal(frame.closeCount, 1);
  assert.equal(errors.length, 0);
  assert.equal(publisher.getStats().video?.droppedFrames, 0);
});

test("processVideoFrames: 実行時エラーで使えなくなったエンコーダーのフレームは破棄され droppedFrames に数える", async () => {
  // ループ条件のエンコーダーの状態は reader.read() の前にしか評価されないため、読み取り中に
  // 実行時エラーで使えなくなったフレームはここで判定する。encode に渡しても Worker モードでは
  // Worker へ送られず警告が出るだけ、直接実行モードでは無言で破棄されるため、破棄として統計に残す
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000 },
  });
  const { encoded, controller, setEncoderState } = injectVideoLoop(control, 0);

  const loop = control.processVideoFrames();
  const frame = createTestFrame();
  controller.enqueue(frame);
  // read が解決する前に使えなくなる (実行時エラーの通知で configured が false になった状態)
  setEncoderState("unconfigured");
  await settle();
  // 状態を落とした後に投入した 2 枚目は読み取らない (ループは次の周回の状態判定で終了している)。
  // 読み取っていれば破棄として数えてしまい、統計が「閉じた後に読み続けた数」に汚れる
  const second = createTestFrame();
  controller.enqueue(second);
  await settle();
  controller.close();
  await loop;

  assert.equal(encoded.length, 0);
  assert.equal(frame.closeCount, 1);
  assert.equal(errors.length, 0);
  // 2 枚目は読み取っていないため閉じられない。破棄の数も状態を落とした後は増えず 1 のままである
  assert.equal(second.closeCount, 0);
  assert.equal(publisher.getStats().video?.droppedFrames, 1);
});

// 破棄するフレームではキーフレームの判定も直前のキーフレームの更新も行わない。行うと、
// startNewGroup() が記録を消した直後にキューが閾値を超えていた場合、破棄した分だけ
// 記録が進んで要求が消費され、キーフレームは次の間隔まで現れない。
// 記録用エンコーダーの encodeQueueSize を変えて閾値超過と回復を作り、
// encode の options (keyFrame) の記録で要求が次の encode するフレームへ移ることを固定する
test("processVideoFrames: キュー超過で破棄したフレームは新しい Group の開始を消費しない", async () => {
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000, keyframeInterval: 10 },
  });
  const { encoded, keyFrames, setEncodeQueueSize, controller } = injectVideoLoop(control);
  const loop = control.processVideoFrames();

  // 1 枚目はキューに空きがあるため encode され、間隔の先頭としてキーフレームになる
  const first = createTestFrame();
  controller.enqueue(first);
  await settle();

  // キューが閾値 (2) を超えた状態で新しい Group を要求する
  // (PublishCallbacks.onNewGroupRequest と同じく startNewGroup() を呼ぶ)
  setEncodeQueueSize(3);
  control.startNewGroup();

  // 要求の直後に届いた 3 枚はすべて破棄される
  const dropped = [createTestFrame(), createTestFrame(), createTestFrame()];
  for (const frame of dropped) {
    controller.enqueue(frame);
    await settle();
  }

  // キューが空いたため、次の 1 枚は encode される
  setEncodeQueueSize(0);
  const second = createTestFrame();
  controller.enqueue(second);
  await settle();
  controller.close();
  await loop;

  // 破棄した 3 枚は encode されず、要求は次に encode するフレームが引き継ぐ。
  // 破棄したフレームで記録を進めると、2 枚目の経過時間が間隔に届かず keyFrame: false になる
  assert.equal(encoded.length, 2);
  assert.strictEqual(encoded[0], first);
  assert.strictEqual(encoded[1], second);
  assert.deepEqual(keyFrames, [true, true]);
  assert.equal(publisher.getStats().video?.droppedFrames, 3);
  // 破棄したフレームも encode したフレームも close() は 1 回だけである
  for (const frame of [first, ...dropped, second]) {
    assert.equal(frame.closeCount, 1);
  }
  assert.equal(errors.length, 0);
});

// キーフレームの判定に使う記録は「実際に encode したフレームの timestamp」で更新する。
// 破棄したフレームで更新すると、間隔の境界が破棄のたびに後ろへずれ、周期のキーフレームが
// 現れなくなる。フレームの timestamp は 50 ms 刻み、間隔は 250 ms とし、破棄した 2 枚を
// 数えなければ 4 枚目の encode (250 ms) が境界に届くことを固定する
test("processVideoFrames: キーフレームの記録は実際に encode したフレームだけで進む", async () => {
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000, keyframeInterval: 0.25 },
  });
  const { encoded, keyFrames, setEncodeQueueSize, controller } = injectVideoLoop(control);
  const loop = control.processVideoFrames();

  // 間隔 (250 ms) の境界に届かない 2 枚 (0 ms / 50 ms) を encode する
  for (let index = 0; index < 2; index++) {
    controller.enqueue(createTestFrame(index * 50_000));
    await settle();
  }

  // キューが閾値を超えている間の 2 枚 (100 ms / 150 ms) は破棄される
  setEncodeQueueSize(3);
  for (let index = 2; index < 4; index++) {
    controller.enqueue(createTestFrame(index * 50_000));
    await settle();
  }

  // キューが空いた後は 3 枚目と 4 枚目 (200 ms / 250 ms) が encode される
  setEncodeQueueSize(0);
  for (let index = 4; index < 6; index++) {
    controller.enqueue(createTestFrame(index * 50_000));
    await settle();
  }
  controller.close();
  await loop;

  // encode したのは 4 枚であり、間隔の境界 (250 ms) は 4 枚目に現れる。
  // 破棄した 2 枚で記録を更新すると 150 ms が基準になり、キーフレームは現れない
  assert.equal(encoded.length, 4);
  assert.deepEqual(keyFrames, [true, false, false, true]);
  assert.equal(publisher.getStats().video?.droppedFrames, 2);
  assert.equal(errors.length, 0);
});

// encode が同期 throw しても、フレームは必ず 1 回閉じられ、記録は進まない。
// VideoEncoderWrapper.encode は try/catch を持たず encoder.encode と worker.postMessage の
// 例外をそのまま伝えるため、この経路は実際に起こり得る。記録の更新を encode より前に置くと
// encode していないフレームで進み、新しい Group の開始を消費する。
// close() を分岐の外に置くと throw の経路で閉じ忘れる
test("processVideoFrames: encode が同期 throw するとフレームを閉じ、記録を進めない", async () => {
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000, keyframeInterval: 10 },
  });
  const { encoded, keyFrames, failNextEncode, controller } = injectVideoLoop(control);

  // 新しい Group を要求した直後のフレームで encode が同期 throw する。
  // 記録が進むと要求が消費され、次に encode するフレームがキーフレームにならない
  control.startNewGroup();
  const failed = createTestFrame();
  failNextEncode(new Error("VideoEncoder.encode failed"));
  // encode の同期 throw はループ全体の catch を抜けて終了するため、
  // 次のフレームは新しいループで処理する (記録はインスタンスに残る)
  const firstLoop = control.processVideoFrames();
  controller.enqueue(failed);
  await settle();
  await firstLoop;

  const secondLoop = control.processVideoFrames();
  const next = createTestFrame();
  controller.enqueue(next);
  await settle();
  controller.close();
  await secondLoop;

  // throw したフレームは encode されず、記録も据え置かれる (要求は next が引き継ぐ)
  assert.equal(encoded.length, 1);
  assert.strictEqual(encoded[0], next);
  assert.deepEqual(keyFrames, [true]);
  // throw したフレームも次のフレームも close() は 1 回だけである
  assert.equal(failed.closeCount, 1);
  assert.equal(next.closeCount, 1);
  // encode の同期 throw は onError へ 1 回通知される (破棄の統計は増えない)
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "VideoEncoder.encode failed");
  assert.equal(publisher.getStats().video?.droppedFrames, 0);
});

/**
 * draft-ietf-moq-transport-22 §10.6 / §9.20.19: 映像トラックは DYNAMIC_GROUPS=1 を広告し、
 * 購読者が NEW_GROUP_REQUEST で新しい Group を要求できるようにする
 */
test("VIDEO_PUBLISH_OPTIONS: 映像トラックは DYNAMIC_GROUPS を広告する", () => {
  assert.isTrue(VIDEO_PUBLISH_OPTIONS.dynamicGroups);
});

/**
 * draft-ietf-moq-transport-22 §9.20.19: NEW_GROUP_REQUEST を受けた publisher は、現在の Group を
 * 終えて新しい Group をできるだけ早く始める SHOULD。映像は onNewGroupRequest から
 * startNewGroup() を呼び、次に符号化するフレームをキーフレーム (新しい Group の先頭) にする。
 * 間隔 10 秒の途中 (3 枚目、timestamp 2 秒) で要求を受けると、4 枚目がキーフレームになり、
 * 以降は要求の後から数えた間隔に戻る
 */
test("processVideoFrames: 新しい Group の要求を受けると次のフレームをキーフレームにする", async () => {
  const { control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000, keyframeInterval: 10 },
  });
  const { keyFrames, controller } = injectVideoLoop(control);
  const loop = control.processVideoFrames();
  // フレームの timestamp は 1 秒刻みにする (間隔 10 秒には届かない)
  for (let index = 0; index < 3; index++) {
    controller.enqueue(createTestFrame(index * 1_000_000));
    await settle();
  }
  // PublishCallbacks.onNewGroupRequest と同じく startNewGroup() を呼ぶ
  control.startNewGroup();
  for (let index = 3; index < 6; index++) {
    controller.enqueue(createTestFrame(index * 1_000_000));
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
  // 公開 pause() で世代を進めた旧ループにフレームが届く場合を再現する。
  // 破棄の統計 (getStats) を検証するため video 付きで作る
  const { publisher, control, errors } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000 },
  });
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
  // 世代の判定は破棄の判定より先に break するため、破棄の統計は増えない
  assert.equal(publisher.getStats().video?.droppedFrames, 0);
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
  // forwardState が 0 から 1 になった時点で立つ Audio Config の送り直し要求
  audioConfigResendRequested: boolean;
  // 直前に AUDIO_CONFIG として送った description (session を跨いで保持しない)
  lastSentAudioConfig: Uint8Array | null;
  // forwardState が 0 から 1 になった時点で立つ Video Config の送り直し要求
  videoConfigResendRequested: boolean;
  // 直前に VIDEO_CONFIG として送った description (session を跨いで保持しない)
  lastSentVideoConfig: Uint8Array | null;
  // {} 代入のための緩和であり検証対象外である (実装型は AudioData の取り出し経路)
  audioFrameSource: AudioFrameSource | null;
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
 *
 * `onSessionClose` を渡すと、解放 (close) のときに実 session (src/session.ts) と同じく
 * 通知する。実 session は transport の切断を待って通知するが、単体テストでは
 * WebTransport を用意できないため、解放の途中 (await の内側) で通知する最も早い場合を
 * 作る。通知に使う世代番号は実装と同じく接続時点の値を呼び出し側が渡す。
 */
function createRecordingSession(onSessionClose?: () => void): {
  session: Session;
  isClosed: () => boolean;
} {
  let closed = false;
  const session = {
    close: async () => {
      closed = true;
      onSessionClose?.();
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

/**
 * 破棄を記録する AudioFrameSource
 *
 * Web Audio 経路の取り出し経路は AudioContext を持つため、配信の停止で閉じられたことを
 * 確かめる (閉じ忘れるとセッションを開き直すたびに増える)
 */
function createRecordingAudioFrameSource(): {
  source: AudioFrameSource;
  isClosed: () => boolean;
} {
  let closed = false;
  const stream = new ReadableStream<AudioData>();
  const source: AudioFrameSource = {
    readable: stream,
    sampleRate: 48000,
    channels: 2,
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
  const { source: audioSource, isClosed: isAudioSourceClosed } = createRecordingAudioFrameSource();
  lifecycle.session = session;
  lifecycle.catalogPublisher = catalogPublisher;
  lifecycle.audioPublisher = audioPublisher;
  lifecycle.videoPublisher = videoPublisher;
  lifecycle.videoFrameSource = source;
  lifecycle.audioFrameSource = audioSource;
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
  assert.isNull(lifecycle.audioFrameSource);
  assert.isNull(lifecycle.audioFrameReader);
  assert.isNull(lifecycle.videoFrameReader);
  // 破棄が呼ばれていること
  assert.isTrue(isSessionClosed());
  assert.equal(catalogDoneCount(), 1);
  assert.equal(audioDoneCount(), 1);
  assert.equal(videoDoneCount(), 1);
  assert.isTrue(isSourceClosed());
  assert.isTrue(isAudioSourceClosed());
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

/**
 * start 失敗の通知の検証用の制御口
 *
 * start() は接続を要するため、通知の抑止の判断を切り出した private メソッドを直接
 * 駆動する。start() の catch が通知を伴わない失敗で onError を 1 回呼ぶことは実物の接続
 * 失敗を使うテストが、印付きの失敗を通知しないことは接続の境界 (openSession) を置き換えて
 * catalog 送信の reject を catch まで運ぶテストが検証している。
 */
interface PublisherStartFailureControl extends PublisherLifecycleControl {
  notifyStartFailure(error: unknown): void;
}

/**
 * publisher 層が通知済みの error を作る
 *
 * 印は実物の PublisherImpl.handleError だけが付ける。通知先は検証対象ではないため
 * 記録せず、印を付けるためだけに実物へ通知させる (モックは使わない)。
 */
function createNotifiedError(message: string): Error {
  const error = new Error(message);
  new PublisherImpl(["namespace"], "track", 0n, 0n).handleError(error);
  return error;
}

test("start 失敗の通知: publisher 層が通知済みの error は通知しない", () => {
  // catalog 送信の await が受けた reject は publisher 層が通知済みのため、
  // start() の catch で通知し直すと 1 件の失敗で onError が 2 回呼ばれる。
  // 印付きでは通知しないことを固定する (抑止の分岐を削るとこのテストが落ちる)
  const { control, errors } = createLoopTestContext();
  const startFailure = control as unknown as PublisherStartFailureControl;
  const failure = createNotifiedError("send rejected after notify");

  startFailure.notifyStartFailure(failure);

  assert.equal(errors.length, 0);
});

test("start 失敗の通知: 通知を伴わない error は 1 回通知する", () => {
  // 接続失敗や closed の同期 throw は publisher 層の通知を伴わないため、
  // 従来どおり onError へ同じ error を 1 回だけ通知する
  const { control, errors } = createLoopTestContext();
  const startFailure = control as unknown as PublisherStartFailureControl;
  const failure = new Error("connection failed");

  startFailure.notifyStartFailure(failure);

  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], failure);
});

test("start 失敗の通知: Error 以外の throw は Error に包んで通知する", () => {
  // throw される値は Error に限らないため、Error 以外は文字列化して通知する
  const { control, errors } = createLoopTestContext();
  const startFailure = control as unknown as PublisherStartFailureControl;

  startFailure.notifyStartFailure("connection failed");

  assert.equal(errors.length, 1);
  assert.instanceOf(errors[0], Error);
  assert.isTrue((errors[0]?.message ?? "").includes("connection failed"));
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
  // 破棄では session に紐づく Audio Config / Video Config の保持値と要求を必ず忘れる。
  // 段階破棄が失敗しても忘れ漏らさないことを確認する
  lifecycle.lastSentAudioConfig = new Uint8Array([0x11, 0x90]);
  lifecycle.audioConfigResendRequested = true;
  lifecycle.lastSentVideoConfig = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  lifecycle.videoConfigResendRequested = true;

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
  assert.isNull(lifecycle.lastSentVideoConfig);
  assert.isFalse(lifecycle.videoConfigResendRequested);
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
 * session close 通知の検証用の制御口
 *
 * 通知の処理 (handleSessionClose) は private のため世代番号を与えて直接駆動する。
 * 接続時の世代番号の捕捉 (connectToServer が作る onSessionClose の閉包) は、
 * 接続の境界 (openSession) を置き換えて別のテストで駆動する。
 * state の遷移と onClose の回数を記録し、通知の有無を固定する。
 */
interface PublisherSessionCloseControl extends PublisherLifecycleControl {
  sessionGeneration: number;
  handleSessionClose(generation: number): Promise<void>;
}

/**
 * 接続の完了を制御するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続の完了 (await の解決) をテストが
 * 決められるようにする。接続後の Publisher の作成 / 解放の扱いは実装のまま駆動する。
 */
interface PublisherConnectControl {
  openSession(settings: MediaConnectSettings): Promise<Session>;
}

function createSessionCloseTestContext(): {
  publisher: MediaPublisherImpl;
  control: PublisherSessionCloseControl;
  states: MediaPublisherState[];
  errors: Error[];
  closeCount: () => number;
  sessionAtClose: (Session | null)[];
} {
  const states: MediaPublisherState[] = [];
  // onClose を通知した時点の session の参照 (解放が先行していることの確認)
  const sessionAtClose: (Session | null)[] = [];
  let closeCount = 0;
  // 生成は createLoopTestContext に委譲する (接続先と publishing 状態の作り方を共有する)
  const context = createLoopTestContext(undefined, {
    onStateChange: (state) => {
      states.push(state);
    },
    onClose: () => {
      closeCount++;
      // onClose の時点の参照をその場で読み直す
      const inside = context.control as unknown as PublisherSessionCloseControl;
      sessionAtClose.push(inside.session);
    },
  });
  return {
    publisher: context.publisher,
    control: context.control as unknown as PublisherSessionCloseControl,
    states,
    errors: context.errors,
    closeCount: () => closeCount,
    sessionAtClose,
  };
}

/**
 * 非同期の通知処理 (解放と終端の遷移) を待つ
 *
 * handleSessionClose は解放 (複数の await) を挟んでから state を変えるため、microtask の
 * 段数に依存しないよう macrotask で待つ。
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * 完了条件: 自己起点の stop で onClose が呼ばれず、onStateChange に "closed" が現れず、
 * "stopped" のまま残って start() に cannot start in state で拒否されない。
 *
 * 解放の途中に届く通知 (最も早い場合) と、stop() が返ったあとに届く通知の両方を通す。
 * どちらも解放が世代番号を進めるため捨てられる。
 */
test("stop: 解放で閉じた session の close 通知では onClose を通知せず stopped のまま残る", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  // 接続時に session の閉包へ渡される世代番号 (解放の前の現在値)
  const connectedGeneration = control.sessionGeneration;
  const { session, isClosed } = createRecordingSession(() => {
    // 実 session と同じく、解放で閉じたときに close 通知を送る
    void control.handleSessionClose(connectedGeneration);
  });
  control.session = session;

  await publisher.stop();

  // 自己起点の停止であるため onClose は通知せず "closed" も経由しないこと
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["stopped"]);
  assert.equal(closeCount(), 0);
  // 解放自体は行われていること
  assert.isTrue(isClosed());
  assert.isNull(control.session);

  // setState("stopped") より後に届いた通知でも state と onClose は変わらないこと
  await control.handleSessionClose(connectedGeneration);
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["stopped"]);
  assert.equal(closeCount(), 0);

  // "stopped" のまま残るため start() は state のガードで拒否されないこと。
  // 接続は node に WebTransport が無いため失敗するが、それは state の拒否ではない
  let startError: unknown = null;
  try {
    await publisher.start({} as MediaStream);
  } catch (error) {
    startError = error;
  }
  assert.instanceOf(startError, Error);
  assert.isFalse((startError as Error).message.includes("cannot start in state"));
});

/**
 * 完了条件: 自己起点の close で onClose が 1 回だけ、onStateChange の "closed" も
 * 1 回だけ通知される。
 *
 * 解放で閉じた session の通知は終端の遷移より先に届く (解放の await の内側である)。
 * 世代番号が解放で進むため捨てられ、通知は close 自身の 1 回だけになる。
 */
test("close: 解放で閉じた session の close 通知が重なっても closed と onClose は 1 回だけ", async () => {
  const { publisher, control, states, closeCount, sessionAtClose } =
    createSessionCloseTestContext();
  // 接続時に session の閉包へ渡される世代番号 (解放の前の現在値)
  const connectedGeneration = control.sessionGeneration;
  const { session, isClosed } = createRecordingSession(() => {
    // 実 session と同じく、解放で閉じたときに close 通知を送る
    void control.handleSessionClose(connectedGeneration);
  });
  control.session = session;

  await publisher.close();

  // 終端の遷移と onClose が 1 回ずつであること
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);
  // 解放が先行していること (onClose の時点で session を切り離し済み)
  assert.deepEqual(sessionAtClose, [null]);
  assert.isTrue(isClosed());
  assert.isNull(control.session);

  // 解放のあとに届いた旧 session の通知でも通知は増えないこと
  await control.handleSessionClose(connectedGeneration);
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);

  // 直列の二重 close も早期 return し、解放と通知は 1 回のままであること
  await publisher.close();
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close 通知 (世代番号が一致する通知) は解放してから "closed" と
 * onClose を通知する。
 *
 * 解放せずに終端へ進めると close() の早期 return で解放経路が消え、session と
 * フレームリーダーとエンコーダーと MediaStream が残ったまま再開も停止もできなくなる。
 * 解放の対象 (session / リーダー / エンコーダー) と処理ループのフラグが残らないことを
 * 固定する。
 */
test("handleSessionClose: 世代が一致する通知では解放してから closed と onClose を通知する", async () => {
  const { publisher, control, states, closeCount, sessionAtClose } =
    createSessionCloseTestContext();
  // ピア起点の close の時点で確保されている資源を注入する
  const { isEncoderClosed: isAudioEncoderClosed } = injectAudioLoop(control);
  const { isEncoderClosed: isVideoEncoderClosed } = injectVideoLoop(control);
  const { session, isClosed } = createRecordingSession();
  control.session = session;
  control.mediaStream = {} as MediaStream;
  assert.isTrue(control.processingActive);
  // 通知を受け取った session の世代番号 (接続時に閉包へ渡る値)
  const generation = control.sessionGeneration;

  await control.handleSessionClose(generation);

  // 解放してから終端へ進むこと
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);
  assert.deepEqual(sessionAtClose, [null]);
  assert.isTrue(isClosed());
  // 参照が残らないこと
  assert.isNull(control.session);
  assert.isNull(control.audioEncoder);
  assert.isNull(control.videoEncoder);
  assert.isNull(control.audioFrameReader);
  assert.isNull(control.videoFrameReader);
  assert.isNull(control.mediaStream);
  // 破棄が呼ばれ、処理ループが止まっていること
  assert.isTrue(isAudioEncoderClosed());
  assert.isTrue(isVideoEncoderClosed());
  assert.isFalse(control.processingActive);
  // 世代番号は解放で進むため、次の通知は世代不一致で捨てられる
  assert.equal(control.sessionGeneration, generation + 1);

  // 同じ通知が重なっても終端の遷移と onClose は 1 回だけであること
  await control.handleSessionClose(generation);
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close の解放が失敗した場合は state を変えず onError で通知し、
 * close() を呼べば残りの解放を進められる。
 */
test("handleSessionClose: 解放が失敗したら state を変えずエラーを通知し close で回収できる", async () => {
  const failure = new Error("session close failure");
  const errors: Error[] = [];
  let closeCount = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = publisher as unknown as PublisherSessionCloseControl;
  control.currentState = "publishing";
  // session の close だけを失敗させる (参照は切り離し済みで残りの段階は進む)
  control.session = {
    close: async () => {
      throw failure;
    },
  } as unknown as Session;

  await control.handleSessionClose(control.sessionGeneration);

  // 終端へ進まず、失敗が 1 回だけ通知されること
  assert.equal(publisher.state, "publishing");
  assert.equal(closeCount, 0);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], failure);
  assert.isNull(control.session);

  // close() が残りの解放 (切り離し済みのため session 以外) と終端遷移を進めること
  await publisher.close();
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount, 1);
});

/**
 * 終端の通知が throw する最小の publisher
 *
 * "closed" への onStateChange を throw させ、onClose の回数を数える。終端の通知の失敗が
 * close() とピア起点の close のどちらの経路でも onClose を失わせないことを、同じ前提で
 * 検証するために共通化する。
 */
function createClosedNotificationTestContext(): {
  publisher: MediaPublisherImpl;
  control: PublisherSessionCloseControl;
  notificationFailure: Error;
  closeCount: () => number;
} {
  const notificationFailure = new Error("onStateChange failure");
  let closeCount = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onStateChange: (state) => {
        if (state === "closed") {
          throw notificationFailure;
        }
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  return {
    publisher,
    control: publisher as unknown as PublisherSessionCloseControl,
    notificationFailure,
    closeCount: () => closeCount,
  };
}

/**
 * 完了条件: 世代番号を一致させた通知でも onStateChange が throw すれば onClose は
 * 失われない。終端に固定された以上、早期 return する close() 以外に通知の回収経路が
 * 無いためである。
 */
test("handleSessionClose: onStateChange が throw しても onClose を通知する", async () => {
  const { publisher, control, notificationFailure, closeCount } =
    createClosedNotificationTestContext();
  control.currentState = "publishing";

  let thrown: unknown = null;
  try {
    await control.handleSessionClose(control.sessionGeneration);
  } catch (error) {
    thrown = error;
  }

  // 遷移の失敗はこの経路の結果として伝わるが、終端に固定された以上 onClose は失われない
  assert.strictEqual(thrown, notificationFailure);
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: 世代番号を一致させた通知でも onStateChange が throw すれば onClose は
 * 失われない (close() の経路)。
 */
test("close: onStateChange が throw しても onClose を通知する", async () => {
  const { publisher, notificationFailure, closeCount } = createClosedNotificationTestContext();

  let thrown: unknown = null;
  try {
    await publisher.close();
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, notificationFailure);
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount(), 1);

  // "closed" での再 close は早期 return するため、通知の回収経路はここだけであること
  await publisher.close();
  assert.equal(closeCount(), 1);
});

/**
 * 一時停止して世代番号の変化を確かめる
 *
 * pause() は処理ループの世代だけを進め、session の close 通知の世代番号は動かさない。
 * pause の前後を必要とする 2 つのテストで共有する。
 *
 * @returns pause() の前の世代番号 (session の close 通知の世代番号を含む)
 */
function pauseAndCaptureGenerations(
  publisher: MediaPublisherImpl,
  control: PublisherSessionCloseControl,
): { sessionGeneration: number; processingGeneration: number } {
  const snapshot = {
    sessionGeneration: control.sessionGeneration,
    processingGeneration: control.processingGeneration,
  };
  publisher.pause();
  assert.equal(publisher.state, "paused");
  assert.equal(control.processingGeneration, snapshot.processingGeneration + 1);
  assert.equal(control.sessionGeneration, snapshot.sessionGeneration);
  return snapshot;
}

/**
 * 完了条件: pause() のあとのピア起点 close 通知が世代不一致で捨てられない
 * (session の close 通知の世代番号に処理ループの世代を流用していない)。
 *
 * 世代番号は pause() の前に捕捉した値を使う。pause() のあとに読み直すと、pause で
 * 世代が進む実装でも通ってしまう。
 */
test("handleSessionClose: pause のあとのピア起点 close 通知は捨てられない", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  // pause() の前に session の閉包へ渡された世代番号
  const connectedGeneration = pauseAndCaptureGenerations(publisher, control).sessionGeneration;

  await control.handleSessionClose(connectedGeneration);

  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["paused", "closed"]);
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: 世代番号を進めるのは disposeAllResources() の 1 箇所だけで、既存の
 * processingGeneration の加算位置と回数が変わらない。
 */
test("session の世代番号は解放の 1 箇所だけで進み pause では進まない", async () => {
  const { publisher, control, states } = createSessionCloseTestContext();
  // pause / resume は処理ループの世代だけを進める
  const snapshot = pauseAndCaptureGenerations(publisher, control);
  publisher.resume();

  // 解放の直接駆動は 1 回で 1 だけ進める
  await control.disposeAllResources();
  assert.equal(control.sessionGeneration, snapshot.sessionGeneration + 1);

  // stop も解放 1 回分だけ進める (stop 本体では進めない)
  const beforeStop = control.sessionGeneration;
  const processingBeforeStop = control.processingGeneration;
  await publisher.stop();
  assert.equal(control.sessionGeneration, beforeStop + 1);
  assert.equal(control.processingGeneration, processingBeforeStop + 1);
  assert.equal(publisher.state, "stopped");

  // close も解放 1 回分だけ進める (close 本体では進めない)
  const beforeClose = control.sessionGeneration;
  const processingBeforeClose = control.processingGeneration;
  await publisher.close();
  assert.equal(control.sessionGeneration, beforeClose + 1);
  assert.equal(control.processingGeneration, processingBeforeClose + 1);
  assert.equal(publisher.state, "closed");
  // stop が "closed" を経由せず、終端の "closed" を 1 回だけ通ること
  assert.deepEqual(states, ["paused", "publishing", "stopped", "closed"]);
});

/**
 * 完了条件: 解放のあとに届いた session close 通知では state と onClose が変わらない。
 * 新しい session を確立したあとに旧 session の通知が届いた場合も無視される。
 *
 * 新しい session の確立は資源の注入と stop で再現し、世代番号は実装と同じ経路 (解放)
 * で進める (connectToServer が作る閉包そのものは接続を差し替えるテストで駆動する)。
 */
test("handleSessionClose: 解放のあとに届いた旧 session の通知では state と onClose が変わらない", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  // 旧 session が接続時に閉包へ渡された世代番号
  const oldGeneration = control.sessionGeneration;
  const { session: firstSession, isClosed: isFirstSessionClosed } = createRecordingSession();
  control.session = firstSession;

  await publisher.stop();
  assert.equal(publisher.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 1);
  assert.isTrue(isFirstSessionClosed());

  // 解放のあとに届いた旧 session の通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["stopped"]);
  assert.equal(closeCount(), 0);

  // 新しい session を確立したあとに旧 session の通知が届く場合も同じこと。新しい session は
  // 接続時に現在の世代番号を捕捉するため、旧 session の捕捉値とは一致しない。ここでは新しい
  // session の資源を注入して再度 stop し、世代番号をもう 1 つ進める
  control.currentState = "publishing";
  const { session: secondSession, isClosed: isSecondSessionClosed } = createRecordingSession();
  control.session = secondSession;
  await publisher.stop();
  assert.equal(publisher.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 2);
  assert.isTrue(isSecondSessionClosed());
  assert.deepEqual(states, ["stopped", "stopped"]);

  // 旧 session (2 世代前) の遅延通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["stopped", "stopped"]);
  assert.equal(closeCount(), 0);

  // 現世代の通知 (新しい session のピア起点の close) は扱われること
  await control.handleSessionClose(control.sessionGeneration);
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["stopped", "stopped", "closed"]);
  assert.equal(closeCount(), 1);
});

/**
 * ピア起点の close の解放を session の close で止め、解放が進行中の窓を作る
 *
 * 解放は session を切り離してから close を await するため、止めている間も state は
 * "publishing" などのままである (利用者の stop() / close() が入り込める窓になる)。
 *
 * @param control 駆動する MediaPublisher
 * @param hooks sessionCloseError を渡すと、止めていた解放を再開したときに session の
 *   close をそのエラーで失敗させる (解放の成否が相乗りした呼び出しへ伝わることの検証に使う)
 * @returns 解放を再開する関数と呼び出し回数、解放の開始を待つ Promise
 */
function startBlockedSessionClose(
  control: PublisherLifecycleControl,
  hooks: { sessionCloseError?: Error } = {},
): {
  release: () => void;
  closeCalls: () => number;
  started: Promise<void>;
} {
  // 解放を再開させる関数を null 許容の let で持つと型の絞り込みで呼べなくなるため、
  // 呼び出し可能な初期値 (何もしない) を持たせる
  let release: () => void = () => {};
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let closeCalls = 0;
  control.session = {
    close: () => {
      closeCalls++;
      notifyStarted();
      return new Promise<void>((resolve, reject) => {
        release = () => {
          if (hooks.sessionCloseError) {
            reject(hooks.sessionCloseError);
            return;
          }
          resolve();
        };
      });
    },
  } as unknown as Session;
  return { release: () => release(), closeCalls: () => closeCalls, started };
}

/**
 * 完了条件: ピア起点の close の解放中に stop() が重なった場合、state は "stopped" のままで
 * onClose は通知されない。
 *
 * 解放中は state が "publishing" のままであるため stop() は state ガードを通過する。
 * 進行中の解放を共有して完了を待ち、あとから解放を終えたピア起点の経路が state と onClose を
 * 動かすと、stop() の事後条件 (再 start 可能な "stopped" / onClose を通知しない) が崩れる。
 */
test("stop: ピア起点の close の解放中に呼ぶと stopped のままで onClose を通知しない", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  const blocked = startBlockedSessionClose(control);
  // この session の close 通知が捕捉する世代番号
  const generation = control.sessionGeneration;

  // ピア起点の close の解放を開始する (解放が止まっている間も state は "publishing")
  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(publisher.state, "publishing");

  // 解放中の窓で利用者が stop() を呼ぶ ("stopped" を決めるのはこちら)。
  // stop() は進行中の解放を共有するため、解放が終わるまで戻らない
  const stopping = publisher.stop();
  await sleep(0);
  assert.equal(publisher.state, "publishing");
  // session の close が stop からやり直されていないこと (参照は切り離し済み)
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると stop が "stopped" にし、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(publisher.state, "stopped");
  assert.equal(closeCount(), 0);
  assert.deepEqual(states, ["stopped"]);
});

/**
 * 完了条件: ピア起点の close の解放中に close() が重なっても、解放は 1 回で終端の通知も
 * 1 回だけになる。
 *
 * 解放中は state が "publishing" のままであるため、state を見た単発性の判定では両方の経路が
 * 終端通知に到達してしまう。close() は進行中の解放を共有して完了を待つ。
 */
test("close: ピア起点の close の解放中に呼んでも解放と通知は 1 回だけ", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  const blocked = startBlockedSessionClose(control);
  const generation = control.sessionGeneration;

  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(publisher.state, "publishing");

  // 解放中の窓で利用者が close() を呼ぶ (終端の通知はこちらが行う)。解放が終わるまで
  // 終端へは進まない
  const closingByUser = publisher.close();
  await sleep(0);
  assert.equal(publisher.state, "publishing");
  assert.equal(closeCount(), 0);
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると close() が終端まで進み、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([closingByUser, closing]);
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: ピア起点の close の解放に相乗りした close() は、その解放の失敗を結果として
 * 受け取る。
 *
 * ピア起点の経路は解放の失敗を onError で通知して戻るため、close() が相乗りしていなければ
 * 利用者は同じ失敗を close() の結果からは受け取れない。
 */
test("close: ピア起点の close の解放に相乗りしたら解放の失敗が close に伝わる", async () => {
  const failure = new Error("session close failure");
  const { publisher, control, states, errors, closeCount } = createSessionCloseTestContext();
  const blocked = startBlockedSessionClose(control, { sessionCloseError: failure });

  // ピア起点の close の解放を開始し、session の close で止める
  const peer = control.handleSessionClose(control.sessionGeneration);
  await blocked.started;
  assert.equal(publisher.state, "publishing");

  // 止めている間に close() を呼ぶ (進行中の解放を共有して完了を待つ)
  const closeResult = publisher.close().then(
    () => null,
    (error: unknown) => error,
  );

  // 解放を失敗させるとピア起点の経路は onError で通知し、close() は同じ失敗を throw する
  blocked.release();
  await peer;
  const closeFailure = await closeResult;
  assert.strictEqual(closeFailure, failure);
  assert.deepEqual(errors, [failure]);
  // 解放が失敗したため終端へは進まず、onClose も呼ばないこと
  assert.equal(publisher.state, "publishing");
  assert.equal(closeCount(), 0);
  assert.deepEqual(states, []);
  assert.equal(blocked.closeCalls(), 1);
});

/**
 * 完了条件: close() が解放と終端遷移を進めている間は stop() を呼べない。
 *
 * 解放中は state がまだ "publishing" のため、state だけを見た判定では停止が通過してしまう。
 * closing (進行中の close) を見た専用のエラーで fail fast にする。
 */
test("stop: close の解放中は cannot stop while closing で拒否する", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  const blocked = startBlockedSessionClose(control);

  const closing = publisher.close();
  await blocked.started;
  assert.equal(publisher.state, "publishing");

  // 解放中の stop() は state ガードではなく closing のガードで拒否されること
  let stopThrown: unknown = null;
  try {
    await publisher.stop();
  } catch (error) {
    stopThrown = error;
  }
  assert.instanceOf(stopThrown, Error);
  assert.equal((stopThrown as Error).message, "cannot stop while closing");

  // 拒否は解放をやり直さないこと
  assert.equal(blocked.closeCalls(), 1);
  blocked.release();
  await closing;
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: close() が解放と終端遷移を進めている間は start() を呼べない。
 *
 * "created" からの close() では解放中も state が "created" のままであり、state だけを
 * 見た判定では開始が通過してしまう。
 */
test("start: close の解放中は cannot start while closing で拒否する", async () => {
  const states: MediaPublisherState[] = [];
  const errors: Error[] = [];
  let closeCount = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = publisher as unknown as PublisherLifecycleControl;
  const blocked = startBlockedSessionClose(control);

  const closing = publisher.close();
  await blocked.started;
  assert.equal(publisher.state, "created");

  // 解放中の start() は state ガードではなく closing のガードで拒否されること
  let startThrown: unknown = null;
  try {
    await publisher.start({} as MediaStream);
  } catch (error) {
    startThrown = error;
  }
  assert.instanceOf(startThrown, Error);
  assert.equal((startThrown as Error).message, "cannot start while closing");
  // 拒否は接続も解放もやり直さないこと
  assert.equal(blocked.closeCalls(), 1);

  blocked.release();
  await closing;
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount, 1);
  assert.deepEqual(states, ["closed"]);
  assert.deepEqual(errors, []);
});

/**
 * 完了条件: await せずに重ねて呼んだ close() は進行中の解放と終端遷移を共有する。
 *
 * 2 回目の close() が自分で解放をやり直すと、解放が session の close で止まっている間に
 * no-op の解放が先に終わり、1 回目の終端遷移を待たずに返ってしまう。世代の加算は 1 回に
 * 留まることでも、2 回目が新しい解放を始めていないことを固定する。
 */
test("close: await せずに重ねて呼んでも解放の完了を待って通知は 1 回だけ", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  const blocked = startBlockedSessionClose(control);
  const processingGeneration = control.processingGeneration;

  const first = publisher.close();
  await blocked.started;
  const second = publisher.close();
  // 解放が止まっている間は 2 回目も終端へ進まないこと (進行中の close を共有している)
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await sleep(0);
  assert.isFalse(secondSettled);
  assert.equal(publisher.state, "publishing");
  assert.equal(blocked.closeCalls(), 1);
  // 2 回目は自分で解放を始めないこと (世代の加算は 1 回だけ)
  assert.equal(control.processingGeneration, processingGeneration + 1);

  // 解放を終えると両方が終端になり、通知は 1 回だけになること
  blocked.release();
  await Promise.all([first, second]);
  assert.isTrue(secondSettled);
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
  assert.equal(control.processingGeneration, processingGeneration + 1);
});

/**
 * 完了条件: "paused" からの stop() も解放して "stopped" へ遷移し、onClose を通知しない
 * ("stopped" は終端ではなく、再 start できる停止である)。
 */
test("stop: paused から停止しても stopped になり onClose は通知しない", async () => {
  const { publisher, control, states, closeCount } = createSessionCloseTestContext();
  const { session, isClosed } = createRecordingSession();
  control.session = session;

  publisher.pause();
  await publisher.stop();

  // 解放して "stopped" になること
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["paused", "stopped"]);
  assert.equal(closeCount(), 0);
  assert.isTrue(isClosed());
  assert.isNull(control.session);

  // "stopped" からの再 stop は停止の事後条件どおり拒否されること
  let thrown: unknown = null;
  try {
    await publisher.stop();
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "cannot stop in state: stopped");
});

/**
 * 接続 1 回分の観測口
 */
interface OpenedPublisherConnection {
  // 実装が onSessionClose に渡した閉包 (接続時点の世代番号を捕捉している)
  notifyClose: () => void;
  // 保留している publish が await に入るまで待つ
  publishing: () => Promise<void>;
  // 保留している publish の await を解放する (保留していない場合は何もしない)
  resolvePublish: () => void;
  // 保留している session の close が呼ばれた時点で解決する (解放がそこで止まったことの観測)
  sessionClosing: () => Promise<void>;
  // 保留している session の close の await を解放する (保留していない場合は何もしない)
  resolveSessionClose: () => void;
  // この接続の session の close が呼ばれた回数 (解放が session を閉じたか)
  sessionCloseCalls: () => number;
  isSessionClosed: () => boolean;
  // この接続が作った catalog Publisher の done の呼び出し回数 (解放で破棄されたか)
  catalogDoneCount: () => number;
}

/**
 * 接続を差し替えて start() を最後まで駆動するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続と publish の完了をテストが
 * 決められるようにする (モジュール置換は行わない)。接続ごとに実装が作る
 * onSessionClose の閉包をそのまま捕捉し、閉包の回収経路も駆動できるようにする。
 * catalog の publish は常に受け付け、音声 / 映像の publish も最小の Publisher を返す。
 *
 * @param callbacks 検証に使うコールバック (onError は呼び出しの記録に使う)
 * @param options holdPublish を立てると publish の await をテストが解放するまで保留する
 *   (解放が start の await に重なる窓を作る)。保留するのは holdPublishTrack (既定は
 *   catalog) の publish である。createCatalogPublisher を渡すと catalog の Publisher を
 *   作り分ける (送信の失敗を start の catch まで運ぶ)。publisherOptions を渡すと publisher の
 *   オプションを差し替える (音声 / 映像の設定を持つ harness で start を駆動するテスト用)。
 *   holdSessionClose を立てると session の close の await もテストが解放するまで保留する
 *   (解放が session の close で止まる窓を作る。解放は参照を切り離してから close するため、
 *   止めている間も state は遷移前のままである)
 */
function createStartConnectHarness(
  callbacks: MediaPublisherCallbacks = {},
  options: {
    holdPublish?: boolean;
    holdPublishTrack?: string;
    holdSessionClose?: boolean;
    createCatalogPublisher?: () => { publisher: Publisher; doneCount: () => number };
    publisherOptions?: MediaPublisherOptions;
    // session の reliability。datagram が reliable and ordered になるセッション ("reliable-only") の検証に使う
    reliability?: string;
  } = {},
): {
  publisher: MediaPublisherImpl;
  control: PublisherConnectControl & PublisherLifecycleControl & PublisherSessionCloseControl;
  errors: Error[];
  opened: OpenedPublisherConnection[];
} {
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    options.publisherOptions ?? { namespace: ["live"] },
    {
      ...callbacks,
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = publisher as unknown as PublisherConnectControl &
    PublisherLifecycleControl &
    PublisherSessionCloseControl;
  const opened: OpenedPublisherConnection[] = [];
  control.openSession = (settings: MediaConnectSettings) => {
    const catalog = options.createCatalogPublisher?.() ?? createRecordingSendPublisher();
    let closed = false;
    let notifyPublishing: () => void = () => {};
    const publishing = new Promise<void>((resolve) => {
      notifyPublishing = resolve;
    });
    let releasePublish: () => void = () => {};
    const publishGate = options.holdPublish
      ? new Promise<void>((resolve) => {
          releasePublish = resolve;
        })
      : null;
    // session の close の保留。解放は session の参照を切り離してから close を await するため、
    // 止めている間も解放は進行中のまま (state は遷移前のまま) になる
    let notifySessionClosing: () => void = () => {};
    const sessionClosing = new Promise<void>((resolve) => {
      notifySessionClosing = resolve;
    });
    let releaseSessionClose: () => void = () => {};
    const sessionCloseGate = options.holdSessionClose
      ? new Promise<void>((resolve) => {
          releaseSessionClose = resolve;
        })
      : null;
    let sessionCloseCalls = 0;
    const holdPublishTrack = options.holdPublishTrack ?? CATALOG_TRACK_NAME;
    const session = {
      // datagram の可否は reliability で決まる (start の音声の送り方の判定が読む)。
      // 実際の Session は WebTransport の reliability をそのまま返す
      reliability: options.reliability,
      publish: async (
        _namespace: string[],
        trackName: string,
        _callbacks?: PublishCallbacks,
      ): Promise<Publisher> => {
        // 保留する publish だけテストが完了を決める
        if (publishGate !== null && trackName === holdPublishTrack) {
          notifyPublishing();
          await publishGate;
        }
        if (trackName === CATALOG_TRACK_NAME) {
          return catalog.publisher;
        }
        // 音声 / 映像の Publisher も最小の Publisher を返す (音声 / 映像の設定を持つ
        // harness で createPublishers を通すため)
        return createRecordingSendPublisher().publisher;
      },
      close: async () => {
        closed = true;
        sessionCloseCalls++;
        notifySessionClosing();
        if (sessionCloseGate !== null) {
          await sessionCloseGate;
        }
      },
    } as unknown as Session;
    opened.push({
      notifyClose: () => settings.onSessionClose(),
      publishing: () => publishing,
      resolvePublish: () => releasePublish(),
      sessionClosing: () => sessionClosing,
      resolveSessionClose: () => releaseSessionClose(),
      sessionCloseCalls: () => sessionCloseCalls,
      isSessionClosed: () => closed,
      catalogDoneCount: catalog.doneCount,
    });
    return Promise.resolve(session);
  };
  return { publisher, control, errors, opened };
}

/**
 * 完了条件: connectToServer が作る onSessionClose の閉包は接続時点の世代番号を捕捉し、
 * 解放のあとに叩いても state も onClose も動かさない。新しい session の閉包は再接続時の
 * 現在値を捕捉する。
 *
 * 接続の境界 (openSession) だけを置き換えて start() を最後まで駆動し、実装が実際に作る
 * 閉包を捕捉して叩く。閉包が捕捉値ではなく通知時の this.sessionGeneration を読む実装に
 * 戻すと、stop() のあとに叩いた旧 session の通知がピア起点の close として扱われ、
 * state が "closed" になって onClose が呼ばれるため、このテストは落ちる。
 */
test("start: 接続の世代番号は接続時に捕捉され 解放後の閉包は通知しない", async () => {
  const states: MediaPublisherState[] = [];
  let closeCount = 0;
  const { publisher, opened } = createStartConnectHarness({
    onStateChange: (state) => {
      states.push(state);
    },
    onClose: () => {
      closeCount++;
    },
  });

  // 1 回目の start は接続が成功し "publishing" まで進む
  const stream = {} as MediaStream;
  await publisher.start(stream);
  assert.equal(publisher.state, "publishing");
  assert.equal(opened.length, 1);

  // stop は解放して "stopped" にし、session を閉じる (世代番号が 1 つ進む)
  await publisher.stop();
  assert.equal(publisher.state, "stopped");
  assert.isTrue(opened[0].isSessionClosed());

  // 解放のあとに叩いた旧 session の閉包は世代不一致で捨てられること
  opened[0].notifyClose();
  await sleep(0);
  assert.equal(publisher.state, "stopped");
  assert.deepEqual(states, ["publishing", "stopped"]);
  assert.equal(closeCount, 0);

  // 再 start の接続は現在の世代番号を捕捉すること
  await publisher.start(stream);
  assert.equal(publisher.state, "publishing");
  assert.equal(opened.length, 2);

  // 新しい session を確立したあとに届いた旧 session の通知も捨てられること
  opened[0].notifyClose();
  await sleep(0);
  assert.equal(publisher.state, "publishing");
  assert.deepEqual(states, ["publishing", "stopped", "publishing"]);
  assert.equal(closeCount, 0);

  // 現世代の閉包 (新しい session のピア起点の close) は解放してから "closed" を通知すること
  opened[1].notifyClose();
  await sleep(0);
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["publishing", "stopped", "publishing", "closed"]);
  assert.equal(closeCount, 1);
  assert.isTrue(opened[1].isSessionClosed());
});

test("start: catalog の Group ID は stop 後の再 start で前回を上回る", async () => {
  // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の過去の全 Group ID を上回る。
  // 接続の境界だけを置き換えて start() → stop() → start() を最後まで駆動し、catalog の
  // Group ID が再 start で 0 に戻らないことを確認する
  const sentByConnection: { groupId: number; objectId: number }[][] = [];
  const { publisher } = createStartConnectHarness(
    {},
    {
      createCatalogPublisher: () => {
        const { publisher: catalogPublisher, sent, doneCount } = createRecordingSendPublisher();
        sentByConnection.push(sent);
        return { publisher: catalogPublisher, doneCount };
      },
    },
  );

  const stream = {} as MediaStream;
  await publisher.start(stream);
  assert.equal(sentByConnection.length, 1);
  assert.equal(sentByConnection[0]?.length, 1);
  assert.equal(sentByConnection[0]?.[0]?.objectId, 0);
  const firstGroupId = sentByConnection[0]?.[0]?.groupId ?? 0;

  await publisher.stop();
  await publisher.start(stream);
  assert.equal(sentByConnection.length, 2);
  assert.equal(sentByConnection[1]?.length, 1);
  assert.isAbove(sentByConnection[1]?.[0]?.groupId ?? 0, firstGroupId);
  assert.equal(sentByConnection[1]?.[0]?.objectId, 0);

  // 予約を残さない
  await publisher.close();
});

/**
 * catalog の送信に endOfSubgroup を付ける
 *
 * draft-ietf-moq-transport-22 §11.3.2: Subgroup の全 Object を QUIC stream へ出し終えたら
 * FIN で閉じる MUST。catalog は delta を送らない (draft-ietf-moq-msf-01 §5) ため、Group の
 * 先頭 Object 1 つでその Subgroup は完結する。閉じないと次の送り直し (既定 30 秒後) まで
 * 開いたままになる。ここでは記録用 Publisher で送信パラメータを検証し、実際に FIN が
 * 出ることは src/session/publishEndOfSubgroup.test.ts が実 WritableStream で固定する。
 */
test("start: catalog の送信に endOfSubgroup を付ける", async () => {
  const sentByConnection: { endOfSubgroup?: boolean }[][] = [];
  const { publisher } = createStartConnectHarness(
    {},
    {
      createCatalogPublisher: () => {
        const { publisher: catalogPublisher, sent, doneCount } = createRecordingSendPublisher();
        sentByConnection.push(sent);
        return { publisher: catalogPublisher, doneCount };
      },
    },
  );

  const stream = {} as MediaStream;
  await publisher.start(stream);

  // 初期送信の時点で endOfSubgroup が付いている (送り直しの 30 秒を待たない)
  assert.equal(sentByConnection.length, 1);
  assert.equal(sentByConnection[0]?.length, 1);
  assert.isTrue(sentByConnection[0]?.[0]?.endOfSubgroup);

  await publisher.close();
});

/**
 * WebCodecs の映像エンコーダーの境界を置き換えて setupEncoders を駆動する
 *
 * node には VideoEncoder と MediaStreamTrackProcessor が無いため、この境界だけを置き換えて
 * 映像エンコーダーの作成と configure まで到達させる (useWorker: false の直接実行にする。
 * 実ブラウザの WebCodecs を駆動する経路は e2e で確認する)。作成 / configure / 破棄の回数を
 * 数え、解放のあとに作られていないことと、解放で破棄されたことを固定できるようにする。
 *
 * @param hooks onConfigure を渡すと configure の呼び出しからテスト側の処理 (close() など) を
 *   挟める (解放を configure の await の窓に重ねる)
 * @returns 回数の取得と、置き換えを元に戻す関数 (テストの finally で必ず呼ぶ)
 */
function replaceVideoCodecBoundary(hooks: { onConfigure?: () => void } = {}): {
  createdCount: () => number;
  configureCount: () => number;
  closeCount: () => number;
  restore: () => void;
} {
  const target = globalThis as unknown as {
    VideoEncoder: unknown;
    MediaStreamTrackProcessor: unknown;
  };
  const originalVideoEncoder = target.VideoEncoder;
  const originalTrackProcessor = target.MediaStreamTrackProcessor;
  let createdCount = 0;
  let configureCount = 0;
  let closeCount = 0;
  target.VideoEncoder = class {
    readonly state = "configured";
    constructor() {
      createdCount++;
    }
    configure(): void {
      configureCount++;
      hooks.onConfigure?.();
    }
    encode(): void {}
    close(): void {
      closeCount++;
    }
  };
  // setupEncoders のあとに続く VideoFrameSource の作成経路を通す (実 ReadableStream を返す)
  target.MediaStreamTrackProcessor = class {
    readonly readable = new ReadableStream<VideoFrame>();
  };
  return {
    createdCount: () => createdCount,
    configureCount: () => configureCount,
    closeCount: () => closeCount,
    restore: () => {
      target.VideoEncoder = originalVideoEncoder;
      target.MediaStreamTrackProcessor = originalTrackProcessor;
    },
  };
}

/**
 * 映像の設定を持つ媒体ストリーム
 *
 * setupEncoders は映像トラックの設定を読むため、getSettings を持つ最小のトラックを返す。
 */
function createVideoMediaStream(): MediaStream {
  return {
    getAudioTracks: () => [],
    getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480 }) }],
  } as unknown as MediaStream;
}

/**
 * WebCodecs の音声エンコーダーと音声の取り出し経路の境界を置き換える
 *
 * node には AudioEncoder と MediaStreamTrackProcessor が無いため、この境界だけを
 * 置き換えて音声の取り出しからエンコーダーの configure まで到達させる (useWorker: false の
 * 直接実行にする。実ブラウザの WebCodecs を駆動する経路は e2e で確認する)。
 * configure へ渡った設定と、取り出し経路 (MediaStreamTrackProcessor) の生成回数を記録し、
 * どの形式で何度構成したかを固定できるようにする。
 *
 * @param hooks onIsConfigSupported を渡すと対応確認の結果を差し替えられる
 *   (取り出した形式が非対応のときに start() が失敗する経路を駆動する)
 * @returns 取り出し経路の生成回数と configure へ渡った設定の取得と、置き換えを元に戻す
 *   関数 (テストの finally で必ず呼ぶ)
 */
function replaceAudioCodecBoundary(
  hooks: {
    onIsConfigSupported?: (config: AudioEncoderConfig) => { supported: boolean };
    /** 実符号化確認 (probe) の符号化だけを失敗させる (対応の申告は true のまま) */
    probeEncodeFails?: boolean;
  } = {},
): {
  frameSourceCreatedCount: () => number;
  configuredConfigs: () => AudioEncoderConfig[];
  restore: () => void;
} {
  const target = globalThis as unknown as {
    AudioEncoder: unknown;
    AudioData: unknown;
    MediaStreamTrackProcessor: unknown;
  };
  const originalAudioEncoder = target.AudioEncoder;
  const originalAudioData = target.AudioData;
  const originalTrackProcessor = target.MediaStreamTrackProcessor;
  // 実際に符号化できるかを確かめる probe (src/codec/configSupport.ts の
  // probeAudioEncoderConfig) が作る AudioData。probe の確認用エンコーダーを
  // 本物のエンコーダーと取り違えないよう、この型で encode されたインスタンスを
  // probe とみなす
  class ProbeAudioData {
    close(): void {}
  }
  // probe の確認用エンコーダーも含めた全インスタンス。configure の記録は
  // 本物のエンコーダー (probe 以外) のものだけを返す
  const encoders: {
    probe: boolean;
    config: AudioEncoderConfig | null;
  }[] = [];
  let frameSourceCreatedCount = 0;
  target.AudioData = ProbeAudioData;
  target.AudioEncoder = class {
    readonly state = "configured";
    private readonly entry: { probe: boolean; config: AudioEncoderConfig | null };
    private readonly init: {
      output?: (chunk: unknown) => void;
      error?: (error: unknown) => void;
    };
    static async isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean }> {
      return hooks.onIsConfigSupported?.(config) ?? { supported: true };
    }
    constructor(init: { output?: (chunk: unknown) => void }) {
      this.init = init;
      this.entry = { probe: false, config: null };
      encoders.push(this.entry);
    }
    configure(config: AudioEncoderConfig): void {
      this.entry.config = config;
    }
    encode(data: unknown): void {
      // probe は確認用の AudioData を渡してくる。本物のエンコーダーは
      // 取り出し経路のフレーム (テストでは流れない) を渡すため区別できる
      if (data instanceof ProbeAudioData) {
        this.entry.probe = true;
        if (hooks.probeEncodeFails === true) {
          // 対応の申告は true なのに実際の符号化が失敗する環境 (Chrome 155 の AAC で
          // ビットレートが下限未満のとき) を再現する。出力は返さず理由だけを通知する
          this.init.error?.(new Error("Encoding error."));
          return;
        }
        // 出力チャンクを 1 件返し、probe を「符号化できた」と判定させる
        this.init.output?.({});
      }
    }
    async flush(): Promise<void> {}
    close(): void {}
  };
  // createProcessorAudioFrameSource の経路を通す (実 ReadableStream を返す)
  target.MediaStreamTrackProcessor = class {
    readonly readable = new ReadableStream<AudioData>();
    constructor() {
      frameSourceCreatedCount++;
    }
  };
  return {
    frameSourceCreatedCount: () => frameSourceCreatedCount,
    configuredConfigs: () =>
      encoders.flatMap((entry) => (entry.probe || entry.config === null ? [] : [entry.config])),
    restore: () => {
      target.AudioEncoder = originalAudioEncoder;
      target.AudioData = originalAudioData;
      target.MediaStreamTrackProcessor = originalTrackProcessor;
    },
  };
}

/**
 * 指定の形式の音声トラックだけを持つ媒体ストリーム
 *
 * 音声の取り出し経路 (MediaStreamTrackProcessor) はトラックの getSettings() を実際に
 * 流れる形式として読むため、マイクの形式を模した値を返す最小のトラックを渡す。
 */
function createAudioMediaStream(settings: {
  sampleRate: number;
  channelCount: number;
}): MediaStream {
  return {
    getAudioTracks: () => [{ getSettings: () => settings }],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

/**
 * 音声の取り出し経路を駆動する start() の harness
 *
 * 音声の配信設定と useWorker: false を持つ publisher と、接続ごとの catalog の送信 payload を
 * 返す (再試行は新しい接続で行うため、接続ごとに分けて記録する)。
 */
function createAudioStartHarness(options: { reliability?: string } = {}): {
  publisher: MediaPublisherImpl;
  control: PublisherConnectControl & PublisherLifecycleControl & PublisherSessionCloseControl;
  sentByConnection: { payload?: Uint8Array }[][];
  errors: Error[];
} {
  const sentByConnection: { payload?: Uint8Array }[][] = [];
  const { publisher, control, errors } = createStartConnectHarness(
    {},
    {
      reliability: options.reliability,
      publisherOptions: {
        namespace: ["live"],
        audio: { codec: "opus", bitrate: 64000 },
        useWorker: false,
      },
      createCatalogPublisher: () => {
        const { publisher: catalogPublisher, sent, doneCount } = createRecordingSendPublisher();
        sentByConnection.push(sent);
        return { publisher: catalogPublisher, doneCount };
      },
    },
  );
  return { publisher, control, sentByConnection, errors };
}

/**
 * 完了条件: 音声の形式を省略したときも、取り出し経路が返したサンプルレートとチャンネル数が
 * Catalog と AudioEncoder の設定になる。要求値 (既定の 48000 Hz / 2 ch) では configure しない。
 *
 * 取り出し経路より先に catalog を publish する実装に戻すと、catalog の samplerate と
 * channelConfig が要求値のままになるため、このテストは落ちる。start() を最後まで駆動し、
 * 送信 payload の読み戻しと configure の記録の両方で同じ形式を確かめる。
 */
test("start: 取り出した音声の形式を catalog と encoder の両方に使う", async () => {
  const boundary = replaceAudioCodecBoundary();
  try {
    const { publisher, sentByConnection } = createAudioStartHarness();

    // マイクはモノラルで 44100 Hz (要求した既定の 48000 Hz / 2 ch と違う形式)
    await publisher.start(createAudioMediaStream({ sampleRate: 44100, channelCount: 1 }));

    const catalogObject = sentByConnection[0]?.[0];
    if (catalogObject?.payload === undefined) {
      throw new Error("expected the catalog object to be sent");
    }
    const decoded = decodeCatalogMessage(catalogObject.payload);
    if (!("version" in decoded)) {
      throw new Error("expected a full catalog, got a delta update");
    }
    const audioTrack = decoded.tracks.find((track) => track.role === "audio");
    assert.isDefined(audioTrack);
    assert.equal(audioTrack?.samplerate, 44100);
    assert.equal(audioTrack?.channelConfig, "1");

    // エンコーダーも catalog と同じ取り出した形式で configure する
    assert.deepEqual(boundary.configuredConfigs(), [
      { codec: "opus", sampleRate: 44100, numberOfChannels: 1, bitrate: 64000 },
    ]);
    // 取り出し経路は 1 回の start につき 1 度だけ作る。setupEncoders で作り直す実装に
    // 戻すと、Catalog とエンコーダーは同じ値のまま緑になり、prepareAudioFrameSource が
    // 作った経路 (Web Audio 経路では AudioContext) が解放されずに残る
    assert.equal(boundary.frameSourceCreatedCount(), 1);

    await publisher.close();
  } finally {
    boundary.restore();
  }
});

/**
 * 完了条件: 取り出した形式がコーデックで符号化できないときは、catalog を送る前に start() が
 * 失敗し、configure もしない。エラーには codec と sampleRate と channels を含める。
 *
 * `AudioEncoder.configure` は未対応の設定でも同期の例外を投げず非同期のエラーになるため、
 * 対応確認を省くと、音声の object が届かないトラックを宣言した catalog が購読側へ渡る。
 * 形式を変えた再試行まで駆動し、start ごとに形式を取り直すことも確かめる。
 */
test("start: 取り出した形式が非対応なら catalog を送る前に失敗し、形式を変えれば再試行できる", async () => {
  // 1 回目は非対応、2 回目は対応として返す (取り出し経路は start ごとに作り直される)
  let configSupported = false;
  const boundary = replaceAudioCodecBoundary({
    onIsConfigSupported: () => ({ supported: configSupported }),
  });
  try {
    const { publisher, control, sentByConnection, errors } = createAudioStartHarness();

    let thrown: unknown = null;
    try {
      await publisher.start(createAudioMediaStream({ sampleRate: 44100, channelCount: 1 }));
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    // どの形式が非対応だったかがメッセージだけで分かること
    assert.match((thrown as Error).message, /codec=opus/);
    assert.match((thrown as Error).message, /sampleRate=44100/);
    assert.match((thrown as Error).message, /channels=1/);
    // configure も catalog の送信もしない (接続はしているため、記録の枠だけが作られる)
    assert.isEmpty(boundary.configuredConfigs());
    assert.equal(sentByConnection.length, 1);
    assert.equal(sentByConnection[0]?.length, 0);
    // 中止は通知を伴う失敗であるため onError は 1 回だけ (二重通知しない)
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], thrown);
    // 確保した取り出し経路は巻き戻しで解放する (残すと Web Audio 経路では AudioContext が残る)
    assert.isNull(control.audioFrameSource);
    // state は動かさない
    assert.equal(publisher.state, "created");

    // 対応する形式のマイクに変えて再試行すると、その形式で catalog と encoder を構成する
    configSupported = true;
    await publisher.start(createAudioMediaStream({ sampleRate: 32000, channelCount: 2 }));
    assert.equal(publisher.state, "publishing");
    assert.equal(boundary.frameSourceCreatedCount(), 2);

    // 再試行の接続で送った catalog を使う (1 回目の接続では catalog を送っていない)
    assert.equal(sentByConnection.length, 2);
    const catalogObject = sentByConnection[1]?.[0];
    if (catalogObject?.payload === undefined) {
      throw new Error("expected the catalog object to be sent");
    }
    const decoded = decodeCatalogMessage(catalogObject.payload);
    if (!("version" in decoded)) {
      throw new Error("expected a full catalog, got a delta update");
    }
    const audioTrack = decoded.tracks.find((track) => track.role === "audio");
    assert.equal(audioTrack?.samplerate, 32000);
    assert.equal(audioTrack?.channelConfig, "2");
    assert.deepEqual(boundary.configuredConfigs(), [
      { codec: "opus", sampleRate: 32000, numberOfChannels: 2, bitrate: 64000 },
    ]);

    await publisher.close();
  } finally {
    boundary.restore();
  }
});

/**
 * 完了条件: 対応の申告はあるが実際の符号化が失敗する形式では、catalog を送る前に
 * start() が失敗し、エンコーダーが返した理由をエラーに含める。
 *
 * AAC はブラウザのエンコーダーがビットレートの下限を持ち、範囲外では
 * isConfigSupported が true を返しても実際の符号化が EncodingError になる
 * (Chrome 155 の macOS で実測)。対応の申告だけで配信を始めると、音声 Object が
 * 1 つも送られないまま catalog だけが音声トラックを広告する。
 */
test("start: 取り出した形式の実符号化が失敗したら catalog を送る前に失敗する", async () => {
  const boundary = replaceAudioCodecBoundary({ probeEncodeFails: true });
  try {
    const { publisher, sentByConnection, errors } = createAudioStartHarness();

    let thrown: unknown = null;
    try {
      await publisher.start(createAudioMediaStream({ sampleRate: 48000, channelCount: 1 }));
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    // どの設定が符号化できなかったかと、エンコーダーが返した理由が読めること
    assert.match((thrown as Error).message, /codec=opus/);
    assert.match((thrown as Error).message, /bitrate=64000/);
    assert.match((thrown as Error).message, /: Encoding error\./);
    // configure も catalog の送信もしない (接続はしているため、記録の枠だけが作られる)
    assert.isEmpty(boundary.configuredConfigs());
    assert.equal(sentByConnection.length, 1);
    assert.equal(sentByConnection[0]?.length, 0);
    // 中止は通知を伴う失敗であるため onError は 1 回だけ
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], thrown);
    // state は動かさない (再試行できる)
    assert.equal(publisher.state, "created");

    await publisher.close();
  } finally {
    boundary.restore();
  }
});

/**
 * 完了条件 (draft-ietf-moq-msf-01 §11.2): catalog の Object を media の Object より先に
 * publish する MUST。ピアが catalog の PUBLISH を cancel すると (STOP_SENDING) publisher は
 * active でなくなるため、catalog を送らないまま media の Object を流さずに start() を失敗させる。
 *
 * 送信を握り潰して "publishing" へ進む実装に戻すと、catalog が 1 件も届かないまま音声・映像の
 * Object だけが流れるため、このテストは落ちる。
 */
test("start: 初期 catalog の送信時に publisher が active でなければ publishing に進まない", async () => {
  const closedCatalogPublisher = {
    state: "closed",
    forwardState: false,
    sendObject: async () => {},
    done: async () => {},
  } as unknown as Publisher;
  const { publisher, errors } = createStartConnectHarness(
    {},
    {
      publisherOptions: {
        namespace: ["live"],
        video: { codec: "vp8", bitrate: 1_000_000 },
        useWorker: false,
      },
      createCatalogPublisher: () => ({ publisher: closedCatalogPublisher, doneCount: () => 0 }),
    },
  );

  let thrown: unknown = null;
  try {
    await publisher.start(createVideoMediaStream());
  } catch (error) {
    thrown = error;
  }

  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /catalog publisher state is closed/);
  // media の Object を流す状態 ("publishing") へ進まない
  assert.equal(publisher.state, "created");
  // 失敗は通知を伴う (二重通知しない)
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});

/**
 * 完了条件: 音声の取り出し経路 (MediaStreamTrackProcessor か Web Audio) が無いブラウザでは、
 * catalog を publish する前に start() を失敗させる (音声トラックを宣言した catalog を送った
 * 後に object が出せない状態を作らない)。
 *
 * node にはどちらの経路も無い (src/audioSource.test.ts が isAudioFrameSourceAvailable の
 * false を固定している) ため、境界を置き換えずにそのまま駆動できる。
 */
test("start: 音声の取り出し経路が無ければ catalog を送る前に失敗する", async () => {
  const { publisher, sentByConnection, errors } = createAudioStartHarness();

  let thrown: unknown = null;
  try {
    await publisher.start(createAudioMediaStream({ sampleRate: 48000, channelCount: 2 }));
  } catch (error) {
    thrown = error;
  }

  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /MediaStreamTrackProcessor or Web Audio AudioWorklet/);
  // catalog は送らず (接続の記録だけが作られる)、state も動かさない
  assert.equal(sentByConnection.length, 1);
  assert.equal(sentByConnection[0]?.length, 0);
  assert.equal(publisher.state, "created");
  // 失敗は通知を伴う (二重通知しない)
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});

/**
 * 完了条件: start の実行中 (createPublishers の await) に利用者の close() が先行した場合、
 * state は "closed" のままで "publishing" に戻らない。
 *
 * 各段階の await の直後の検査 (assertStartNotDisposed) が無いと、解放のあとに
 * createPublishers が戻って処理ループを起動し、"closed" のあとに "publishing" へ進んで
 * しまう (終端が破れ、解放されないリソースも残る)。catalog トラックの PUBLISH の完了を
 * テストが握り、解放が先に終端へ進んだ状態で start を再開させる。
 */
test("start: createPublishers の await 中に close したら closed のままで publishing に戻らない", async () => {
  const states: MediaPublisherState[] = [];
  let closeCount = 0;
  const { publisher, errors, opened } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    { holdPublish: true },
  );

  const startResult = publisher.start({} as MediaStream).then(
    () => null,
    (error: unknown) => error,
  );
  // createPublishers が catalog トラックの PUBLISH を await したところで止める
  await opened[0].publishing();
  assert.equal(publisher.state, "created");

  // 解放が先行して終端へ進む
  await publisher.close();
  assert.equal(publisher.state, "closed");
  assert.isTrue(opened[0].isSessionClosed());

  // publish を解放して createPublishers を戻すと、検査が解放の先行を検知して中止する
  opened[0].resolvePublish();
  const startFailure = await startResult;

  assert.instanceOf(startFailure, Error);
  assert.isTrue((startFailure as Error).message.includes("start aborted"));
  // "publishing" へ進まず、"closed" のままであること
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);
  // 中止までに確保した catalog の Publisher が巻き戻しで破棄されること
  assert.equal(opened[0].catalogDoneCount(), 1);
  // 中止は通知を伴う失敗であるため onError は 1 回だけ
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
});

/**
 * 完了条件: 解放が進行中のまま createPublishers が戻った場合、解放のあとに続く段階へ進まず、
 * エンコーダーを作らない ("これ以上リソースを作らない")。
 *
 * 解放は mediaStream を切り離すため、解放が完了していれば setupEncoders は素通りし、state
 * だけでは検査の有無の差が出ない。解放の最初の段階 (フレームリーダーの cancel) を実
 * ReadableStream の cancel で保留し、mediaStream がまだ切り離されていない状態で
 * createPublishers を戻す。WebCodecs の境界を置き換えて、映像エンコーダーの作成と configure
 * が呼ばれないことを数える。
 */
test("start: 解放が進行中のまま createPublishers が戻ったらエンコーダーを作らない", async () => {
  const boundary = replaceVideoCodecBoundary();
  let releaseCancel: () => void = () => {};
  try {
    const { publisher, control, opened } = createStartConnectHarness(
      {},
      {
        holdPublish: true,
        holdPublishTrack: "video",
        publisherOptions: {
          namespace: ["live"],
          useWorker: false,
          video: { trackName: "video", codec: "vp8", bitrate: 1_000_000 },
        },
      },
    );
    // 解放の最初の段階 (reader の cancel) を保留する。解放はここで止まり、mediaStream は
    // まだ切り離されていない
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    control.audioFrameReader = new ReadableStream<AudioData>({
      cancel: () => cancelGate,
    }).getReader();

    const startResult = publisher.start(createVideoMediaStream()).then(
      () => null,
      (error: unknown) => error,
    );
    // 映像の publish を await したところで止める
    await opened[0].publishing();

    // 解放を開始する (最初の段階で止まるため、解放は進行中のままになる)
    const closing = publisher.close();
    assert.equal(boundary.createdCount(), 0);

    // 解放が進行中のまま createPublishers を戻す
    opened[0].resolvePublish();
    await sleep(0);

    // 解放が進行中でも次の段階へ進まず、エンコーダーを作らないこと
    assert.equal(boundary.createdCount(), 0);
    assert.equal(boundary.configureCount(), 0);

    releaseCancel();
    await closing;
    const startFailure = await startResult;

    assert.instanceOf(startFailure, Error);
    assert.isTrue((startFailure as Error).message.includes("start aborted"));
    assert.equal(publisher.state, "closed");
  } finally {
    // 解放が保留のままだとテストが終われないため、必ず解除する
    releaseCancel();
    boundary.restore();
  }
});

/**
 * 完了条件: ピア起点の close の解放が start の実行中に終端へ進んだ場合も "closed" を優先し、
 * start は失敗する。
 *
 * 解放は世代番号を進めるため、start が捕捉した値との比較で解放の先行が分かる
 * (終端へ至る経路はすべて解放を経るため、state が "closed" であることもこの比較に含まれる)。
 */
test("start: createPublishers の await 中にピア起点の close が終端へ進んだら closed を優先する", async () => {
  const states: MediaPublisherState[] = [];
  let closeCount = 0;
  const { publisher, control, errors, opened } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    { holdPublish: true },
  );

  const startResult = publisher.start({} as MediaStream).then(
    () => null,
    (error: unknown) => error,
  );
  await opened[0].publishing();

  // 接続で受け取った session の close 通知 (ピア起点の close) を叩き、解放を終端まで進める
  opened[0].notifyClose();
  await sleep(0);
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount, 1);
  assert.isNull(control.session);

  // 解放のあとに createPublishers が戻っても "publishing" へは進まない
  opened[0].resolvePublish();
  const startFailure = await startResult;

  assert.instanceOf(startFailure, Error);
  assert.isTrue((startFailure as Error).message.includes("start aborted"));
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
});

/**
 * 完了条件: 解放の完了後に利用者が呼び直した start は、解放が終端 ("closed") へ進んだあと
 * なら世代番号が一致していても失敗し、"publishing" に戻らない。
 *
 * 解放 (disposeAllResources) は世代番号を進める。解放が終わってから始まる start はその値を
 * 捕捉するため、世代番号の比較だけでは終端を跨いだことを判定できない。state が "closed" で
 * あることも中止の条件に入れないと、start は最後まで進んで "publishing" になり、解放済みの
 * リソースの上で処理ループを起動する (onClose のあとに state が "closed" でなくなるため、
 * close() の早期 return も通過する)。
 *
 * 駆動する順序は次のとおりである。
 * 1. start #1 が createPublishers の catalog トラックの PUBLISH で止まっている間にピア起点の close が
 *    届き、解放 D1 が session の close で止まる (世代番号は解放の先頭で進む)
 * 2. start #1 は段階の検査で中止し、失敗時の巻き戻し D2 が先に終わって失敗が確定する
 *    (D1 が参照を切り離し済みの session を D2 は触らない)
 * 3. 利用者は start #1 の失敗を待ってから直列に start #2 を呼ぶ。state はまだ "created" で
 *    あるため state のガードを通過し、捕捉する世代番号は D1 が進めた現在値と一致する
 * 4. D1 を終わらせると state は "closed" になり onClose が 1 回通知される
 * 5. start #2 の検査は世代番号が一致するため、state の比較が無ければ通過して start が成功する
 */
test("start: 解放の完了後に呼び直した start は世代一致でも closed を跨いで publishing にしない", async () => {
  const states: MediaPublisherState[] = [];
  let closeCount = 0;
  const { publisher, control, errors, opened } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    // catalog トラックの PUBLISH と session の close の両方をテストが解放する (2 つの窓を作る)
    { holdPublish: true, holdSessionClose: true },
  );

  await withUnhandledRejectionWatch(async (unhandled) => {
    // 1. start #1 を catalog トラックの PUBLISH の await で止める
    const firstStart = publisher.start({} as MediaStream).then(
      () => null,
      (error: unknown) => error,
    );
    await opened[0].publishing();
    assert.equal(publisher.state, "created");

    // ピア起点の close の解放 D1 を始め、session の close で止める
    opened[0].notifyClose();
    await opened[0].sessionClosing();
    // D1 は session の参照を切り離してから close を待つ (解放はまだ進行中である)
    assert.isNull(control.session);
    assert.equal(opened[0].sessionCloseCalls(), 1);
    assert.equal(publisher.state, "created");
    assert.equal(closeCount, 0);

    // 2. start #1 を再開させると段階の検査が中止し、巻き戻し D2 が先に終わって失敗が確定する
    opened[0].resolvePublish();
    const firstFailure = await firstStart;
    assert.instanceOf(firstFailure, Error);
    assert.equal(
      (firstFailure as Error).message,
      "start aborted: resources were disposed during start",
    );
    // D2 は切り離し済みの session を触らない (close は D1 の 1 回だけ)
    assert.equal(opened[0].sessionCloseCalls(), 1);
    // 解放はまだ終端へ進んでおらず、state のガードは通過できる状態である
    assert.equal(publisher.state, "created");
    assert.equal(closeCount, 0);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], firstFailure);

    // 3. 直列に start #2 を呼ぶ。解放 (D1) が進行中であるため、開始の入口で拒否される
    // (解放が終端へ進む前に開始を許すと、開始した資源を解放する経路が残らない)
    const secondFailure = await publisher.start({} as MediaStream).then(
      () => null,
      (error: unknown) => error,
    );
    assert.instanceOf(secondFailure, Error);
    assert.equal((secondFailure as Error).message, "cannot start while closing");
    assert.equal(publisher.state, "created");
    assert.equal(opened[1], undefined);

    // 4. D1 を終わらせると終端 ("closed") と onClose が 1 回だけ通知される
    opened[0].resolveSessionClose();
    await sleep(0);
    assert.equal(publisher.state, "closed");
    assert.equal(closeCount, 1);
    assert.deepEqual(states, ["closed"]);

    // 5. 解放が終わったあとに呼び直しても、終端 ("closed") を跨ぐため中止すること
    const thirdStart = publisher.start({} as MediaStream).then(
      () => null,
      (error: unknown) => error,
    );
    const thirdFailure = await thirdStart;
    assert.instanceOf(thirdFailure, Error);
    assert.equal((thirdFailure as Error).message, `cannot start in state: closed`);
    // "publishing" へ進んでいないこと (onClose のあとに state が動かない)
    assert.equal(publisher.state, "closed");
    assert.deepEqual(states, ["closed"]);
    assert.equal(closeCount, 1);
    // 入口の拒否は start の catch を通らないため onError は増えない (通知は start #1 の 1 回だけ)
    assert.equal(errors.length, 1);

    // 解放と中止が重なっても未処理の rejection を残さないこと
    await waitForUnhandledRejectionDetection();
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 完了条件: setupEncoders の configure の await 中に利用者の close() が先行した場合も、
 * state は "closed" のままで "publishing" に戻らない。
 *
 * WebCodecs の境界を置き換えて configure の await の窓で close() を先行させる。close() は
 * 同期部分で世代番号を進めるため、解放のあとに setupEncoders が続いても最後の検査が中止する。
 */
test("start: setupEncoders の configure の await 中に close したら publishing にしない", async () => {
  const states: MediaPublisherState[] = [];
  let closeCount = 0;
  const { publisher, opened } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    {
      publisherOptions: {
        namespace: ["live"],
        useWorker: false,
        video: { codec: "vp8", bitrate: 1_000_000 },
      },
    },
  );

  // configure の await の窓で利用者の close() を先行させる
  let userClose: Promise<void> = Promise.resolve();
  const boundary = replaceVideoCodecBoundary({
    onConfigure: () => {
      userClose = publisher.close();
    },
  });

  const startResult = publisher.start(createVideoMediaStream()).then(
    () => null,
    (error: unknown) => error,
  );

  let startFailure: unknown = null;
  try {
    startFailure = await startResult;
  } finally {
    boundary.restore();
  }
  await userClose;

  // configure まで到達し、解放が先行したため中止されること
  assert.equal(boundary.configureCount(), 1);
  assert.instanceOf(startFailure, Error);
  assert.isTrue((startFailure as Error).message.includes("start aborted"));
  // "publishing" へ進まず "closed" のままであること ("closed" のあとに遷移しない)
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);
  // 解放でエンコーダーが閉じられ、session も閉じられていること
  assert.equal(boundary.closeCount(), 1);
  assert.isTrue(opened[0].isSessionClosed());
});

/**
 * 完了条件: 接続が作る onSessionClose の閉包は handleSessionClose の reject を回収し、
 * 未処理の rejection にせず onError へ流す。
 *
 * ピア起点の close の終端遷移で onStateChange が throw すると handleSessionClose は
 * reject する。閉包の catch を削ると onError に届かないため、このテストは落ちる。
 */
test("start: ピア起点 close の終端通知が throw しても閉包が回収して onError へ届く", async () => {
  const notificationFailure = new Error("onStateChange failure");
  let closeCount = 0;
  const { publisher, errors, opened } = createStartConnectHarness({
    onStateChange: (state) => {
      if (state === "closed") {
        throw notificationFailure;
      }
    },
    onClose: () => {
      closeCount++;
    },
  });

  await publisher.start({} as MediaStream);
  assert.equal(publisher.state, "publishing");

  // 実装が作った閉包 (onSessionClose) をそのまま叩く
  opened[0].notifyClose();
  await sleep(0);

  // 遷移が失敗しても state は "closed" になり onClose は通知されること
  assert.equal(publisher.state, "closed");
  assert.equal(closeCount, 1);
  // 閉包の回収経路が同じ失敗を onError へ流すこと
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], notificationFailure);
});

/**
 * 完了条件: catalog 送信が publisher 層の通知を伴って reject した場合、start() の catch は
 * 通知し直さない (1 件の失敗で onError が 2 回呼ばれない)。
 *
 * 印付きの失敗を catch まで運ぶ経路も、接続の境界 (openSession) の差し替えで駆動できる
 * (node に WebTransport は要らない)。送信の reject は publishCatalog の await を通って
 * start() の catch に届く。
 */
test("start: catalog 送信の印付き reject は catch を経ても通知しない", async () => {
  const notified = createNotifiedError("catalog send rejected after notify");
  let catalogDoneCount = 0;
  const { publisher, errors, opened } = createStartConnectHarness(
    {},
    {
      createCatalogPublisher: () => ({
        publisher: {
          state: "active",
          sendObject: async () => {
            throw notified;
          },
          done: async () => {
            catalogDoneCount++;
          },
        } as unknown as Publisher,
        doneCount: () => catalogDoneCount,
      }),
    },
  );

  let thrown: unknown = null;
  try {
    await publisher.start({} as MediaStream);
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, notified);
  // 印付きの失敗は publisher 層が通知済みであるため、start() の catch では通知しない
  assert.deepEqual(errors, []);
  // state は変えず再 start でき、確保済みは巻き戻しで破棄されること
  assert.equal(publisher.state, "created");
  assert.equal(opened[0].catalogDoneCount(), 1);
  assert.isTrue(opened[0].isSessionClosed());
});

/**
 * 完了条件: 接続の await 中に close() が先行した場合、接続で受け取った session をその場で
 * 閉じて this.session に代入しない。代入すると state は既に "closed" で close() も早期
 * return するため、閉じる経路が残らない。あわせて "publishing" へ進まない。
 *
 * WebTransport は node に無いため、接続の境界 (openSession) だけを置き換えて完了を
 * 制御する。接続要求を保留したまま close() を完了させ、そのあとで接続を解決させる。
 */
test("start: 接続の await 中に close したら受け取った session を閉じて採用しない", async () => {
  const states: MediaPublisherState[] = [];
  const errors: Error[] = [];
  let closeCount = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onError: (error) => {
        errors.push(error);
      },
      onClose: () => {
        closeCount++;
      },
    },
  );
  const control = publisher as unknown as PublisherConnectControl & PublisherSessionCloseControl;
  // 接続の完了をテストが決める (解決するまで connectToServer は await のまま)
  let completeConnect: (session: Session) => void = () => {};
  control.openSession = () =>
    new Promise<Session>((resolve) => {
      completeConnect = resolve;
    });

  const startResult = publisher.start({} as MediaStream).then(
    () => null,
    (error: unknown) => error,
  );

  // 接続待ちの間に close() を完了させる (解放は session 未代入のまま "closed" へ固定する)
  await publisher.close();
  assert.equal(publisher.state, "closed");

  // 接続を解決する。受け取った session は採用せずその場で閉じる
  const { session, isClosed } = createRecordingSession();
  completeConnect(session);
  const startFailure = await startResult;

  assert.instanceOf(startFailure, Error);
  assert.isTrue((startFailure as Error).message.includes("start aborted"));
  assert.isTrue(isClosed());
  assert.isNull(control.session);
  // "publishing" へ進まず、Publisher の作成 (publish) も行わないこと。
  // publish を持たない session を渡しているため、採用していれば throw する
  assert.equal(publisher.state, "closed");
  assert.deepEqual(states, ["closed"]);
  // 中止は通知を伴わない失敗であるため onError は 1 回だけ
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(closeCount, 1);
});

/**
 * Group ID 初期値の検証用の制御口
 */
interface PublisherGroupControl {
  audioGroupId: number;
  videoGroupId: number;
  // encode を依頼した時点の世代 (入力フレームの timestamp を鍵にする)
  videoEncodeGenerations: EncodeGenerationRecords;
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
 *
 * `done` は解放 (disposeAllResources) からも呼ばれるため、呼び出し回数を記録して成功する。
 */
function createRecordingSendPublisher(): {
  publisher: Publisher;
  sent: {
    groupId: number;
    objectId: number;
    priority?: number;
    payload?: Uint8Array;
    endOfSubgroup?: boolean;
  }[];
  doneCount: () => number;
  closeSubgroupCount: () => number;
} {
  const sent: {
    groupId: number;
    objectId: number;
    priority?: number;
    payload?: Uint8Array;
    endOfSubgroup?: boolean;
  }[] = [];
  let done = 0;
  let closeSubgroup = 0;
  const publisher = {
    state: "active",
    // 実物の PublisherImpl と同じ既定 (FORWARD は 1) にする。送り直しの経路が見送りの
    // 判定に使う
    forwardState: true,
    closeSubgroup: async () => {
      closeSubgroup++;
    },
    sendObject: async (params: {
      groupId: number;
      objectId: number;
      priority?: number;
      payload?: Uint8Array;
      endOfSubgroup?: boolean;
    }) => {
      sent.push({
        groupId: params.groupId,
        objectId: params.objectId,
        priority: params.priority,
        payload: params.payload,
        endOfSubgroup: params.endOfSubgroup,
      });
    },
    done: async () => {
      done++;
    },
  } as unknown as Publisher;
  return { publisher, sent, doneCount: () => done, closeSubgroupCount: () => closeSubgroup };
}

/**
 * 初回の送信だけ成功し、2 回目以降の送信が指定の error で失敗する Publisher
 *
 * catalog の送り直しの失敗を駆動する。事前検証の違反は publisher 層が通知済みの印を
 * 付けて reject するため、印の有無を切り替えられるよう error の作り方を渡す。
 * Publisher の実装は WebTransport を要するため、送信の形だけを持つ最小オブジェクトを
 * cast で注入する (モジュール置換は行わない)。
 */
function createRepublishFailingSendPublisher(createFailure: () => Error): {
  publisher: Publisher;
  sendCount: () => number;
} {
  let count = 0;
  const publisher = {
    state: "active",
    forwardState: true,
    sendObject: async (): Promise<void> => {
      count++;
      if (count > 1) {
        throw createFailure();
      }
    },
    done: async () => {},
  } as unknown as Publisher;
  return { publisher, sendCount: () => count };
}

test("初期 Group ID 生成は前回値を下回らない", () => {
  // 時刻依存は固定値で検証する。実時刻由来の確保が先行しても単調性は保たれる
  const first = allocateInitialGroupId(100);
  const second = allocateInitialGroupId(50);
  assert.equal(second, first + 1);
});

test("noteGroupId: 配信を止めて再開しても、開始 Group ID が前回の最大値を上回る", () => {
  // draft-ietf-moq-msf-01 §6.1: 配信を再開したときの開始 Group ID は、同一 track で
  // 以前に publish したどの Group ID よりも大きいことを MUST とする。配信中に進めた Group ID
  // (映像のキーフレーム、音声の chunk、Catalog と event timeline の送り直し) を単調ガードへ
  // 伝えておかないと、停止と再開を繰り返したときに開始値が前回の最大値を下回る
  const base = 9_000_000_000_000;
  const start = allocateInitialGroupId(base);
  // 配信中に Group を進める (送信のたびに追随させる)
  noteGroupId(start + 1);
  noteGroupId(start + 5);

  // 停止 → 再開の開始値は、前回送ったどの Group ID よりも大きい
  const restarted = allocateInitialGroupId(base);
  assert.isAbove(restarted, start + 5, "再開の開始 Group ID が前回の最大値を上回っていない");
  assert.equal(restarted, start + 6, "再開の開始 Group ID が前回の最大値の次でない");
});

test("noteGroupId: 安全整数でない値を拒否し、単調ガードを汚染しない", () => {
  // allocateInitialGroupId と同じ検証。ガードが NaN になると Math.max が常に NaN を返し、
  // 全トラックの開始 Group ID を払い出せなくなる
  const base = 9_200_000_000_000;
  noteGroupId(base);
  const before = allocateInitialGroupId(1);
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    // 有限でも安全整数でない値 (ガードが固定してしまう)
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    let thrown: unknown = null;
    try {
      noteGroupId(value);
    } catch (error) {
      thrown = error;
    }
    assert.isTrue(thrown instanceof Error, "安全整数でない値を拒否していない");
  }
  assert.equal(allocateInitialGroupId(1), before + 1, "単調ガードが汚染されている");
});

test("noteGroupId: 送信済みの最大値より小さい値では単調ガードが下がらない", () => {
  // 同じトラックで Group を進めない経路 (Group を進めない Object の送信) から呼ばれても、
  // 既に送った最大値を忘れない。他のテストが進めたガードの影響を受けないよう、値は
  // 相対で確かめる
  const base = 9_300_000_000_000;
  noteGroupId(base + 100);
  const high = allocateInitialGroupId(1);
  assert.isAbove(high, base + 100, "前提: 送信済みの値が単調ガードに入っていない");

  noteGroupId(base);
  assert.equal(allocateInitialGroupId(1), high + 1, "単調ガードが下がっている");
});

test("初期 Group ID 生成は安全整数でない値を拒否する", () => {
  // 共有カウンタの汚染を防ぐための検証。拒否後に正常割当てを行い、
  // 単調性が壊れていないことも確認する。有限でも安全整数でない値 (1.5 や 2^53) は
  // 単調ガードが固定してしまうため拒否する
  const before = allocateInitialGroupId(200);
  for (const candidate of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
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
  // 音声の送信内容を Subgroup の sendObject で見るため、明示的に Subgroup を選ぶ
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent: audioSent } = createRecordingSendPublisher();
  const { publisher: videoPublisher, sent: videoSent } = createRecordingSendPublisher();
  control.audioPublisher = audioPublisher;
  control.videoPublisher = videoPublisher;
  const initialAudio = control.audioGroupId;
  const initialVideo = control.videoGroupId;

  // 符号化を依頼した時点の記録を作る (実経路と同じ)
  recordAudioEncode(control, 0);
  recordVideoEncode(control, 0);
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
  recordAudioEncode(control, 1);
  control.handleAudioEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  assert.equal(audioSent[1].groupId, initialAudio + 1);
  assert.equal(audioSent[1].objectId, 0);

  // 2 回目以降の key で加算されること
  recordVideoEncode(control, 1);
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

  recordVideoEncode(control, 0);
  control.handleVideoEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  recordVideoEncode(control, 1);
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
 * 送られることを検証する。description は configure 後の最初の出力と構成変更時にしか
 * 現れないため、要求が無い限り同じ値は再送せず、変化したときだけ載せる。要求がある
 * ときは次のキーフレームで 1 度だけ載せ直す。
 */
function createCapturingPublisher(): {
  publisher: Publisher;
  sent: Array<{ properties?: Uint8Array; endOfSubgroup?: boolean }>;
  datagrams: Array<{
    groupId?: number;
    objectId?: number;
    payload?: Uint8Array;
    properties?: Uint8Array;
    priority?: number;
  }>;
} {
  const sent: Array<{ properties?: Uint8Array; endOfSubgroup?: boolean }> = [];
  const datagrams: Array<{
    groupId?: number;
    objectId?: number;
    payload?: Uint8Array;
    properties?: Uint8Array;
    priority?: number;
  }> = [];
  const publisher = {
    state: "active",
    done: async () => {
      // 破棄は no-op (購読の無いテストでは書き込み完了を待つ対象が無い)
    },
    closeSubgroup: async () => {
      // 開いている Subgroup は無い (テストは実ストリームを持たない) ため no-op
    },
    sendObject: async (params: { properties?: Uint8Array; endOfSubgroup?: boolean }) => {
      sent.push(params);
    },
    sendDatagram: (params: { properties?: Uint8Array }) => {
      datagrams.push(params);
    },
  } as unknown as Publisher;
  return { publisher, sent, datagrams };
}

/**
 * 映像の符号化を依頼した時点の世代を記録する (テスト用)
 *
 * `handleVideoEncodedChunk` は、符号化を依頼した時点の世代と一致する出力だけを送る
 * (記録の無い出力は送らない)。テストはエンコーダーを挟まずに出力を流すため、実経路と
 * 同じ記録を先に作る
 */
function recordVideoEncode(control: unknown, timestamp: number): void {
  const internal = control as {
    videoEncodeGenerations: EncodeGenerationRecords;
    processingGeneration: number;
  };
  recordEncodeGeneration(internal.videoEncodeGenerations, internal.processingGeneration, timestamp);
}

/**
 * 音声の符号化を依頼した時点の投入を記録する (テスト用)
 *
 * 長さは 20 ms とし、1 つの出力が覆い切るものとして記録する
 */
function recordAudioEncode(control: unknown, timestampMicros: number): void {
  const internal = control as {
    audioCatchUp: {
      evaluate(input: {
        timestampMicros: number;
        generation: number;
        readWallClockMicros: bigint;
        appliedOffsetMicros: bigint | null;
        durationMicros: number | null;
        nowMs: number;
      }): boolean;
    };
    processingGeneration: number;
  };
  // 追いつきの判定で捨てられると記録が作られず、テストが空振りで通る
  assert.isTrue(
    internal.audioCatchUp.evaluate({
      timestampMicros,
      generation: internal.processingGeneration,
      readWallClockMicros: 0n,
      appliedOffsetMicros: null,
      durationMicros: 20_000,
      nowMs: performance.now(),
    }),
    "テストの前提となる投入が捨てられている",
  );
}

/** Video Config の description を含む chunk を handleVideoEncodedChunk に流す */
function sendVideoChunk(
  control: PublisherLifecycleControl,
  description?: Uint8Array,
  type: "key" | "delta" = "key",
): void {
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
  // 実経路では encode を依頼した時点で世代を記録する
  recordVideoEncode(control, 1000);
  handler({
    data: new Uint8Array([0xaa]),
    type,
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
 * draft-ietf-moq-loc-04 §2.3.2.1 (Video Config):
 * 後から接続した購読者 (forwardState が 0 から 1 になった時点) のために、
 * 保持している Video Config を次のキーフレームの Object に載せ直す契約を検証する。
 * Chromium の VideoEncoder は description を configure 後の最初の出力と構成変更時に
 * しか付けないため、キーフレームごとに再出現することを前提にできない。GOP の途中の
 * Object に載せると購読側が GOP の途中で復号器を再構成することになるため、要求は
 * キーフレームまで保留する。
 */
test("handleVideoEncodedChunk: 送り直し要求は次のキーフレームで保持している Video Config を 1 Object 載せ直す", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  // 最初の chunk (description 付きのキーフレーム) で Video Config を送って保持する
  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);

  // forwardState が 1 になった時点で立つ要求を再現する。
  // 以降のキーフレームに description は再出現しない (Chromium の実挙動)
  control.videoConfigResendRequested = true;
  sendVideoChunk(control);

  // 載せ直しは 1 Object に限る (要求は載せた時点で解消する)
  sendVideoChunk(control);

  assert.equal(sent.length, 3);
  assert.deepEqual(
    LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.deepEqual(
    LOC.decodeVideoProperties(sent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isUndefined(LOC.decodeVideoProperties(sent[2].properties ?? new Uint8Array(0)).config);
  assert.isFalse(control.videoConfigResendRequested);
});

test("handleVideoEncodedChunk: キーフレーム以外の chunk では要求を保留し、載せない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);
  control.videoConfigResendRequested = true;

  // デルタフレームに載せると購読側が GOP の途中で復号器を再構成することになるため、
  // 載せずに要求を残す (同じ description を持つ場合も載せない)
  sendVideoChunk(control, new Uint8Array(description), "delta");
  assert.isUndefined(LOC.decodeVideoProperties(sent[1].properties ?? new Uint8Array(0)).config);
  assert.isTrue(control.videoConfigResendRequested);

  // 次のキーフレームで載り、要求は解消する
  sendVideoChunk(control);
  assert.deepEqual(
    LOC.decodeVideoProperties(sent[2].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isFalse(control.videoConfigResendRequested);
});

test("handleVideoEncodedChunk: 保持値が無いまま要求されたら、次の description 付きキーフレームで載せる", () => {
  // forwardState が 1 になった時点で Video Config をまだ持っていない場合でも、
  // 要求を捨てずに次の description で載せられることの検証
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  control.videoConfigResendRequested = true;
  // 保持値が無いため、description の無いキーフレームでも載せられず要求は残る
  sendVideoChunk(control);
  assert.isTrue(control.videoConfigResendRequested);
  assert.isUndefined(LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0)).config);

  // 次の description が現れた時点で載り、要求は解消する
  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);
  assert.deepEqual(
    LOC.decodeVideoProperties(sent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isFalse(control.videoConfigResendRequested);
});

test("handleVideoEncodedChunk: stop 後の再開では同じ description でも VIDEO_CONFIG を載せる", async () => {
  // stop → start は新しい session と encoder を作るため、購読者は誰も前の
  // VIDEO_CONFIG を受け取っていない。保持値を破棄していないと新しい encoder の
  // description が同じ値として抑止され、再開後の購読者が映像を復号できない。
  // 公開 stop() で破棄を駆動し (start() 自体は接続を要する)、
  // 再開後に同じ description が載ることを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: firstPublisher, sent: firstSent } = createCapturingPublisher();
  control.videoPublisher = firstPublisher;

  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);
  assert.deepEqual(
    LOC.decodeVideoProperties(firstSent[0].properties ?? new Uint8Array(0)).config,
    description,
  );

  // stop では session に紐づく Video Config の保持値と要求を忘れる
  await publisher.stop();
  assert.equal(publisher.state, "stopped");
  assert.isNull(control.lastSentVideoConfig);
  assert.isFalse(control.videoConfigResendRequested);

  // 再開後 (新しい publisher) に同じ description が届いたら初出として載る
  const { publisher: resumedPublisher, sent: resumedSent } = createCapturingPublisher();
  control.videoPublisher = resumedPublisher;
  sendVideoChunk(control, new Uint8Array(description));

  assert.equal(resumedSent.length, 1);
  assert.deepEqual(
    LOC.decodeVideoProperties(resumedSent[0].properties ?? new Uint8Array(0)).config,
    description,
  );
});

/**
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
 * encoder が返す description (AAC の AudioSpecificConfig) が AUDIO_CONFIG として
 * 送られることを検証する。同じ値の重複送出は避けるが、forwardState が 0 から 1 に
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
  // 実経路では encode を依頼した時点で投入を記録する
  recordAudioEncode(control, 1000);
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
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  // AAC の AudioSpecificConfig 相当 (2 バイト)
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);

  assert.equal(sent.length, 1);
  // 音声の Object は 1 Object = 1 Group = 1 Subgroup であり、送り終えたら FIN で閉じる
  // (draft-ietf-moq-transport-22 §11.3.2 の MUST)
  assert.isTrue(sent[0]?.endOfSubgroup);
  const decoded = LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0));
  assert.deepEqual(decoded.config, description);
});

test("handleAudioEncodedChunk: 同じ description は再送しない", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  setSubgroupAudioDelivery(control);
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
  setSubgroupAudioDelivery(control);
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
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  sendAudioChunk(control);

  assert.isUndefined(LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0)).config);
});

/**
 * draft-ietf-moq-transport-22 §11 (Data Streams and Datagrams):
 * delivery が "datagram" なら Datagram で送り、Subgroup (sendObject) へは流さない。
 * 経路は Object 単位で選べるが、moqt-js の音声は 1 つの設定で統一する
 */
test("handleAudioEncodedChunk: delivery が datagram なら Datagram で送る", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent, datagrams } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;
  // 送り方は start で解決した設定から読む
  (
    control as unknown as {
      resolvedAudio: ReturnType<typeof resolveAudioPublishSettings> | null;
    }
  ).resolvedAudio = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64_000,
    delivery: "datagram",
  });

  sendAudioChunk(control, new Uint8Array([0x11, 0x90]));

  assert.equal(datagrams.length, 1);
  assert.equal(sent.length, 0);
  // Datagram 経路でも送る中身が欠けないこと (位置・payload・AUDIO_CONFIG)。落ちても呼び出し
  // 回数だけでは緑になるため、params まで固定する
  const params = datagrams[0];
  assert.isNumber(params?.groupId);
  assert.isNumber(params?.objectId);
  assert.isAbove(params?.payload?.length ?? 0, 0);
  assert.deepEqual(
    LOC.decodeAudioProperties(params?.properties ?? new Uint8Array(0)).config,
    new Uint8Array([0x11, 0x90]),
  );
});

/**
 * 完了条件: `redundancy` が 2 のときは、同じ音声 Object を 2 回送る。
 *
 * 音声は datagram で届き、再送されない (RFC 9221)。2 回送ると両方の copy が落ちる確率は
 * 損失率の 2 乗になる。受信側は同じ識別子 (groupId と objectId) の 2 回目を捨てるため
 * (src/createMediaSubscriber.ts)、同じ音が 2 回鳴ることはない。
 *
 * 実測 (実リレー、5 % の損失を注入して 40 秒): 1 回送りは欠落 0.055・鳴った割合 94.5 %・
 * 飛ばした音 2220 ms であったのに対し、2 回送りは欠落 0.003・鳴った割合 99.4 %・80 ms
 * になった。損失の無い経路では品質が変わらない (欠落 0、飛ばし 0)
 */
test("handleAudioEncodedChunk: redundancy が 2 なら同じ Object を 2 回送る", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent, datagrams } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;
  (
    control as unknown as {
      resolvedAudio: ReturnType<typeof resolveAudioPublishSettings> | null;
    }
  ).resolvedAudio = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64_000,
    delivery: "datagram",
    redundancy: 2,
  });

  sendAudioChunk(control, new Uint8Array([0x11, 0x90]));

  assert.equal(datagrams.length, 2, "同じ Object を 2 回送ること");
  assert.equal(sent.length, 0, "Subgroup へは流さないこと");
  // 2 個目は同じ Object (識別子も payload も同じ) であること
  assert.equal(datagrams[0]?.objectId, datagrams[1]?.objectId);
  assert.deepEqual(datagrams[0]?.payload, datagrams[1]?.payload);
});

/**
 * 完了条件: `redundancy` が 3 のときは 3 回送る。経路の損失が 20 % のような厳しい回では、
 * 2 回よりも 3 回の方が残る欠落が小さい (実測: 30 秒で欠落 0.037 → 3 回なら 0.008 相当)。
 * 4 以上は音声の帯域を無駄にするため start がエラーにする
 */
test("handleAudioEncodedChunk: redundancy が 3 なら 3 回送る", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, datagrams } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;
  (
    control as unknown as {
      resolvedAudio: ReturnType<typeof resolveAudioPublishSettings> | null;
    }
  ).resolvedAudio = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64_000,
    delivery: "datagram",
    redundancy: 3,
  });

  sendAudioChunk(control, new Uint8Array([0x11, 0x90]));

  assert.equal(datagrams.length, 3, "同じ Object を 3 回送ること");
  assert.equal(datagrams[0]?.objectId, datagrams[2]?.objectId, "同じ Object であること");
});

test("resolveAudioPublishSettings: redundancy は 1〜3 の整数だけ受理する", () => {
  assert.equal(resolveAudioPublishSettings({ codec: "opus", bitrate: 64_000 }).redundancy, 1);
  assert.equal(
    resolveAudioPublishSettings({
      codec: "opus",
      bitrate: 64_000,
      delivery: "datagram",
      redundancy: 3,
    }).redundancy,
    3,
  );
  // 冗長化は datagram の送信経路でしか実装していないため、subgroup で 2 以上は拒否する。
  // 既定の配送方式は datagram なので、delivery を省略した場合は受け付ける
  assert.equal(
    resolveAudioPublishSettings({ codec: "opus", bitrate: 64_000, redundancy: 2 }).redundancy,
    2,
  );
  assert.throws(
    () =>
      resolveAudioPublishSettings({
        codec: "opus",
        bitrate: 64_000,
        delivery: "subgroup",
        redundancy: 2,
      }),
    /audio redundancy must be 1 when delivery is "subgroup"/,
  );
  for (const value of [0, 4, 1.5]) {
    assert.throws(
      () =>
        resolveAudioPublishSettings({
          codec: "opus",
          bitrate: 64_000,
          delivery: "datagram",
          redundancy: value,
        }),
      /audio redundancy must be an integer between 1 and 3/,
    );
  }
});

/**
 * 完了条件: 指定が無ければ Datagram で送る (既定は "datagram")。
 *
 * 音声は 1 Object = 1 Group であり、datagram は再送されない (RFC 9221)。既定の datagram は
 * 遅延の裾を縮めるためのもので、損失に備えるには `redundancy` を 2 以上にする。Subgroup を
 * 選ぶ場合は `delivery: "subgroup"` を明示する。落ちても呼び出し回数だけでは緑にならない
 * よう、送った中身も固定する
 */
test("handleAudioEncodedChunk: delivery の既定は Datagram で送る", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: audioPublisher, sent, datagrams } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;
  (
    control as unknown as {
      resolvedAudio: ReturnType<typeof resolveAudioPublishSettings> | null;
    }
  ).resolvedAudio = resolveAudioPublishSettings({ codec: "opus", bitrate: 64_000 });

  sendAudioChunk(control, new Uint8Array([0x11, 0x90]));

  assert.equal(datagrams.length, 1, "Datagram を 1 回送ること");
  assert.equal(sent.length, 0, "Subgroup へは流さないこと");
  const params = datagrams[0];
  assert.isNumber(params?.groupId);
  assert.isNumber(params?.objectId);
  assert.deepEqual(
    LOC.decodeAudioProperties(params?.properties ?? new Uint8Array(0)).config,
    new Uint8Array([0x11, 0x90]),
  );
});

/**
 * 完了条件: datagram が再送されない経路でなくなるセッション (HTTP/2 上の WebTransport。
 * draft-ietf-moq-transport-22 §6.2 は datagram も reliable and ordered とする) で音声の
 * delivery に "datagram" を指定したら、start がエラーになる。宣言された設定を黙って
 * Subgroup へ戻すと、送り方を計器や購読側の前提から読めなくなるためである。エラーは onError
 * にも 1 回通知され、state は created のまま (再 start できる)
 */
test("start: reliable-only のセッションでは datagram の音声配信を拒否する", async () => {
  const { publisher, errors } = createStartConnectHarness(
    {},
    {
      reliability: "reliable-only",
      publisherOptions: {
        namespace: ["live"],
        audio: { codec: "opus", bitrate: 64_000, delivery: "datagram" },
      },
    },
  );

  const failure = await publisher
    .start(createAudioMediaStream({ sampleRate: 48_000, channelCount: 2 }))
    .then(
      () => null,
      (error: unknown) => error,
    );

  assert.ok(failure instanceof Error);
  assert.match((failure as Error).message, /reliable-only/);
  assert.equal(errors.length, 1);
  assert.equal(publisher.state, "created");
});

/**
 * 完了条件: delivery を省略した場合も既定が datagram であるため、reliable-only の
 * セッションでは start がエラーになる。既定だからといって黙って Subgroup へ戻すと、
 * 送り方を計器や購読側の前提から読めなくなる。Subgroup で配信するには明示する
 */
test("start: reliable-only のセッションでは既定 (datagram) の音声配信も拒否する", async () => {
  const { publisher, errors } = createStartConnectHarness(
    {},
    {
      reliability: "reliable-only",
      publisherOptions: {
        namespace: ["live"],
        audio: { codec: "opus", bitrate: 64_000 },
      },
    },
  );

  const failure = await publisher
    .start(createAudioMediaStream({ sampleRate: 48_000, channelCount: 2 }))
    .then(
      () => null,
      (error: unknown) => error,
    );

  assert.ok(failure instanceof Error);
  assert.match((failure as Error).message, /reliable-only/);
  assert.equal(errors.length, 1);
  assert.equal(publisher.state, "created");
});

/**
 * 音声トラックが無い MediaStream では音声 Object を 1 つも送らないため、reliable-only の
 * セッションでも既定 datagram を理由に start を拒否しない。catalog の宣言だけが残る穴は
 * 別に扱う
 */
test("start: 音声トラックが無ければ reliable-only でも既定 datagram を拒否しない", async () => {
  const { publisher, errors } = createStartConnectHarness(
    {},
    {
      reliability: "reliable-only",
      publisherOptions: {
        namespace: ["live"],
        audio: { codec: "opus", bitrate: 64_000 },
      },
    },
  );

  await publisher.start(createVideoMediaStream());

  assert.equal(errors.length, 0);
  assert.equal(publisher.state, "publishing");
});

/**
 * 完了条件: reliability が undefined のときは datagram を送れるものとして扱う。
 * WebTransport.reliability を公開していないブラウザでは undefined になるため、この分岐が
 * 既定の datagram 経路になり得る。undefined を拒否すると、それらのブラウザで datagram を
 * 使えなくなる
 */
test("start: reliability が undefined でも datagram の音声配信を開始できる", async () => {
  const boundary = replaceAudioCodecBoundary();
  try {
    const { publisher, errors } = createAudioStartHarness({ reliability: undefined });
    await publisher.start(createAudioMediaStream({ sampleRate: 48_000, channelCount: 2 }));

    assert.equal(errors.length, 0);
    assert.equal(publisher.state, "publishing");
    await publisher.close();
  } finally {
    boundary.restore();
  }
});

/**
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
 * 後から接続した購読者 (forwardState が 0 から 1 になった時点) のために、
 * 保持している Audio Config を次の Object に載せ直す契約を検証する。
 * 音声にはキーフレームが無いため、description の再出現では送り直せない。
 */
test("handleAudioEncodedChunk: 送り直し要求で保持している Audio Config を 1 Object 載せ直す", () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  // 最初の chunk で Audio Config を送って保持する
  const description = new Uint8Array([0x11, 0x90]);
  sendAudioChunk(control, description);

  // forwardState が 1 になった時点で立つ要求を再現する
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
  // forwardState が 1 になった時点で Audio Config をまだ持っていない場合でも、
  // 要求を捨てずに次の description で載せられることの検証
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  setSubgroupAudioDelivery(control);
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
  setSubgroupAudioDelivery(control);
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
  setSubgroupAudioDelivery(control);
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

test("handleVideoEncodedChunk: publisher が active でない間は保持値も要求も変えない", () => {
  // 音声側と同じ入口ガードを映像側も持つことの検証。送信できない間に届いた chunk で
  // 保持値や要求を書き換えると、購読者が接続したのに VIDEO_CONFIG を送り直せなくなる
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherLifecycleControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  // 送信できない状態 (active 以外) を作る
  (videoPublisher as unknown as { state: string }).state = "closed";
  control.videoPublisher = videoPublisher;
  const retained = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  control.lastSentVideoConfig = new Uint8Array(retained);
  control.videoConfigResendRequested = true;

  sendVideoChunk(control, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));

  assert.equal(sent.length, 0);
  assert.isTrue(control.videoConfigResendRequested);
  assert.deepEqual(control.lastSentVideoConfig, retained);
});

/**
 * 送信が失敗する Publisher
 *
 * sendObject の失敗の形を切り替える。本番の Publisher は事前検証の違反で自分で通知して
 * から返値を reject するため、通知を伴う reject ("notifyThenReject") が本番の契約である。
 * 通知を伴わない reject ("reject") は reject の回収だけを検証する分岐、同期 throw
 * ("throw") は通知を伴わない失敗の分岐である。Publisher の実装は WebTransport を要する
 * ため、失敗の形だけを持つ最小オブジェクトを cast で注入する。
 *
 * @param mode - 失敗の形
 * @param notify - 通知を伴う失敗で呼ぶ通知先 (テストの onError 収集)
 */
function createFailingSendPublisher(
  mode: "reject" | "notifyThenReject" | "throw",
  notify: (error: Error) => void,
): {
  publisher: Publisher;
  callCount: () => number;
} {
  let count = 0;
  const publisher = {
    state: "active",
    sendObject: (): Promise<void> => {
      count++;
      if (mode === "throw") {
        throw new Error("send threw");
      }
      let failure: Error;
      if (mode === "notifyThenReject") {
        // 本番の契約 (事前検証の違反は自分で通知してから返値を reject する) を再現する
        failure = new Error("send rejected after notify");
        notify(failure);
      } else {
        failure = new Error("send rejected");
      }
      return Promise.reject(failure);
    },
  } as unknown as Publisher;
  return { publisher, callCount: () => count };
}

/**
 * 送信が失敗する Publisher を注入して chunk を 1 件流す
 *
 * 音声 / 映像の送信箇所が、返値の reject を回収し (未処理の rejection にせず)、
 * 通知を伴わない失敗 (同期 throw) を onError へ 1 回流すこと、通知を伴う reject では
 * 通知を重ねないことを駆動する。
 *
 * @param kind - 音声側 / 映像側のどちらの送信箇所を駆動するか
 * @param mode - 失敗の形 (createFailingSendPublisher を参照)
 */
async function driveSendFailure(
  kind: "audio" | "video",
  mode: "reject" | "notifyThenReject" | "throw",
): Promise<{ callCount: number; errors: Error[]; unhandled: unknown[] }> {
  const { control: loopControl, errors } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl;
  // 音声の送信の失敗を Subgroup の sendObject で駆動する (既定は Datagram)
  setSubgroupAudioDelivery(control);
  const { publisher, callCount } = createFailingSendPublisher(mode, (error) => {
    errors.push(error);
  });
  return withUnhandledRejectionWatch(async (unhandled) => {
    if (kind === "audio") {
      control.audioPublisher = publisher;
      recordAudioEncode(control, 0);
      control.handleAudioEncodedChunk({
        data: new Uint8Array([0xaa]),
        type: "key",
        timestamp: 0,
        duration: null,
      });
    } else {
      control.videoPublisher = publisher;
      recordVideoEncode(control, 0);
      control.handleVideoEncodedChunk({
        data: new Uint8Array([0xaa]),
        type: "key",
        timestamp: 0,
        duration: null,
      });
    }
    await waitForUnhandledRejectionDetection();
    return { callCount: callCount(), errors, unhandled };
  });
}

test("handleAudioEncodedChunk: 送信の reject は通知せず未処理にもしない", async () => {
  // 通知の担い手は Publisher 側である (事前検証が自分で通知してから返値を reject する)。
  // 呼び出し側が同じ失敗を通知すると 1 件の失敗で 2 回通知になるため、ここでは
  // reject を回収するだけにして通知が 0 回であることを固定する
  const { callCount, errors, unhandled } = await driveSendFailure("audio", "reject");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 0);
  assert.equal(unhandled.length, 0);
});

test("handleVideoEncodedChunk: 送信の reject は通知せず未処理にもしない", async () => {
  // 映像側も音声側と同じ扱いであることの検証
  const { callCount, errors, unhandled } = await driveSendFailure("video", "reject");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 0);
  assert.equal(unhandled.length, 0);
});

test("handleAudioEncodedChunk: 通知を伴う送信の reject でも onError は合計 1 回", async () => {
  // 本番の契約 (Publisher が通知してから返値を reject する) を再現する。呼び出し側は
  // 通知し直さないため、1 件の失敗で onError は 1 回のままである
  const { callCount, errors, unhandled } = await driveSendFailure("audio", "notifyThenReject");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 1);
  assert.isTrue((errors[0]?.message ?? "").includes("send rejected after notify"));
  assert.equal(unhandled.length, 0);
});

test("handleVideoEncodedChunk: 通知を伴う送信の reject でも onError は合計 1 回", async () => {
  // 映像側も音声側と同じ扱いであることの検証
  const { callCount, errors, unhandled } = await driveSendFailure("video", "notifyThenReject");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 1);
  assert.isTrue((errors[0]?.message ?? "").includes("send rejected after notify"));
  assert.equal(unhandled.length, 0);
});

test("handleAudioEncodedChunk: 送信の同期 throw は onError に 1 回届く", async () => {
  // 同期 throw は Publisher 側の通知を伴わない (closed の throw は先頭の state ガードで
  // 到達せず、委譲先が同期 throw する場合の防御である)。呼び出し元へ例外を漏らさず、
  // 通知を 1 回だけ行うことを固定する
  const { callCount, errors, unhandled } = await driveSendFailure("audio", "throw");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 1);
  assert.isTrue((errors[0]?.message ?? "").includes("send threw"));
  assert.equal(unhandled.length, 0);
});

test("handleVideoEncodedChunk: 送信の同期 throw は onError に 1 回届く", async () => {
  // 映像側も音声側と同じ扱いであることの検証
  const { callCount, errors, unhandled } = await driveSendFailure("video", "throw");

  assert.equal(callCount, 1);
  assert.equal(errors.length, 1);
  assert.isTrue((errors[0]?.message ?? "").includes("send threw"));
  assert.equal(unhandled.length, 0);
});

/**
 * forwardState 変化の登録を検証するための制御口
 *
 * Publisher の作成と catalog の送信は接続を要する start() からしか呼べないため、publish
 * 呼び出しを記録する最小セッションを注入して駆動する (モジュール置換は行わない)。
 * start() と同じ順序にするため、Publisher の作成 → catalog の送信を順に呼ぶ
 * (start() は両者の間で音声の取り出し経路を作るが、この制御口は音声を使わない)
 */
interface PublisherForwardControl extends PublisherLifecycleControl {
  resolvedAudio: ResolvedAudioPublishSettings | null;
  resolvedVideo: ResolvedVideoPublishSettings | null;
  createPublishers(): Promise<void>;
  publishCatalog(): Promise<void>;
}

/**
 * catalog の送り直しを検証するための制御口
 *
 * 送り直しの予約は実時間のタイマーであり、テストが 30 秒待たずに済むよう間隔を
 * 短く差し替えられるようにする。Group ID と予約の有無も実装の内部状態として見る。
 */
interface PublisherCatalogRepublishControl extends PublisherForwardControl {
  catalogGroupId: number;
  catalogInitialSent: boolean;
  currentCatalog: Catalog | null;
  catalogRepublishTimer: ReturnType<typeof setTimeout> | null;
  catalogRepublishInterval: number;
  // 進行中の解放 (テストから解放中の窓を作るために差し替える)
  disposalInFlight: Promise<void> | null;
}

/**
 * publish 呼び出しを記録する最小セッション
 *
 * track 名で引く Publisher を返し、渡されたコールバックを記録する。
 * createPublishers() が forwardState 変化のコールバックを音声 / 映像 Publisher に
 * 登録しているかを、実装の内部状態を経由せずに検証できるようにする。
 */
function createPublishRecordingSession(publishers: Map<string, Publisher>): {
  session: Session;
  callbacksByTrack: Map<string, PublishCallbacks>;
  optionsByTrack: Map<string, PublishOptions | undefined>;
} {
  const callbacksByTrack = new Map<string, PublishCallbacks>();
  const optionsByTrack = new Map<string, PublishOptions | undefined>();
  const session = {
    publish: async (
      _namespace: string[],
      trackName: string,
      callbacks?: PublishCallbacks,
      options?: PublishOptions,
    ): Promise<Publisher> => {
      callbacksByTrack.set(trackName, callbacks ?? {});
      optionsByTrack.set(trackName, options);
      const publisher = publishers.get(trackName);
      if (!publisher) {
        throw new Error(`unexpected track: ${trackName}`);
      }
      return publisher;
    },
    // 解放 (stop / close / ピア起点の close) を駆動できるようにする
    close: async (): Promise<void> => {},
  } as unknown as Session;
  return { session, callbacksByTrack, optionsByTrack };
}

test("createPublishers: forwardState が 1 になると Audio Config の送り直しを要求する", async () => {
  // 購読者が居ない状態から購読者が接続した場合の結合の検証。
  // createPublishers() が音声 Publisher に onForwardStateChange を登録し、
  // それが handleAudioEncodedChunk の載せ直しに繋がることを確認する
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  const audioSettings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
    // 送信内容 (sendObject の引数) を Subgroup で見るため、明示的に Subgroup を選ぶ
    delivery: "subgroup",
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

  await control.publishCatalog();

  // Catalog が Object ID 0 で 1 件だけ publish されること
  assert.equal(catalogSent.length, 1);
  assert.equal(catalogSent[0].objectId, 0);

  // 音声 Publisher に forwardState 変化のコールバックが登録されていること
  const audioCallbacks = callbacksByTrack.get(audioSettings.trackName);
  assert.isDefined(audioCallbacks);
  assert.isDefined(audioCallbacks?.onForwardStateChange);

  // forwardState が 0 (購読者なし) では要求が立たない
  audioCallbacks?.onForwardStateChange?.(false);
  assert.isFalse(control.audioConfigResendRequested);

  // Audio Config を送って保持したあと、forwardState が 1 で要求が立つ
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

  // 要求の寿命は送信で決まる。forwardState が 0 に戻っても保留中の要求は消さない
  // (消すと、次に 1 になったときの送り直しを取りこぼす)
  audioCallbacks?.onForwardStateChange?.(true);
  audioCallbacks?.onForwardStateChange?.(false);
  assert.isTrue(control.audioConfigResendRequested);
});

test("createPublishers: forwardState が 1 になると Video Config の送り直しを要求する", async () => {
  // 購読者が居ない状態から購読者が接続した場合の結合の検証。
  // createPublishers() が映像 Publisher に onForwardStateChange を登録し、
  // それが handleVideoEncodedChunk の載せ直しに繋がることを確認する
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  const videoSettings = resolveVideoPublishSettings(
    { codec: "vp8", bitrate: 1_000_000, trackName: "video" },
    undefined,
  );
  control.resolvedVideo = videoSettings;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const { publisher: videoPublisher, sent: videoSent } = createCapturingPublisher();
  const publishers = new Map<string, Publisher>([
    [CATALOG_TRACK_NAME, catalogPublisher],
    [videoSettings.trackName, videoPublisher],
  ]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  await control.publishCatalog();

  // Catalog が Object ID 0 で 1 件だけ publish されること
  assert.equal(catalogSent.length, 1);
  assert.equal(catalogSent[0].objectId, 0);

  // 映像 Publisher に forwardState 変化のコールバックが登録されていること
  const videoCallbacks = callbacksByTrack.get(videoSettings.trackName);
  assert.isDefined(videoCallbacks);
  assert.isDefined(videoCallbacks?.onForwardStateChange);

  // forwardState が 0 (購読者なし) では要求が立たない
  videoCallbacks?.onForwardStateChange?.(false);
  assert.isFalse(control.videoConfigResendRequested);

  // Video Config を送って保持したあと、forwardState が 1 で要求が立つ
  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  sendVideoChunk(control, description);
  videoCallbacks?.onForwardStateChange?.(true);
  assert.isTrue(control.videoConfigResendRequested);

  // 要求に従って次のキーフレームの Object に保持値が載る
  // (キーフレームに description は再出現しない)
  sendVideoChunk(control);
  assert.deepEqual(
    LOC.decodeVideoProperties(videoSent[1].properties ?? new Uint8Array(0)).config,
    description,
  );
  assert.isFalse(control.videoConfigResendRequested);

  // 要求の寿命は送信で決まる。forwardState が 0 に戻っても保留中の要求は消さない
  // (消すと、次に 1 になったときの送り直しを取りこぼす)
  videoCallbacks?.onForwardStateChange?.(true);
  videoCallbacks?.onForwardStateChange?.(false);
  assert.isTrue(control.videoConfigResendRequested);
});

test("createPublishers: catalog の forwardState が 1 になると新しい Group の先頭 Object として送り直す", async () => {
  // 配信の開始後に購読を始めた相手への結合の検証。relay は購読者が居ない間 upstream の購読を
  // pause してよい (paused の間は publisher が Object を送らない) ため、開始時に送った catalog
  // は後着の購読者へ届かない。createPublishers() が catalog Publisher に
  // onForwardStateChange を登録し、FORWARD が 1 になった時点で直前より大きい Group ID の
  // 先頭 Object として同じ payload を送り直すことを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack, optionsByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  await control.publishCatalog();

  // 開始時の catalog が保持している Group ID の先頭 Object として 1 件だけ送られること
  assert.equal(catalogSent.length, 1);
  assert.equal(catalogSent[0]?.groupId, control.catalogGroupId);
  assert.equal(catalogSent[0]?.objectId, 0);
  assert.equal(catalogSent[0]?.priority, PRIORITY_CATALOG);

  // MAX_CACHE_DURATION を relay に伝えること (送り直しの間隔の根拠になる値そのものを固定する)
  assert.equal(CATALOG_MAX_CACHE_DURATION_MS, 3_600_000);
  assert.equal(
    optionsByTrack.get(CATALOG_TRACK_NAME)?.maxCacheDuration,
    BigInt(CATALOG_MAX_CACHE_DURATION_MS),
  );

  // catalog Publisher に forwardState 変化のコールバックが登録されていること
  const catalogCallbacks = callbacksByTrack.get(CATALOG_TRACK_NAME);
  assert.isDefined(catalogCallbacks);
  assert.isDefined(catalogCallbacks?.onForwardStateChange);

  // forwardState が 0 に変わっただけでは送らない
  catalogCallbacks?.onForwardStateChange?.(false);
  await settle();
  assert.equal(catalogSent.length, 1);

  // forwardState が 1 になると新しい Group の先頭 Object として同じ payload を送り直す
  const catalogBeforeRepublish = control.currentCatalog;
  catalogCallbacks?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 2);
  assert.isAbove(catalogSent[1]?.groupId ?? 0, catalogSent[0]?.groupId ?? 0);
  assert.equal(catalogSent[1]?.objectId, 0);
  assert.deepEqual(catalogSent[1]?.payload, catalogSent[0]?.payload);
  // 送り直しも Subgroup を閉じる (初期送信と同じ形)
  assert.isTrue(catalogSent[0]?.endOfSubgroup);
  assert.isTrue(catalogSent[1]?.endOfSubgroup);
  // 送り直しは同じ catalog instance を送る (組み立て直さない。generatedAt は開始時のまま)
  assert.strictEqual(control.currentCatalog, catalogBeforeRepublish);

  // 送り直しで進めた Group ID が、次のインスタンスの開始 Group ID の下限に反映されること
  // (draft-ietf-moq-msf-01 §6.1。allocateInitialGroupId は候補より前回値を優先する)
  assert.isAbove(allocateInitialGroupId(1), control.catalogGroupId);

  // 1 → 0 → 1 でも送る (変化のたびに送り直す)
  catalogCallbacks?.onForwardStateChange?.(false);
  await settle();
  catalogCallbacks?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 3);
  assert.isAbove(catalogSent[2]?.groupId ?? 0, catalogSent[1]?.groupId ?? 0);

  await publisher.close();
});

test("createPublishers: catalog の送り直しの reject は onError へ 1 回届き未処理にしない", async () => {
  // forwardState 変化のコールバックは同期であり送信の完了を待てない。送り直しの失敗を
  // 握り潰さず onError へ流し、未処理の rejection にしないことを確認する
  const { publisher: catalogPublisher, sendCount } = createRepublishFailingSendPublisher(
    () => new Error("catalog resend failed"),
  );
  const { publisher, control: loopControl, errors } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await withUnhandledRejectionWatch(async (unhandled) => {
    await control.createPublishers();
    await control.publishCatalog();
    callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
    await waitForUnhandledRejectionDetection();

    assert.equal(sendCount(), 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, "catalog resend failed");
    assert.equal(unhandled.length, 0);
  });

  await publisher.close();
});

test("createPublishers: catalog の送り直しでは publisher 層が通知済みの reject を通知しない", async () => {
  // 事前検証の違反は publisher 層が error コールバックで通知してから返値を reject する。
  // 送り直しの経路で通知し直すと 1 件の失敗で onError が 2 回呼ばれるため、印付きでは
  // 通知しないことを確認する (抑止の分岐を削るとこのテストが落ちる)
  const { publisher: catalogPublisher, sendCount } = createRepublishFailingSendPublisher(() =>
    createNotifiedError("catalog resend rejected after notify"),
  );
  const { publisher, control: loopControl, errors } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await withUnhandledRejectionWatch(async (unhandled) => {
    await control.createPublishers();
    await control.publishCatalog();
    callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
    await waitForUnhandledRejectionDetection();

    assert.equal(sendCount(), 2);
    assert.equal(errors.length, 0);
    assert.equal(unhandled.length, 0);
  });

  await publisher.close();
});

test("createPublishers: catalog の送り直しで onError が throw しても未処理の rejection にしない", async () => {
  // 通知の担い手はこの経路であり、呼び出し元が居ない (forwardState 変化とタイマー)。
  // 利用者の onError が throw しても、通知の失敗を伝える経路が無いため握って未処理の
  // rejection にしないことを確認する (handleSessionClose と同じ形)
  let errors = 0;
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: () => {
        errors++;
        throw new Error("onError threw");
      },
    },
  );
  const control = publisher as unknown as PublisherCatalogRepublishControl;
  control.currentState = "publishing";
  const { publisher: catalogPublisher } = createRepublishFailingSendPublisher(
    () => new Error("catalog resend failed"),
  );
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await withUnhandledRejectionWatch(async (unhandled) => {
    await control.createPublishers();
    await control.publishCatalog();
    callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
    await waitForUnhandledRejectionDetection();

    assert.equal(errors, 1);
    assert.equal(unhandled.length, 0);
  });

  await publisher.close();
});

test("publishCatalog: catalog の送り直しを間隔ごとに予約し直し、解放で取り消す", async () => {
  // 配信の開始から MAX_CACHE_DURATION を過ぎた相手にも catalog を届けるための定期送り直しを
  // 実時間で駆動する。テストが 30 秒待たずに済むよう間隔だけを短くし、送り直しのたびに
  // 次の予約が入ることと、解放 (close()) で予約が取り消されることを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session } = createPublishRecordingSession(publishers);
  control.session = session;
  // 既定の間隔は MAX_CACHE_DURATION から導出した値であること
  assert.equal(CATALOG_REPUBLISH_DEFAULT_INTERVAL_MS, 30_000);
  assert.equal(control.catalogRepublishInterval, CATALOG_REPUBLISH_DEFAULT_INTERVAL_MS);
  control.catalogRepublishInterval = 10;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  assert.isNotNull(control.catalogRepublishTimer);

  // 予約が満了すると新しい Group で送り直され、次の予約が入ること
  // (1 回だけの送信なら 10 ms の間隔で 120 ms 待てば 2 件目以降が積まれる)
  await sleep(120);
  assert.isAtLeast(catalogSent.length, 3);
  assert.isAbove(catalogSent[1]?.groupId ?? 0, catalogSent[0]?.groupId ?? 0);
  assert.equal(catalogSent[1]?.objectId, 0);
  assert.isNotNull(control.catalogRepublishTimer);

  // 解放で予約が取り消され、その後に送り直しが起きないこと
  await publisher.close();
  assert.equal(publisher.state, "closed");
  assert.isNull(control.catalogRepublishTimer);
  const sentBeforeDisposeWait = catalogSent.length;
  await sleep(50);
  assert.equal(catalogSent.length, sentBeforeDisposeWait);
});

test("publishCatalog: FORWARD が 0 でも初期送信は完了として扱い予約を残す", async () => {
  // 初期送信の時点で FORWARD が 0 のときも publisher は Object を送らない
  // (draft-ietf-moq-transport-22 §3.1.1)。publishCatalog の検査は publisher の state だけを
  // 見るため active なら失敗せず、初期送信の完了として扱って次の FORWARD 0→1 に備える。
  // 見送りそのものは publisher が行う (「FORWARD が 0 の間の送り直しは見送られ Group ID を
  // 消費しない」のテストが駆動する)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  // 送信の可否は publisher が決めるため、初期送信の前から FORWARD を 0 にしておく
  (catalogPublisher as unknown as { forwardState: boolean }).forwardState = false;
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session } = createPublishRecordingSession(publishers);
  control.session = session;
  control.catalogRepublishInterval = 10;

  await control.createPublishers();
  await control.publishCatalog();

  // active なので例外にはならない。Object を実際に送るかは publisher が決めるため
  // (FORWARD が 0 の間は送らない。draft-ietf-moq-transport-22 §3.1.1)、記録した stand-in には
  // 送信の呼び出しだけが残る。見送りでも初期送信の完了として扱い、予約を残す
  assert.equal(catalogSent.length, 1);
  assert.isTrue(control.catalogInitialSent);
  assert.isNotNull(control.catalogRepublishTimer);
  const groupIdAfterStart = control.catalogGroupId;

  // FORWARD が 1 になれば、予約の満了で新しい Group の先頭 Object として送り直される
  (catalogPublisher as unknown as { forwardState: boolean }).forwardState = true;
  await sleep(50);
  assert.isAtLeast(catalogSent.length, 2);
  assert.isAbove(catalogSent[1]?.groupId ?? 0, groupIdAfterStart);
  assert.equal(catalogSent[1]?.objectId, 0);

  await publisher.close();
});

test("createPublishers: FORWARD が 0 の間の送り直しは見送られ Group ID を消費しない", async () => {
  // publisher は paused の間 Object を送らない (draft-ietf-moq-transport-22 §3.1.1)。
  // 見送られる送り直しで Group ID と、同一プロセスの開始 Group ID の下限を進めないこと
  // (音声・映像が encode した分だけ Group を進めるのと同じ扱い) と、予約が維持されることを
  // 確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;
  control.catalogRepublishInterval = 10;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  const groupIdAfterStart = control.catalogGroupId;

  // FORWARD が 1 の間は送り直しで Group ID が進むこと
  callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 2);
  const groupIdAfterRepublish = control.catalogGroupId;
  assert.isAbove(groupIdAfterRepublish, groupIdAfterStart);

  // FORWARD が 0 の間は送らず、Group ID も進めないこと
  (catalogPublisher as unknown as { forwardState: boolean }).forwardState = false;
  callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 2);
  assert.equal(control.catalogGroupId, groupIdAfterRepublish);

  // 予約は維持され、満了しても見送られて Group ID は進まないこと
  await sleep(50);
  assert.equal(catalogSent.length, 2);
  assert.equal(control.catalogGroupId, groupIdAfterRepublish);
  assert.isNotNull(control.catalogRepublishTimer);

  await publisher.close();
});

test("createPublishers: catalog Publisher が closed になったら FORWARD が 1 でも送り直さない", async () => {
  // ピアが catalog の PUBLISH を cancel すると (STOP_SENDING。draft-ietf-moq-transport-22
  // §3.1.2) publisher は closed になり、配送する相手が居なくなる。FORWARD 0→1 の入口で
  // 送らず、Group ID も進めず、予約も残さないことを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  const groupIdBeforeClose = control.catalogGroupId;
  assert.isNotNull(control.catalogRepublishTimer);

  (catalogPublisher as unknown as { state: string }).state = "closed";
  callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 1);
  assert.equal(control.catalogGroupId, groupIdBeforeClose);
  assert.isNull(control.catalogRepublishTimer);

  await publisher.close();
});

test("createPublishers: catalog Publisher が closed になったら予約の満了でも送り直さない", async () => {
  // 同じく cancel 後の予約の満了の入口。送らず、Group ID も進めず、予約を入れ直さないことを
  // 確認する (満了のたびに再予約していたら、閉じた publisher へ送り続ける経路が残る)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session } = createPublishRecordingSession(publishers);
  control.session = session;
  control.catalogRepublishInterval = 10;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  const groupIdBeforeClose = control.catalogGroupId;

  (catalogPublisher as unknown as { state: string }).state = "closed";
  await sleep(50);
  assert.equal(catalogSent.length, 1);
  assert.equal(control.catalogGroupId, groupIdBeforeClose);
  assert.isNull(control.catalogRepublishTimer);

  await publisher.close();
});

test("publishCatalog: 初期 catalog の送信前に FORWARD が 1 になっても送り直さない", async () => {
  // stop() → start() の窓。前回 start の currentCatalog は解放で消さないため、新しい
  // catalog Publisher を作ってから初期 catalog を送るまでの間 (音声・映像の PUBLISH の往復と
  // 音声の取り出し経路の準備) に
  // FORWARD 0→1 が届くと、前回の catalog を新しい Group ID で送ってしまい、直後の初期送信が
  // 同じ Location に別の payload を載せる (draft-ietf-moq-transport-22 §2.1 / §7.1)。
  // 初期送信が済むまでは送り直さないことを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const audioSettings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  control.resolvedAudio = audioSettings;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const { publisher: audioPublisher } = createCapturingPublisher();
  const callbacksByTrack = new Map<string, PublishCallbacks>();
  // 音声の PUBLISH の応答中 (catalog の Publisher は作成済み、初期 catalog は未送信) に
  // FORWARD 1 を届かせる
  let notifyForwardDuringMediaPublish = false;
  const session = {
    publish: async (
      _namespace: string[],
      trackName: string,
      callbacks?: PublishCallbacks,
    ): Promise<Publisher> => {
      callbacksByTrack.set(trackName, callbacks ?? {});
      if (trackName === CATALOG_TRACK_NAME) {
        return catalogPublisher;
      }
      if (notifyForwardDuringMediaPublish) {
        callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
      }
      return audioPublisher;
    },
    close: async (): Promise<void> => {},
  } as unknown as Session;
  control.session = session;

  // 1 回目の start 相当。初期送信より前の FORWARD 1 は currentCatalog が null のため送らない
  notifyForwardDuringMediaPublish = true;
  await control.createPublishers();
  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  assert.equal(catalogSent[0]?.groupId, control.catalogGroupId);
  assert.equal(catalogSent[0]?.objectId, 0);
  const firstGroupId = catalogSent[0]?.groupId ?? 0;

  // 2 回目の start 相当。前回の catalog が currentCatalog に残っていても、この start の
  // 初期送信が済むまでは送り直さない (初期送信 1 件だけが新しい Group ID で送られる)
  await control.createPublishers();
  await control.publishCatalog();
  assert.equal(catalogSent.length, 2);
  assert.isAbove(catalogSent[1]?.groupId ?? 0, firstGroupId);
  assert.equal(catalogSent[1]?.objectId, 0);
  assert.equal(catalogSent[1]?.groupId, control.catalogGroupId);

  await publisher.close();
});

test("createPublishers: 解放が進行中の送り直しは送らない", async () => {
  // 解放はカタログ Publisher を切り離す前に await を挟む。その間に FORWARD 0→1 が届いても
  // 送らないことを確認する (切り離し後に届いた場合は catalogPublisher の null ガードで止まる)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  const groupIdBeforeDisposal = control.catalogGroupId;

  // 解放が進行中の状態を作る
  control.disposalInFlight = Promise.resolve();
  callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 1);
  assert.equal(control.catalogGroupId, groupIdBeforeDisposal);

  control.disposalInFlight = null;
  await publisher.close();
});

test("createPublishers: start 失敗の巻き戻し中は送り直さない", async () => {
  // start() の失敗時の巻き戻しは runDisposal を通さず disposeAllResources を直に await する
  // ため、その間 disposalInFlight は null のままである。この窓で FORWARD 0→1 が届いても
  // 破棄中の catalog Publisher へ送らないことを catalogInitialSent で止めている
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session, callbacksByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  const groupIdBeforeDisposal = control.catalogGroupId;

  // 解放 (巻き戻し) の直後に FORWARD 0→1 が届く窓
  await control.disposeAllResources();
  callbacksByTrack.get(CATALOG_TRACK_NAME)?.onForwardStateChange?.(true);
  await settle();
  assert.equal(catalogSent.length, 1);
  assert.equal(control.catalogGroupId, groupIdBeforeDisposal);
  assert.isFalse(control.catalogInitialSent);
  assert.isNull(control.catalogRepublishTimer);

  await publisher.close();
});

test("createPublishers: pause と resume は catalog の送り直しを止めない", async () => {
  // catalog を relay の cache に保つことが送り直しの目的であり、配信の一時停止とは独立である。
  // pause() / resume() を挟んでも予約が維持され、送り直しが続くことを確認する
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherCatalogRepublishControl;
  const { publisher: catalogPublisher, sent: catalogSent } = createRecordingSendPublisher();
  const publishers = new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]);
  const { session } = createPublishRecordingSession(publishers);
  control.session = session;
  control.catalogRepublishInterval = 10;

  await control.createPublishers();

  await control.publishCatalog();
  assert.equal(catalogSent.length, 1);
  assert.isNotNull(control.catalogRepublishTimer);

  publisher.pause();
  assert.equal(publisher.state, "paused");
  await sleep(50);
  assert.isAtLeast(catalogSent.length, 3);
  assert.isNotNull(control.catalogRepublishTimer);

  publisher.resume();
  assert.equal(publisher.state, "publishing");
  await sleep(50);
  const sentAfterResume = catalogSent.length;
  assert.isAtLeast(sentAfterResume, 5);

  await publisher.close();
});

test("publishCatalog: catalog 送信の事前検証 reject は印付きで 1 回だけ通知される", async () => {
  // start() は createPublishers() の後に publishCatalog() を await する。事前検証の違反は
  // publisher 層が通知してから返値を reject するため、reject が publishCatalog() を伝って
  // start() の catch に届く。
  // ここでは実物の publisher に事前検証で拒否させ、通知が publisher 層の 1 回で終わることと、
  // reject に印が付いたまま伝わることを固定する。
  // start() 自体は node に WebTransport が無く接続できないため、start() の catch が
  // 受ける位置 (publishCatalog() の await) までを駆動し、通知の抑止は
  // start 失敗の通知のテストで確認する
  const { control: loopControl, errors } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  // 高レベル API と同じ配線にする (publisher の error コールバックが onError に直結する)
  const catalogPublisher = new PublisherImpl(["live"], CATALOG_TRACK_NAME, 0n, 0n, (error) => {
    errors.push(error);
  });
  // END_OF_TRACK を受理させ、その後の catalog 送信を guard の事前検証で拒否させる
  // (委譲先を持たない publisher でも END_OF_TRACK の記録は行われる)
  await catalogPublisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });
  const { session } = createPublishRecordingSession(
    new Map<string, Publisher>([[CATALOG_TRACK_NAME, catalogPublisher]]),
  );
  control.session = session;

  let rejected: unknown = null;
  try {
    await control.createPublishers();
    await control.publishCatalog();
  } catch (error) {
    rejected = error;
  }

  // 事前検証の違反は publisher 層が通知してから返値の reject になる
  assert.instanceOf(rejected, ProtocolViolationError);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isTrue(isErrorNotifiedByPublisher(rejected));
});

/**
 * グループ管理・キーフレーム判定・codec description 送出判断の純関数
 *
 * MediaPublisherImpl から切り出した払い出しロジックと判定ロジックを、実装クラスや
 * 構造の注入を介さず固定値で直接駆動する。Group ID が進む条件と Object ID が
 * 0 に戻る条件、キーフレーム間隔の解決と境界、Audio Config / Video Config の再送判断、
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
  // forwardState が 0 から 1 になった時点 (後着購読者の出現) の要求に、
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
  // 初回の description が現れる前に forwardState が 1 になった場合は載せる値が無いため、
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

test("resolveVideoConfigToSend: 初回と変化時だけ Video Config を載せる", () => {
  // draft-ietf-moq-loc-04 §2.3.2.1 (Video Config): description が現れた最初の chunk と、
  // 値が変わった chunk だけ載せる。同じ値を毎 Object 送らない
  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);

  // 未送信の状態で description が現れたら載せ、保持する
  const first = resolveVideoConfigToSend(null, description, true, false);
  assert.deepEqual(first.config, description);
  assert.deepEqual(first.next, description);
  assert.isFalse(first.resendNext);

  // 保持値は複製する (呼び出し側が元の配列を書き換えても送出値が変わらない)
  const original = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  const mutable = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  const held = resolveVideoConfigToSend(null, mutable, true, false);
  assert.notStrictEqual(held.next, mutable);
  mutable.fill(0xff);
  assert.deepEqual(held.next, original);

  // 同じ値は載せず、保持値も変えない
  const same = resolveVideoConfigToSend(
    first.next,
    new Uint8Array([0x01, 0x42, 0xc0, 0x1f]),
    true,
    false,
  );
  assert.isUndefined(same.config);
  assert.deepEqual(same.next, first.next);
  assert.isFalse(same.resendNext);

  // 値が変わったら載せて保持値を更新する (キーフレーム以外でも新しい値は載せる)
  const changed = resolveVideoConfigToSend(
    first.next,
    new Uint8Array([0x01, 0x42, 0xc0, 0x2a]),
    false,
    false,
  );
  assert.deepEqual(changed.config, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));
  assert.deepEqual(changed.next, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));
  assert.isFalse(changed.resendNext);

  // description が無い chunk (初回出力と構成変更時以外や VP8) では載せず、
  // 保持値もそのままにする
  const withoutDescription = resolveVideoConfigToSend(first.next, undefined, true, false);
  assert.isUndefined(withoutDescription.config);
  assert.deepEqual(withoutDescription.next, first.next);
  assert.isFalse(withoutDescription.resendNext);
});

test("resolveVideoConfigToSend: 空の description は値なしとして扱う", () => {
  // 長さ 0 の description は extradata として意味を持たないため、長さ 0 の
  // VIDEO_CONFIG を送らず、description の無い chunk と同じ扱いにする
  const previous = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  const empty = resolveVideoConfigToSend(previous, new Uint8Array(0), true, false);

  assert.isUndefined(empty.config);
  assert.deepEqual(empty.next, previous);
  assert.isFalse(empty.resendNext);

  // 保持値が無い状態でも空は載せない
  const firstEmpty = resolveVideoConfigToSend(null, new Uint8Array(0), true, false);
  assert.isUndefined(firstEmpty.config);
  assert.isNull(firstEmpty.next);

  // 値なしとして扱うため、キーフレーム以外では要求が残る
  const pending = resolveVideoConfigToSend(previous, new Uint8Array(0), false, true);
  assert.isUndefined(pending.config);
  assert.isTrue(pending.resendNext);
});

test("resolveVideoConfigToSend: 送り直し要求はキーフレームで保持している Video Config を 1 Object 載せ直す", () => {
  // forwardState が 0 から 1 になった時点 (後着購読者の出現) の要求に、
  // 次のキーフレームで保持値を 1 Object だけ載せ直して応える。キーフレーム以外では
  // 要求を残す (GOP の途中で購読側に復号器を再構成させない)
  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  const sent = resolveVideoConfigToSend(null, description, true, false);

  // 要求が無い chunk では載らない
  const normal = resolveVideoConfigToSend(sent.next, undefined, true, false);
  assert.isUndefined(normal.config);
  assert.deepEqual(normal.next, sent.next);

  // キーフレーム以外では応えず、要求を残す
  const deferred = resolveVideoConfigToSend(normal.next, undefined, false, true);
  assert.isUndefined(deferred.config);
  assert.deepEqual(deferred.next, sent.next);
  assert.isTrue(deferred.resendNext);

  // キーフレームで保持値を載せ直し、要求は解消する
  const resent = resolveVideoConfigToSend(deferred.next, undefined, true, true);
  assert.deepEqual(resent.config, description);
  assert.deepEqual(resent.next, description);
  assert.isFalse(resent.resendNext);

  // 保持値は消さない (2 人目以降の購読者にも同じ要求で応えられる)
  const secondResend = resolveVideoConfigToSend(resent.next, undefined, true, true);
  assert.deepEqual(secondResend.config, description);
  assert.deepEqual(secondResend.next, description);
});

test("resolveVideoConfigToSend: 保持値が無いまま要求されたら要求を残す", () => {
  // 初回の description が現れる前に forwardState が 1 になった場合は載せる値が無いため、
  // 要求だけを残す (要求を消すと、次に description が現れても送り直しの意図が失われる)。
  // 保持値が無い間はキーフレームでも載せられない
  const onDelta = resolveVideoConfigToSend(null, undefined, false, true);
  assert.isUndefined(onDelta.config);
  assert.isNull(onDelta.next);
  assert.isTrue(onDelta.resendNext);

  const onKeyFrame = resolveVideoConfigToSend(onDelta.next, undefined, true, true);
  assert.isUndefined(onKeyFrame.config);
  assert.isNull(onKeyFrame.next);
  assert.isTrue(onKeyFrame.resendNext);

  // 要求が残ったまま次の description が現れたら、それを載せて要求は解消する
  const resolved = resolveVideoConfigToSend(
    onKeyFrame.next,
    new Uint8Array([0x01, 0x42, 0xc0, 0x1f]),
    true,
    true,
  );
  assert.deepEqual(resolved.config, new Uint8Array([0x01, 0x42, 0xc0, 0x1f]));
  assert.isFalse(resolved.resendNext);
});

test("resolveVideoConfigToSend: 送り直し要求より新しい description を優先する", () => {
  // 要求が立っている間に encoder の値が変わった場合は、保持値の再送ではなく
  // 新しい値を載せる (古い値を送ると購読側の復号設定と食い違う)
  const resent = resolveVideoConfigToSend(
    new Uint8Array([0x01, 0x42, 0xc0, 0x1f]),
    new Uint8Array([0x01, 0x42, 0xc0, 0x2a]),
    true,
    true,
  );

  assert.deepEqual(resent.config, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));
  assert.deepEqual(resent.next, new Uint8Array([0x01, 0x42, 0xc0, 0x2a]));
  assert.isFalse(resent.resendNext);
});

test("resolveKeyframeInterval: 映像オプションが無ければ既定の 2 秒になる", () => {
  // 間隔は秒で持つため、framerate から導出しない (映像を配信しない場合も同じ値)
  assert.equal(resolveKeyframeInterval(undefined), DEFAULT_KEYFRAME_INTERVAL_SECONDS);
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000 }), 2);
});

test("resolveKeyframeInterval: framerate を変えても既定値は変わらない", () => {
  // フレーム数ではなく時間で指定するため、実際の間隔は framerate に依存しない
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, framerate: 25 }), 2);
  assert.equal(resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, framerate: 60 }), 2);
});

test("resolveKeyframeInterval: keyframeInterval 指定時はその値になる", () => {
  // 明示指定が既定を上書きすることの検証
  assert.equal(
    resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, keyframeInterval: 10 }),
    10,
  );
  // 時間の指定なので、1 秒未満の値も受理する
  assert.equal(
    resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, keyframeInterval: 0.5 }),
    0.5,
  );
});

test("resolveKeyframeInterval: 0 以下と非有限数の keyframeInterval は値域エラーで reject する", () => {
  // 0 は「毎フレームキーフレーム」と解釈すると帯域を浪費し、負値と非有限数は経過時間の
  // 比較が成立しないため、0 より大きい有限数だけを受理する。
  // エラーメッセージに受け取った値を含めること
  const invalidValues = [
    0,
    -5,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const value of invalidValues) {
    assert.throws(
      () => resolveKeyframeInterval({ codec: "vp8", bitrate: 1000000, keyframeInterval: value }),
      new RegExp(`keyframeInterval must be a finite number of seconds > 0, got ${value}$`),
    );
  }
});

test("createMediaPublisher: 不正な keyframeInterval は公開 API で reject する", async () => {
  // 値域検証はコンストラクタで走るため、接続にも WebCodecs にも到達せず reject する
  let rejected: unknown = null;
  try {
    await createMediaPublisher("moqt://example.com/moqt", {
      namespace: ["live"],
      video: { codec: "vp8", bitrate: 1000000, keyframeInterval: 0 },
    });
  } catch (error) {
    rejected = error;
  }
  assert.instanceOf(rejected, Error);
  assert.include(
    (rejected as Error).message,
    "keyframeInterval must be a finite number of seconds > 0, got 0",
  );
});

test("shouldSendKeyFrame: 直前のキーフレームが無ければキーフレームになる", () => {
  // 初回フレームと startNewGroup() 直後 (直前のキーフレームの記録を null に戻す) が
  // キーフレームになることの検証
  assert.isTrue(shouldSendKeyFrame(null, 0, 60));
  assert.isTrue(shouldSendKeyFrame(null, 1_000_000, 1));
});

test("shouldSendKeyFrame: 経過時間が間隔に届くまでキーフレームにしない", () => {
  // 間隔 60 秒の境界をマイクロ秒で固定する (直前のキーフレームから
  // 59.999999 秒 / 60 秒 / 60.000001 秒)
  assert.isFalse(shouldSendKeyFrame(0, 59_999_999, 60));
  assert.isTrue(shouldSendKeyFrame(0, 60_000_000, 60));
  assert.isFalse(shouldSendKeyFrame(1_000_000, 60_999_999, 60));
  assert.isTrue(shouldSendKeyFrame(1_000_000, 61_000_000, 60));
});

test("shouldSendKeyFrame: timestamp が巻き戻ったらキーフレームになる", () => {
  // 映像の入力が差し替わって timestamp が前のキーフレームより戻った場合も、
  // 復号を始められるよう先頭としてキーフレームにする
  assert.isTrue(shouldSendKeyFrame(5_000_000, 0, 60));
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
 * draft-ietf-moq-transport-22 §5.1.1:
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
  // 音声の送信内容を Subgroup の sendObject で見るため、明示的に Subgroup を選ぶ
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent: audioSent } = createRecordingSendPublisher();
  const { publisher: videoPublisher, sent: videoSent } = createRecordingSendPublisher();
  control.audioPublisher = audioPublisher;
  control.videoPublisher = videoPublisher;

  // 符号化を依頼した時点の記録を作る (実経路と同じ)
  recordAudioEncode(control, 0);
  control.handleAudioEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  // 音声は 1 フレーム 1 Group のため、2 件目以降も音声の値を載せる
  recordAudioEncode(control, 1);
  control.handleAudioEncodedChunk({
    data: new Uint8Array([2]),
    type: "key",
    timestamp: 1,
    duration: null,
  });
  recordVideoEncode(control, 0);
  control.handleVideoEncodedChunk({
    data: new Uint8Array([1]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  recordVideoEncode(control, 1);
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
    sendObject: async (params: { groupId: number; objectId: number; payload: Uint8Array }) => {
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

/**
 * draft-ietf-moq-msf-01 §5.2.42 / §11.4.1: 視聴側は catalog の track の authInfo を見て、
 * SUBSCRIBE にトークンを付けるかを決める。C4M のトークン (CAT、Token Type 0x01) で接続した
 * 配信は、音声と映像の両方の track に authInfo を載せ、視聴側に同じ方式のトークンを求める
 */
test("publishCatalog: SETUP のトークンが CAT なら音声と映像の track に authInfo を載せる", async () => {
  const { control, sent } = createCatalogPublishContext({
    namespace: ["live"],
    audio: { codec: "aac", bitrate: 64000 },
    video: { codec: "vp8", bitrate: 1000000 },
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 1n,
      tokenValue: new Uint8Array([0xd2, 0x84, 0x43]),
    },
  });

  await control.publishCatalog();

  const decoded = decodeCatalogMessage(sent[0].payload);
  if (!("version" in decoded)) {
    throw new Error("expected a full catalog, got a delta update");
  }
  assert.deepEqual(
    decoded.tracks.map((track) => track.role),
    ["audio", "video"],
  );
  for (const track of decoded.tracks) {
    // トークンそのものではなく、fragment の c4m を指す変数参照を載せる
    assert.deepEqual(track.authInfo, { cat: "%c4m%" });
  }
});

/**
 * CAT 以外のトークンや、トークンが無い配信は authInfo を載せない。authInfo があると、
 * 視聴側はトークンを用意できないときに subscribe を失敗させる (§11.4.4)。
 * 符号化は undefined の値を落とすため、キーの有無は payload の JSON で確かめる
 */
test("publishCatalog: SETUP のトークンが CAT でなければ authInfo を載せない", async () => {
  const cases: MediaPublisherOptions[] = [
    {
      namespace: ["live"],
      audio: { codec: "aac", bitrate: 64000 },
      video: { codec: "vp8", bitrate: 1000000 },
    },
    {
      namespace: ["live"],
      audio: { codec: "aac", bitrate: 64000 },
      video: { codec: "vp8", bitrate: 1000000 },
      // Token Type 0 は out-of-band のトークン
      authorizationToken: {
        aliasType: AuthorizationTokenAliasType.USE_VALUE,
        tokenType: 0n,
        tokenValue: new TextEncoder().encode("token"),
      },
    },
  ];
  for (const options of cases) {
    const { control, sent } = createCatalogPublishContext(options);

    await control.publishCatalog();

    const trackObjects = parseCatalogTrackObjects(sent[0].payload);
    assert.equal(trackObjects.length, 2);
    for (const track of trackObjects) {
      assert.isFalse("authInfo" in track);
    }
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
 * draft-ietf-moq-transport-22 §5.1.1 / draft-ietf-moq-msf-01 §5:
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
  // draft-ietf-moq-transport-22 §5.1.1: 0-255 の符号無し整数で数値が小さいほど
  // 高優先である。キーフレーム < 音声 < デルタフレームの順になることを固定する
  // (デルタフレームは draft-ietf-moq-transport-22 §10.4 の既定 128 のまま据え置く)
  assert.isTrue(PRIORITY_CATALOG <= PRIORITY_VIDEO_KEY);
  assert.isTrue(PRIORITY_VIDEO_KEY < PRIORITY_AUDIO);
  assert.isTrue(PRIORITY_AUDIO < PRIORITY_VIDEO_DELTA);
});

/**
 * draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH へ MUST 付与する
 * (SETUP に載せていても免除されない)。createPublishers() は SETUP Option (0x03) として送った
 * トークン (`Session.setupAuthorizationToken`) を catalog と音声の PUBLISH にそのまま載せる。
 */
test("createPublishers: SETUP に載せたトークンを PUBLISH に付与する", async () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  const audioSettings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  control.resolvedAudio = audioSettings;
  const { publisher: catalogPublisher } = createRecordingSendPublisher();
  const { publisher: audioPublisher } = createCapturingPublisher();
  const publishers = new Map<string, Publisher>([
    [CATALOG_TRACK_NAME, catalogPublisher],
    [audioSettings.trackName, audioPublisher],
  ]);
  const { session, optionsByTrack } = createPublishRecordingSession(publishers);
  const token = useValueToken();
  // 実セッションは initialize() で SETUP のトークンを保持する
  (
    session as unknown as { setupAuthorizationToken: AuthorizationToken | undefined }
  ).setupAuthorizationToken = token;
  control.session = session;

  // PUBLISH に載るトークンを見るため、catalog の Object の送信は要らない
  await control.createPublishers();

  assert.equal(optionsByTrack.get(CATALOG_TRACK_NAME)?.authorizationToken, token);
  assert.equal(optionsByTrack.get(audioSettings.trackName)?.authorizationToken, token);
});

// SETUP にトークンを送っていない場合は、PUBLISH にも AUTHORIZATION TOKEN を載せない
test("createPublishers: SETUP にトークンが無ければ PUBLISH に付与しない", async () => {
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherForwardControl;
  const audioSettings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 64000,
    trackName: "audio",
  });
  control.resolvedAudio = audioSettings;
  const { publisher: catalogPublisher } = createRecordingSendPublisher();
  const { publisher: audioPublisher } = createCapturingPublisher();
  const publishers = new Map<string, Publisher>([
    [CATALOG_TRACK_NAME, catalogPublisher],
    [audioSettings.trackName, audioPublisher],
  ]);
  const { session, optionsByTrack } = createPublishRecordingSession(publishers);
  control.session = session;

  // PUBLISH に載るトークンを見るため、catalog の Object の送信は要らない
  await control.createPublishers();

  assert.isUndefined(optionsByTrack.get(CATALOG_TRACK_NAME)?.authorizationToken);
  assert.isUndefined(optionsByTrack.get(audioSettings.trackName)?.authorizationToken);
});

test("pause: 開いている Subgroup を閉じる", async () => {
  // draft-ietf-moq-transport-22 §11.3.2: 配信を止めた時点で「その Subgroup に続く Object は
  // 無い」ため、開いている Subgroup を FIN で閉じる MUST を満たせる。閉じないと、次の
  // Object を待つ購読側が DATA_STREAM_TIMEOUT (0x12) でセッションを閉じうる
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl & {
    catalogPublisher: Publisher | null;
  };
  const catalog = createRecordingSendPublisher();
  const audio = createRecordingSendPublisher();
  const video = createRecordingSendPublisher();
  control.catalogPublisher = catalog.publisher;
  control.audioPublisher = audio.publisher;
  control.videoPublisher = video.publisher;

  publisher.pause();

  assert.equal(publisher.state, "paused");
  assert.equal(catalog.closeSubgroupCount(), 1, "catalog の Subgroup を閉じていない");
  assert.equal(audio.closeSubgroupCount(), 1, "音声の Subgroup を閉じていない");
  assert.equal(video.closeSubgroupCount(), 1, "映像の Subgroup を閉じていない");

  // catalog の送り直しは止めない (pause は送信の停止であり、購読の維持とは別である)
  await publisher.close();
});

test("pause: 止める前に依頼した映像の出力は送られない", () => {
  // 符号化は非同期であり、pause の直前に依頼したフレームの出力が pause の後に届く。
  // 止めた時点で閉じた Subgroup へ送らない (WebCodecs は出力の到着順も保証しないため、
  // 到着順ではなく依頼した時点の世代で判定する)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl;
  const { publisher: videoPublisher, sent } = createRecordingSendPublisher();
  control.videoPublisher = videoPublisher;

  recordVideoEncode(control, 1000);
  publisher.pause();
  control.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 1000,
    duration: null,
  });

  assert.equal(sent.length, 0, "閉じた Subgroup へ送っている");
});

test("pause: 止める前に依頼した音声の出力は送られない", () => {
  // 音声も同じ規則。世代は audioPublishCatchUp の投入の記録に載せて返す
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl;
  const { publisher: audioPublisher, sent } = createRecordingSendPublisher();
  control.audioPublisher = audioPublisher;

  recordAudioEncode(control, 0);
  publisher.pause();
  control.handleAudioEncodedChunk({
    data: new Uint8Array([0xbb]),
    type: "key",
    timestamp: 0,
    duration: null,
  });

  assert.equal(sent.length, 0, "閉じた Subgroup へ送っている");
});

test("pause → resume: 再開後はキーフレームで新しい Group を始める", async () => {
  // 閉じた Group へ送り直さないよう、再開後は新しい Group をキーフレームから始める
  // (startNewGroup() と同じ効果)。直前のキーフレームの記録が残っていると、再開後の
  // 最初のフレームがデルタになり、購読側は映像を出せない
  const { publisher, control } = createLoopTestContext({
    video: { codec: "vp8", bitrate: 1000 },
  });
  const groupControl = control as unknown as PublisherGroupControl;
  const { publisher: videoPublisher, sent } = createRecordingSendPublisher();
  groupControl.videoPublisher = videoPublisher;

  // 配信が始まっている状態を作る (最初のキーフレームは初期の Group をそのまま使う)
  const initialVideoGroupId = groupControl.videoGroupId;
  recordVideoEncode(groupControl, 0);
  groupControl.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 0,
    duration: null,
  });
  assert.equal(sent[0].groupId, initialVideoGroupId);

  // 直前のキーフレームの記録が残ったまま pause → resume する
  control.lastKeyFrameTimestampUs = 1000;
  publisher.pause();
  publisher.resume();
  assert.equal(publisher.state, "publishing");

  // 実ループに 1 枚流す。記録が消えているためキーフレームとして encode される
  const { keyFrames, controller } = injectVideoLoop(control);
  const loop = control.processVideoFrames();
  const frame = createTestFrame(2000);
  controller.enqueue(frame);
  await Promise.resolve();
  await Promise.resolve();
  controller.close();
  await loop;

  assert.deepEqual(keyFrames, [true], "再開後の最初のフレームがキーフレームになっていない");
  // encode を依頼した時点の世代が記録される (実経路の記録。取り違えると出力を送れない)
  assert.equal(
    groupControl.videoEncodeGenerations.get(frame.timestamp)?.generation,
    control.processingGeneration,
    "encode を依頼した時点の世代が記録されていない",
  );

  // その出力を流すと、新しい Group の先頭 Object になる
  groupControl.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: frame.timestamp,
    duration: null,
  });

  assert.equal(
    sent[1].groupId,
    initialVideoGroupId + 1,
    "再開後のキーフレームが新しい Group になっていない",
  );
  assert.equal(sent[1].objectId, 0);
});

test("start: 配信ごとの初期化で前の配信の映像の記録を消す", async () => {
  // stop のあとの start は同じインスタンスを使い、世代のカウンタは戻さない。記録を
  // 持ち越すと、前の配信の出力と取り違えて新しい配信の出力を捨てるおそれがある。
  // start() が呼ぶ初期化 (setupEncoders) を通した後は記録が残っていないことを確認する
  const { control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl & {
    setupEncoders(): Promise<void>;
  };
  const { publisher: videoPublisher, sent } = createRecordingSendPublisher();
  control.videoPublisher = videoPublisher;

  recordVideoEncode(control, 1000);
  await control.setupEncoders();

  control.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 1000,
    duration: null,
  });

  assert.equal(sent.length, 0, "前の配信の記録が残っている");
});

test("pause: 捨てた出力の Audio Config は次の送信で載る", () => {
  // description は configure 後の最初の出力にしか載らない。配信を止める直前に届いた出力を
  // 捨てるときに description を失うと、復号に必要な AUDIO_CONFIG を以後の配信で送れなく
  // なる (AAC は AudioSpecificConfig が必須で、catalog の Track Property にも載せない)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl;
  // audioPublisher へ送る経路 (Subgroup の sendObject) を見るため、明示的に Subgroup を選ぶ
  setSubgroupAudioDelivery(control);
  const { publisher: audioPublisher, sent } = createCapturingPublisher();
  control.audioPublisher = audioPublisher;

  const description = new Uint8Array([0x11, 0x90]);
  recordAudioEncode(control, 0);
  publisher.pause();
  control.handleAudioEncodedChunk({
    data: new Uint8Array([0xbb]),
    type: "key",
    timestamp: 0,
    duration: null,
    description,
  });
  assert.equal(sent.length, 0, "閉じた Subgroup へ送っている");

  // 再開後に届く出力は description を持たないが、捨てた出力の値が載る
  publisher.resume();
  recordAudioEncode(control, 1000);
  control.handleAudioEncodedChunk({
    data: new Uint8Array([0xbb]),
    type: "key",
    timestamp: 1000,
    duration: null,
  });

  assert.equal(sent.length, 1);
  const decoded = LOC.decodeAudioProperties(sent[0].properties ?? new Uint8Array(0));
  assert.deepEqual(decoded.config, description, "捨てた出力の Audio Config が載っていない");
});

test("pause: 捨てた出力の Video Config は次のキーフレームで載る", () => {
  // 映像も同じ (canonical 形式の description は configure 後の最初の出力にしか載らない)
  const { publisher, control: loopControl } = createLoopTestContext();
  const control = loopControl as unknown as PublisherGroupControl;
  const { publisher: videoPublisher, sent } = createCapturingPublisher();
  control.videoPublisher = videoPublisher;

  const description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f]);
  recordVideoEncode(control, 1000);
  publisher.pause();
  control.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 1000,
    duration: null,
    description,
  });
  assert.equal(sent.length, 0, "閉じた Subgroup へ送っている");

  publisher.resume();
  recordVideoEncode(control, 2000);
  control.handleVideoEncodedChunk({
    data: new Uint8Array([0xaa]),
    type: "key",
    timestamp: 2000,
    duration: null,
  });

  assert.equal(sent.length, 1);
  const decoded = LOC.decodeVideoProperties(sent[0].properties ?? new Uint8Array(0));
  assert.deepEqual(decoded.config, description, "捨てた出力の Video Config が載っていない");
});

test("selectCodecDescription: 空の description は保留値を覆わない", () => {
  // 送らなかった出力の description を保留している間は、空の description を「値なし」として
  // 扱う (覆うと、載せる値が無いまま保留値が消える)
  const pending = new Uint8Array([1, 2]);

  const fresh = new Uint8Array([3, 4]);
  assert.deepEqual(
    selectCodecDescription(fresh, pending),
    fresh,
    "値のある description を使っていない",
  );
  assert.deepEqual(
    selectCodecDescription(new Uint8Array(), pending),
    pending,
    "空の description が保留値を覆っている",
  );
  assert.deepEqual(selectCodecDescription(undefined, pending), pending);
  assert.isUndefined(selectCodecDescription(new Uint8Array(), null), "値が無いのに載せている");
  assert.isUndefined(selectCodecDescription(undefined, null));
});

// ============================================================================
// 停止時の末尾 flush: 停止前に読んだフレームと encoder の中身を送り切る
// ============================================================================

/** 末尾 flush の検証で使う音声ブロック (10 ms) */
interface TailAudioBlock {
  readonly timestamp: number;
  readonly duration: number;
  closed: boolean;
  close(): void;
}

/** 音声ブロックを作る (48 kHz の 10 ms。timestamp はマイクロ秒) */
function createTailAudioBlock(index: number): TailAudioBlock {
  const block: TailAudioBlock = {
    timestamp: index * 10_000,
    duration: 10_000,
    closed: false,
    close: () => {
      block.closed = true;
    },
  };
  return block;
}

/**
 * 停止時の末尾 flush の検証用の制御口
 *
 * `processAudioFrames` と private の送信経路を直接駆動する。エンコーダーと Publisher は
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
interface TailFlushControl extends PublisherLoopControl {
  audioPublisher: Publisher | null;
  resolvedAudio: { delivery: "datagram" | "subgroup"; redundancy: number } | null;
  audioTailDrain: unknown;
  pendingAudioTailGrace: boolean;
  handleAudioEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void;
}

/** 送信の記録 (種類と時刻) */
interface TailSentRecord {
  readonly kind: "datagram" | "subgroup" | "done";
  readonly atMs: number;
}

/**
 * 停止時の末尾 flush を駆動するコンテキストを作る
 *
 * エンコーダーは encode されたフレームを溜め、`flush()` でまとめて出力する (WebCodecs の
 * 「flush するまで出力が返らない」状態を再現する)。出力は本番の経路
 * (`handleAudioEncodedChunk`) へ渡す。
 */
function createTailFlushContext(options: {
  delivery: "datagram" | "subgroup";
  flushDelayMs?: number;
}): {
  publisher: MediaPublisherImpl;
  control: TailFlushControl;
  controller: ReadableStreamDefaultController<TailAudioBlock>;
  encodedBlocks: TailAudioBlock[];
  sent: TailSentRecord[];
  order: string[];
  errors: Error[];
} {
  const errors: Error[] = [];
  const publisher = new MediaPublisherImpl(
    "moqt://example.com/live",
    {
      namespace: ["live"],
      audio: { codec: "opus", bitrate: 64_000, delivery: options.delivery },
    },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = publisher as unknown as TailFlushControl;
  control.currentState = "publishing";
  control.processingActive = true;
  // start() が解決する値と同じ形にする (送り方と冗長度)
  control.resolvedAudio = { delivery: options.delivery, redundancy: 1 };

  let controller!: ReadableStreamDefaultController<TailAudioBlock>;
  const stream = new ReadableStream<TailAudioBlock>({
    start(c) {
      controller = c;
    },
  });
  control.audioFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<AudioData>;

  // 送信の記録 (PUBLISH_DONE の順序を時刻で確かめる)
  const sent: TailSentRecord[] = [];
  const order: string[] = [];
  const audioPublisher = {
    state: "active",
    forwardState: true,
    closeSubgroup: async () => {},
    sendObject: async () => {
      sent.push({ kind: "subgroup", atMs: performance.now() });
      order.push("send");
    },
    sendDatagram: () => {
      sent.push({ kind: "datagram", atMs: performance.now() });
      order.push("send");
      return Promise.resolve();
    },
    done: async () => {
      sent.push({ kind: "done", atMs: performance.now() });
      order.push("done");
    },
  } as unknown as Publisher;
  control.audioPublisher = audioPublisher;

  // エンコーダー: encode されたフレームを溜め、flush でまとめて出力する
  const encodedBlocks: TailAudioBlock[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const encoder = {
    state: "configured",
    encodeQueueSize: 0,
    encode: (data: TailAudioBlock) => {
      encodedBlocks.push(data);
      order.push("encode");
    },
    flush: async (): Promise<void> => {
      const delayMs = options.flushDelayMs ?? 0;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          flushTimer = setTimeout(resolve, delayMs);
        });
      }
      order.push("flush");
      // flush の出力を本番の経路へ渡す (ここで送信される)
      const pending = encodedBlocks.splice(0);
      for (const block of pending) {
        control.handleAudioEncodedChunk({
          data: new Uint8Array([1]),
          type: "key",
          timestamp: block.timestamp,
          duration: block.duration,
        });
      }
    },
    close: () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      order.push("close");
    },
  };
  control.audioEncoder = encoder as unknown as AudioEncoderWrapper;
  return { publisher, control, controller, encodedBlocks, sent, order, errors };
}

/**
 * 完了条件: 停止の前に投入した 10 ms ブロックがすべて encode され、送信される
 * (末尾の欠落 30 ms → 0 ms)。
 */
test("stop: 停止前に読んだ音声ブロックをすべて encode・送信する", async () => {
  const context = createTailFlushContext({ delivery: "subgroup" });
  const blocks = [
    createTailAudioBlock(0),
    createTailAudioBlock(1),
    createTailAudioBlock(2),
    createTailAudioBlock(3),
  ];
  const loop = context.control.processAudioFrames();
  // 2 ブロックを処理させ、残り 2 ブロックをキューに残した状態で停止する
  context.controller.enqueue(blocks[0]!);
  context.controller.enqueue(blocks[1]!);
  await settle();
  assert.equal(context.encodedBlocks.length, 1, "先読みでブロック 0 が encode されること");

  context.controller.enqueue(blocks[2]!);
  context.controller.enqueue(blocks[3]!);
  await context.publisher.stop();
  await loop;

  // 停止前に投入した 4 ブロックがすべて encode され、送信された
  assert.equal(context.encodedBlocks.length, 0, "flush で溜めた出力をすべて出したこと");
  const sentCount = context.sent.filter((record) => record.kind !== "done").length;
  assert.equal(sentCount, 4, "4 ブロック分の Object を送ること (30 ms の欠落を 0 にする)");
  const stats = context.publisher.getStats().audio;
  assert.isDefined(stats);
  assert.equal(stats?.tailFlushedFrames, 4, "flush で送れた末尾を数えること");
  assert.isAbove(stats?.tailFlushedMs ?? 0, 0);
  assert.equal(stats?.tailDroppedFrames, 0, "停止時に取りこぼした入力が無いこと");
  assert.equal(stats?.tailDroppedMs, 0);
  // ブロックはすべて閉じられる (閉じ忘れが無い)
  for (const block of blocks) {
    assert.isTrue(block.closed, "読み出したブロックを閉じること");
  }
  assert.isNull(context.control.audioTailDrain, "tail drain の状態を残さないこと");
  assert.equal(context.errors.length, 0);
});

/**
 * 完了条件: encoder に残った出力が flush で送られ、encoder の close と PUBLISH_DONE の
 * 前に送信が終わること。
 */
test("stop: flush の出力を encoder の close と PUBLISH_DONE より前に送る", async () => {
  const context = createTailFlushContext({ delivery: "subgroup" });
  const loop = context.control.processAudioFrames();
  for (let index = 0; index < 4; index++) {
    context.controller.enqueue(createTailAudioBlock(index));
  }
  await settle();
  await context.publisher.stop();
  await loop;

  const sendIndexes = context.order
    .map((entry, index) => (entry === "send" ? index : -1))
    .filter((index) => index >= 0);
  const closeIndex = context.order.indexOf("close");
  const doneIndex = context.order.indexOf("done");
  assert.isAbove(sendIndexes.length, 0, "flush の出力を送ること");
  assert.isAbove(closeIndex, Math.max(...sendIndexes), "送信の後に encoder を閉じること");
  assert.isAbove(doneIndex, closeIndex, "PUBLISH_DONE は close の後 (dispose の中) であること");
});

/**
 * 完了条件: datagram 配送の停止では、末尾の datagram を書いた後に猶予
 * (AUDIO_TAIL_PUBLISH_DONE_GRACE_MS) を待ってから PUBLISH_DONE を送る。
 */
test("stop: datagram 配送では PUBLISH_DONE を末尾 datagram の後に送る", async () => {
  const context = createTailFlushContext({ delivery: "datagram" });
  const loop = context.control.processAudioFrames();
  for (let index = 0; index < 4; index++) {
    context.controller.enqueue(createTailAudioBlock(index));
  }
  await settle();
  await context.publisher.stop();
  await loop;

  // 最後に書いた datagram (lib の対象が ES2023 より前のため findLast を使わない)
  let lastDatagram: TailSentRecord | undefined;
  for (const record of context.sent) {
    if (record.kind === "datagram") {
      lastDatagram = record;
    }
  }
  const done = context.sent.find((record) => record.kind === "done");
  assert.isDefined(lastDatagram, "末尾の datagram を書くこと");
  assert.isDefined(done, "PUBLISH_DONE を送ること");
  const gapMs = (done?.atMs ?? 0) - (lastDatagram?.atMs ?? 0);
  assert.isAtLeast(gapMs, AUDIO_TAIL_PUBLISH_DONE_GRACE_MS - 5, "猶予を待つこと");
  assert.isAtMost(gapMs, AUDIO_TAIL_PUBLISH_DONE_GRACE_MS + 200, "猶予を超えて待たないこと");
  // PUBLISH_DONE の後に datagram を送らない
  assert.isFalse(
    context.sent.some((record) => record.kind === "datagram" && record.atMs > (done?.atMs ?? 0)),
    "PUBLISH_DONE の後に datagram を送らないこと",
  );
});

/**
 * 完了条件: 末尾 flush の待ちの間の二重 stop は拒否され、1 回目の停止は完了する。
 */
test("stop: 末尾 flush の待ちの間の二重 stop を拒否する", async () => {
  const context = createTailFlushContext({ delivery: "subgroup", flushDelayMs: 20 });
  const loop = context.control.processAudioFrames();
  context.controller.enqueue(createTailAudioBlock(0));
  await settle();

  const first = context.publisher.stop();
  let secondError: unknown = null;
  try {
    await context.publisher.stop();
  } catch (error) {
    secondError = error;
  }
  assert.instanceOf(secondError, Error);
  assert.match((secondError as Error).message, /cannot stop while stopping/);
  await first;
  await loop;
  assert.equal(context.control.currentState, "stopped");
});

/**
 * 完了条件: close() の末尾 flush の待ちの間の stop は cannot stop while closing で拒否する。
 */
test("stop: close の末尾 flush の待ちの間は cannot stop while closing で拒否する", async () => {
  const context = createTailFlushContext({ delivery: "subgroup", flushDelayMs: 20 });
  const loop = context.control.processAudioFrames();
  context.controller.enqueue(createTailAudioBlock(0));
  await settle();

  const closing = context.publisher.close();
  let stopError: unknown = null;
  try {
    await context.publisher.stop();
  } catch (error) {
    stopError = error;
  }
  assert.instanceOf(stopError, Error);
  assert.match((stopError as Error).message, /cannot stop while closing/);
  await closing;
  await loop;
  assert.equal(context.control.currentState, "closed");
});

/**
 * 完了条件: 停止の後に再 start 相当の処理ループを動かしても、末尾 flush の状態が残らず
 * 通常どおり encode と送信ができる。
 */
test("stop: 停止の後に再 start 相当でループを動かせる", async () => {
  const context = createTailFlushContext({ delivery: "subgroup" });
  const loop = context.control.processAudioFrames();
  context.controller.enqueue(createTailAudioBlock(0));
  await settle();
  // 停止の受付時点ではループは次のフレームの read で待っている。実際のトラックは
  // 10 ms 周期でフレームを出すため、停止の直後に次のフレームが届いて read が解ける
  const stopping = context.publisher.stop();
  context.controller.enqueue(createTailAudioBlock(10));
  await stopping;
  await loop;
  const sentAfterStop = context.sent.filter((record) => record.kind !== "done").length;
  // 1 フレーム先読みの保留分と、停止直後に読んだ 1 フレーム (保留の read を解いた分)
  assert.equal(sentAfterStop, 2, "保留分と停止直後に読んだフレームを送ること");
  assert.equal(context.control.pendingAudioTailGrace, false, "猶予の状態を残さないこと");

  // 再 start 相当: 新しい reader と encoder を注入し、publishing に戻してループを動かす
  let controller!: ReadableStreamDefaultController<TailAudioBlock>;
  const stream = new ReadableStream<TailAudioBlock>({
    start(c) {
      controller = c;
    },
  });
  context.control.audioFrameReader =
    stream.getReader() as unknown as ReadableStreamDefaultReader<AudioData>;
  const encoded: TailAudioBlock[] = [];
  context.control.audioEncoder = {
    state: "configured",
    encodeQueueSize: 0,
    encode: (data: TailAudioBlock) => {
      encoded.push(data);
    },
    flush: async () => {},
    close: () => {},
  } as unknown as AudioEncoderWrapper;
  context.control.currentState = "publishing";
  context.control.processingActive = true;
  const secondLoop = context.control.processAudioFrames();
  const block = createTailAudioBlock(10);
  controller.enqueue(block);
  await settle();
  controller.close();
  await secondLoop;

  assert.equal(encoded.length, 1, "再 start 相当で次のフレームを encode すること");
  assert.isTrue(block.closed);
});
