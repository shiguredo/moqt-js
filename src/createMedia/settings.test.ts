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
  // 音声 Object の送り方の既定は Datagram。datagram は再送されないため、損失に備えるには
  // redundancy を 2 以上にする必要がある (既定の冗長度は 1 のまま)。datagram が reliable and
  // ordered になるセッションでの可否はここでは判定せず、createMediaPublisher の start が拒否する
  assert.equal(settings.delivery, "datagram");
});

// 音声 Object の送り方 (draft-ietf-moq-transport-22 §11) は指定どおりに解決する。
// datagram を送れるかはセッションの reliability で決まるため、ここでは判定しない
test("resolveAudioPublishSettings: delivery を指定どおりに解決する", () => {
  const datagram = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64000,
    delivery: "datagram",
  });
  assert.equal(datagram.delivery, "datagram");
  const subgroup = resolveAudioPublishSettings({
    codec: "opus",
    bitrate: 64000,
    delivery: "subgroup",
  });
  assert.equal(subgroup.delivery, "subgroup");
});

// 冗長化は datagram の送信経路でしか実装していない。datagram では 2 以上を受け付け、
// 何回送るかをそのまま解決する。既定の配送方式も datagram なので、delivery の省略でも
// 2 以上を指定できる。
test("resolveAudioPublishSettings: datagram では冗長度 2 以上を解決する", () => {
  for (const delivery of ["datagram", undefined] as const) {
    for (const redundancy of [2, 3]) {
      const settings = resolveAudioPublishSettings({
        codec: "opus",
        bitrate: 64000,
        ...(delivery === undefined ? {} : { delivery }),
        redundancy,
      });
      assert.equal(settings.redundancy, redundancy, "指定した冗長度をそのまま返すこと");
      assert.equal(
        settings.delivery,
        "datagram",
        delivery === undefined ? "省略時は Datagram になること" : "指定した delivery を返すこと",
      );
    }
  }
});

// subgroup 配送は Data Stream が FIN で閉じる限り再送されるため、冗長化の意味が無い
// (RESET された場合は欠落し得る)。指定を黙って無視すると
// 利用者が冗長化されていると誤解するため、start() で拒否する。
test("resolveAudioPublishSettings: subgroup で冗長度 2 以上を指定するとエラーになる", () => {
  assert.throws(
    () =>
      resolveAudioPublishSettings({
        codec: "opus",
        bitrate: 64000,
        delivery: "subgroup",
        redundancy: 2,
      }),
    /redundancy must be 1 when delivery is "subgroup"/,
    "subgroup 配送では冗長度 2 を拒否すること",
  );
});

// 冗長度 1 はどの配送方式でも受け付ける (既定値でもある)。
test("resolveAudioPublishSettings: 冗長度 1 は subgroup でも受け付ける", () => {
  for (const delivery of ["subgroup", "datagram"] as const) {
    const settings = resolveAudioPublishSettings({
      codec: "opus",
      bitrate: 64000,
      delivery,
      redundancy: 1,
    });
    assert.equal(settings.redundancy, 1, "冗長度 1 をそのまま返すこと");
  }
});

// 冗長度の範囲 (1〜3 の整数) の検証は配送方式に関係なく行う。
test("resolveAudioPublishSettings: 冗長度の範囲外は配送方式に関係なくエラーになる", () => {
  for (const redundancy of [0, 4, 1.5]) {
    assert.throws(
      () =>
        resolveAudioPublishSettings({
          codec: "opus",
          bitrate: 64000,
          delivery: "datagram",
          redundancy,
        }),
      /redundancy must be an integer between 1 and 3/,
      "1〜3 の整数以外を拒否すること",
    );
  }
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
  assert.equal(captured.delivery, "datagram");
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
