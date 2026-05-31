import { useMemo, useRef, useEffect } from "preact/hooks";
import { useSubscriber } from "../hooks/useSubscriber";
import { formatBytes, formatBitrate } from "../utils/codec";
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
  const { startSubscribing, stopSubscribing, requestKeyframe } = useSubscriber(
    subscriberId,
    canvasRef,
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
                checked={instance.joiningFetchEnabled.value}
                onChange={(e) => {
                  instance.joiningFetchEnabled.value = e.currentTarget.checked;
                }}
                disabled={isSubscribing}
                class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 disabled:cursor-not-allowed"
              />
              <span class="text-sm text-slate-600">Joining Fetch</span>
            </label>
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
          <canvas ref={canvasRef} width="1280" height="720" class="w-full h-full object-contain" />
          <div class="absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-xs text-white font-medium">
            Remote Stream
          </div>
          {codec && (
            <div class="absolute top-2 right-2 px-2 py-1 bg-blue-500/80 rounded text-xs text-white font-medium">
              {codec}
            </div>
          )}
        </div>

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
                  : "Track did not include DYNAMIC_GROUPS=1 (draft-ietf-moq-transport-18 §10.2.13)"
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
            Joining Fetch
          </h3>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-white rounded-lg p-3 border border-slate-200 col-span-2">
              <div class="text-xs text-slate-500">largestGroup</div>
              <div class="text-xl font-bold text-blue-600">
                {instance.largestLocation.value?.group.toString() ?? "-"}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">largestObject</div>
              <div class="text-xl font-bold text-blue-600">
                {instance.largestLocation.value?.object.toString() ?? "-"}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">fetchObjects</div>
              <div class="text-xl font-bold text-purple-600">
                {instance.joiningFetchStats.value?.objectsReceived ?? 0}
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-slate-200">
              <div class="text-xs text-slate-500">fetchBytes</div>
              <div class="text-xl font-bold text-purple-600">
                {formatBytes(instance.joiningFetchStats.value?.bytesReceived ?? 0)}
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
