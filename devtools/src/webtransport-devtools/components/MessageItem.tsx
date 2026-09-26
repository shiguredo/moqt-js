import type { StreamMessage } from "../messageLog";

interface MessageItemProps {
  msg: StreamMessage;
}

/**
 * メッセージ表示コンポーネント
 *
 * 日時は追加時に整形済みの値を受け取る。ここで整形し直すと、1 件追加するたびに
 * 表示中の全行の整形コストがかかる (整形 1 回は実測で約 30 µs)
 */
export function MessageItem({ msg }: MessageItemProps) {
  const colorClass = msg.direction === "send" ? "text-blue-600" : "text-green-600";
  const label = msg.direction === "send" ? "SEND" : "RECV";

  return (
    <div class={`text-xs py-1 flex gap-2 ${colorClass}`}>
      <span class="text-slate-400 font-mono">{msg.formattedTimestamp}</span>
      <span class="font-medium">{label}:</span>
      <span class="break-all">{msg.data}</span>
    </div>
  );
}
