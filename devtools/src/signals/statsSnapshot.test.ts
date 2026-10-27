import { test, assert } from "vite-plus/test";
import { EMPTY_AUDIO_PLAYOUT_TIMING, EMPTY_AUDIO_RECEIVE_CATCH_UP } from "moqt-js";
import { createSubscriberInstance, EMPTY_AV_SYNC, EMPTY_AUDIO_DELAY_FEEDBACK } from "./subscriber";
import { EMPTY_PLAYOUT_TIMING } from "../utils/playoutTimingStats";
import { EMPTY_PUBLISH_TIMING } from "../utils/publishTimingStats";
import { EMPTY_HOST_DELAY } from "../utils/hostDelayTracker.ts";
import { buildPublisherStats, buildSubscriberStats } from "./statsSnapshot";
import * as pub from "./publisher";
import * as settings from "./connectionSettings";

test("buildSubscriberStats: Audio Level の 0 と false を保持する", () => {
  // 公開する統計は「値が無い」を null で表すが、level 0 (最大音量) と
  // voiceActivity false (無音) は値があるため、null に潰してはいけない
  const instance = createSubscriberInstance("stats-audio-1");
  instance.audioLastLevel.value = { level: 0, voiceActivity: false };

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audio.lastLevel, 0);
  assert.equal(stats.audio.lastVoiceActivity, false);
});

test("buildSubscriberStats: Audio Level が無いときは null にする", () => {
  const instance = createSubscriberInstance("stats-audio-2");
  instance.audioLastLevel.value = null;

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audio.lastLevel, null);
  assert.equal(stats.audio.lastVoiceActivity, null);
});

test("buildSubscriberStats: 復号前のレベルは null、復号後は dBFS を返す", () => {
  const instance = createSubscriberInstance("stats-audio-3");
  assert.equal(buildSubscriberStats(instance).audio.peakDbfs, null);
  assert.equal(buildSubscriberStats(instance).audio.rmsDbfs, null);
  assert.equal(buildSubscriberStats(instance).audio.peakDbfsRight, null);
  assert.equal(buildSubscriberStats(instance).audio.rmsDbfsRight, null);

  instance.audioPeakDbfsLeft.value = -6;
  instance.audioRmsDbfsLeft.value = -9;
  instance.audioPeakDbfsRight.value = -7;
  instance.audioRmsDbfsRight.value = -10;

  const stats = buildSubscriberStats(instance);
  assert.equal(stats.audio.peakDbfs, -6);
  assert.equal(stats.audio.rmsDbfs, -9);
  assert.equal(stats.audio.peakDbfsRight, -7);
  assert.equal(stats.audio.rmsDbfsRight, -10);
});

test("buildSubscriberStats: 受信した音声の鳴らし方の数を返す", () => {
  // 鳴らす時刻を過ぎて届いたなどで基準を取り直した回数と、遅れが上限を超えて捨てた音の数。
  // 再生の音の途切れの原因を切り分けるために読む
  const instance = createSubscriberInstance("stats-audio-playout");
  instance.audioPlayoutRebases.value = 2;
  instance.audioPlayoutDrops.value = 3;
  const stats = buildSubscriberStats(instance);
  assert.equal(stats.audio.playoutRebases, 2);
  assert.equal(stats.audio.playoutDrops, 3);
});

test("buildSubscriberStats: Group の順序と欠落で捨てた映像フレーム数を返す", () => {
  // 前の Group の遅着 Object (stale) と、参照先が欠けてキーフレームを待つ間の Object
  // (missing-reference) を分けて数える。E2E はこの値で受信した映像の並びを確かめる
  const instance = createSubscriberInstance("dropped-frames");
  instance.staleFramesDropped.value = 5;
  instance.missingReferenceFramesDropped.value = 7;
  const stats = buildSubscriberStats(instance);
  assert.equal(stats.staleFramesDropped, 5);
  assert.equal(stats.missingReferenceFramesDropped, 7);
});

