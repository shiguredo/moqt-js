/**
 * 配信側の音声メーターを動かす
 *
 * 取っている音のトラックを複製し、MediaStreamTrackProcessor で AudioData を読んで、
 * peak / RMS (dBFS) と直近の波形を publisher の signal へ反映する。受信側のメーターと同じ
 * 計算 (utils/audioLevel.ts) を使うため、送る側と受ける側の値をそのまま比べられる。
 * 配信の経路 (usePublisher の processAudioFrames) とは別のトラックで読むため、符号化には
 * 影響しない。Preview 中も配信中も、音声のストリームがある間は動かす。
 *
 * publisher はページに 1 つであるため、メーターもモジュールで 1 つだけ持つ。
 */

import { isMediaStreamTrackProcessorAvailable } from "moqt-js";
import { addLog } from "../signals/debugLog";
import { readAudioSamples } from "../utils/audioLevel";
import { AudioMeterAccumulator } from "../utils/audioMeterAccumulator";
import * as pub from "../signals/publisher";

/**
 * メーターの値を画面へ反映する間隔 (ミリ秒)
 *
 * マイクの AudioData は 10 ms ごとに届く。届くたびに反映すると描き直しが多すぎる
 */
const AUDIO_METER_UPDATE_INTERVAL_MS = 50;

// 動いているメーターを止める関数。止めると null に戻す
let stopCurrentMeter: (() => void) | null = null;

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
 * MediaStreamTrackProcessor が無いブラウザ (Firefox / Safari) では動かさない
 */
export function startPublisherAudioMeter(stream: MediaStream): void {
  stopPublisherAudioMeter();
  const [track] = stream.getAudioTracks();
  if (track === undefined || !isMediaStreamTrackProcessorAvailable()) {
    return;
  }
  // 配信の経路と同じトラックを 2 つの MediaStreamTrackProcessor で読まないよう複製する
  const meterTrack = track.clone();
  const reader = new MediaStreamTrackProcessor<AudioData>({
    track: meterTrack,
  }).readable.getReader();
  let stopped = false;
  stopCurrentMeter = (): void => {
    stopped = true;
    reader.cancel().catch(() => {
      // 既に閉じている場合は無視する
    });
    meterTrack.stop();
  };
  void readMeter(reader, () => stopped);
}

/** メーターを止め、値を消す */
export function stopPublisherAudioMeter(): void {
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
