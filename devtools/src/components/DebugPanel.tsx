import { signal, useSignalEffect, batch } from "@preact/signals";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import {
  formatAbsoluteTime,
  formatDeltaTime,
  formatElapsedTime,
  formatHexDump,
  formatMessageData,
} from "../utils/logFormatters";
import { isDebugPanelOpen, closeDebugPanel } from "../signals/debug";
import * as settings from "../signals/connectionSettings";
import * as pub from "../signals/publisher";
import * as sub from "../signals/subscriber";
import { subscriberIds } from "../signals/subscriber";

interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
  payload?: Uint8Array;
}

// 配列本体は破壊的に操作するため signal にしない。テスト用に getter を export する。
const logBuffer: LogEntry[] = [];
const MAX_LOGS = 1000;
// 追加イベントの累積カウンタ。MAX_LOGS 到達後も増え続け、autoScroll effect /
// 描画再評価のトリガになる。
export const logSequence = signal(0);
// 現在の件数表示用 signal。logSequence と一緒に更新する。
export const logCount = signal(0);
export const autoScroll = signal(true);

// テスト用に logBuffer のスナップショットを返す。
// readonly は型レベルの不変性宣言で、呼び出し側に書き換えを意図させない。
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}

// テスト用に logBuffer / logCount / logSequence を初期状態へ戻す。
export function __resetLogStateForTest(): void {
  logBuffer.length = 0;
  logCount.value = 0;
  logSequence.value = 0;
}

export function addLog(
  level: LogEntry["level"],
  message: string,
  data?: unknown,
  payload?: Uint8Array,
) {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    message,
    data,
    payload,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    // MAX_LOGS 到達後は shift 1 回で先頭を捨てる。
    // 旧実装の [...array, entry].slice(-MAX_LOGS) のフルコピー × 2 を 1 回に削減。
    logBuffer.shift();
  }
  // 2 つの signal を同時更新するため batch で effect の二重発火を防ぐ。
  batch(() => {
    logCount.value = logBuffer.length;
    logSequence.value = logSequence.value + 1;
  });
}

// 接続設定をテキストとして生成
function generateSettingsText(): string {
  // ビットレートを読みやすい形式に変換
  const bitrateValue = settings.bitrate.value;
  const bitrateText =
    bitrateValue >= 1000000
      ? `${(bitrateValue / 1000000).toFixed(1)} Mbps`
      : `${(bitrateValue / 1000).toFixed(0)} kbps`;

  // キャッシュ時間を読みやすい形式に変換
  const cacheDurationMs = settings.maxCacheDuration.value;
  const cacheDurationText =
    cacheDurationMs >= 60000
      ? `${(cacheDurationMs / 60000).toFixed(1)} min`
      : `${(cacheDurationMs / 1000).toFixed(1)} sec`;

  const lines = [
    "=== Connection Settings ===",
    `URL: ${settings.url.value}`,
    `Namespace: ${settings.namespace.value}`,
    `Track Name: ${settings.trackName.value}`,
    `Codec: ${settings.codec.value.toUpperCase()}`,
    `Resolution: ${settings.resolution.value}`,
    `Framerate: ${settings.framerate.value} fps`,
    `Bitrate: ${bitrateText} (${bitrateValue} bps)`,
    `Keyframe Interval: ${settings.keyframeInterval.value} frames`,
    `Max Cache Duration: ${cacheDurationText} (${cacheDurationMs} ms)`,
    `Use Dedicated Worker: ${settings.useDedicatedWorker.value}`,
  ];
  if (settings.certificateHash.value) {
    lines.push(`Certificate Hash: ${settings.certificateHash.value}`);
  }
  return lines.join("\n");
}

// バイト数を読みやすい形式に変換
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}

