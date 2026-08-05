import * as store from "../signals";
import type { ApiSupportNode } from "../signals";
import { SettingsIcon } from "./Icons";
import { BCD_SOURCE, BCD_SOURCE_URL, BCD_CONFIRMED_DATE } from "../bcd";
import { BcdBadges } from "./BcdBadges";

/**
 * 仕様根拠の注記バッジ
 * W3C WebTransport 仕様の節番号を表示する
 */
function SpecSectionBadge({ section }: { section: string }) {
  return <span class="text-xs text-slate-400">W3C {section}</span>;
}

/**
 * API Support の値に応じた色クラスを返す
 */
function apiSupportValueClass(value: string): string {
  if (value === "undefined" || value === "null" || value.startsWith("N/A")) {
    return "text-red-500 font-semibold";
  }
  return "text-green-600 font-semibold";
}

/**
 * HTTP バージョンバッジ
 * draft-ietf-webtrans-http2 / draft-ietf-webtrans-http3 の判別表示
 */
function HttpVersionBadge({ label }: { label: "HTTP/2" | "HTTP/3" | "--" }) {
  const color =
    label === "HTTP/3"
      ? "bg-green-100 text-green-700"
      : label === "HTTP/2"
        ? "bg-blue-100 text-blue-700"
        : "bg-slate-100 text-slate-500";
  return <span class={`px-2 py-0.5 text-xs font-medium rounded-full ${color}`}>{label}</span>;
}

/**
 * API Support のノードを再帰的にインデント表示する
 */
function ApiSupportTree({
  nodes,
  level,
}: {
  nodes: Record<string, ApiSupportNode>;
  level: number;
}) {
  return (
    <>
      {Object.entries(nodes).map(([key, node]) => (
        <div key={key} style={{ paddingLeft: `${(level + 1) * 0.5}rem` }}>
          <span class="text-slate-400">{key}: </span>
          <span class={apiSupportValueClass(node.value)}>{node.value}</span>
          {node.children && <ApiSupportTree nodes={node.children} level={level + 1} />}
        </div>
      ))}
    </>
  );
}

/**
 * 接続設定パネル
 */
