/**
 * MediaSubscriber の停止と終端のライフサイクルの単体テスト
 *
 * stop / close の解放と単発性、start の受け付けと失敗時の巻き戻し、
 * 解放が先行したときの中止を検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import { MediaSubscriberImpl } from "./createMediaSubscriber";

import {
  playoutAudioClockOf,
  playoutAudioInputMapOf,
  playoutAudioOf,
  playoutAudioTimingOf,
  playoutTimelineOf,
  playoutVideoInputMapOf,
} from "./testSupport/mediaPlayoutInternals";

import {
  AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS,
  AUDIO_PLAYOUT_DRAIN_MAX_MS,
} from "./playout/audioPlayoutSession";

import type { MediaConnectSettings } from "./createMedia/connect";

import type { Session } from "./session";

import type { Subscriber } from "./subscriber";

import type { MediaSubscriberCallbacks, MediaSubscriberState } from "./codec/types";

import { encodeCatalog } from "./msf";

import * as LOC from "./loc";
import { type MoqtObject } from "./dataStream";

import type { AuthorizationToken } from "./message";

import {
  useValueToken,
  waitForUnhandledRejectionDetection,
  withUnhandledRejectionWatch,
} from "./testSupport/helpers";

import {
  createTestSubscriber,
  makeCatalogObject,
  type SubscriberInitialConfigControl,
  makeIdentifiedObject,
  makeStreamVideoObject,
  createCatalogTestSession,
  makeVideoCatalog,
  sleep,
  AV_SYNC_TARGET_LATENCY_MS,
  wallClockTimestampMicrosOf,
  createTimestampedRecordingFrame,
  installAnimationFrameRecorder,
  restoreAnimationFrame,
  clearPendingAnimationFrame,
  type SubscriberLifecycleControl,
  createRecordingSubscriber,
  injectLifecycleResources,
  captureThrown,
  makeAudioTrackInfo,
  makeVideoTrackInfo,
  activateLifecycleControl,
} from "./testSupport/mediaSubscriberTestSupport";

// ============================================================================
// stop / close のライフサイクル（解放と再 start）
// ============================================================================

/**
 * 接続の完了を制御するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続の完了 (await の解決) をテストが
 * 決められるようにする。接続後の購読 / カタログ / 解放の扱いは実装のまま駆動する。
 */
interface SubscriberConnectControl {
  openSession(settings: MediaConnectSettings): Promise<Session>;
}

/**
 * 解放の順序の期待値
 *
 * 購読を止めてから復号器と出力を閉じ、音声の出力先を止めてから AudioContext を閉じ、
 * 最後に session を閉じる (順序が入れ替わると、閉じた相手へ書き込む窓ができる)。
 */
const LIFECYCLE_DISPOSAL_ORDER = [
  "catalogSubscriber.unsubscribe()",
  "audioSubscriber.unsubscribe()",
  "videoSubscriber.unsubscribe()",
  "audioDecoder.close()",
  "videoDecoder.close()",
  "videoWriter.close()",
  "videoTrackGenerator.stop()",
  "audioDestination.track.stop()",
  "audioContext.close()",
  "session.close()",
];

/**
 * 解放で初期値に戻ることを確認するため、実行時状態に停止前の値を入れる
 *
 * catalog の受信待ち (catalogResolve / catalogReject) と受信タイマーも初期値に戻る対象で
 * あり、値が残っていないことを見るためにここで入れる。受信待ちの打ち切り (await が
 * 解放で終わること) はここでは検証せず、別のテストが担う。
 */
function fillStopRuntimeState(control: SubscriberLifecycleControl): void {
  control.receivedCatalog = makeVideoCatalog();
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true };
  control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true };
  control.catalogResolve = () => {};
  control.catalogReject = () => {};
  control.catalogFetchInProgress = true;
  control.pendingCatalogObjects = [makeIdentifiedObject(0n, 0x01)];
  control.catalogFetchLastLocation = { group: 1n, object: 0n };
  // 解放で clearTimeout されるタイマー (取り残しを検出できるようにする)
  control.catalogTimer = setTimeout(() => {}, 1000);
  control.catalogReceiveFailed = true;
  control.audioDecoderConfigured = true;
  control.videoDecoderConfigured = true;
  control.lastAppliedVideoConfig = new Uint8Array([1]);
  control.lastAppliedAudioConfig = new Uint8Array([2]);
  // 前世代で復号した Object (解放で初期化しないと、再 start で同じ位置の
  // キーフレームを stale として捨ててしまう)
  control.videoDecodeOrder.admit({
    groupId: 5n,
    objectId: 0n,
    isKeyFrame: true,
    priorObjectIdGap: 0n,
  });
  // 前の AudioContext の時計の対応 (解放で消す。影響は AudioClockBridge.reset の
  // JSDoc を参照)。代用 (fallback) の印も一緒に消えることを見るため、対応なしで作る
  playoutAudioClockOf(control.playout).update(null, 12.5, 4_000);
}

// Context の生成、時計の初期化、resume の失敗通知は、ブラウザー API を差し替えず
// 実 Chrome の media-subscriber-audio-output.spec.ts で検証する。

/**
 * 完了条件: stop は close と同じ解放を行い、解放のあとに参照が残らず、
 * 参照を 1 回ずつ破棄する。state は "stopped" のままで onClose は呼ばない。
 * 再生の入口 (`MediaPlayout.clearAll`) が時間軸・復号へ渡した入力の対応表・映像の
 * 表示待ちを捨て、計器の累積と受信側の追いつきの観測を停止直後の統計として残すことも
 * 固定する。予約済みの音声の drain は通常の上限 (300 ms) で待つ。
 */
test("stop: 全参照を解放し unsubscribe と close を 1 回ずつ呼ぶ", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ audio: {}, video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  // stop は "active" からのみ呼べる
  control.currentState = "active";
  const counts = injectLifecycleResources(control);
  fillStopRuntimeState(control);
  control.audioStats.framesReceived = 7;
  control.videoStats.framesReceived = 9;

  // 計器の累積と受信側の追いつきの観測に値を入れ、時間軸・復号へ渡した入力の対応表・
  // 映像の表示待ちにも値を残す。音声の予約は未来に残し、drain が上限まで待つようにする
  const nowMs = performance.now();
  playoutAudioTimingOf(control.playout).recordPlay(nowMs, null, nowMs + 500, 200, "arrival");
  playoutAudioOf(control.playout).catchUp.observe({
    nowMs: 1_000,
    lagMs: 150,
    durationMs: 20,
    timestampMicros: 1_000_000,
  });
  const observedWallClockMs = performance.timeOrigin + performance.now();
  const timestampMicros = wallClockTimestampMicrosOf(observedWallClockMs);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, timestampMicros);
  control.playout.setTargetLatencyMs(AV_SYNC_TARGET_LATENCY_MS);
  control.playout.trackAudioDecodeInput(timestampMicros, { timestampKind: "wallClock" });
  control.playout.trackVideoDecodeInput(timestampMicros, {
    timestampKind: "wallClock",
    location: { group: 0n, object: 0n },
  });
  // 表示周期の予約 (requestAnimationFrame) とその取り消し (cancelAnimationFrame) は
  // node 環境に無いため、解放で予約を取り消すところまで差し替えて受ける
  installAnimationFrameRecorder();
  try {
    const { frame } = createTimestampedRecordingFrame(timestampMicros);
    control.playout.pushVideo(frame);
    assert.equal(
      control.playout.getStats().video?.queuedFrames,
      1,
      "停止前は映像の表示待ちに 1 枚あること",
    );
    // 積んだフレームは復号へ渡した入力の記録を 1 件引くため、対応表に記録を残し直す
    control.playout.trackVideoDecodeInput(timestampMicros + 1_000_000, {
      timestampKind: "wallClock",
      location: { group: 0n, object: 1n },
    });
    assert.equal(
      playoutAudioInputMapOf(control.playout).size,
      1,
      "停止前は音声の対応表に記録があること",
    );
    assert.equal(
      playoutVideoInputMapOf(control.playout).size,
      1,
      "停止前は映像の対応表に記録があること",
    );
    assert.isNotNull(
      playoutTimelineOf(control.playout).presentationDelayMs,
      "停止前は時間軸に観測があること",
    );

    await subscriber.stop();
  } finally {
    restoreAnimationFrame();
    clearPendingAnimationFrame();
  }

  // 参照が残らないこと
  assert.isNull(control.session);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.audioSubscriber);
  assert.isNull(control.videoSubscriber);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.videoDecoder);
  assert.isNull(control.videoWriter);
  assert.isNull(control.videoTrackGenerator);
  assert.isNull(control.audioOutput);
  assert.isNull(control.outputStream);
  // 破棄が 1 回ずつ呼ばれること
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.equal(counts.audioUnsubscribes, 1);
  assert.equal(counts.videoUnsubscribes, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.equal(counts.videoDecoderCloses, 1);
  assert.equal(counts.videoWriterCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.equal(counts.audioTrackStops, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.sessionCloses, 1);
  // 破棄の順序も固定する (購読 → 復号器 → 出力 → AudioContext → session)
  assert.deepEqual(counts.order, LIFECYCLE_DISPOSAL_ORDER);
  // 実行時状態が初期値に戻ること
  assert.isNull(control.receivedCatalog);
  assert.isNull(control.audioTrackInfo);
  assert.isNull(control.videoTrackInfo);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogReject);
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogTimer);
  assert.isFalse(control.catalogReceiveFailed);
  assert.isFalse(control.audioDecoderConfigured);
  assert.isFalse(control.videoDecoderConfigured);
  assert.isNull(control.lastAppliedVideoConfig);
  assert.isNull(control.lastAppliedAudioConfig);
  // AudioContext の時計の対応も初期値に戻ること
  // (対応を残す影響は AudioClockBridge.reset の JSDoc を参照)
  assert.isNull(playoutAudioClockOf(control.playout).currentOffsetMs);
  assert.isFalse(playoutAudioClockOf(control.playout).usingFallback);
  // 復号順の判定も初期化されること (前世代で復号した Object を引き継ぐと、再 start で
  // 同じ位置のキーフレームを stale として捨てる)
  assert.deepEqual(
    control.videoDecodeOrder.admit({
      groupId: 5n,
      objectId: 0n,
      isKeyFrame: true,
      priorObjectIdGap: 0n,
    }),
    { decode: true },
  );
  // 復号へ渡した入力の対応表・時間軸・映像の表示待ちが捨てられていること
  assert.equal(playoutAudioInputMapOf(control.playout).size, 0, "音声の対応表を捨てること");
  assert.equal(playoutVideoInputMapOf(control.playout).size, 0, "映像の対応表を捨てること");
  assert.isNull(playoutTimelineOf(control.playout).presentationDelayMs, "時間軸を捨てること");
  assert.equal(control.playout.getStats().video?.queuedFrames, 0, "映像の表示待ちを捨てること");
  // 予約済みの音声は drain の上限 (stop は 300 ms) で打ち切る
  assert.equal(
    subscriber.getStats().audio?.playoutTiming.lastDrain?.requestedMs,
    AUDIO_PLAYOUT_DRAIN_MAX_MS,
    "drain の上限は stop の 300 ms",
  );
  // 計器の累積と受信側の追いつきの観測は、停止直後の統計として残っていること
  assert.equal(
    subscriber.getStats().audio?.playoutTiming.playedFrames,
    1,
    "計器の累積 (鳴らした音の数) を残すこと",
  );
  assert.equal(
    subscriber.getStats().audio?.playoutTiming.playedMs,
    200,
    "計器の累積 (鳴らした長さ) を残すこと",
  );
  assert.equal(subscriber.getStats().audio?.playoutCatchUp.lagMs, 150, "追いつきの観測を残すこと");
  // 統計は再 start へ引き継ぐ
  const stats = subscriber.getStats();
  assert.equal(stats.audio?.framesReceived, 7);
  assert.equal(stats.video?.framesReceived, 9);
  // state は "stopped" のままで onClose は呼ばれないこと
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["stopped"]);
  assert.equal(closeCount(), 0);
});

/**
 * 完了条件: close は stop と同じ解放を行い、"closed" になったあとの start は拒否される。
 * 同じ解放 (disposeAllResources) の詳細と clearAll の表明は stop のテストが持つため、
 * ここでは close だけの差である drain の上限 (150 ms) と終端の振る舞いを固定する。
 */
test("close: stop と同じ解放を行い以後の start を拒否する", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ audio: {}, video: {} });
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control);
  fillStopRuntimeState(control);
  // 予約済みの音声を未来に残し、close の drain が短い上限で打ち切ることを見る
  const nowMs = performance.now();
  playoutAudioTimingOf(control.playout).recordPlay(nowMs, null, nowMs + 500, 200, "arrival");

  await subscriber.close();

  // stop と同じ解放が走ること (参照と実行時状態の詳細は stop のテストが持つ)
  assert.isNull(control.session);
  assert.equal(counts.sessionCloses, 1);
  // close の drain の上限は stop (300 ms) より短い 150 ms で、予約は打ち切られる
  const drain = subscriber.getStats().audio?.playoutTiming.lastDrain;
  assert.equal(drain?.requestedMs, AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS);
  assert.isAbove(drain?.cutMs ?? 0, 0, "上限で打ち切ったこと");
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount(), 1);

  // 終端後の start は拒否されること
  const thrown = await captureThrown(subscriber.start());
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "cannot start in state: closed");
  // 拒否では解放も通知も起きない
  assert.equal(counts.sessionCloses, 1);
  assert.equal(closeCount(), 1);

  // 二重 close は早期 return で単発のまま終わること
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 解放を catalog の購読解除で止める
 *
 * 解放 (disposeAllResources) は購読の解除から始まり await を挟む。解除の完了をテストが
 * 決められるようにして、close() の同期部分より後で解放の完了より前の窓を作る。この窓は
 * 「解放の途中に届いた Object」と「解放の途中に走った初期 configure の適用」を駆動する
 * ために使う (どちらも解放が decoder の参照を切る前に起きる)。
 *
 * @param control 制御口
 * @returns 解除を完了させて解放を先へ進める関数
 */