// Publisher 統計情報をテキストとして生成
function generatePublisherStatsText(): string {
  // Publisher を使ったことがあるかどうかを判定
  // objectsSent は disconnect 時にリセットされるため、他の指標も確認する
  const hasPublished =
    pub.pubCodec.value !== "" || pub.framesEncoded.value > 0 || pub.catalog.value !== null;
  if (!hasPublished && pub.pubStatus.value === "disconnected") {
    return "";
  }
  const lines = [
    "=== Publisher Statistics ===",
    `Status: ${pub.pubStatus.value}`,
    `Codec: ${pub.pubCodec.value}`,
    `Encoder State: ${pub.encoderState.value}`,
    `Frames Encoded: ${pub.framesEncoded.value}`,
    `Keyframes Encoded: ${pub.keyFramesEncoded.value}`,
    `Chunks Encoded: ${pub.chunksEncoded.value}`,
    `Objects Sent: ${pub.objectsSent.value}`,
    `Objects With Extensions: ${pub.objectsWithExtensions.value}`,
    `Bytes Sent: ${formatBytes(pub.bytesSent.value)}`,
    `Current Group: ${pub.pubCurrentGroup.value}`,
    `Encode Errors: ${pub.encodeErrors.value}`,
  ];
  // WebTransport ストリーム統計
  if (pub.pubSession.value) {
    const stats = pub.pubSession.value.getStatistics();
    lines.push(`--- Control Stream ---`);
    lines.push(`Control Messages Sent: ${stats.controlMessagesSent}`);
    lines.push(`Control Messages Received: ${stats.controlMessagesReceived}`);
    lines.push(`--- Data Streams ---`);
    lines.push(`Unidirectional Streams Opened: ${stats.unidirectionalStreamsOpened}`);
  }
  // Catalog 情報
  if (pub.catalog.value) {
    lines.push(`Catalog: ${JSON.stringify(pub.catalog.value, null, 2)}`);
  }
  return lines.join("\n");
}

// Subscriber 統計情報をテキストとして生成
function generateSubscriberStatsText(subscriberId: string): string {
  const instance = sub.getSubscriber(subscriberId);
  if (!instance) {
    return "";
  }
  const lines = [
    `=== Subscriber Statistics (${subscriberId}) ===`,
    `Status: ${instance.status.value}`,
    `Codec: ${instance.codec.value}`,
    `Decoder State: ${instance.decoderState.value}`,
    `Decoder Configured: ${instance.decoderConfigured.value}`,
    `Objects Received: ${instance.objectsReceived.value}`,
    `Objects With Extensions: ${instance.objectsWithExtensions.value}`,
    `Bytes Received: ${formatBytes(instance.bytesReceived.value)}`,
    `Current Group: ${instance.currentGroup.value}`,
    `Chunks Created: ${instance.chunksCreated.value}`,
    `Chunks Decoded: ${instance.chunksDecoded.value}`,
    `Chunks Skipped: ${instance.chunksSkipped.value}`,
    `Frames Decoded: ${instance.framesDecoded.value}`,
    `Keyframes Decoded: ${instance.keyFramesDecoded.value}`,
    `Decode Errors: ${instance.decodeErrors.value}`,
  ];
  // Largest Location 情報
  const largestLocation = instance.largestLocation.value;
  if (largestLocation) {
    lines.push(`Largest Group: ${largestLocation.group}`);
    lines.push(`Largest Object: ${largestLocation.object}`);
  }
  // セッション統計情報
  const session = instance.session.value;
  if (session) {
    const stats = session.getStatistics();
    lines.push(`--- Session Statistics ---`);
    lines.push(`Subgroup Headers Received: ${stats.subgroupHeadersReceived}`);
    lines.push(`Fetch Headers Received: ${stats.fetchHeadersReceived}`);
    lines.push(`Objects Received Via Fetch: ${stats.objectsReceivedViaFetch}`);
    lines.push(`Objects Received Via Subscribe: ${stats.objectsReceivedViaSubscribe}`);
    lines.push(`Bytes Received Via Fetch: ${formatBytes(stats.bytesReceivedViaFetch)}`);
    lines.push(`Bytes Received Via Subscribe: ${formatBytes(stats.bytesReceivedViaSubscribe)}`);
    lines.push(`Pending Subgroup Streams: ${stats.pendingSubgroupStreamsCount}`);
    lines.push(`Pending Subgroup Bytes: ${formatBytes(stats.pendingSubgroupStreamsBytes)}`);
    lines.push(`Active Subscribers: ${stats.activeSubscribers}`);
    lines.push(`Active Fetchers: ${stats.activeFetchers}`);
    lines.push(`--- Control Stream ---`);
    lines.push(`Control Messages Sent: ${stats.controlMessagesSent}`);
    lines.push(`Control Messages Received: ${stats.controlMessagesReceived}`);
    lines.push(`--- Data Streams ---`);
    lines.push(`Unidirectional Streams Received: ${stats.unidirectionalStreamsReceived}`);
  }
  // Catalog 情報
  const catalog = instance.catalog.value;
  if (catalog) {
    lines.push(`Catalog: ${JSON.stringify(catalog, null, 2)}`);
  }
  return lines.join("\n");
}

