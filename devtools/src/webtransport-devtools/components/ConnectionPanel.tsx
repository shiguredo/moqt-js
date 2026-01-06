import * as store from "../signals";
import { SettingsIcon } from "./Icons";

/**
 * 接続設定パネル
 */
export function ConnectionPanel() {
  const handleConnect = () => {
    if (store.connectionStatus.value === "connected") {
      store.disconnect();
    } else {
      void store.connect();
    }
  };

  const getButtonClass = () => {
    switch (store.connectionStatus.value) {
      case "connected":
        return "bg-red-500 hover:bg-red-600 text-white";
      case "connecting":
        return "bg-yellow-500 text-white cursor-wait";
      default:
        return "bg-blue-500 hover:bg-blue-600 text-white";
    }
  };

  const getButtonText = () => {
    switch (store.connectionStatus.value) {
      case "connected":
        return "Disconnect";
      case "connecting":
        return "Connecting...";
      default:
        return "Connect";
    }
  };

  const getStatusClass = () => {
    switch (store.connectionStatus.value) {
      case "connected":
        return "text-green-600";
      case "error":
        return "text-red-600";
      default:
        return "text-slate-500";
    }
  };

  const getStatusText = () => {
    switch (store.connectionStatus.value) {
      case "connected":
        return "Connected";
      case "error":
        return `Error: ${store.connectionError.value}`;
      default:
        return "Disconnected";
    }
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <h2 class="text-lg font-semibold text-slate-700 mb-4 flex items-center gap-2">
        <SettingsIcon />
        Connection Settings
      </h2>

      <div class="space-y-4">
        <div>
          <label for="url" class="block text-sm font-medium text-slate-600 mb-1">
            Server URL
          </label>
          <input
            type="text"
            id="url"
            value={store.url.value}
            onInput={(e) => (store.url.value = e.currentTarget.value)}
            disabled={store.settingsDisabled.value}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
          />
        </div>
        <div>
          <label for="certificateHash" class="block text-sm font-medium text-slate-600 mb-1">
            Certificate Hash (Base64)
            <span class="ml-1 text-xs text-slate-400">for self-signed certs</span>
          </label>
          <input
            type="text"
            id="certificateHash"
            autocomplete="off"
            value={store.certificateHash.value}
            onInput={(e) => (store.certificateHash.value = e.currentTarget.value)}
            disabled={store.settingsDisabled.value}
            placeholder="openssl x509 -in cert.pem -outform DER | openssl dgst -sha256 -binary | base64"
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
          />
        </div>
        <div class="flex items-center gap-4">
          <button
            onClick={handleConnect}
            class={`px-4 py-2 rounded-lg font-medium transition-colors ${getButtonClass()}`}
            disabled={store.connectionStatus.value === "connecting"}
          >
            {getButtonText()}
          </button>
          <span class={`text-sm ${getStatusClass()}`}>{getStatusText()}</span>
        </div>
      </div>
    </div>
  );
}
