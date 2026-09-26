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

test("音声レベルメーターの見出し行の項目は、値が変わっても位置が動かない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 見出し行は値の文字数で項目の幅が変わると、話している間ずっと画面が揺れる。
  // 実際のパネルと同じ幅 (max-w-7xl の 2 列で、メーターの内側は 546 px) で AudioMeter を描き、
  // 値と voice activity を変えても項目の位置とメーターの高さが変わらないことを確認する。
  // コンポーネントテストの基盤が無いため、実ブラウザの E2E から描画する (CSS も実際のものが当たる)
  const layout = await page.evaluate(async () => {
    // Preact はアプリが読み込んだものと同じインスタンスで描く必要がある。
    // 別の URL から import すると preact/hooks が見る現在のコンポーネントがずれ、
    // hooks (useRef / useSignalEffect) が動かない
    const depUrl = (pattern: RegExp): string => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => pattern.test(name));
      if (!url) {
        throw new Error(`no loaded dependency: ${String(pattern)}`);
      }
      return url;
    };

    const preact = (await import(depUrl(/\/deps\/preact\.js\?v=/))) as {
      h: (type: unknown, props: Record<string, unknown>) => unknown;
      render: (node: unknown, parent: Element) => void;
    };
    const signals = (await import(depUrl(/\/deps\/@preact_signals\.js\?v=/))) as {
      signal: <T>(value: T) => { value: T };
    };
    // リテラルの import にすると、このファイルを型検査するときにパスを解決しようとする。
    // devtools の Vite が配信する URL であり、テストの TypeScript からは見えない
    const audioMeterUrl = "/src/components/AudioMeter.tsx";
    const { AudioMeter } = (await import(audioMeterUrl)) as {
      AudioMeter: unknown;
    };

    // 実際のパネルの列と同じ幅で描く (メーターの外側が 572 px、内側の p-3 と border を
    // 引いた見出し行の幅が 546 px になる)
    const host = document.createElement("div");
    host.style.width = "572px";
    document.body.append(host);

    const peakDbfs = signals.signal<number | null>(null);
    const rmsDbfs = signals.signal<number | null>(null);
    const level = signals.signal<{ level: number; voiceActivity: boolean } | null>(null);
    const waveform = signals.signal<Float32Array | null>(null);

    // 1 つの状態を描き、値の項目の位置と、見出し行とメーターの高さ、表示の文字列を測る
    const measure = async (state: {
      active: boolean;
      levelActive: boolean;
      peakDbfs: number | null;
      rmsDbfs: number | null;
      level: { level: number; voiceActivity: boolean } | null;
    }) => {
      peakDbfs.value = state.peakDbfs;
      rmsDbfs.value = state.rmsDbfs;
      level.value = state.level;
      preact.render(
        preact.h(AudioMeter, {
          peakDbfs,
          rmsDbfs,
          level,
          waveform,
          active: state.active,
          levelActive: state.levelActive,
          testIdPrefix: "layout-audio",
        }),
        host,
      );
      // Preact の再描画は microtask で走るため、1 フレーム待ってから測る
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });

      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      const texts: Record<string, string> = {};
      for (const name of ["peak", "rms", "level", "voice-activity"]) {
        const element = document.querySelector(`[data-testid="layout-audio-${name}"]`);
        if (!element) {
          throw new Error(`no element: layout-audio-${name}`);
        }
        const rect = element.getBoundingClientRect();
        boxes[name] = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        texts[name] = element.textContent ?? "";
      }

      const meter = document.querySelector('[data-testid="layout-audio-meter"]');
      const header = meter?.firstElementChild;
      if (!meter || !header) {
        throw new Error("no element: layout-audio-meter");
      }
      return {
        boxes,
        texts,
        headerHeight: Math.round(header.getBoundingClientRect().height),
        meterHeight: Math.round(meter.getBoundingClientRect().height),
      };
    };

    // 値を「-」にした状態 (購読していない間や配信していない間の表示)
    const inactive = await measure({
      active: false,
      levelActive: false,
      peakDbfs: null,
      rmsDbfs: null,
      level: null,
    });
    // 音を受けていて voice activity が off の状態
    const voiceOff = await measure({
      active: true,
      levelActive: true,
      peakDbfs: -53.6,
      rmsDbfs: -63.5,
      level: { level: 72, voiceActivity: false },
    });
    // voice activity だけが on になった状態 (値は同じ)
    const voiceOn = await measure({
      active: true,
      levelActive: true,
      peakDbfs: -53.6,
      rmsDbfs: -63.5,
      level: { level: 72, voiceActivity: true },
    });
    // 最も静かな値 (peak / RMS は 11 文字、LOC Audio Level は 9 文字)
    const quiet = await measure({
      active: true,
      levelActive: true,
      peakDbfs: -100,
      rmsDbfs: -100,
      level: { level: 127, voiceActivity: false },
    });
    // 最も大きい値 (peak / RMS は 8 文字、LOC Audio Level は 6 文字)
    const loud = await measure({
      active: true,
      levelActive: true,
      peakDbfs: 0,
      rmsDbfs: -6,
      level: { level: 0, voiceActivity: true },
    });
    // Audio Level が載っていない Object を受けた状態 (LOC Audio Level は 12 文字)
    const notReported = await measure({
      active: true,
      levelActive: true,
      peakDbfs: -53.6,
      rmsDbfs: -63.5,
      level: null,
    });
    // 音を受けているが、まだ復号していない状態 (peak / RMS は値なし)
    const notMeasured = await measure({
      active: true,
      levelActive: true,
      peakDbfs: null,
      rmsDbfs: null,
      level: { level: 72, voiceActivity: false },
    });

    return { inactive, voiceOff, voiceOn, quiet, loud, notReported, notMeasured };
  });

  // 546 px の幅では見出し行が 1 行に収まる (折り返すと 40px 前後になり、下の Catalog と
  // Statistics が動く)。行高は 16px で、flex の baseline で 1px 足されることがある
  expect(layout.quiet.headerHeight).toBeLessThanOrEqual(20);

  // どの状態でも項目の位置と大きさ、見出し行とメーターの高さが変わらない
  for (const state of [
    layout.voiceOff,
    layout.voiceOn,
    layout.quiet,
    layout.loud,
    layout.notReported,
    layout.notMeasured,
  ]) {
    expect(state.boxes).toEqual(layout.inactive.boxes);
    expect(state.headerHeight).toBe(layout.inactive.headerHeight);
    expect(state.meterHeight).toBe(layout.inactive.meterHeight);
  }

  // 表示そのものが壊れていないこと (位置だけを測る空のテストにしない)
  expect(layout.voiceOff.texts).toEqual({
    peak: " -53.6 dBFS",
    rms: " -63.5 dBFS",
    level: " -72 dBov",
    "voice-activity": "off",
  });
  expect(layout.voiceOn.texts["voice-activity"]).toBe("on ");
  expect(layout.quiet.texts).toEqual({
    peak: "-100.0 dBFS",
    rms: "-100.0 dBFS",
    level: "-127 dBov",
    "voice-activity": "off",
  });
  expect(layout.loud.texts).toEqual({
    peak: "   0.0 dBFS",
    rms: "  -6.0 dBFS",
    level: "   0 dBov",
    "voice-activity": "on ",
  });
  expect(layout.notReported.texts).toEqual({
    peak: " -53.6 dBFS",
    rms: " -63.5 dBFS",
    level: "not reported",
    "voice-activity": "-",
  });
  expect(layout.notMeasured.texts).toEqual({
    peak: "-",
    rms: "-",
    level: " -72 dBov",
    "voice-activity": "off",
  });
  expect(layout.inactive.texts).toEqual({
    peak: "-",
    rms: "-",
    level: "-",
    "voice-activity": "-",
  });
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
    expect(audioStats?.audio.objectsReceived).toBe(0);
    expect(audioStats?.audio.chunksDecoded).toBe(0);
    expect(audioStats?.audio.peakDbfs).toBeNull();
    expect(audioStats?.audio.rmsDbfs).toBeNull();
    expect(audioStats?.audio.lastLevel).toBeNull();
    expect(audioStats?.audio.lastVoiceActivity).toBeNull();
  }
});
