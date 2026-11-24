export type ConnectionStatus = "idle" | "loading" | "playing" | "error";

const STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  idle: "Ready",
  loading: "Loading",
  playing: "Playing",
  error: "Error",
};

/** パネルのヘッダーに出す状態名。 */
export function statusLabel(status: ConnectionStatus): string {
  return STATUS_LABELS[status];
}

const STATUS_BADGE_CLASSES: Readonly<Record<ConnectionStatus, string>> = {
  idle: "bg-white/20 text-white",
  loading: "bg-white/20 text-white",
  playing: "bg-green-400/30 text-white",
  error: "bg-red-400/30 text-white",
};

/** moqt-devtools のパネルヘッダーと同じ配色のバッジ。 */
export function statusBadgeClass(status: ConnectionStatus): string {
  return STATUS_BADGE_CLASSES[status];
}