export function ConnectionPanel() {
  const handleConnect = () => {
    if (store.connectionStatus.value === "connected") {
      // ユーザー操作の Disconnect 時のみ closeInfo を渡す
      // サーバー起因の切断 (wt.closed) では渡さない
      store.disconnect(store.buildCloseInfo() ?? undefined);
    } else {
      void store.connect();
    }
  };

  // 排他検証: allowPooling を有効化したら certificateHash を無効化する
  // W3C §6.9 は allowPooling と serverCertificateHashes の同時指定を NotSupportedError にする
  const handleAllowPoolingChange = (checked: boolean) => {
    store.allowPooling.value = checked;
    if (checked) {
      store.certificateHash.value = "";
    }
  };

  // 排他検証: certificateHash に入力したら allowPooling を無効化する
  const handleCertificateHashChange = (value: string) => {
    store.certificateHash.value = value;
    if (value) {
      store.allowPooling.value = false;
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
            data-testid="connection-url"
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
            <span class="ml-2">
              <SpecSectionBadge section="§6.9" />
            </span>
            <span class="ml-2">
              <BcdBadges name="serverCertificateHashes" />
            </span>
          </label>
          <input
            type="text"
            id="certificateHash"
            autocomplete="off"
            data-testid="connection-certificate-hash"
            value={store.certificateHash.value}
            onInput={(e) => handleCertificateHashChange(e.currentTarget.value)}
            disabled={store.settingsDisabled.value || store.allowPooling.value}
            placeholder="openssl x509 -in cert.pem -outform DER | openssl dgst -sha256 -binary | base64"
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
          />
        </div>

        {/* 接続時設定: WebTransportOptions (W3C §6.9) */}
        <div class="border-t border-slate-200 pt-4 space-y-4">
          <div class="text-sm font-semibold text-slate-500">
            WebTransport Options <SpecSectionBadge section="§6.9" />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-slate-600">
                allowPooling
                <span class="ml-2">
                  <BcdBadges name="allowPooling" />
                </span>
              </div>
              <div class="text-xs text-slate-400">
                Allow the session to share an underlying connection with other sessions
              </div>
            </div>
            <input
              type="checkbox"
              id="allowPooling"
              data-testid="connection-allow-pooling"
              checked={store.allowPooling.value}
              onChange={(e) => handleAllowPoolingChange(e.currentTarget.checked)}
              disabled={store.settingsDisabled.value}
              class="w-4 h-4 accent-blue-500"
            />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-slate-600">
                requireUnreliable
                <span class="ml-2">
                  <BcdBadges name="requireUnreliable" />
                </span>
              </div>
              <div class="text-xs text-slate-400">
                Require a connection that supports unreliable (UDP) transport
              </div>
            </div>
            <input
              type="checkbox"
              id="requireUnreliable"
              data-testid="connection-require-unreliable"
              checked={store.requireUnreliable.value}
              onChange={(e) => (store.requireUnreliable.value = e.currentTarget.checked)}
              disabled={store.settingsDisabled.value}
              class="w-4 h-4 accent-blue-500"
            />
          </div>

          <div>
            <label for="congestionControl" class="block text-sm font-medium text-slate-600 mb-1">
              congestionControl
              <span class="ml-2">
                <BcdBadges name="congestionControl" />
              </span>
            </label>
            <select
              id="congestionControl"
              data-testid="connection-congestion-control"
              value={store.congestionControl.value}
              onChange={(e) =>
                (store.congestionControl.value = e.currentTarget
                  .value as typeof store.congestionControl.value)
              }
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            >
              <option value="default">default</option>
              <option value="throughput">throughput</option>
              <option value="low-latency">low-latency</option>
            </select>
          </div>

          <div>
            <label for="headers" class="block text-sm font-medium text-slate-600 mb-1">
              headers
              <span class="ml-2">
                <SpecSectionBadge section="§6.9" />
              </span>
            </label>
            <textarea
              id="headers"
              data-testid="connection-headers"
              value={store.headersText.value}
              onInput={(e) => (store.headersText.value = e.currentTarget.value)}
              disabled={store.settingsDisabled.value}
              rows={3}
              placeholder={"X-Custom-Header: value\n(1 header per line, key: value)"}
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm font-mono"
            />
            <div class="text-xs text-slate-400">
              Forbidden request-headers and wt-available-protocols are rejected
            </div>
          </div>

          <div>
            <label for="protocols" class="block text-sm font-medium text-slate-600 mb-1">
              protocols
              <span class="ml-2">
                <SpecSectionBadge section="§6.9" />
              </span>
            </label>
            <input
              type="text"
              id="protocols"
              data-testid="connection-protocols"
              value={store.protocolsText.value}
              onInput={(e) => (store.protocolsText.value = e.currentTarget.value)}
              disabled={store.settingsDisabled.value}
              placeholder="my-protocol, other-protocol (comma separated)"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
            <div class="text-xs text-slate-400">
              Duplicate, empty, and longer than 512 characters are rejected
            </div>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-slate-600">
                datagramsReadableType: bytes
                <span class="ml-2">
                  <SpecSectionBadge section="§6.9" />
                </span>
              </div>
              <div class="text-xs text-slate-400">
                Read incoming datagrams as a byte stream. Message boundaries are not guaranteed
              </div>
            </div>
            <input
              type="checkbox"
              id="datagramsReadableType"
              data-testid="connection-datagrams-readable-type"
              checked={store.datagramsReadableType.value === "bytes"}
              onChange={(e) =>
                (store.datagramsReadableType.value = e.currentTarget.checked ? "bytes" : "")
              }
              disabled={store.settingsDisabled.value}
              class="w-4 h-4 accent-blue-500"
            />
          </div>

          <div>
            <label
              for="anticipatedConcurrentIncomingUnidirectionalStreams"
              class="block text-sm font-medium text-slate-600 mb-1"
            >
              anticipatedConcurrentIncomingUnidirectionalStreams
              <span class="ml-2">
                <BcdBadges name="anticipatedConcurrentIncomingUnidirectionalStreams" />
              </span>
            </label>
            <input
              type="number"
              id="anticipatedConcurrentIncomingUnidirectionalStreams"
              data-testid="connection-anticipated-uni"
              value={store.anticipatedConcurrentIncomingUnidirectionalStreams.value}
              onInput={(e) =>
                (store.anticipatedConcurrentIncomingUnidirectionalStreams.value =
                  e.currentTarget.value)
              }
              disabled={store.settingsDisabled.value}
              min={0}
              max={65535}
              placeholder="empty = default"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div>
            <label
              for="anticipatedConcurrentIncomingBidirectionalStreams"
              class="block text-sm font-medium text-slate-600 mb-1"
            >
              anticipatedConcurrentIncomingBidirectionalStreams
              <span class="ml-2">
                <BcdBadges name="anticipatedConcurrentIncomingBidirectionalStreams" />
              </span>
            </label>
            <input
              type="number"
              id="anticipatedConcurrentIncomingBidirectionalStreams"
              data-testid="connection-anticipated-bidi"
              value={store.anticipatedConcurrentIncomingBidirectionalStreams.value}
              onInput={(e) =>
                (store.anticipatedConcurrentIncomingBidirectionalStreams.value =
                  e.currentTarget.value)
              }
              disabled={store.settingsDisabled.value}
              min={0}
              max={65535}
              placeholder="empty = default"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>

          <div class="text-xs text-slate-400 border-t border-slate-200 pt-3">
            Browser support data:{" "}
            <a
              href={BCD_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              {BCD_SOURCE}
            </a>{" "}
            (confirmed {BCD_CONFIRMED_DATE})
          </div>
        </div>

        <div class="flex items-center gap-4">
          <button
            onClick={handleConnect}
            data-testid="connection-connect"
            class={`px-4 py-2 rounded-lg font-medium transition-colors ${getButtonClass()}`}
            disabled={store.connectionStatus.value === "connecting"}
          >
            {getButtonText()}
          </button>
          <span class={`text-sm ${getStatusClass()}`}>{getStatusText()}</span>
        </div>
        {store.connectionStatus.value !== "disconnected" && (
          <div class="mt-3 p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-600 space-y-1">
            <div>
              <span class="text-slate-400">connectionStatus: </span>
              <span class="font-semibold">{store.connectionStatus.value}</span>
            </div>
            <div>
              <span class="text-slate-400">ready: </span>
              <span
                class={
                  store.wtReadyState.value === "resolved"
                    ? "text-green-600 font-semibold"
                    : store.wtReadyState.value.startsWith("rejected")
                      ? "text-red-600 font-semibold"
                      : "text-yellow-600 font-semibold"
                }
              >
                {store.wtReadyState.value}
              </span>
            </div>
            <div>
              <span class="text-slate-400">closed: </span>
              <span
                class={store.wtClosedState.value === "pending" ? "text-slate-500" : "font-semibold"}
              >
                {store.wtClosedState.value}
              </span>
            </div>
            <div>
              <span class="text-slate-400">draining: </span>
              <span
                class={
                  store.wtDrainingState.value === "pending" ? "text-slate-500" : "font-semibold"
                }
              >
                {store.wtDrainingState.value}
              </span>
            </div>
            {store.wtReliability.value && (
              <div class="flex items-center gap-2">
                <span class="text-slate-400">reliability: </span>
                <span class="font-semibold">{store.wtReliability.value}</span>
                <HttpVersionBadge label={store.wtHttpVersion.value} />
              </div>
            )}
            {store.wtCongestionControl.value && (
              <div>
                <span class="text-slate-400">congestionControl: </span>
                <span class="font-semibold">{store.wtCongestionControl.value}</span>
              </div>
            )}
            {store.wtSupportsReliableOnly.value && (
              <div>
                <span class="text-slate-400">supportsReliableOnly: </span>
                <span class="font-semibold">{store.wtSupportsReliableOnly.value}</span>
              </div>
            )}
            {store.wtProtocol.value !== "" && (
              <div>
                <span class="text-slate-400">protocol: </span>
                <span class="font-semibold">{store.wtProtocol.value || "(empty)"}</span>
              </div>
            )}
            {store.wtResponseHeaders.value && (
              <div>
                <span class="text-slate-400">responseHeaders: </span>
                <span class="font-semibold whitespace-pre-wrap">
                  {store.wtResponseHeaders.value}
                </span>
              </div>
            )}
            {store.wtApiSupport.value && (
              <div class="mt-2 pt-2 border-t border-slate-200">
                <div class="text-slate-400 mb-1">API Support:</div>
                <ApiSupportTree nodes={store.wtApiSupport.value} level={0} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
