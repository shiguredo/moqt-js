import { signal, useSignalEffect } from "@preact/signals";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
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

// グローバルログストア
export const logs = signal<LogEntry[]>([]);
const MAX_LOGS = 1000;
export const autoScroll = signal(true);

// RFC 形式のフィールド名マッピング
const RFC_FIELD_NAMES: Record<string, string> = {
  requestId: "Request ID",
  trackAlias: "Track Alias",
  trackNamespace: "Track Namespace",
  trackName: "Track Name",
  filterType: "Filter Type",
  errorCode: "Error Code",
  reason: "Reason",
  statusCode: "Status Code",
  streamCount: "Stream Count",
  maxRequestId: "Max Request ID",
  fetchType: "Fetch Type",
  joiningRequestId: "Joining Request ID",
  joiningStart: "Joining Start",
  startLocation: "Start Location",
  endLocation: "End Location",
  trackNamespacePrefix: "Track Namespace Prefix",
  subscriptionRequestId: "Subscription Request ID",
};

// パラメーターかどうかを判定
function isParameter(key: string): boolean {
  return key === key.toUpperCase() && key.includes("_");
}

// RFC 仕様書風のフォーマット
function formatMessageData(data: unknown, indent = 0): string {
  if (data === null || data === undefined) {
    return "";
  }

  const spaces = "  ".repeat(indent);

  if (typeof data === "string") {
    return data;
  }

  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    return String(data);
  }

  if (typeof data === "symbol" || typeof data === "function") {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "[]";
    }
    // 配列の中にオブジェクトがある場合は JSON.stringify で表示
    const hasObjects = data.some((item) => typeof item === "object" && item !== null);
    if (hasObjects) {
      return JSON.stringify(data, null, 2);
    }
    return `[${data.join(", ")}]`;
  }

  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) {
    return "";
  }

  // フィールドとパラメーターを分離
  const fields: [string, unknown][] = [];
  const parameters: [string, unknown][] = [];

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    if (isParameter(key)) {
      parameters.push([key, value]);
    } else {
      fields.push([key, value]);
    }
  }

  const lines: string[] = [];

  // フィールドを表示
  for (const [key, value] of fields) {
    const displayName = RFC_FIELD_NAMES[key] ?? key;
    // catalog フィールドは JSON として表示
    if (key === "catalog" && typeof value === "object" && value !== null) {
      const jsonStr = JSON.stringify(value, null, 2);
      const indentedJson = jsonStr
        .split("\n")
        .map((line, i) => (i === 0 ? line : `${spaces}  ${line}`))
        .join("\n");
      lines.push(`${spaces}  ${displayName}: ${indentedJson}`);
    } else {
      const formattedValue = formatMessageData(value, indent + 1);
      lines.push(`${spaces}  ${displayName}: ${formattedValue}`);
    }
  }

  // パラメーターを表示
  if (parameters.length > 0) {
    lines.push(`${spaces}  Parameters:`);
    for (const [key, value] of parameters) {
      const formattedValue = formatMessageData(value, indent + 2);
      lines.push(`${spaces}    ${key}: ${formattedValue}`);
    }
  }

  return `{\n${lines.join("\n")}\n${spaces}}`;
}

// バイナリデータを hex dump 形式でフォーマット
function formatHexDump(data: Uint8Array): string {
  const lines: string[] = [];
  const bytesPerLine = 16;

  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const chunk = data.slice(offset, offset + bytesPerLine);

    // オフセット (4桁の16進数)
    const offsetStr = offset.toString(16).padStart(4, "0");

    // 16進数部分
    const hexParts: string[] = [];
    for (let i = 0; i < bytesPerLine; i++) {
      if (i < chunk.length) {
        hexParts.push(chunk[i].toString(16).padStart(2, "0"));
      } else {
        hexParts.push("  ");
      }
    }
    const hexStr = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");

    // ASCII 部分
    let asciiStr = "";
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte >= 0x20 && byte <= 0x7e) {
        asciiStr += String.fromCharCode(byte);
      } else {
        asciiStr += ".";
      }
    }

    lines.push(`${offsetStr}  ${hexStr}  |${asciiStr}|`);
  }

  return lines.join("\n");
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

  logs.value = [...logs.value, entry].slice(-MAX_LOGS);
}