// ログをフィルタリングしてテキストとして生成
function generateLogsText(filter?: string): string {
  const filteredLogs = filter ? logBuffer.filter((log) => log.message.includes(filter)) : logBuffer;

  return filteredLogs
    .map((log) => {
      const timestamp = formatAbsoluteTime(log.timestamp);
      const parts: string[] = [`${timestamp} ${log.message}`];

      if (log.data) {
        parts.push(formatMessageData(log.data));
      }

      if (log.payload && log.payload.length > 0) {
        parts.push(`Binary (${log.payload.length} bytes):\n${formatHexDump(log.payload)}`);
      }

      return parts.join(" ");
    })
    .join("\n\n");
}

// LLM 用のフルログを生成
function generateFullLogText(filter?: string, subscriberId?: string): string {
  const sections: string[] = [];

  // 接続設定
  sections.push(generateSettingsText());

  // 統計情報
  if (subscriberId) {
    // Subscriber 指定時はその Subscriber の統計のみ
    const subStats = generateSubscriberStatsText(subscriberId);
    if (subStats) {
      sections.push(subStats);
    }
  } else if (filter === "[publisher]") {
    // Publisher ログの場合
    const pubStats = generatePublisherStatsText();
    if (pubStats) {
      sections.push(pubStats);
    }
  } else {
    // 全ログの場合は両方
    const pubStats = generatePublisherStatsText();
    if (pubStats) {
      sections.push(pubStats);
    }
    for (const id of subscriberIds.value) {
      const subStats = generateSubscriberStatsText(id);
      if (subStats) {
        sections.push(subStats);
      }
    }
  }

  // ログ
  const logsText = generateLogsText(filter);
  const filterLabel = filter ? ` (${filter})` : "";
  sections.push(`=== Debug Logs${filterLabel} ===\n${logsText}`);

  return sections.join("\n\n");
}

type ViewMode = "data" | "binary";

