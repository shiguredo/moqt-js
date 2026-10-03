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
  await expect(page.getByTestId("audio-waveform-left")).toBeVisible();
  await expect(page.getByTestId("audio-waveform-right")).toBeVisible();
  await expect(page.getByTestId("audio-peak-left")).toHaveText("-");
  await expect(page.getByTestId("audio-peak-right")).toHaveText("-");
  await expect(page.getByTestId("audio-rms-left")).toHaveText("-");
  await expect(page.getByTestId("audio-rms-right")).toHaveText("-");
  await expect(page.getByTestId("audio-level")).toHaveText("-");
  await expect(page.getByTestId("audio-voice-activity")).toHaveText("-");

  // 映像の canvas は描画されたままである (映像の表示を妨げない)
  await expect(page.getByTestId("subscriber-video-canvas")).toBeVisible();
});

test("波形は canvas に信号を描く", async ({ page }) => {
  // 波形はチャンネルごとの canvas に描く。描画は canvas への直接描画であり DOM からは
  // 読めないため、実際の canvas に描いて画素を確認する
  await page.goto(DEVTOOLS_URL);

  const result = await page.evaluate(async () => {
    // リテラルの import にすると、このファイルを型検査するときにパスを解決しようとする。
    // devtools の Vite が配信する URL であり、テストの TypeScript からは見えない
    const audioMeterUrl = "/src/components/AudioMeter.tsx";
    const module = (await import(audioMeterUrl)) as {
      drawAudioWaveform: (
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        waveform: Float32Array | null,
      ) => void;
    };

    const canvasWidth = 320;
    const canvasHeight = 48;

    const draw = (waveform: Float32Array | null): CanvasRenderingContext2D => {
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("failed to get 2d context");
      }
      module.drawAudioWaveform(ctx, canvas.width, canvas.height, waveform);
      return ctx;
    };

    // 波形の色 (#38bdf8、青が 248) の画素を数える。中心線 (灰色) と分ける
    const waveformPixels = (waveform: Float32Array | null): number => {
      const ctx = draw(waveform);
      const data = ctx.getImageData(0, 0, canvasWidth, canvasHeight).data;
      let colored = 0;
      for (let index = 0; index < data.length; index += 4) {
        const blue = data[index + 2] ?? 0;
        const alpha = data[index + 3] ?? 0;
        if (alpha > 0 && blue > 200) {
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

    // 波形が描かれている x の範囲を求める
    const ctx = draw(waveform);
    const data = ctx.getImageData(0, 0, canvasWidth, canvasHeight).data;
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < canvasWidth; x++) {
      for (let y = 0; y < canvasHeight; y++) {
        const offset = (y * canvasWidth + x) * 4;
        const blue = data[offset + 2] ?? 0;
        if (blue > 200) {
          if (minX === -1) {
            minX = x;
          }
          maxX = x;
          break;
        }
      }
    }

    return {
      withSignal: waveformPixels(waveform),
      withNull: waveformPixels(null),
      minX,
      maxX,
    };
  });

  // 波形があるときだけ青い画素が描かれる (null では中心線だけ)
  expect(result.withSignal).toBeGreaterThan(100);
  expect(result.withNull).toBe(0);
  // 波形は左端から右端まで描く (4800 サンプルを幅いっぱいに写す)
  expect(result.minX).toBeLessThanOrEqual(1);
  expect(result.maxX).toBeGreaterThanOrEqual(318);
});

test("音声レベルメーターの値は、値が変わっても位置が動かない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);

  // 値の文字数で項目の幅が変わると、音が鳴っている間ずっと画面が揺れる。実際のパネルと
  // 同じ幅 (max-w-7xl の 2 列で、メーターの内側は 572 px) で AudioMeter を描き、
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

    // 実際のパネルの列と同じ幅で描く (メーターの外側が 572 px、内側の p-2 と border を
    // 引いた幅になる)
    const host = document.createElement("div");
    host.style.width = "572px";
    document.body.append(host);

    const peakDbfsLeft = signals.signal<number | null>(null);
    const peakDbfsRight = signals.signal<number | null>(null);
    const rmsDbfsLeft = signals.signal<number | null>(null);
    const rmsDbfsRight = signals.signal<number | null>(null);
    const level = signals.signal<{ level: number; voiceActivity: boolean } | null>(null);
    const waveformLeft = signals.signal<Float32Array | null>(null);
    const waveformRight = signals.signal<Float32Array | null>(null);

    // 1 つの状態を描き、値の項目の位置と、見出しとメーターの高さ、表示の文字列を測る
    const measure = async (state: {
      active: boolean;
      levelActive: boolean;
      peakDbfsLeft: number | null;
      peakDbfsRight: number | null;
      rmsDbfsLeft: number | null;
      rmsDbfsRight: number | null;
      level: { level: number; voiceActivity: boolean } | null;
    }) => {
      peakDbfsLeft.value = state.peakDbfsLeft;
      peakDbfsRight.value = state.peakDbfsRight;
      rmsDbfsLeft.value = state.rmsDbfsLeft;
      rmsDbfsRight.value = state.rmsDbfsRight;
      level.value = state.level;
      preact.render(
        preact.h(AudioMeter, {
          peakDbfsLeft,
          peakDbfsRight,
          rmsDbfsLeft,
          rmsDbfsRight,
          level,
          waveformLeft,
          waveformRight,
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
      for (const name of [
        "peak-left",
        "peak-right",
        "rms-left",
        "rms-right",
        "level",
        "voice-activity",
      ]) {
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

      // 値の末尾の単位 (dBFS / dBov) の左端の x を測る。単位が無い値 ("-" や
      // "not reported") は null にする
      const unitX = (testId: string): number | null => {
        const value = document.querySelector(`[data-testid="${testId}"]`)?.firstChild;
        const valueText = value?.textContent ?? "";
        if (value === null || value === undefined || !/(dBFS|dBov)$/.test(valueText)) {
          return null;
        }
        const range = document.createRange();
        range.setStart(value, valueText.length - 4);
        range.setEnd(value, valueText.length);
        return Math.round(range.getBoundingClientRect().x);
      };

      return {
        boxes,
        texts,
        peakLeftUnitX: unitX("layout-audio-peak-left"),
        peakRightUnitX: unitX("layout-audio-peak-right"),
        levelUnitX: unitX("layout-audio-level"),
        headerHeight: Math.round(header.getBoundingClientRect().height),
        meterHeight: Math.round(meter.getBoundingClientRect().height),
      };
    };

    // 値を「-」にした状態 (購読していない間や配信していない間の表示)
    const inactive = await measure({
      active: false,
      levelActive: false,
      peakDbfsLeft: null,
      peakDbfsRight: null,
      rmsDbfsLeft: null,
      rmsDbfsRight: null,
      level: null,
    });
    // 音を受けていて voice activity が off の状態
    const voiceOff = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: -53.6,
      peakDbfsRight: -55,
      rmsDbfsLeft: -63.5,
      rmsDbfsRight: -65,
      level: { level: 72, voiceActivity: false },
    });
    // voice activity だけが on になった状態 (値は同じ)
    const voiceOn = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: -53.6,
      peakDbfsRight: -55,
      rmsDbfsLeft: -63.5,
      rmsDbfsRight: -65,
      level: { level: 72, voiceActivity: true },
    });
    // 最も静かな値 (peak / RMS は 11 文字、LOC Audio Level は 9 文字)
    const quiet = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: -100,
      peakDbfsRight: -100,
      rmsDbfsLeft: -100,
      rmsDbfsRight: -100,
      level: { level: 127, voiceActivity: false },
    });
    // 最も大きい値 (peak / RMS は 11 文字、LOC Audio Level は 8 文字)
    const loud = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: 0,
      peakDbfsRight: -1,
      rmsDbfsLeft: -6,
      rmsDbfsRight: -7,
      level: { level: 0, voiceActivity: true },
    });
    // Audio Level が載っていない Object を受けた状態
    const notReported = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: -53.6,
      peakDbfsRight: -55,
      rmsDbfsLeft: -63.5,
      rmsDbfsRight: -65,
      level: null,
    });
    // 音を受けているが、まだ復号していない状態 (peak / RMS は値なし)
    const notMeasured = await measure({
      active: true,
      levelActive: true,
      peakDbfsLeft: null,
      peakDbfsRight: null,
      rmsDbfsLeft: null,
      rmsDbfsRight: null,
      level: { level: 72, voiceActivity: false },
    });

    return { inactive, voiceOff, voiceOn, quiet, loud, notReported, notMeasured };
  });

  // 見出し (Audio と voice) は 1 行に固定する
  expect(layout.quiet.headerHeight).toBeLessThanOrEqual(20);

  // どの状態でも項目の位置と大きさ、見出しとメーターの高さが変わらない
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

  // 値の桁数が変わっても単位 (dBFS / dBov) の位置が動かないこと。
  // 空白が潰れると単位だけが動き、値の変化が読み取れなくなる
  const peakLeftUnitXs = [
    layout.voiceOff.peakLeftUnitX,
    layout.voiceOn.peakLeftUnitX,
    layout.quiet.peakLeftUnitX,
    layout.loud.peakLeftUnitX,
    layout.notReported.peakLeftUnitX,
  ].filter((x): x is number => x !== null);
  expect(peakLeftUnitXs).toHaveLength(5);
  expect(new Set(peakLeftUnitXs).size).toBe(1);

  const peakRightUnitXs = [
    layout.voiceOff.peakRightUnitX,
    layout.voiceOn.peakRightUnitX,
    layout.quiet.peakRightUnitX,
    layout.loud.peakRightUnitX,
    layout.notReported.peakRightUnitX,
  ].filter((x): x is number => x !== null);
  expect(peakRightUnitXs).toHaveLength(5);
  expect(new Set(peakRightUnitXs).size).toBe(1);

  const levelUnitXs = [
    layout.voiceOff.levelUnitX,
    layout.voiceOn.levelUnitX,
    layout.quiet.levelUnitX,
    layout.loud.levelUnitX,
    layout.notMeasured.levelUnitX,
  ].filter((x): x is number => x !== null);
  expect(levelUnitXs).toHaveLength(5);
  expect(new Set(levelUnitXs).size).toBe(1);

  // 表示そのものが壊れていないこと (位置だけを測る空のテストにしない)
  expect(layout.voiceOff.texts).toEqual({
    "peak-left": " -53.6 dBFS",
    "peak-right": " -55.0 dBFS",
    "rms-left": " -63.5 dBFS",
    "rms-right": " -65.0 dBFS",
    level: " -72 dBov",
    "voice-activity": "off",
  });
  expect(layout.voiceOn.texts["voice-activity"]).toBe("on ");
  expect(layout.quiet.texts).toEqual({
    "peak-left": "-100.0 dBFS",
    "peak-right": "-100.0 dBFS",
    "rms-left": "-100.0 dBFS",
    "rms-right": "-100.0 dBFS",
    level: "-127 dBov",
    "voice-activity": "off",
  });
  expect(layout.loud.texts).toEqual({
    "peak-left": "   0.0 dBFS",
    "peak-right": "  -1.0 dBFS",
    "rms-left": "  -6.0 dBFS",
    "rms-right": "  -7.0 dBFS",
    level: "   0 dBov",
    "voice-activity": "on ",
  });
  expect(layout.notReported.texts).toEqual({
    "peak-left": " -53.6 dBFS",
    "peak-right": " -55.0 dBFS",
    "rms-left": " -63.5 dBFS",
    "rms-right": " -65.0 dBFS",
    level: "not reported",
    "voice-activity": "-",
  });
  expect(layout.notMeasured.texts).toEqual({
    "peak-left": "-",
    "peak-right": "-",
    "rms-left": "-",
    "rms-right": "-",
    level: " -72 dBov",
    "voice-activity": "off",
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
    // datagram で届いた数は受信数の内数。購読前は 0
    expect(audioStats?.audio.datagramObjectsReceived).toBe(0);
    expect(audioStats?.audio.chunksDecoded).toBe(0);
    expect(audioStats?.audio.peakDbfs).toBeNull();
    expect(audioStats?.audio.rmsDbfs).toBeNull();
    expect(audioStats?.audio.peakDbfsRight).toBeNull();
    expect(audioStats?.audio.rmsDbfsRight).toBeNull();
    expect(audioStats?.audio.lastLevel).toBeNull();
    expect(audioStats?.audio.lastVoiceActivity).toBeNull();
  }
});

// 音声は Subgroup (stream) と Datagram の両方で届きうる (draft-ietf-moq-transport-22 §11)。
// どちらの経路で届いたかを画面で確かめられるように、統計に経路別の数を出す
test("subscriber の画面に音声の経路別の受信数を出す", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  // 統計の欄は既定で閉じているため、先に開く
  await page.getByTestId("subscriber-statistics-toggle").click();

  // 未購読では音声の受信数は 0 (datagram で届いた数も 0)
  await expect(page.getByTestId("subscriber-audio-datagram-objects")).toHaveText("0");
});
