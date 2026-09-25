import { useMemo, useRef, useEffect } from "preact/hooks";
import { useSubscriber } from "../hooks/useSubscriber";
import { AudioMeter } from "./AudioMeter";
import { EventLog, StatList, StatSection, StatTable, TimingTable } from "./StatsView";
import {
  DECODING_PIPELINE_HELP,
  LOSS_HELP,
  PLAYBACK_TIMING_CAPTION,
  PLAYBACK_TIMING_HELP,
  STALL_CAUSES_HELP,
  SUBSCRIBER_LATENCY_BREAKDOWN_HELP,
  TOTAL_LATENCY_SEGMENT,
} from "./statsHelp";
import { formatBitrate, formatBytes } from "../utils/logFormatters";
import { formatLossEvent, formatStallEvent } from "../utils/playbackTimingStats";
import { LATENCY_SEGMENTS } from "../utils/latencyBreakdown";
import { STALL_CAUSES } from "../utils/stallAnalysis";
import * as sub from "../signals/subscriber";

function formatCatalogValue(key: string, value: unknown): string {
  if (key === "bitrate" && typeof value === "number") {
    return formatBitrate(value);
  }
  return String(value);
}

interface SubscriberPanelProps {
  subscriberId: string;
  onRemove?: () => void;
  canRemove?: boolean;
}