function holdDisposalAtCatalogUnsubscribe(control: SubscriberLifecycleControl): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 購読が確立している ("active") 購読だけが解除の対象になる
  control.catalogSubscriber = {
    state: "active",
    unsubscribe: () => held,
  } as unknown as Subscriber;
  return release;
}

/**
 * Track Property だけを持つ購読者を作る (初期 configure の検証用)
 *
 * SubscriberLifecycleControl と SubscriberInitialConfigControl を交差させた制御口では、
 * 購読者の trackProperties が Subscriber の ReadonlyArray と注入用の配列の両方として
 * 要求される。記録用の最小オブジェクトをこの形に整えて渡す (モジュール置換は行わない)。
 * trackProperties は getter にして読み取り回数を数える (閉じた後に初期 configure の適用が
 * Track Property を読まないことを検証できるようにする)。
 *
 * @param trackProperties 購読確立で受け取った Track Property
 * @returns subscriber は購読者、trackPropertyReads は trackProperties を読んだ回数
 */
function createTrackPropertySubscriber(trackProperties: { id: bigint; data?: Uint8Array }[]): {
  subscriber: Subscriber & { trackProperties: { id: bigint; data?: Uint8Array }[] };
  trackPropertyReads: () => number;
} {
  let reads = 0;
  const subscriber = {
    get trackProperties() {
      reads++;
      return trackProperties;
    },
  } as unknown as Subscriber & { trackProperties: { id: bigint; data?: Uint8Array }[] };
  return { subscriber, trackPropertyReads: () => reads };
}

/**
 * 完了条件: 映像の再構成 (VIDEO_CONFIG の変化) の完了前に close() した場合、
 * videoDecoderConfigured が true に戻らず lastAppliedVideoConfig も更新されない。
 *
 * 再構成は configure の await を挟む。解放も購読の解除などで await を挟むため、close() の
 * 同期部分で閉状態になった後に configure が成功し得る。configure の完了をテストが決め、
 * 解放が終わった後に成功させる。閉じた後に configure の結果で状態を戻すと、閉じた購読が
 * 「構成済み」に戻り、以降の Object が統計に数えられて復号へ渡る (復号は捨てられる)。
 */
test("close: 映像の再構成の完了が解放より後でも videoDecoderConfigured と lastAppliedVideoConfig を戻さない", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
  // configure の完了をテストが決める (解放の完了より後に成功させる)
  let completeConfigure: () => void = () => {};
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: () =>
      new Promise<void>((resolve) => {
        completeConfigure = resolve;
      }),
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  // close() が初期値に戻すことを見るため、適用済みの config を入れておく
  control.lastAppliedVideoConfig = new Uint8Array([1, 1]);

  // 直前と異なる VIDEO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.2.1)
  control.handleVideoObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0x11]),
    properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
  });
  // 再構成中は decode に渡さない
  assert.isFalse(control.videoDecoderConfigured);
  assert.deepEqual(decoded, []);

  // 同じタスクで close する (再構成は configure の await の途中)
  const closing = subscriber.close();
  // 閉状態は解放の await を待たず、close の同期部分で立つ
  assert.isTrue(control.closed);

  // 解放の完了後に configure が成功しても、構成済みと適用済み config は戻らない
  await closing;
  assert.isNull(control.lastAppliedVideoConfig);
  completeConfigure();
  await sleep(0);

  assert.isFalse(control.videoDecoderConfigured);
  assert.isNull(control.lastAppliedVideoConfig);
  assert.deepEqual(decoded, []);
  // 解放で decoder の参照も残らない
  assert.isNull(control.videoDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 音声の再構成 (AUDIO_CONFIG の変化) の完了前に close() した場合、
 * audioDecoderConfigured が true に戻らず lastAppliedAudioConfig も更新されない。
 * 映像と同じ経路を音声でも固定する。
 */
test("close: 音声の再構成の完了が解放より後でも audioDecoderConfigured と lastAppliedAudioConfig を戻さない", async () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  // configure の完了をテストが決める (解放の完了より後に成功させる)
  let completeConfigure: () => void = () => {};
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: () =>
      new Promise<void>((resolve) => {
        completeConfigure = resolve;
      }),
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  // close() が初期値に戻すことを見るため、適用済みの config を入れておく
  control.lastAppliedAudioConfig = new Uint8Array([1, 1]);

  // 直前と異なる AUDIO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.3.1)
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0x22]),
    properties: LOC.encodeAudioProperties({ timestamp: 0n, config: new Uint8Array([8, 8]) }),
  });
  assert.isFalse(control.audioDecoderConfigured);
  assert.deepEqual(decoded, []);

  const closing = subscriber.close();
  assert.isTrue(control.closed);

  await closing;
  assert.isNull(control.lastAppliedAudioConfig);
  completeConfigure();
  await sleep(0);

  assert.isFalse(control.audioDecoderConfigured);
  assert.isNull(control.lastAppliedAudioConfig);
  assert.deepEqual(decoded, []);
  assert.isNull(control.audioDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放の途中で待機中の configure が中止 (reject) しても onError を
 * 通知しない。映像と音声の両方で固定し、閉じていない購読では従来どおり通知することも見る。
 *
 * 実物の復号器は close() で世代を無効化し、待機中の configure を中止する (遅延成功した
 * 旧世代は破棄・reject される)。close() の解放は購読の解除から復号器の破棄まで await を
 * 挟むため、解放の途中で中止が届く。利用者が要求した終了に伴う中止は失敗ではないため
 * 通知しない。注入する復号器の close() が待機中の configure を reject させることで、
 * 実物の世代の無効化による中止を再現する (モジュール置換は行わない)。
 *
 * 中止が実際に起きたこと (aborts) と復号器が破棄されたこと (decoderCloses) を併せて
 * 確かめる。中止が起きなければ onError が 0 回でも通ってしまうためである。
 */
test("close: 解放の途中で configure が中止 (reject) しても onError を通知しない", async () => {
  // 映像: 解放中の復号器の破棄による configure の中止は通知しない
  {
    const errors: Error[] = [];
    const subscriber = createTestSubscriber(
      { video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    ).subscriber;
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.currentState = "active";
    control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
    // 待機中の configure を中止させる関数 (注入した復号器の close() が呼ぶ)。
    // 実物の復号器は close() で世代を無効化し、待機中の configure を reject する
    let configureCalls = 0;
    let aborts = 0;
    let decoderCloses = 0;
    let abortConfigure: (error: Error) => void = () => {};
    control.videoDecoder = {
      configure: () => {
        configureCalls++;
        return new Promise<void>((_resolve, reject) => {
          abortConfigure = (error) => {
            aborts++;
            reject(error);
          };
        });
      },
      decode: () => {},
      close: () => {
        decoderCloses++;
        abortConfigure(new Error("video decoder configure aborted by close"));
        abortConfigure = () => {};
      },
    };
    control.videoDecoderConfigured = true;
    control.lastAppliedVideoConfig = new Uint8Array([1, 1]);
    // 解放を catalog の購読解除で止め、復号器の破棄 (中止) の時機をテストが決める
    const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

    // 直前と異なる VIDEO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.2.1)
    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x11]),
      properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
    });
    // configure は待機中である (この後に close() して解放の途中で中止させる)
    assert.equal(configureCalls, 1);
    assert.isFalse(control.videoDecoderConfigured);

    const closing = subscriber.close();
    // 閉状態は解放の await を待たず close の同期部分で立つ
    assert.isTrue(control.closed);
    // 解放を進めると復号器が破棄され、待機中の configure が中止される
    releaseDisposal();
    await closing;
    await sleep(0);

    // 中止は起きており (中止が無ければこのテストは何も確かめていない)、復号器も破棄された
    assert.equal(aborts, 1);
    assert.equal(decoderCloses, 1);
    // 購読の終了に伴う中止は失敗として通知しない
    assert.equal(errors.length, 0);
    assert.isFalse(control.videoDecoderConfigured);
    assert.equal(subscriber.state, "closed");
  }

  // 音声: 同じ経路を音声でも固定する
  {
    const errors: Error[] = [];
    const subscriber = createTestSubscriber(
      { audio: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    ).subscriber;
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.currentState = "active";
    control.audioTrackInfo = makeAudioTrackInfo({
      codec: "opus",
      samplerate: 48_000,
      channelConfig: "2",
    });
    let configureCalls = 0;
    let aborts = 0;
    let decoderCloses = 0;
    let abortConfigure: (error: Error) => void = () => {};
    control.audioDecoder = {
      configure: () => {
        configureCalls++;
        return new Promise<void>((_resolve, reject) => {
          abortConfigure = (error) => {
            aborts++;
            reject(error);
          };
        });
      },
      decode: () => {},
      close: () => {
        decoderCloses++;
        abortConfigure(new Error("audio decoder configure aborted by close"));
        abortConfigure = () => {};
      },
    };
    control.audioDecoderConfigured = true;
    control.lastAppliedAudioConfig = new Uint8Array([1, 1]);
    const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

    // 直前と異なる AUDIO_CONFIG の Object で再構成を開始させる (draft-ietf-moq-loc-04 §2.3.3.1)
    control.handleAudioObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x22]),
      properties: LOC.encodeAudioProperties({ timestamp: 0n, config: new Uint8Array([8, 8]) }),
    });
    assert.equal(configureCalls, 1);
    assert.isFalse(control.audioDecoderConfigured);

    const closing = subscriber.close();
    assert.isTrue(control.closed);
    releaseDisposal();
    await closing;
    await sleep(0);

    assert.equal(aborts, 1);
    assert.equal(decoderCloses, 1);
    assert.equal(errors.length, 0);
    assert.isFalse(control.audioDecoderConfigured);
    assert.equal(subscriber.state, "closed");
  }

  // 対照: 閉じていない購読では同じ configure の中止 (失敗) が従来どおり onError へ 1 回届く
  {
    const errors: Error[] = [];
    const subscriber = createTestSubscriber(
      { video: {} },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    ).subscriber;
    const control = subscriber as unknown as SubscriberLifecycleControl &
      SubscriberInitialConfigControl;
    control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
    let abortConfigure: (error: Error) => void = () => {};
    control.videoDecoder = {
      configure: () =>
        new Promise<void>((_resolve, reject) => {
          abortConfigure = reject;
        }),
      decode: () => {},
      close: () => {},
    };
    control.videoDecoderConfigured = true;
    control.lastAppliedVideoConfig = new Uint8Array([1, 1]);

    control.handleVideoObject({
      groupId: 1n,
      objectId: 0n,
      status: 0,
      payload: new Uint8Array([0x33]),
      properties: LOC.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([9, 9]) }),
    });
    // 閉じていないため、configure の失敗は onError へ 1 回届く
    abortConfigure(new Error("video decoder configure failed"));
    await sleep(0);

    assert.equal(errors.length, 1);
    assert.isTrue((errors[0]?.message ?? "").includes("video decoder configure failed"));
    assert.isFalse(control.videoDecoderConfigured);
    assert.equal(subscriber.state, "created");
  }
});

/**
 * 完了条件: close() の解放の途中に届いた映像 Object は統計に数えず decode にも渡さない。
 *
 * 解放は購読の解除などで await を挟む。decoder の参照を切る前の窓では復号器の構成済み
 * フラグが true のままのため、閉状態の判定が無ければ先頭ガードを通り、統計を先に進めてから
 * decode を呼ぶ (復号は捨てられる)。映像は Group の保留にも入れない (閉じた購読では
 * 復号されず、保留の期限まで保持されるだけになる)。
 */
