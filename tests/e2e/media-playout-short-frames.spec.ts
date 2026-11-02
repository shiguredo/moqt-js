/// <reference types="node" />
/** 短いバッファでも先頭のフェードを消さず、公開 API の実出力で接続を確かめる。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const frames of [120, 192, 240, 960]) {
  for (const scenario of ["initial", "reset", "conceal"] as const) {
    test(`${frames} サンプルの連続予約でも開始と接続を滑らかにする: ${scenario}`, async ({
      page,
    }, testInfo) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, harnessUrl, frames, scenario }) => {
          const { createMediaPlayout } = await import(moduleUrl);
          const { waitFor } = await import(harnessUrl);
          const { playoutAudioOf, playoutAudioClockOf, playoutAudioTimingOf } = await import(
            new URL("./testSupport/mediaPlayoutInternals.ts", moduleUrl).href
          );
          const context = new AudioContext({ sampleRate: 48000 });
          const chunks: Float32Array[] = [];
          const captureEnds: number[] = [];
          const reservations: {
            timestamp: number;
            inputFrames: number;
            startSeconds: number | null;
            endSeconds: number;
          }[] = [];
          let reservedEndSeconds = 0;
          let capturedUntil = 0;
          const url = URL.createObjectURL(
            new Blob(
              [
                `class Capture extends AudioWorkletProcessor {
                  process(inputs, outputs) {
                    const samples = inputs[0]?.[0]?.slice() ?? new Float32Array(outputs[0][0].length);
                    this.port.postMessage({ samples, endFrame: currentFrame + samples.length });
                    return true;
                  }
                } registerProcessor("short-frame-capture", Capture);`,
              ],
              { type: "text/javascript" },
            ),
          );
          await context.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          const tap = new AudioWorkletNode(context, "short-frame-capture");
          tap.port.onmessage = (
            event: MessageEvent<{ samples: Float32Array; endFrame: number }>,
          ) => {
            chunks.push(event.data.samples);
            captureEnds.push(event.data.endFrame);
            capturedUntil = event.data.endFrame;
          };
          const mute = context.createGain();
          mute.gain.value = 0;
          tap.connect(mute).connect(context.destination);
          const playout = createMediaPlayout({ audio: { context, destination: tap } });
          await playout.prepareAudio();
          const statuses: string[] = [];
          const session = playoutAudioOf(playout) as unknown as {
            lastRenderEndSeconds: number;
          };
          const clock = playoutAudioClockOf(playout);
          const timing = playoutAudioTimingOf(playout);
          const push = (timestamp: number, count: number, amplitude = 0.3) => {
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: count,
              timestamp,
              data: new Float32Array(count).fill(amplitude),
            });
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
            const pushResult = playout.pushAudio(data);
            statuses.push(pushResult.status);
            reservedEndSeconds = session.lastRenderEndSeconds;
            // 伸縮後の開始は入力長から推定せず、実際に予約した開始と終端を残す。
            // 開始は再生の記録に残った performance 軸の値を、同じ時計の対応で audio 軸へ戻す。
            // 伸縮で長さが変わっても開始は変わらないため、未描画の予約長を計算できる。
            const lastStartMs =
              pushResult.status === "played"
                ? timing.snapshot(performance.now()).lastStartMs
                : null;
            reservations.push({
              timestamp,
              inputFrames: count,
              startSeconds: lastStartMs === null ? null : clock.toAudioSeconds(lastStartMs),
              endSeconds: reservedEndSeconds,
            });
            data.close();
          };
          try {
            await context.resume();
            await waitFor(
              () => (context.getOutputTimestamp().performanceTime ?? 0) > 0,
              2000,
              "出力時計の準備",
            );
            if (scenario === "reset") {
              push(0, frames, 0.1);
              await playout.drainAudio();
              // 再開前に旧予約の末尾まで収録し、同じ出力への重なりを検査に混ぜない。
              await waitFor(
                () =>
                  chunks.some((chunk) => chunk.some((sample) => sample > 0.001)) &&
                  chunks.length >= 3 &&
                  chunks.slice(-3).every((chunk) => chunk.every((sample) => sample === 0)),
                2000,
                "旧予約の出力完了",
              );
              playout.resetAudioPlayback();
            }
            // 2 件目を先行予約し、末尾を取り消す時点で先頭の ramp が残るかを検査する。
            await context.suspend();
            let timestamp = 0;
            if (scenario === "conceal") {
              // PLC の材料には 20 ms を渡し、その先の短い穴と実音も同じ出力で検査する。
              push(0, 960, 0.1);
              timestamp = 21000;
            }
            push(timestamp, frames);
            push(timestamp + (frames / 48000) * 1000000, frames);
            // 停止中に積んだ制御の受理を確認してから、実際の時計を再開する。
            await playout.prepareAudio();
            const suspendedTime = context.currentTime;
            await context.resume();
            // resume の解決だけでは出力時計の再始動を保証しない。実際の描画を確認する。
            await waitFor(() => context.currentTime > suspendedTime, 2000, "出力時計の再始動");
            const drain = await playout.drainAudio();
            const endAtDrain = context.currentTime;
            // 実出力と MessagePort の配送が検査位置を越えるまで待ち、固定 sleep で推測しない。
            const captureFrame =
              Math.ceil(Math.max(context.currentTime, reservedEndSeconds) * context.sampleRate) +
              384;
            await waitFor(() => capturedUntil >= captureFrame, 2000, "停止後の出力の収録完了");
            let previous = 0;
            let maximumStep = 0;
            let peak = 0;
            let targetActiveSamples = 0;
            const steps: { frame: number; previous: number; sample: number }[] = [];
            let chunkIndex = 0;
            for (const chunk of chunks) {
              let offset = 0;
              for (const sample of chunk) {
                if (Math.abs(sample - previous) >= 0.006 && steps.length < 8) {
                  steps.push({
                    frame: (captureEnds[chunkIndex] ?? 0) - chunk.length + offset,
                    previous,
                    sample,
                  });
                }
                offset++;
                maximumStep = Math.max(maximumStep, Math.abs(sample - previous));
                peak = Math.max(peak, Math.abs(sample));
                // 準備音とその PLC は振幅 0.1 なので、検査対象の短い実音だけを数える。
                if (sample > 0.2) targetActiveSamples++;
                previous = sample;
              }
              chunkIndex++;
            }
            return {
              statuses,
              reservations,
              steps,
              maximumStep,
              peak,
              targetActiveSamples,
              reservedEndSeconds,
              drain,
              endAtDrain,
              captureFrame,
              capturedUntil,
            };
          } finally {
            playout.clearAll();
            tap.disconnect();
            mute.disconnect();
            await context.close();
          }
        },
        { frames, scenario },
      );
      await testInfo.attach("waveform-metrics.json", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      assert.ok(
        result.statuses.every((status) => status === "played"),
        "全入力を再生すること",
      );
      // drain の cutMs は「鳴らせなかった予約の長さ」を返す。予約開始前の lead
      // (予約開始 - endAtDrain) は予約の長さではないため cutMs に含まれない。出力時計が
      // 止まった間は予約開始が未来のまま打ち切られ、reservedEndSeconds - endAtDrain と
      // cutMs の差がその lead の分だけ開く。未描画の予約の長さと比べる。
      // 予約の描画が済んでいれば cutMs は 0 になり、この比較も 0 対 0 で通る。
      const lastReservation = result.reservations.at(-1);
      assert.ok(lastReservation !== undefined, "予約を記録していること");
      assert.ok(lastReservation.startSeconds !== null, "予約の開始時刻を読めること");
      const unplayedReservedMs =
        Math.max(
          0,
          result.reservedEndSeconds - Math.max(result.endAtDrain, lastReservation.startSeconds),
        ) * 1000;
      assert.ok(
        result.drain.cutMs + 1000 / 48000 >= unplayedReservedMs,
        `予約の描画前に完了する場合は切った量を報告すること: ${JSON.stringify(result)}`,
      );
      assert.ok(
        result.peak > 0.299 && result.targetActiveSamples >= frames,
        "無音化して成功させないこと",
      );
      assert.ok(result.maximumStep < 0.006, `先頭 ramp を保つこと: ${JSON.stringify(result)}`);
    });
  }
}
