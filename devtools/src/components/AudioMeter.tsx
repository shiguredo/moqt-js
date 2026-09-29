import { useRef } from "preact/hooks";
import { useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { LOC } from "moqt-js";
import {
  INACTIVE_TEXT,
  MAX_DBFS,
  MIN_DBFS,
  formatAudioLevel,
  formatDbfs,
  formatVoiceActivity,
} from "../utils/audioLevel";
import { METER_TITLE_CLASS, METER_VALUE_CLASS } from "./meterLayout";

/** レベルメーターと波形に描く値 */
interface AudioMeterValues {
  /** 音の peak (dBFS)。受信側は復号した音、送信側は取っている音 */
  peakDbfs: number | null;
  /** 音の RMS (dBFS)。受信側は復号した音、送信側は取っている音 */
  rmsDbfs: number | null;
  /** LOC Audio Level (-dBov) */
  level: LOC.AudioLevel | null;
  /** 直近の波形 (第 1 チャンネル) */
  waveform: Float32Array | null;
}

/** メーターの行 (peak / rms / LOC level) の数 */
const METER_ROW_COUNT = 3;

/** メーターの行の間隔 (px) */
const METER_ROW_GAP = 4;

/**
 * メーターの行の高さ (px)
 *
 * 上から peak / rms / LOC level の 3 行、その下が波形になる。描画 (drawAudioMeter) と、
 * どの行が何かを示すラベルの高さ揃えが同じ値を使う
 */
export function audioMeterRowHeights(height: number): readonly [number, number, number, number] {
  const meterHeight = Math.max(4, Math.floor(height / 6));
  const waveformHeight = Math.max(1, height - METER_ROW_COUNT * (meterHeight + METER_ROW_GAP));
  return [meterHeight, meterHeight, meterHeight, waveformHeight];
}

/**
 * レベルメーターと波形を canvas に描く
 *
 * 2 系統 (復号信号と LOC Audio Level) は同じゲージに混ぜず、上段に別々の行として描く。
 * 下段は直近の波形である。行の高さは audioMeterRowHeights が返す
 */
export function drawAudioMeter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  values: AudioMeterValues,
): void {
  ctx.clearRect(0, 0, width, height);

  const [meterHeight] = audioMeterRowHeights(height);

  const rowY = (row: number): number => row * (meterHeight + METER_ROW_GAP);

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
    ctx.lineTo(x, METER_ROW_COUNT * (meterHeight + METER_ROW_GAP) - METER_ROW_GAP);
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
  // 描く値。受信側は復号した音、送信側は取っている音 (peak / RMS / 波形) と送った
  // LOC Audio Level。signal のまま受け、値が変わったときにメーターだけを描き直す
  // (パネル全体を描き直さない)
  peakDbfs: ReadonlySignal<number | null>;
  rmsDbfs: ReadonlySignal<number | null>;
  level: ReadonlySignal<LOC.AudioLevel | null>;
  waveform: ReadonlySignal<Float32Array | null>;
  // 音を受けている (取っている) か。していない間は peak / RMS を「-」にし、波形は空にする
  active: boolean;
  // LOC Audio Level を出すか (受信側は購読している間、送信側は音声を送っている間)。
  // 出さない間は「-」にする
  levelActive: boolean;
  // data-testid の接頭辞 (受信側は "audio"、送信側は "publisher-audio")
  testIdPrefix: string;
}

// 値の幅は、その欄に出うる最も長い文字列の文字数に合わせる。
// 足りないと文字がはみ出し、広すぎると見出し行が 1 行に収まらない
/** peak / rms の幅 (`-100.0 dBFS` と `-`) */
const DBFS_VALUE_WIDTH_CLASS = "w-[11ch]";
/** LOC Audio Level の幅 (`not reported` と `-127 dBov`) */
const LEVEL_VALUE_WIDTH_CLASS = "w-[12ch]";
/** voice activity の幅 (`off` と `-`) */
const VOICE_VALUE_WIDTH_CLASS = "w-[3ch]";

/** メーターの canvas の高さ (px)。行の高さはこの値から求める */
const METER_CANVAS_HEIGHT = 72;

/** メーターの行の高さ (peak / rms / LOC / 波形)。drawAudioMeter の行と揃える */
const METER_ROW_HEIGHTS = audioMeterRowHeights(METER_CANVAS_HEIGHT);

// 行ごとの高さ (drawAudioMeter と同じ値)
const [PEAK_ROW_HEIGHT, RMS_ROW_HEIGHT, LEVEL_ROW_HEIGHT, WAVEFORM_ROW_HEIGHT] = METER_ROW_HEIGHTS;

