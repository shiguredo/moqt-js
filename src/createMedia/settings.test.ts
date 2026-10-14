import { test, assert } from "vite-plus/test";
import {
  DEFAULT_AUDIO_TRACK_NAME,
  DEFAULT_VIDEO_TRACK_NAME,
  withCapturedAudioFormat,
  resolveAudioPublishSettings,
  resolveVideoPublishSettings,
} from "./settings";
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_FRAMERATE,
} from "../codec/config";

// トラック名・コーデック文字列・既定値の解決を固定する。
// Catalog とエンコーダーが同じ値を使うための解決ロジックであり、
// ここが変わると両者の整合が崩れる。
test("resolveAudioPublishSettings: 省略時は既定値を使う", () => {
  const settings = resolveAudioPublishSettings({ codec: "opus", bitrate: 64000 });
  assert.equal(settings.trackName, DEFAULT_AUDIO_TRACK_NAME);
  assert.equal(settings.codec, "opus");
  assert.equal(settings.codecString, "opus");
  assert.equal(settings.bitrate, 64000);
  assert.equal(settings.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(settings.channels, DEFAULT_AUDIO_CHANNELS);
  // 音声 Object の送り方の既定は Subgroup (後方互換)
  assert.equal(settings.delivery, "subgroup");
});

// 音声 Object の送り方 (draft-ietf-moq-transport-22 §11) は指定どおりに解決する。
// datagram を送れるかはセッションの reliability で決まるため、ここでは判定しない
test("resolveAudioPublishSettings: delivery を指定どおりに解決する", () => {
  const settings = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64000,
    delivery: "datagram",
  });
  assert.equal(settings.delivery, "datagram");
});

// 明示値はそのまま反映され、aac の codec 文字列は mp4a.40.2 になる。
test("resolveAudioPublishSettings: 明示値と aac の codec 文字列", () => {
  const settings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 128000,
    sampleRate: 16000,
    channels: 1,
    trackName: "audio-1",
  });
  assert.equal(settings.trackName, "audio-1");
  assert.equal(settings.codecString, "mp4a.40.2");
  assert.equal(settings.sampleRate, 16000);
  assert.equal(settings.channels, 1);
});

// 取り出し経路が返した形式は、要求値と違っても Catalog とエンコーダーの設定になる。
// Chromium の AudioEncoder は AudioData の形式が設定と違うとエラーにするため、
// ここで写し替えないと符号化が止まる (マイクがモノラルの例)
test("withCapturedAudioFormat: 取り出した形式を設定へ写す", () => {
  const requested = resolveAudioPublishSettings({ codec: "opus", bitrate: 64000 });
  const captured = withCapturedAudioFormat(requested, { sampleRate: 44100, channels: 1 });
  assert.equal(captured.sampleRate, 44100);
  assert.equal(captured.channels, 1);
  // 形式以外は要求どおりのまま (Catalog の codec / bitrate / delivery が変わらない)
  assert.equal(captured.trackName, DEFAULT_AUDIO_TRACK_NAME);
  assert.equal(captured.codec, "opus");
  assert.equal(captured.codecString, "opus");
  assert.equal(captured.bitrate, 64000);
  assert.equal(captured.delivery, "subgroup");
  // 呼び出し元の設定は書き換えない (写した結果は新しい値として返す)
  assert.equal(requested.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(requested.channels, DEFAULT_AUDIO_CHANNELS);
});

// トラックが無い場合は 640x480 / 既定 framerate にフォールバックする。
test("resolveVideoPublishSettings: トラック未指定は 640x480 にフォールバックする", () => {
  const settings = resolveVideoPublishSettings({ codec: "vp8", bitrate: 1000000 }, undefined);
  assert.equal(settings.trackName, DEFAULT_VIDEO_TRACK_NAME);
  assert.equal(settings.codecString, "vp8");
  assert.equal(settings.width, 640);
  assert.equal(settings.height, 480);
  assert.equal(settings.framerate, DEFAULT_VIDEO_FRAMERATE);
});

// 明示値はトラック設定より優先される。
test("resolveVideoPublishSettings: 明示値が優先される", () => {
  const settings = resolveVideoPublishSettings(
    { codec: "h264", bitrate: 2000000, width: 1280, height: 720, framerate: 15 },
    undefined,
  );
  assert.equal(settings.codecString, "avc1.42001f");
  assert.equal(settings.width, 1280);
  assert.equal(settings.height, 720);
  assert.equal(settings.framerate, 15);
});
