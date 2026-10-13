/**
 * 配信側の音声メーターを動かす
 *
 * 取っている音のトラックを複製し、AudioData の取り出し経路 (ライブラリの
 * src/audioSource.ts) で読んで、peak / RMS (dBFS) と直近の波形を publisher の signal へ
 * 反映する。受信側のメーターと同じ計算 (utils/audioLevel.ts) を使うため、送る側と受ける側の
 * 値をそのまま比べられる。配信の経路 (usePublisher の processAudioFrames) とは別のトラックで
 * 読むため、符号化には影響しない。Preview 中も配信中も、音声のストリームがある間は動かす。
 *
 * publisher はページに 1 つであるため、メーターもモジュールで 1 つだけ持つ。
 */

import { createAudioFrameSource, isAudioFrameSourceAvailable } from "moqt-js";
import { addLog } from "../signals/debugLog";
import { readAudioSamples } from "../utils/audioLevel";
import { AudioMeterAccumulator } from "../utils/audioMeterAccumulator";
import type { AudioFormat } from "../utils/microphone";
import * as pub from "../signals/publisher";

/**
 * メーターの値を画面へ反映する間隔 (ミリ秒)
 *
 * 音声の AudioData は 10 ms ごとに届く。届くたびに反映すると描き直しが多すぎる
 */
const AUDIO_METER_UPDATE_INTERVAL_MS = 50;

// 動いているメーターを止める関数。止めると null に戻す
let stopCurrentMeter: (() => void) | null = null;

// メーターを開始した回数。取り出し経路の用意は非同期であるため、待っている間に
// 止められた開始を捨てるために使う
let meterGeneration = 0;

/** 取っている音の値を消す (メーターは「-」と空の波形に戻る) */
function clearMeterValues(): void {
  pub.audioMeterPeakDbfsLeft.value = null;
  pub.audioMeterPeakDbfsRight.value = null;
  pub.audioMeterRmsDbfsLeft.value = null;
  pub.audioMeterRmsDbfsRight.value = null;
  pub.audioMeterWaveformLeft.value = null;
  pub.audioMeterWaveformRight.value = null;
}

/**
 * 音声のストリームのメーターを動かす。動いているメーターは先に止める
 *
 * 取り出し経路が無いブラウザでは動かさない。メーターが動かないことは配信の可否ではない
 * ため、失敗しても配信は続ける (警告のログだけ残す)。
 *
 * @param stream - メーターの対象にする音声のストリーム
 * @param requested - 取り出し経路に要求する形式。音声の形式は配信の開始まで確定しないため、
 *   接続設定の値を渡す (メーターは `AudioData.sampleRate` を使うため、ずれても表示は壊れない)
 */
export async function startPublisherAudioMeter(
  stream: MediaStream,
  requested: AudioFormat,
): Promise<void> {
  stopPublisherAudioMeter();
  const generation = meterGeneration;
  const [track] = stream.getAudioTracks();
  if (track === undefined || !isAudioFrameSourceAvailable()) {
    return;
  }
  // 配信の経路と同じトラックを 2 つの取り出し経路で読まないよう複製する
  const meterTrack = track.clone();
  let frameSource;
  try {
    frameSource = await createAudioFrameSource(meterTrack, requested);
  } catch (error) {
    meterTrack.stop();
    addLog("warn", "[publisher] failed to start audio meter", {
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (generation !== meterGeneration) {
    // 取り出し経路を待っている間にメーターを止めた。ここで読み始めると、止めたはずの
    // AudioContext が残る
    frameSource.close();
    meterTrack.stop();
    return;
  }
  const reader = frameSource.readable.getReader();
  let stopped = false;
  stopCurrentMeter = (): void => {
    stopped = true;
    // cancel でも取り出し経路は閉じるが、読み出しを始めていない場合のために明示的に閉じる
    reader.cancel().catch(() => {
      // 既に閉じている場合は無視する
    });
    frameSource.close();
    meterTrack.stop();
  };
  void readMeter(reader, () => stopped);
}

/** メーターを止め、値を消す */
export function stopPublisherAudioMeter(): void {
  // 開始を待っているメーターも無効にする (取り出し経路を用意している最中の停止)
  meterGeneration++;
  if (stopCurrentMeter !== null) {
    stopCurrentMeter();
    stopCurrentMeter = null;
  }
  clearMeterValues();
}

/** AudioData を読み続け、間隔ごとにメーターの値を反映する */
async function readMeter(
  reader: ReadableStreamDefaultReader<AudioData>,
  isStopped: () => boolean,
): Promise<void> {
  const accumulator = new AudioMeterAccumulator(AUDIO_METER_UPDATE_INTERVAL_MS);
  try {
    for (;;) {
      const { value: audioData, done } = await reader.read();
      if (done || isStopped()) {
        audioData?.close();
        return;
      }
      try {
        const samplesLeft = readAudioSamples(audioData);
        // モノラルのときは右チャンネルを読まない (メーターの右は「-」のまま)
        const samplesRight = audioData.numberOfChannels > 1 ? readAudioSamples(audioData, 1) : null;
        const snapshot = accumulator.push(
          samplesLeft,
          samplesRight,
          audioData.sampleRate,
          performance.now(),
        );
        if (snapshot !== null) {
          pub.audioMeterPeakDbfsLeft.value = snapshot.left.peakDbfs;
          pub.audioMeterRmsDbfsLeft.value = snapshot.left.rmsDbfs;
          pub.audioMeterWaveformLeft.value = snapshot.left.waveform;
          pub.audioMeterPeakDbfsRight.value = snapshot.right?.peakDbfs ?? null;
          pub.audioMeterRmsDbfsRight.value = snapshot.right?.rmsDbfs ?? null;
          pub.audioMeterWaveformRight.value = snapshot.right?.waveform ?? null;
        }
      } finally {
        audioData.close();
      }
    }
  } catch (error) {
    // 止めたことによる中断は失敗ではない
    if (!isStopped()) {
      addLog("warn", "[publisher] audio meter stopped", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