/** メーターの行のラベル。幅を固定し、色は行ごとに付ける */
const METER_ROW_LABEL_CLASS = "w-8 shrink-0 text-[10px] leading-none";

interface AudioMeterValueRowProps {
  /** 行のラベル (peak / rms / LOC) */
  label: string;
  /** ラベルの色 (canvas のバーと揃える) */
  labelClass: string;
  value: string;
  valueWidthClass: string;
  testId: string;
  /** 行の高さ (px)。drawAudioMeter の行と同じ値にする */
  height: number;
}

/** メーターの 1 行のラベルと数値。canvas の行と同じ高さに揃える */
function AudioMeterValueRow({
  label,
  labelClass,
  value,
  valueWidthClass,
  testId,
  height,
}: AudioMeterValueRowProps) {
  return (
    <div class="flex items-center gap-2" style={{ height: `${height}px` }}>
      <span class={`${METER_ROW_LABEL_CLASS} ${labelClass}`}>{label}</span>
      <span data-testid={testId} class={`${METER_VALUE_CLASS} ${valueWidthClass} shrink-0`}>
        {value}
      </span>
    </div>
  );
}

/**
 * 音声のレベルメーターと波形
 *
 * 数値はそれぞれの行の左に置き、canvas の行 (バーと波形) と高さを揃える。canvas は
 * signal が更新されたときだけ描き直す (`requestAnimationFrame` による常時再描画はしない)。
 */
export function AudioMeter({
  peakDbfs,
  rmsDbfs,
  level,
  waveform,
  active,
  levelActive,
  testIdPrefix,
}: AudioMeterProps) {
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
      peakDbfs: peakDbfs.value,
      rmsDbfs: rmsDbfs.value,
      level: level.value,
      waveform: waveform.value,
    });
  });

  return (
    <div
      data-testid={`${testIdPrefix}-meter`}
      class="bg-slate-50 border border-slate-200 rounded-lg p-2 mb-4"
    >
      <div class="flex items-center justify-between gap-2 mb-1">
        <h3 class={METER_TITLE_CLASS}>Audio</h3>
        <span class="flex items-center gap-1 text-[10px] leading-none text-slate-500">
          <span>voice</span>
          <span
            data-testid={`${testIdPrefix}-voice-activity`}
            class={`${METER_VALUE_CLASS} ${VOICE_VALUE_WIDTH_CLASS}`}
          >
            {levelActive ? formatVoiceActivity(level.value) : INACTIVE_TEXT}
          </span>
        </span>
      </div>
      <div class="flex items-stretch gap-2">
        {/* 数値は各行の左に置き、canvas の行と高さを揃える */}
        <div class="flex shrink-0 flex-col gap-1">
          <AudioMeterValueRow
            label="peak"
            labelClass="text-red-500"
            value={active ? formatDbfs(peakDbfs.value) : INACTIVE_TEXT}
            valueWidthClass={DBFS_VALUE_WIDTH_CLASS}
            testId={`${testIdPrefix}-peak`}
            height={PEAK_ROW_HEIGHT}
          />
          <AudioMeterValueRow
            label="rms"
            labelClass="text-green-600"
            value={active ? formatDbfs(rmsDbfs.value) : INACTIVE_TEXT}
            valueWidthClass={DBFS_VALUE_WIDTH_CLASS}
            testId={`${testIdPrefix}-rms`}
            height={RMS_ROW_HEIGHT}
          />
          <AudioMeterValueRow
            label="LOC"
            labelClass="text-blue-500"
            value={levelActive ? formatAudioLevel(level.value) : INACTIVE_TEXT}
            valueWidthClass={LEVEL_VALUE_WIDTH_CLASS}
            testId={`${testIdPrefix}-level`}
            height={LEVEL_ROW_HEIGHT}
          />
          {/* 波形の行は数値を持たない (ラベルだけ) */}
          <div class="flex items-center" style={{ height: `${WAVEFORM_ROW_HEIGHT}px` }}>
            <span class={`${METER_ROW_LABEL_CLASS} text-sky-600`}>wave</span>
          </div>
        </div>
        <canvas
          ref={canvasRef}
          data-testid={`${testIdPrefix}-waveform`}
          width="640"
          height="72"
          class="flex-1 min-w-0 rounded bg-slate-900"
          style={{ height: `${METER_CANVAS_HEIGHT}px` }}
        />
      </div>
    </div>
  );
}
