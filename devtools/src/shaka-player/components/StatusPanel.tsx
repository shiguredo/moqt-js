import type { ShakaStats, ShakaVariantTrack } from "../shaka";
import { statusLabel, type ConnectionStatus } from "../status";

interface StatusPanelProps {
  status: ConnectionStatus;
  stats: ShakaStats | null;
  variants: ShakaVariantTrack[];
}

function numberOrDash(value: number | undefined, digits = 0): string {
  if (value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(digits);
}

function bitrateOrDash(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${(value / 1000).toFixed(0)} kbps`;
}

function withUnit(value: number | undefined, digits: number, unit: string): string {
  if (value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(digits)} ${unit}`;
}

function resolutionOrDash(stats: ShakaStats | null): string {
  if (stats === null || stats.width === undefined || stats.height === undefined) {
    return "—";
  }
  if (Number.isNaN(stats.width) || Number.isNaN(stats.height)) {
    return "—";
  }
  return `${stats.width}x${stats.height}`;
}

function activeVariant(variants: ShakaVariantTrack[]): ShakaVariantTrack | null {
  return variants.find((variant) => variant.active === true) ?? null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function StatusPanel({ status, stats, variants }: StatusPanelProps) {
  const variant = activeVariant(variants);
  const videoCodec = nonEmptyString(variant?.videoCodec);
  const audioCodec = nonEmptyString(variant?.audioCodec);
  const codecs = videoCodec ?? audioCodec ?? nonEmptyString(stats?.currentCodecs) ?? "—";
  const rows: Array<[string, string]> = [
    ["State", statusLabel(status)],
    ["Resolution", resolutionOrDash(stats)],
    ["Codecs", codecs],
    ["Bandwidth", bitrateOrDash(stats?.streamBandwidth ?? variant?.bandwidth)],
    [
      "Live latency",
      withUnit(stats?.liveLatency !== undefined ? stats.liveLatency * 1000 : undefined, 0, "ms"),
    ],
    ["Decoded frames", numberOrDash(stats?.decodedFrames)],
    ["Dropped frames", numberOrDash(stats?.droppedFrames)],
    ["Buffering time", withUnit(stats?.bufferingTime, 2, "s")],
  ];

  return (
    <section class="rounded-xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-800">Status</h2>
      <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} class="contents">
            <dt class="text-slate-500">{label}</dt>
            <dd class="min-w-0 break-words font-mono text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
      <h3 class="mt-4 text-sm font-semibold text-slate-700">Active tracks</h3>
      {variant === null ? (
        <p class="mt-1 text-sm text-slate-500">No active track</p>
      ) : (
        <ul class="mt-1 space-y-1 text-sm">
          {audioCodec !== null && (
            <li>
              <span class="text-slate-500">Audio: </span>
              <span class="font-mono">{audioCodec}</span>
            </li>
          )}
          {videoCodec !== null && (
            <li>
              <span class="text-slate-500">Video: </span>
              <span class="font-mono">{videoCodec}</span>
              {variant.width !== undefined && variant.height !== undefined && (
                <span class="text-slate-500">
                  {" "}
                  ({variant.width}x{variant.height})
                </span>
              )}
            </li>
          )}
          {variant.bandwidth !== undefined && (
            <li>
              <span class="text-slate-500">Bandwidth: </span>
              <span class="font-mono">{bitrateOrDash(variant.bandwidth)}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
