import type { ShareState } from "../utils/relay";
import { VERSION_OPTIONS } from "../utils/relay";

export type ConnectionStatus = "idle" | "loading" | "playing" | "error";

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
  return (
    <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 class="text-lg font-semibold">Connection</h2>
      <p class="mt-1 text-sm text-slate-600">
        Load an MSF catalog from a MoQT relay with shaka-player.
      </p>

      <label class="mt-4 block text-sm font-medium" for="relay-url">
        Relay URL
      </label>
      <input
        id="relay-url"
        data-testid="relay-url"
        class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
        type="text"
        value={state.relayUrl}
        placeholder="moqt://relay.example.com:443/"
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => onChange("relayUrl", event.currentTarget.value)}
      />
      <p class="mt-1 text-xs text-slate-500">
        moqt:// is converted to https://. The relay must allow WebTransport from this origin.
      </p>

      <label class="mt-4 block text-sm font-medium" for="namespace">
        Namespace
      </label>
      <textarea
        id="namespace"
        data-testid="namespace"
        class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
        rows={3}
        value={state.namespaceText}
        placeholder="shaka-demo/abc123"
        spellcheck={false}
        onInput={(event) => onChange("namespaceText", event.currentTarget.value)}
      />
      <p class="mt-1 text-xs text-slate-500">A single namespace. Fields are separated by /.</p>

      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="block text-sm font-medium" for="version">
            Draft
          </label>
          <select
            id="version"
            data-testid="version"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
          <label class="block text-sm font-medium" for="fingerprint-uri">
            Fingerprint URI
          </label>
          <input
            id="fingerprint-uri"
            data-testid="fingerprint-uri"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            type="text"
            value={state.fingerprintUri}
            placeholder="https://example.com/cert.sha256"
            autocomplete="off"
            spellcheck={false}
            onInput={(event) => onChange("fingerprintUri", event.currentTarget.value)}
          />
        </div>
      </div>

      <label class="mt-4 block text-sm font-medium" for="authorization-token">
        Authorization Token
      </label>
      <input
        id="authorization-token"
        data-testid="authorization-token"
        class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
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
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          type="button"
          disabled={loading}
          onClick={onLoad}
        >
          {loading ? "Loading..." : "Load"}
        </button>
        <button
          data-testid="stop"
          class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          type="button"
          disabled={status === "idle" || loading}
          onClick={onStop}
        >
          Stop
        </button>
        <button
          data-testid="copy-url"
          class="w-36 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
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
    </section>
  );
}