test("buildSubscriberStats: 受信から表示までの時間の統計を返す", () => {
  // 到着の揺らぎ・遅延・復号時間・表示間隔の分布と、止まり・表示キューのあふれの累積を
  // そのまま出す。E2E と実測スクリプトはこの値でかくつきの原因を切り分ける
  const instance = createSubscriberInstance("playout-timing");
  const timing = {
    ...EMPTY_PLAYOUT_TIMING,
    arrivalJitterMs: { p50: 1, p95: 20, max: 300 },
    latencyMs: { p50: 45, p95: 80, max: 1_200 },
    displayFps: 30,
    displayStalls: 4,
    displayStallMs: 900,
    displayQueueDrops: 2,
    playoutDelayMs: 40,
    lateFramesDropped: 3,
  };
  instance.playoutTiming.value = timing;
  assert.deepEqual(buildSubscriberStats(instance).playoutTiming, timing);
  // 購読前は何も記録していない値を返す
  assert.deepEqual(
    buildSubscriberStats(createSubscriberInstance("playout-timing-empty")).playoutTiming,
    EMPTY_PLAYOUT_TIMING,
  );
});

test("buildSubscriberStats: 同期の 5 項目を、未購読では既定値で返す", () => {
  // 同期の推定は映像の購読を始めてから記録するため、購読前は意味を持たない既定値を返す。
  // E2E はこの既定値と、data-testid に出る同じ値を確かめる
  const stats = buildSubscriberStats(createSubscriberInstance("av-sync-empty"));
  assert.deepEqual(stats.avSync, EMPTY_AV_SYNC);
  assert.equal(stats.avSync.skewMs, null);
  assert.equal(stats.avSync.presentationDelayMs, null);
  assert.equal(stats.avSync.targetLatencyMs, null);
  assert.equal(stats.avSync.targetLatencyLimitedMs, 0);
  assert.equal(stats.avSync.audioClockFallback, false);
});

test("buildSubscriberStats: 記録した同期の 5 項目をそのまま返す", () => {
  // 切り下げた分が 0 のとき (上限に収まっている) と、時計を代用していない false を
  // null に潰さずに返す。同期ずれは負 (映像が進んでいる) にもなる
  const instance = createSubscriberInstance("av-sync-values");
  instance.avSync.value = {
    skewMs: -12.5,
    presentationDelayMs: 145.25,
    targetLatencyMs: 100,
    targetLatencyLimitedMs: 0,
    audioClockFallback: false,
    delays: {
      audioPlayoutCorrectionMs: 0,
      audio: {
        baseDelayMs: 12.5,
        jitterDelayMs: 60,
        syncExtraDelayMs: 72.75,
        presentationDelayMs: 145.25,
        presentationDelayCapMs: 500,
      },
      video: {
        baseDelayMs: 4.5,
        jitterDelayMs: 33.3,
        syncExtraDelayMs: 0,
        presentationDelayMs: 37.8,
        presentationDelayCapMs: 500,
      },
      baseDifferenceMs: 8,
      baseDifferenceRecentMs: 9.5,
      baseDifferenceSettledMs: 6,
      baseDifferenceDeviationMs: 3.5,
      sharingBases: true,
      unsharedReason: "none",
      baseDriftMsPerSecond: 0.5,
      baseDriftLimitMs: 50,
      baseUnsharedReturnMs: 1_250,
      presentationDelayCapMs: 500,
      audioDelayFeedback: {
        targetMs: 110,
        jitterTargetMs: 40,
        appliedMs: 110,
        reason: "lateness",
        ceilingMs: 200,
        lastChangeMs: 30,
        adjustments: 4,
        latenessP50Ms: 8.5,
        startDelayP50Ms: 118.25,
        slackP50Ms: 12,
        // 圧縮が続いて上限を広げている状態 (明示設定 200 ms のうち 160 ms まで使う)
        appliedCeilingMs: 160,
        compressionMsPerSecond: 20,
      },
    },
  };
  assert.deepEqual(buildSubscriberStats(instance).avSync, instance.avSync.value);
});

