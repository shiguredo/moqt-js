import { test, expect } from "@playwright/test";

// dummy の映像のフレーム供給のテスト
//
// フレームの間隔を刻む時計は Dedicated Worker にある。タブが hidden のときブラウザは
// main thread のタイマーを 1 秒間隔に絞るため、main thread のタイマーで刻むと
// 1 コールバック = 1 フレームのこの生成器のフレーム供給が 1 fps になる (worker の
// タイマーは絞られない)。hidden の状態は Playwright の page では作れないため、ここでは
// 可視のタブで、worker が刻んだ間隔どおりにフレームが供給されることを確かめる。
//
// dev サーバーが配信するモジュールを直接読み込み、ブラウザ側の映像経路だけを検証する。
// テストファイル側の tsconfig は devtools の WebCodecs 型拡張を読み込まないため、
// ここでは必要な形を明示してキャストする (devtools-audio.spec.ts と同じ形)。

/** dummy の映像を読み込むページ (devtools の Vite dev サーバー) */
const DUMMY_VIDEO_PAGE_URL = "http://localhost:5173/webcodecs-devtools.html";
/** 測定期間 (ミリ秒)。短すぎると周期の揺らぎでぶれる */
const MEASURE_DURATION_MS = 2_000;
/** 立ち上がりを捨てる時間 (ミリ秒) */
const WARMUP_MS = 500;
/** 設定する framerate */
const FRAMERATE = 30;
/** 許容する fps の下限。1 fps に落ちる回帰と、worker が動かない 0 fps を検出する */
const MIN_FPS = 20;
/** 許容する fps の上限。設定より速く供給していないことを確かめる */
const MAX_FPS = 40;

test("dummy の映像は設定した framerate でフレームを供給する", async ({ page }) => {
  await page.goto(DUMMY_VIDEO_PAGE_URL);

  const result = await page.evaluate(
    async (options) => {
      const modulePath = "/src/webcodecs-devtools/utils/dummyVideo.ts";
      const module = (await import(modulePath)) as {
        createDummyVideoStream: (
          width: number,
          height: number,
          framerate: number,
        ) => { stream: MediaStream; stop: () => void };
      };

      const processorCtor = (
        globalThis as unknown as {
          MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
            readable: ReadableStream<VideoFrame>;
          };
        }
      ).MediaStreamTrackProcessor;

      const generator = module.createDummyVideoStream(320, 180, options.framerate);
      const [track] = generator.stream.getVideoTracks();
      if (!track) {
        generator.stop();
        throw new Error("dummy video stream has no video track");
      }

      // 供給されたフレームを実際に読んで数える
      const processor = new processorCtor({ track });
      const reader = processor.readable.getReader();
      let frames = 0;
      const readLoop = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            return;
          }
          frames += 1;
          value.close();
        }
      })();

      // 最初の 1 枚とタイマーの立ち上がりを捨ててから測る
      await new Promise((resolve) => {
        setTimeout(resolve, options.warmupMs);
      });
      frames = 0;
      const startedAtMs = performance.now();
      await new Promise((resolve) => {
        setTimeout(resolve, options.durationMs);
      });
      // 経過時間は performance.now() で測る (sleep の実時間を fps の分母にする)
      const elapsedMs = performance.now() - startedAtMs;

      generator.stop();
      await reader.cancel().catch(() => {
        // 停止による中断は失敗ではない
      });
      await readLoop.catch(() => {
        // 停止による中断は失敗ではない
      });

      return { frames, elapsedMs, framesPerSecond: (frames / elapsedMs) * 1_000 };
    },
    { framerate: FRAMERATE, durationMs: MEASURE_DURATION_MS, warmupMs: WARMUP_MS },
  );

  // fps が範囲外のときは、どれだけ供給されたかが分かるように値も出す
  expect(
    result.framesPerSecond,
    `expected ${String(MIN_FPS)} - ${String(MAX_FPS)} fps but got ${result.framesPerSecond.toFixed(1)} fps (${String(result.frames)} frames / ${result.elapsedMs.toFixed(1)} ms)`,
  ).toBeGreaterThan(MIN_FPS);
  expect(result.framesPerSecond).toBeLessThan(MAX_FPS);
});
