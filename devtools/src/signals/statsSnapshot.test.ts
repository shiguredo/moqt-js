import { test, assert } from "vite-plus/test";
import { createSubscriberInstance, EMPTY_AV_SYNC } from "./subscriber";
import { EMPTY_PLAYBACK_TIMING } from "../utils/playbackTimingStats";
import { EMPTY_PUBLISH_TIMING } from "../utils/publishTimingStats";
import { buildPublisherStats, buildSubscriberStats } from "./statsSnapshot";
import * as pub from "./publisher";

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

  instance.audioPeakDbfs.value = -6;
  instance.audioRmsDbfs.value = -9;

  const stats = buildSubscriberStats(instance);
  assert.equal(stats.audio.peakDbfs, -6);
  assert.equal(stats.audio.rmsDbfs, -9);
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
  const instance = createSubscriberInstance("playback-timing");
  const timing = {
    ...EMPTY_PLAYBACK_TIMING,
    arrivalJitterMs: { p50: 1, p95: 20, max: 300 },
    latencyMs: { p50: 45, p95: 80, max: 1_200 },
    displayFps: 30,
    displayStalls: 4,
    displayStallMs: 900,
    displayQueueDrops: 2,
    playoutDelayMs: 40,
    lateFramesDropped: 3,
  };
  instance.playbackTiming.value = timing;
  assert.deepEqual(buildSubscriberStats(instance).playbackTiming, timing);
  // 購読前は何も記録していない値を返す
  assert.deepEqual(
    buildSubscriberStats(createSubscriberInstance("playback-timing-empty")).playbackTiming,
    EMPTY_PLAYBACK_TIMING,
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
  instance.audioDecoderConfigured.value = true;
  instance.audioPlaybackEnabled.value = true;

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audio.objectsReceived, 21);
  assert.equal(stats.audio.datagramObjectsReceived, 8);
  assert.equal(stats.audio.chunksDecoded, 20);
  assert.equal(stats.audio.catchUpObjectsSkipped, 6);
  assert.equal(stats.audio.decoderConfigured, true);
  assert.equal(stats.audio.playbackEnabled, true);
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
  pub.audioMeterPeakDbfs.value = -6.5;
  pub.audioMeterRmsDbfs.value = -12.25;
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
    assert.equal(stats.audio.meterPeakDbfs, -6.5);
    assert.equal(stats.audio.meterRmsDbfs, -12.25);
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
    pub.audioMeterPeakDbfs.value = null;
    pub.audioMeterRmsDbfs.value = null;
    pub.audioMeterLevel.value = null;
  }
});
