import { signal } from "@preact/signals";
import {
  ConnectionPanel,
  StaticApiSupportPanel,
  BidiStreamPanel,
  UniSendStreamPanel,
  UniRecvStreamPanel,
  DatagramPanel,
} from "./components";
import { buildQueryString } from "./signals";

const copyButtonText = signal("Copy URL");

function copyUrlToClipboard(): void {
  const queryString = buildQueryString();
  const fullUrl = `${window.location.origin}${window.location.pathname}?${queryString}`;

  // ブラウザの URL を更新
  window.history.replaceState(null, "", `?${queryString}`);

  navigator.clipboard.writeText(fullUrl).then(
    () => {
      copyButtonText.value = "Copied!";
      setTimeout(() => {
        copyButtonText.value = "Copy URL";
      }, 2000);
    },
    () => {
      copyButtonText.value = "Failed";
      setTimeout(() => {
        copyButtonText.value = "Copy URL";
      }, 2000);
    },
  );
}

export function App() {
  return (
    <div class="min-h-screen bg-slate-100">
      {/* 右上固定の Copy URL ボタン */}
      <div class="fixed top-4 right-4 z-30">
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
          <span>{copyButtonText}</span>
        </button>
      </div>

      <div class="container mx-auto px-4 py-8 max-w-6xl">
        <h1 class="text-2xl font-bold text-slate-800 mb-6">WebTransport DevTools</h1>
        <StaticApiSupportPanel />
        <ConnectionPanel />
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <BidiStreamPanel />
          <div class="space-y-6">
            <UniSendStreamPanel />
            <UniRecvStreamPanel />
          </div>
        </div>
        <DatagramPanel />

        {/* Footer */}
        <footer class="mt-6 text-center text-sm text-slate-400">
          <p>
            WebTransport DevTools -{" "}
            <a
              href="https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              draft-ietf-webtrans-http3-15
            </a>
            {" / "}
            <a
              href="https://datatracker.ietf.org/doc/draft-ietf-webtrans-http2/"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              draft-ietf-webtrans-http2-14
            </a>
          </p>
          <p class="mt-1">
            <a
              href="https://www.w3.org/TR/webtransport/"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              W3C WebTransport
            </a>
            {" / "}
            <a
              href="https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              MDN WebTransport API
            </a>
          </p>
          <p class="mt-1">株式会社時雨堂 Copyright © 2026 Shiguredo Inc. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
