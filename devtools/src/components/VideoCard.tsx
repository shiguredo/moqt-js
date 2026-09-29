import type { ComponentChildren } from "preact";
import type { TimingSummary } from "../utils/playbackTimingStats";
import {
  METER_FIELD_CLASS,
  METER_HEADER_CLASS,
  METER_LABEL_CLASS,
  METER_TITLE_CLASS,
  METER_VALUE_CLASS,
} from "./meterLayout";

// 値の幅は、その欄に出うる最も長い文字列の文字数に合わせる。
// 足りないと文字がはみ出し、広すぎると見出しが 1 行に収まらない
/** fps の幅 (`120.0` と `-`) */
const FPS_VALUE_WIDTH_CLASS = "w-[5ch]";
/** 遅延の幅 (`1234.5 ms` と `-`) */
const LATENCY_VALUE_WIDTH_CLASS = "w-[10ch]";
/** 捨てたフレーム数の幅 (0 以上の整数と `-`) */
const DROPPED_VALUE_WIDTH_CLASS = "w-[7ch]";

/** 映像の遅延の 1 項目 (符号化 / 送信 / 受信から表示まで / 復号) */
export interface VideoLatencyField {
  label: string;
  /** 直近の窓の分布。記録が無いときは null */
  summary: TimingSummary | null;
  testId: string;
}

interface VideoCardProps {
  /** data-testid の接頭辞 (受信側は "subscriber-video"、送信側は "publisher-video") */
  testIdPrefix: string;
  /** 直近 1 秒の fps。映像が出ていないときは null (「-」になる) */
  fps: number | null;
  /** 遅延の項目 (p50 を出す) */
  latency: readonly VideoLatencyField[];
  /** 表示されなかったフレーム数。映像が出ていないときは null (「-」になる) */
  dropped: number | null;
  /** 映像そのもの (video / canvas と、その上に重ねるバッジ) */
  children: ComponentChildren;
}

/** fps を表示用にする。映像が出ていない間は「-」 */
function formatFps(fps: number | null): string {
  return fps === null ? "-" : fps.toFixed(1);
}

/** 遅延 (p50、ms) を表示用にする。記録が無い間は「-」 */
function formatLatency(summary: TimingSummary | null): string {
  return summary === null ? "-" : `${summary.p50.toFixed(1)} ms`;
}

/** 捨てたフレーム数を表示用にする。映像が出ていない間は「-」 */
function formatDropped(dropped: number | null): string {
  return dropped === null ? "-" : String(dropped);
}

/**
 * 映像のカード
 *
 * 映像を AudioMeter と同じ枠で囲み、見出しに映像そのものからは読み取れない値
 * (fps と遅延、捨てたフレーム数) を出す。遅延の区間は publisher が符号化 / 送信、
 * subscriber が受信から表示まで / 復号とする。コーデックと状態のバッジは
 * これまでどおり映像の上に重ねる
 */
export function VideoCard({ testIdPrefix, fps, latency, dropped, children }: VideoCardProps) {
  return (
    <div
      data-testid={`${testIdPrefix}-card`}
      class="bg-slate-50 border border-slate-200 rounded-lg p-2 mb-4"
    >
      <div class={METER_HEADER_CLASS}>
        <h3 class={METER_TITLE_CLASS}>Video</h3>
        <span class={METER_FIELD_CLASS}>
          <span class={METER_LABEL_CLASS}>fps</span>
          <span
            data-testid={`${testIdPrefix}-fps`}
            class={`${METER_VALUE_CLASS} ${FPS_VALUE_WIDTH_CLASS}`}
          >
            {formatFps(fps)}
          </span>
        </span>
        {latency.map((field) => (
          <span key={field.label} class={METER_FIELD_CLASS}>
            <span class={METER_LABEL_CLASS}>{field.label}</span>
            <span
              data-testid={field.testId}
              class={`${METER_VALUE_CLASS} ${LATENCY_VALUE_WIDTH_CLASS}`}
            >
              {formatLatency(field.summary)}
            </span>
          </span>
        ))}
        <span class={METER_FIELD_CLASS}>
          <span class={METER_LABEL_CLASS}>dropped</span>
          <span
            data-testid={`${testIdPrefix}-dropped`}
            class={`${METER_VALUE_CLASS} ${DROPPED_VALUE_WIDTH_CLASS}`}
          >
            {formatDropped(dropped)}
          </span>
        </span>
      </div>
      <div class="relative bg-slate-900 rounded-lg overflow-hidden aspect-video">{children}</div>
    </div>
  );
}