test("close: 解放の途中に届いた映像 Object は統計に数えず decode にも渡さない", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & { receiveVideoObject(obj: MoqtObject): void };
  control.currentState = "active";
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {},
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();
  // 解放の await の中 (decoder の参照を切る前) に届いた Object は捨てる
  control.receiveVideoObject(makeStreamVideoObject(1n, 0n));
  // 次の Group の Object も Group の保留に入れない
  control.receiveVideoObject(makeStreamVideoObject(2n, 0n));
  // ハンドラを直接駆動した場合 (保留の解放経路) も統計に数えない
  control.handleVideoObject(makeIdentifiedObject(1n, 0x66));

  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.equal(subscriber.getStats().video?.bytesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.isNull(control.videoGroupGate.holdDeadlineMs);

  releaseDisposal();
  await closing;
  assert.equal(subscriber.getStats().video?.framesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放の途中に届いた音声 Object も統計に数えず decode にも渡さない。
 * 音声は Group の保留が無いため、ハンドラ先頭の閉状態の判定だけで捨てる。
 */
test("close: 解放の途中に届いた音声 Object は統計に数えず decode にも渡さない", async () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl;
  control.currentState = "active";
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async () => {},
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();
  control.handleAudioObject(makeIdentifiedObject(0n, 0x33));

  assert.equal(subscriber.getStats().audio?.framesReceived, 0);
  assert.equal(subscriber.getStats().audio?.bytesReceived, 0);
  assert.deepEqual(decoded, []);

  releaseDisposal();
  await closing;
  assert.equal(subscriber.getStats().audio?.framesReceived, 0);
  assert.deepEqual(decoded, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の後に applyInitialVideoConfig が走っても configure を発行しない。
 *
 * 解放は await を挟むため、購読の確立 (session.subscribe) が close() の後に解決すると
 * 初期 configure の適用が閉じた後に走り得る。閉状態の判定が無ければ、decoder の参照が
 * まだ切れていない窓では configure を発行して復号器を作り直してしまう。保留分の解放は
 * 行い、復号はしない (閉じた後に decoder を作らない)。
 */
test("close: 閉じた後に applyInitialVideoConfig が走っても configure を発行しない", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      reconfigureVideoDecoder(description: Uint8Array): Promise<void>;
    };
  control.currentState = "active";
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
  let configureCount = 0;
  const decoded: number[] = [];
  control.videoDecoder = {
    configure: async () => {
      configureCount++;
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.videoDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();

  // 解放の途中 (decoder の参照がまだ切れていない) に購読確立後の初期 configure が走る
  const trackProperties = [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2, 3]) }];
  const { subscriber: trackSubscriber, trackPropertyReads } =
    createTrackPropertySubscriber(trackProperties);
  control.videoInitialConfigPending = true;
  control.videoSubscriber = trackSubscriber;
  // 保留中に届いた Object は解放で捨てる
  control.handleVideoObject(makeIdentifiedObject(0n, 0x44));
  await control.applyInitialVideoConfig();

  // Track Property を読まず configure も発行せず、保留分だけ解放する
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.videoInitialConfigPending);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.deepEqual(decoded, []);

  // 閉じた後に再構成そのものを呼んでも configure を発行しない (解放の途中で decoder の
  // 参照がまだ切れていないため、閉状態の判定だけが configure を止める)
  await control.reconfigureVideoDecoder(new Uint8Array([7, 7, 7]));
  assert.equal(configureCount, 0);
  assert.isNull(control.lastAppliedVideoConfig);

  releaseDisposal();
  await closing;

  // 解放の完了後に走った場合も Track Property を読まず configure を発行しない
  control.videoInitialConfigPending = true;
  control.videoSubscriber = trackSubscriber;
  await control.applyInitialVideoConfig();
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.videoInitialConfigPending);
  assert.equal(control.pendingVideoObjects.length, 0);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の後に applyInitialAudioConfig が走っても configure を発行しない。
 * 映像と同じ経路を音声でも固定する。
 */
test("close: 閉じた後に applyInitialAudioConfig が走っても configure を発行しない", async () => {
  const subscriber = createTestSubscriber({
    audio: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      reconfigureAudioDecoder(description: Uint8Array): Promise<void>;
    };
  control.currentState = "active";
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  let configureCount = 0;
  const decoded: number[] = [];
  control.audioDecoder = {
    configure: async () => {
      configureCount++;
    },
    decode: (payload) => {
      decoded.push(payload[0] ?? -1);
    },
    close: () => {},
  };
  control.audioDecoderConfigured = true;
  const releaseDisposal = holdDisposalAtCatalogUnsubscribe(control);

  const closing = subscriber.close();

  // 解放の途中 (decoder の参照がまだ切れていない) に購読確立後の初期 configure が走る
  const trackProperties = [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([4, 5, 6]) }];
  const { subscriber: trackSubscriber, trackPropertyReads } =
    createTrackPropertySubscriber(trackProperties);
  control.audioInitialConfigPending = true;
  control.audioSubscriber = trackSubscriber;
  control.handleAudioObject(makeIdentifiedObject(0n, 0x55));
  await control.applyInitialAudioConfig();

  // Track Property を読まず configure も発行せず、保留分だけ解放する
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.audioInitialConfigPending);
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.deepEqual(decoded, []);

  // 閉じた後に再構成そのものを呼んでも configure を発行しない (解放の途中で decoder の
  // 参照がまだ切れていないため、閉状態の判定だけが configure を止める)
  await control.reconfigureAudioDecoder(new Uint8Array([7, 7, 7]));
  assert.equal(configureCount, 0);
  assert.isNull(control.lastAppliedAudioConfig);

  releaseDisposal();
  await closing;

  // 解放の完了後に走った場合も Track Property を読まず configure を発行しない
  control.audioInitialConfigPending = true;
  control.audioSubscriber = trackSubscriber;
  await control.applyInitialAudioConfig();
  assert.equal(trackPropertyReads(), 0);
  assert.equal(configureCount, 0);
  assert.isFalse(control.audioInitialConfigPending);
  assert.equal(control.pendingAudioObjects.length, 0);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close() の解放が失敗して終端 ("closed") へ進まなかった場合、閉状態は
 * 復旧の手順 (state が "active" なら stop() を呼んでから start()) の start() の入口で戻る。
 *
 * 解放が失敗したときは state を変えないため、解放の最後の段階 (session の close) で
 * 失敗すると state は "active" のまま残る。この state では start() が cannot start in
 * state で拒否されるため、まず stop() を呼んで "stopped" にしてから再開する。参照は
 * 破棄の前に切り離しているため、stop() の解放は失敗した段階をやり直さず残りの段階だけで
 * 成功する。閉状態を残すと再開した購読がすべての Object と再構成を捨てて復号できなく
 * なるため、start() の入口で戻す。
 */
test("start: close の解放が失敗した後に stop を経て再開したら閉状態を戻す", async () => {
  const failure = new Error("session close failure");
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  control.currentState = "active";
  // 解放の最後の段階 (session の close) で失敗させ、終端へ進めない
  injectLifecycleResources(control, { sessionCloseError: failure });

  const thrown = await captureThrown(subscriber.close());
  assert.strictEqual(thrown, failure);
  // 解放が失敗したため終端へは進んでおらず state は "active" のままである (失敗時は
  // state を変えない) が、閉状態は立っている
  assert.equal(subscriber.state, "active");
  assert.isTrue(control.closed);

  // 復旧の手順: state が "active" のままなので、まず stop() で "stopped" にする。
  // 参照は破棄の前に切り離し済みであり、解放は失敗した段階をやり直さず成功する
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  // stop() は閉状態を戻さない (戻すのは再開の入口である start())
  assert.isTrue(control.closed);

  // 再開の入口で閉状態を戻す (接続は node 環境に WebTransport が無いため失敗させる)
  control.openSession = () => Promise.reject(new Error("connect failed"));
  let startThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    startThrown = error;
  }
  assert.instanceOf(startThrown, Error);
  assert.notMatch((startThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
  assert.isFalse(control.closed);
});

/**
 * 完了条件: stop は "active" 以外では cannot stop in state で throw する
 * ("stopped" での再 stop を含む)。
 */
test("stop: active 以外では cannot stop in state で throw する", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  // "active" 以外では解放も起きないこと
  for (const state of ["created", "subscribing", "stopped", "closed"] as const) {
    control.currentState = state;
    let thrown: unknown = null;
    try {
      await subscriber.stop();
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, `cannot stop in state: ${state}`);
  }
  assert.equal(counts.sessionCloses, 0);
  assert.equal(counts.catalogUnsubscribes, 0);

  // "active" からは停止できる
  control.currentState = "active";
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(counts.sessionCloses, 1);

  // "stopped" での再 stop は拒否され、解放をやり直さない
  let repeatThrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    repeatThrown = error;
  }
  assert.instanceOf(repeatThrown, Error);
  assert.equal((repeatThrown as Error).message, "cannot stop in state: stopped");
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: 解放が throw した場合、stop は state を変えず onClose も呼ばず、
 * 元のエラーを throw する。参照は切り離し済みで再試行できる。
 */
test("stop: 解放が失敗したら state と onClose を変えず元のエラーを throw し再試行できる", async () => {
  const failure = new Error("session close failure");
  const { subscriber, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  // 段階破棄の途中 (session の close) で失敗させる
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  const thrown = await captureThrown(subscriber.stop());

  // 元のエラーがそのまま伝わること
  assert.strictEqual(thrown, failure);
  // state は変わらず onClose も呼ばれないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  // 失敗した段階より後も破棄が続き、参照が残らないこと
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.isNull(control.session);

  // 参照は切り離し済みのため再試行できること
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount(), 0);
  // 参照が無いため session の close はやり直さない
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: 解放が成功していれば、終端遷移 ("stopped") で利用者の onStateChange が
 * throw しても stop は失敗しない。
 *
 * setState は state を代入してから onStateChange を呼ぶため、throw しても state は
 * "stopped" になり解放も完了している。通知の失敗を stop の失敗として返すと、解放は
 * 成功しているのに再試行を促す非対称な結果になる。
 */
test("stop: 終端遷移の onStateChange が throw しても stopped になり解放は成功として返る", async () => {
  const stateFailure = new Error("state change failure");
  const { subscriber, closeCount } = createTestSubscriber(
    { video: {} },
    {
      onStateChange: () => {
        throw stateFailure;
      },
    },
  );
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control);

  // throw せずに戻ること
  await subscriber.stop();

  // state は代入済みで "stopped" になり、解放も完了していること
  assert.equal(subscriber.state, "stopped");
  assert.equal(counts.sessionCloses, 1);
  assert.isNull(control.session);
  assert.isNull(control.audioOutput);
  assert.equal(closeCount(), 0);
});

/**
 * 完了条件: 解放は購読が確立している ("active") Subscriber だけを unsubscribe する。
 * stop の時点で MediaSubscriber は "active" であるため通常は確立済みだが、
 * start 失敗時の巻き戻しでは "subscribing" のまま購読が確立している場合がある。
 * その unsubscribe は購読側の状態機械の外にあるため試みず、参照だけ切り離す。
 */
test("stop: 購読が確立していない Subscriber は unsubscribe せず参照だけ切り離す", async () => {
  let unsubscribeCount = 0;
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = activateLifecycleControl(subscriber);
  // 購読確立前 ("subscribing") の Subscriber を注入する
  control.catalogSubscriber = {
    state: "subscribing",
    unsubscribe: async () => {
      unsubscribeCount++;
    },
  } as unknown as Subscriber;

  await subscriber.stop();

  // unsubscribe は呼ばず、参照は残さないこと
  assert.equal(unsubscribeCount, 0);
  assert.isNull(control.catalogSubscriber);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: 解放の段階失敗は後続を止めず、最後に最初の失敗を throw する。
 * 失敗の注入が最後の段階 (session) だけだと、失敗した段階より後がないため
 * 「後続を止めない」ことを検証できない。最初の段階 (catalog の unsubscribe) で
 * 失敗させ、後続の全段階が走ることを見る。
 */
test("stop: 最初の段階が失敗しても後続の解放を続け最初の失敗を throw する", async () => {
  const failure = new Error("catalog unsubscribe failure");
  const { subscriber, closeCount } = createTestSubscriber({ audio: {}, video: {} });
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control, { catalogUnsubscribeError: failure });

  const thrown = await captureThrown(subscriber.stop());

  // 最初の失敗がそのまま伝わること (後続の失敗ではない)
  assert.strictEqual(thrown, failure);
  // 最初の失敗より後の段階がすべて 1 回走ること
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.equal(counts.audioUnsubscribes, 1);
  assert.equal(counts.videoUnsubscribes, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.equal(counts.videoDecoderCloses, 1);
  assert.equal(counts.videoWriterCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.equal(counts.audioTrackStops, 1);
  assert.equal(counts.audioContextCloses, 1);
  assert.equal(counts.sessionCloses, 1);
  // 参照は切り離し済みで、state と onClose は変わらないこと
  assert.isNull(control.session);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.audioOutput);
  assert.isNull(control.outputStream);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
});

/**
 * 完了条件: 解放が throw した場合、close は state を変えず onClose も呼ばず、
 * 元のエラーを throw する。参照は切り離し済みで再試行できる。
 */
test("close: 解放が失敗したら state と onClose を変えず元のエラーを throw し再試行できる", async () => {
  const failure = new Error("session close failure");
  const { subscriber, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  const thrown = await captureThrown(subscriber.close());

  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  assert.isNull(control.session);

  // 再試行すると終端まで進むこと
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.equal(counts.sessionCloses, 1);
});

/**
 * 完了条件: "stopped" から start() を呼んでも state ガードで拒否されない。
 * node 環境には WebTransport が無いため接続で失敗し、失敗後は遷移前の
 * "stopped" に戻って再試行できる。
 */
test("start: stopped からは state ガードで拒否されず、失敗後は stopped に戻り再試行できる", async () => {
  const { subscriber, states, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  control.currentState = "stopped";
  // 失敗時の巻き戻しで解放が走ることを、確保済みの資源の破棄で確認する
  const counts = injectLifecycleResources(control);

  const thrown = await captureThrown(subscriber.start());

  assert.instanceOf(thrown, Error);
  // state ガードの拒否ではないこと (接続の失敗)
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 遷移前の "stopped" に戻り、再試行できること
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // 巻き戻しの解放が走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.catalogUnsubscribes, 1);
  assert.isNull(control.session);

  // 再試行も state ガードで拒否されないこと
  let retryThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    retryThrown = error;
  }
  assert.instanceOf(retryThrown, Error);
  assert.notMatch((retryThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: start が失敗したときは解放され、state は遷移前の "created" に戻る。
 */
test("start: 失敗したら遷移前の created に戻り再試行できる", async () => {
  const { subscriber, states, errors } = createTestSubscriber({ audio: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  const thrown = await captureThrown(subscriber.start());

  assert.instanceOf(thrown, Error);
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 遷移前の "created" に戻ること
  assert.equal(subscriber.state, "created");
  assert.deepEqual(states, ["subscribing", "created"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // 巻き戻しの解放が走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.audioDecoderCloses, 1);
  assert.isNull(control.outputStream);
  assert.isNull(control.receivedCatalog);

  // 再試行も state ガードで拒否されないこと
  let retryThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    retryThrown = error;
  }
  assert.instanceOf(retryThrown, Error);
  assert.notMatch((retryThrown as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "created");
});

/**
 * 完了条件: 失敗時の巻き戻しで利用者の onStateChange が throw しても、元のエラーを
 * throw し onError を通知する。
 *
 * setState は state を代入してから onStateChange を呼ぶため、throw しても state は
 * 遷移前に戻っている。巻き戻しの通知の失敗をそのまま通すと、呼び出し元が受け取るエラーが
 * すり替わり (接続の失敗が消える)、onError の通知にも到達しない。
 */
test("start: 巻き戻しの onStateChange が throw しても元のエラーを throw し onError を通知する", async () => {
  const stateFailure = new Error("state change failure");
  const states: MediaSubscriberState[] = [];
  const { subscriber, errors } = createTestSubscriber(
    { video: {} },
    {
      onStateChange: (state) => {
        states.push(state);
        // 巻き戻しの遷移 ("created") でだけ throw する (開始の遷移は通す)
        if (state === "created") {
          throw stateFailure;
        }
      },
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl;
  const counts = injectLifecycleResources(control);

  const thrown = await captureThrown(subscriber.start());

  // 接続の失敗 (元のエラー) がそのまま伝わること (巻き戻しの通知の失敗にすり替わらない)
  assert.instanceOf(thrown, Error);
  assert.notStrictEqual(thrown, stateFailure);
  assert.notMatch((thrown as Error).message, /cannot start in state/);
  // 元のエラーが onError で通知されること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  // state は代入済みで遷移前 ("created") に戻っていること
  assert.equal(subscriber.state, "created");
  assert.deepEqual(states, ["subscribing", "created"]);
  // 巻き戻しの解放も走っていること
  assert.equal(counts.sessionCloses, 1);
  assert.isNull(control.session);
});

/**
 * 完了条件: ピア起点の close が start の実行中 ("subscribing") に届いた場合、
 * "closed" が優先され、start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * start の成功パスは WebTransport と実 WebCodecs を要するため node では駆動できない。
 * 最後の await から戻った時点の処理 (finishStart) を直接駆動し、解放が先行した状態では
 * "active" にせず throw することを固定する。解放 (handleSessionClose) が完了していれば
 * state は "closed" であり、start の catch は state が "closed" のとき巻き戻さない。
 */
test("start: 解放が先行して最後の await から戻ったら active にせず closed を保つ", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    finishStart(startGeneration: number): void;
  };
  // start が "subscribing" になったあとを再現する
  control.currentState = "subscribing";
  const counts = injectLifecycleResources(control);
  // start の開始時に捕捉する世代番号
  const startGeneration = control.sessionGeneration;

  // 最後の await の間にピア起点の close が届き、解放が完了した状態を作る
  await control.handleSessionClose(startGeneration);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);

  // 最後の await から戻った start は "active" にしないこと
  let thrown: unknown = null;
  try {
    control.finishStart(startGeneration);
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放は先行済みで "closed" が保たれること (巻き戻しの余地が無い)
  assert.equal(subscriber.state, "closed");
  assert.equal(counts.sessionCloses, 1);
  assert.deepEqual(states, ["closed"]);

  // 解放が先行していなければ同じ経路で "active" になること
  control.currentState = "subscribing";
  control.finishStart(control.sessionGeneration);
  assert.equal(subscriber.state, "active");
});

/**
 * 完了条件: ピア起点の close が start の実行中に届いた場合、"closed" が優先され、
 * start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * 解放の完了を待たずに start が失敗する場合 (解放が session の close で止まっている間) の
 * 巻き戻しは、終端 ("closed") へ進んでいなければ遷移前の state に戻す。"subscribing" の
 * まま取り残すと start も stop も拒否されて close 以外の出口が無くなるためである。
 * あとから解放を終えたピア起点の経路が "closed" と onClose を決めるため、巻き戻しは
 * 終端の単発性を崩さない。start の接続そのものは node では駆動できないため、接続の失敗で
 * start を終わらせる。start の catch は世代番号で解放の先行を判定するため、start の開始後に
 * 解放を始めて世代番号を進める。
 *
 * 巻き戻しのあとに利用者が再開した start は、解放の時点で世代番号が既に進んでいるため、
 * 解放の有無だけでは終端を跨いだことを判定できない。終端 ("closed") も中止の条件に
 * 入れ、"closed" のあとに "active" へ戻さない (戻すと onClose のあとに受信が続く)。
 */
test("start: 解放が進行中でも失敗時の巻き戻しで遷移前の state に戻り終端は closed になる", async () => {
  const { subscriber, states, errors, closeCount } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    finishStart(startGeneration: number): void;
  };
  // 停止後 ("stopped") を再現し、start の遷移前の state を "stopped" にする
  control.currentState = "stopped";
  injectLifecycleResources(control);
  // 解放が session の close で止まるようにして、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);
  // この session の close 通知が捕捉する世代番号
  const generation = control.sessionGeneration;

  // start を開始する (同期部分で "subscribing" になり、接続の失敗を待つ)
  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");
  // 接続の失敗が解決する前に、ピア起点の close の解放を開始する (世代番号が進む)
  const closing = control.handleSessionClose(generation);
  await blocked.started;
  // 解放は session の close で止まっており、まだ "closed" になっていないこと。
  // start の失敗の巻き戻しは解放を待たずに進むため、state は既に遷移前へ戻り得る
  assert.notEqual(subscriber.state, "closed");
  assert.equal(closeCount(), 0);

  // この間に start が失敗したら、巻き戻しで遷移前の "stopped" に戻ること
  // ("subscribing" に固定すると start も stop も拒否されて出口が無くなる)
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);
  assert.equal(closeCount(), 0);

  // 巻き戻しのあとに利用者が再開した start を再現する (接続は node では駆動できないため、
  // "subscribing" への遷移と開始時の世代番号の捕捉だけを行う)
  control.currentState = "subscribing";
  const restartedGeneration = control.sessionGeneration;

  // 解放を終わらせるとピア起点の close として "closed" と onClose になること
  // (巻き戻しで戻した state はこの終端遷移で上書きされる)
  blocked.release();
  await closing;
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["subscribing", "stopped", "closed"]);

  // 再開した start の世代番号は解放の時点で既に進んでいるため、解放の検査だけでは終端を
  // 跨いだことを判定できない。終端 ("closed") を検査して "active" へ戻さないこと
  // (start の成功パスは node では駆動できないため、最後の await から戻った時点の処理
  //  (finishStart) を直接駆動する)
  let restartThrown: unknown = null;
  try {
    control.finishStart(restartedGeneration);
  } catch (error) {
    restartThrown = error;
  }
  assert.instanceOf(restartThrown, Error);
  assert.equal(
    (restartThrown as Error).message,
    "start aborted: resources were disposed during start",
  );
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 接続 1 回分の観測口
 */
interface OpenedSubscriberConnection {
  // 実装が onSessionClose に渡した閉包 (接続時点の世代番号を捕捉している)
  notifyClose: () => void;
  // 保留している購読要求 (session.subscribe) が呼ばれた時点で解決する
  subscribing: () => Promise<void>;
  // 保留している購読要求の await を解放する (保留していない場合は何もしない)
  resolveSubscribe: () => void;
  // 保留している session の close が呼ばれた時点で解決する (解放がそこで止まったことの観測)
  sessionClosing: () => Promise<void>;
  // 保留している session の close の await を解放する (保留していない場合は何もしない)
  resolveSessionClose: () => void;
  // この接続の session の close が呼ばれた回数 (解放が session を閉じたか)
  sessionCloseCalls: () => number;
  // 確立した購読の unsubscribe が呼ばれた回数 (start の巻き戻しが解放したか)
  unsubscribeCalls: () => number;
}

/**
 * 接続を差し替えて start() を段階ごとに駆動するための制御口
 *
 * connectToServer は WebTransport を要する接続を openSession 越しに行う。node 環境には
 * WebTransport が無いため、この境界だけを置き換えて接続と購読の完了をテストが決められる
 * ようにする (モジュール置換は行わない)。接続ごとに実装が作る onSessionClose の閉包を
 * そのまま捕捉し、ピア起点の close の解放も駆動できるようにする。カタログの購読は
 * 確立した記録付きの Subscriber を返す。
 *
 * @param callbacks 検証に使うコールバック (onError は呼び出しの記録に使う)
 * @param options holdSubscribe を立てるとカタログの購読 (session.subscribe) の await を
 *   テストが解放するまで保留する (解放が start の await に重なる窓を作る)。
 *   holdSessionClose を立てると session の close の await もテストが解放するまで保留する
 *   (解放が session の close で止まる窓を作る。解放は参照を切り離してから close するため、
 *   止めている間も state は遷移前のままである)。connectFailure を渡すと 2 回目以降の接続を
 *   そのエラーで失敗させる (入口の拒否が外れたときにテストが接続の待ちで止まらないようにする)
 */
function createStartConnectHarness(
  callbacks: MediaSubscriberCallbacks = {},
  options: {
    holdSubscribe?: boolean;
    holdSessionClose?: boolean;
    connectFailure?: Error;
  } = {},
): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberLifecycleControl & SubscriberConnectControl;
  errors: Error[];
  opened: OpenedSubscriberConnection[];
  connectAttempts: () => number;
} {
  const { subscriber, errors } = createTestSubscriber(
    { video: {} },
    {
      ...callbacks,
    },
  );
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  const opened: OpenedSubscriberConnection[] = [];
  let connectAttempts = 0;
  control.openSession = (settings: MediaConnectSettings) => {
    connectAttempts++;
    // 2 回目以降の接続はテストが決めたエラーで失敗させる (入口の拒否を外したときの観測)
    if (options.connectFailure !== undefined && opened.length > 0) {
      return Promise.reject(options.connectFailure);
    }
    let notifySubscribing: () => void = () => {};
    const subscribing = new Promise<void>((resolve) => {
      notifySubscribing = resolve;
    });
    let releaseSubscribe: () => void = () => {};
    const subscribeGate = options.holdSubscribe
      ? new Promise<void>((resolve) => {
          releaseSubscribe = resolve;
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
    let unsubscribeCalls = 0;
    const session = {
      subscribe: async (): Promise<Subscriber> => {
        // 保留する購読だけテストが完了を決める
        if (subscribeGate !== null) {
          notifySubscribing();
          await subscribeGate;
        }
        return createRecordingSubscriber(() => {
          unsubscribeCalls++;
        });
      },
      fetch: () => {
        // 解放の検査を通らずに FETCH へ進んだ場合に、黙って進まないよう失敗させる
        throw new Error("must not fetch");
      },
      close: async () => {
        sessionCloseCalls++;
        notifySessionClosing();
        if (sessionCloseGate !== null) {
          await sessionCloseGate;
        }
      },
    } as unknown as Session;
    opened.push({
      notifyClose: () => settings.onSessionClose(),
      subscribing: () => subscribing,
      resolveSubscribe: () => releaseSubscribe(),
      sessionClosing: () => sessionClosing,
      resolveSessionClose: () => releaseSessionClose(),
      sessionCloseCalls: () => sessionCloseCalls,
      unsubscribeCalls: () => unsubscribeCalls,
    });
    return Promise.resolve(session);
  };
  return { subscriber, control, errors, opened, connectAttempts: () => connectAttempts };
}

/**
 * 完了条件: ピア起点の close の解放が進行中のまま利用者が start() を呼び直すと、
 * 入口で cannot start while closing により拒否される。
 *
 * 解放 (disposeAllResources) は世代番号を進める。解放が終端 ("closed") へ進む前に開始を
 * 許すと、開始が捕捉する世代番号は解放が進めた現在値と一致するため段階の検査をすべて通過し、
 * "active" になったあとの解放の終端遷移で state が "closed" になり、開始した購読 / デコーダ /
 * 出力 / session を解放する経路が消える (close() は早期 return、start() / stop() は state で
 * 拒否される)。入口で解放の進行を見て拒否することを固定する。
 *
 * 駆動する順序は次のとおりである。
 * 1. start #1 がカタログの購読 (session.subscribe) の await で止まっている間にピア起点の
 *    close が届き、解放 D1 が session の close で止まる (世代番号は解放の先頭で進む)
 * 2. start #1 は段階の検査で中止し、失敗時の巻き戻し D2 が D1 を待たずに終わって失敗が
 *    確定する (state は開始前の "created" に戻る)
 * 3. 利用者は start #1 の失敗を待ってから直列に start #2 を呼ぶ。state は "created" で
 *    あるため state ガードを通過し、捕捉する世代番号は D1 が進めた現在値と一致する
 * 4. D1 を終わらせると state は "closed" になり onClose が 1 回通知される
 * 5. そのあとに呼び直した start は終端の state により拒否される
 */
test("start: ピア起点の close の解放が進行中のまま呼び直すと入口で拒否される", async () => {
  const states: MediaSubscriberState[] = [];
  let closeCount = 0;
  const { subscriber, control, errors, opened, connectAttempts } = createStartConnectHarness(
    {
      onStateChange: (state) => {
        states.push(state);
      },
      onClose: () => {
        closeCount++;
      },
    },
    // カタログの購読と session の close の両方をテストが解放する (2 つの窓を作る)。
    // 入口の拒否が外れたときに接続の待ちで止まらないよう、2 回目の接続は失敗させる
    { holdSubscribe: true, holdSessionClose: true, connectFailure: new Error("connect failed") },
  );

  await withUnhandledRejectionWatch(async (unhandled) => {
    // 1. start #1 をカタログの購読の await で止める
    const firstStart = subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    await opened[0].subscribing();
    assert.equal(subscriber.state, "subscribing");
    assert.isNotNull(control.session);

    // ピア起点の close の解放 D1 を始め、session の close で止める
    opened[0].notifyClose();
    await opened[0].sessionClosing();
    // D1 は session の参照を切り離してから close を待つ (解放はまだ進行中である)
    assert.isNull(control.session);
    assert.equal(opened[0].sessionCloseCalls(), 1);
    assert.equal(subscriber.state, "subscribing");
    assert.equal(closeCount, 0);

    // 2. start #1 を再開させると段階の検査が中止し、巻き戻し D2 が先に終わって失敗が確定する
    opened[0].resolveSubscribe();
    const firstFailure = await firstStart;
    assert.instanceOf(firstFailure, Error);
    assert.equal(
      (firstFailure as Error).message,
      "start aborted: resources were disposed during start",
    );
    // D2 は切り離し済みの session を触らない (close は D1 の 1 回だけ)
    assert.equal(opened[0].sessionCloseCalls(), 1);
    // D2 は中止までに確立した購読を解除する
    assert.equal(opened[0].unsubscribeCalls(), 1);
    // 解放はまだ終端へ進んでおらず、state のガードは通過できる状態である
    assert.equal(subscriber.state, "created");
    assert.deepEqual(states, ["subscribing", "created"]);
    assert.equal(closeCount, 0);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], firstFailure);

    // 3. 直列に start #2 を呼ぶ。解放 (D1) が進行中であるため、開始の入口で拒否される
    // (解放が終端へ進む前に開始を許すと、開始した資源を解放する経路が残らない)
    const secondFailure = await subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.instanceOf(secondFailure, Error);
    assert.equal((secondFailure as Error).message, "cannot start while closing");
    // 接続も購読も試みないこと (入口で止まる)
    assert.equal(connectAttempts(), 1);
    assert.equal(subscriber.state, "created");
    assert.deepEqual(states, ["subscribing", "created"]);

    // 4. D1 を終わらせると終端 ("closed") と onClose が 1 回だけ通知される
    opened[0].resolveSessionClose();
    await sleep(0);
    assert.equal(subscriber.state, "closed");
    assert.equal(closeCount, 1);
    assert.deepEqual(states, ["subscribing", "created", "closed"]);

    // 5. 解放が終わったあとに呼び直しても、終端 ("closed") を跨ぐため拒否されること
    const thirdFailure = await subscriber.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.instanceOf(thirdFailure, Error);
    assert.equal((thirdFailure as Error).message, "cannot start in state: closed");
    assert.equal(connectAttempts(), 1);
    // "active" へ進んでいないこと (onClose のあとに state が動かない)
    assert.equal(subscriber.state, "closed");
    assert.equal(closeCount, 1);
    assert.deepEqual(states, ["subscribing", "created", "closed"]);
    // 入口の拒否は start の catch を通らないため onError は増えない (通知は start #1 の 1 回だけ)
    assert.equal(errors.length, 1);

    // 解放と中止が重なっても未処理の rejection を残さないこと
    await waitForUnhandledRejectionDetection();
    assert.equal(unhandled.length, 0);
  });
});

/**
 * 完了条件: 解放が進行していない正規の start() (stop のあとの再開) は入口で拒否されない。
 *
 * 入口の検査は解放の進行 (disposalInFlight) だけを見る。stop() の解放が終われば解放の
 * Promise は外れるため、"stopped" からの再開は通常どおり開始できなければならない
 * (拒否すると停止した購読を再開する経路が消える)。stop は注入した資源の解放まで実際に
 * 走らせ、接続の境界だけを置き換えて再開が "subscribing" へ進むことを固定する。
 */
test("start: stop の解放が終わったあとの再開は入口の拒否を受けない", async () => {
  const { subscriber, states, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // stop は "active" からのみ呼べる
  control.currentState = "active";
  injectLifecycleResources(control);

  // stop で解放が実際に走り、進行中の解放が残らないこと
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.isNull(control.session);

  // 接続の完了をテストが決める (解決するまで connectToServer は await のまま)
  let connectCalls = 0;
  let completeConnect: (session: Session) => void = () => {};
  control.openSession = () => {
    connectCalls++;
    return new Promise<Session>((resolve) => {
      completeConnect = resolve;
    });
  };

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  // 入口の拒否 (cannot start while closing) を通過して "subscribing" へ進むこと
  assert.equal(subscriber.state, "subscribing");
  assert.equal(connectCalls, 1);

  // 接続待ちの間に close を完了させ、開始は解放の検査で中止させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  const sessionCalls: string[] = [];
  completeConnect({
    subscribe: async () => {
      sessionCalls.push("subscribe");
      throw new Error("must not subscribe");
    },
    close: async () => {
      sessionCalls.push("session.close()");
    },
  } as unknown as Session);

  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  // 解放の検査で中止し、接続で受け取った session はその場で閉じること
  assert.deepEqual(sessionCalls, ["session.close()"]);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.deepEqual(states, ["stopped", "subscribing", "closed"]);
});

/**
 * 完了条件: ピア起点の close 通知の経路で解放が失敗したとき、その通知 (onError) が throw
 * しても onError を二重に呼ばない。
 *
 * 通知の失敗がこの経路の promise の reject として伝わると、接続側の回収 (connectToServer が
 * 同じ失敗をもう一度 onError へ流す) が 2 回目の通知になる。通知の失敗はこの経路では
 * 握り潰し、解放の失敗の通知を 1 回だけにする。
 */
test("handleSessionClose: 解放の失敗通知が throw しても onError を二重に呼ばない", async () => {
  const failure = new Error("session close failure");
  const notificationFailure = new Error("onError failure");
  let onErrorCalls = 0;
  const subscriber = createTestSubscriber(
    { video: {} },
    {
      onError: () => {
        onErrorCalls++;
        throw notificationFailure;
      },
    },
  ).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 接続を成功させて session の close 通知のコールバックを捕捉する。購読は解決させず、
  // start を "subscribing" に保って世代番号を進めない (通知を直接駆動できるようにする)
  let notifyClose: () => void = () => {};
  control.openSession = async (settings: MediaConnectSettings) => {
    notifyClose = () => settings.onSessionClose();
    return {
      subscribe: () => new Promise<Subscriber>(() => {}),
      close: async () => {},
    } as unknown as Session;
  };
  // start は購読の確立で止まるため、結果は待たない
  void subscriber.start().catch(() => {});
  await sleep(0);
  assert.isNotNull(control.session);
  assert.equal(subscriber.state, "subscribing");
  // 解放を session の close で失敗させる
  injectLifecycleResources(control, { sessionCloseError: failure });

  // ピア起点の close 通知を駆動する
  notifyClose();
  await sleep(0);

  // 解放の失敗の通知は 1 回だけで、通知の失敗が回収経路をもう一度呼ばないこと
  assert.equal(onErrorCalls, 1);
  assert.equal(subscriber.state, "subscribing");
  assert.isNull(control.session);
});

/**
 * 完了条件: 解放のあとに届いた session close 通知では state と onClose が変わらない。
 * 新しい session を確立したあとに旧 session の通知が届いた場合も無視される。
 * 通知の処理 (handleSessionClose) を世代番号を与えて直接駆動する。
 *
 * 再 start の接続 (connectToServer の世代番号の捕捉) は node では駆動できないため、
 * 新しい session の確立は資源の注入と stop で再現し、世代番号は実装と同じ経路
 * (解放) で進める。
 */
test("handleSessionClose: 解放のあとに届いた通知では state と onClose が変わらない", async () => {
  const { subscriber, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control);
  // 旧 session が connectToServer で捕捉した世代番号
  const oldGeneration = control.sessionGeneration;

  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 1);

  // 解放のあとに届いた旧 session の通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount(), 0);
  // 解放の再実行も起きないこと (参照は既に切り離し済み)
  assert.equal(counts.sessionCloses, 1);

  // 新しい session を確立したあとに旧 session の通知が届く場合も同じこと。
  // 新しい session は接続時に現在の世代番号を捕捉するため、旧 session の捕捉値とは
  // 一致しない。ここでは新しい session の資源を注入して再度 stop し、世代番号を
  // もう 1 つ進める (再 start の接続が捕捉する値が現世代になる)
  control.currentState = "active";
  const nextCounts = injectLifecycleResources(control);
  await subscriber.stop();
  assert.equal(subscriber.state, "stopped");
  assert.equal(control.sessionGeneration, oldGeneration + 2);
  assert.equal(nextCounts.sessionCloses, 1);

  // 旧 session (2 世代前) の遅延通知は捨てられること
  await control.handleSessionClose(oldGeneration);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount(), 0);
  assert.equal(nextCounts.sessionCloses, 1);

  // 現世代の通知 (新しい session のピア起点の close) は扱われること
  await control.handleSessionClose(control.sessionGeneration);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close 通知の経路で解放が throw した場合、state は変わらず
 * エラーがログ (onError) に出て、close() で回収できる。
 */
test("handleSessionClose: 解放が失敗したら state を変えずエラーを通知し close で回収できる", async () => {
  const failure = new Error("session close failure");
  const { subscriber, errors, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control, { sessionCloseError: failure });

  await control.handleSessionClose(control.sessionGeneration);

  // state は変わらず onClose も呼ばないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  // 解放の失敗は onError で通知されること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], failure);
  // 失敗した段階より後も破棄が続き、参照が残らないこと
  assert.equal(counts.sessionCloses, 1);
  assert.equal(counts.videoTrackStops, 1);
  assert.isNull(control.session);

  // close() で回収できること (参照は切り離し済みで再試行できる)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close 通知 (世代番号が一致する通知) では解放が走ってから
 * "closed" と onClose になり、"closed" のまま解放されない経路が残らない。
 *
 * 解放の全段階が 1 回ずつ走ることは stop のテストが検証する。ここでは順序の検証に
 * 必要な範囲として、onClose が呼ばれた時点で解放対象の参照が切り離し済みであること
 * (解放してから通知していること) に絞る。
 */
test("handleSessionClose: 世代が一致する通知では解放してから closed と onClose になる", async () => {
  let closeCount = 0;
  // onClose の中で見た状態 (解放済みの参照と state) を記録する
  const atClose: string[] = [];
  const { subscriber, states } = createTestSubscriber(
    { audio: {}, video: {} },
    {
      onClose: () => {
        closeCount++;
        // onClose の時点の参照をその場で読み直し、解放が先行していることを確かめる
        const inside = subscriber as unknown as SubscriberLifecycleControl;
        atClose.push(
          `state:${inside.currentState}`,
          inside.session === null ? "session:null" : "session:present",
          inside.catalogSubscriber === null
            ? "catalogSubscriber:null"
            : "catalogSubscriber:present",
          inside.audioOutput === null ? "audioOutput:null" : "audioOutput:present",
          inside.outputStream === null ? "outputStream:null" : "outputStream:present",
        );
      },
    },
  );
  const control = activateLifecycleControl(subscriber);
  const counts = injectLifecycleResources(control);

  await control.handleSessionClose(control.sessionGeneration);

  // 解放が 1 回走ってから "closed" と onClose になること
  assert.equal(counts.sessionCloses, 1);
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["closed"]);
  assert.equal(closeCount, 1);
  // onClose の時点で参照が切り離し済みであること ("closed" を先に立てて解放を
  // 取り残す経路が無い)
  assert.deepEqual(atClose, [
    "state:closed",
    "session:null",
    "catalogSubscriber:null",
    "audioOutput:null",
    "outputStream:null",
  ]);
});

/**
 * ピア起点の close の解放を session の close で止め、解放が進行中の窓を作る
 *
 * 解放は session を切り離してから close を await するため、止めている間も state は
 * "active" のままである (利用者の stop() / close() が入り込める窓になる)。
 *
 * @param control 駆動する MediaSubscriber
 * @param hooks sessionCloseError を渡すと、止めていた解放を再開したときに session の
 *   close をそのエラーで失敗させる (解放の成否が相乗りした呼び出しへ伝わることの検証に使う)
 * @returns 解放を再開する関数と呼び出し回数、解放の開始を待つ Promise
 */
function startBlockedSessionClose(
  control: SubscriberLifecycleControl,
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
 * 完了条件: stop のあと state が "stopped" のままで、ピア起点の close で "closed" に
 * 化けない。ピア起点の close の解放中に利用者の stop() が重なった場合、解放中は state が
 * "active" のままであるため stop() は通り (進行中の解放を共有して完了を待つ)、あとから
 * 解放を終えたピア起点の経路が state と onClose を動かしてはならない。
 */
test("stop: ピア起点の close の解放中に呼ぶと stopped のままで onClose を通知しない", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);
  // この session の close 通知が捕捉する世代番号
  const generation = control.sessionGeneration;

  // ピア起点の close の解放を開始する (解放が止まっている間も state は "active")
  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の窓で利用者が stop() を呼ぶ ("stopped" を決めるのはこちら)。
  // stop() は進行中の解放を共有するため、解放が終わるまで戻らない
  const stopping = subscriber.stop();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  // session の close が stop からやり直されていないこと (参照は切り離し済み)
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると stop が "stopped" にし、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(subscriber.state, "stopped");
  assert.equal(closeCount(), 0);
  assert.deepEqual(states, ["stopped"]);
});

/**
 * 完了条件: ピア起点の close の解放中に利用者の close() が重なっても onClose は 1 回だけ
 * 通知される。state を見た判定では、解放中は "active" のままであるため両方の経路が
 * 終端通知に到達してしまう。close() は進行中の解放を共有して完了を待つ。
 */
test("close: ピア起点の close の解放中に呼んでも onClose は 1 回だけ通知される", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);
  const generation = control.sessionGeneration;

  const closing = control.handleSessionClose(generation);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の窓で利用者が close() を呼ぶ (終端の通知はこちらが行う)。解放が終わるまで
  // 終端へは進まない
  const closingByUser = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  assert.equal(blocked.closeCalls(), 1);

  // 解放を終えると close() が終端まで進み、ピア起点の経路は state も onClose も動かさない
  blocked.release();
  await Promise.all([closingByUser, closing]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: 解放を共有する 2 つのピア起点の close 通知が重なっても、終端の遷移と
 * onClose の通知は 1 回だけになる。
 *
 * 1 つ目の通知の解放が session の close で止まっている間に、新しい session の close 通知
 * (再試行した start が確立した session の世代) が届くと、2 つ目の通知は進行中の解放を共有
 * して待つ。解放が終わると両方の通知が終端へ進もうとするため、state を見た終端判定が
 * 無いと "closed" と onClose が 2 回目通知される。
 */
test("handleSessionClose: 解放を共有する 2 つの通知でも終端遷移と onClose は 1 回になる", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  // 1 つ目の通知の解放を session の close で止め、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);

  const first = control.handleSessionClose(control.sessionGeneration);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放が進行中の間に、新しい session の close 通知が届く (解放は共有される)
  control.session = { close: async () => {} } as unknown as Session;
  const second = control.handleSessionClose(control.sessionGeneration);
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);

  // 解放を終わらせると、終端の遷移と onClose は 1 回だけになること
  blocked.release();
  await Promise.all([first, second]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
  assert.equal(blocked.closeCalls(), 1);
});

/**
 * 完了条件: close() を await せずに重ねて呼んでも、解放は 1 回で onClose と
 * onStateChange("closed") は 1 回だけ通知される。
 *
 * 単発性を state だけで判定すると、解放 (disposeAllResources) の await を挟む間に
 * 2 回目の close() が早期 return を通過し、終端遷移と onClose が二重になる。
 * 解放の Promise を共有し、単発性を「呼び出し回数」ではなく「解放の実行回数」に
 * 結び付けていることを、解放を session の close で止めて固定する。
 */
test("close: await せず重ねて呼んでも解放と終端通知は 1 回だけになる", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  // 解放を session の close で止め、2 回目の close() が入り込める窓を作る
  const blocked = startBlockedSessionClose(control);

  // await せずに 2 回呼ぶ (1 回目が解放の await で止まっている間に 2 回目が走る)
  const first = subscriber.close();
  const second = subscriber.close();
  await blocked.started;
  // 解放は 1 回だけ開始され、まだ終端通知は出ていないこと
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(closeCount(), 0);

  blocked.release();
  await Promise.all([first, second]);

  // 解放も終端遷移も onClose も 1 回だけであること
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["closed"]);
});

/**
 * 完了条件: 終端遷移 (setState) が throw しても onClose を通知する。
 *
 * setState は利用者の onStateChange を呼ぶため throw し得る。state だけ "closed" に
 * 固定されると close() は早期 return するため、通知の回収経路が消える。終端遷移と
 * onClose を対にして、onClose を取り落とさない。
 */
test("handleSessionClose: onStateChange が throw しても onClose を通知する", async () => {
  const failure = new Error("state change failure");
  const { subscriber, closeCount } = createTestSubscriber(
    { video: {} },
    {
      onStateChange: () => {
        throw failure;
      },
    },
  );
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);

  const thrown = await captureThrown(control.handleSessionClose(control.sessionGeneration));

  // onStateChange の失敗は伝わるが、onClose は通知されること
  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);

  // "closed" のあとの close() は早期 return であり、onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: close でも終端遷移 (setState) が throw したときに onClose を通知する。
 * 通知の回収経路が close() の早期 return しか無いため、この経路でも対にする。
 */
test("close: onStateChange が throw しても onClose を通知する", async () => {
  const failure = new Error("state change failure");
  const { subscriber, closeCount } = createTestSubscriber(
    { video: {} },
    {
      onStateChange: () => {
        throw failure;
      },
    },
  );
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);

  const thrown = await captureThrown(subscriber.close());

  assert.strictEqual(thrown, failure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);

  // 二重 close は早期 return であり、onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close が start の実行中 ("subscribing") に届いた場合、
 * "closed" が優先され、start の失敗時の巻き戻しで state が "closed" に戻らない。
 *
 * start() は接続を要するため node では connect で失敗する。start() が同期部分で
 * "subscribing" に遷移した直後に、connectToServer が捕捉した世代番号で通知を駆動する
 * (解放の完了は start() の失敗を待たない。実際の通知は await の途中で届く)。
 */
test("start: subscribing 中にピア起点の close が届いたら closed を優先する", async () => {
  const { subscriber, states, errors, closeCount } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl;
  // connectToServer が session を作るときに捕捉する世代番号
  const generation = control.sessionGeneration;

  // node 環境には WebTransport が無いため start は接続で失敗する。
  // 失敗の解決を待たずに通知を駆動するため、先に結果を受け取れるようにしておく
  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  await control.handleSessionClose(generation);

  // ピア起点の close が優先されること
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(
    states.filter((state) => state === "closed"),
    ["closed"],
  );
  // 巻き戻しで "closed" が上書きされないこと
  assert.equal(states[states.length - 1], "closed");

  // start は接続の失敗で終わり、state ガードの拒否ではないこと
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 接続の await 中に close() が先行した場合、接続で受け取った session を
 * その場で閉じて this.session に代入しない。代入すると state は既に "closed" で
 * close() も早期 return するため、閉じる経路が残らない。
 * あわせて、購読 (SUBSCRIBE / FETCH) もカタログ通知 (onCatalog) もリソース作成
 * (出力 MediaStream / AudioContext / デコーダ) も行わない。
 *
 * WebTransport は node に無いため、接続の境界 (openSession) だけを置き換えて完了を
 * 制御する。接続要求を保留したまま close() を完了させ、そのあとで接続を解決させる。
 */
test("start: 接続の await 中に close したら受け取った session を閉じて購読もしない", async () => {
  const { subscriber, states, errors, catalogs, closeCount } = createTestSubscriber({
    audio: {},
    video: {},
  });
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 接続の完了をテストが決める (解決するまで connectToServer は await のまま)
  let completeConnect: (session: Session) => void = () => {};
  control.openSession = () =>
    new Promise<Session>((resolve) => {
      completeConnect = resolve;
    });

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  // 接続待ちの間に close() を完了させる (解放は session 未代入のまま "closed" へ固定する)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);

  // 接続が解決したら、受け取った session をその場で閉じて採用しないこと
  const sessionCalls: string[] = [];
  completeConnect({
    subscribe: async () => {
      sessionCalls.push("subscribe");
      throw new Error("must not subscribe");
    },
    fetch: async () => {
      sessionCalls.push("fetch");
      throw new Error("must not fetch");
    },
    close: async () => {
      sessionCalls.push("close");
    },
  } as unknown as Session);

  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  // session は代入されず、その場で 1 回だけ閉じられること
  assert.isNull(control.session);
  assert.deepEqual(sessionCalls, ["close"]);
  // 購読もカタログ通知もリソース作成も起きないこと
  assert.equal(catalogs.length, 0);
  assert.isNull(control.outputStream);
  assert.isNull(control.audioOutput);
  assert.isNull(control.audioDecoder);
  assert.isNull(control.videoDecoder);
  // 失敗は onError で通知され、state は終端のまま (巻き戻さない) であること
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(states, ["subscribing", "closed"]);
});

/**
 * 完了条件: カタログの SUBSCRIBE の await 中に解放が先行した場合、FETCH を発行せず
 * カタログの受信待ちもしない。確立した購読は start の失敗時の巻き戻しが解除する。
 *
 * 接続の境界 (openSession) を置き換え、購読要求の解決をテストが決める。
 */
test("start: カタログの購読確立中に close したら FETCH も受信待ちもしない", async () => {
  const { subscriber, errors, catalogs, closeCount } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  const sessionCalls: string[] = [];
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.openSession = async () =>
    ({
      subscribe: () =>
        new Promise<Subscriber>((resolve) => {
          completeSubscribe = resolve;
        }),
      fetch: async () => {
        sessionCalls.push("fetch");
        throw new Error("must not fetch");
      },
      close: async () => {
        sessionCalls.push("session.close()");
      },
    }) as unknown as Session;

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");
  // カタログの購読要求が出るまで待つ (ここから先は購読の解決をテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  // 購読の確立中に close() を完了させる (session は閉じられ、世代番号が進む)
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立したら、解放の検査で中止し FETCH も受信待ちも行わないこと
  let unsubscribes = 0;
  completeSubscribe(
    createRecordingSubscriber(() => {
      unsubscribes++;
    }),
  );
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.equal(
    (startFailure as Error).message,
    "start aborted: resources were disposed during start",
  );
  assert.deepEqual(sessionCalls, ["session.close()"]);
  // 確立した購読は巻き戻しが解除し、参照も残らないこと
  assert.equal(unsubscribes, 1);
  assert.isNull(control.catalogSubscriber);
  // カタログも受信していないこと
  assert.equal(catalogs.length, 0);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: close は stop と同じ解放を行う。購読の確立中 ("subscribing") の close でも
 * catalog の受信待ちが残らず、start() の await が永久に解決しないことがない。
 */
test("close: subscribing 中の close は catalog の受信待ちを打ち切る", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  const { session } = createCatalogTestSession();
  // 解放で session を閉じるため、最小セッションに close を足す
  (session as unknown as { close: () => Promise<void> }).close = async () => {};
  control.session = session;
  control.currentState = "subscribing";

  // SUBSCRIBE は確立するが catalog は届かない (受信待ちが残る)
  const subscribePromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  assert.isNotNull(control.catalogResolve);
  // 購読の await を解決させ、受信待ちに入れてから close する。解放は購読の await の直後の
  // 検査にも掛かるため、待ちに入る前に解放すると中止の検査で終わってしまう
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  await subscriber.close();

  // 受信待ちが解放で打ち切られ、start 側の await が解決しないままにならないこと
  const thrown = await captureThrown(subscribePromise);
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /catalog receive aborted/);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogReject);
  assert.isNull(control.catalogTimer);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: close は stop と同じ解放を行う。解放による catalog の打ち切りは
 * await が付いた待ちだけを対象にするため、session.subscribe の待ちの間に close しても
 * 未処理の rejection にならず、start 側は購読要求の失敗で終わる。
 */
test("close: session.subscribe の待ちの間に close しても購読要求の失敗で終わる", async () => {
  const subscriber = createTestSubscriber({
    video: {},
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  let rejectSubscribe: ((error: Error) => void) | null = null;
  control.session = {
    subscribe: () =>
      new Promise((_resolve, reject) => {
        rejectSubscribe = reject;
      }),
    // 実セッションでは close が保留中の購読要求を reject する
    close: async () => {
      rejectSubscribe?.(new Error("session closed"));
    },
  } as unknown as Session;
  control.currentState = "subscribing";

  const subscribePromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読要求の失敗が start 側へ伝わること (catalog の打ち切りは await が付く前の
  // 待ちを対象にしないため、この経路では reject されない)
  const thrown = await captureThrown(subscribePromise);
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /session closed/);
});

/**
 * 完了条件: close は stop と同じ解放を行う。解放中に保留中の FETCH が終了しても、
 * バッファした live オブジェクトのドレインで onCatalog が発火したり catalog 待ちが
 * resolve したりしない。
 *
 * FETCH フェーズ中に届いた full catalog は pendingCatalogObjects にバッファされる。
 * 解放の session close は保留中の FETCH を reject し、その終了処理
 * (finishCatalogFetchPhase) がバッファをドレインするため、解放がフェーズ状態を
 * 先に落としていないと、解放中の onCatalog 発火と catalog 待ちの resolve が起きる。
 */
test("close: 解放中に FETCH が終了してもバッファした live オブジェクトを適用しない", async () => {
  const { subscriber, catalogs } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
  };
  let rejectFetch: ((error: Error) => void) | null = null;
  // 捕捉したコールバックを null 許容の let で持つと型の絞り込みで呼べなくなるため、
  // 呼び出し可能な初期値 (何もしない) を持たせる
  let liveObject: (obj: MoqtObject) => void = () => {};
  let notifyFetchStarted: () => void = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    notifyFetchStarted = resolve;
  });
  control.session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>) => {
      liveObject = args[2].object;
      // SUBSCRIBE_OK の LARGEST_OBJECT だけを持つ最小の Subscriber
      return { largestLocation: { group: 1n, object: 0n } } as Subscriber;
    },
    fetch: () => {
      // 解放まで終わらない FETCH (実セッションと同じく close で reject される)
      notifyFetchStarted();
      return new Promise<never>((_resolve, reject) => {
        rejectFetch = reject;
      });
    },
    // 実セッションでは close が保留中の FETCH を reject する
    close: async () => {
      rejectFetch?.(new Error("session closed"));
    },
  } as unknown as Session;
  control.currentState = "subscribing";

  const catalogPromise = control.subscribeCatalog(control.sessionGeneration, 60_000);
  // FETCH が呼ばれるまで待つ (fetch の登録は subscribe の解決後に行われる)
  await fetchStarted;
  // FETCH フェーズ中に届いた live の full catalog はバッファされる
  liveObject({ ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) });
  assert.equal(control.pendingCatalogObjects.length, 1);

  await subscriber.close();

  // 解放中に FETCH が reject しても、バッファした live オブジェクトを適用しないこと
  assert.equal(catalogs.length, 0);
  assert.isNull(control.catalogResolve);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.equal(subscriber.state, "closed");
  // catalog 待ちは resolve せず、解放による打ち切りで終わること
  const thrown = await captureThrown(catalogPromise);
  assert.instanceOf(thrown, Error);
  assert.match((thrown as Error).message, /catalog receive aborted/);
});

/**
 * 完了条件: デコーダの configure の await 中に解放が先行した場合、次の段階
 * (映像デコーダ / メディアトラックの購読) へ進まずに中止する。
 *
 * AudioDecoderWrapper は WebCodecs の AudioDecoder を作る。node には無いため、その境界
 * だけを置き換えて configure まで到達させる (useWorker: false にして worker を使わない
 * 直接実行にする)。configure は同期で完了するため、await の解決までの間に close() の
 * 解放 (世代番号を進める) を先行させる。
 */
test("setupDecoders: デコーダの configure の await 中に close したら中止する", async () => {
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
    useWorker: false,
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    setupDecoders(startGeneration: number): Promise<void>;
  };
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  control.currentState = "subscribing";

  // 差し替えた WebCodecs の AudioDecoder (実装が configure まで到達した印も取る)
  const target = globalThis as unknown as { AudioDecoder: unknown };
  const originalAudioDecoder = target.AudioDecoder;
  const configuredCodecs: string[] = [];
  target.AudioDecoder = class {
    readonly state = "configured";
    configure(config: { codec: string }): void {
      configuredCodecs.push(config.codec);
    }
    decode(): void {}
    close(): void {}
  };

  let thrown: unknown = null;
  try {
    const pending = control.setupDecoders(control.sessionGeneration);
    // await の解決の間に解放を先行させる
    await subscriber.close();
    await pending;
  } catch (error) {
    thrown = error;
  } finally {
    target.AudioDecoder = originalAudioDecoder;
  }

  // デコーダは構成されたが、解放が先行したため中止されること
  assert.deepEqual(configuredCodecs, ["opus"]);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放でデコーダは閉じられ、参照も残らないこと
  assert.isNull(control.audioDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: メディアトラックの購読の await 中に解放が先行した場合、初期 configure の適用へ
 * 進まずに中止する。start の失敗時の巻き戻しに相当する解放で、確立した購読が解除される。
 *
 * 購読要求の解決をテストが決め、その間に close() を完了させる。
 */
test("subscribeMediaTracks: 購読の確立中に解放が先行したら初期 configure を適用しない", async () => {
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    Pick<SubscriberInitialConfigControl, "audioInitialConfigPending"> & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
      disposeAllResources(): Promise<void>;
    };
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.session = {
    subscribe: () =>
      new Promise<Subscriber>((resolve) => {
        completeSubscribe = resolve;
      }),
    close: async () => {},
  } as unknown as Session;
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  // 購読要求 (session.subscribe) が出るまで待つ (購読の解決はテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // 購読の await 中に解放を先行させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立しても、解放の検査で中止し初期 configure の適用 (購読の Track Property の
  // 読み取り) をしないこと
  let unsubscribes = 0;
  let trackPropertyReads = 0;
  completeSubscribe({
    state: "active",
    largestLocation: null,
    get trackProperties() {
      trackPropertyReads++;
      return [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([1, 2]) }];
    },
    unsubscribe: async () => {
      unsubscribes++;
    },
  } as unknown as Subscriber);

  const thrown = await captureThrown(pending);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 初期 configure の適用が始まっていないこと
  assert.equal(trackPropertyReads, 0);

  // start の巻き戻しに相当する解放で、確立した購読が解除され参照も残らないこと
  await control.disposeAllResources();
  assert.equal(unsubscribes, 1);
  assert.isNull(control.audioSubscriber);
});

/**
 * 完了条件: start の実行中 ("subscribing") に解放が先行して失敗しても、失敗時の巻き戻しが
 * state を "subscribing" に固定しない。
 *
 * 巻き戻しを「解放が先行したか」だけで止めると、解放が失敗して終端 ("closed") に到達しなかった
 * 場合に "subscribing" が残り、start も stop も拒否されて close 以外の出口が無くなる。
 * 接続の完了をテストが決めて start を "subscribing" に保ち、解放が失敗する close() を
 * 重ねてから接続を失敗させる。
 */
test("start: 開始の途中で解放が失敗しても subscribing に固定されない", async () => {
  const failure = new Error("session close failure");
  const { subscriber, states, errors } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & SubscriberConnectControl;
  // 停止後 ("stopped") を再現し、start の遷移前の state を "stopped" にする
  control.currentState = "stopped";
  // 解放が session の close で失敗するようにする (終端 "closed" へ進めない)
  injectLifecycleResources(control, { sessionCloseError: failure });
  // 接続の完了をテストが決める (解決するまで start は "subscribing" のまま)
  let failConnect: (error: Error) => void = () => {};
  control.openSession = () =>
    new Promise<Session>((_resolve, reject) => {
      failConnect = reject;
    });

  const startResult = subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(subscriber.state, "subscribing");

  // 解放が失敗する close() を重ねる
  let closeThrown: unknown = null;
  try {
    await subscriber.close();
  } catch (error) {
    closeThrown = error;
  }
  assert.strictEqual(closeThrown, failure);
  // 解放が失敗したため終端へは進んでいないこと
  assert.equal(subscriber.state, "subscribing");

  // 接続の失敗で start を終わらせると、巻き戻しで遷移前の "stopped" に戻ること
  failConnect(new Error("connect failed"));
  const startFailure = await startResult;
  assert.instanceOf(startFailure, Error);
  assert.notMatch((startFailure as Error).message, /cannot start in state/);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], startFailure);
  assert.equal(subscriber.state, "stopped");
  assert.deepEqual(states, ["subscribing", "stopped"]);

  // 再試行が state ガードで拒否されないこと ("subscribing" に固定されていない)
  control.openSession = () => Promise.reject(new Error("connect failed"));
  const retryFailure = await subscriber.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.instanceOf(retryFailure, Error);
  assert.notMatch((retryFailure as Error).message, /cannot start in state/);
  assert.equal(subscriber.state, "stopped");
});

/**
 * 完了条件: 解放をまたいで stop() と close() が重なっても終端の "closed" が残り、
 * onClose は 1 回だけ通知される。
 *
 * stop() の終端遷移 ("stopped") を無条件に行うと、close() の終端遷移より後に走った場合に
 * state が "closed" から "stopped" へ戻る。close() の早期 return は state だけを見るため、
 * もう一度 close() を呼ぶと onClose が 2 回目通知される。stop の解放を session の close で
 * 止め、close() が進行中の解放の完了を待って終端へ進む順序を固定する。
 */
test("stop: close と重なっても closed のまま onClose は 1 回だけになる", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  // stop の解放を session の close で止め、解放が進行中の窓を作る
  const blocked = startBlockedSessionClose(control);

  // stop を await せずに開始し、解放が止まるまで待つ (state は "active" のまま)
  const stopping = subscriber.stop();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ。close() は進行中の解放を共有して完了を待つため、
  // 解放が終わるまで終端へは進まない
  const closing = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);

  // 止めていた stop の解放を終わらせると close() が終端まで進む
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
  // 解放は 1 回だけで、"stopped" のあとに "closed" が来ること
  assert.equal(blocked.closeCalls(), 1);
  assert.deepEqual(states, ["stopped", "closed"]);

  // "closed" のあとの close() は早期 return であり onClose を増やさないこと
  await subscriber.close();
  assert.equal(closeCount(), 1);

  // 終端後の start() は state ガードで拒否されること
  const thrown = await captureThrown(subscriber.start());
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "cannot start in state: closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: stop() が始めた解放に close() が相乗りしても、解放の成否が close() に伝わる。
 *
 * 解放は破棄の前に参照を切り離すため、相乗りした呼び出しが自分で解放をやり直すと
 * 「破棄するものが無い成功」に見え、進行中の失敗を検知できない。解放の Promise を共有して
 * いることを、解放を session の close で止めて失敗させることで固定する。
 */
test("close: stop の解放に相乗りしたら解放の失敗が close に伝わる", async () => {
  const failure = new Error("session close failure");
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  // stop の解放を session の close で止め、再開したとき失敗させる
  const blocked = startBlockedSessionClose(control, { sessionCloseError: failure });

  // stop() の解放を開始する (state は "active" のまま止まる)
  const stopping = subscriber.stop().then(
    () => null,
    (error: unknown) => error,
  );
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ (進行中の解放を共有して完了を待つ)
  const closeResult = subscriber.close().then(
    () => null,
    (error: unknown) => error,
  );

  // 解放を失敗させると stop() と close() の両方に失敗が伝わること
  blocked.release();
  const stopFailure = await stopping;
  const closeFailure = await closeResult;
  assert.strictEqual(stopFailure, failure);
  assert.strictEqual(closeFailure, failure);
  // 解放が失敗したため終端へは進まず、onClose も呼ばないこと
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  assert.deepEqual(states, []);
  // 解放は 1 回だけであること (相乗りでやり直さない)
  assert.equal(blocked.closeCalls(), 1);

  // 参照は切り離し済みのため、close() の呼び直しで終端まで進めること
  await subscriber.close();
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: stop() が始めた解放に close() が相乗りし、解放が成功した場合は
 * 解放 1 回で "closed" になり onClose は 1 回だけ通知される。
 *
 * close() が相乗りを待たずに自分の解放をやり直すと、参照は切り離し済みのため先に終端へ
 * 進んでしまい、stop() の事後条件と解放の順序が崩れる。
 */
test("close: stop の解放に相乗りして成功したら解放 1 回で closed になる", async () => {
  const { subscriber, states, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control);

  const stopping = subscriber.stop();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // close() は進行中の解放を共有するため、止めている間は終端へ進まないこと
  const closing = subscriber.close();
  await sleep(0);
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);

  // 解放を終わらせると stop の "stopped" のあとに close の "closed" が来ること
  blocked.release();
  await Promise.all([stopping, closing]);
  assert.equal(blocked.closeCalls(), 1);
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(states, ["stopped", "closed"]);
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: ピア起点の close が始めた解放に close() が相乗りしても、解放の成否が
 * close() に伝わる。
 *
 * ピア起点の経路は解放の失敗を onError で通知して戻るため、close() が相乗りしていなければ
 * 利用者は同じ失敗を close() の結果からは受け取れない。
 */
test("close: ピア起点の close の解放に相乗りしたら解放の失敗が close に伝わる", async () => {
  const failure = new Error("session close failure");
  const { subscriber, errors, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  const blocked = startBlockedSessionClose(control, { sessionCloseError: failure });

  // ピア起点の close の解放を開始し、session の close で止める
  const peer = control.handleSessionClose(control.sessionGeneration);
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 止めている間に close() を呼ぶ (進行中の解放を共有して完了を待つ)
  const closeResult = subscriber.close().then(
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
  assert.equal(subscriber.state, "active");
  assert.equal(closeCount(), 0);
  assert.equal(blocked.closeCalls(), 1);
});

/**
 * 完了条件: close() の解放中は start() / stop() を呼べない。
 *
 * 解放中は state がまだ "active" などのため、state だけを見た判定では開始や停止が
 * 通過してしまう。解放と終端を待たずに重ねると、開始した start が途中で終端になる。
 * closing (進行中の解放) を見た専用のエラーで fail fast にする。
 */
test("start / stop: close の解放中は while closing で拒否する", async () => {
  const { subscriber, closeCount } = createTestSubscriber({ video: {} });
  const control = activateLifecycleControl(subscriber);
  injectLifecycleResources(control);
  // 解放を session の close で止め、解放中の窓を作る
  const blocked = startBlockedSessionClose(control);

  const closing = subscriber.close();
  await blocked.started;
  assert.equal(subscriber.state, "active");

  // 解放中の start() は state ガードではなく closing のガードで拒否されること
  let startThrown: unknown = null;
  try {
    await subscriber.start();
  } catch (error) {
    startThrown = error;
  }
  assert.instanceOf(startThrown, Error);
  assert.equal((startThrown as Error).message, "cannot start while closing");

  // 解放中の stop() も同様に拒否されること
  let stopThrown: unknown = null;
  try {
    await subscriber.stop();
  } catch (error) {
    stopThrown = error;
  }
  assert.instanceOf(stopThrown, Error);
  assert.equal((stopThrown as Error).message, "cannot stop while closing");

  // 拒否は解放をやり直さないこと
  assert.equal(blocked.closeCalls(), 1);
  blocked.release();
  await closing;
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCount(), 1);
});

/**
 * 完了条件: デコーダの configure の await 中に解放が先行した場合、次の段階
 * (メディアトラックの購読) へ進まずに中止する。解放のあとに Worker や VideoDecoder を
 * 作らないことを、映像デコーダだけで駆動して固定する (音声側は setupDecoders の
 * 別のテストが担う)。
 *
 * VideoDecoderWrapper は WebCodecs の VideoDecoder を作る。node には無いため、その境界
 * だけを置き換えて configure の対応確認まで到達させる (useWorker: false にして worker を
 * 使わない直接実行にする)。対応確認の解決はテスト側で保留し、その間に close() の解放が
 * Wrapper を閉じるまで進める。解放のあとに作られた Worker や VideoDecoder は誰も破棄しない
 * ため、置き換えた VideoDecoder の生成と close を数えて作られていないことまで固定する。
 */
test("setupDecoders: 映像デコーダの configure の await 中に close したら中止する", async () => {
  const subscriber = createTestSubscriber({
    video: { codec: "vp8" },
    useWorker: false,
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    setupDecoders(startGeneration: number): Promise<void>;
  };
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8", width: 640, height: 480 });
  control.currentState = "subscribing";

  // 差し替えた WebCodecs の VideoDecoder (実装が configure まで到達した印も取る)
  const target = globalThis as unknown as { VideoDecoder: unknown };
  const originalVideoDecoder = target.VideoDecoder;
  const configuredCodecs: string[] = [];
  // 実装は configure の直前に対応確認 (isConfigSupported) を通る。そこへ渡る codec も取る
  const probedCodecs: string[] = [];
  // 解放のあとにデコーダーが作られていないことを数える。作られると誰も閉じないため、
  // 解放で参照が切れたことだけでは検出できない
  let createdCodecCount = 0;
  let closedCodecCount = 0;
  // 対応確認の解決をテスト側で制御し、解放がデコーダーを閉じるまで保留させる
  let releaseSupportCheck: () => void = () => {};
  const supportCheckPending = new Promise<void>((resolve) => {
    releaseSupportCheck = resolve;
  });
  target.VideoDecoder = class {
    readonly state = "configured";
    constructor() {
      createdCodecCount += 1;
    }
    // 境界の置き換えとして対応ありを返す (非対応の分岐は実ブラウザの e2e が固定する)
    static async isConfigSupported(config: { codec: string }): Promise<{ supported: boolean }> {
      probedCodecs.push(config.codec);
      // 解放がデコーダーを閉じるまで対応確認を保留する (await の窓をテスト側で作る)
      await supportCheckPending;
      return { supported: true };
    }
    configure(config: { codec: string }): void {
      configuredCodecs.push(config.codec);
    }
    decode(): void {}
    close(): void {
      closedCodecCount += 1;
    }
  };

  let thrown: unknown = null;
  try {
    const pending = control.setupDecoders(control.sessionGeneration);
    // 解放を先行させ、デコーダーを閉じるまで待つ (configure の対応確認は保留のまま)
    await subscriber.close();
    // 保留していた対応確認を解放のあとに解決させる (close() が先行した状態で再開する)
    releaseSupportCheck();
    await pending;
  } catch (error) {
    thrown = error;
  } finally {
    target.VideoDecoder = originalVideoDecoder;
  }

  // 対応確認までは進むが、解放が先行したためデコーダーは作らずに中止されること
  assert.deepEqual(probedCodecs, ["vp8"]);
  assert.equal(createdCodecCount, 0);
  assert.deepEqual(configuredCodecs, []);
  assert.equal(closedCodecCount, 0);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "video decoder configure superseded by newer generation");
  // 解放で参照は切り離され、解放のあとに作られたデコーダーも残らないこと
  assert.isNull(control.videoDecoder);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 認可トークンの解決の await 中に解放が先行した場合、購読要求
 * (SUBSCRIBE) を出さずに中止する。映像側を駆動する。
 *
 * 解放は世代番号を進めてから参照を切り離すため、トークンの解決が先に進むと、
 * 検査が無ければ切り離し前の session へ購読要求を出してしまう。
 */
test("subscribeMediaTracks: 映像の認可トークン解決中に解放が先行したら購読要求を出さない", async () => {
  const token = useValueToken();
  let releaseToken: () => void = () => {};
  let notifyTokenStarted: () => void = () => {};
  const tokenStarted = new Promise<void>((resolve) => {
    notifyTokenStarted = resolve;
  });
  const subscriber = createTestSubscriber({
    video: { codec: "vp8" },
    getAuthorizationToken: () => {
      notifyTokenStarted();
      return new Promise<AuthorizationToken | undefined>((resolve) => {
        releaseToken = () => resolve(token);
      });
    },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
  };
  const subscribeCalls: string[] = [];
  control.session = {
    subscribe: async () => {
      subscribeCalls.push("subscribe");
      return {} as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  // authInfo がある track は購読前にトークンの解決を要する (draft-ietf-moq-msf-01 §11.4.3)
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8", authInfo: { "privacy-pass": {} } });
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await tokenStarted;
  // トークンの解決中に解放を先行させる。解放は session を切り離す前に await を挟むため、
  // ここで世代番号だけが先に進む
  const closing = subscriber.close();
  releaseToken();

  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放が先行したため購読要求を出していないこと
  assert.deepEqual(subscribeCalls, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 認可トークンの解決の await 中に解放が先行した場合、購読要求を出さずに中止する。
 * 音声側は映像側より先に購読するため、音声の検査が無ければ解放後に音声の購読要求が出る。
 */
test("subscribeMediaTracks: 音声の認可トークン解決中に解放が先行したら購読要求を出さない", async () => {
  const token = useValueToken();
  let releaseToken: () => void = () => {};
  let notifyTokenStarted: () => void = () => {};
  const tokenStarted = new Promise<void>((resolve) => {
    notifyTokenStarted = resolve;
  });
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
    getAuthorizationToken: () => {
      notifyTokenStarted();
      return new Promise<AuthorizationToken | undefined>((resolve) => {
        releaseToken = () => resolve(token);
      });
    },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    Pick<SubscriberInitialConfigControl, "audioInitialConfigPending"> & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  const subscribeCalls: string[] = [];
  control.session = {
    subscribe: async () => {
      subscribeCalls.push("subscribe");
      return {} as Subscriber;
    },
    close: async () => {},
  } as unknown as Session;
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
    authInfo: { "privacy-pass": {} },
  });
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await tokenStarted;
  // 購読要求より前に保留 (audioInitialConfigPending) が有効化されていること
  assert.isTrue(control.audioInitialConfigPending);
  const closing = subscriber.close();
  releaseToken();

  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.deepEqual(subscribeCalls, []);
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 映像トラックの購読確立の await 中に解放が先行した場合、初期 configure の適用へ
 * 進まずに中止する。start の失敗時の巻き戻しに相当する解放で、確立した購読が解除される。
 *
 * 購読要求の解決をテストが決め、その間に close() を完了させる。
 */
test("subscribeMediaTracks: 映像の購読確立中に解放が先行したら初期 configure を適用しない", async () => {
  const subscriber = createTestSubscriber({
    video: { codec: "vp8" },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeMediaTracks(startGeneration: number): Promise<void>;
    disposeAllResources(): Promise<void>;
  };
  let completeSubscribe: (subscriber: Subscriber) => void = () => {};
  control.session = {
    subscribe: () =>
      new Promise<Subscriber>((resolve) => {
        completeSubscribe = resolve;
      }),
    close: async () => {},
  } as unknown as Session;
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  // 購読要求 (session.subscribe) が出るまで待つ (購読の解決はテストが決める)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // 購読の await 中に解放を先行させる
  await subscriber.close();
  assert.equal(subscriber.state, "closed");

  // 購読が確立しても、解放の検査で中止し初期 configure の適用 (購読の Track Property の
  // 読み取り) をしないこと
  let unsubscribes = 0;
  let trackPropertyReads = 0;
  completeSubscribe({
    state: "active",
    largestLocation: null,
    get trackProperties() {
      trackPropertyReads++;
      return [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2]) }];
    },
    unsubscribe: async () => {
      unsubscribes++;
    },
  } as unknown as Subscriber);

  const thrown = await captureThrown(pending);
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 初期 configure の適用が始まっていないこと
  assert.equal(trackPropertyReads, 0);

  // start の巻き戻しに相当する解放で、確立した購読が解除され参照も残らないこと
  await control.disposeAllResources();
  assert.equal(unsubscribes, 1);
  assert.isNull(control.videoSubscriber);
});

/**
 * 完了条件: 音声の初期 configure の適用 (configure の await) 中に解放が先行した場合、
 * 次の段階 (映像トラックの購読) へ進まずに中止する。
 *
 * VideoDecoderWrapper / AudioDecoderWrapper は WebCodecs のデコーダを作る。この検査は
 * 適用の await の直後にあり、configure の解決をテストが決めないと解放を割り込ませられない。
 * デコーダの境界だけを置き換え、reconfigureAudioDecoder の分岐は実装のまま駆動する。
 */
test("subscribeMediaTracks: 音声の初期 configure 適用中に解放が先行したら中止する", async () => {
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  // 初期 configure の適用を configure の await で止め、解放が入り込める窓を作る
  let releaseConfigure: () => void = () => {};
  let notifyConfigureStarted: () => void = () => {};
  const configureStarted = new Promise<void>((resolve) => {
    notifyConfigureStarted = resolve;
  });
  control.audioDecoder = {
    configure: () => {
      notifyConfigureStarted();
      return new Promise<void>((resolve) => {
        releaseConfigure = resolve;
      });
    },
    decode: () => {},
    close: () => {},
  };
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        largestLocation: null,
        trackProperties: [{ id: LOC.LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([1, 2]) }],
        unsubscribe: async () => {},
      }) as unknown as Subscriber,
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await configureStarted;
  // 適用の await 中に解放を先行させる
  const closing = subscriber.close();
  releaseConfigure();

  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: 映像の初期 configure の適用 (configure の await) 中に解放が先行した場合、
 * start を "active" にせず中止する。映像側の検査が無ければ、解放後に初期 configure を
 * 適用したうえで start が成功してしまう。
 */
test("subscribeMediaTracks: 映像の初期 configure 適用中に解放が先行したら中止する", async () => {
  const subscriber = createTestSubscriber({
    video: { codec: "vp8" },
  }).subscriber;
  const control = subscriber as unknown as SubscriberLifecycleControl &
    SubscriberInitialConfigControl & {
      subscribeMediaTracks(startGeneration: number): Promise<void>;
    };
  // 初期 configure の適用を configure の await で止め、解放が入り込める窓を作る
  let releaseConfigure: () => void = () => {};
  let notifyConfigureStarted: () => void = () => {};
  const configureStarted = new Promise<void>((resolve) => {
    notifyConfigureStarted = resolve;
  });
  control.videoDecoder = {
    configure: () => {
      notifyConfigureStarted();
      return new Promise<void>((resolve) => {
        releaseConfigure = resolve;
      });
    },
    decode: () => {},
    close: () => {},
  };
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "vp8" });
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        trackProperties: [{ id: LOC.LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([1, 2]) }],
        unsubscribe: async () => {},
      }) as unknown as Subscriber,
    close: async () => {},
  } as unknown as Session;
  control.currentState = "subscribing";

  const pending = control.subscribeMediaTracks(control.sessionGeneration);
  await configureStarted;
  // 適用の await 中に解放を先行させる
  const closing = subscriber.close();
  releaseConfigure();

  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  assert.equal(subscriber.state, "closed");
});

/**
 * 完了条件: カタログの受信の await が解決した直後に解放が先行した場合、トラック情報の抽出と
 * 出力の作成へ進まずに中止する。
 *
 * カタログ待ちは解放で reject されるため、解放が先行したことを受信の await の直後で
 * 判定できるのは「待ちが解決済みで、await の再開前に解放が入った」場合だけである。
 * FETCH を失敗させて live のフルカタログで待ちを解決し、その直後に close() を呼ぶ。
 */
test("subscribeCatalog: カタログの受信 await の解決直後に解放が先行したら中止する", async () => {
  const { subscriber, catalogs } = createTestSubscriber({ video: {} });
  const control = subscriber as unknown as SubscriberLifecycleControl & {
    subscribeCatalog(startGeneration: number, timeoutMs?: number): Promise<void>;
    handleCatalogObject(obj: MoqtObject): void;
  };
  let unsubscribeCount = 0;
  control.session = {
    subscribe: async () =>
      ({
        state: "active",
        largestLocation: null,
        unsubscribe: async () => {
          unsubscribeCount++;
        },
      }) as unknown as Subscriber,
    // FETCH を失敗させ、FETCH フェーズを終わらせる (live のバッファをドレインさせる)
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

  // フルカタログを受信させ、受信待ちを解決する
  control.handleCatalogObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  assert.equal(catalogs.length, 1);
  assert.isNotNull(control.receivedCatalog);

  // 受信の await が再開する前に、close() の同期部分で世代番号を進める
  const closing = subscriber.close();

  const thrown = await captureThrown(pending);
  await closing;
  assert.instanceOf(thrown, Error);
  assert.equal((thrown as Error).message, "start aborted: resources were disposed during start");
  // 解放で購読は解除され、参照も残らないこと
  assert.equal(unsubscribeCount, 1);
  assert.isNull(control.catalogSubscriber);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.equal(subscriber.state, "closed");
});
