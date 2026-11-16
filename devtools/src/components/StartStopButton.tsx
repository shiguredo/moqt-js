interface StartStopButtonProps {
  active: boolean;
  disabled: boolean;
  starting?: boolean;
  stopping: boolean;
  startLabel: string;
  tone: "green" | "blue";
  testId: string;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
}

/** 配信と購読の主操作。開始と停止で同じ幅と位置を使い、停止中は再操作を防ぐ。 */
export function StartStopButton({
  active,
  disabled,
  starting = false,
  stopping,
  startLabel,
  tone,
  testId,
  onStart,
  onStop,
}: StartStopButtonProps) {
  const showStop = active || stopping;
  const colorClasses = showStop
    ? "bg-red-500 hover:bg-red-600"
    : tone === "green"
      ? "bg-green-500 hover:bg-green-600"
      : "bg-blue-500 hover:bg-blue-600";

  return (
    <button
      type="button"
      onClick={() => void (active ? onStop() : onStart())}
      disabled={disabled || stopping}
      data-testid={testId}
      class={`flex-1 basis-0 min-w-0 px-4 py-2.5 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 ${colorClasses}`}
    >
      <svg
        aria-hidden="true"
        class="w-4 h-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        {showStop ? (
          <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
        ) : (
          <>
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </>
        )}
      </svg>
      {stopping ? "Stopping..." : active ? "Stop" : starting ? "Starting..." : startLabel}
    </button>
  );
}
