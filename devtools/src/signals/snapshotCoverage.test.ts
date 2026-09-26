import { test, assert } from "vite-plus/test";
import * as connectionSettings from "./connectionSettings";
import * as publisherSignals from "./publisher";
import { buildConnectionSettingsSnapshot } from "./connectionSettingsSnapshot";
import { buildPublisherStats, buildSubscriberStats } from "./statsSnapshot";
import { createSubscriberInstance } from "./subscriber";

/**
 * スナップショットの網羅
 *
 * 統計や設定の signal を足したのにスナップショットへ足し忘れると、画面には出るのに
 * 「Copy for LLM」のテキストには出ない、という食い違いが起きる (実際に音声の統計、
 * 同期の推定、Target Latency で起きた)。signal とスナップショットの対応をここで
 * 固定し、signal を足したら「出す」か「出さない理由」のどちらかを書くことを強制する。
 *
 * 対応は名前で見る。名前が違うものは `mapped` に書き、出さないものは `excluded` に
 * 理由を書く。`excluded` に書いた signal が消えたら、この表も直す必要がある。
 */

interface CoverageExpectation {
  /** signal 名 → スナップショットのキー (入れ子は "audio.lastLevel" の形) */
  mapped: Record<string, string>;
  /** スナップショットに入れない signal と、その理由 */
  excluded: Record<string, string>;
}

/** signal かどうか (computed も含む) */
function isSignal(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "peek" in value &&
    "subscribe" in value
  );
}

/** スナップショットのキーを集める。入れ子のオブジェクトは "audio.lastLevel" の形にする */
function collectSnapshotPaths(value: unknown, prefix: string, paths: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    paths.add(path);
    collectSnapshotPaths(child, path, paths);
  }
}

/** スナップショットへ出ていない signal を返す */
function findUncoveredSignals(
  source: Record<string, unknown>,
  snapshot: object,
  expectation: CoverageExpectation,
): string[] {
  const paths = new Set<string>();
  collectSnapshotPaths(snapshot, "", paths);

  const uncovered: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!isSignal(value)) {
      continue;
    }
    const mapped = expectation.mapped[name] ?? name;
    if (!paths.has(mapped) && expectation.excluded[name] === undefined) {
      uncovered.push(name);
    }
  }
  return uncovered;
}

/**
 * 除外した signal がスナップショットへ出ていないかを返す
 *
 * 除外リストに書いたままスナップショットへも出していると、除外の理由と実装が食い違う。
 */
function findUnexpectedInclusions(
  source: Record<string, unknown>,
  snapshot: object,
  expectation: CoverageExpectation,
): string[] {
  const paths = new Set<string>();
  collectSnapshotPaths(snapshot, "", paths);
  // 実在する signal だけを見る (消えた signal は findStaleExclusions が見る)
  return Object.keys(expectation.excluded).filter(
    (name) => paths.has(name) && isSignal(source[name]),
  );
}

/** 消えた signal を除外したままにしていないか (理由を書いた signal が実在するか) を返す */
function findStaleExclusions(
  source: Record<string, unknown>,
  expectation: CoverageExpectation,
): string[] {
  return Object.keys(expectation.excluded).filter(
    (name) => !(name in source) || !isSignal(source[name]),
  );
}

