import * as store from "../signals";
import { ListIcon, ClearIcon } from "./Icons";
import { ActionButton } from "./ActionButton";
import { useAutoScroll } from "../hooks";

export function FrameLogPanel() {
  const encodedFramesValue = store.encodedFrames.value;
  const scrollRef = useAutoScroll(encodedFramesValue);

  const handleClear = () => {
    store.clearFrameLogs();
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <ListIcon />
          Frame Log
        </h2>
        <ActionButton onClick={handleClear} title="Clear logs" variant="warning">
          <ClearIcon />
        </ActionButton>
      </div>

      <div
        ref={scrollRef}
        class="h-64 overflow-y-auto bg-slate-50 rounded-lg p-2 font-mono text-xs"
      >
        {encodedFramesValue.length === 0 ? (
          <div class="text-slate-400 text-center py-4">No frames encoded yet</div>
        ) : (
          <table class="w-full">
            <thead class="sticky top-0 bg-slate-100">
              <tr class="text-left text-slate-500">
                <th class="px-2 py-1">Time</th>
                <th class="px-2 py-1">Type</th>
                <th class="px-2 py-1">Size</th>
              </tr>
            </thead>
            <tbody>
              {encodedFramesValue.map((frame, index) => (
                <tr key={index} class="border-t border-slate-200">
                  <td class="px-2 py-1 text-slate-600">{store.formatTimestamp(frame.timestamp)}</td>
                  <td class="px-2 py-1">
                    <span
                      class={`px-1.5 py-0.5 rounded text-xs ${
                        frame.type === "key"
                          ? "bg-green-100 text-green-700"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {frame.type === "key" ? "KEY" : "DELTA"}
                    </span>
                  </td>
                  <td class="px-2 py-1 text-slate-600">{store.formatBytes(frame.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
