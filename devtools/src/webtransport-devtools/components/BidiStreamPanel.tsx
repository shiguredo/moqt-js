import { useSignal } from "@preact/signals";
import * as store from "../signals";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { ActionButton } from "./ActionButton";
import { MessageItem } from "./MessageItem";
import { BidiStreamIcon, ClearIcon, StopIcon, CloseIcon } from "./Icons";

/**
 * 双方向ストリームアイテム
 */
function BidiStreamItem({ streamId }: { streamId: number }) {
  const input = useSignal("");
  const stream = store.bidiStreams.value.find((s) => s.id === streamId);
  const messagesRef = useAutoScroll([stream?.messages.length]);

  if (!stream) return null;

  const handleSend = () => {
    if (input.value.trim() && !stream.closed) {
      void store.sendBidiMessage(streamId, input.value);
      input.value = "";
    }
  };

  return (
    <div
      class={`border rounded-lg p-4 ${stream.closed ? "border-slate-300 bg-slate-50" : "border-slate-200"}`}
    >
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-medium text-slate-600 flex items-center gap-2">
          Stream #{streamId}
          {stream.closed && (
            <span class="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded">Closed</span>
          )}
        </h3>
        <div class="flex items-center gap-1">
          <ActionButton
            onClick={() => store.clearBidiMessages(streamId)}
            title="Clear messages"
            variant="warning"
          >
            <ClearIcon />
          </ActionButton>
          {!stream.closed && (
            <ActionButton
              onClick={() => void store.closeBidiStream(streamId)}
              title="Close stream"
              variant="danger"
            >
              <StopIcon />
            </ActionButton>
          )}
          <ActionButton
            onClick={() => store.removeBidiStream(streamId)}
            title="Remove from list"
            variant="danger"
          >
            <CloseIcon />
          </ActionButton>
        </div>
      </div>
      {!stream.closed && (
        <div class="flex gap-2 mb-3">
          <input
            type="text"
            value={input.value}
            onInput={(e) => (input.value = e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Enter message..."
            class="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={handleSend}
            class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      )}
      <div ref={messagesRef} class="max-h-40 overflow-y-auto bg-slate-50 rounded-lg p-2">
        {stream.messages.length === 0 ? (
          <p class="text-slate-400 text-xs">No messages</p>
        ) : (
          stream.messages.map((msg, i) => <MessageItem key={i} msg={msg} />)
        )}
      </div>
    </div>
  );
}

/**
 * 双方向ストリームパネル
 */
export function BidiStreamPanel() {
  const handleCreateStream = () => {
    void store.createBidiStream();
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <BidiStreamIcon />
          Bidirectional Streams
          {store.bidiStreams.value.length > 0 && (
            <span class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
              {store.bidiStreams.value.length}
            </span>
          )}
        </h2>
        <button
          onClick={handleCreateStream}
          data-testid="bidi-new-stream"
          disabled={store.connectionStatus.value !== "connected"}
          class="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          + New Stream
        </button>
      </div>

      {/* ストリーム作成時設定 (W3C §6.11 / §6.12) */}
      <div class="mb-4 p-3 bg-slate-50 rounded-lg space-y-3">
        <div class="text-xs font-semibold text-slate-500">
          Stream Options <span class="text-slate-400 font-normal">W3C §6.11 / §6.12</span>
        </div>
        <div>
          <label for="bidiSendOrder" class="block text-xs font-medium text-slate-600 mb-1">
            sendOrder
          </label>
          <input
            type="number"
            id="bidiSendOrder"
            data-testid="bidi-stream-send-order"
            value={store.streamSendOrder.value}
            onInput={(e) => (store.streamSendOrder.value = e.currentTarget.value)}
            disabled={store.connectionStatus.value !== "connected"}
            placeholder="empty = default"
            class="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
          />
        </div>
        <label class="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            data-testid="bidi-stream-wait-until-available"
            checked={store.streamWaitUntilAvailable.value}
            onChange={(e) => (store.streamWaitUntilAvailable.value = e.currentTarget.checked)}
            disabled={store.connectionStatus.value !== "connected"}
            class="w-4 h-4 accent-blue-500"
          />
          waitUntilAvailable
        </label>
      </div>

      {store.bidiStreams.value.length === 0 ? (
        <p class="text-slate-500 text-sm">No bidirectional streams</p>
      ) : (
        <div class="space-y-4">
          {store.bidiStreams.value.map((stream) => (
            <BidiStreamItem key={stream.id} streamId={stream.id} />
          ))}
        </div>
      )}
    </div>
  );
}
