import { version } from "moqt-js";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { PublisherPanel } from "./components/PublisherPanel";
import { SubscriberPanel } from "./components/SubscriberPanel";
import { DebugPanel, logCount } from "./components/DebugPanel";
import { isDebugPanelOpen, toggleDebugPanel } from "./signals/debug";
import { buildQueryString } from "./signals/connectionSettings";
import { useCopyUrlButton } from "./hooks/useCopyUrlButton";
import * as sub from "./signals/subscriber";

function handleAddSubscriber(): void {
  sub.addSubscriber();
}

export function App() {
  const subscriberIdList = sub.subscriberIds.value;
  const debugPanelOpen = isDebugPanelOpen.value;
  const { buttonText: copyButtonText, copy: copyUrlToClipboard } =
    useCopyUrlButton(buildQueryString);

  return (
    <div class="flex min-h-screen">
      {/* メインコンテンツ */}
      <div
        class={`flex-1 bg-slate-100 min-h-screen transition-all duration-300 ${debugPanelOpen ? "mr-[640px]" : ""}`}
      >
        {/* 右上固定のボタン群 */}
        <div
          class={`fixed top-4 z-30 flex items-center gap-3 transition-all duration-300 ${debugPanelOpen ? "right-[656px]" : "right-4"}`}
        >
          {/* Copy URL ボタン */}
          <button
            onClick={copyUrlToClipboard}
            class="p-4 rounded-xl shadow-lg transition-all flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white font-medium"
            title="Copy URL with current settings"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            <span>{copyButtonText.value}</span>
          </button>

          {/* Debug ボタン */}
          <button
            onClick={toggleDebugPanel}
            class={`p-4 rounded-xl shadow-lg transition-all flex items-center gap-2 ${
              debugPanelOpen ? "bg-slate-600 hover:bg-slate-700" : "bg-blue-500 hover:bg-blue-600"
            } text-white font-medium`}
            title="Debug Logs"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span>Debug</span>
            {/* ログ件数バッジ */}
            {logCount.value > 0 && !debugPanelOpen && (
              <span class="bg-red-500 text-white text-xs font-bold rounded-full min-w-[24px] h-6 flex items-center justify-center px-1.5">
                {logCount.value > 99 ? "99+" : logCount.value}
              </span>
            )}
          </button>
        </div>

        <div class="max-w-7xl mx-auto px-4 py-6">
          {/* Header */}
          <header class="text-center mb-6">
            <h1 class="text-3xl font-bold text-slate-800">MOQT DevTools</h1>
            <p class="text-slate-500 mt-1">Media over QUIC Transport - Publisher & Subscriber</p>
            <p class="mt-2 flex justify-center gap-4">
              <a
                href="/webcodecs-devtools.html"
                class="text-blue-500 hover:text-blue-600 underline"
              >
                WebCodecs DevTools
              </a>
              <a
                href="/webtransport-devtools.html"
                class="text-blue-500 hover:text-blue-600 underline"
              >
                WebTransport DevTools
              </a>
            </p>
          </header>

          {/* Connection Settings */}
          <ConnectionSettings />

          {/* Main Content */}
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Publisher Panel */}
            <PublisherPanel />

            {/* Subscriber Panels */}
            {subscriberIdList.map((id) => (
              <SubscriberPanel
                key={id}
                subscriberId={id}
                canRemove={subscriberIdList.length > 1}
                onRemove={() => sub.removeSubscriber(id)}
              />
            ))}
          </div>

          {/* Add Subscriber ボタン */}
          <div class="mt-6 flex justify-center">
            <button
              onClick={handleAddSubscriber}
              class="px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-xl shadow-lg transition-all flex items-center gap-2"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Subscriber
            </button>
          </div>

          {/* Footer */}
          <footer class="mt-6 text-center text-sm text-slate-400">
            <p>
              <a
                href="https://www.npmjs.com/package/moqt-js"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-slate-600 underline"
              >
                moqt-js {version}
              </a>{" "}
              -{" "}
              <a
                href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-19"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-slate-600 underline"
              >
                draft-ietf-moq-transport-19
              </a>
              {" / "}
              <a
                href="https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3-15"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-slate-600 underline"
              >
                draft-ietf-webtrans-http3-15
              </a>
            </p>
            <p class="mt-1">株式会社時雨堂 Copyright © 2026 Shiguredo Inc. All rights reserved.</p>
          </footer>
        </div>
      </div>

      {/* デバッグサイドパネル */}
      <DebugPanel />
    </div>
  );
}
