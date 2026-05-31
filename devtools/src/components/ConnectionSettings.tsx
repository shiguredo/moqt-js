import { signal } from "@preact/signals";
import * as settings from "../signals/connectionSettings";

const showMoqtHelp = signal(false);
const showMsfHelp = signal(false);
const showLocHelp = signal(false);

function MoqtHelpModal() {
  if (!showMoqtHelp.value) return null;

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => (showMoqtHelp.value = false)}
    >
      <div
        class="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-700">MOQT (Media over QUIC Transport)</h3>
          <button
            onClick={() => (showMoqtHelp.value = false)}
            class="text-slate-400 hover:text-slate-600"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="space-y-4 text-sm text-slate-600">
          <div>
            <p>
              QUIC 上でメディアをリアルタイム配信するためのプロトコルです。
              低遅延かつ信頼性の高いメディアストリーミングを実現します。
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">主要概念</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Client - サーバーに接続してメディアを送受信</li>
              <li>Server - クライアント間のメディア中継</li>
              <li>SUBSCRIBE - トラックの購読リクエスト</li>
              <li>ANNOUNCE - トラックの公開通知</li>
            </ul>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">データ構造</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Track - メディアストリームの単位</li>
              <li>Group - 関連オブジェクトの集合</li>
              <li>Object - 最小のデータ単位</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-transport
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function MsfHelpModal() {
  if (!showMsfHelp.value) return null;

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => (showMsfHelp.value = false)}
    >
      <div
        class="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-700">MSF (MOQT Streaming Format)</h3>
          <button
            onClick={() => (showMsfHelp.value = false)}
            class="text-slate-400 hover:text-slate-600"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="space-y-4 text-sm text-slate-600">
          <div>
            <p>
              MOQT 上でメディアコンテンツを配信するためのストリーミングフォーマットです。 LOC
              によるメディアパッケージングと Catalog によるメタデータ記述を組み合わせます。
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">構成要素</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Catalog - トラックメタデータの JSON 記述</li>
              <li>LOC - メディアパッケージング</li>
              <li>Media Timeline - シーク・同期サポート</li>
              <li>Event Timeline - イベントメタデータ</li>
            </ul>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Catalog トラック</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>トラック名: catalog (固定)</li>
              <li>フォーマット: JSON</li>
              <li>配信可能なトラック情報を記述</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-msf
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function LocHelpModal() {
  if (!showLocHelp.value) return null;

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => (showLocHelp.value = false)}
    >
      <div
        class="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-700">LOC (Low Overhead Container)</h3>
          <button
            onClick={() => (showLocHelp.value = false)}
            class="text-slate-400 hover:text-slate-600"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="space-y-4 text-sm text-slate-600">
          <div>
            <p>
              MOQT 用の軽量メディアコンテナフォーマットです。WebCodecs との親和性が高く、
              最小限のオーバーヘッドでメディアデータを転送できます。
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Header Extensions</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Capture Timestamp - キャプチャ時刻</li>
              <li>Video Frame Marking - キーフレーム判定</li>
              <li>Video Config - デコーダ設定</li>
              <li>Audio Level - オーディオレベル</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-loc
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 現在の WebTransport.reliability を HTTP バージョンバッジとして表示する。
 * draft-ietf-webtrans-http2 / draft-ietf-webtrans-http3 の判別に利用する。
 */
function HttpVersionBadge() {
  const label = settings.toHttpVersionLabel(settings.reliability.value);
  const color =
    label === "HTTP/3"
      ? "bg-green-100 text-green-700"
      : label === "HTTP/2"
        ? "bg-blue-100 text-blue-700"
        : "bg-slate-100 text-slate-500";
  return (
    <span
      class={`px-2 py-0.5 text-xs font-medium rounded-full ${color}`}
      title={`WebTransport.reliability: ${settings.reliability.value}`}
    >
      {label}
    </span>
  );
}

