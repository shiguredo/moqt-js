import { formatTimestamp, type StreamMessage } from "../signals";

interface MessageItemProps {
  msg: StreamMessage;
}

/**
 * メッセージ表示コンポーネント
 */
export function MessageItem({ msg }: MessageItemProps) {
  const colorClass = msg.direction === "send" ? "text-blue-600" : "text-green-600";
  const label = msg.direction === "send" ? "SEND" : "RECV";

  return (
    <div class={`text-xs py-1 flex gap-2 ${colorClass}`}>
      <span class="text-slate-400 font-mono">{formatTimestamp(msg.timestamp)}</span>
      <span class="font-medium">{label}:</span>
      <span class="break-all">{msg.data}</span>
    </div>
  );
}
