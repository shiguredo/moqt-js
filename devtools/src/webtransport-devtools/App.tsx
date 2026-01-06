import {
  ConnectionPanel,
  BidiStreamPanel,
  UniSendStreamPanel,
  UniRecvStreamPanel,
  DatagramPanel,
} from "./components";

export function App() {
  return (
    <div class="min-h-screen bg-slate-100">
      <div class="container mx-auto px-4 py-8 max-w-6xl">
        <h1 class="text-2xl font-bold text-slate-800 mb-6">WebTransport DevTools</h1>
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
              draft-ietf-webtrans-http3-14
            </a>
            {" / "}
            <a
              href="https://www.w3.org/TR/webtransport/"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              W3C WebTransport
            </a>
          </p>
          <p class="mt-1">株式会社時雨堂 Copyright © 2025 Shiguredo Inc. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