test("buildSubscriberStats: 画面とコピー本文に出す状態と復号の統計を返す", () => {
  // 状態 (codec / statusMessage / httpVersion) と復号パイプラインの累積は、
  // デバッグパネルのコピー本文と SubscriberPanel が読む
  const instance = createSubscriberInstance("state-and-decoding");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";
  instance.httpVersion.value = "H3";
  instance.codec.value = "vp8";
  instance.decoderState.value = "configured";
  instance.decoderConfigured.value = true;
  instance.chunksCreated.value = 11;
  instance.chunksDecoded.value = 10;
  instance.chunksSkipped.value = 1;
  instance.catchUpFramesSkipped.value = 7;
  instance.catchUpPending.value = true;
  instance.decodeErrors.value = 2;
  instance.dynamicGroupsSupported.value = true;
  instance.newGroupRequestEnabled.value = true;

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.status, "connected");
  assert.equal(stats.statusMessage, "Subscribed");
  assert.equal(stats.httpVersion, "H3");
  assert.equal(stats.codec, "vp8");
  assert.equal(stats.decoderState, "configured");
  assert.equal(stats.decoderConfigured, true);
  assert.equal(stats.chunksCreated, 11);
  assert.equal(stats.chunksDecoded, 10);
  assert.equal(stats.chunksSkipped, 1);
  // relay の cache から追いつく途中の数と状態も、画面と同じ値を返す
  assert.equal(stats.catchUpFramesSkipped, 7);
  assert.equal(stats.catchUpPending, true);
  assert.equal(stats.decodeErrors, 2);
  assert.equal(stats.dynamicGroupsSupported, true);
  assert.equal(stats.newGroupRequestEnabled, true);
});

test("buildSubscriberStats: 音声の受信とデコード、再生の状態を返す", () => {
  // 音声だけの購読では映像の統計が 0 のままになるため、音声側の累積を別に読む
  const instance = createSubscriberInstance("audio-state");
  instance.audioObjectsReceived.value = 21;
  // datagram で届いた数は受信数の内数 (差が Subgroup で届いた数になる)
  instance.audioDatagramObjectsReceived.value = 8;
  instance.audioChunksDecoded.value = 20;
  instance.audioCatchUpObjectsSkipped.value = 6;
  // datagram の冗長化で届いた 2 個目を捨てた数と、順序逆転の数・戻り幅
  instance.duplicateObjectsDropped.value = 4;
  instance.outOfOrderObjectsReceived.value = 3;
  instance.maxOutOfOrderGroupDistance.value = 7;
  instance.audioDecoderConfigured.value = true;
  instance.audioPlaybackEnabled.value = true;

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audio.objectsReceived, 21);
  assert.equal(stats.audio.datagramObjectsReceived, 8);
  assert.equal(stats.audio.chunksDecoded, 20);
  assert.equal(stats.audio.catchUpObjectsSkipped, 6);
  // 重複と順序逆転は、datagram の冗長化と順序保証の無さを直接測る計器である
  assert.equal(stats.audio.duplicateObjectsDropped, 4);
  assert.equal(stats.audio.outOfOrderObjectsReceived, 3);
  assert.equal(stats.audio.maxOutOfOrderGroupDistance, 7);
  assert.equal(stats.audio.decoderConfigured, true);
  assert.equal(stats.audio.playbackEnabled, true);
});

