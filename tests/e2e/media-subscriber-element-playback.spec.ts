/**
 * 高レベル API の音声と映像を同じ video 要素へ接続する。
 * 入力の識別子を音声の振幅と映像の画素へ埋め、内部の同期統計に頼らず観測する。
 * 音声は MediaStream の分岐点、映像は要素の表示通知で測る。スピーカーとの同期測定ではない。
 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({
  launchOptions: async ({ browserName }, provide) => {
    await provide(
      browserName === "chromium"
        ? { channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] }
        : {},
    );
  },
});

for (const minDelayMs of [10, 50]) {
  test(`音声と映像を video 要素で継続再生し、再開と解像度変更を処理する ${minDelayMs} ms`, async ({
    page,
  }, testInfo) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, minDelayMs, stallMs }) => {
        const { MediaSubscriberImpl } = await import(
          new URL("./createMediaSubscriber.ts", moduleUrl).href
        );
        const subscriber = new MediaSubscriberImpl(
          "https://localhost.invalid",
          {
            namespace: ["element-playback"],
            audio: { minDelayMs },
            video: {},
          },
          {},
        );
        const control = subscriber as unknown as {
          createOutputStream(): Promise<void>;
          audioTrackInfo: object;
          videoTrackInfo: object;
          audioOutput: { context: AudioContext };
          playout: import("../../src/playout/mediaPlayout").MediaPlayout;
        };
        control.audioTrackInfo = {
          name: "audio",
          packaging: "loc",
          isLive: true,
          codec: "opus",
          samplerate: 48000,
        };
        control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
        const video = document.createElement("video");
        video.playsInline = true;
        video.controls = true;
        // 自動再生の許可と音量操作は要素が所有する。無音でも音声トラック自体は流し続ける。
        video.muted = true;
        video.width = 64;
        video.height = 32;
        document.body.append(video);
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const drawing = canvas.getContext("2d");
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        const reader = probe.getContext("2d", { willReadFrequently: true });
        if (drawing === null || reader === null) throw new Error("測定用 canvas を作れない");
        const audio = new Map<number, number>();
        const displays = new Map<number, number>();
        let callback = 0;
        let displayedFrames = 0;
        let played = 0;
        let playError = "";
        const recordPlayError = (error: unknown): void => {
          playError = String(error);
        };
        const widths = new Set<number>();
        const diag: {
          id: number;
          late: number;
          target: number;
          drops: number;
          compressedMs: number;
          latenessMs: number;
          clockDrift: number;
        }[] = [];
        const decisions: string[] = [];
        let tap: AudioWorkletNode | null = null;
        let source: MediaStreamAudioSourceNode | null = null;
        const module = URL.createObjectURL(
          new Blob(
            [
              `
        class SignalProbe extends AudioWorkletProcessor {
          peak = 0;
          onset = 0;
          quiet = 0;
          process(inputs) {
            const samples = inputs[0]?.[0];
            if (samples) for (let index = 0; index < samples.length; index++) {
              const amplitude = Math.abs(samples[index]);
              if (amplitude > 0.08) {
                if (this.peak === 0) this.onset = currentFrame + index;
                this.peak = Math.max(this.peak, amplitude);
                this.quiet = 0;
              } else if (this.peak > 0 && ++this.quiet >= sampleRate * 0.005) {
                this.port.postMessage({ id: Math.round((this.peak - 0.1) / 0.02), frame: this.onset });
                this.peak = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('signal-probe', SignalProbe);
      `,
            ],
            { type: "text/javascript" },
          ),
        );
        try {
          await control.createOutputStream();
          const stream: MediaStream | null = subscriber.mediaStream;
          if (stream === null) throw new Error("出力 MediaStream がない");
          video.srcObject = stream;
          const playing = video.play().catch(recordPlayError);
          const context = control.audioOutput.context;
          await context.resume();
          await context.audioWorklet.addModule(module);
          tap = new AudioWorkletNode(context, "signal-probe");
          // 要素と同じ音声トラックを分岐して観測する。出力先の差し替えや API の置換はしない。
          source = context.createMediaStreamSource(stream);
          source.connect(tap).connect(context.destination);
          tap.port.onmessage = (event: MessageEvent<{ id: number; frame: number }>) => {
            if (!audio.has(event.data.id)) {
              // この値は capture 側の処理時刻。デバイスの出力時計として扱わない。
              audio.set(
                event.data.id,
                performance.now() +
                  (event.data.frame / context.sampleRate - context.currentTime) * 1000,
              );
            }
          };
          const record: VideoFrameRequestCallback = (_now, metadata) => {
            displayedFrames++;
            widths.add(video.videoWidth);
            reader.drawImage(video, 0, 0, 1, 1);
            const id = Math.round((reader.getImageData(0, 0, 1, 1).data[0] ?? 0) / 8);
            if (id > 0 && !displays.has(id)) displays.set(id, metadata.expectedDisplayTime);
            callback = video.requestVideoFrameCallback(record);
          };
          callback = video.requestVideoFrameCallback(record);
          const clockBase = context.currentTime * 1000 - performance.now();
          const origin = performance.now() + 30;
          const epoch = Math.round((performance.timeOrigin + origin) * 1000);
          for (let index = 0; index < 240; index++) {
            const remaining = origin + index * 20 - performance.now();
            if (remaining > 0)
              await new Promise<void>((resolve) => {
                setTimeout(resolve, remaining);
              });
            if (index === 100) video.pause();
            if (index === 110) void video.play().catch(recordPlayError);
            if (index === 120) canvas.width = 32;
            const id = Math.floor(index / 10) + 1;
            const timestamp = epoch + index * 20000;
            if (index === 80 && stallMs > 0) {
              const until = performance.now() + stallMs;
              while (performance.now() < until) {
                // メインスレッドだけを止めて供給のバーストを再現する (診断用)
              }
            }
            if (index % 10 === 0) {
              const stats = control.playout.getStats();
              diag.push({
                id,
                late: performance.now() - (origin + index * 20),
                target: stats.audio?.delay.targetMs ?? -1,
                drops: stats.audio?.drops ?? -1,
                compressedMs: stats.audio?.compressedMs ?? -1,
                latenessMs: stats.audio?.latenessMs ?? -1,
                clockDrift:
                  control.audioOutput.context.currentTime * 1000 - performance.now() - clockBase,
              });
            }
            // 200 ms ごとの 20 ms パルスと同時に画面の識別子を更新する。
            const data = new AudioData({
              format: "f32",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: 960,
              timestamp,
              data: new Float32Array(960).fill(index % 10 === 0 ? 0.1 + id * 0.02 : 0),
            });
            control.playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
            const decision = control.playout.pushAudio(data);
            data.close();
            if (decision.status === "error") throw decision.error;
            if (decision.status === "played") played++;
            else decisions.push(`${index}:${decision.status}`);
            drawing.fillStyle = `rgb(${id * 8}, 0, 0)`;
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            control.playout.trackVideoDecodeInput(timestamp, {
              timestampKind: "wallClock",
              location: { group: BigInt(index), object: 0n },
            });
            control.playout.pushVideo(new VideoFrame(canvas, { timestamp }));
          }
          await control.playout.drainAudio();
          await playing;
          const summarize = (values: number[]) => {
            values.sort((a, b) => a - b);
            return {
              samples: values.length,
              p50: values[Math.floor(values.length * 0.5)] ?? null,
              p95: values[Math.floor(values.length * 0.95)] ?? null,
              max: values.at(-1) ?? null,
            };
          };
          // 始動と pause 区間を除外し、再開後の区間も含めて遅延の蓄積を検出する。
          const stable = (id: number) => id >= 6 && id !== 11 && id !== 12;
          const age = (entries: Map<number, number>) =>
            [...entries]
              .filter(([id]) => stable(id))
              .map(([id, time]) => time - origin - (id - 1) * 200);
          const observationDelta = [...displays].flatMap(([id, time]) => {
            const capturedAt = audio.get(id);
            return stable(id) && capturedAt !== undefined ? [time - capturedAt] : [];
          });
          const tracks = stream.getTracks();
          const state = { paused: video.paused, mediaTime: video.currentTime };
          await subscriber.close();
          return {
            minDelayMs,
            played,
            playError,
            displayedFrames,
            widths: [...widths],
            ...state,
            audioTracks: stream.getAudioTracks().length,
            videoTracks: stream.getVideoTracks().length,
            ended: tracks.every((track) => track.readyState === "ended"),
            audioTrackAgeMs: summarize(age(audio)),
            videoDisplayAgeMs: summarize(age(displays)),
            observationDeltaMs: summarize(observationDelta),
            decisions,
            diag: diag.map((d) => ({
              ...d,
              age: (audio.get(d.id) ?? Number.NaN) - origin - (d.id - 1) * 200,
              vage: (displays.get(d.id) ?? Number.NaN) - origin - (d.id - 1) * 200,
            })),
          };
        } finally {
          video.cancelVideoFrameCallback(callback);
          video.pause();
          video.srcObject = null;
          source?.disconnect();
          tap?.disconnect();
          tap?.port.close();
          await subscriber.close();
          video.remove();
          URL.revokeObjectURL(module);
        }
      },
      { minDelayMs, stallMs: Number(process.env.STALL_MS ?? "0") },
    );
    await testInfo.attach("MediaStream と video 要素の観測", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    console.log("MediaStream と video 要素の観測", JSON.stringify(result));
    assert.equal(result.playError, "");
    assert.equal(result.audioTracks, 1);
    assert.equal(result.videoTracks, 1);
    assert.equal(result.played, 240);
    assert.equal(result.paused, false);
    assert.ok(result.mediaTime > 3);
    assert.ok(result.displayedFrames > 140, "フレームを捨てて遅延を小さく見せないこと");
    assert.ok(
      result.widths.includes(16) && result.widths.includes(32),
      "解像度変更後も表示すること",
    );
    assert.ok(result.audioTrackAgeMs.samples >= 12 && result.videoDisplayAgeMs.samples >= 12);
    // ブラウザーの描画周期とキャプチャー分岐を含む回帰検出の上限。超低遅延の保証値ではない。
    assert.ok((result.audioTrackAgeMs.p95 ?? Infinity) < 150, JSON.stringify(result));
    assert.ok((result.videoDisplayAgeMs.p95 ?? Infinity) < 150, JSON.stringify(result));
    assert.equal(result.ended, true);
  });
}
