/// <reference types="node" />
import assert from "node:assert/strict";
import { test, type Page } from "@playwright/test";
import { DEVTOOLS_URL } from "../urls";
import { createTestNamespace, registerMoqtUriCandidate, requireRelayUri } from "./support";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import type { MoqtDevToolsApi } from "../../../devtools/src/testApi";
import type { SubscriberInstance } from "../../../devtools/src/signals/subscriber";

// マイクとカメラの代わりに実 Web Audio と canvas の生成器を配信する。
// API は置き換えず、音声トラックの enabled / stop を操作して無音と途絶を作る。
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/** 配信・受信・表示と画素の更新を同時に読み、止まった段を区別する。 */
async function readProgress(page: Page) {
  return page.evaluate(() => {
    const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
    const publisher = api.getPublisher();
    const subscriber = api.getSubscribers()[0];
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="subscriber-video-canvas"]',
    );
    const context = canvas?.getContext("2d");
    if (subscriber === undefined || canvas === null || !context) {
      throw new Error("Video observation is unavailable");
    }
    // 全画素を保存せず、実際に描かれた映像の変化をハッシュで観測する。
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 16) {
      hash = Math.imul(hash ^ (pixels[index] ?? 0), 16777619);
    }
    return {
      atMs: performance.now(),
      visible: document.visibilityState,
      videoSent: publisher.objectsSent,
      videoReceived: subscriber.objectsReceived,
      videoDecodeCalls: subscriber.chunksDecoded,
      videoDisplayed: subscriber.framesDecoded,
      audioReceived: subscriber.audio.objectsReceived,
      audioDecoded: subscriber.audio.chunksDecoded,
      audioPlayed: subscriber.audio.playoutTiming.playedFrames,
      audioPeakDbfs: subscriber.audio.peakDbfs,
      playbackEnabled: subscriber.audio.playbackEnabled,
      decodeErrors: subscriber.decodeErrors,
      hash,
    };
  });
}

/** 短い一時停止も累積値に隠れないよう、各 500 ms の進行を検査する。 */
async function measureProgress(page: Page, name: string) {
  const rows = [await readProgress(page)];
  for (let index = 0; index < 12; index++) {
    await page.waitForTimeout(500);
    rows.push(await readProgress(page));
  }
  await test.info().attach(`${name}.json`, {
    body: JSON.stringify(rows, null, 2),
    contentType: "application/json",
  });
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    assert.ok(previous && current);
    const seconds = (current.atMs - previous.atMs) / 1000;
    assert.equal(current.visible, "visible", "前面のページで表示を計測すること");
    for (const key of [
      "videoSent",
      "videoReceived",
      "videoDecodeCalls",
      "videoDisplayed",
    ] as const) {
      assert.ok(
        (current[key] - previous[key]) / seconds >= 15,
        `${name}: ${key} が無音でも進むこと: ${JSON.stringify({ previous, current })}`,
      );
    }
    assert.notEqual(current.hash, previous.hash, `${name}: 映像の画素も更新されること`);
    assert.equal(current.decodeErrors, 0, `${name}: 復号エラーがないこと`);
  }
  return rows;
}

/** DevTools 自身の配信と購読を開始し、立ち上がりの cache 追いつきを除外する。 */
async function startBoth(
  page: Page,
  audioSource: "dummy" | "none",
  extraParams: Record<string, string> = {},
) {
  const relayUri = requireRelayUri();
  if (relayUri === null) return false;
  const namespace = formatTrackNamespace(createTestNamespace());
  const params = new URLSearchParams({
    mode: "both",
    namespace,
    codec: "vp9",
    resolution: "1280x720",
    keyframeInterval: "10",
    audioSource,
    ...extraParams,
  });
  await page.goto(`${DEVTOOLS_URL}?${params.toString()}`);
  await registerMoqtUriCandidate(page, relayUri);
  await page.getByTestId("publisher-publish-button").click();
  // 配信側が最初の catalog と映像を送る前に購読を始め、準備待ちで失敗しないようにする。
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
      return api.getPublisher().objectsSent > 0;
    },
    undefined,
    { timeout: 30000 },
  );
  await page.getByTestId("subscriber-subscribe-button").click();
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
      return (api.getSubscribers()[0]?.framesDecoded ?? 0) > 30;
    },
    undefined,
    { timeout: 30000 },
  );
  return true;
}