export function ConnectionSettings() {
  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <MsfHelpModal />
      <LocHelpModal />
      <MoqtHelpModal />
      <h2 class="text-lg font-semibold text-slate-700 mb-4 flex items-center gap-2">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        Connection Settings
        <div class="ml-auto flex items-center gap-2">
          <HttpVersionBadge />
          <button
            onClick={() => (showMsfHelp.value = true)}
            class="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full hover:bg-purple-200 transition-colors flex items-center gap-1"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            MSF
          </button>
          <button
            onClick={() => (showLocHelp.value = true)}
            class="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200 transition-colors flex items-center gap-1"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            LOC
          </button>
          <button
            onClick={() => (showMoqtHelp.value = true)}
            class="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full hover:bg-green-200 transition-colors flex items-center gap-1"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            MOQT
          </button>
        </div>
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div class="lg:col-span-2">
          <label for="url" class="block text-sm font-medium text-slate-600 mb-1">
            Server URL
          </label>
          <input
            type="text"
            id="url"
            value={settings.url.value}
            onInput={(e) => (settings.url.value = e.currentTarget.value)}
            disabled={settings.settingsDisabled.value}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
          />
        </div>
        <div class="lg:col-span-3">
          <label for="certificateHash" class="block text-sm font-medium text-slate-600 mb-1">
            Certificate Hash (Base64)
            <span class="ml-1 text-xs text-slate-400">for self-signed certs</span>
          </label>
          <input
            type="text"
            id="certificateHash"
            autocomplete="off"
            value={settings.certificateHash.value}
            onInput={(e) => (settings.certificateHash.value = e.currentTarget.value)}
            disabled={settings.settingsDisabled.value}
            placeholder="openssl x509 -in cert.pem -outform DER | openssl dgst -sha256 -binary | base64"
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
          />
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mt-4">
        <div class="lg:col-span-2">
          <label for="fragment" class="block text-sm font-medium text-slate-600 mb-1">
            URI Fragment
            <span class="ml-1 text-xs text-slate-400">type:value (draft-18 §3.1.2)</span>
          </label>
          <input
            type="text"
            id="fragment"
            value={settings.fragment.value}
            onInput={(e) => (settings.fragment.value = e.currentTarget.value)}
            disabled={settings.settingsDisabled.value}
            placeholder="例: track:video"
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
          />
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mt-4">
        <div>
          <label for="namespace" class="block text-sm font-medium text-slate-600 mb-1">
            Namespace
            <span class="text-xs text-slate-400 ml-1">(「/」で tuple に分割)</span>
          </label>
          <input
            type="text"
            id="namespace"
            placeholder="例: room/123 → [room, 123]"
            value={settings.namespace.value}
            onInput={(e) => (settings.namespace.value = e.currentTarget.value)}
            disabled={settings.settingsDisabled.value}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
          />
        </div>
        <div>
          <label for="trackName" class="block text-sm font-medium text-slate-600 mb-1">
            Track Name
          </label>
          <input
            type="text"
            id="trackName"
            value={settings.trackName.value}
            onInput={(e) => (settings.trackName.value = e.currentTarget.value)}
            disabled={settings.settingsDisabled.value}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
          />
        </div>
        <div>
          <label for="codec" class="block text-sm font-medium text-slate-600 mb-1">
            Codec
          </label>
          <select
            id="codec"
            value={settings.codec.value}
            onChange={(e) => (settings.codec.value = e.currentTarget.value as any)}
            disabled={settings.settingsDisabled.value}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
          >
            <option value="vp8">VP8</option>
            <option value="vp9">VP9</option>
            <option value="av1">AV1</option>
            <option value="h264">H.264</option>
            <option value="h265">H.265</option>
          </select>
        </div>
      </div>

      {/* Video Settings */}
      <div class="mt-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Video Settings</h3>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <label for="videoSource" class="block text-xs text-slate-500 mb-1">
              Video Source
            </label>
            <select
              id="videoSource"
              value={settings.videoSource.value}
              onChange={(e) => {
                settings.videoSource.value = e.currentTarget.value as any;
                if (e.currentTarget.value === "camera") {
                  void settings.fetchCameraDevices();
                }
              }}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="dummy">Dummy (Canvas)</option>
              <option value="camera">Camera (gUM)</option>
            </select>
          </div>
          {settings.videoSource.value === "camera" && (
            <div>
              <label for="cameraDevice" class="block text-xs text-slate-500 mb-1">
                Camera Device
              </label>
              {settings.cameraDevices.value.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void settings.fetchCameraDevices()}
                  disabled={settings.settingsDisabled.value}
                  class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  Fetch Devices
                </button>
              ) : (
                <select
                  id="cameraDevice"
                  value={settings.selectedCameraDeviceId.value}
                  onChange={(e) => (settings.selectedCameraDeviceId.value = e.currentTarget.value)}
                  disabled={settings.settingsDisabled.value}
                  class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  {settings.cameraDevices.value.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div>
            <label for="resolution" class="block text-xs text-slate-500 mb-1">
              Resolution
            </label>
            <select
              id="resolution"
              value={settings.resolution.value}
              onChange={(e) => (settings.resolution.value = e.currentTarget.value)}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
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
              value={settings.framerate.value}
              onChange={(e) => (settings.framerate.value = Number(e.currentTarget.value))}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
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
              value={settings.bitrate.value}
              onChange={(e) => (settings.bitrate.value = Number(e.currentTarget.value))}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
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
              value={settings.keyframeInterval.value}
              onChange={(e) => (settings.keyframeInterval.value = Number(e.currentTarget.value))}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="30">1 sec</option>
              <option value="60">2 sec</option>
              <option value="120">4 sec</option>
              <option value="240">8 sec</option>
              <option value="300">10 sec</option>
              <option value="900">30 sec</option>
              <option value="1800">60 sec</option>
              <option value="2700">90 sec</option>
              <option value="3600">120 sec</option>
              <option value="7200">240 sec</option>
            </select>
          </div>
        </div>
      </div>

      {/* Publish Settings */}
      <div class="mt-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Publish Settings</h3>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <label for="maxCacheDuration" class="block text-xs text-slate-500 mb-1">
              MAX_CACHE_DURATION
            </label>
            <select
              id="maxCacheDuration"
              value={settings.maxCacheDuration.value}
              onChange={(e) => (settings.maxCacheDuration.value = Number(e.currentTarget.value))}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="0">0 (no cache)</option>
              <option value="10000">10 sec</option>
              <option value="30000">30 sec</option>
              <option value="60000">1 min</option>
              <option value="180000">3 min</option>
              <option value="300000">5 min</option>
              <option value="600000">10 min</option>
            </select>
          </div>
        </div>
      </div>

      {/* Subscribe Settings */}
      <div class="mt-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">Subscribe Settings</h3>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <label for="catalogSubscriptionTimeout" class="block text-xs text-slate-500 mb-1">
              Catalog Timeout
            </label>
            <select
              id="catalogSubscriptionTimeout"
              value={settings.catalogSubscriptionTimeout.value}
              onChange={(e) =>
                (settings.catalogSubscriptionTimeout.value = Number(e.currentTarget.value))
              }
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="3000">3 sec</option>
              <option value="5000">5 sec</option>
              <option value="10000">10 sec</option>
              <option value="30000">30 sec</option>
              <option value="60000">1 min</option>
              <option value="120000">2 min</option>
              <option value="300000">5 min</option>
            </select>
          </div>
        </div>
      </div>

      {/* WebCodecs Settings */}
      <div class="mt-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">WebCodecs Settings</h3>
        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="useDedicatedWorker"
            checked={settings.useDedicatedWorker.value}
            onChange={(e) => (settings.useDedicatedWorker.value = e.currentTarget.checked)}
            disabled={settings.settingsDisabled.value}
            class="rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
          />
          <label for="useDedicatedWorker" class="text-sm text-slate-600">
            Use Dedicated Worker
          </label>
        </div>
      </div>

      {/* Authorization Token Settings */}
      {/* draft-ietf-moq-transport-18 §10.3.1.4 (AUTHORIZATION TOKEN Setup Option) */}
      <div class="mt-4 pt-4 border-t border-slate-200">
        <h3 class="text-sm font-medium text-slate-600 mb-3">
          Authorization Token
          <span class="ml-2 text-xs text-slate-400">SETUP Option (0x03)</span>
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label for="authorizationTokenAliasType" class="block text-xs text-slate-500 mb-1">
              Alias Type
            </label>
            <select
              id="authorizationTokenAliasType"
              value={settings.authorizationTokenAliasType.value}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v === "useValue" || v === "register") {
                  settings.authorizationTokenAliasType.value = v;
                }
              }}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
            >
              <option value="useValue">USE_VALUE (0x3)</option>
              <option value="register">REGISTER (0x1)</option>
            </select>
          </div>
          {settings.authorizationTokenAliasType.value === "register" && (
            <div>
              <label for="authorizationTokenAlias" class="block text-xs text-slate-500 mb-1">
                Token Alias
              </label>
              <input
                type="text"
                id="authorizationTokenAlias"
                value={settings.authorizationTokenAlias.value}
                onInput={(e) => (settings.authorizationTokenAlias.value = e.currentTarget.value)}
                disabled={settings.settingsDisabled.value}
                placeholder="0"
                class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
            </div>
          )}
          <div>
            <label for="authorizationTokenType" class="block text-xs text-slate-500 mb-1">
              Token Type
              <span class="ml-1 text-slate-400">(0 = out-of-band)</span>
            </label>
            <input
              type="text"
              id="authorizationTokenType"
              value={settings.authorizationTokenType.value}
              onInput={(e) => (settings.authorizationTokenType.value = e.currentTarget.value)}
              disabled={settings.settingsDisabled.value}
              placeholder="0"
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
          </div>
          <div class="lg:col-span-2">
            <label for="authorizationTokenValue" class="block text-xs text-slate-500 mb-1">
              Token Value
              <span class="ml-1 text-slate-400">(空の場合は送出しない)</span>
            </label>
            <input
              type="text"
              id="authorizationTokenValue"
              autocomplete="off"
              value={settings.authorizationTokenValue.value}
              onInput={(e) => (settings.authorizationTokenValue.value = e.currentTarget.value)}
              disabled={settings.settingsDisabled.value}
              placeholder="任意のトークン文字列 (UTF-8)"
              class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