test("buildSubscriberStats: 音声の再生の観測値を返す", () => {
  // 鳴るはずの時刻と鳴らなかった量は、音声の語尾が聞こえない症状を数値で確定させるために
  // 読む。E2E と実測スクリプトはこの値で、予定に間に合っていたかを切り分ける
  const instance = createSubscriberInstance("audio-playout-timing");
  const timing = {
    ...EMPTY_AUDIO_PLAYOUT_TIMING,
    lastTargetMs: 1_000,
    lastArrivalMs: 920,
    lastStartMs: 1_010,
    lastSlackMs: 80,
    lastStartDelayMs: 90,
    lastLatenessMs: 10,
    slackMs: { p50: 80, p95: 120, max: 400 },
    startDelayMs: { p50: 90, p95: 130, max: 410 },
    latenessMs: { p50: 10, p95: 10, max: 10 },
    playedFrames: 100,
    playedMs: 2_000,
    arrivalPlannedFrames: 5,
    unplannedFrames: 3,
    missedFrames: 2,
    missedMs: 40,
    missedByReason: {
      ...EMPTY_AUDIO_PLAYOUT_TIMING.missedByReason,
      lateness: { count: 2, ms: 40 },
    },
    // 補間で埋まらなかった無音の穴、予約の追い越し、バッファ境界の段差
    gapCount: 3,
    gapMs: 48,
    gapMaxMs: 22,
    unrecoverableGapCount: 1,
    unrecoverableGapMs: 20,
    lateStartCount: 1,
    lateStartMaxMs: 2,
    boundaryStepCount: 2,
    boundaryStepMax: 0.19,
  };
  instance.audioPlayoutTiming.value = timing;
  assert.deepEqual(buildSubscriberStats(instance).audio.playoutTiming, timing);
  // 購読前は何も記録していない値を返す
  assert.deepEqual(
    buildSubscriberStats(createSubscriberInstance("audio-playout-timing-empty")).audio
      .playoutTiming,
    EMPTY_AUDIO_PLAYOUT_TIMING,
  );
});

test("buildSubscriberStats: Audio Playback の穴・段差・drain・上限を JSON に出す", () => {
  // 画面の Audio Playback Timing と Audio に出していた値を、Copy for LLM の JSON でも
  // 同じ名前で読めるようにする。値はスナップショットをそのまま写し、上限と圧縮の速さだけ
  // A/V 同期の audioDelayFeedback から写す
  const instance = createSubscriberInstance("audio-playout-instruments");
  const playoutTiming = {
    ...EMPTY_AUDIO_PLAYOUT_TIMING,
    // 補間で埋まらなかった穴と、予約できなかった穴
    gapCount: 3,
    gapMs: 48.4,
    gapMaxMs: 21.9,
    unrecoverableGapCount: 2,
    unrecoverableGapMs: 30.2,
    // 予約の追い越しと押し直し
    lateStartCount: 1,
    lateStartMaxMs: 2.5,
    pushStartCount: 4,
    pushStartMaxMs: 6.5,
    // バッファ境界の段差
    boundaryStepCount: 2,
    boundaryStepMax: 0.19,
    // 停止時の drain
    lastDrain: {
      pendingMsAtStart: 80,
      requestedMs: 100,
      waitedMs: 90.5,
      playedMs: 70,
      cutMs: 10,
      flushedObjects: 0,
      undecodedFlushedObjects: 0,
    },
  };
  instance.audioPlayoutTiming.value = playoutTiming;
  instance.audioReceiveDelayMs.value = 120.5;
  instance.audioMaxReceiveDelayMs.value = 201.25;
  // 時間圧縮が続いて上限を 100 ms から 160 ms へ広げている状態。音声だけの購読でも
  // 読めるよう、A/V 同期ではなく音声の統計が持つ閉ループの値を使う
  instance.audioDelayFeedback.value = {
    ...EMPTY_AUDIO_DELAY_FEEDBACK,
    appliedCeilingMs: 160,
    compressionMsPerSecond: 20,
  };

  const stats = buildSubscriberStats(instance);
  // 音声の節に写した上限と圧縮の速さ
  assert.equal(stats.audio.appliedCeilingMs, 160, "適用中の上限を写すこと");
  assert.equal(stats.audio.compressionMsPerSecond, 20, "圧縮の速さを写すこと");
  // 既存の値 (playoutTiming 全体) は変えない
  assert.deepEqual(stats.audio.playoutTiming, playoutTiming);
  assert.equal(stats.audio.receiveDelayMs, 120.5, "到着の遅れを変えないこと");
  assert.equal(stats.audio.maxReceiveDelayMs, 201.25, "到着の遅れの最大を変えないこと");

  // Copy for LLM の JSON にも、画面と同じ値が出る
  const jsonText = JSON.stringify(stats);
  const json = JSON.parse(jsonText) as {
    audio: {
      receiveDelayMs: number;
      maxReceiveDelayMs: number;
      appliedCeilingMs: number;
      compressionMsPerSecond: number;
      audioDelayFeedback: {
        appliedMs: number;
        appliedCeilingMs: number;
        compressionMsPerSecond: number;
      };
      playoutTiming: {
        gapCount: number;
        gapMs: number;
        gapMaxMs: number;
        unrecoverableGapCount: number;
        unrecoverableGapMs: number;
        lateStartCount: number;
        lateStartMaxMs: number;
        pushStartCount: number;
        pushStartMaxMs: number;
        boundaryStepCount: number;
        boundaryStepMax: number;
        lastDrain: {
          playedMs: number;
          cutMs: number;
          waitedMs: number;
          requestedMs: number;
        } | null;
      };
    };
  };
  assert.equal(json.audio.receiveDelayMs, 120.5);
  assert.equal(json.audio.maxReceiveDelayMs, 201.25);
  assert.equal(json.audio.appliedCeilingMs, 160);
  assert.equal(json.audio.compressionMsPerSecond, 20);
  // 閉ループの内訳も音声の節にあり、音声だけの購読でも読める
  assert.equal(json.audio.audioDelayFeedback.appliedCeilingMs, 160);
  assert.equal(json.audio.audioDelayFeedback.compressionMsPerSecond, 20);
  assert.equal(
    json.audio.audioDelayFeedback.appliedMs,
    EMPTY_AUDIO_DELAY_FEEDBACK.appliedMs,
    "閉ループの内訳の既定値を変えないこと",
  );
  assert.deepEqual(json.audio.playoutTiming, {
    ...playoutTiming,
    // JSON へ直列化しても値は同じ (bigint などは無い)
    lastDrain: playoutTiming.lastDrain,
  });
});

