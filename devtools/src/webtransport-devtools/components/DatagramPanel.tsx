import { useSignal } from "@preact/signals";
import * as store from "../signals";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { ActionButton } from "./ActionButton";
import { MessageItem } from "./MessageItem";
import { DatagramIcon, ClearIcon } from "./Icons";

/**
 * データグラムパネル
 */
export function DatagramPanel() {
  const input = useSignal("");
  const messagesRef = useAutoScroll([store.datagramMessages.value.length]);

  const handleSend = () => {
    if (input.value.trim()) {
      void store.sendDatagram(input.value);
      input.value = "";
    }
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <DatagramIcon />
          Datagrams
          {store.datagramMessages.value.length > 0 && (
            <span class="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
              {store.datagramMessages.value.length}
            </span>
          )}
        </h2>
        <ActionButton
          onClick={() => store.clearDatagramMessages()}
          title="Clear messages"
          variant="warning"
        >
          <ClearIcon />
        </ActionButton>
      </div>

      <div class="flex gap-2 mb-3">
        <input
          type="text"
          data-testid="datagram-input"
          value={input.value}
          onInput={(e) => (input.value = e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={store.connectionStatus.value !== "connected"}
          placeholder="Enter datagram message..."
          class="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSend}
          data-testid="datagram-send"
          disabled={store.connectionStatus.value !== "connected"}
          class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>

      <div ref={messagesRef} class="max-h-60 overflow-y-auto bg-slate-50 rounded-lg p-3">
        {store.datagramMessages.value.length === 0 ? (
          <p class="text-slate-400 text-sm">No datagrams</p>
        ) : (
          store.datagramMessages.value.map((msg, i) => <MessageItem key={i} msg={msg} />)
        )}
      </div>
    </div>
  );
}
