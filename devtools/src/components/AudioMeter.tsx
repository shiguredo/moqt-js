import { useRef } from "preact/hooks";
import { useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { LOC } from "moqt-js";
import {
  INACTIVE_TEXT,
  dbfsToRatio,
  formatAudioLevel,
  formatDbfs,
  formatVoiceActivity,
} from "../utils/audioLevel";
import { METER_TITLE_CLASS, METER_VALUE_CLASS } from "./meterLayout";

/**
 * 波形を canvas に描く
 *
 * 背景と中心線 (無音の位置) を描き、波形があれば折れ線で重ねる。レベル (peak / rms /
 * LOC) のバーとは描画を分け、この canvas は波形だけを描く。チャンネルごとに 1 つの
 * canvas を描く
 */
export function drawAudioWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveform: Float32Array | null,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillRect(0, 0, width, height);

  // 中心線 (無音の位置)
  ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
  ctx.lineWidth = 1;
  const centerY = height / 2;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  if (waveform === null || waveform.length === 0) {
    return;
  }

  const half = height / 2;
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
  /** 第 1 チャンネル (左) の peak (dBFS) */
  peakDbfsLeft: ReadonlySignal<number | null>;
  /** 第 2 チャンネル (右) の peak (dBFS)。モノラルでは null */
  peakDbfsRight: ReadonlySignal<number | null>;
  rmsDbfsLeft: ReadonlySignal<number | null>;
  rmsDbfsRight: ReadonlySignal<number | null>;
  level: ReadonlySignal<LOC.AudioLevel | null>;
  /** 第 1 チャンネル (左) の直近の波形 */
  waveformLeft: ReadonlySignal<Float32Array | null>;
  /** 第 2 チャンネル (右) の直近の波形。モノラルでは null */
  waveformRight: ReadonlySignal<Float32Array | null>;
  // 音を受けている (取っている) か。していない間は peak / RMS を「-」にし、波形は空にする
  active: boolean;
  // LOC Audio Level を出すか (受信側は購読している間、送信側は音声を送っている間)。
  // 出さない間は「-」にする
  levelActive: boolean;
  // data-testid の接頭辞 (受信側は "audio"、送信側は "publisher-audio")
  testIdPrefix: string;
}

// 値の幅は、その欄に出うる最も長い文字列の文字数に合わせる。
// 足りないと文字がはみ出し、広すぎると見出しが 1 行に収まらない
/** peak / rms の幅 (`-100.0 dBFS` と `-`) */
const DBFS_VALUE_WIDTH_CLASS = "w-[11ch]";
/** LOC Audio Level の幅 (`not reported` と `-127 dBov`) */
const LEVEL_VALUE_WIDTH_CLASS = "w-[12ch]";
/** voice activity の幅 (`off` と `-`) */
const VOICE_VALUE_WIDTH_CLASS = "w-[3ch]";

/**
 * 値の欄の幅 (rem)。`5.5rem` は LOC Audio Level の `not reported` (12 文字) が入る幅
 */
const VALUE_COLUMN_CLASS = "5.5rem";

/** メーターの行のラベル。幅を固定し、色は行ごとに付ける */
const METER_ROW_LABEL_CLASS = "text-[10px] leading-none";

/** バーに重ねる目盛りの位置 (dBFS)。右端 (0 dB) はバーの端で表す */
const METER_TICK_DBFS = [-20, -40, -60, -80, -100] as const;

/** 波形の canvas の大きさ (描画は幅と高さで正規化するため、表示に合わせた比率にする) */
const WAVEFORM_CANVAS_WIDTH = 320;
const WAVEFORM_CANVAS_HEIGHT = 24;

interface MeterBarProps {
  /** バーの割合 (0..1)。値が無いときは null (塗らない) */
  ratio: number | null;
  /** バーの色 (行のラベルと揃える) */
  fillClass: string;
  /** 追加のクラス (LOC の行は列をまたぐ) */
  class?: string;
}

/** レベルのバー。目盛りを重ねる */
function MeterBar({ ratio, fillClass, class: className }: MeterBarProps) {
  return (
    <div class={`relative h-1.5 min-w-0 overflow-hidden rounded bg-slate-800 ${className ?? ""}`}>
      {ratio !== null && (
        <div
          class={`absolute inset-y-0 left-0 rounded-sm ${fillClass}`}
          style={{ width: `${ratio * 100}%` }}
        />
      )}
      {METER_TICK_DBFS.map((db) => (
        <div
          key={db}
          class="absolute inset-y-0 w-px bg-slate-500/60"
          style={{ left: `${dbfsToRatio(db) * 100}%` }}
        />
      ))}
    </div>
  );
}

/** バーの割合にする。値が無い (「-」) ときは null */
function barRatio(value: number | null): number | null {
  return value === null ? null : dbfsToRatio(value);
}

