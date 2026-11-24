import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ConnectionForm, type FormState } from "./components/ConnectionForm";
import { LogPanel } from "./components/LogPanel";
import { StatusPanel } from "./components/StatusPanel";
import { PlayerController } from "./player/playerController";
import { statusBadgeClass, statusLabel, type ConnectionStatus } from "./status";
import type { ShakaStats, ShakaVariantTrack } from "./shaka";
import { formatError } from "./utils/error";
import { describeShakaVersion } from "./utils/version";
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
  const fallbackTimerRef = useRef<number | null>(null);
  const audioFallbackTriedRef = useRef(false);
  const retryWithoutAudioRef = useRef<() => void>(() => {});
  const shakaAvailable = window.shaka !== undefined;
  const shakaVersion = window.shaka?.Player.version ?? "unknown";
  const shakaVersionInfo = describeShakaVersion(shakaVersion);

  const appendLog = useCallback((message: string) => {
    setLogs((current) => {
      const next = [...current, `${new Date().toISOString()} ${message}`];
      return next.slice(-50);
    });
  }, []);

  const handleChange = useCallback((field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  }, []);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const handleStats = useCallback((nextStats: ShakaStats, nextVariants: ShakaVariantTrack[]) => {
    setStats(nextStats);
    setVariants(nextVariants);
    // manifest を読んだだけでは再生にならない。最初のフレームが用意できた
    // (readyState >= HAVE_CURRENT_DATA) 時点で Playing に切り替える。
    if (videoRef.current !== null && videoRef.current.readyState >= 2) {
      setStatus((current) => (current === "loading" ? "playing" : current));
    }
  }, []);

  /**
   * 指定した設定で Load する。
   *
   * 音声 LOC トラックがあると shaka が Loading のまま止まることがあるため、
   * 映像だけの Load を再試行できるよう disableAudio を切り替えられるようにする。
   */
  const startLoad = useCallback(
    async (disableAudio: boolean) => {
      clearFallbackTimer();
      setError(null);
      setStats(null);
      setVariants([]);
      setStatus("loading");

      const relayUrl = normalizeRelayUrl(form.relayUrl);
      const namespaces = parseNamespace(form.namespaceText);
      if (!shakaAvailable) {
        throw new Error("shaka-player is not loaded; the experimental build is missing");
      }
      const video = videoRef.current;
      if (video === null) {
        throw new Error("video element is missing");
      }

      const previous = controllerRef.current;
      controllerRef.current = null;
      if (previous !== null) {
        await previous.stop();
      }

      const controller = new PlayerController(video, {
        onError: (message) => {
          clearFallbackTimer();
          setError(message);
          setStatus("error");
        },
        onLog: appendLog,
        onStats: handleStats,
      });
      controllerRef.current = controller;

      try {
        await controller.load({
          relayUrl,
          namespaces,
          version: form.version,
          fingerprintUri: form.fingerprintUri,
          authorizationToken: form.authorizationToken,
          disableAudio,
        });
      } catch (loadError) {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        clearFallbackTimer();
        throw loadError;
      }

      if (!disableAudio && !audioFallbackTriedRef.current) {
        fallbackTimerRef.current = window.setTimeout(() => {
          fallbackTimerRef.current = null;
          if (controllerRef.current !== controller) {
            return;
          }
          if (video.readyState >= 2) {
            return;
          }
          audioFallbackTriedRef.current = true;
          appendLog("audio track did not start; retrying without audio");
          retryWithoutAudioRef.current();
        }, 5000);
      }
    },
    [
      appendLog,
      clearFallbackTimer,
      form.authorizationToken,
      form.fingerprintUri,
      form.namespaceText,
      form.relayUrl,
      form.version,
      handleStats,
      shakaAvailable,
    ],
  );

  useEffect(() => {
    retryWithoutAudioRef.current = () => {
      void startLoad(true).catch((retryError: unknown) => {
        controllerRef.current = null;
        setError(formatError(retryError));
        setStatus("error");
        appendLog(`load failed: ${formatError(retryError)}`);
      });
    };
  }, [appendLog, startLoad]);

  const handleLoad = useCallback(async () => {
    setLogs([]);
    audioFallbackTriedRef.current = false;
    try {
      await startLoad(false);
    } catch (loadError) {
      controllerRef.current = null;
      setError(formatError(loadError));
      setStatus("error");
      appendLog(`load failed: ${formatError(loadError)}`);
    }
  }, [appendLog, startLoad]);

  const handleStop = useCallback(async () => {
    clearFallbackTimer();
    audioFallbackTriedRef.current = false;
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
  }, [appendLog, clearFallbackTimer]);

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
      clearFallbackTimer();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      void controllerRef.current?.stop();
    };
  }, [appendLog, clearFallbackTimer, shakaAvailable]);

  return (
    <div class="min-h-screen bg-slate-100 text-slate-900">
      <div class="mx-auto max-w-7xl px-4 py-6">
        <header class="mb-6 text-center">
          <h1 class="text-3xl font-bold text-slate-800">Shaka Player</h1>
          <p class="mt-1 text-slate-500" data-testid="shaka-version">
            <a
              href={shakaVersionInfo.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="shaka-version-link"
              class="underline hover:text-slate-700"
            >
              {shakaVersionInfo.displayVersion}
            </a>
            {shakaVersionInfo.detail !== null && (
              <a
                href={shakaVersionInfo.commitUrl ?? shakaVersionInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="ml-1 text-xs text-slate-400 underline hover:text-slate-600"
              >
                {shakaVersionInfo.detail}
              </a>
            )}
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
                <li>If an audio LOC track does not start, playback retries without audio.</li>
                <li>
                  Shaka plays audio sent over subgroups. Datagram audio is not played; the publisher
                  uses subgroups by default.
                </li>
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
              href={shakaVersionInfo.packageUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-slate-600"
            >
              shaka-player
            </a>
            {" - "}
            <a
              href={shakaVersionInfo.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-slate-600"
            >
              {shakaVersionInfo.displayVersion}
            </a>
            {shakaVersionInfo.detail !== null && (
              <span class="ml-1">({shakaVersionInfo.detail})</span>
            )}
          </p>
          <p class="mt-1">Copyright © 2026 Shiguredo Inc. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
