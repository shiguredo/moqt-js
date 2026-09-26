import { test, assert } from "vite-plus/test";
import * as settings from "./connectionSettings";
import { buildConnectionSettingsSnapshot } from "./connectionSettingsSnapshot";

// テストで書き換える設定を既定値へ戻す。set 系の signal は同じファイルの他のテストへ
// 持ち越したくない
function resetSettingSignals(): void {
  settings.url.value = "moqt://127.0.0.1:4443/";
  settings.fragment.value = "";
  settings.mode.value = "both";
  settings.namespace.value = "room/123";
  settings.trackName.value = "video";
  settings.codec.value = "vp8";
  settings.videoSource.value = "dummy";
  settings.selectedCameraDeviceId.value = "";
  settings.resolution.value = "1280x720";
  settings.framerate.value = 30;
  settings.bitrate.value = 2000000;
  settings.keyframeInterval.value = 60;
  settings.maxCacheDuration.value = 600000;
  settings.audioSource.value = "dummy";
  settings.audioDelivery.value = "subgroup";
  settings.audioCodec.value = "opus";
  settings.audioBitrate.value = 64000;
  settings.audioSampleRate.value = 48000;
  settings.audioChannels.value = 2;
  settings.selectedMicrophoneDeviceId.value = "";
  settings.selectedAudioOutputDeviceId.value = "";
  settings.audioEchoCancellation.value = true;
  settings.audioNoiseSuppression.value = true;
  settings.audioAutoGainControl.value = true;
  settings.targetLatency.value = null;
  settings.renderGroup.value = null;
  settings.catalogSubscriptionTimeout.value = 5000;
  settings.certificateHash.value = "";
  settings.authorizationTokenValue.value = "";
  settings.authorizationTokenBase64.value = "";
  settings.authorizationTokenType.value = "0";
  settings.authorizationTokenAliasType.value = "useValue";
  settings.authorizationTokenAlias.value = "0";
  settings.useDedicatedWorker.value = true;
  settings.jitterBufferEnabled.value = true;
}

test("buildConnectionSettingsSnapshot: 接続に使う設定をそのまま写す", () => {
  resetSettingSignals();
  settings.url.value = "moqt://relay.example:4443/";
  settings.fragment.value = "msf:room--video";
  settings.mode.value = "subscriber";
  settings.namespace.value = "room/456";
  settings.trackName.value = "audio";
  settings.codec.value = "h265";
  settings.videoSource.value = "camera";
  settings.selectedCameraDeviceId.value = "camera-1";
  settings.resolution.value = "1920x1080";
  settings.framerate.value = 60;
  settings.bitrate.value = 8000000;
  settings.keyframeInterval.value = 120;
  settings.maxCacheDuration.value = 30000;
  settings.audioSource.value = "microphone";
  settings.audioDelivery.value = "datagram";
  settings.audioCodec.value = "aac";
  settings.audioBitrate.value = 128000;
  settings.audioSampleRate.value = 44100;
  settings.audioChannels.value = 1;
  settings.selectedMicrophoneDeviceId.value = "mic-1";
  settings.selectedAudioOutputDeviceId.value = "speaker-1";
  settings.audioEchoCancellation.value = false;
  settings.audioNoiseSuppression.value = false;
  settings.audioAutoGainControl.value = false;
  settings.targetLatency.value = 100;
  settings.renderGroup.value = 1;
  settings.catalogSubscriptionTimeout.value = 3000;
  settings.certificateHash.value = "AQID";
  settings.useDedicatedWorker.value = false;
  settings.jitterBufferEnabled.value = false;

  try {
    const snapshot = buildConnectionSettingsSnapshot();
    assert.equal(snapshot.url, "moqt://relay.example:4443/");
    assert.equal(snapshot.fragment, "msf:room--video");
    assert.equal(snapshot.mode, "subscriber");
    assert.equal(snapshot.namespace, "room/456");
    assert.equal(snapshot.trackName, "audio");
    assert.equal(snapshot.codec, "h265");
    assert.equal(snapshot.videoSource, "camera");
    assert.equal(snapshot.cameraDeviceId, "camera-1");
    assert.equal(snapshot.resolution, "1920x1080");
    assert.equal(snapshot.framerateFps, 60);
    assert.equal(snapshot.bitrateBps, 8000000);
    assert.equal(snapshot.keyframeIntervalFrames, 120);
    assert.equal(snapshot.maxCacheDurationMs, 30000);
    assert.equal(snapshot.audioSource, "microphone");
    assert.equal(snapshot.audioDelivery, "datagram");
    assert.equal(snapshot.audioCodec, "aac");
    assert.equal(snapshot.audioBitrateBps, 128000);
    assert.equal(snapshot.audioSampleRateHz, 44100);
    assert.equal(snapshot.audioChannels, 1);
    assert.equal(snapshot.microphoneDeviceId, "mic-1");
    assert.equal(snapshot.audioOutputDeviceId, "speaker-1");
    assert.equal(snapshot.audioEchoCancellation, false);
    assert.equal(snapshot.audioNoiseSuppression, false);
    assert.equal(snapshot.audioAutoGainControl, false);
    assert.equal(snapshot.targetLatencyMs, 100);
    assert.equal(snapshot.renderGroup, 1);
    assert.equal(snapshot.catalogSubscriptionTimeoutMs, 3000);
    assert.equal(snapshot.certificateHash, "AQID");
    assert.equal(snapshot.useDedicatedWorker, false);
    assert.equal(snapshot.jitterBufferEnabled, false);
  } finally {
    resetSettingSignals();
  }
});

