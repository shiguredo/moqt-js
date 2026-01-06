import * as store from "../signals";
import { SettingsIcon, PlayIcon, StopIcon, ResetIcon } from "./Icons";

export function ConfigPanel() {
  const handleStartStop = () => {
    if (store.isCapturing.value) {
      store.stopCapture();
    } else {
      void store.startCapture();
    }
  };

  const handleReset = () => {
    store.resetEncoder();
  };

  const getButtonClass = () => {
    if (store.isCapturing.value) {
      return "bg-red-500 hover:bg-red-600 text-white";
    }
    return "bg-blue-500 hover:bg-blue-600 text-white";
  };

  const getStatusClass = () => {
    if (store.encoderError.value) {
      return "text-red-600";
    }
    if (store.encoderStatus.value === "configured") {
      return "text-green-600";
    }
    return "text-slate-500";
  };

  const getStatusText = () => {
    if (store.encoderError.value) {
      return `Error: ${store.encoderError.value}`;
    }
    if (store.isCapturing.value) {
      return "Capturing";
    }
    if (store.encoderStatus.value === "configured") {
      return "Configured";
    }
    return "Unconfigured";
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <h2 class="text-lg font-semibold text-slate-700 mb-4 flex items-center gap-2">
        <SettingsIcon />
        Settings
      </h2>

      {/* Device Error */}
      {store.deviceError.value && (
        <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {store.deviceError.value}
        </div>
      )}

      {/* Video Source Settings */}
      <div class="mb-4">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Video Input</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label for="videoSource" class="block text-xs text-slate-500 mb-1">
              Video Source
            </label>
            <select
              id="videoSource"
              value={store.videoSource.value}
              onChange={(e) => {
                store.videoSource.value = e.currentTarget.value as store.VideoSourceType;
                if (e.currentTarget.value === "camera") {
                  void store.fetchDevices();
                }
              }}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="dummy">Dummy (Canvas)</option>
              <option value="camera">Camera (gUM)</option>
            </select>
          </div>
          {store.videoSource.value === "camera" && (
            <div>
              <label for="videoDevice" class="block text-xs text-slate-500 mb-1">
                Camera Device
              </label>
              {store.videoDevices.value.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void store.fetchDevices()}
                  disabled={store.settingsDisabled.value}
                  class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  Fetch Devices
                </button>
              ) : (
                <select
                  id="videoDevice"
                  value={store.selectedVideoDeviceId.value}
                  onChange={(e) => (store.selectedVideoDeviceId.value = e.currentTarget.value)}
                  disabled={store.settingsDisabled.value}
                  class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  {store.videoDevices.value.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Encoder Settings */}
      <div class="mb-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Encoder Settings</h3>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div>
            <label for="codec" class="block text-xs text-slate-500 mb-1">
              Codec
            </label>
            <select
              id="codec"
              value={store.videoCodec.value}
              onChange={(e) => (store.videoCodec.value = e.currentTarget.value)}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="vp8">VP8 (vp8)</option>
              <option value="vp09.00.10.08">VP9 (vp09.00.10.08)</option>
              <option value="av01.0.01M.08">AV1 (av01.0.01M.08)</option>
              <option value="avc1.42001E">H.264 Baseline (avc1.42001E)</option>
              <option value="avc1.4D001E">H.264 Main (avc1.4D001E)</option>
              <option value="avc1.64001E">H.264 High (avc1.64001E)</option>
              <option value="hvc1.1.6.L93.B0">H.265 (hvc1.1.6.L93.B0)</option>
            </select>
          </div>

          <div>
            <label for="resolution" class="block text-xs text-slate-500 mb-1">
              Resolution
            </label>
            <select
              id="resolution"
              value={store.resolution.value}
              onChange={(e) => (store.resolution.value = e.currentTarget.value)}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="1920x1080">1080p (1920x1080)</option>
              <option value="1280x720">720p (1280x720)</option>
              <option value="960x540">540p (960x540)</option>
              <option value="640x480">480p (640x480)</option>
              <option value="320x240">240p (320x240)</option>
            </select>
          </div>

          <div>
            <label for="framerate" class="block text-xs text-slate-500 mb-1">
              Frame Rate
            </label>
            <select
              id="framerate"
              value={store.framerate.value}
              onChange={(e) => (store.framerate.value = Number(e.currentTarget.value))}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="60">60 fps</option>
              <option value="30">30 fps</option>
              <option value="15">15 fps</option>
            </select>
          </div>

          <div>
            <label for="bitrate" class="block text-xs text-slate-500 mb-1">
              Bitrate
            </label>
            <select
              id="bitrate"
              value={store.bitrate.value}
              onChange={(e) => (store.bitrate.value = Number(e.currentTarget.value))}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="16000000">16 Mbps</option>
              <option value="8000000">8 Mbps</option>
              <option value="4000000">4 Mbps</option>
              <option value="2000000">2 Mbps</option>
              <option value="1000000">1 Mbps</option>
              <option value="500000">500 Kbps</option>
            </select>
          </div>

          <div>
            <label for="keyframeInterval" class="block text-xs text-slate-500 mb-1">
              Keyframe Interval
            </label>
            <select
              id="keyframeInterval"
              value={store.keyframeInterval.value}
              onChange={(e) => (store.keyframeInterval.value = Number(e.currentTarget.value))}
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="30">30 frames</option>
              <option value="60">60 frames</option>
              <option value="90">90 frames</option>
              <option value="120">120 frames</option>
            </select>
          </div>
        </div>
      </div>

      {/* Worker Settings */}
      <div class="mb-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Worker Settings</h3>
        <div class="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-4">
          <div>
            <label for="encoderWorkerMode" class="block text-xs text-slate-500 mb-1">
              Encoder Worker
            </label>
            <select
              id="encoderWorkerMode"
              value={store.encoderWorkerMode.value}
              onChange={(e) =>
                (store.encoderWorkerMode.value = e.currentTarget.value as store.WorkerMode)
              }
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="none">None (Main Thread)</option>
              <option value="dedicated">DedicatedWorker</option>
            </select>
          </div>

          <div>
            <label for="decoderWorkerMode" class="block text-xs text-slate-500 mb-1">
              Decoder Worker
            </label>
            <select
              id="decoderWorkerMode"
              value={store.decoderWorkerMode.value}
              onChange={(e) =>
                (store.decoderWorkerMode.value = e.currentTarget.value as store.WorkerMode)
              }
              disabled={store.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="none">None (Main Thread)</option>
              <option value="dedicated">DedicatedWorker</option>
            </select>
          </div>
        </div>
      </div>

      {/* Control Buttons */}
      <div class="flex items-center gap-4 pt-4 border-t border-slate-200">
        <button
          onClick={handleStartStop}
          class={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${getButtonClass()}`}
        >
          {store.isCapturing.value ? (
            <>
              <StopIcon />
              Stop
            </>
          ) : (
            <>
              <PlayIcon />
              Start
            </>
          )}
        </button>
        <button
          onClick={handleReset}
          disabled={store.isCapturing.value}
          class="px-4 py-2 rounded-lg font-medium transition-colors bg-slate-200 hover:bg-slate-300 text-slate-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ResetIcon />
          Reset
        </button>
        <span class={`text-sm ${getStatusClass()}`}>{getStatusText()}</span>
      </div>
    </div>
  );
}
