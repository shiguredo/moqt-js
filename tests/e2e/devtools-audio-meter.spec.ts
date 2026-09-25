import { test, expect } from "@playwright/test";
import type { SubscriberStats } from "../../devtools/src/testApi";

// devtools の音声レベルメーターの UI テスト
// 実リレーは起動しない (音声 object の到達は相互運用 harness 側で検証する)
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const DEVTOOLS_URL = "http://localhost:5173/index.html";

test("音声トラックを購読していないときもレベルメーターを描き、値を「-」にする", async ({
  page,
}) => {
  await page.goto(DEVTOOLS_URL);

  // 状態によって項目が出たり消えたりすると、下の項目の位置が動く。メーターは常に描き、
  // 音声トラックを購読していない間は各値を「-」にする
  await expect(page.getByTestId("audio-meter")).toBeVisible();
  await expect(page.getByTestId("audio-waveform")).toBeVisible();
  await expect(page.getByTestId("audio-peak")).toHaveText("-");
  await expect(page.getByTestId("audio-rms")).toHaveText("-");
  await expect(page.getByTestId("audio-level")).toHaveText("-");
  await expect(page.getByTestId("audio-voice-activity")).toHaveText("-");

  // 映像の canvas は描画されたままである (映像の表示を妨げない)
  await expect(page.getByTestId("subscriber-video-canvas")).toBeVisible();
});

test("レベルメーターは信号を canvas に描く", async ({ page }) => {
  // 描画は canvas への直接描画であり DOM からは読めないため、実際の canvas に
  // 描いて画素が変わったことを確認する (空の canvas では背景だけになる)
  await page.goto(DEVTOOLS_URL);

  const result = await page.evaluate(async () => {
    const modulePath = "/src/components/AudioMeter.tsx";
    const module = (await import(modulePath)) as {
      drawAudioMeter: (
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        values: {
          peakDbfs: number | null;
          rmsDbfs: number | null;
          level: { level: number; voiceActivity: boolean } | null;
          waveform: Float32Array | null;
        },
      ) => void;
    };

    const canvasWidth = 320;
    const canvasHeight = 96;

    // メーターを描いた canvas を作る (canvas は DOM から読めないため画素で確認する)
    const drawCanvas = (
      values: Parameters<typeof module.drawAudioMeter>[3],
    ): CanvasRenderingContext2D => {
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("failed to get 2d context");
      }
      module.drawAudioMeter(ctx, canvas.width, canvas.height, values);
      return ctx;
    };

    const countColoredPixels = (values: Parameters<typeof module.drawAudioMeter>[3]): number => {
      const ctx = drawCanvas(values);
      const data = ctx.getImageData(0, 0, canvasWidth, canvasHeight).data;
      let colored = 0;
      for (let index = 0; index < data.length; index += 4) {
        // 背景 (暗い slate、R=14) を除くための閾値。バー・波形・目盛りはこれを超える
        const red = data[index] ?? 0;
        const green = data[index + 1] ?? 0;
        const blue = data[index + 2] ?? 0;
        const alpha = data[index + 3] ?? 0;
        if (alpha > 0 && (red > 60 || green > 60 || blue > 60)) {
          colored += 1;
        }
      }
      return colored;
    };

    // 実装の窓長 (100 ms = 4800 サンプル) と同じ長さの合成波形
    const waveform = new Float32Array(4800);
    for (let index = 0; index < waveform.length; index += 1) {
      waveform[index] = 0.5 * Math.sin(index / 10);
    }

    // 上段 peak 行だけを走査し、バーの左右の端を求める。
    // 目盛りは右端が 0 dB、左端が -100 dB であり、バーは左端から現在の値まで伸びる
    const peakBarRange = (peakDbfs: number): { left: number; right: number } => {
      const ctx = drawCanvas({ peakDbfs, rmsDbfs: null, level: null, waveform: null });
      // peak 行 (最上段 y=0〜15、行間 4) の中央付近だけを見る。
      // 行高は drawAudioMeter の Math.max(4, floor(height / 6)) = 16 (height 96)
      const data = ctx.getImageData(0, 4, canvasWidth, 8).data;
      let left = -1;
      let right = -1;
      for (let x = 0; x < canvasWidth; x++) {
        const offset = x * 4;
        const red = data[offset] ?? 0;
        const alpha = data[offset + 3] ?? 0;
        // peak 行は赤 (#f87171、R=248)。目盛りの合成色 (R=148) を除くため 150 とする
        if (alpha > 0 && red > 150) {
          if (left === -1) {
            left = x;
          }
          right = x;
        }
      }
      return { left, right };
    };

    return {
      withSignal: countColoredPixels({
        peakDbfs: -6,
        rmsDbfs: -9,
        level: { level: 14, voiceActivity: true },
        waveform,
      }),
      // 未計測 (すべて null) でも目盛りだけは描かれ、例外にならない
      withNulls: countColoredPixels({
        peakDbfs: null,
        rmsDbfs: null,
        level: null,
        waveform: null,
      }),
      // -50 dBFS は目盛りの中間、-6 dBFS は右寄りになる
      middle: peakBarRange(-50),
      loud: peakBarRange(-6),
      silent: peakBarRange(-100),
    };
  });

  // 信号があるときはレベルバーと波形が描かれる
  expect(result.withSignal).toBeGreaterThan(100);
  // 未計測でも目盛りの線が描かれる (全く描かれないと描画自体の失敗に気付けない)
  expect(result.withNulls).toBeGreaterThan(0);
  expect(result.withSignal).toBeGreaterThan(result.withNulls);

  // バーは左端 (静かな側) から伸び、0 dB が右端になる。
  // 向きが逆だと -50 dBFS のバーが右半分に寄るため、ここで検出できる
  expect(result.middle.left).toBe(0);
  expect(result.middle.right).toBeGreaterThan(140);
  expect(result.middle.right).toBeLessThan(180);
  expect(result.loud.right).toBeGreaterThan(result.middle.right);
  // canvas 幅 320 に対し -6 dBFS は約 301 px まで伸びる
  expect(result.loud.right).toBeGreaterThan(290);
  // 無音 (-100 dBFS) は左端の 1 px だけになる
  expect(result.silent.right).toBeLessThanOrEqual(1);
});

test("window.moqtDevTools から音声の統計が読める", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 再生も購読もしていない状態でも、音声の統計項目が公開されていること
  // (値そのものは実リレー経由の相互運用 harness 側で確認する)
  const stats = await page.evaluate(() => {
    // 公開する統計の型は実装から借りる (フィールド名のずれを型で検出する)
    const api = (
      window as unknown as {
        moqtDevTools: {
          getSubscribers: () => SubscriberStats[];
          getSubscriber: (id: string) => SubscriberStats | null;
        };
      }
    ).moqtDevTools;

    const [first] = api.getSubscribers();
    if (!first) {
      throw new Error("no subscriber instance");
    }
    return { first, byId: api.getSubscriber(first.id) };
  });

  for (const audioStats of [stats.first, stats.byId]) {
    expect(audioStats).not.toBeNull();
    expect(audioStats?.audioObjectsReceived).toBe(0);
    expect(audioStats?.audioChunksDecoded).toBe(0);
    expect(audioStats?.audioPeakDbfs).toBeNull();
    expect(audioStats?.audioRmsDbfs).toBeNull();
    expect(audioStats?.audioLastLevel).toBeNull();
    expect(audioStats?.audioLastVoiceActivity).toBeNull();
  }
});
