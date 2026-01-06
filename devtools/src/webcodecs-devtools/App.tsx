import { ConfigPanel, VideoPanel, StatsPanel, FrameLogPanel } from "./components";

export function App() {
  return (
    <div class="min-h-screen bg-slate-100">
      <div class="container mx-auto px-4 py-8 max-w-6xl">
        <h1 class="text-2xl font-bold text-slate-800 mb-6">WebCodecs DevTools</h1>
        <ConfigPanel />
        <VideoPanel />
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <StatsPanel />
          <FrameLogPanel />
        </div>

        <footer class="mt-6 text-center text-sm text-slate-400">
          <p>
            WebCodecs DevTools -{" "}
            <a
              href="https://www.w3.org/TR/webcodecs/"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-slate-600 underline"
            >
              W3C WebCodecs
            </a>
          </p>
          <p class="mt-1">株式会社時雨堂 Copyright © 2025 Shiguredo Inc. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