test("buildSubscriberStats: 受信側の追いつきの判定値を JSON に出す", () => {
  // 表示と判定が食い違わないよう、判定に使う decodeLagMs と limitMs を JSON にも出す。
  // lagMs は入力の遅れと意図した遅延を含む生の値として残し、既存の値も変えない
  const instance = createSubscriberInstance("audio-catch-up-decision");
  const catchUp = {
    ...EMPTY_AUDIO_RECEIVE_CATCH_UP,
    lagMs: 92.5,
    inputLagMs: 20,
    decodeLagMs: 72.5,
    floorMs: 21.4,
    maxLagMs: 120.5,
    limitMs: 61.4,
    catchingUp: true,
    catchUpStarts: 1,
    skippedFrames: 2,
    skippedMs: 40,
    lastSkippedMs: 20,
  };
  instance.audioPlayoutCatchUp.value = catchUp;

  const stats = buildSubscriberStats(instance);
  assert.deepEqual(stats.audio.playoutCatchUp, catchUp);
  // Copy for LLM の JSON にも、判定に使う値と参考値の両方が出る
  const jsonText = JSON.stringify(stats);
  const json = JSON.parse(jsonText) as {
    audio: {
      playoutCatchUp: {
        lagMs: number | null;
        decodeLagMs: number | null;
        floorMs: number | null;
        maxLagMs: number | null;
        limitMs: number;
        catchingUp: boolean;
        catchUpStarts: number;
        skippedFrames: number;
        skippedMs: number;
        lastSkippedMs: number | null;
      };
    };
  };
  assert.equal(json.audio.playoutCatchUp.decodeLagMs, 72.5, "判定に使う遅れを出すこと");
  assert.equal(json.audio.playoutCatchUp.limitMs, 61.4, "判定に使う上限を出すこと");
  // 既存の値は変えない
  assert.equal(json.audio.playoutCatchUp.lagMs, 92.5);
  assert.equal(json.audio.playoutCatchUp.floorMs, 21.4);
  assert.equal(json.audio.playoutCatchUp.maxLagMs, 120.5);
  assert.equal(json.audio.playoutCatchUp.catchingUp, true);
  assert.equal(json.audio.playoutCatchUp.catchUpStarts, 1);
  assert.equal(json.audio.playoutCatchUp.skippedFrames, 2);
  assert.equal(json.audio.playoutCatchUp.skippedMs, 40);
  assert.equal(json.audio.playoutCatchUp.lastSkippedMs, 20);
});

