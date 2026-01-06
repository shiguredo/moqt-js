import * as store from "../signals";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { ActionButton } from "./ActionButton";
import { MessageItem } from "./MessageItem";
import { IncomingStreamIcon, CloseIcon } from "./Icons";

/**
 * 受信用単方向ストリームアイテム
 */
function UniRecvStreamItem({ streamId }: { streamId: number }) {
  const stream = store.uniRecvStreams.value.find((s) => s.id === streamId);
  const messagesRef = useAutoScroll([stream?.messages.length]);

  if (!stream) return null;

  return (
    <div
      class={`border rounded-lg p-4 ${stream.closed ? "border-slate-300 bg-slate-50" : "border-green-200"}`}
    >
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-medium text-slate-600 flex items-center gap-2">
          Stream #{streamId}
          {stream.closed ? (
            <span class="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded">Closed</span>
          ) : (
            <span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">Receiving</span>
          )}
        </h3>
        <div class="flex items-center gap-1">
          <ActionButton
            onClick={() => store.removeUniRecvStream(streamId)}
            title="Remove from list"
            variant="danger"
          >
            <CloseIcon />
          </ActionButton>
        </div>
      </div>
      <div ref={messagesRef} class="max-h-40 overflow-y-auto bg-slate-50 rounded-lg p-2">
        {stream.messages.length === 0 ? (
          <p class="text-slate-400 text-xs">Waiting for data...</p>
        ) : (
          stream.messages.map((msg, i) => <MessageItem key={i} msg={msg} />)
        )}
      </div>
    </div>
  );
}

/**
 * 受信用単方向ストリームパネル
 */
export function UniRecvStreamPanel() {
  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <IncomingStreamIcon />
          Incoming Streams
          {store.uniRecvStreams.value.length > 0 && (
            <span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
              {store.uniRecvStreams.value.length}
            </span>
          )}
        </h2>
      </div>

      {store.uniRecvStreams.value.length === 0 ? (
        <p class="text-slate-500 text-sm">No incoming streams</p>
      ) : (
        <div class="space-y-4">
          {store.uniRecvStreams.value.map((stream) => (
            <UniRecvStreamItem key={stream.id} streamId={stream.id} />
          ))}
        </div>
      )}
    </div>
  );
}
