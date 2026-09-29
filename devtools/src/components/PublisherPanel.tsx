import { useEffect, useMemo, useRef } from "preact/hooks";
import { useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { usePublisher } from "../hooks/usePublisher";
import { StatGroup, StatList, StatSection, StatsCollapse, TimingTable } from "./StatsView";
import { PUBLISHER_LATENCY_BREAKDOWN_HELP, PUBLISH_TIMING_CAPTION } from "./statsHelp";
import { formatBytes } from "../utils/logFormatters";
import { formatDbfsShort } from "../utils/audioLevel";
import { AudioMeter } from "./AudioMeter";
import { VideoCard } from "./VideoCard";
import { HttpVersionBadge } from "./HttpVersionBadge";
import { CatalogTracks } from "./CatalogTracks";
import { MessageComposer } from "./MessageComposer";
import { PANEL_OPTION_ROW_CLASS } from "./panelLayout";
import * as settings from "../signals/connectionSettings";
import { type PublisherStats, buildPublisherStats } from "../signals/statsSnapshot";
import { createStatsSignal, startStatsTick } from "../signals/statsTick";
import * as pub from "../signals/publisher";

/** Forward State を表示用にする。配信していない間 (null) は「-」 */
function formatForwardState(forwardState: boolean | null): string {
  if (forwardState === null) {
    return "-";
  }
  return forwardState ? "1 (forwarding)" : "0 (not forwarding)";
}

export function PublisherPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { togglePreview, startPublishing, stopPublishing, sendEventMessage } = usePublisher();

  // mediaStream の変化に追従して video 要素の srcObject を更新する
  useSignalEffect(() => {
    if (videoRef.current && pub.mediaStream.value) {
      videoRef.current.srcObject = pub.mediaStream.value;
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  });

  const getStatusClasses = () => {
    // 1 行に収める。長い文言で折り返すと、下の映像の位置が動く (全文は title に持つ)
    const base = "mb-4 px-4 py-2 rounded-lg text-sm truncate";
    if (pub.pubStatus.value === "connected") {
      return `${base} bg-green-50 text-green-700`;
    }
    if (pub.pubStatus.value === "error") {
      return `${base} bg-red-50 text-red-700`;
    }
    return `${base} bg-slate-100 text-slate-600`;
  };

  const getBadgeClasses = () => {
    const base = "px-2 py-1 text-xs font-medium rounded-full";
    if (pub.pubStatus.value === "connected") {
      return `${base} bg-green-400/30 text-white`;
    }
    if (pub.pubStatus.value === "error") {
      return `${base} bg-red-400/30 text-white`;
    }
    return `${base} bg-white/20 text-white`;
  };

  const getBadgeText = () => {
    if (pub.pubStatus.value === "connected") return "Connected";
    if (pub.pubStatus.value === "error") return "Error";
    return "Ready";
  };

  const isPublishing = pub.isPublishing.value;
  const isStopping = pub.isStopping.value;
  const previewBtnDisabled = isPublishing || isStopping;
  const publishBtnDisabled = isPublishing || isStopping;
  const stopBtnDisabled = !isPublishing || isStopping;
  // 統計は 1 秒に 1 回だけまとめて読み直す。値は statsSignal を読む子コンポーネント
  // (PublisherVideoCard / PublisherStats) だけが購読し、パネル全体は描き直さない
  const statsSignal = useMemo(() => createStatsSignal(buildPublisherStats), []);
  useEffect(() => {
    startStatsTick();
  }, []);

  return (
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="bg-gradient-to-r from-green-500 to-green-600 px-5 py-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold text-white flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            Publisher
            {pub.httpVersion.value !== null && (
              <HttpVersionBadge version={pub.httpVersion.value} testId="publisher-http-version" />
            )}
          </h2>
          <span class={getBadgeClasses()}>{getBadgeText()}</span>
        </div>
      </div>

      <div class="p-5">
        {/* Status Message。接続の段階を示す。トラックの一覧は Catalog パネルが出す */}
        <div
          class={getStatusClasses()}
          title={pub.pubStatusMessage.value}
          data-testid="publisher-status-message"
        >
          {pub.pubStatusMessage.value}
        </div>

        {/* Forward State。配信していない間も描き、値を「-」にする (配信の開始で行が
            現れると映像の位置が動く) */}
        <div class={PANEL_OPTION_ROW_CLASS} data-testid="publisher-forward-state">
          <span>
            Forward State:{" "}
            <span
              class={
                pub.forwardState.value === true ? "text-green-700 font-medium" : "text-slate-500"
              }
            >
              {formatForwardState(pub.forwardState.value)}
            </span>
          </span>
        </div>

        {/* Buttons */}
        <div class="flex gap-3 mb-4">
          <button
            onClick={togglePreview}
            disabled={previewBtnDisabled}
            class="w-28 py-2.5 bg-slate-500 hover:bg-slate-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
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
            {pub.isPreviewActive.value ? "Stop" : "Preview"}
          </button>
          <button
            onClick={() => void startPublishing()}
            disabled={publishBtnDisabled}
            data-testid="publisher-publish-button"
            class="flex-1 px-4 py-2.5 bg-green-500 hover:bg-green-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Publish
          </button>
          <button
            onClick={() => void stopPublishing()}
            disabled={stopBtnDisabled}
            data-testid="publisher-stop-button"
            class="w-20 py-2.5 bg-red-500 hover:bg-red-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            Stop
          </button>
        </div>

        {/* Catalog。catalog を受け取る前も描き、値を「-」にする */}
        <CatalogTracks
          tracks={pub.catalog.value?.tracks ?? []}
          trackNamespace={settings.namespaceArray.value}
          tone="green"
          testId="publisher-catalog"
        />

        {/* 取っている音と送っている音のレベルメーターと波形。音声を取っていない間も描き、
            値を「-」にする (Preview の開始で現れると下の項目の位置が動く) */}
        <AudioMeter
          peakDbfsLeft={pub.audioMeterPeakDbfsLeft}
          peakDbfsRight={pub.audioMeterPeakDbfsRight}
          rmsDbfsLeft={pub.audioMeterRmsDbfsLeft}
          rmsDbfsRight={pub.audioMeterRmsDbfsRight}
          level={pub.audioMeterLevel}
          waveformLeft={pub.audioMeterWaveformLeft}
          waveformRight={pub.audioMeterWaveformRight}
          active={pub.audioStream.value !== null}
          levelActive={pub.audioPublisher.value !== null}
          testIdPrefix="publisher-audio"
        />

        {/* Video。Audio と同じ枠で囲み、映像からは読み取れない値 (符号化 fps、符号化と
            送信の遅延、捨てたフレーム数) をヘッダーに出す */}
        <PublisherVideoCard statsSignal={statsSignal}>
          <video ref={videoRef} autoPlay muted playsInline class="w-full h-full object-contain" />
          <div class="absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white font-medium">
            Local Camera
          </div>
          {/* プレビュー中は右上に Preview、配信を始めたらコーデックと解像度
              (pubCodec) に置き換える */}
          {pub.isPreviewActive.value ? (
            <div
              data-testid="publisher-preview-badge"
              class="absolute top-2 right-2 px-2 py-1 bg-slate-500/80 rounded text-xs text-white font-medium"
            >
              Preview
            </div>
          ) : (
            pub.pubCodec.value !== "" && (
              <div
                data-testid="publisher-codec-badge"
                class="absolute top-2 right-2 px-2 py-1 bg-green-500/80 rounded text-xs text-white font-medium"
              >
                {pub.pubCodec.value}
              </div>
            )
          )}
        </PublisherVideoCard>

        {/* event timeline のメッセージ入力。audio / video 以外を送る例 */}
        <MessageComposer
          disabled={pub.eventPublisher.value === null}
          onSend={(text) => void sendEventMessage(text)}
          sentCount={pub.eventMessagesSent.value}
        />

        {/* Statistics。既定で閉じ、「Statistics」を押すと開く。Audio / Video /
            Messages (event timeline) の種類ごとに分ける (audio → video の順) */}
        <StatsCollapse testId="publisher-statistics">
          <PublisherStats statsSignal={statsSignal} />
        </StatsCollapse>
      </div>
    </div>
  );
}

/** 統計。1 秒ごとにまとめて読み直したスナップショットを描く */
function PublisherStats({ statsSignal }: { statsSignal: ReadonlySignal<PublisherStats> }) {
  const stats = statsSignal.value;
  return (
    <>
      <StatGroup title="Audio">
        <StatSection title="Encoding">
          <StatList
            items={[
              { label: "chunksEncoded", value: stats.audio.chunksEncoded },
              { label: "encodeErrors", value: stats.audio.encodeErrors, tone: "error" },
            ]}
          />
        </StatSection>

        <StatSection title="Sending">
          <StatList
            items={[
              { label: "objects", value: stats.audio.objectsSent },
              {
                label: "datagramObjects",
                value: stats.audio.datagramObjectsSent,
                testId: "publisher-audio-datagram-objects",
              },
              { label: "bytes", value: formatBytes(stats.audio.bytesSent) },
              {
                label: "meterPeakDbfs",
                value: formatDbfsShort(stats.audio.meterPeakDbfs),
              },
              {
                label: "meterRmsDbfs",
                value: formatDbfsShort(stats.audio.meterRmsDbfs),
              },
              {
                label: "meterPeakDbfsRight",
                value: formatDbfsShort(stats.audio.meterPeakDbfsRight),
              },
              {
                label: "meterRmsDbfsRight",
                value: formatDbfsShort(stats.audio.meterRmsDbfsRight),
              },
              { label: "lastSentLevel", value: stats.audio.lastSentLevel ?? "-" },
              {
                label: "lastSentVoiceActivity",
                value:
                  stats.audio.lastSentVoiceActivity === null
                    ? "-"
                    : String(stats.audio.lastSentVoiceActivity),
              },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Video">
        <StatSection title="Encoding">
          <StatList
            items={[
              { label: "framesEncoded", value: stats.framesEncoded },
              { label: "chunksEncoded", value: stats.chunksEncoded },
              { label: "keyFrames", value: stats.keyFramesEncoded },
              { label: "encodeErrors", value: stats.encodeErrors, tone: "error" },
              {
                label: "newGroupRequests",
                value: stats.newGroupRequests,
                testId: "publisher-new-group-requests",
              },
            ]}
          />
        </StatSection>

        <StatSection title="Transmission">
          <StatList
            items={[
              { label: "objects", value: stats.objectsSent },
              { label: "withExtensions", value: stats.objectsWithExtensions },
              { label: "bytes", value: formatBytes(stats.bytesSent) },
            ]}
          />
        </StatSection>

        <StatSection
          title="Latency"
          help={PUBLISHER_LATENCY_BREAKDOWN_HELP}
          testId="publisher-latency-breakdown"
        >
          <TimingTable
            caption={PUBLISH_TIMING_CAPTION}
            testId="publisher-latency-breakdown"
            rows={[
              {
                label: "encode",
                summary: stats.publishTiming.encodeMs,
                testId: "publisher-encode-time",
              },
              {
                label: "send",
                summary: stats.publishTiming.sendMs,
                testId: "publisher-send-time",
              },
            ]}
          />
          <StatList
            items={[
              {
                label: "encodeQueueDrops",
                value: stats.publishTiming.encodeQueueDrops,
                tone: "warn",
                testId: "publisher-encode-queue-drops",
              },
            ]}
          />
        </StatSection>

        <StatSection title="Output">
          <StatList
            items={[
              { label: "currentGroup", value: stats.currentGroup },
              { label: "encoderState", value: stats.encoderState },
            ]}
          />
        </StatSection>
      </StatGroup>

      <StatGroup title="Messages">
        <StatSection title="Sending">
          <StatList
            items={[
              {
                label: "messagesSent",
                value: stats.event.messagesSent,
                testId: "publisher-messages-sent-stat",
              },
            ]}
          />
        </StatSection>
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
              label: "unidirectionalStreamsOpened",
              value: stats.sessionStatistics?.unidirectionalStreamsOpened ?? "-",
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
 * 統計 (符号化 fps、符号化と送信の遅延、捨てたフレーム数) は 1 秒ごとにまとめて読み直し、
 * このコンポーネントだけを描き直す
 */
function PublisherVideoCard({
  statsSignal,
  children,
}: {
  statsSignal: ReadonlySignal<PublisherStats>;
  children: ComponentChildren;
}) {
  const stats = statsSignal.value;
  return (
    <VideoCard
      testIdPrefix="publisher-video"
      fps={pub.publisher.value === null ? null : stats.publishTiming.encodedFps}
      latency={[
        {
          label: "encode",
          summary: stats.publishTiming.encodeMs,
          testId: "publisher-video-encode",
        },
        { label: "send", summary: stats.publishTiming.sendMs, testId: "publisher-video-send" },
      ]}
      dropped={pub.publisher.value === null ? null : stats.publishTiming.encodeQueueDrops}
    >
      {children}
    </VideoCard>
  );
}