export function SubscriberPanel({
  subscriberId,
  onRemove,
  canRemove = false,
}: SubscriberPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const { startSubscribing, stopSubscribing, requestKeyframe, toggleAudioPlayback } = useSubscriber(
    subscriberId,
    canvasRef,
    audioRef,
  );

  // canvas の背景を slate-800 で初期化する
  useEffect(() => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, []);

  // subscriberInstances Map 全体ではなく、対象 ID 用の派生 signal だけを購読する。
  // ID が変わらない限り同じ ReadonlySignal を使い続ける。
  const instanceSignal = useMemo(
    () => sub.getSubscriberInstanceSignal(subscriberId),
    [subscriberId],
  );
  const instance = instanceSignal.value;
  if (!instance) {
    return null;
  }

  const status = instance.status.value;
  const session = instance.session.value;
  const catalog = instance.catalog.value;
  const codec = instance.codec.value;
  const isSubscribing = instance.subscriber.value !== null;
  const isStopping = instance.isStopping.value;
  const subscribeBtnDisabled = isSubscribing || isStopping;
  const stopBtnDisabled = !isSubscribing || isStopping;
  const timing = instance.playbackTiming.value;
  const sessionStats = session?.getStatistics();

  const getStatusClasses = () => {
    const base = "mb-4 px-4 py-2 rounded-lg text-sm";
    if (status === "connected") {
      return `${base} bg-blue-50 text-blue-700`;
    }
    if (status === "error") {
      return `${base} bg-red-50 text-red-700`;
    }
    return `${base} bg-slate-100 text-slate-600`;
  };

  const getBadgeClasses = () => {
    const base = "px-2 py-1 text-xs font-medium rounded-full";
    if (status === "connected") {
      return `${base} bg-blue-400/30 text-white`;
    }
    if (status === "error") {
      return `${base} bg-red-400/30 text-white`;
    }
    return `${base} bg-white/20 text-white`;
  };

  const getBadgeText = () => {
    if (status === "connected") return "Connected";
    if (status === "error") return "Error";
    return "Ready";
  };

  return (
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold text-white flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Subscriber
          </h2>
          <div class="flex items-center gap-2">
            <span class={getBadgeClasses()}>{getBadgeText()}</span>
            {canRemove && (
              <button
                onClick={onRemove}
                disabled={isSubscribing}
                class="p-1 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Remove this subscriber"
              >
                <svg
                  class="w-5 h-5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <div class="p-5">
        {/* Status Message */}
        <div class={getStatusClasses()}>{instance.statusMessage.value}</div>

        {/* Subscribe Options */}
        <div class="mb-4 space-y-2">
          <div class="flex items-center gap-6">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={instance.newGroupRequestEnabled.value}
                onChange={(e) => {
                  instance.newGroupRequestEnabled.value = e.currentTarget.checked;
                }}
                disabled={isSubscribing}
                class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 disabled:cursor-not-allowed"
              />
              <span class="text-sm text-slate-600">NEW_GROUP_REQUEST</span>
            </label>
          </div>
        </div>

        {/* Buttons */}
        <div class="flex gap-3 mb-4">
          <button
            onClick={() => void startSubscribing()}
            disabled={subscribeBtnDisabled}
            class="flex-1 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            Start Subscribing
          </button>
          {/* 購読中の操作。統計の間ではなく、ほかの操作と並べる */}
          <button
            onClick={() => void requestKeyframe()}
            disabled={!isSubscribing || !instance.dynamicGroupsSupported.value}
            class="px-4 py-2.5 bg-purple-500 hover:bg-purple-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            title={
              instance.dynamicGroupsSupported.value
                ? "NEW_GROUP_REQUEST を送信して新しいキーフレームを要求する"
                : "Track did not include DYNAMIC_GROUPS=1 (draft-ietf-moq-transport-21 §9.20.20)"
            }
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Request Keyframe
          </button>
          <button
            onClick={() => void stopSubscribing()}
            disabled={stopBtnDisabled}
            class="px-4 py-2.5 bg-red-500 hover:bg-red-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            Stop
          </button>
        </div>

        {/* Canvas Container */}
        <div class="relative bg-slate-900 rounded-lg overflow-hidden aspect-video mb-4">
          <canvas
            ref={canvasRef}
            data-testid="subscriber-video-canvas"
            width="1280"
            height="720"
            class="w-full h-full object-contain"
          />
          <div class="absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white font-medium">
            Remote Stream
          </div>
          {codec && (
            <div class="absolute top-2 right-2 px-2 py-1 bg-blue-500/80 rounded text-xs text-white font-medium">
              {codec}
            </div>
          )}
        </div>

        {/* 受信した音声のレベルメーターと波形。音声トラックを購読していないときは
            描画しない (映像の表示を妨げない) */}
        {instance.audioSubscriber.value !== null && <AudioMeter instance={instance} />}

        {/* 受信した音声の再生 */}
        {/*
          既定では再生しない。相互運用の実測で毎回音が出ると邪魔になるため、
          トグルを明示的に有効にしたときだけ音声出力デバイスへ繋ぐ。
          <audio> は表示せず、srcObject の設定先としてだけ使う。
        */}
        <div class="flex items-center gap-3 mb-4">
          <button
            type="button"
            data-testid="subscriber-audio-playback-toggle"
            onClick={() => void toggleAudioPlayback()}
            class={`w-28 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              instance.audioPlaybackEnabled.value
                ? "bg-blue-500 hover:bg-blue-600 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {instance.audioPlaybackEnabled.value ? "Stop Audio" : "Play Audio"}
          </button>
          <span class="text-xs text-slate-500">
            {instance.audioPlaybackEnabled.value
              ? "受信した音声を再生中"
              : "受信した音声は再生しない (既定)"}
          </span>
        </div>
        <audio ref={audioRef} data-testid="subscriber-audio-element" class="hidden" />

        {/* Catalog */}
        {catalog && catalog.tracks && catalog.tracks.length > 0 && (
          <div class="bg-blue-50 rounded-lg p-4 mb-4 border border-blue-200">
            <h3 class="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-3 flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Catalog
            </h3>
            {catalog.tracks.map((track, index) => (
              <div key={index} class="bg-white rounded-lg p-3 border border-blue-100">
                <div class="grid grid-cols-4 gap-2 text-xs">
                  {Object.entries(track).map(([key, value]) => (
                    <div key={key}>
                      <div class="text-slate-500">{key}</div>
                      <div
                        class="font-semibold text-slate-700 truncate"
                        title={formatCatalogValue(key, value)}
                      >
                        {formatCatalogValue(key, value)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Statistics */}
        <div class="bg-slate-50 rounded-lg p-4">
          <StatSection title="Reception">
            <StatList
              items={[
                { label: "objects", value: instance.objectsReceived.value },
                { label: "withExtensions", value: instance.objectsWithExtensions.value },
                { label: "bytes", value: formatBytes(instance.bytesReceived.value) },
              ]}
            />
          </StatSection>

          <StatSection
            title="Decoding Pipeline"
            help={DECODING_PIPELINE_HELP}
            testId="subscriber-decoding-pipeline"
          >
            <StatList
              items={[
                { label: "chunksCreated", value: instance.chunksCreated.value },
                { label: "chunksDecoded", value: instance.chunksDecoded.value },
                { label: "chunksSkipped", value: instance.chunksSkipped.value, tone: "warn" },
                {
                  label: "staleFramesDropped",
                  value: instance.staleFramesDropped.value,
                  tone: "warn",
                },
                {
                  label: "missingReferenceFramesDropped",
                  value: instance.missingReferenceFramesDropped.value,
                  tone: "warn",
                },
                { label: "decodeErrors", value: instance.decodeErrors.value, tone: "error" },
              ]}
            />
          </StatSection>

          <StatSection title="Output">
            <StatList
              items={[
                { label: "framesDecoded", value: instance.framesDecoded.value },
                { label: "keyFrames", value: instance.keyFramesDecoded.value },
                { label: "currentGroup", value: instance.currentGroup.value },
                { label: "currentSubGroup", value: instance.currentSubGroup.value },
                { label: "decoderState", value: instance.decoderState.value },
              ]}
            />
          </StatSection>

          <StatSection
            title="Playback Timing"
            help={PLAYBACK_TIMING_HELP}
            testId="subscriber-playback-timing"
          >
            <TimingTable
              caption={PLAYBACK_TIMING_CAPTION}
              rows={[
                {
                  label: "arrivalJitter",
                  summary: timing.arrivalJitterMs,
                  testId: "subscriber-arrival-jitter",
                },
                { label: "latency", summary: timing.latencyMs, testId: "subscriber-latency" },
                {
                  label: "decodeTime",
                  summary: timing.decodeTimeMs,
                  testId: "subscriber-decode-time",
                },
                {
                  label: "displayInterval",
                  summary: timing.displayIntervalMs,
                  testId: "subscriber-display-interval",
                },
              ]}
            />
            <StatList
              items={[
                {
                  label: "displayFps",
                  value: timing.displayFps,
                  testId: "subscriber-display-fps",
                },
                {
                  label: "displayStalls",
                  value: timing.displayStalls,
                  tone: "warn",
                  testId: "subscriber-display-stalls",
                },
                {
                  label: "displayStallMs",
                  value: Math.round(timing.displayStallMs),
                  tone: "warn",
                  testId: "subscriber-display-stall-ms",
                },
                {
                  label: "displayQueueDrops",
                  value: timing.displayQueueDrops,
                  tone: "warn",
                  testId: "subscriber-display-queue-drops",
                },
                {
                  label: "playoutDelayMs",
                  value: timing.playoutDelayMs === null ? "-" : timing.playoutDelayMs.toFixed(1),
                  testId: "subscriber-playout-delay",
                },
                {
                  label: "lateFramesDropped",
                  value: timing.lateFramesDropped,
                  tone: "warn",
                  testId: "subscriber-late-frames-dropped",
                },
              ]}
            />
          </StatSection>

          <StatSection
            title="Latency Breakdown"
            help={SUBSCRIBER_LATENCY_BREAKDOWN_HELP}
            testId="subscriber-latency-breakdown"
          >
            <TimingTable
              caption={PLAYBACK_TIMING_CAPTION}
              testId="subscriber-latency-breakdown"
              rows={LATENCY_SEGMENTS.map((segment) => ({
                label: segment,
                summary: timing.latencyBreakdown[segment],
                testId: `subscriber-latency-breakdown-${segment}`,
                // 表示の遅延はほかの区間の和のため、合計の行として区切る
                total: segment === TOTAL_LATENCY_SEGMENT,
              }))}
            />
          </StatSection>

          <StatSection
            title="Stall Causes"
            help={STALL_CAUSES_HELP}
            testId="subscriber-stall-causes"
          >
            <StatTable
              caption="since start"
              columns={["count", "ms"]}
              testId="subscriber-stall-causes"
              rows={[
                ...STALL_CAUSES.map((cause) => {
                  const total = timing.stallCauses[cause];
                  return {
                    label: cause,
                    values: [String(total.count), String(Math.round(total.ms))],
                    testId: `subscriber-stall-cause-${cause}`,
                    // 起きた原因だけを目立たせる
                    tone: total.count > 0 ? ("warn" as const) : undefined,
                  };
                }),
                // 原因ごとの和は止まりの回数と時間に一致する
                {
                  label: "total",
                  values: [String(timing.displayStalls), String(Math.round(timing.displayStallMs))],
                  testId: "subscriber-stall-cause-total",
                  total: true,
                },
              ]}
            />
            <EventLog
              label="recentStalls"
              hint="UTC, newest first"
              lines={[...timing.recentStalls].reverse().map((stall) => formatStallEvent(stall))}
              testId="subscriber-recent-stalls"
            />
          </StatSection>

          <StatSection title="Loss" help={LOSS_HELP} testId="subscriber-loss">
            <StatList
              items={[
                {
                  label: "missingObjects",
                  value: timing.missingObjects,
                  tone: "error",
                  testId: "subscriber-missing-objects",
                },
                {
                  label: "missingGroups",
                  value: timing.missingGroups,
                  tone: "error",
                  testId: "subscriber-missing-groups",
                },
                {
                  label: "subgroupStreamResets",
                  value: timing.subgroupStreamResets,
                  tone: "error",
                  testId: "subscriber-subgroup-stream-resets",
                },
                {
                  label: "groupSwitchHoldExpirations",
                  value: timing.groupSwitchHoldExpirations,
                  tone: "warn",
                  testId: "subscriber-group-switch-hold-expirations",
                },
              ]}
            />
            <EventLog
              label="subgroupStreamResetsByCode"
              hint="count per error code"
              showCount={false}
              lines={Object.entries(timing.subgroupStreamResetsByCode).map(
                ([code, count]) => `${code}: ${count}`,
              )}
              testId="subscriber-subgroup-stream-resets-by-code"
            />
            <EventLog
              label="recentLossEvents"
              hint="UTC, newest first"
              lines={[...timing.recentLossEvents]
                .reverse()
                .map((lossEvent) => formatLossEvent(lossEvent))}
              testId="subscriber-recent-loss-events"
            />
          </StatSection>

          <StatSection title="Largest Location">
            <StatList
              items={[
                {
                  label: "largestGroup",
                  value: instance.largestLocation.value?.group.toString() ?? "-",
                },
                {
                  label: "largestObject",
                  value: instance.largestLocation.value?.object.toString() ?? "-",
                },
              ]}
            />
          </StatSection>

          <StatSection title="Session">
            <StatList
              items={[
                { label: "controlMessagesSent", value: sessionStats?.controlMessagesSent ?? "-" },
                {
                  label: "controlMessagesReceived",
                  value: sessionStats?.controlMessagesReceived ?? "-",
                },
                {
                  label: "unidirectionalStreamsReceived",
                  value: sessionStats?.unidirectionalStreamsReceived ?? "-",
                },
              ]}
            />
          </StatSection>
        </div>
      </div>
    </div>
  );
}
