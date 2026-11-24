import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ConnectionForm, type ConnectionStatus, type FormState } from "./components/ConnectionForm";
import { LogPanel } from "./components/LogPanel";
import { StatusPanel } from "./components/StatusPanel";
import { PlayerController } from "./player/playerController";
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
      <header class="border-b border-slate-200 bg-white">
        <div class="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-3 px-6 py-5">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">Shaka Player MoQT</h1>
            <p class="mt-1 text-sm text-slate-600">
              WebTransport / MSF playback check with shaka-player.
            </p>
          </div>
          <a class="text-sm text-blue-600 hover:text-blue-700 hover:underline" href="/">
            moqt-devtools
          </a>
        </div>
      </header>

      <main class="mx-auto grid max-w-7xl gap-5 px-6 py-6 lg:grid-cols-3">
        <div class="space-y-5 lg:col-span-1">
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
          <section class="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
            <h2 class="text-lg font-semibold text-slate-900">Notes</h2>
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

        <div class="space-y-5 lg:col-span-2">
          <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
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
          </section>
          <StatusPanel status={status} stats={stats} variants={variants} />
          <LogPanel error={error} logs={logs} />
        </div>
      </main>
    </div>
  );
}