// 絶対時刻をフォーマット（HH:MM:SS.mmm）
function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
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
  // Joining Fetch 情報
  const largestLocation = instance.largestLocation.value;
  if (largestLocation) {
    lines.push(`Largest Group: ${largestLocation.group}`);
    lines.push(`Largest Object: ${largestLocation.object}`);
  }
  const joiningFetchStats = instance.joiningFetchStats.value;
  if (joiningFetchStats) {
    lines.push(`Joining Fetch Objects: ${joiningFetchStats.objectsReceived}`);
    lines.push(`Joining Fetch Bytes: ${formatBytes(joiningFetchStats.bytesReceived)}`);
    lines.push(`Joining Fetch Completed: ${joiningFetchStats.completed}`);
    lines.push(`Joining Fetch Buffered Live: ${joiningFetchStats.bufferedLiveObjects}`);
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
  const filteredLogs = filter
    ? logs.value.filter((log) => log.message.includes(filter))
    : logs.value;

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
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [viewModes, setViewModes] = useState<Map<number, ViewMode>>(new Map());
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedButton, setCopiedButton] = useState<string | null>(null);

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
      const allIndices = new Set(logs.value.map((_, i) => i).filter((i) => logs.value[i].data));
      setExpandedRows(allIndices);
    }
  };

  const copyToClipboard = useCallback(async (log: LogEntry, index: number, event: MouseEvent) => {
    event.stopPropagation();
    const timestamp = formatAbsoluteTime(log.timestamp);
    const parts: string[] = [`${timestamp} ${log.message}`];

    if (log.data) {
      parts.push(formatMessageData(log.data));
    }

    if (log.payload && log.payload.length > 0) {
      parts.push(`Binary (${log.payload.length} bytes):\n${formatHexDump(log.payload)}`);
    }

    await navigator.clipboard.writeText(parts.join(" "));
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  }, []);

  // 一括コピー: 全ログ
  const copyAllLogs = useCallback(async () => {
    const text = generateFullLogText();
    await navigator.clipboard.writeText(text);
    setCopiedButton("all");
    setTimeout(() => setCopiedButton(null), 1500);
  }, []);

  // 一括コピー: Publisher ログ
  const copyPublisherLogs = useCallback(async () => {
    const text = generateFullLogText("[publisher]");
    await navigator.clipboard.writeText(text);
    setCopiedButton("publisher");
    setTimeout(() => setCopiedButton(null), 1500);
  }, []);

  // 一括コピー: Subscriber ログ
  const copySubscriberLogs = useCallback(async (subscriberId: string) => {
    const text = generateFullLogText(`[${subscriberId}]`, subscriberId);
    await navigator.clipboard.writeText(text);
    setCopiedButton(subscriberId);
    setTimeout(() => setCopiedButton(null), 1500);
  }, []);

  // オートスクロール (新しいログが上なので scrollTop = 0)
  useSignalEffect(() => {
    const logsLength = logs.value.length;
    if (logsLength > 0 && autoScroll.value && logContainerRef.current) {
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
    logs.value = [];
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
  const firstTimestamp = logs.value.length > 0 ? logs.value[0].timestamp : 0;

  // 経過時間をフォーマット（秒.ミリ秒）
  const formatElapsedTime = (timestamp: number): string => {
    const elapsed = timestamp - firstTimestamp;
    const seconds = Math.floor(elapsed / 1000);
    const milliseconds = elapsed % 1000;
    return `+${seconds}.${milliseconds.toString().padStart(3, "0")}`;
  };

  // 差分時間をフォーマット（ミリ秒）
  const formatDeltaTime = (currentTimestamp: number, previousTimestamp: number | null): string => {
    if (previousTimestamp === null) {
      return "";
    }
    const delta = currentTimestamp - previousTimestamp;
    return `(+${delta}ms)`;
  };

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
          <span>Logs: {logs.value.length}</span>
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
            copiedButton === "all"
              ? "bg-green-500 text-white"
              : "bg-slate-200 hover:bg-slate-300 text-slate-700"
          }`}
        >
          {copiedButton === "all" ? "Copied!" : "All"}
        </button>
        <button
          onClick={copyPublisherLogs}
          class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            copiedButton === "publisher"
              ? "bg-green-500 text-white"
              : "bg-slate-200 hover:bg-slate-300 text-slate-700"
          }`}
        >
          {copiedButton === "publisher" ? "Copied!" : "Publisher"}
        </button>
        {subscriberIds.value.map((id) => (
          <button
            key={id}
            onClick={() => copySubscriberLogs(id)}
            class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              copiedButton === id
                ? "bg-green-500 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {copiedButton === id ? "Copied!" : id}
          </button>
        ))}
      </div>

      {/* ログコンテナ */}
      <div
        ref={logContainerRef}
        class="h-[calc(100vh-190px)] overflow-y-auto p-4 font-mono text-sm"
      >
        {logs.value.length === 0 ? (
          <div class="flex items-center justify-center h-full text-slate-400">
            No logs yet. MOQT operations will appear here.
          </div>
        ) : (
          <div class="space-y-1">
            {(() => {
              // 最新のログを上に表示するため逆方向ループで描画する。
              // 配列の reverse コピーを避けて O(n) 割り当てを削減する。
              const elements = [];
              const logsArray = logs.value;
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
                          <span>{formatElapsedTime(log.timestamp)}</span>
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
                        {copiedIndex === originalIndex ? (
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
