import { test, expect } from "@playwright/test";
import { DEVTOOLS_URL } from "./urls";

// MediaStreamTrackProcessor をメインスレッドに持たないブラウザ (Safari / Firefox) の条件で、
// devtools が音声を配信できると判定し、Web Audio 経由で AudioData を取り出せることを確かめる。
//
// Safari は WebKit が MediaStreamTrackProcessor を DedicatedWorker にしか公開しておらず
// (WebKit の MediaStreamTrackProcessor.idl は Exposed=DedicatedWorker)、Worker へ
// MediaStreamTrack も渡せない (DataCloneError)。Firefox は実装していない。そのため
// メインスレッドからは必ず見えない。
//
// 条件は Playwright の init script で「そのブラウザに無い API を無い状態にする」ことで作る
// (実装を差し替えるスタブではない)。Safari / Firefox の実機と同じ経路を Chromium で走らせ、
// CI で回せるようにする。
//
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)

/** メインスレッドから MediaStreamTrackProcessor を隠す */
async function hideTrackProcessor(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "MediaStreamTrackProcessor", {
      value: undefined,
      configurable: true,
    });
  });
}

test("MediaStreamTrackProcessor が無いブラウザでも音声を配信可能と判定する", async ({ page }) => {
  // 配信可否は「取り出し経路があるか」で決まる。Web Audio の AudioWorklet があれば音声を
  // 配信できるため、MediaStreamTrackProcessor の有無だけで諦めない
  await hideTrackProcessor(page);
  await page.goto(DEVTOOLS_URL);

  const publishable = await page.evaluate(async () => {
    const modulePath = "/src/hooks/usePublisher.ts";
    const module = (await import(modulePath)) as {
      resolveAudioPublishable: (source: string) => boolean;
    };
    return {
      dummy: module.resolveAudioPublishable("dummy"),
      none: module.resolveAudioPublishable("none"),
    };
  });
  expect(publishable).toEqual({ dummy: true, none: false });

  // Tracks カードの予定も「広告する」になる。以前は browser-unsupported として No を出し、
  // 音声トラックが catalog に載らないまま配信が始まっていた
  await expect(page.getByTestId("audio-track-advertised")).toHaveText("Yes");
});

test("MediaStreamTrackProcessor が無いブラウザでも送信側の音声メーターが動く", async ({ page }) => {
  // メーターは配信と同じ取り出し経路を使う。Preview で実際に AudioData が流れ、
  // 値が「-」から変わることまでを確かめる (無音でも値は出るため、波形ではなく値だけを見る)
  await hideTrackProcessor(page);
  await page.goto(`${DEVTOOLS_URL}?videoSource=none&audioSource=dummy`);

  await page.getByTestId("publisher-preview-button").click();
  await expect(page.getByTestId("publisher-audio-peak-left")).not.toHaveText("-", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("publisher-audio-rms-left")).not.toHaveText("-");

  // 後始末する (Preview を止めると値は「-」に戻る)
  await page.getByTestId("publisher-preview-button").click();
  await expect(page.getByTestId("publisher-audio-peak-left")).toHaveText("-");
});
