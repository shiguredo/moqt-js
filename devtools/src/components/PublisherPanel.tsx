import { useRef, useEffect } from "preact/hooks";
import { usePublisher } from "../hooks/usePublisher";
import { formatBytes, formatBitrate } from "../utils/codec";
import * as pub from "../signals/publisher";

function formatCatalogValue(key: string, value: unknown): string {
  if (key === "bitrate" && typeof value === "number") {
    return formatBitrate(value);
  }
  return String(value);
}

export function PublisherPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { togglePreview, startPublishing, stopPublishing } = usePublisher();

  // Update video element when mediaStream changes
  useEffect(() => {
    if (videoRef.current && pub.mediaStream.value) {
      videoRef.current.srcObject = pub.mediaStream.value;
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [pub.mediaStream.value]);

  const getStatusClasses = () => {
    const base = "mb-4 px-4 py-2 rounded-lg text-sm";
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
        <div class={getStatusClasses()}>{pub.pubStatusMessage}</div>

        {/* Forward State */}
        {pub.forwardState.value !== null && (
          <div class="mb-4 px-4 py-2 rounded-lg text-sm bg-slate-100 text-slate-600">
            Forward State:{" "}
            <span class={pub.forwardState.value ? "text-green-700 font-medium" : "text-slate-500"}>
              {pub.forwardState.value ? "1 (forwarding)" : "0 (not forwarding)"}
            </span>
          </div>
        )}

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
              {pub.pubCodec}
            </div>
          )}
        </div>

        {/* Catalog */}
        {pub.catalog.value && pub.catalog.value.tracks && pub.catalog.value.tracks.length > 0 && (
          <div class="bg-green-50 rounded-lg p-4 mb-4 border border-green-200">
            <h3 class="text-xs font-semibold text-green-700 uppercase tracking-wide mb-3 flex items-center gap-2">
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
            {pub.catalog.value.tracks.map((track, index) => (
              <div key={index} class="bg-white rounded-lg p-3 border border-green-100">
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
            Encoding Pipeline
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">framesEncoded</div>
              <div class="text-xl font-bold text-green-600">{pub.framesEncoded}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">chunksEncoded</div>
              <div class="text-xl font-bold text-green-600">{pub.chunksEncoded}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">keyFrames</div>
              <div class="text-xl font-bold text-green-600">{pub.keyFramesEncoded}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">encodeErrors</div>
              <div class="text-xl font-bold text-red-600">{pub.encodeErrors}</div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Transmission
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">objects</div>
              <div class="text-xl font-bold text-green-600">{pub.objectsSent}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">withExtensions</div>
              <div class="text-xl font-bold text-green-600">{pub.objectsWithExtensions}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">bytes</div>
              <div class="text-xl font-bold text-green-600">{formatBytes(pub.bytesSent.value)}</div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Output</h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">currentGroup</div>
              <div class="text-xl font-bold text-green-600">{pub.pubCurrentGroup}</div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">encoderState</div>
              <div class="text-sm font-bold text-slate-600">{pub.encoderState}</div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Control Stream
          </h3>
          <div class="grid grid-cols-4 gap-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">messagesSent</div>
              <div class="text-xl font-bold text-green-600">
                {pub.pubSession.value?.getStatistics().controlMessagesSent ?? 0}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">messagesReceived</div>
              <div class="text-xl font-bold text-green-600">
                {pub.pubSession.value?.getStatistics().controlMessagesReceived ?? 0}
              </div>
            </div>
          </div>

          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 mt-4">
            Data Streams
          </h3>
          <div class="grid grid-cols-4 gap-3">
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">streamsOpened</div>
              <div class="text-xl font-bold text-green-600">
                {pub.pubSession.value?.getStatistics().unidirectionalStreamsOpened ?? 0}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