test("buildSubscriberStats: メインスレッドの停止と到着の重なりを返す", () => {
  // 到着の遅れ (receiveDelayMs) には、経路と relay の遅れだけでなく、同じページの
  // メインスレッドが止まっていた分も混ざる。停止の回数・合計・停止と重なった到着の数を
  // コピー本文の JSON でも読めるようにする
  const instance = createSubscriberInstance("audio-host-delay");
  instance.audioHostDelay.value = {
    stallCount: 2,
    stallMs: 173.5,
    overlappedArrivalCount: 1,
  };

  const stats = buildSubscriberStats(instance);
  assert.deepEqual(stats.audio.hostDelay, instance.audioHostDelay.value);
  // Copy for LLM の JSON にも同じ値が出る
  const jsonText = JSON.stringify(stats);
  const json = JSON.parse(jsonText) as {
    audio: { hostDelay: { stallCount: number; stallMs: number; overlappedArrivalCount: number } };
  };
  assert.deepEqual(json.audio.hostDelay, {
    stallCount: 2,
    stallMs: 173.5,
    overlappedArrivalCount: 1,
  });

  // 購読前は何も観測していない値 (0) を返す
  assert.deepEqual(
    buildSubscriberStats(createSubscriberInstance("audio-host-delay-empty")).audio.hostDelay,
    EMPTY_HOST_DELAY,
  );
});

test("buildSubscriberStats: Largest Location の bigint を文字列にする", () => {
  // JSON シリアライズは bigint で例外になるため、文字列にして返す。
  // SubscriberPanel と E2E は同じ値を文字列として読む
  const instance = createSubscriberInstance("largest-location");
  instance.largestLocation.value = { group: 12n, object: 345n };
  assert.deepEqual(buildSubscriberStats(instance).largestLocation, {
    group: "12",
    object: "345",
  });

  instance.largestLocation.value = null;
  assert.equal(buildSubscriberStats(instance).largestLocation, null);
});

test("buildSubscriberStats: event timeline のメッセージを JSON にできる形で返す", () => {
  // audio / video 以外のデータ (draft-ietf-moq-msf-01 §8) として受信した entry を
  // そのまま返す。Location の bigint は Largest Location と同じく文字列にする
  const instance = createSubscriberInstance("event-messages");
  instance.eventObjectsReceived.value = 2;
  instance.eventMessages.value = [
    { t: 1000, data: { text: "hello" } },
    { l: [12n, 0n], data: { text: "linked" } },
  ];

  const stats = buildSubscriberStats(instance);

  assert.deepEqual(stats.event, { objectsReceived: 2, entries: 2 });
  assert.deepEqual(stats.eventMessages, [
    { t: 1000, data: { text: "hello" } },
    { l: ["12", "0"], data: { text: "linked" } },
  ]);
  // スナップショット全体も JSON にできる (テスト用 API から取り出す前提)
  assert.isString(JSON.stringify(stats));
});

test("buildSubscriberStats: Session と Catalog が無いときは null を返す", () => {
  // 未購読では getStatistics() を呼べないため null にする。コピー本文の整形は
  // null を "-" として出す
  const stats = buildSubscriberStats(createSubscriberInstance("no-session"));
  assert.equal(stats.sessionStatistics, null);
  assert.equal(stats.catalog, null);
});

