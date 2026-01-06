import { VideoIcon } from "./Icons";

export function VideoPanel() {
  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <h2 class="text-lg font-semibold text-slate-700 mb-4 flex items-center gap-2">
        <VideoIcon />
        Video Preview
      </h2>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 class="text-sm font-medium text-slate-600 mb-2">Source (Camera)</h3>
          <div class="bg-slate-900 rounded-lg overflow-hidden aspect-video flex items-center justify-center">
            <video
              id="source-video"
              class="w-full h-full object-contain"
              autoPlay
              muted
              playsInline
            />
          </div>
        </div>

        <div>
          <h3 class="text-sm font-medium text-slate-600 mb-2">Decoded Output</h3>
          <div class="bg-slate-900 rounded-lg overflow-hidden aspect-video flex items-center justify-center">
            <canvas id="decoded-canvas" class="w-full h-full object-contain" />
          </div>
        </div>
      </div>
    </div>
  );
}