export function DebugPanel() {
  // ログ追加イベント (MAX_LOGS 到達後も含む) で再レンダリングをトリガするため、
  // logSequence を購読する。値自体は使わない。
  void logSequence.value;

  const logContainerRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [viewModes, setViewModes] = useState<Map<number, ViewMode>>(new Map());
  // 行コピーとボタンコピーは同時に「Copied!」表示しうるため hook を分離する。
  const rowFeedback = useCopyFeedback();
  const buttonFeedback = useCopyFeedback();

  const getViewMode = (index: number): ViewMode => viewModes.get(index) ?? "data";
  const setViewMode = (index: number, mode: ViewMode) => {
    setViewModes((prev) => new Map(prev).set(index, mode));
  };

  const toggleRow = (index: number) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const isAllExpanded = expandedRows.size > 0;

  const toggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedRows(new Set());
    } else {
      const allIndices = new Set(logBuffer.map((_, i) => i).filter((i) => logBuffer[i].data));
      setExpandedRows(allIndices);
    }
  };

  const copyToClipboard = useCallback(
    async (log: LogEntry, index: number, event: MouseEvent) => {
      event.stopPropagation();
      const timestamp = formatAbsoluteTime(log.timestamp);
      const parts: string[] = [`${timestamp} ${log.message}`];

      if (log.data) {
        parts.push(formatMessageData(log.data));
      }

      if (log.payload && log.payload.length > 0) {
        parts.push(`Binary (${log.payload.length} bytes):\n${formatHexDump(log.payload)}`);
      }

      await rowFeedback.copy(parts.join(" "), String(index));
    },
    [rowFeedback],
  );

  // 一括コピー: 全ログ
  const copyAllLogs = useCallback(async () => {
    await buttonFeedback.copy(generateFullLogText(), "all");
  }, [buttonFeedback]);

  // 一括コピー: Publisher ログ
  const copyPublisherLogs = useCallback(async () => {
    await buttonFeedback.copy(generateFullLogText("[publisher]"), "publisher");
  }, [buttonFeedback]);

  // 一括コピー: Subscriber ログ
  const copySubscriberLogs = useCallback(
    async (subscriberId: string) => {
      await buttonFeedback.copy(
        generateFullLogText(`[${subscriberId}]`, subscriberId),
        subscriberId,
      );
    },
    [buttonFeedback],
  );

  // 新しいログ追加時にトップへオートスクロール。
  // logSequence の変化でのみ発火し、autoScroll トグル単体では発火しない。
  useSignalEffect(() => {
    const sequence = logSequence.value;
    if (sequence === 0) return;
    if (!autoScroll.peek()) return;
    if (logBuffer.length === 0) return;
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  });

  // ESC キーでパネルを閉じる
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isDebugPanelOpen.value) {
        closeDebugPanel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const clearLogs = () => {
    logBuffer.length = 0;
    batch(() => {
      logCount.value = 0;
      // clear イベントを effect 側へ伝播させるため bump する。
      logSequence.value = logSequence.value + 1;
    });
  };

  const getLevelColor = (level: LogEntry["level"]) => {
    switch (level) {
      case "error":
        return "text-red-600 bg-red-50";
      case "warn":
        return "text-yellow-600 bg-yellow-50";
      case "info":
        return "text-blue-600 bg-blue-50";
      case "debug":
        return "text-slate-600 bg-slate-50";
    }
  };

  // 最初のログのタイムスタンプ
  const firstTimestamp = logBuffer.length > 0 ? logBuffer[0].timestamp : 0;

  if (!isDebugPanelOpen.value) {
    return null;
  }

  return (
    <div class="fixed top-0 right-0 h-full w-[640px] bg-white shadow-2xl z-50 border-l border-slate-200">
      {/* ヘッダー */}
      <div class="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          Debug Logs
        </h2>
        <button
          onClick={closeDebugPanel}
          class="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          title="閉じる (ESC)"
        >
          <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* コントロール */}
      <div class="flex items-center justify-between p-3 border-b border-slate-100">
        <div class="flex items-center gap-4 text-sm text-slate-600">
          <span>Logs: {logCount.value}</span>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={autoScroll.value}
              onChange={(event) => (autoScroll.value = event.currentTarget.checked)}
              class="rounded"
            />
            Auto Scroll
          </label>
          <button
            onClick={toggleExpandAll}
            class="w-24 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {isAllExpanded ? "Collapse All" : "Expand All"}
          </button>
          <button
            onClick={clearLogs}
            class="px-3 py-1.5 bg-slate-500 hover:bg-slate-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* 一括コピーボタン */}
      <div class="flex items-center gap-2 p-3 border-b border-slate-100 flex-wrap">
        <span class="text-sm text-slate-500">Copy for LLM:</span>
        <button
          onClick={copyAllLogs}
          class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            buttonFeedback.feedback.value === "all"
              ? "bg-green-500 text-white"
              : "bg-slate-200 hover:bg-slate-300 text-slate-700"
          }`}
        >
          {buttonFeedback.feedback.value === "all" ? "Copied!" : "All"}
        </button>
        <button
          onClick={copyPublisherLogs}
          class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            buttonFeedback.feedback.value === "publisher"
              ? "bg-green-500 text-white"
              : "bg-slate-200 hover:bg-slate-300 text-slate-700"
          }`}
        >
          {buttonFeedback.feedback.value === "publisher" ? "Copied!" : "Publisher"}
        </button>
        {subscriberIds.value.map((id) => (
          <button
            key={id}
            onClick={() => copySubscriberLogs(id)}
            class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              buttonFeedback.feedback.value === id
                ? "bg-green-500 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {buttonFeedback.feedback.value === id ? "Copied!" : id}
          </button>
        ))}
      </div>

      {/* ログコンテナ */}
      <div
        ref={logContainerRef}
        class="h-[calc(100vh-190px)] overflow-y-auto p-4 font-mono text-sm"
      >
        {logCount.value === 0 ? (
          <div class="flex items-center justify-center h-full text-slate-400">
            No logs yet. MOQT operations will appear here.
          </div>
        ) : (
          <div class="space-y-1">
            {(() => {
              const elements = [];
              const logsArray = logBuffer;
              for (let i = logsArray.length - 1; i >= 0; i--) {
                const log = logsArray[i];
                const originalIndex = i;
                const nextLog = i < logsArray.length - 1 ? logsArray[i + 1] : null;
                const previousTimestamp = nextLog ? nextLog.timestamp : null;
                const isExpanded = expandedRows.has(originalIndex);
                elements.push(
                  <div
                    key={originalIndex}
                    class={`rounded cursor-pointer transition-colors hover:ring-2 hover:ring-slate-300 ${getLevelColor(log.level)}`}
                    onClick={() => toggleRow(originalIndex)}
                  >
                    <div class="flex gap-2 p-2 items-center">
                      {/* 展開アイコン */}
                      {log.data && (
                        <svg
                          class={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      )}
                      {!log.data && <div class="w-4" />}
                      {/* タイムスタンプ列 */}
                      <div class="flex flex-col text-xs whitespace-nowrap min-w-[140px]">
                        <span class="text-slate-600 font-medium">
                          {formatAbsoluteTime(log.timestamp)}
                        </span>
                        <div class="flex gap-2 text-slate-400">
                          <span>{formatElapsedTime(log.timestamp, firstTimestamp)}</span>
                          {previousTimestamp !== null && (
                            <span class="text-slate-300">
                              {formatDeltaTime(log.timestamp, previousTimestamp)}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* メッセージ */}
                      <span class="flex-1 break-all">{log.message}</span>
                      {/* コピーボタン */}
                      <button
                        onClick={(event) => copyToClipboard(log, originalIndex, event)}
                        class="p-1 hover:bg-white/50 rounded transition-colors"
                        title="Copy to clipboard"
                      >
                        {rowFeedback.feedback.value === String(originalIndex) ? (
                          <svg
                            class="w-4 h-4 text-green-600"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="2"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        ) : (
                          <svg
                            class="w-4 h-4 text-slate-400 hover:text-slate-600"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="2"
                              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                            />
                          </svg>
                        )}
                      </button>
                    </div>
                    {/* データ（展開時のみ表示） */}
                    {(log.data ?? log.payload) && isExpanded && (
                      <div class="mx-2 mb-2">
                        {/* タブ */}
                        {log.payload && (
                          <div class="flex gap-1 mb-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setViewMode(originalIndex, "data");
                              }}
                              class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                                getViewMode(originalIndex) === "data"
                                  ? "bg-white/70 text-slate-700 font-medium"
                                  : "bg-white/30 text-slate-500 hover:bg-white/50"
                              }`}
                            >
                              Data
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setViewMode(originalIndex, "binary");
                              }}
                              class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                                getViewMode(originalIndex) === "binary"
                                  ? "bg-white/70 text-slate-700 font-medium"
                                  : "bg-white/30 text-slate-500 hover:bg-white/50"
                              }`}
                            >
                              Binary ({log.payload.length} bytes)
                            </button>
                          </div>
                        )}
                        {/* コンテンツ */}
                        <pre class="text-xs p-3 bg-white/70 rounded overflow-auto max-h-96">
                          {getViewMode(originalIndex) === "binary" && log.payload
                            ? formatHexDump(log.payload)
                            : formatMessageData(log.data)}
                        </pre>
                      </div>
                    )}
                  </div>,
                );
              }
              return elements;
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
