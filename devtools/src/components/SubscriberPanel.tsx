import { useMemo, useRef, useEffect } from "preact/hooks";
import type { ReadonlySignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useSubscriber } from "../hooks/useSubscriber";
import { AudioMeter } from "./AudioMeter";
import { VideoCard } from "./VideoCard";
import { HttpVersionBadge } from "./HttpVersionBadge";
import {
  EventLog,
  StatGroup,
  StatList,
  StatSection,
  StatTable,
  StatsCollapse,
  TimingTable,
} from "./StatsView";
import {
  DECODING_PIPELINE_HELP,
  LOSS_HELP,
  PLAYBACK_TIMING_CAPTION,
  PLAYBACK_TIMING_HELP,
  STALL_CAUSES_HELP,
  SUBSCRIBER_LATENCY_BREAKDOWN_HELP,
  TOTAL_LATENCY_SEGMENT,
} from "./statsHelp";
import { formatBytes } from "../utils/logFormatters";
import { formatDbfsShort } from "../utils/audioLevel";
import { CatalogTracks } from "./CatalogTracks";
import { MessageList } from "./MessageList";
import { PANEL_OPTION_ROW_CLASS } from "./panelLayout";
import { formatLossEvent, formatStallEvent } from "../utils/playbackTimingStats";
import { LATENCY_SEGMENTS } from "../utils/latencyBreakdown";
import { STALL_CAUSES } from "../utils/stallAnalysis";
import { subscriberControlState } from "../utils/subscriberControls";
import * as settings from "../signals/connectionSettings";
import { type SubscriberStats, buildSubscriberStats } from "../signals/statsSnapshot";
import { createStatsSignal, startStatsTick } from "../signals/statsTick";
import * as sub from "../signals/subscriber";

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
  // 統計は 1 秒に 1 回だけまとめて読み直す (値の signal を直接読むと毎フレーム描き直す)。
  // フックは早期 return より前に呼び、購読が無い間は null を返す
  const statsSignal = useMemo(
    () =>
      createStatsSignal(() => {
        const current = sub.getSubscriber(subscriberId);
        return current === undefined ? null : buildSubscriberStats(current);
      }),
    [subscriberId],
  );
  useEffect(() => {
    startStatsTick();
  }, []);
  const instance = instanceSignal.value;
  if (!instance) {
    return null;
  }

  const status = instance.status.value;
  const catalog = instance.catalog.value;
  const codec = instance.codec.value;
  // 購読の確立を待っている間も購読中として扱い、Stop で止められるようにする
  const {
    active: isSubscribing,
    startDisabled: subscribeBtnDisabled,
    stopDisabled: stopBtnDisabled,
  } = subscriberControlState({
    subscribed: sub.hasEstablishedSubscription(instance),
    starting: instance.isStarting.value,
    stopping: instance.isStopping.value,
  });

  const getStatusClasses = () => {
    // 1 行に収める。長い文言で折り返すと、下の映像の位置が動く (全文は title に持つ)
    const base = "mb-4 px-4 py-2 rounded-lg text-sm truncate";
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
            {instance.httpVersion.value !== null && (
              <HttpVersionBadge
                version={instance.httpVersion.value}
                testId="subscriber-http-version"
              />
            )}
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
        {/* Status Message。接続の段階を示す。トラックの一覧は Catalog パネルが出す */}
        <div
          class={getStatusClasses()}
          title={instance.statusMessage.value}
          data-testid="subscriber-status-message"
        >
          {instance.statusMessage.value}
        </div>

        {/* Subscribe Options。Publisher の paused 状態の行と同じ高さの枠で描き、
            映像の上端をそろえる */}
        <div class={PANEL_OPTION_ROW_CLASS}>
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
          {/*
            受信した音声の再生。既定では再生しない。相互運用の実測で毎回音が出ると
            邪魔になるため、明示的に有効にしたときだけ音声出力デバイスへ繋ぐ。
            購読の前も購読中も切り替えられる。Publisher のパネルに無い行を足すと
            下の項目の位置が 2 つのパネルでずれるため、この行に置く
          */}
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="subscriber-audio-playback-toggle"
              checked={instance.audioPlaybackEnabled.value}
              onChange={(e) => {
                // 表示は再生の状態 (audioPlaybackEnabled) に従う。押した時点では戻しておき、
                // 再生を始め終えてから切り替える (始められなかったときに表示だけ残さない)
                e.currentTarget.checked = instance.audioPlaybackEnabled.value;
                void toggleAudioPlayback();
              }}
              class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
            />
            <span class="text-sm text-slate-600">Play Audio</span>
          </label>
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
            disabled={instance.subscriber.value === null || !instance.dynamicGroupsSupported.value}
            class="px-4 py-2.5 bg-purple-500 hover:bg-purple-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            title={
              instance.dynamicGroupsSupported.value
                ? "Send NEW_GROUP_REQUEST to request a new keyframe"
                : "Track did not include DYNAMIC_GROUPS=1 (draft-ietf-moq-transport-22 §9.20.19)"
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

        {/* Catalog。catalog を受け取る前も描き、値を「-」にする */}
        <CatalogTracks
          tracks={catalog?.tracks ?? []}
          trackNamespace={settings.namespaceArray.value}
          tone="blue"
          testId="subscriber-catalog"
        />

        {/* 受信した音声のレベルメーターと波形。音声トラックを購読していない間も描き、
            値を「-」にする (購読の開始でメーターが現れると下の項目の位置が動く) */}
        <AudioMeter
          peakDbfsLeft={instance.audioPeakDbfsLeft}
          peakDbfsRight={instance.audioPeakDbfsRight}
          rmsDbfsLeft={instance.audioRmsDbfsLeft}
          rmsDbfsRight={instance.audioRmsDbfsRight}
          level={instance.audioLastLevel}
          waveformLeft={instance.audioWaveformLeft}
          waveformRight={instance.audioWaveformRight}
          active={instance.audioSubscriber.value !== null}
          levelActive={instance.audioSubscriber.value !== null}
          testIdPrefix="audio"
        />

        {/* 受信した音声の再生先。表示せず、srcObject の設定先としてだけ使う */}
        <audio ref={audioRef} data-testid="subscriber-audio-element" class="hidden" />

        {/* Video。Audio と同じ枠で囲み、映像からは読み取れない値 (表示 fps、受信から
            表示までと復号の遅延、捨てたフレーム数) をヘッダーに出す */}
        <SubscriberVideoCard
          statsSignal={statsSignal}
          subscriberActive={instance.subscriber.value !== null}
        >
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
          {/* 購読の開始に relay の cache から追いつくまでの間、古いフレームは描かない */}
          <div class="absolute top-2 right-2 flex items-center gap-2">
            {instance.catchUpPending.value && (
              <div
                data-testid="subscriber-catching-up"
                class="px-2 py-1 bg-amber-500/80 rounded text-xs text-white font-medium"
              >
                Catching up
              </div>
            )}
            {codec && (
              <div class="px-2 py-1 bg-blue-500/80 rounded text-xs text-white font-medium">
                {codec}
              </div>
            )}
          </div>
        </SubscriberVideoCard>

        {/* 受信した event timeline のメッセージ。audio / video 以外のデータ */}
        <MessageList entries={instance.eventMessages.value} testId="subscriber-messages" />

        {/* Statistics。既定で閉じ、「Statistics」を押すと開く。Audio / Video /
            Messages (event timeline) の種類ごとに分ける (audio → video の順) */}
        <StatsCollapse testId="subscriber-statistics">
          <SubscriberStats statsSignal={statsSignal} />
        </StatsCollapse>
      </div>
    </div>
  );
}