test("buildConnectionSettingsSnapshot: targetLatency と renderGroup の未指定は null のままにする", () => {
  // 0 は有効値 (catalog の targetLatency と同じ扱い)。未指定 (null) と 0 を区別できないと、
  // コピー本文から「指定したかどうか」が読めなくなる
  resetSettingSignals();

  try {
    assert.equal(buildConnectionSettingsSnapshot().targetLatencyMs, null);
    assert.equal(buildConnectionSettingsSnapshot().renderGroup, null);

    settings.targetLatency.value = 0;
    settings.renderGroup.value = 0;

    const snapshot = buildConnectionSettingsSnapshot();
    assert.equal(snapshot.targetLatencyMs, 0);
    assert.equal(snapshot.renderGroup, 0);
  } finally {
    resetSettingSignals();
  }
});

test("buildConnectionSettingsSnapshot: 認可トークンの値は入れず、設定の有無だけを入れる", () => {
  // コピーしたテキストは外部 (LLM など) へ渡す前提のため、値そのものは入れない。
  // 設定されているかどうかと種別だけを入れる
  resetSettingSignals();
  const tokenValue = "sentinel-token-value-must-not-appear";
  settings.authorizationTokenValue.value = tokenValue;
  settings.authorizationTokenType.value = "1";
  settings.authorizationTokenAliasType.value = "register";
  settings.authorizationTokenAlias.value = "7";

  try {
    const snapshot = buildConnectionSettingsSnapshot();
    assert.equal(snapshot.authorizationTokenConfigured, true);
    assert.equal(snapshot.authorizationTokenFromC4m, false);
    assert.equal(snapshot.authorizationTokenType, "1");
    assert.equal(snapshot.authorizationTokenAliasType, "register");
    assert.equal(snapshot.authorizationTokenAlias, "7");
    // スナップショットのどこにも値が現れない
    assert.notInclude(JSON.stringify(snapshot), tokenValue);
  } finally {
    resetSettingSignals();
  }
});

test("buildConnectionSettingsSnapshot: c4m から取り込んだトークンも値は入れず、URL と fragment では伏せ字にする", () => {
  // Relay URI と URI Fragment のどちらにも c4m を書ける。取り込んだ後も signal には
  // 残るため、テキストへ出す値 (スナップショット) の時点で伏せる
  resetSettingSignals();
  const c4mBase64 = "c2VudGluZWwtYzRtLXRva2Vu";
  const relayUri = `moqt://relay.example/moqt#msf:room-123--video&c4m=${c4mBase64}`;

  try {
    settings.url.value = relayUri;
    assert.isTrue(settings.applyC4mFromUrl(relayUri));

    const snapshot = buildConnectionSettingsSnapshot();
    assert.equal(snapshot.authorizationTokenConfigured, true);
    assert.equal(snapshot.authorizationTokenFromC4m, true);
    assert.equal(snapshot.url, "moqt://relay.example/moqt#msf:room-123--video&c4m=<redacted>");
    // スナップショットのどこにもトークンの値が現れない
    assert.notInclude(JSON.stringify(snapshot), c4mBase64);

    // fragment に貼り付けた場合も同じ
    settings.fragment.value = `msf:room-123--video&c4m=${c4mBase64}`;
    const withFragment = buildConnectionSettingsSnapshot();
    assert.equal(withFragment.fragment, "msf:room-123--video&c4m=<redacted>");
    assert.notInclude(JSON.stringify(withFragment), c4mBase64);
  } finally {
    resetSettingSignals();
  }
});
