/**
 * MediaSubscriber の PUBLISH_DONE と停止時の drain の単体テスト
 *
 * resolvePublishDoneError の解釈、PUBLISH_DONE の終了通知の配線、
 * 停止時に予約済みの音声を鳴らし切る drain を検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import type { Session, SubscribeCallbacks } from "./session";

import type { Subscriber } from "./subscriber";

import type { MediaSubscriberState } from "./codec/types";

import { resolvePublishDoneError } from "./createMediaSubscriber";

import { PublishDoneStatusCode } from "./message/types";

import {
  createTestSubscriber,
  makeIdentifiedObject,
  createPreDecodeDelaySubscriber,
  type SubscriberFrameControl,
  sleep,
  type SubscriberLifecycleControl,
  captureThrown,
  makeAudioTrackInfo,
  makeVideoTrackInfo,
} from "./testSupport/mediaSubscriberTestSupport";

// ============================================================================
// resolvePublishDoneError
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE) / §12.4 (Publish Done Codes):
 * エラーを示す Status Code の PUBLISH_DONE だけを購読の失敗として扱い、
 * 正常終了 (TRACK_ENDED 等) では失敗にしないことを検証する。
 */
test("resolvePublishDoneError: 正常終了の Status Code では null を返す", () => {
  assert.isNull(
    resolvePublishDoneError({ statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" }),
  );
  assert.isNull(
    resolvePublishDoneError({ statusCode: PublishDoneStatusCode.GOING_AWAY, reasonPhrase: "bye" }),
  );
  assert.isNull(
    resolvePublishDoneError({ statusCode: PublishDoneStatusCode.EXPIRED, reasonPhrase: "expired" }),
  );
});

test("resolvePublishDoneError: エラーを示す Status Code では status code と reason を載せた Error を返す", () => {
  const error = resolvePublishDoneError({
    statusCode: PublishDoneStatusCode.UPDATE_FAILED,
    reasonPhrase: "update failed",
  });
  assert.isNotNull(error);
  assert.equal(error!.message, "PUBLISH_DONE with status 0x8: update failed");
});

test("resolvePublishDoneError: reason が空でも Error のメッセージに余分な区切りを残さない", () => {
  const error = resolvePublishDoneError({
    statusCode: PublishDoneStatusCode.MALFORMED_TRACK,
    reasonPhrase: "",
  });
  assert.isNotNull(error);
  assert.equal(error!.message, "PUBLISH_DONE with status 0x12");
});

// ============================================================================
// PUBLISH_DONE の終了通知の配線
// ============================================================================

/**
 * 完了条件: エラー status の PUBLISH_DONE が高レベル API の onError に届く。
 *
 * 低レベル API は PUBLISH_DONE を end だけで通知するため、高レベル API が購読の失敗として
 * 扱うかどうかは購読の end の配線が決める。映像トラックの経路を実際の購読で固定する。
 */
test("subscribeMediaTracks: エラー status の PUBLISH_DONE で映像の購読が onError に届く", async () => {
  const { subscriber, errors } = createTestSubscriber({ video: { codec: "vp8" } });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  let videoCallbacks: SubscribeCallbacks | undefined;
  control.session = {
    subscribe: async (_namespace: string[], _trackName: string, callbacks: SubscribeCallbacks) => {
      videoCallbacks = callbacks;
      return {
        state: "active",
        trackProperties: [],
        unsubscribe: async () => {},
      } as unknown as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
  control.currentState = "subscribing";

  await control.subscribeMediaTracks(control.sessionGeneration);
  assert.isDefined(videoCallbacks);

  // 正常終了 (TRACK_ENDED) では購読の失敗として通知しない
  videoCallbacks?.end?.({ statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" });
  assert.deepEqual(errors, []);

  // エラー status では理由を載せた Error が onError に届く
  videoCallbacks?.end?.({
    statusCode: PublishDoneStatusCode.MALFORMED_TRACK,
    reasonPhrase: "bad track",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "PUBLISH_DONE with status 0x12: bad track");
});

/**
 * 完了条件: 音声だけの購読でも、エラー status の PUBLISH_DONE が onError に届く。
 *
 * 音声は映像より先に購読するため、映像側の配線だけを直しても音声だけの購読は失敗を
 * 通知しないままになる。音声の経路を実際の購読で固定する。
 */
test("subscribeMediaTracks: エラー status の PUBLISH_DONE で音声だけの購読が onError に届く", async () => {
  const { subscriber, errors } = createTestSubscriber({ audio: { codec: "opus" } });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  let audioCallbacks: SubscribeCallbacks | undefined;
  control.session = {
    subscribe: async (_namespace: string[], _trackName: string, callbacks: SubscribeCallbacks) => {
      audioCallbacks = callbacks;
      return {
        state: "active",
        largestLocation: null,
        trackProperties: [],
        unsubscribe: async () => {},
      } as unknown as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  control.audioTrackInfo = makeAudioTrackInfo({ codec: "opus" });
  control.currentState = "subscribing";

  await control.subscribeMediaTracks(control.sessionGeneration);
  assert.isDefined(audioCallbacks);

  audioCallbacks?.end?.({
    statusCode: PublishDoneStatusCode.EXCESSIVE_LOAD,
    reasonPhrase: "loaded",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "PUBLISH_DONE with status 0x9: loaded");
});

/**
 * 完了条件: catalog の購読がエラー status の PUBLISH_DONE で終わったとき、タイムアウトを
 * 待たずに失敗として通知する。
 *
 * catalog は購読の確立そのものなので、失敗の理由を待ち時間ではなく PUBLISH_DONE から
 * 受け取れる必要がある。FETCH を失敗させて live のカタログ待ちに入れ、その購読の終了を
 * エラー status で終わらせる。
 */
test("subscribeCatalog: エラー status の PUBLISH_DONE で catalog の購読が失敗する", async () => {
  const { subscriber, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  let catalogCallbacks: SubscribeCallbacks | undefined;
  control.session = {
    subscribe: async (_namespace: string[], _trackName: string, callbacks: SubscribeCallbacks) => {
      catalogCallbacks = callbacks;
      return {
        state: "active",
        largestLocation: null,
        unsubscribe: async () => {},
      } as unknown as Subscriber;
    },
    // FETCH を失敗させ、FETCH フェーズを終わらせる (live のカタログ待ちに入る)
    fetch: async () => {
      throw new Error("fetch failed");
    },
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeCatalog(control.sessionGeneration, 60_000);
  // 購読の await を解決させ、カタログの受信待ちに入れる
  await sleep(0);
  assert.isNotNull(control.catalogResolve);
  assert.isDefined(catalogCallbacks);

  // カタログが届く前に購読がエラー status の PUBLISH_DONE で終わる。
  // 購読の失敗は onError に届く (カタログの待ちは購読の受信か解放でしか解けない)
  catalogCallbacks?.end?.({
    statusCode: PublishDoneStatusCode.INTERNAL_ERROR,
    reasonPhrase: "catalog broken",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "PUBLISH_DONE with status 0x0: catalog broken");

  // カタログの待ちは解放で打ち切る
  const closing = subscriber.close();
  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "catalog receive aborted: resources disposed");
});

// ============================================================================
// 停止時の drain (予約済みの音声を鳴らし切ってから AudioContext を閉じる)
// ============================================================================

/**
 * 停止時に復号の flush 待ちと破棄が完了することを確かめるための制御口
 */
interface SubscriberDrainControl extends SubscriberFrameControl {
  currentState: MediaSubscriberState;
  // 停止の drain の状態 (復号の停止と flush の復号待ちの残り)
  audioDecodeStopped: boolean;
  audioDecodeSubmitSequences: number[];
  audioDrainFlushedSequences: Set<number>;
  audioDrainFlushedDiscarded: number;
  discardPendingAudioDecodes: () => void;
}

/**
 * 完了条件: drain の flush 待ちは、flush した Object の復号出力だけを減らす。停止の前に
 * 復号器へ投入していた Object の出力では減らさない (drain が早く終わって末尾を切らないため)。
 */
test("handleAudioDecodedData: flush 由来の復号出力だけを drain の待ちから減らす", () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberDrainControl;
  const makeAudioData = (timestamp: number): AudioData =>
    ({
      numberOfChannels: 1,
      sampleRate: 48_000,
      numberOfFrames: 960,
      timestamp,
      copyTo: () => {},
      close: () => {},
    }) as unknown as AudioData;

  control.audioDecodeStopped = true;
  // 停止の前に復号へ渡した音 (通し番号 0) と、flush で復号へ渡した音 (通し番号 1)
  control.audioDecodeSubmitSequences.push(0, 1);
  control.audioDrainFlushedSequences.add(1);

  // 停止の前に投入していた Object の出力 (通し番号 0) では減らない
  control.handleAudioDecodedData({ data: makeAudioData(100_000) });
  assert.equal(control.audioDrainFlushedSequences.size, 1, "flush 分以外では減らさないこと");

  // flush した Object の出力 (通し番号 1) では減る
  control.handleAudioDecodedData({ data: makeAudioData(200_000) });
  assert.equal(control.audioDrainFlushedSequences.size, 0, "flush 分の出力で減ること");
});

/**
 * 完了条件: 復号器の作り直しで未処理の出力が捨てられたら、投入順の対応も捨てる。
 * 残すと以後の対応がずれ、drain が上限まで待って実際は再生済みの分を未復号と数える。
 */
test("discardPendingAudioDecodes: 復号器の作り直しで投入順の対応を捨てる", () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberDrainControl;
  control.audioDecodeSubmitSequences.push(0, 1);
  control.audioDrainFlushedSequences.add(1);

  control.discardPendingAudioDecodes();

  assert.equal(control.audioDecodeSubmitSequences.length, 0, "投入順を捨てること");
  assert.equal(control.audioDrainFlushedSequences.size, 0, "flush の待ちを残さないこと");
  assert.equal(control.audioDrainFlushedDiscarded, 1, "捨てた flush 分を数えること");
});

/**
 * 完了条件: 復号前の段から flush した Object の件数を drain の結果に残す。
 * 復号の出力が届かない場合は上限で打ち切る (停止が終わらないことはない)。
 */
test("stop: preDecodeDelayMs の保持分を flush し、drain の結果に件数を残す", async () => {
  const { subscriber, control } = createPreDecodeDelaySubscriber(2_000);
  control.receiveAudioObject(makeIdentifiedObject(0n, 0x11), "subgroup");
  control.receiveAudioObject(makeIdentifiedObject(1n, 0x22), "subgroup");
  control.currentState = "active";
  assert.equal(control.audioPreDecodeStage?.size, 2);

  const stopStartedAtMs = performance.now();
  await subscriber.stop();
  const waitedMs = performance.now() - stopStartedAtMs;

  const timing = subscriber.getStats().audio?.playoutTiming;
  assert.equal(timing?.lastDrain?.flushedObjects, 2, "flush した件数を残すこと");
  // 復号の出力を待つが、届かないため上限 (余裕の 100 ms) で打ち切る
  assert.isAtMost(waitedMs, 400, "復号の出力が無くても停止が長引かないこと");
});
