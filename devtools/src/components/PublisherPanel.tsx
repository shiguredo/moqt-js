import { useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { usePublisher } from "../hooks/usePublisher";
import { StatList, StatSection, TimingTable } from "./StatsView";
import { PUBLISHER_LATENCY_BREAKDOWN_HELP, PUBLISH_TIMING_CAPTION } from "./statsHelp";
import { formatBytes } from "../utils/logFormatters";
import { CatalogTracks } from "./CatalogTracks";
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
  const { togglePreview, startPublishing, stopPublishing } = usePublisher();

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

  const isPublishing = pub.publisher.value !== null;
  const isStopping = pub.isStopping.value;
  const previewBtnDisabled = isPublishing || isStopping;
  const publishBtnDisabled = isPublishing || isStopping;
  const stopBtnDisabled = !isPublishing || isStopping;
  const publishTiming = pub.publishTiming.value;
  const sessionStats = pub.pubSession.value?.getStatistics();

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
          </h2>
          <span class={getBadgeClasses()}>{getBadgeText()}</span>
        </div>
      </div>

      <div class="p-5">
        {/* Status Message */}
        <div
          class={getStatusClasses()}
          title={pub.pubStatusMessage.value}
          data-testid="publisher-status-message"
        >
          {pub.pubStatusMessage.value}
        </div>

        {/* Forward State。配信していない間も描き、値を「-」にする (配信の開始で行が
            現れると映像の位置が動く) */}
        <div
          class="mb-4 px-4 py-2 rounded-lg text-sm bg-slate-100 text-slate-600 truncate"
          data-testid="publisher-forward-state"
        >
          Forward State:{" "}
          <span
            class={
              pub.forwardState.value === true ? "text-green-700 font-medium" : "text-slate-500"
            }
          >
            {formatForwardState(pub.forwardState.value)}
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

        {/* Video Container */}
        <div class="relative bg-slate-900 rounded-lg overflow-hidden aspect-video mb-4">
          <video ref={videoRef} autoPlay muted playsInline class="w-full h-full object-contain" />
          <div class="absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white font-medium">
            Local Camera
          </div>
          {pub.pubCodec.value && (
            <div class="absolute top-2 right-2 px-2 py-1 bg-green-500/80 rounded text-xs text-white font-medium">
              {pub.pubCodec.value}
            </div>
          )}
        </div>

        {/* Catalog。catalog を受け取る前も描き、値を「-」にする */}
        <CatalogTracks
          tracks={pub.catalog.value?.tracks ?? []}
          tone="green"
          testId="publisher-catalog"
        />

        {/* Statistics */}
        <div class="bg-slate-50 rounded-lg p-4">
          <StatSection title="Encoding Pipeline">
            <StatList
              items={[
                { label: "framesEncoded", value: pub.framesEncoded.value },
                { label: "chunksEncoded", value: pub.chunksEncoded.value },
                { label: "keyFrames", value: pub.keyFramesEncoded.value },
                { label: "encodeErrors", value: pub.encodeErrors.value, tone: "error" },
                {
                  label: "newGroupRequests",
                  value: pub.newGroupRequestsReceived.value,
                  testId: "publisher-new-group-requests",
                },
              ]}
            />
          </StatSection>

          <StatSection title="Transmission">
            <StatList
              items={[
                { label: "objects", value: pub.objectsSent.value },
                { label: "withExtensions", value: pub.objectsWithExtensions.value },
                { label: "bytes", value: formatBytes(pub.bytesSent.value) },
              ]}
            />
          </StatSection>

          <StatSection
            title="Latency Breakdown"
            help={PUBLISHER_LATENCY_BREAKDOWN_HELP}
            testId="publisher-latency-breakdown"
          >
            <TimingTable
              caption={PUBLISH_TIMING_CAPTION}
              testId="publisher-latency-breakdown"
              rows={[
                {
                  label: "encode",
                  summary: publishTiming.encodeMs,
                  testId: "publisher-encode-time",
                },
                { label: "send", summary: publishTiming.sendMs, testId: "publisher-send-time" },
              ]}
            />
            <StatList
              items={[
                {
                  label: "encodeQueueDrops",
                  value: publishTiming.encodeQueueDrops,
                  tone: "warn",
                  testId: "publisher-encode-queue-drops",
                },
              ]}
            />
          </StatSection>

          <StatSection title="Output">
            <StatList
              items={[
                { label: "currentGroup", value: pub.pubCurrentGroup.value },
                { label: "encoderState", value: pub.encoderState.value },
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
                  label: "unidirectionalStreamsOpened",
                  value: sessionStats?.unidirectionalStreamsOpened ?? "-",
                },
              ]}
            />
          </StatSection>
        </div>
      </div>
    </div>
  );
}
