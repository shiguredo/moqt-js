/** 実 MediaStream と media element の波形の受け渡しを、同じ設定の Context の直接出力と比較する。 */
export async function measureOutputPath() {
  const results = [];
  for (const route of ["element", "direct"]) {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const url = URL.createObjectURL(
      new Blob(
        [
          `
        class Tap extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0]?.[0];
            if (input) {
              for (let index = 0; index < input.length; index++) {
                if (Math.abs(input[index]) > 0.2) {
                  this.port.postMessage({frame: currentFrame + index, peak: input[index]});
                  return false;
                }
              }
            }
            return true;
          }
        }
        registerProcessor('tap', Tap);
      `,
        ],
        { type: "text/javascript" },
      ),
    );
    const element = document.createElement("audio");
    document.body.append(element);
    try {
      await context.audioWorklet.addModule(url);
      await context.resume();
      const tap = new AudioWorkletNode(context, "tap");
      const mute = context.createGain();
      mute.gain.value = 0;
      tap.connect(mute).connect(context.destination);
      const source = context.createBufferSource();
      const buffer = context.createBuffer(1, 4800, 48000);
      buffer.copyToChannel(new Float32Array(4800).fill(0.3), 0);
      source.buffer = buffer;
      if (route === "element") {
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        element.srcObject = destination.stream;
        await element.play();
        context.createMediaStreamSource(element.captureStream()).connect(tap);
      } else source.connect(tap);
      const start = context.currentTime + 0.25;
      const captured = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Audio output capture timed out")), 4000);
        tap.port.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        };
      });
      source.start(start);
      const detected = await captured;
      results.push({
        route,
        delayMs: (detected.frame / 48000 - start) * 1000,
        peak: detected.peak,
        baseLatencyMs: context.baseLatency * 1000,
        outputLatencyMs: context.outputLatency * 1000,
      });
      tap.port.close();
      source.disconnect();
      tap.disconnect();
      mute.disconnect();
    } finally {
      element.pause();
      const stream = element.srcObject;
      if (stream instanceof MediaStream) for (const track of stream.getTracks()) track.stop();
      element.srcObject = null;
      element.remove();
      URL.revokeObjectURL(url);
      await context.close();
    }
  }
  return results;
}
