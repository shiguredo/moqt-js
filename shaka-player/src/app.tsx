import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ConnectionForm, type FormState } from "./components/ConnectionForm";
import { LogPanel } from "./components/LogPanel";
import { StatusPanel } from "./components/StatusPanel";
import { PlayerController } from "./player/playerController";
import { statusBadgeClass, statusLabel, type ConnectionStatus } from "./status";
import type { ShakaStats, ShakaVariantTrack } from "./shaka";
import { formatError } from "./utils/error";
import { buildShareUrl, normalizeRelayUrl, parseNamespace, parseShareQuery } from "./utils/relay";

const initialFormState = (): FormState => ({
  ...parseShareQuery(window.location.search),
  authorizationToken: "",
});

export function App() {
  const [form, setForm] = useState<FormState>(initialFormState);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ShakaStats | null>(null);
  const [variants, setVariants] = useState<ShakaVariantTrack[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const shakaAvailable = window.shaka !== undefined;

  const appendLog = useCallback((message: string) => {
    setLogs((current) => {
      const next = [...current, `${new Date().toISOString()} ${message}`];
      return next.slice(-50);
    });
  }, []);

  const handleChange = useCallback((field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  }, []);

  const handleStats = useCallback((nextStats: ShakaStats, nextVariants: ShakaVariantTrack[]) => {
    setStats(nextStats);
    setVariants(nextVariants);
  }, []);

  const handleLoad = useCallback(async () => {
    setError(null);
    setStats(null);
    setVariants([]);
    setStatus("loading");
    setLogs([]);

    try {
      const relayUrl = normalizeRelayUrl(form.relayUrl);
      const namespaces = parseNamespace(form.namespaceText);
      if (!shakaAvailable) {
        throw new Error("shaka-player is not loaded; the experimental build is missing");
      }
      const video = videoRef.current;
      if (video === null) {
        throw new Error("video element is missing");
      }
      const controller = new PlayerController(video, {
        onError: (message) => {
          setError(message);
          setStatus("error");
        },
        onLog: appendLog,
        onStats: handleStats,
      });
      controllerRef.current = controller;
      await controller.load({
        relayUrl,
        namespaces,
        version: form.version,
        fingerprintUri: form.fingerprintUri,
        authorizationToken: form.authorizationToken,
      });
      setStatus("playing");
    } catch (loadError) {
      controllerRef.current = null;
      setError(formatError(loadError));
      setStatus("error");
      appendLog(`load failed: ${formatError(loadError)}`);
    }
  }, [
    appendLog,
    form.authorizationToken,
    form.fingerprintUri,
    form.namespaceText,
    form.relayUrl,
    form.version,
    handleStats,
    shakaAvailable,
  ]);

  const handleStop = useCallback(async () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    if (controller !== null) {
      await controller.stop();
    }
    setStatus("idle");
    setError(null);
    setStats(null);
    setVariants([]);
    appendLog("stopped");
  }, [appendLog]);

  const handleCopy = useCallback(async () => {
    try {
      const url = buildShareUrl(window.location.href, form);
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard API is unavailable");
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch (copyError) {
      setError(formatError(copyError));
      appendLog(`copy URL failed: ${formatError(copyError)}`);
    }
  }, [appendLog, form]);

  useEffect(() => {
    if (!shakaAvailable) {
      appendLog("shaka-player is not loaded; vendor the experimental build before loading a URL");
    }
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      void controllerRef.current?.stop();
    };
  }, [appendLog, shakaAvailable]);

  return (
    <div class="min-h-screen bg-slate-100 text-slate-900">
      <div class="mx-auto max-w-7xl px-4 py-6">
        <header class="mb-6 text-center">
          <h1 class="text-3xl font-bold text-slate-800">Shaka Player</h1>
          <p class="mt-1 text-slate-500">
            Media over QUIC Transport -{" "}
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-23"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-500 underline hover:text-blue-600"
            >
              draft-23
            </a>
          </p>
          <p class="mt-2 flex justify-center gap-4">
            <a href="/" class="text-blue-500 underline hover:text-blue-600">
              MOQT DevTools
            </a>
            <a href="/c4m-devtools.html" class="text-blue-500 underline hover:text-blue-600">
              C4M DevTools
            </a>
            <a href="/webcodecs-devtools.html" class="text-blue-500 underline hover:text-blue-600">
              WebCodecs DevTools
            </a>
            <a
              href="/webtransport-devtools.html"
              class="text-blue-500 underline hover:text-blue-600"
            >
              WebTransport DevTools
            </a>
          </p>
        </header>

        <main class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div class="space-y-6">
            <ConnectionForm
              state={form}
              status={status}
              copied={copied}
              shakaAvailable={shakaAvailable}
              onChange={handleChange}
              onLoad={handleLoad}
              onStop={handleStop}
              onCopy={handleCopy}
            />
            <section class="rounded-xl bg-white p-5 text-sm text-slate-600 shadow-sm">
              <h2 class="text-lg font-semibold text-slate-800">Notes</h2>
              <ul class="mt-2 list-disc space-y-1 pl-5">
                <li>
                  One namespace is required because shaka does not discover published namespaces.
                </li>
                <li>Draft-23 needs the shaka-player experimental build built from main.</li>
                <li>LOC playback supports h264, hevc, and av01. VP8 LOC is not supported.</li>
                <li>The relay must be reachable over HTTPS and allow WebTransport.</li>
              </ul>
            </section>
          </div>

          <div class="space-y-6">
            <section class="overflow-hidden rounded-xl bg-white shadow-sm">
              <div class="flex items-center justify-between gap-3 bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-3">
                <h2 class="text-lg font-semibold text-white">Player</h2>
                <span
                  class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}
                >
                  {statusLabel(status)}
                </span>
              </div>
              <div class="p-5">
                <video
                  ref={(element) => {
                    videoRef.current = element;
                  }}
                  class="aspect-video w-full rounded-lg bg-black"
                  controls
                  muted
                  playsinline
                />
                <p class="mt-3 text-sm text-slate-600">
                  {status === "playing"
                    ? "Playing. Use the native controls to pause or adjust the volume."
                    : "Load a relay and namespace to start playback."}
                </p>
              </div>
            </section>
            <StatusPanel status={status} stats={stats} variants={variants} />
          </div>

          <div class="lg:col-span-2">
            <LogPanel error={error} logs={logs} />
          </div>
        </main>

        <footer class="mt-6 text-center text-sm text-slate-400">
          <p>
            <a
              href="https://www.npmjs.com/package/moqt-js"
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-slate-600"
            >
              moqt-js
            </a>
            {" - "}
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-23"
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-slate-600"
            >
              draft-ietf-moq-transport-23
            </a>
          </p>
          <p class="mt-1">Copyright © 2026 Shiguredo Inc. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
