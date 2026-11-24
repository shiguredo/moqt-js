/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { formatTrackNamespace } from "../../../src/fullTrackName";
import { DEVTOOLS_URL, SHAKA_PLAYER_URL } from "../urls";
import { createTestNamespace, requireRelayUri, setMoqtUri, RELAY_TEST_TIMEOUT_MS } from "./support";

test("Shaka Player は既定設定でキーフレーム間隔 10 秒の LOC 映像を再生し続ける", async ({
  page: publisher,
  context,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS);
  const relayUri = requireRelayUri();
  if (relayUri === null) return;
  const namespace = createTestNamespace();
  const publisherQuery = new URLSearchParams({
    mode: "publisher",
    namespace: formatTrackNamespace(namespace),
    videoSource: "dummy",
    audioSource: "none",
    codec: "av1",
    resolution: "320x240",
    keyframeInterval: "10",
  });
  await publisher.goto(`${DEVTOOLS_URL}?${publisherQuery.toString()}`);
  await setMoqtUri(publisher, relayUri);
  await publisher.getByTestId("publisher-publish-button").click();
  await publisher.waitForFunction(() => {
    const keyframes = document.querySelector('[data-testid="publisher-video-keyframes"]');
    return Number(keyframes?.textContent) > 0;
  });

  const player = await context.newPage();
  const playerQuery = new URLSearchParams({ namespace: namespace.join("/"), version: "draft-23" });
  // URL にしきい値を載せず、ページの既定値が再生に使われる経路を通す。
  await player.goto(`${SHAKA_PLAYER_URL}?${playerQuery.toString()}`);
  await player.getByTestId("relay-url").fill(relayUri);
  await player.getByTestId("load").click();
  await player.waitForFunction(() => {
    const video = document.querySelector("video");
    return video !== null && video.getVideoPlaybackQuality().totalVideoFrames > 0;
  });

  // 再生開始後に 10 秒以上を観測し、キーフレームをまたぐ。再生時刻ではなく実際の
  // 映像提示を計測するため、次のキーフレームへシークしても停止時間を見落とさない。
  const playback = await player.evaluate(async () => {
    const video = document.querySelector("video");
    if (video === null) throw new Error("再生を観測する映像要素が見つからない");
    let presentedFrames = 0;
    let lastFrameAt = performance.now();
    let longestFrameGapMs = 0;
    let callback = video.requestVideoFrameCallback(function observe(now) {
      longestFrameGapMs = Math.max(longestFrameGapMs, now - lastFrameAt);
      lastFrameAt = now;
      presentedFrames += 1;
      callback = video.requestVideoFrameCallback(observe);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15_000);
    });
    video.cancelVideoFrameCallback(callback);
    return {
      presentedFrames,
      // 最後の提示以降ずっと停止した場合も、観測結果に含める。
      longestFrameGapMs: Math.max(longestFrameGapMs, performance.now() - lastFrameAt),
    };
  });
  assert.ok(playback.presentedFrames > 0, "実際に映像が提示されること");
  // 短いスケジューリングのゆらぎは許し、従来の約 4 秒の欠落は検出する。
  assert.ok(
    playback.longestFrameGapMs < 2_000,
    `映像が周期停止しないこと: ${JSON.stringify(playback)}`,
  );
});
