interface LogPanelProps {
  error: string | null;
  logs: string[];
}

export function LogPanel({ error, logs }: LogPanelProps) {
  return (
    <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 class="text-lg font-semibold">Diagnostics</h2>
      {error !== null && (
        <p
          data-testid="error"
          class="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 font-mono text-sm text-red-800"
        >
          {error}
        </p>
      )}
      <pre
        data-testid="logs"
        class="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100"
      >
        {logs.length === 0 ? "No log messages" : logs.join("\n")}
      </pre>
    </section>
  );
}
