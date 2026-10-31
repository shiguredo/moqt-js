/** Chrome の実 Web Audio で、予約と DSP を通した波形を修正前後で比較する。 */

/** 時計の学習と到着の揺らぎを分離し、本番の予約と接続を実レンダラーへ通す。 */
async function render(moduleUrl, contextRate, sampleRate, frames, firstStart) {
  const { AudioPlayoutSession } = await import(new URL("./audioPlayoutSession.ts", moduleUrl).href);
  const { AudioPlayoutTimingStats } = await import(
    new URL("./audioPlayoutTimingStats.ts", moduleUrl).href
  );
  const last = frames.at(-1);
  const end = firstStart + last.timestamp / 1000000 + last.samples.length / sampleRate;
  const context = new OfflineAudioContext(1, Math.ceil((end + 0.1) * contextRate), contextRate);
  const session = new AudioPlayoutSession({
    timing: new AudioPlayoutTimingStats(10000, performance.timeOrigin),
  });
  let actualEnd = 0;
  for (const { timestamp, samples } of frames) {
    const data = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfChannels: 1,
      numberOfFrames: samples.length,
      timestamp: Math.round(timestamp),
      data: samples,
    });
    try {
      const target = firstStart + timestamp / 1000000;
      const decision = session.playout.schedule(
        target - 0.05,
        timestamp,
        samples.length / sampleRate,
        {
          targetStartSeconds: target,
          enforceTarget: true,
          arrivalSeconds: target - 0.05,
          delaySeconds: 0.05,
          arrivalDelaySeconds: 0.05,
          presentationDelaySeconds: 0.05,
        },
      );
      if (decision.kind !== "play") throw new Error("Audio was dropped before rendering");
      const played = session.playSound(
        { context, destination: context.destination },
        decision,
        data,
        1,
        sampleRate,
        samples.length,
      );
      actualEnd = played.startAtSeconds + played.playedSeconds;
    } finally {
      data.close();
    }
  }
  const output = await context.startRendering();
  return {
    samples: output.getChannelData(0),
    endSeconds: actualEnd,
    expectedEndSeconds: end,
    concealedMs: session.playout.concealed * 1000,
  };
}

/** 倍音を含む有声音。非定常の自然発話の品質スコアとしては使わない。 */
function voice(position, rate, frequency) {
  if (frequency === 492) {
    // 短い窓では補間でき、長い窓だけでは拒否する非定常音も対照へ残す。
    const time = position / rate - 0.01;
    const phase = 2 * Math.PI * frequency * time;
    return (
      0.15 *
      (1 + 0.3 * Math.sin(2 * Math.PI * 25 * time)) *
      (Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(5 * phase))
    );
  }
  const phase = (2 * Math.PI * frequency * position) / rate;
  return 0.2 * Math.sin(phase) + 0.06 * Math.sin(2 * phase) + 0.03 * Math.sin(3 * phase);
}

export async function measure(caseName, { moduleUrl, comparisonModuleUrl }) {
  const results = [];
  const recordings = [];
  for (const [variant, url] of [
    ["primary", moduleUrl],
    ["comparison", comparisonModuleUrl],
  ]) {
    if (url === undefined) continue;
    const cases = [];
    if (caseName === "resampling") {
      for (const [contextRate, sampleRate] of [
        [48000, 48000],
        [44100, 48000],
        [48000, 16000],
        [44100, 16000],
        [48000, 44100],
      ]) {
        for (const irregular of [false, true])
          for (const fractionalStart of [0, 0.1, 0.5, 0.9]) {
            let timestamp = 0;
            const frames = Array.from({ length: 100 }, (_, index) => {
              const samples = new Float32Array(
                sampleRate / 50 - (irregular ? (index % 7) * 13 : 0),
              ).fill(0.25);
              const frame = { timestamp, samples };
              timestamp += (samples.length / sampleRate) * 1000000;
              return frame;
            });
            const start = 0.12 + fractionalStart / contextRate;
            const rendered = await render(url, contextRate, sampleRate, frames, start);
            const samples = rendered.samples.slice(
              Math.ceil((start + 0.01) * contextRate),
              Math.floor((rendered.endSeconds - 0.01) * contextRate),
            );
            cases.push({
              contextRate,
              sampleRate,
              irregular,
              fractionalStart,
              activeSamples: samples.length,
              minimum: Math.min(...samples),
              maximum: Math.max(...samples),
              anomalousSamples: samples.filter((sample) => Math.abs(sample - 0.25) > 0.001).length,
              endSeconds: rendered.endSeconds,
              expectedEndSeconds: rendered.expectedEndSeconds,
            });
          }
      }
    } else if (caseName === "low-pitch") {
      for (const sampleRate of [44100, 48000])
        for (const frequency of [68, 80, 100, 170, 492]) {
          const frames = [0, 1, 3, 4].map((index) => ({
            timestamp: index * 20000,
            samples: Float32Array.from({ length: sampleRate / 50 }, (_, offset) =>
              voice((index * sampleRate) / 50 + offset, sampleRate, frequency),
            ),
          }));
          const rendered = await render(url, sampleRate, sampleRate, frames, 0.12);
          const first = Math.round(0.162 * sampleRate);
          const samples = rendered.samples.slice(first, Math.round(0.178 * sampleRate));
          let errorEnergy = 0;
          let referenceEnergy = 0;
          for (let index = 0; index < samples.length; index++) {
            const expected = voice(first + index - 0.12 * sampleRate, sampleRate, frequency);
            errorEnergy += (samples[index] - expected) ** 2;
            referenceEnergy += expected ** 2;
          }
          cases.push({
            sampleRate,
            frequency,
            activeSamples: samples.length,
            concealedMs: rendered.concealedMs,
            silenceSamples: samples.filter((sample) => Math.abs(sample) < 1e-8).length,
            errorDb: 10 * Math.log10(Math.max(1e-20, errorEnergy / referenceEnergy)),
            endSeconds: rendered.endSeconds,
            expectedEndSeconds: rendered.expectedEndSeconds,
          });
          if (sampleRate === 48000 && frequency === 80)
            recordings.push({
              name: `low-pitch-80-${variant}`,
              sampleRate,
              samples: Array.from(rendered.samples),
            });
        }
    } else throw new Error(`Invalid waveform case: ${caseName}`);
    results.push({ moduleUrl: url, variant, cases });
  }
  return {
    caseName,
    results,
    recordings,
    valid:
      results.length > 0 &&
      results.every(
        (result) =>
          result.cases.length > 0 &&
          result.cases.every(
            (entry) =>
              entry.activeSamples > 0 &&
              Object.values(entry).every(
                (value) => typeof value !== "number" || Number.isFinite(value),
              ),
          ),
      ),
  };
}