test("buildPublisherStats: Catalog の bigint を文字列にして、JSON にできる形で返す", () => {
  // Catalog の Media Timeline Template は [bigint, bigint] を含む。JSON.stringify は
  // bigint で例外になるため、スナップショットの時点で文字列にする
  pub.catalog.value = {
    version: "draft-01",
    tracks: [
      {
        name: "video",
        packaging: "eventtimeline",
        isLive: true,
        template: [0, 40, [10n, 20n], [1n, 2n], 1_700_000_000_000, 40],
      },
    ],
  };

  try {
    const stats = buildPublisherStats();
    assert.equal(
      JSON.stringify(stats.catalog),
      '{"version":"draft-01","tracks":[{"name":"video","packaging":"eventtimeline","isLive":true,"template":[0,40,["10","20"],["1","2"],1700000000000,40]}]}',
    );
    // スナップショット全体も JSON にできる (テスト用 API から取り出す前提)
    assert.isString(JSON.stringify(stats));
  } finally {
    pub.catalog.value = null;
  }
});

test("buildPublisherStats: 配信前は既定値を返す", () => {
  // 配信していないページでも統計の形は同じにする (コピー本文は配信の有無で節を省く)
  const stats = buildPublisherStats();
  assert.equal(stats.status, "disconnected");
  assert.deepEqual(stats.publishTiming, EMPTY_PUBLISH_TIMING);
  assert.equal(stats.sessionStatistics, null);
  assert.equal(stats.catalog, null);
  // 音声トラックの PUBLISH はまだ無い
  assert.equal(stats.audio.publishing, false);
  assert.equal(stats.audio.lastSentLevel, null);
  assert.equal(stats.audio.lastSentVoiceActivity, null);
  // event timeline もまだ無い
  assert.equal(stats.event.publishing, false);
  assert.equal(stats.event.messagesSent, 0);
});

test("buildPublisherStats: event timeline に送ったメッセージの数を返す", () => {
  // 配信していない状態では実体を作れないため、送信数の signal だけを差し替えて写像を固定する
  const previousSent = pub.eventMessagesSent.value;
  pub.eventMessagesSent.value = 3;
  try {
    const stats = buildPublisherStats();
    assert.equal(stats.event.publishing, false);
    assert.equal(stats.event.messagesSent, 3);
  } finally {
    pub.eventMessagesSent.value = previousSent;
  }
});

