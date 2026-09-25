import { useMemo, useRef, useEffect } from "preact/hooks";
import { useSubscriber } from "../hooks/useSubscriber";
import { AudioMeter } from "./AudioMeter";
import { formatBitrate, formatBytes } from "../utils/logFormatters";
import {
  formatStallCauseTotal,
  formatLossEvent,
  formatStallEvent,
  formatTimingSummary,
} from "../utils/playbackTimingStats";
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
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Reception
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">objects</div>
              <div class="text-xl font-bold text-blue-600">{instance.objectsReceived.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">withExtensions</div>
              <div class="text-xl font-bold text-blue-600">
                {instance.objectsWithExtensions.value}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">bytes</div>
              <div class="text-xl font-bold text-blue-600">
                {formatBytes(instance.bytesReceived.value)}
              </div>
            </div>
            <button
              onClick={() => void requestKeyframe()}
              disabled={!isSubscribing || !instance.dynamicGroupsSupported.value}
              class="bg-purple-500 hover:bg-purple-600 disabled:bg-slate-200 disabled:cursor-not-allowed text-white rounded-lg p-3 border border-purple-600 disabled:border-slate-300 transition-colors flex flex-col items-center justify-center gap-1"
              title={
                instance.dynamicGroupsSupported.value
                  ? "NEW_GROUP_REQUEST を送信して新しいキーフレームを要求する"
                  : "Track did not include DYNAMIC_GROUPS=1 (draft-ietf-moq-transport-21 §9.20.20)"
              }
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span class="text-xs font-medium">Request Keyframe</span>
            </button>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Decoding Pipeline
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">chunksCreated</div>
              <div class="text-xl font-bold text-blue-600">{instance.chunksCreated.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">chunksDecoded</div>
              <div class="text-xl font-bold text-green-600">{instance.chunksDecoded.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">chunksSkipped</div>
              <div class="text-xl font-bold text-yellow-600">{instance.chunksSkipped.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">staleFramesDropped</div>
              <div class="text-xl font-bold text-yellow-600">
                {instance.staleFramesDropped.value}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">missingReferenceFramesDropped</div>
              <div class="text-xl font-bold text-yellow-600">
                {instance.missingReferenceFramesDropped.value}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">decodeErrors</div>
              <div class="text-xl font-bold text-red-600">{instance.decodeErrors.value}</div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Output</h3>
          <div class="grid grid-cols-4 gap-3 mb-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">framesDecoded</div>
              <div class="text-xl font-bold text-blue-600">{instance.framesDecoded.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">keyFrames</div>
              <div class="text-xl font-bold text-blue-600">{instance.keyFramesDecoded.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">currentGroup</div>
              <div class="text-xl font-bold text-blue-600">{instance.currentGroup.value}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">currentSubGroup</div>
              <div class="text-xl font-bold text-blue-600">{instance.currentSubGroup.value}</div>
            </div>
          </div>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">decoderState</div>
              <div class="text-sm font-bold text-slate-600">{instance.decoderState.value}</div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Playback Timing
          </h3>
          <p class="text-xs text-slate-500 mb-3">
            分布は直近 10 秒の p50 / p95 / max (ms)。latency は送信側の壁時計の LOC TIMESTAMP
            を基準にするため、別のマシンでは時計のずれを含む
          </p>
          <div class="grid grid-cols-4 gap-3 mb-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">arrivalJitter</div>
              <div class="text-sm font-bold text-blue-600" data-testid="subscriber-arrival-jitter">
                {formatTimingSummary(instance.playbackTiming.value.arrivalJitterMs)}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">latency</div>
              <div class="text-sm font-bold text-blue-600" data-testid="subscriber-latency">
                {formatTimingSummary(instance.playbackTiming.value.latencyMs)}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">decodeTime</div>
              <div class="text-sm font-bold text-blue-600" data-testid="subscriber-decode-time">
                {formatTimingSummary(instance.playbackTiming.value.decodeTimeMs)}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">displayInterval</div>
              <div
                class="text-sm font-bold text-blue-600"
                data-testid="subscriber-display-interval"
              >
                {formatTimingSummary(instance.playbackTiming.value.displayIntervalMs)}
              </div>
            </div>
          </div>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">displayFps</div>
              <div class="text-xl font-bold text-blue-600" data-testid="subscriber-display-fps">
                {instance.playbackTiming.value.displayFps}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">displayStalls</div>
              <div
                class="text-xl font-bold text-yellow-600"
                data-testid="subscriber-display-stalls"
              >
                {instance.playbackTiming.value.displayStalls}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">displayStallMs</div>
              <div
                class="text-xl font-bold text-yellow-600"
                data-testid="subscriber-display-stall-ms"
              >
                {Math.round(instance.playbackTiming.value.displayStallMs)}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">displayQueueDrops</div>
              <div
                class="text-xl font-bold text-yellow-600"
                data-testid="subscriber-display-queue-drops"
              >
                {instance.playbackTiming.value.displayQueueDrops}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">playoutDelay (jitter buffer, ms)</div>
              <div class="text-xl font-bold text-blue-600" data-testid="subscriber-playout-delay">
                {instance.playbackTiming.value.playoutDelayMs === null
                  ? "-"
                  : instance.playbackTiming.value.playoutDelayMs.toFixed(1)}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">lateFramesDropped</div>
              <div
                class="text-xl font-bold text-yellow-600"
                data-testid="subscriber-late-frames-dropped"
              >
                {instance.playbackTiming.value.lateFramesDropped}
              </div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Latency Breakdown
          </h3>
          <p class="text-xs text-slate-500 mb-3">
            描いたフレームの遅延を区間ごとに分けた直近 10 秒の p50 / p95 / max (ms)。フレームごとに
            arrival + hold + decodeWait + decode + displayWait = displayLatency になる。arrival:
            TIMESTAMP から受信まで (publisher の符号化と送信、経路、relay)、hold: Group の切り替えの
            保留、decodeWait: decoder に渡すまでの待ち、decode: 復号、displayWait: 復号から描くまで
            (jitter buffer の待ち)、displayLatency: TIMESTAMP から描くまで。arrival と
            displayLatency は publisher の壁時計の TIMESTAMP
            を基準にするため、別のマシンでは時計のずれを含む。 publisher の中の遅れは publisher の
            Latency Breakdown を見る
          </p>
          <div class="grid grid-cols-4 gap-3 mb-4" data-testid="subscriber-latency-breakdown">
            {LATENCY_SEGMENTS.map((segment) => (
              <div key={segment} class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
                <div class="text-xs text-slate-500">{segment}</div>
                <div
                  class="text-sm font-bold text-blue-600"
                  data-testid={`subscriber-latency-breakdown-${segment}`}
                >
                  {formatTimingSummary(instance.playbackTiming.value.latencyBreakdown[segment])}
                </div>
              </div>
            ))}
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Stall Causes
          </h3>
          <p class="text-xs text-slate-500 mb-3">
            止まりごとに原因を 1 つ決めた回数 / 時間 (購読開始からの累積)。source: publisher の
            TIMESTAMP の飛び、loss: Object が届いていない、discarded: 復号せずに破棄、arrival:
            到着の遅れ、groupSwitchHold: Group の切り替えの保留、decode: 復号の遅れ、playout: jitter
            buffer の再生遅延の増加、render: 描画の遅れ
          </p>
          <div class="grid grid-cols-4 gap-3 mb-3" data-testid="subscriber-stall-causes">
            {STALL_CAUSES.map((cause) => (
              <div key={cause} class="bg-white rounded-lg p-3 border border-slate-200">
                <div class="text-xs text-slate-500">{cause}</div>
                <div class="text-sm font-bold text-yellow-600">
                  {formatStallCauseTotal(instance.playbackTiming.value.stallCauses[cause])}
                </div>
              </div>
            ))}
          </div>
          <div class="grid grid-cols-4 gap-3 mb-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">missingObjects</div>
              <div class="text-xl font-bold text-red-600" data-testid="subscriber-missing-objects">
                {instance.playbackTiming.value.missingObjects}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">missingGroups</div>
              <div class="text-xl font-bold text-red-600" data-testid="subscriber-missing-groups">
                {instance.playbackTiming.value.missingGroups}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">subgroupStreamResets</div>
              <div
                class="text-xl font-bold text-red-600"
                data-testid="subscriber-subgroup-stream-resets"
              >
                {instance.playbackTiming.value.subgroupStreamResets}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">groupSwitchHoldExpirations</div>
              <div
                class="text-xl font-bold text-yellow-600"
                data-testid="subscriber-group-switch-hold-expirations"
              >
                {instance.playbackTiming.value.groupSwitchHoldExpirations}
              </div>
            </div>
          </div>
          <div class="bg-white rounded-lg p-3 border border-slate-200 mb-4">
            <div class="text-xs text-slate-500 mb-1">recentStalls (UTC, 新しい順)</div>
            <pre
              class="text-xs font-mono text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-y-auto"
              data-testid="subscriber-recent-stalls"
            >
              {instance.playbackTiming.value.recentStalls.length === 0
                ? "-"
                : [...instance.playbackTiming.value.recentStalls]
                    .reverse()
                    .map((stall) => formatStallEvent(stall))
                    .join("\n")}
            </pre>
          </div>
          <div class="bg-white rounded-lg p-3 border border-slate-200 mb-4">
            <div class="text-xs text-slate-500 mb-1">
              subgroupStreamResetsByCode (RESET_STREAM の error code ごとの数)
            </div>
            <pre
              class="text-xs font-mono text-slate-700 whitespace-pre-wrap break-all"
              data-testid="subscriber-subgroup-stream-resets-by-code"
            >
              {Object.keys(instance.playbackTiming.value.subgroupStreamResetsByCode).length === 0
                ? "-"
                : Object.entries(instance.playbackTiming.value.subgroupStreamResetsByCode)
                    .map(([code, count]) => `${code}: ${count}`)
                    .join("\n")}
            </pre>
          </div>
          <div class="bg-white rounded-lg p-3 border border-slate-200 mb-4">
            <div class="text-xs text-slate-500 mb-1">
              recentLossEvents (stream の reset と欠落の止まり、UTC、新しい順)
            </div>
            <pre
              class="text-xs font-mono text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-y-auto"
              data-testid="subscriber-recent-loss-events"
            >
              {instance.playbackTiming.value.recentLossEvents.length === 0
                ? "-"
                : [...instance.playbackTiming.value.recentLossEvents]
                    .reverse()
                    .map((lossEvent) => formatLossEvent(lossEvent))
                    .join("\n")}
            </pre>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Largest Location
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">largestGroup</div>
              <div class="text-xl font-bold text-blue-600">
                {instance.largestLocation.value?.group.toString() ?? "-"}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">largestObject</div>
              <div class="text-xl font-bold text-blue-600">
                {instance.largestLocation.value?.object.toString() ?? "-"}
              </div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Control Stream
          </h3>
          <div class="grid grid-cols-4 gap-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">messagesSent</div>
              <div class="text-xl font-bold text-blue-600">
                {session?.getStatistics().controlMessagesSent ?? "-"}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">messagesReceived</div>
              <div class="text-xl font-bold text-blue-600">
                {session?.getStatistics().controlMessagesReceived ?? "-"}
              </div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 mt-4">
            Data Streams
          </h3>
          <div class="grid grid-cols-4 gap-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">streamsReceived</div>
              <div class="text-xl font-bold text-blue-600">
                {session?.getStatistics().unidirectionalStreamsReceived ?? "-"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
