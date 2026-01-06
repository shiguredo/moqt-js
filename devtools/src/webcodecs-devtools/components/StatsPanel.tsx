import * as store from "../signals";
import { ChartIcon } from "./Icons";

export function StatsPanel() {
  const encoderStatsValue = store.encoderStats.value;
  const decoderStatsValue = store.decoderStats.value;

  return (
    <div class="bg-white rounded-xl shadow-sm p-5">
      <h2 class="text-lg font-semibold text-slate-700 mb-4 flex items-center gap-2">
        <ChartIcon />
        Statistics
      </h2>

      <div class="space-y-4">
        <div>
          <h3 class="text-sm font-medium text-slate-600 mb-2">Encoder</h3>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Frames</div>
              <div class="font-mono text-slate-800">{encoderStatsValue.frameCount}</div>
            </div>
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Key Frames</div>
              <div class="font-mono text-slate-800">{encoderStatsValue.keyFrameCount}</div>
            </div>
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Total Bytes</div>
              <div class="font-mono text-slate-800">
                {store.formatBytes(encoderStatsValue.totalBytes)}
              </div>
            </div>
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Avg Bitrate</div>
              <div class="font-mono text-slate-800">
                {store.formatBitrate(encoderStatsValue.averageBitrate)}
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-medium text-slate-600 mb-2">Decoder</h3>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Frames</div>
              <div class="font-mono text-slate-800">{decoderStatsValue.frameCount}</div>
            </div>
            <div class="bg-slate-50 rounded p-2">
              <div class="text-slate-500">Total Bytes</div>
              <div class="font-mono text-slate-800">
                {store.formatBytes(decoderStatsValue.totalBytes)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
