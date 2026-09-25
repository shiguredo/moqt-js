import { useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { LOC } from "moqt-js";
import {
  MAX_DBFS,
  MIN_DBFS,
  formatAudioLevel,
  formatDbfs,
  formatVoiceActivity,
} from "../utils/audioLevel";
import type { SubscriberInstance } from "../signals/subscriber";

/** レベルメーターと波形に描く値 */
interface AudioMeterValues {
  /** 復号信号の peak (dBFS) */
  peakDbfs: number | null;
  /** 復号信号の RMS (dBFS) */
  rmsDbfs: number | null;
  /** LOC Audio Level (-dBov) */
  level: LOC.AudioLevel | null;
  /** 直近の波形 (第 1 チャンネル) */
  waveform: Float32Array | null;
}

/**
 * レベルメーターと波形を canvas に描く
 *
 * 2 系統 (復号信号と LOC Audio Level) は同じゲージに混ぜず、上段に別々の行として描く。
 * 下段は直近の波形である。
 */
export function drawAudioMeter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  values: AudioMeterValues,
): void {
  ctx.clearRect(0, 0, width, height);

  const meterHeight = Math.max(4, Math.floor(height / 6));
  // 上から peak / rms / LOC Audio Level の 3 行、その下が波形
  const METER_ROW_COUNT = 3;
  const rowGap = 4;

  const rowY = (row: number): number => row * (meterHeight + rowGap);

  const fill = (row: number, dbfs: number | null, color: string): void => {
    drawMeterRow(ctx, width, rowY(row), meterHeight, dbfs, color);
  };

  fill(0, values.peakDbfs, "#f87171");
  fill(1, values.rmsDbfs, "#4ade80");
  // LOC の level は -dBov (0 が最大) のため dBFS と同じ向きに写像する
  fill(2, values.level === null ? null : -values.level.level, "#60a5fa");

  // 目盛りの縦線 (0 / -20 / -40 / -60 / -80 / -100 dB)
  ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
  ctx.lineWidth = 1;
  for (let db = MAX_DBFS; db >= MIN_DBFS; db -= 20) {
    // 上端 (0 dB) は x = width になり線幅の半分が canvas の外へ出るため内側に寄せる
    const x = Math.min(width - 1, Math.round(dbfsToX(db, width)));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, METER_ROW_COUNT * (meterHeight + rowGap) - rowGap);
    ctx.stroke();
  }

  drawWaveform(ctx, width, height, rowY(METER_ROW_COUNT), values.waveform);
}

function drawMeterRow(
  ctx: CanvasRenderingContext2D,
  width: number,
  y: number,
  height: number,
  dbfs: number | null,
  color: string,
): void {
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillRect(0, y, width, height);

  if (dbfs === null) {
    return;
  }

  // 左端 (MIN_DBFS) から現在のレベルまで塗る。無音でも 1 px は残し、
  // 「描かれていない」のか「無音」なのかを区別できるようにする
  const x = dbfsToX(dbfs, width);
  ctx.fillStyle = color;
  ctx.fillRect(0, y, Math.max(1, x), height);
}

/** dB の値を canvas の x 座標にする (0 dB が右端、MIN_DBFS が左端) */
function dbfsToX(dbfs: number, width: number): number {
  const clamped = Math.max(MIN_DBFS, Math.min(MAX_DBFS, dbfs));
  return ((clamped - MIN_DBFS) / (MAX_DBFS - MIN_DBFS)) * width;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  y: number,
  waveform: Float32Array | null,
): void {
  const waveformHeight = Math.max(1, height - y);
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillRect(0, y, width, waveformHeight);

  // 中心線 (無音の位置)
  ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
  ctx.lineWidth = 1;
  const centerY = y + waveformHeight / 2;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  if (waveform === null || waveform.length === 0) {
    return;
  }

  const half = waveformHeight / 2;
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let index = 0; index < waveform.length; index++) {
    const value = waveform[index] ?? 0;
    // -1..1 を上下いっぱいに写像する (振幅 1.0 が 0 dBFS)
    const amplitude = Math.max(-1, Math.min(1, value));
    const x = (index / Math.max(1, waveform.length - 1)) * width;
    const pointY = centerY - amplitude * half;
    if (index === 0) {
      ctx.moveTo(x, pointY);
    } else {
      ctx.lineTo(x, pointY);
    }
  }
  ctx.stroke();
}

interface AudioMeterProps {
  instance: SubscriberInstance;
  // 音声トラックを購読しているか。購読していない間は各値を「-」にし、波形は空にする
  subscribed: boolean;
}

/** 購読していない間の値の表示 */
const NOT_SUBSCRIBED = "-";

/**
 * 受信した音声のレベルメーターと波形
 *
 * 映像 canvas と同じく、signal が更新されたときだけ描き直す
 * (`requestAnimationFrame` による常時再描画はしない)。
 */
export function AudioMeter({ instance, subscribed }: AudioMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useSignalEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    drawAudioMeter(ctx, canvas.width, canvas.height, {
      peakDbfs: instance.audioPeakDbfs.value,
      rmsDbfs: instance.audioRmsDbfs.value,
      level: instance.audioLastLevel.value,
      waveform: instance.audioWaveform.value,
    });
  });

  return (
    <div data-testid="audio-meter" class="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 class="text-xs font-semibold text-slate-600 uppercase tracking-wide">Audio</h3>
        <div class="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span>
            peak{" "}
            <span data-testid="audio-peak" class="font-mono text-slate-800">
              {subscribed ? formatDbfs(instance.audioPeakDbfs.value) : NOT_SUBSCRIBED}
            </span>
          </span>
          <span>
            rms{" "}
            <span data-testid="audio-rms" class="font-mono text-slate-800">
              {subscribed ? formatDbfs(instance.audioRmsDbfs.value) : NOT_SUBSCRIBED}
            </span>
          </span>
          <span>LOC Audio Level</span>
          <span data-testid="audio-level" class="font-mono text-slate-800">
            {subscribed ? formatAudioLevel(instance.audioLastLevel.value) : NOT_SUBSCRIBED}
          </span>
          <span data-testid="audio-voice-activity" class="font-mono text-slate-800">
            {subscribed ? formatVoiceActivity(instance.audioLastLevel.value) : NOT_SUBSCRIBED}
          </span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="audio-waveform"
        width="640"
        height="96"
        class="w-full h-24 bg-slate-900 rounded"
      />
    </div>
  );
}