// 接続設定の signal の対応。値の signal は出さず、設定の有無だけを出す
const CONNECTION_SETTINGS_COVERAGE: CoverageExpectation = {
  mapped: {
    selectedCameraDeviceId: "cameraDeviceId",
    framerate: "framerateFps",
    bitrate: "bitrateBps",
    keyframeInterval: "keyframeIntervalFrames",
    maxCacheDuration: "maxCacheDurationMs",
    audioBitrate: "audioBitrateBps",
    audioSampleRate: "audioSampleRateHz",
    selectedMicrophoneDeviceId: "microphoneDeviceId",
    selectedAudioOutputDeviceId: "audioOutputDeviceId",
    targetLatency: "targetLatencyMs",
    catalogSubscriptionTimeout: "catalogSubscriptionTimeoutMs",
    // トークンの値は出さず、送るかどうかだけを出す
    authorizationTokenValue: "authorizationTokenConfigured",
    authorizationTokenBase64: "authorizationTokenFromC4m",
  },
  excluded: {
    savedServerUrl: "Save で覚えた Relay URI で、今の接続に使う値ではない",
    cameraDevices: "選べるカメラの一覧で、選んだ値は cameraDeviceId として出す",
    microphoneDevices: "選べる音声入力の一覧で、選んだ値は microphoneDeviceId として出す",
    audioOutputDevices: "選べる音声出力の一覧で、選んだ値は audioOutputDeviceId として出す",
    settingsDisabled: "他の接続が設定を使っている間の入力の状態で、設定の値ではない",
  },
};

// Publisher の signal の対応
const PUBLISHER_COVERAGE: CoverageExpectation = {
  mapped: {
    pubStatus: "status",
    pubStatusMessage: "statusMessage",
    pubCodec: "codec",
    pubCurrentGroup: "currentGroup",
    newGroupRequestsReceived: "newGroupRequests",
    publishTimingStats: "publishTiming",
    audioPublisher: "audio.publishing",
    audioMeterPeakDbfs: "audio.meterPeakDbfs",
    audioMeterRmsDbfs: "audio.meterRmsDbfs",
    audioMeterLevel: "audio.lastSentLevel",
  },
  excluded: {
    pubSession:
      "Session の実体 (制御ストリームとデータストリームの統計は sessionStatistics に出す)",
    publisher: "Publisher の実体。統計は objectsSent / bytesSent / currentGroup に出す",
    catalogPublisher: "Catalog 用の Publisher の実体。送った Catalog は catalog に出す",
    catalogGroup: "Catalog を送る Group ID。時刻由来の値で、診断に使わない",
    encoder: "エンコーダの実体。状態は encoderState、統計は framesEncoded / chunksEncoded に出す",
    mediaStream: "映像の MediaStream の実体 (統計ではない)",
    isPreviewActive: "画面のプレビューを出しているかどうか",
    isStopping: "停止処理の途中かどうか (一時的な状態)",
    isStarting: "開始処理の途中かどうか (一時的な状態)",
    hasActivePublisher: "pubSession と isStarting から求まる computed",
    isPublishing: "publisher と audioPublisher から求まる computed",
    frameReader: "映像の読み取りの実体 (統計ではない)",
    videoWallClock: "LOC TIMESTAMP の時刻換算の実体 (統計ではない)",
    publishTimingUpdatedAtMs: "画面へ反映する間隔を測るための値",
    framesSinceKeyFrame: "キーフレームの間隔を数える途中の値",
    newGroupRequested: "NEW_GROUP_REQUEST を処理している途中かどうか",
    videoStreamCleanup: "映像の後始末の実体 (統計ではない)",
    keyframeInterval: "接続設定の keyframeIntervalFrames と同じ値を配信側が持っている",
    pubCurrentObjectId: "Object ID の採番の途中の値",
    audioEncoder: "音声のエンコーダの実体。音声の送信状態は audio に出す",
    audioStream: "音声の MediaStream の実体 (統計ではない)",
    audioStreamCleanup: "音声の後始末の実体 (統計ではない)",
    audioFrameReader: "音声の読み取りの実体 (統計ではない)",
    audioLevelTimeline: "LOC Audio Level の算出の実体。直近の値は audio.lastSentLevel に出す",
    audioMeterWaveform: "波形の配列は大きく、コピーする統計ではない",
    pubCurrentAudioGroup: "音声の Group ID。時刻由来の値で、診断に使わない",
    pubAudioGroupStarted: "音声の Group の採番の途中の状態",
    lastSentAudioConfig: "Audio Config のバイナリ",
    audioConfigResendRequested: "Audio Config の送り直しの要求の状態",
  },
};

