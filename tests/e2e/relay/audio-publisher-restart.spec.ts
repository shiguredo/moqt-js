/// <reference types="node" />
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "../playoutTestPage";
import { createTestNamespace, RELAY_TEST_TIMEOUT_MS, requireRelayUri } from "./support";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// private なループだけを再開すると、公開 start が行う時計と catch-up の初期化を飛ばす。
// 同じ Publisher の stop / start を、実キャプチャと実エンコーダーで検査する。
test("同じ音声 Publisher を停止して再開しても送信を続けられる", async ({ page }) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const url = requireRelayUri();
  if (url === null) return;
  await openPlayoutPage(page);
  const result = await evaluatePlayout(
    page,
    async ({ moduleUrl, harnessUrl, url, namespace }) => {
      const { createMediaPublisher } = (await import(
        moduleUrl
      )) as typeof import("../../../src/index");
      const { waitFor } = await import(harnessUrl);
      const context = new AudioContext({ sampleRate: 48000 });
      const tone = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      tone.connect(destination);
      tone.start();
      const errors: string[] = [];
      const publisher = await createMediaPublisher(
        url,
        {
          namespace,
          audio: { codec: "opus", bitrate: 64000, delivery: "subgroup" },
        },
        { onError: (error: Error) => errors.push(error.message) },
      );
      const observations: { sent: number; state: string }[] = [];
      try {
        await context.resume();
        for (let attempt = 0; attempt < 2; attempt++) {
          await publisher.start(destination.stream);
          const before = publisher.getStats().audio?.framesSent ?? 0;
          await waitFor(
            () => (publisher.getStats().audio?.framesSent ?? 0) > before + 5,
            5000,
            "再開した Publisher の実音の送信",
          );
          observations.push({
            sent: (publisher.getStats().audio?.framesSent ?? 0) - before,
            state: publisher.state,
          });
          await publisher.stop();
        }
        return { observations, errors, state: publisher.state };
      } finally {
        await publisher.close();
        tone.stop();
        for (const track of destination.stream.getTracks()) track.stop();
        await context.close();
      }
    },
    { url, namespace: createTestNamespace() },
  );
  assert.deepEqual(result.errors, [], "実際の開始と停止をエラーなく完了すること");
  assert.equal(result.state, "stopped", "再開後も停止できること");
  assert.equal(result.observations.length, 2, "初回と再開後の両方を検査すること");
  for (const observation of result.observations) {
    assert.equal(observation.state, "publishing", "実際の公開 API で再開すること");
    assert.ok(observation.sent > 5, "再開後にも継続して Object を送ること");
  }
});