for (const phase of ["starting", "playing"] as const) {
  test(`出力機器の選択失敗後も復号前遅延の接続を保ち、音声と映像を再生する (${phase === "starting" ? "開始時" : "再生中"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    if (!(await startBoth(page, "dummy", { preDecodeDelayMs: "500" }))) return;
    try {
      const configuredDelay = await page.evaluate(async () => {
        const moduleUrl = "/src/signals/connectionSettings.ts";
        const settings = await import(moduleUrl);
        return settings.preDecodeDelayMs.value;
      });
      assert.equal(configuredDelay, 500, "復号前遅延が実際に設定されていること");
      if (phase === "playing") {
        await page.getByTestId("subscriber-audio-playback-toggle").click();
        await page.waitForFunction(
          () => {
            const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
            return (api.getSubscribers()[0]?.audio.playoutTiming.playedFrames ?? 0) > 30;
          },
          undefined,
          { timeout: 10000 },
        );
      }
      const before = await readProgress(page);
      // 存在しない機器を実 AudioContext に指定し、ブラウザ本体のエラーを通す。
      await page.evaluate(async () => {
        const moduleUrl = "/src/signals/connectionSettings.ts";
        const settings = await import(moduleUrl);
        settings.selectedAudioOutputDeviceId.value = `missing-output-${crypto.randomUUID()}`;
      });
      if (phase === "starting") await page.getByTestId("subscriber-audio-playback-toggle").click();
      await page.waitForFunction(
        () => {
          const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
          const subscriber = api.getSubscribers()[0];
          return (
            subscriber !== undefined &&
            !subscriber.audio.playbackEnabled &&
            subscriber.audioOutput.contextState === null
          );
        },
        undefined,
        { timeout: 5000 },
      );
      await page.evaluate(async () => {
        const moduleUrl = "/src/signals/connectionSettings.ts";
        const settings = await import(moduleUrl);
        settings.selectedAudioOutputDeviceId.value = "";
      });
      // 失敗時に flush した古い入力の増分だけで復帰を判定しない。
      await page.waitForTimeout(1000);
      const paused = await readProgress(page);
      await page.getByTestId("subscriber-audio-playback-toggle").click();
      // トグルだけの復帰では成功させない。復号前キューから新しい音声が届く必要がある。
      await page.waitForFunction(
        (previous) => {
          const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
          const subscriber = api.getSubscribers()[0];
          return (
            subscriber !== undefined &&
            subscriber.audio.playbackEnabled &&
            subscriber.audio.chunksDecoded > previous.audioDecoded + 30 &&
            subscriber.audio.playoutTiming.playedFrames > previous.audioPlayed + 30 &&
            subscriber.framesDecoded > previous.videoDisplayed + 10
          );
        },
        paused,
        { timeout: 5000 },
      );
      const after = await readProgress(page);
      assert.equal(after.decodeErrors, 0, "音声を再開しても映像の復号を継続すること");
      await test.info().attach("output-device-recovery.json", {
        body: JSON.stringify({ before, after }),
        contentType: "application/json",
      });
    } finally {
      await page.getByTestId("subscriber-stop-button").click();
      await page.getByTestId("publisher-stop-button").click();
    }
  });
}

test("音声トラックなしでも音声再生の ON / OFF に依存せず映像を表示する", async ({ page }) => {
  test.setTimeout(90000);
  if (!(await startBoth(page, "none"))) return;
  try {
    await measureProgress(page, "video-only-playback-off");
    await page.getByTestId("subscriber-audio-playback-toggle").click();
    const rows = await measureProgress(page, "video-only-playback-on");
    assert.ok(rows.every((row) => row.audioReceived === 0 && row.audioDecoded === 0));
  } finally {
    await page.getByTestId("subscriber-stop-button").click();
    await page.getByTestId("publisher-stop-button").click();
  }
});

test("音声を無音化・復帰・停止しても映像の配信と表示を継続する", async ({ page }) => {
  test.setTimeout(120000);
  if (!(await startBoth(page, "dummy"))) return;
  const changeAudio = async (state: "silent" | "audible" | "stopped") => {
    await page.evaluate(async (next) => {
      const moduleUrl = "/src/signals/publisher.ts";
      const publisher = (await import(moduleUrl)) as {
        audioStream: { value: MediaStream | null };
      };
      const track = publisher.audioStream.value?.getAudioTracks()[0];
      if (track === undefined) throw new Error("Published audio track is unavailable");
      if (next === "stopped") track.stop();
      else track.enabled = next === "audible";
    }, state);
  };
  try {
    await changeAudio("silent");
    await page.getByTestId("subscriber-audio-playback-toggle").click();
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
        const audio = api.getSubscribers()[0]?.audio;
        return audio?.peakDbfs !== null && (audio?.peakDbfs ?? 0) < -70;
      },
      undefined,
      { timeout: 10000 },
    );
    const silent = await measureProgress(page, "silent-audio");
    assert.ok(silent.every((row) => row.audioPeakDbfs !== null && row.audioPeakDbfs < -70));
    await changeAudio("audible");
    // 無音化だけが成功して音が復帰しない測定を、比較の対照として採用しない。
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
        return (api.getSubscribers()[0]?.audio.peakDbfs ?? -100) > -30;
      },
      undefined,
      { timeout: 10000 },
    );
    await measureProgress(page, "audible-audio");
    await changeAudio("silent");
    await measureProgress(page, "silent-again");
    await changeAudio("stopped");
    await measureProgress(page, "audio-track-stopped");
    await page.getByTestId("subscriber-audio-playback-toggle").click();
    await measureProgress(page, "audio-playback-off");
  } finally {
    await page.getByTestId("subscriber-stop-button").click();
    await page.getByTestId("publisher-stop-button").click();
  }
});

test("映像の実復号エラー後は新しい Group を要求し、次の定期キーフレームまで待たない", async ({
  page,
}) => {
  test.setTimeout(60000);
  if (!(await startBoth(page, "dummy"))) return;
  try {
    await page.getByTestId("subscriber-audio-playback-toggle").click();
    // 間隔は 10 秒であり、配信開始から約 3 秒で壊すと自然な復帰は約 7 秒後になる。
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
        return api.getPublisher().framesEncoded > 90;
      },
      undefined,
      { timeout: 10000 },
    );
    const before = await page.evaluate(async () => {
      const moduleUrl = "/src/signals/subscriber.ts";
      const subscribers = (await import(moduleUrl)) as {
        subscriberInstances: { value: ReadonlyMap<string, SubscriberInstance> };
      };
      const instance = subscribers.subscriberInstances.value.values().next().value;
      if (!instance?.decoder.value) throw new Error("Active video decoder is unavailable");
      const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
      const subscriber = api.getSubscribers()[0];
      if (!subscriber) throw new Error("Active subscriber is unavailable");
      const snapshot = {
        atMs: performance.now(),
        errors: subscriber.decodeErrors,
        displayed: subscriber.framesDecoded,
        played: subscriber.audio.playoutTiming.playedFrames,
        keyFrames: subscriber.keyFramesDecoded,
        requests: api.getPublisher().newGroupRequests,
      };
      // 壊れた入力を実 WebCodecs へ渡す。エラーコールバックも decoder も置き換えない。
      instance.decoder.value.decode(
        new EncodedVideoChunk({
          type: "delta",
          timestamp: Math.round((performance.timeOrigin + performance.now()) * 1000),
          data: new Uint8Array([0]),
        }),
      );
      return snapshot;
    });
    // 単なる入力の破棄ではなく、ブラウザ本体が実際にエラーを通知したことを必要とする。
    await page.waitForFunction(
      (errors) => {
        const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
        return (api.getSubscribers()[0]?.decodeErrors ?? 0) > errors;
      },
      before.errors,
      { timeout: 2000 },
    );
    await page.waitForFunction(
      (previous) => {
        const api = (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools;
        const subscriber = api.getSubscribers()[0];
        return (
          subscriber !== undefined &&
          subscriber.decodeErrors > previous.errors &&
          subscriber.framesDecoded > previous.displayed + 10 &&
          subscriber.keyFramesDecoded > previous.keyFrames &&
          subscriber.audio.playoutTiming.playedFrames > previous.played + 10 &&
          api.getPublisher().newGroupRequests > previous.requests
        );
      },
      before,
      { timeout: 2000 },
    );
    const after = await readProgress(page);
    assert.ok(
      after.atMs - before.atMs < 2000,
      "定期キーフレームを待たず 2 秒以内に表示を再開すること",
    );
    await test.info().attach("native-decode-recovery.json", {
      body: JSON.stringify({ before, after }),
      contentType: "application/json",
    });
  } finally {
    await page.getByTestId("subscriber-stop-button").click();
    await page.getByTestId("publisher-stop-button").click();
  }
});
