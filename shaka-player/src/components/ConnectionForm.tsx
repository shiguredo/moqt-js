import { useState } from "preact/hooks";
import { statusBadgeClass, statusLabel, type ConnectionStatus } from "../status";
import type { ShareState } from "../utils/relay";
import { VERSION_OPTIONS } from "../utils/relay";

export interface FormState extends ShareState {
  authorizationToken: string;
}

interface ConnectionFormProps {
  state: FormState;
  status: ConnectionStatus;
  copied: boolean;
  shakaAvailable: boolean;
  onChange: (field: keyof FormState, value: string) => void;
  onLoad: () => void;
  onStop: () => void;
  onCopy: () => void;
}

export function ConnectionForm({
  state,
  status,
  copied,
  shakaAvailable,
  onChange,
  onLoad,
  onStop,
  onCopy,
}: ConnectionFormProps) {
  const loading = status === "loading";
  const [relayVisible, setRelayVisible] = useState(true);
  return (
    <section class="overflow-hidden rounded-xl bg-white shadow-sm">
      <div class="flex items-center justify-between gap-3 bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-3">
        <h2 class="text-lg font-semibold text-white">Connection</h2>
        <span class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}>
          {statusLabel(status)}
        </span>
      </div>
      <div class="p-5">
        <p class="text-sm text-slate-600">
          Load an MSF catalog from a MoQT relay with shaka-player.
        </p>

        <label class="mt-4 block text-sm font-medium text-slate-700" for="relay-url">
          Relay URL
        </label>
        <div class="relative mt-1">
          {relayVisible ? (
            <input
              id="relay-url"
              data-testid="relay-url"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              type="text"
              value={state.relayUrl}
              placeholder="moqt://relay.example.com:443/"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => onChange("relayUrl", event.currentTarget.value)}
            />
          ) : (
            <input
              id="relay-url"
              data-testid="relay-url"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              type="password"
              value={state.relayUrl}
              placeholder="moqt://relay.example.com:443/"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => onChange("relayUrl", event.currentTarget.value)}
            />
          )}
          <button
            type="button"
            data-testid="relay-url-visibility"
            aria-label={relayVisible ? "Hide relay URL" : "Show relay URL"}
            title={relayVisible ? "Hide relay URL" : "Show relay URL"}
            onClick={() => setRelayVisible((current) => !current)}
            class="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-500 transition-colors hover:text-slate-700 focus:ring-2 focus:ring-blue-500 focus:ring-inset focus:outline-none"
          >
            {relayVisible ? (
              <svg
                aria-hidden="true"
                class="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                class="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M3 3l18 18"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10.584 10.587a2 2 0 002.828 2.83M9.363 5.365A9.466 9.466 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.523 10.523 0 01-4.293 5.276M6.228 6.228A10.45 10.45 0 002.458 12c1.274 4.057 5.064 7 9.542 7a9.47 9.47 0 004.293-1.027"
                />
              </svg>
            )}
          </button>
        </div>
        <p class="mt-1 text-xs text-slate-500">
          moqt:// is converted to https://. The relay must allow WebTransport from this origin.
        </p>

        <label class="mt-4 block text-sm font-medium text-slate-700" for="namespace">
          Namespace
        </label>
        <textarea
          id="namespace"
          data-testid="namespace"
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          rows={3}
          value={state.namespaceText}
          placeholder="shaka-demo/abc123"
          spellcheck={false}
          onInput={(event) => onChange("namespaceText", event.currentTarget.value)}
        />
        <p class="mt-1 text-xs text-slate-500">
          A single namespace. Fields can be separated by / or by - (namespace-name format).
        </p>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-sm font-medium text-slate-700" for="version">
              Draft
            </label>
            <select
              id="version"
              data-testid="version"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              value={state.version}
              onChange={(event) => onChange("version", event.currentTarget.value)}
            >
              {VERSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-700" for="fingerprint-uri">
              Fingerprint URI
            </label>
            <input
              id="fingerprint-uri"
              data-testid="fingerprint-uri"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              type="text"
              value={state.fingerprintUri}
              placeholder="https://example.com/cert.sha256"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => onChange("fingerprintUri", event.currentTarget.value)}
            />
          </div>
        </div>

        <label class="mt-4 block text-sm font-medium text-slate-700" for="authorization-token">
          Authorization Token
        </label>
        <input
          id="authorization-token"
          data-testid="authorization-token"
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          type="password"
          value={state.authorizationToken}
          placeholder="C4M CAT (optional)"
          autocomplete="off"
          spellcheck={false}
          onInput={(event) => onChange("authorizationToken", event.currentTarget.value)}
        />
        <p class="mt-1 text-xs text-slate-500">
          The token is kept in memory and is never written to the shared URL.
        </p>

        <div class="mt-5 flex flex-wrap gap-2">
          <button
            data-testid="load"
            class="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300"
            type="button"
            disabled={loading}
            onClick={onLoad}
          >
            {loading ? "Loading..." : "Load"}
          </button>
          <button
            data-testid="stop"
            class={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:bg-slate-300 ${
              status === "idle" ? "bg-slate-400" : "bg-red-500 hover:bg-red-600"
            }`}
            type="button"
            disabled={status === "idle" || loading}
            onClick={onStop}
          >
            Stop
          </button>
          <button
            data-testid="copy-url"
            class="w-36 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            type="button"
            onClick={onCopy}
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
        </div>

        {!shakaAvailable && (
          <p
            data-testid="shaka-missing"
            class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          >
            shaka-player is not loaded. The experimental build has not been vendored into this page.
          </p>
        )}
      </div>
    </section>
  );
}
