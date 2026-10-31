/**
 * 同じ復号 PCM と同じ圧縮上限で、時間とクロスフェードの打ち消し量を比較する。
 * 打ち消し量は線形混合のエネルギーの差であり、聴感の品質スコアではない。
 */

/** 出力と完全一致する位置だけを使い、実際に混ぜた区間の差を測る。 */
function spliceLoss(input, output, removed) {
  const center = (input.length >> 1) - removed;
  const starts = [center];
  for (let step = 1; step <= 4; step++) {
    starts.push(
      Math.round(center - ((center - 1) * step) / 4),
      Math.round(center + ((input.length - 2 * removed - 1 - center) * step) / 4),
    );
  }
  for (const start of starts) {
    if (start < 0 || start + 2 * removed > input.length) continue;
    const matches = output.every((sample, index) => {
      if (index < start) return sample === input[index];
      if (index >= start + removed) return sample === input[index + removed];
      const weight = (index - start + 1) * (1 / (removed + 1));
      return sample === Math.fround((1 - weight) * input[index] + weight * input[index + removed]);
    });
    if (!matches) continue;
    let loss = 0;
    for (let index = 0; index < removed; index++) {
      const weight = (index + 1) / (removed + 1);
      const difference = input[start + index] - input[start + removed + index];
      loss += weight * (1 - weight) * difference * difference;
    }
    return { start, loss };
  }
  // 位置探索や混合方法が変わった場合、別の波形へ古い測定法を当てはめない。
  throw new Error("Cannot identify the compression splice from output PCM");
}

/** 純粋な DSP の比較では、時計の進行による圧縮量の違いを混ぜない。 */
export function compareCompression(frames, scheduled, before, after) {
  const totals = {
    available: { frames: 0, changed: 0, beforeLoss: 0, afterLoss: 0 },
    scheduled: { frames: 0, changed: 0, beforeLoss: 0, afterLoss: 0 },
  };
  for (const [index, frame] of frames.entries()) {
    if (frame.sampleRate !== 48000 || frame.channels !== 1)
      throw new Error(`Expected mono 48000 Hz decoded PCM at frame ${index}`);
    const input = Float32Array.from(frame.samples);
    const scheduledBudget = Math.round((scheduled[index]?.compressedDeltaMs ?? 0) * 48);
    for (const [name, budget] of [
      ["available", input.length / 2],
      ["scheduled", scheduledBudget],
    ]) {
      if (budget === 0) continue;
      const original = before([input], 48000, budget);
      const candidate = after([input], 48000, budget);
      if (original.lengthChangeSamples !== candidate.lengthChangeSamples)
        throw new Error(`Compression duration changed at frame ${index}`);
      if (candidate.lengthChangeSamples === 0) continue;
      const removed = -candidate.lengthChangeSamples;
      const originalScore = spliceLoss(input, original.channels[0], removed);
      const candidateScore = spliceLoss(input, candidate.channels[0], removed);
      if (candidateScore.loss > originalScore.loss + 1e-18)
        throw new Error(`Crossfade cancellation increased at frame ${index}`);
      const total = totals[name];
      total.frames++;
      if (candidateScore.start !== originalScore.start) total.changed++;
      total.beforeLoss += originalScore.loss;
      total.afterLoss += candidateScore.loss;
    }
  }
  return totals;
}