/**
 * 音声のレベルメーターと波形
 *
 * レベル (peak / rms / LOC) はバー (HTML)、波形はチャンネルごとの canvas と、描画を
 * 分ける。左右のチャンネルは列で分け、peak / rms と波形は左右それぞれに出す。
 * LOC Audio Level は Object 全体の値のため 1 つだけ出す。
 *
 * canvas は signal が更新されたときだけ描き直す (`requestAnimationFrame` による
 * 常時再描画はしない)。
 */
export function AudioMeter({
  peakDbfsLeft,
  peakDbfsRight,
  rmsDbfsLeft,
  rmsDbfsRight,
  level,
  waveformLeft,
  waveformRight,
  active,
  levelActive,
  testIdPrefix,
}: AudioMeterProps) {
  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const rightCanvasRef = useRef<HTMLCanvasElement>(null);

  useSignalEffect(() => {
    const canvas = leftCanvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    drawAudioWaveform(ctx, canvas.width, canvas.height, waveformLeft.value);
  });

  useSignalEffect(() => {
    const canvas = rightCanvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    drawAudioWaveform(ctx, canvas.width, canvas.height, waveformRight.value);
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
      {/* レベルはバー、波形は canvas。左右のチャンネルは列で分ける */}
      <div
        class="grid items-center gap-x-2 gap-y-1"
        style={{
          gridTemplateColumns: `auto ${VALUE_COLUMN_CLASS} minmax(0, 1fr) ${VALUE_COLUMN_CLASS} minmax(0, 1fr)`,
        }}
      >
        {/* チャンネルの見出し */}
        <span />
        <span class="text-[10px] leading-none text-slate-500">L</span>
        <span />
        <span class="text-[10px] leading-none text-slate-500">R</span>
        <span />

        <span class={`${METER_ROW_LABEL_CLASS} text-red-500`}>peak</span>
        <span
          data-testid={`${testIdPrefix}-peak-left`}
          class={`${METER_VALUE_CLASS} ${DBFS_VALUE_WIDTH_CLASS}`}
        >
          {active ? formatDbfs(peakDbfsLeft.value) : INACTIVE_TEXT}
        </span>
        <MeterBar ratio={active ? barRatio(peakDbfsLeft.value) : null} fillClass="bg-red-400" />
        <span
          data-testid={`${testIdPrefix}-peak-right`}
          class={`${METER_VALUE_CLASS} ${DBFS_VALUE_WIDTH_CLASS}`}
        >
          {active ? formatDbfs(peakDbfsRight.value) : INACTIVE_TEXT}
        </span>
        <MeterBar ratio={active ? barRatio(peakDbfsRight.value) : null} fillClass="bg-red-400" />

        <span class={`${METER_ROW_LABEL_CLASS} text-green-600`}>rms</span>
        <span
          data-testid={`${testIdPrefix}-rms-left`}
          class={`${METER_VALUE_CLASS} ${DBFS_VALUE_WIDTH_CLASS}`}
        >
          {active ? formatDbfs(rmsDbfsLeft.value) : INACTIVE_TEXT}
        </span>
        <MeterBar ratio={active ? barRatio(rmsDbfsLeft.value) : null} fillClass="bg-green-400" />
        <span
          data-testid={`${testIdPrefix}-rms-right`}
          class={`${METER_VALUE_CLASS} ${DBFS_VALUE_WIDTH_CLASS}`}
        >
          {active ? formatDbfs(rmsDbfsRight.value) : INACTIVE_TEXT}
        </span>
        <MeterBar ratio={active ? barRatio(rmsDbfsRight.value) : null} fillClass="bg-green-400" />

        <span class={`${METER_ROW_LABEL_CLASS} text-blue-500`}>LOC</span>
        <span
          data-testid={`${testIdPrefix}-level`}
          class={`${METER_VALUE_CLASS} ${LEVEL_VALUE_WIDTH_CLASS}`}
        >
          {levelActive ? formatAudioLevel(level.value) : INACTIVE_TEXT}
        </span>
        {/* LOC Audio Level は Object 全体の値のため、左右に分けず 1 本にする */}
        <MeterBar
          class="col-span-3"
          ratio={levelActive && level.value !== null ? dbfsToRatio(-level.value.level) : null}
          fillClass="bg-blue-400"
        />

        <span class={`${METER_ROW_LABEL_CLASS} text-sky-600`}>wave</span>
        <canvas
          ref={leftCanvasRef}
          data-testid={`${testIdPrefix}-waveform-left`}
          width={WAVEFORM_CANVAS_WIDTH}
          height={WAVEFORM_CANVAS_HEIGHT}
          class="col-span-2 h-6 w-full min-w-0 rounded bg-slate-900"
        />
        <canvas
          ref={rightCanvasRef}
          data-testid={`${testIdPrefix}-waveform-right`}
          width={WAVEFORM_CANVAS_WIDTH}
          height={WAVEFORM_CANVAS_HEIGHT}
          class="col-span-2 h-6 w-full min-w-0 rounded bg-slate-900"
        />
      </div>
    </div>
  );
}
