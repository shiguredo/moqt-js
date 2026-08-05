import { useSignal } from "@preact/signals";
import * as store from "../signals";
import { BcdBadges } from "./BcdBadges";

/**
 * 接続後設定パネル
 * 接続中のみ編集可能な datagrams 設定 (§5.3) と close() の closeCode / reason (§6.10) を提供する
 */
export function PostConnectionPanel() {
  const applyResult = useSignal("");

  const handleApply = () => {
    applyResult.value = "";
    store.applyDatagramSettings();
    if (store.connectionError.value) {
      applyResult.value = store.connectionError.value;
    } else {
      applyResult.value = "Applied";
    }
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <h2 class="text-lg font-semibold text-slate-700 mb-4">Post-Connection Settings</h2>

      <div class="space-y-4">
        <div class="text-xs text-slate-400">Editable while connected. Reset on disconnect.</div>

        {/* datagrams 設定 (W3C §5.3) */}
        <div class="border-t border-slate-200 pt-4 space-y-4">
          <div class="text-sm font-semibold text-slate-500">
            Datagrams <span class="text-xs text-slate-400 font-normal">W3C §5.3</span>
          </div>

          <div>
            <label for="incomingMaxAge" class="block text-sm font-medium text-slate-600 mb-1">
              incomingMaxAge (ms)
              <span class="ml-2">
                <BcdBadges name="incomingMaxAge" />
              </span>
            </label>
            <input
              type="number"
              id="incomingMaxAge"
              data-testid="datagram-incoming-max-age"
              value={store.datagramIncomingMaxAge.value}
              onInput={(e) => (store.datagramIncomingMaxAge.value = e.currentTarget.value)}
              disabled={store.connectionStatus.value !== "connected"}
              min={0}
              placeholder="0 = implementation default, empty = keep current"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label for="outgoingMaxAge" class="block text-sm font-medium text-slate-600 mb-1">
              outgoingMaxAge (ms)
              <span class="ml-2">
                <BcdBadges name="outgoingMaxAge" />
              </span>
            </label>
            <input
              type="number"
              id="outgoingMaxAge"
              data-testid="datagram-outgoing-max-age"
              value={store.datagramOutgoingMaxAge.value}
              onInput={(e) => (store.datagramOutgoingMaxAge.value = e.currentTarget.value)}
              disabled={store.connectionStatus.value !== "connected"}
              min={0}
              placeholder="0 = implementation default, empty = keep current"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label
              for="incomingMaxBufferedDatagrams"
              class="block text-sm font-medium text-slate-600 mb-1"
            >
              incomingMaxBufferedDatagrams
              <span class="ml-2">
                <BcdBadges name="incomingMaxBufferedDatagrams" />
              </span>
            </label>
            <input
              type="number"
              id="incomingMaxBufferedDatagrams"
              data-testid="datagram-incoming-max-buffered"
              value={store.datagramIncomingMaxBufferedDatagrams.value}
              onInput={(e) =>
                (store.datagramIncomingMaxBufferedDatagrams.value = e.currentTarget.value)
              }
              disabled={store.connectionStatus.value !== "connected"}
              min={1}
              placeholder="values below 1 are clamped to 1, empty = keep current"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label
              for="outgoingMaxBufferedDatagrams"
              class="block text-sm font-medium text-slate-600 mb-1"
            >
              outgoingMaxBufferedDatagrams
              <span class="ml-2">
                <BcdBadges name="outgoingMaxBufferedDatagrams" />
              </span>
            </label>
            <input
              type="number"
              id="outgoingMaxBufferedDatagrams"
              data-testid="datagram-outgoing-max-buffered"
              value={store.datagramOutgoingMaxBufferedDatagrams.value}
              onInput={(e) =>
                (store.datagramOutgoingMaxBufferedDatagrams.value = e.currentTarget.value)
              }
              disabled={store.connectionStatus.value !== "connected"}
              min={1}
              placeholder="values below 1 are clamped to 1, empty = keep current"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div class="flex items-center gap-3">
            <button
              onClick={handleApply}
              data-testid="datagram-apply"
              disabled={store.connectionStatus.value !== "connected"}
              class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              Apply
            </button>
            {applyResult.value && (
              <span
                class={`text-sm ${applyResult.value === "Applied" ? "text-green-600" : "text-red-600"}`}
              >
                {applyResult.value}
              </span>
            )}
          </div>
        </div>

        {/* close() の設定 (W3C §6.10) */}
        <div class="border-t border-slate-200 pt-4 space-y-4">
          <div class="text-sm font-semibold text-slate-500">
            Close <span class="text-xs text-slate-400 font-normal">W3C §6.10</span>
          </div>
          <div class="text-xs text-slate-400">
            Passed to close() only when disconnecting via the Disconnect button.
          </div>

          <div>
            <label for="closeCode" class="block text-sm font-medium text-slate-600 mb-1">
              closeCode
            </label>
            <input
              type="number"
              id="closeCode"
              data-testid="close-code"
              value={store.closeCode.value}
              onInput={(e) => (store.closeCode.value = e.currentTarget.value)}
              disabled={store.connectionStatus.value !== "connected"}
              min={0}
              max={4294967295}
              placeholder="unsigned long, empty = omit"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label for="closeReason" class="block text-sm font-medium text-slate-600 mb-1">
              reason
            </label>
            <input
              type="text"
              id="closeReason"
              data-testid="close-reason"
              value={store.closeReason.value}
              onInput={(e) => (store.closeReason.value = e.currentTarget.value)}
              disabled={store.connectionStatus.value !== "connected"}
              placeholder="USVString, empty = omit"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