test("buildPublisherStats: 符号化と送信の累積、状態、音声のメーターを返す", () => {
  // 画面の PublisherPanel とコピー本文が読む値を一巡させる
  pub.pubStatus.value = "connected";
  pub.pubStatusMessage.value = "Publishing";
  pub.httpVersion.value = "H2";
  pub.forwardState.value = true;
  pub.pubCodec.value = "vp8";
  pub.encoderState.value = "configured";
  pub.framesEncoded.value = 31;
  pub.keyFramesEncoded.value = 2;
  pub.chunksEncoded.value = 30;
  pub.encodeErrors.value = 1;
  pub.objectsSent.value = 29;
  pub.objectsWithExtensions.value = 3;
  pub.bytesSent.value = 12345;
  pub.pubCurrentGroup.value = 99;
  pub.newGroupRequestsReceived.value = 4;
  pub.audioObjectsSent.value = 12;
  pub.audioDatagramObjectsSent.value = 5;
  pub.audioBytesSent.value = 3456;
  pub.audioChunksEncoded.value = 13;
  pub.audioEncodeErrors.value = 1;
  pub.audioMeterPeakDbfsLeft.value = -6.5;
  pub.audioMeterRmsDbfsLeft.value = -12.25;
  pub.audioMeterPeakDbfsRight.value = -7.5;
  pub.audioMeterRmsDbfsRight.value = -13.25;
  pub.audioMeterLevel.value = { level: -20, voiceActivity: true };

  try {
    const stats = buildPublisherStats();
    assert.equal(stats.status, "connected");
    assert.equal(stats.statusMessage, "Publishing");
    assert.equal(stats.httpVersion, "H2");
    assert.equal(stats.forwardState, true);
    assert.equal(stats.codec, "vp8");
    assert.equal(stats.encoderState, "configured");
    assert.equal(stats.framesEncoded, 31);
    assert.equal(stats.keyFramesEncoded, 2);
    assert.equal(stats.chunksEncoded, 30);
    assert.equal(stats.encodeErrors, 1);
    assert.equal(stats.objectsSent, 29);
    assert.equal(stats.objectsWithExtensions, 3);
    assert.equal(stats.bytesSent, 12345);
    assert.equal(stats.currentGroup, 99);
    assert.equal(stats.newGroupRequests, 4);
    assert.equal(stats.audio.objectsSent, 12);
    assert.equal(stats.audio.datagramObjectsSent, 5);
    assert.equal(stats.audio.bytesSent, 3456);
    assert.equal(stats.audio.chunksEncoded, 13);
    assert.equal(stats.audio.encodeErrors, 1);
    assert.equal(stats.audio.meterPeakDbfs, -6.5);
    assert.equal(stats.audio.meterRmsDbfs, -12.25);
    assert.equal(stats.audio.meterPeakDbfsRight, -7.5);
    assert.equal(stats.audio.meterRmsDbfsRight, -13.25);
    assert.equal(stats.audio.lastSentLevel, -20);
    assert.equal(stats.audio.lastSentVoiceActivity, true);
  } finally {
    // 同じファイルの他のテストへ持ち越さない
    pub.pubStatus.value = "disconnected";
    pub.pubStatusMessage.value = "Ready to publish";
    pub.httpVersion.value = null;
    pub.forwardState.value = null;
    pub.pubCodec.value = "";
    pub.encoderState.value = "unconfigured";
    pub.framesEncoded.value = 0;
    pub.keyFramesEncoded.value = 0;
    pub.chunksEncoded.value = 0;
    pub.encodeErrors.value = 0;
    pub.objectsSent.value = 0;
    pub.objectsWithExtensions.value = 0;
    pub.bytesSent.value = 0;
    pub.pubCurrentGroup.value = 0;
    pub.newGroupRequestsReceived.value = 0;
    pub.audioObjectsSent.value = 0;
    pub.audioDatagramObjectsSent.value = 0;
    pub.audioBytesSent.value = 0;
    pub.audioChunksEncoded.value = 0;
    pub.audioEncodeErrors.value = 0;
    pub.audioMeterPeakDbfsLeft.value = null;
    pub.audioMeterRmsDbfsLeft.value = null;
    pub.audioMeterPeakDbfsRight.value = null;
    pub.audioMeterRmsDbfsRight.value = null;
    pub.audioMeterLevel.value = null;
  }
});

// 接続先の候補から選んだときはその URI、候補を使わないときは URI 欄の値を出す。
// Copy for LLM とテスト用 API で、どの relay へ繋いだかを確かめられるようにする
test("buildSubscriberStats / buildPublisherStats: 接続先の候補があればその URI、無ければ URI 欄の値を出す", () => {
  const urlBefore = settings.url.value;
  const selectedBefore = pub.pubSelectedServerUrl.value;
  try {
    settings.url.value = "moqt://typed.example:4443/";
    const instance = createSubscriberInstance("stats-server-url");

    // 候補を使わない接続では URI 欄の値
    instance.selectedServerUrl.value = null;
    pub.pubSelectedServerUrl.value = null;
    assert.equal(buildSubscriberStats(instance).serverUrl, "moqt://typed.example:4443/");
    assert.equal(buildPublisherStats().serverUrl, "moqt://typed.example:4443/");

    // 候補から選んだ接続では、その候補の URI
    instance.selectedServerUrl.value = "moqt://candidate.example:4443/";
    pub.pubSelectedServerUrl.value = "moqt://candidate.example:4443/";
    assert.equal(buildSubscriberStats(instance).serverUrl, "moqt://candidate.example:4443/");
    assert.equal(buildPublisherStats().serverUrl, "moqt://candidate.example:4443/");
  } finally {
    settings.url.value = urlBefore;
    pub.pubSelectedServerUrl.value = selectedBefore;
  }
});