// Subscriber インスタンスの signal の対応
const SUBSCRIBER_COVERAGE: CoverageExpectation = {
  mapped: {
    audioLastLevel: "audio.lastLevel",
    audioObjectsReceived: "audio.objectsReceived",
    audioDatagramObjectsReceived: "audio.datagramObjectsReceived",
    audioChunksDecoded: "audio.chunksDecoded",
    audioCatchUpObjectsSkipped: "audio.catchUpObjectsSkipped",
    audioDecoderConfigured: "audio.decoderConfigured",
    audioPlaybackEnabled: "audio.playbackEnabled",
    audioPeakDbfs: "audio.peakDbfs",
    audioRmsDbfs: "audio.rmsDbfs",
    audioPlayoutRebases: "audio.playoutRebases",
    audioPlayoutDrops: "audio.playoutDrops",
  },
  excluded: {
    session: "Session の実体。制御ストリームとデータストリームの統計は sessionStatistics に出す",
    subscriber: "映像の Subscriber の実体。状態は status / codec に出す",
    catalogSubscriber: "Catalog 用の Subscriber の実体。受けた Catalog は catalog に出す",
    decoder: "映像のデコーダの実体。状態は decoderState / decoderConfigured に出す",
    isStopping: "停止処理の途中かどうか (一時的な状態)",
    isStarting: "開始処理の途中かどうか (一時的な状態)",
    audioSubscriber: "音声の Subscriber の実体。状態は audio.decoderConfigured などに出す",
    audioDecoder: "音声のデコーダの実体。状態は audio.decoderConfigured に出す",
    audioWaveform: "波形の配列は大きく、コピーする統計ではない",
  },
};

test("ConnectionSettingsSnapshot: 接続設定の signal を網羅する", () => {
  // 以前、Target Latency / Render Group と音声の設定がコピー本文から抜けていた。
  // 設定を足したら、このスナップショットへ足すか、出さない理由を書く
  assert.deepEqual(
    findUncoveredSignals(
      connectionSettings,
      buildConnectionSettingsSnapshot(),
      CONNECTION_SETTINGS_COVERAGE,
    ),
    [],
  );
  assert.deepEqual(findStaleExclusions(connectionSettings, CONNECTION_SETTINGS_COVERAGE), []);
  assert.deepEqual(
    findUnexpectedInclusions(
      connectionSettings,
      buildConnectionSettingsSnapshot(),
      CONNECTION_SETTINGS_COVERAGE,
    ),
    [],
  );
});

test("PublisherStats: publisher の signal を網羅する", () => {
  assert.deepEqual(
    findUncoveredSignals(publisherSignals, buildPublisherStats(), PUBLISHER_COVERAGE),
    [],
  );
  assert.deepEqual(findStaleExclusions(publisherSignals, PUBLISHER_COVERAGE), []);
  assert.deepEqual(
    findUnexpectedInclusions(publisherSignals, buildPublisherStats(), PUBLISHER_COVERAGE),
    [],
  );
});

test("SubscriberStats: Subscriber インスタンスの signal を網羅する", () => {
  // 以前、同期の推定と音声の統計がコピー本文から抜けていた
  const instance = createSubscriberInstance("coverage");
  assert.deepEqual(
    findUncoveredSignals(
      instance as unknown as Record<string, unknown>,
      buildSubscriberStats(instance),
      SUBSCRIBER_COVERAGE,
    ),
    [],
  );
  assert.deepEqual(
    findStaleExclusions(instance as unknown as Record<string, unknown>, SUBSCRIBER_COVERAGE),
    [],
  );
  assert.deepEqual(
    findUnexpectedInclusions(
      instance as unknown as Record<string, unknown>,
      buildSubscriberStats(instance),
      SUBSCRIBER_COVERAGE,
    ),
    [],
  );
});