/** 統計。1 秒ごとにまとめて読み直したスナップショットを描く */
function SubscriberStats({ statsSignal }: { statsSignal: ReadonlySignal<SubscriberStats | null> }) {
  const stats = statsSignal.value;
  if (stats === null) {
    return null;
  }
  return (
    <>
      <StatGroup title="Audio">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.audio.objectsReceived },
              {
                label: "datagramObjects",
                value: stats.audio.datagramObjectsReceived,
                testId: "subscriber-audio-datagram-objects",
              },
              { label: "chunksDecoded", value: stats.audio.chunksDecoded },
              {
                // relay の cache から追いつくまでに鳴らさなかった音声 Object の数
                label: "catchUpObjectsSkipped",
                value: stats.audio.catchUpObjectsSkipped,
                tone: "warn",
                testId: "subscriber-audio-catch-up-objects-skipped",
              },
            ]}
          />
        </StatSection>

        <StatSection title="Playout">
          <StatList
            items={[
              {
                label: "decoderConfigured",
                value: String(stats.audio.decoderConfigured),
              },
              {
                label: "playbackEnabled",
                value: String(stats.audio.playbackEnabled),
              },
              {
                label: "playoutRebases",
                value: stats.audio.playoutRebases,
                tone: "warn",
              },
              {
                label: "playoutDrops",
                value: stats.audio.playoutDrops,
                tone: "warn",
              },
            ]}
          />
        </StatSection>

        <StatSection title="Meter">
          <StatList
            items={[
              { label: "peakDbfs", value: formatDbfsShort(stats.audio.peakDbfs) },
              { label: "rmsDbfs", value: formatDbfsShort(stats.audio.rmsDbfs) },
              {
                label: "peakDbfsRight",
                value: formatDbfsShort(stats.audio.peakDbfsRight),
              },
              {
                label: "rmsDbfsRight",
                value: formatDbfsShort(stats.audio.rmsDbfsRight),
              },
              { label: "lastLevel", value: stats.audio.lastLevel ?? "-" },
              {
                label: "lastVoiceActivity",
                value:
                  stats.audio.lastVoiceActivity === null
                    ? "-"
                    : String(stats.audio.lastVoiceActivity),
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Video">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.objectsReceived },
              { label: "withExtensions", value: stats.objectsWithExtensions },
              { label: "bytes", value: formatBytes(stats.bytesReceived) },
            ]}
          />
        </StatSection>

        <StatSection
          title="Decoding"
          help={DECODING_PIPELINE_HELP}
          testId="subscriber-decoding-pipeline"
        >
          <StatList
            items={[
              { label: "chunksCreated", value: stats.chunksCreated },
              { label: "chunksDecoded", value: stats.chunksDecoded },
              { label: "chunksSkipped", value: stats.chunksSkipped, tone: "warn" },
              {
                label: "staleFramesDropped",
                value: stats.staleFramesDropped,
                tone: "warn",
              },
              {
                label: "missingReferenceFramesDropped",
                value: stats.missingReferenceFramesDropped,
                tone: "warn",
              },
              { label: "decodeErrors", value: stats.decodeErrors, tone: "error" },
            ]}
          />
        </StatSection>

        <StatSection title="Output">
          <StatList
            items={[
              { label: "framesDecoded", value: stats.framesDecoded },
              {
                // relay の cache から追いつくまでに描かなかったフレームの数
                label: "catchUpFramesSkipped",
                value: stats.catchUpFramesSkipped,
                tone: "warn",
                testId: "subscriber-catch-up-frames-skipped",
              },
              { label: "keyFrames", value: stats.keyFramesDecoded },
              { label: "currentGroup", value: stats.currentGroup },
              { label: "currentSubGroup", value: stats.currentSubGroup },
              { label: "decoderState", value: stats.decoderState },
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
                summary: stats.playbackTiming.arrivalJitterMs,
                testId: "subscriber-arrival-jitter",
              },
              {
                label: "latency",
                summary: stats.playbackTiming.latencyMs,
                testId: "subscriber-latency",
              },
              {
                label: "decodeTime",
                summary: stats.playbackTiming.decodeTimeMs,
                testId: "subscriber-decode-time",
              },
              {
                label: "displayInterval",
                summary: stats.playbackTiming.displayIntervalMs,
                testId: "subscriber-display-interval",
              },
            ]}
          />
          <StatList
            items={[
              {
                label: "displayFps",
                value: stats.playbackTiming.displayFps,
                testId: "subscriber-display-fps",
              },
              {
                label: "displayStalls",
                value: stats.playbackTiming.displayStalls,
                tone: "warn",
                testId: "subscriber-display-stalls",
              },
              {
                label: "displayStallMs",
                value: Math.round(stats.playbackTiming.displayStallMs),
                tone: "warn",
                testId: "subscriber-display-stall-ms",
              },
              {
                label: "displayQueueDrops",
                value: stats.playbackTiming.displayQueueDrops,
                tone: "warn",
                testId: "subscriber-display-queue-drops",
              },
              {
                label: "playoutDelayMs",
                value:
                  stats.playbackTiming.playoutDelayMs === null
                    ? "-"
                    : stats.playbackTiming.playoutDelayMs.toFixed(1),
                testId: "subscriber-playout-delay",
              },
              {
                label: "lateFramesDropped",
                value: stats.playbackTiming.lateFramesDropped,
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
              summary: stats.playbackTiming.latencyBreakdown[segment],
              testId: `subscriber-latency-breakdown-${segment}`,
              // 表示の遅延はほかの区間の和のため、合計の行として区切る
              total: segment === TOTAL_LATENCY_SEGMENT,
            }))}
          />
        </StatSection>

        <StatSection title="Stall Causes" help={STALL_CAUSES_HELP} testId="subscriber-stall-causes">
          <StatTable
            caption="since start"
            columns={["count", "ms"]}
            testId="subscriber-stall-causes"
            rows={[
              ...STALL_CAUSES.map((cause) => {
                const total = stats.playbackTiming.stallCauses[cause];
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
                values: [
                  String(stats.playbackTiming.displayStalls),
                  String(Math.round(stats.playbackTiming.displayStallMs)),
                ],
                testId: "subscriber-stall-cause-total",
                total: true,
              },
            ]}
          />
          <EventLog
            label="recentStalls"
            hint="UTC, newest first"
            lines={[...stats.playbackTiming.recentStalls]
              .reverse()
              .map((stall) => formatStallEvent(stall))}
            testId="subscriber-recent-stalls"
          />
        </StatSection>

        <StatSection title="Loss" help={LOSS_HELP} testId="subscriber-loss">
          <StatList
            items={[
              {
                label: "missingObjects",
                value: stats.playbackTiming.missingObjects,
                tone: "error",
                testId: "subscriber-missing-objects",
              },
              {
                label: "missingGroups",
                value: stats.playbackTiming.missingGroups,
                tone: "error",
                testId: "subscriber-missing-groups",
              },
              {
                label: "subgroupStreamResets",
                value: stats.playbackTiming.subgroupStreamResets,
                tone: "error",
                testId: "subscriber-subgroup-stream-resets",
              },
              {
                label: "groupSwitchHoldExpirations",
                value: stats.playbackTiming.groupSwitchHoldExpirations,
                tone: "warn",
                testId: "subscriber-group-switch-hold-expirations",
              },
            ]}
          />
          <EventLog
            label="subgroupStreamResetsByCode"
            hint="count per error code"
            showCount={false}
            lines={Object.entries(stats.playbackTiming.subgroupStreamResetsByCode).map(
              ([code, count]) => `${code}: ${count}`,
            )}
            testId="subscriber-subgroup-stream-resets-by-code"
          />
          <EventLog
            label="recentLossEvents"
            hint="UTC, newest first"
            lines={[...stats.playbackTiming.recentLossEvents]
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
                value: stats.largestLocation?.group ?? "-",
              },
              {
                label: "largestObject",
                value: stats.largestLocation?.object ?? "-",
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Messages">
        <StatSection title="Reception">
          <StatList
            items={[
              { label: "objects", value: stats.event.objectsReceived },
              {
                // 表示している履歴の件数。event timeline は Group の先頭 Object に
                // その時点の履歴を載せるため、受信した Object の数とは別
                label: "entries",
                value: stats.event.entries,
                testId: "subscriber-message-entries",
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      {/* 音声と映像の同期の推定。値の意味はライブラリの AvSyncStats と同じで、
              未購読や jitter buffer が無効のときは既定値 (null / 0 / false) になる */}
      <StatGroup title="A/V Sync">
        <StatList
          items={[
            {
              label: "skewMs",
              value: stats.avSync.skewMs === null ? "-" : stats.avSync.skewMs.toFixed(1),
              testId: "subscriber-av-sync-skew",
            },
            {
              label: "presentationDelayMs",
              value:
                stats.avSync.presentationDelayMs === null
                  ? "-"
                  : stats.avSync.presentationDelayMs.toFixed(1),
              testId: "subscriber-av-sync-presentation-delay",
            },
            {
              label: "targetLatencyMs",
              value: stats.avSync.targetLatencyMs ?? "-",
              testId: "subscriber-av-sync-target-latency",
            },
            {
              label: "targetLatencyLimitedMs",
              value: stats.avSync.targetLatencyLimitedMs,
              tone: stats.avSync.targetLatencyLimitedMs > 0 ? "warn" : undefined,
              testId: "subscriber-av-sync-target-latency-limited",
            },
            {
              label: "audioClockFallback",
              value: String(stats.avSync.audioClockFallback),
              testId: "subscriber-av-sync-audio-clock-fallback",
            },
          ]}
        />
      </StatGroup>

      <StatGroup title="Session">
        <StatList
          items={[
            {
              label: "controlMessagesSent",
              value: stats.sessionStatistics?.controlMessagesSent ?? "-",
            },
            {
              label: "controlMessagesReceived",
              value: stats.sessionStatistics?.controlMessagesReceived ?? "-",
            },
            {
              label: "unidirectionalStreamsReceived",
              value: stats.sessionStatistics?.unidirectionalStreamsReceived ?? "-",
            },
          ]}
        />
      </StatGroup>
    </>
  );
}

/**
 * Video カード
 *
 * 統計 (表示 fps、受信から表示までと復号の遅延、捨てたフレーム数) は 1 秒ごとに
 * まとめて読み直し、このコンポーネントだけを描き直す
 */
function SubscriberVideoCard({
  statsSignal,
  subscriberActive,
  children,
}: {
  statsSignal: ReadonlySignal<SubscriberStats | null>;
  subscriberActive: boolean;
  children: ComponentChildren;
}) {
  const stats = statsSignal.value;
  if (stats === null) {
    return null;
  }
  // 表示されなかったフレーム数の合計。relay の cache から追いつくまでに意図的に
  // 描かなかった分 (catchUpFramesSkipped) は含めない
  const dropped =
    stats.staleFramesDropped +
    stats.missingReferenceFramesDropped +
    stats.playbackTiming.lateFramesDropped +
    stats.playbackTiming.displayQueueDrops;
  return (
    <VideoCard
      testIdPrefix="subscriber-video"
      fps={subscriberActive ? stats.playbackTiming.displayFps : null}
      latency={[
        {
          label: "latency",
          summary: stats.playbackTiming.latencyMs,
          testId: "subscriber-video-latency",
        },
        {
          label: "decode",
          summary: stats.playbackTiming.decodeTimeMs,
          testId: "subscriber-video-decode",
        },
      ]}
      dropped={subscriberActive ? dropped : null}
    >
      {children}
    </VideoCard>
  );
}
