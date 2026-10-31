/** ブラウザー API を置き換えず、実 Context の準備、初期化、終了と失敗通知を検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("購読者の実 Context を準備し、時計を初期化して累積の圧縮量を残す", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      { namespace: ["audio-output"], audio: {} },
      {},
    );
    const control = subscriber as unknown as {
      createOutputStream(): Promise<void>;
      audioTrackInfo: object;
      audioOutput: { context: AudioContext; destination: MediaStreamAudioDestinationNode };
      playout: import("../../src/playout/mediaPlayout").MediaPlayout;
    };
    const playout = control.playout as unknown as {
      audio: { session: import("../../src/playout/audioPlayoutSession").AudioPlayoutSession };
    };
    const scheduler = playout.audio.session.playout;
    scheduler.schedule(10, 0, 0.02, {
      targetStartSeconds: 10.2,
      enforceTarget: true,
      arrivalSeconds: 10,
      delaySeconds: 0.3,
      arrivalDelaySeconds: 0.05,
      presentationDelaySeconds: 0.05,
    });
    scheduler.schedule(10, 20000, 0.02, {
      targetStartSeconds: 10.1,
      enforceTarget: true,
      arrivalSeconds: 10,
      delaySeconds: 0.3,
      arrivalDelaySeconds: 0.05,
      presentationDelaySeconds: 0.05,
    });
    scheduler.confirmStretch(0.005);
    const before = scheduler.compressed;
    playout.audio.session.clock.update(null, 12.5, 4000);
    control.audioTrackInfo = {
      name: "audio",
      packaging: "loc",
      isLive: true,
      codec: "opus",
      samplerate: 44100,
    };
    try {
      await control.createOutputStream();
      const offset = playout.audio.session.clock.currentOffsetMs;
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfFrames: 960,
        numberOfChannels: 1,
        timestamp: 0,
        data: new Float32Array(960).fill(0.1),
      });
      control.playout.trackAudioDecodeInput(0, { timestampKind: "mediaTime" });
      const status = control.playout.pushAudio(data).status;
      data.close();
      return {
        before,
        after: scheduler.compressed,
        offset,
        status,
        sampleRate: control.audioOutput.context.sampleRate,
        tracks: control.audioOutput.destination.stream.getAudioTracks().length,
      };
    } finally {
      await subscriber.close();
    }
  });
  assert.ok(result.before > 0, "初期化前に圧縮の実績を持つこと");
  assert.equal(result.after, result.before, "Context を作り直しても実績を消さないこと");
  assert.equal(result.offset, null, "旧 Context の時計を残さないこと");
  assert.equal(result.status, "played", "準備した実音声出力へ投入できること");
  assert.equal(result.sampleRate, 48000, "Opus の実際の復号レートで出力すること");
  assert.equal(result.tracks, 1, "実 MediaStream に音声トラックを持つこと");
});

for (const notificationThrows of [false, true]) {
  test(`実 Context の resume 失敗を通知し、通知が throw しても rejection を残さない ${notificationThrows}`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, notificationThrows }) => {
        const { resumeAudioOutput } = await import(
          new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
        );
        const context = new AudioContext();
        await context.close();
        const errors: string[] = [],
          unhandled: string[] = [];
        const listener = (event: PromiseRejectionEvent): void => {
          unhandled.push(String(event.reason));
          event.preventDefault();
        };
        window.addEventListener("unhandledrejection", listener);
        try {
          resumeAudioOutput(context, (error: Error) => {
            errors.push(error.name);
            if (notificationThrows) throw new Error("notification failed");
          });
          const deadline = performance.now() + 2000;
          while (errors.length === 0) {
            if (performance.now() > deadline)
              throw new Error("resume の失敗通知を受け取れませんでした");
            await new Promise((resolve) => {
              setTimeout(resolve, 1);
            });
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          return { errors, unhandled };
        } finally {
          window.removeEventListener("unhandledrejection", listener);
        }
      },
      { notificationThrows },
    );
    assert.equal(result.errors.length, 1, "実 API の失敗を 1 回通知すること");
    assert.deepEqual(result.unhandled, [], "未処理の rejection を残さないこと");
  });
}

test("準備前と非有限 PCM の失敗で、後続の正常音に余分な遅延を残さない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const context = new AudioContext({ sampleRate: 48000 });
    const playout = createMediaPlayout({ audio: { context, destination: context.destination } });
    const push = (timestamp: number, value: number): string => {
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfFrames: 960,
        numberOfChannels: 1,
        timestamp,
        data: new Float32Array(960).fill(value),
      });
      try {
        playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
        return playout.pushAudio(data).status;
      } finally {
        data.close();
      }
    };
    try {
      await context.resume();
      const before = push(0, 0.1);
      await playout.prepareAudio();
      const invalid = push(20000, Number.NaN);
      const valid = push(40000, 0.1);
      const stats = playout.getStats().audio;
      await playout.drainAudio();
      return {
        before,
        invalid,
        valid,
        delay: stats?.timing.lastStartDelayMs,
        played: stats?.timing.playedFrames,
      };
    } finally {
      playout.setAudioOutput(null);
      await context.close();
    }
  });
  assert.equal(result.before, "error", "準備前の入力を成功した再生として扱わないこと");
  assert.equal(result.invalid, "error", "非有限 PCM を出力しないこと");
  assert.equal(result.valid, "played");
  assert.equal(result.played, 1, "正常な音だけを予約すること");
  assert.ok((result.delay ?? Infinity) < 65, `失敗した音の予約を持ち越さないこと: ${result.delay}`);
});

// 出力のレート解決も実 Context で確認する。グローバルの API を置き換えない。
for (const setting of [
  { codec: "mp4a.40.2", sampleRate: 44100, expected: 44100 },
  { codec: null, sampleRate: null, expected: 48000 },
]) {
  test(`Catalog の音声形式に対応する実出力レートを選ぶ ${setting.codec ?? "未解決"}`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, setting }) => {
        const { MediaSubscriberImpl } = await import(
          new URL("./createMediaSubscriber.ts", moduleUrl).href
        );
        const subscriber = new MediaSubscriberImpl(
          "https://localhost.invalid",
          { namespace: ["audio-rate"], audio: {} },
          {},
        );
        const control = subscriber as unknown as {
          createOutputStream(): Promise<void>;
          audioTrackInfo: object;
          audioOutput: { context: AudioContext };
        };
        control.audioTrackInfo = {
          name: "audio",
          packaging: "loc",
          isLive: true,
          ...(setting.codec === null
            ? {}
            : { codec: setting.codec, samplerate: setting.sampleRate }),
        };
        try {
          await control.createOutputStream();
          return control.audioOutput.context.sampleRate;
        } finally {
          await subscriber.close();
        }
      },
      { setting },
    );
    assert.equal(result, setting.expected, "Catalog と復号形式に対応するレートで作ること");
  });
}
