import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { useId } from "preact/hooks";
import { isMediaStreamTrackProcessorAvailable } from "moqt-js";
import * as settings from "../signals/connectionSettings";
import { persistServerUrl, relayUriMemoryButtons } from "../utils/serverUrlStore";
import { isConnectionSettingsOpen, toggleConnectionSettings } from "../signals/layout";
import {
  resolveAudioAdvertisement,
  resolveTrackNameProblem,
  resolveVideoAdvertisement,
  type TrackAdvertisement,
  type TrackNameProblem,
} from "../utils/publishTracks";
import type {
  AudioDelivery,
  AudioSourceType,
  CodecType,
  DevtoolsMode,
  VideoSourceType,
} from "../types";

const showMoqtHelp = signal(false);
const showMsfHelp = signal(false);
const showLocHelp = signal(false);
const showC4mHelp = signal(false);

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
            aria-label="Close"
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
              A protocol for real-time media delivery over QUIC. It provides low-latency and
              reliable media streaming.
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Key Concepts</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Client - Connects to a server to send and receive media</li>
              <li>Server - Relays media between clients</li>
              <li>SUBSCRIBE - Requests a track</li>
              <li>ANNOUNCE - Advertises a track</li>
            </ul>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Data Model</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Track - A unit of media stream</li>
              <li>Group - A set of related Objects</li>
              <li>Object - The smallest unit of data</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-21"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-transport-21
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function C4mHelpModal() {
  if (!showC4mHelp.value) return null;

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => (showC4mHelp.value = false)}
    >
      <div
        class="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-700">C4M (CAT-4-MOQT)</h3>
          <button
            onClick={() => (showC4mHelp.value = false)}
            aria-label="Close"
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
              Token-based authorization for MOQT using Common Access Token (CAT). The token controls
              whether a connection is allowed and which actions it may perform.
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Sending the Token</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>SETUP - Sent on connect as AUTHORIZATION_TOKEN (0x03)</li>
              <li>AUTHORIZATION_TOKEN parameter - Sent with SUBSCRIBE, FETCH, etc.</li>
              <li>URL - Base64 in the c4m parameter of the MSF fragment</li>
            </ul>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">moqt claim</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Allowed actions per namespace / track</li>
              <li>Everything is Blocked by default</li>
              <li>moqt-reval - Revalidation interval for ongoing streams (seconds)</li>
            </ul>
          </div>
          <div>
            <p>
              The c4m parameter in the URL is applied to the Authorization Token automatically. The
              relay validates the token; the client sends it as is.
            </p>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-c4m-01"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-c4m-01
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
            aria-label="Close"
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
              A streaming format for delivering media over MOQT. It combines media packaging with
              LOC and metadata description with a Catalog.
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Components</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Catalog - Track metadata in JSON</li>
              <li>LOC - Media packaging</li>
              <li>Media Timeline - Seeking and synchronization</li>
              <li>Event Timeline - Event metadata</li>
            </ul>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Catalog Track</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Track name: catalog (fixed)</li>
              <li>Format: JSON</li>
              <li>Describes the tracks available</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-msf-01
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
            aria-label="Close"
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
              A lightweight media container format for MOQT. It fits WebCodecs well and carries
              media data with minimal overhead.
            </p>
          </div>
          <div>
            <h4 class="font-medium text-slate-700 mb-1">Properties</h4>
            <ul class="list-disc list-inside space-y-1 text-slate-500">
              <li>Timestamp - Media timestamp</li>
              <li>Timescale - Unit of Timestamp</li>
              <li>Video Frame Marking - Keyframe detection</li>
              <li>Video Config - Decoder configuration</li>
              <li>Audio Config - Decoder configuration</li>
              <li>Audio Level - Audio level</li>
            </ul>
          </div>
          <div class="pt-2 border-t border-slate-200">
            <a
              href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-04"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 hover:underline"
            >
              draft-ietf-moq-loc-04
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

const AUDIO_DELIVERY_LABELS: Record<AudioDelivery, string> = {
  subgroup: "Subgroup",
  datagram: "Datagram",
};

// チャンネル数の表示名。許可リストに値を足したときはここにも足す
const AUDIO_CHANNEL_LABELS: Record<number, string> = { 1: "Mono", 2: "Stereo" };

// デバイスの欄 (Camera Device / Audio Device) のボタンと select の大きさ。
// 一覧を取る前は Fetch Devices のボタン (38 px)、取った後は select (37 px) を描くため、高さの違いで
// 行の高さが変わり、下の項目が動く。欄を縦の flex にしてボタンと select を行の高さいっぱいに伸ばし、
// 自身の高さ (flex-basis を 0) は行の高さに加えない。行の高さは同じ行の他の select が決める。
// 行に他の項目が無くなっても潰れないよう、最小の高さを付ける
const DEVICE_CONTROL_SIZE_CLASS = "flex-1 basis-0 min-h-9";

// 映像の入力元の表示名
// 値 "dummy" は URL に残す。画面では生成方法の名前にする
const VIDEO_SOURCE_LABELS: Record<VideoSourceType, string> = {
  none: "None",
  dummy: "Dummy (Canvas)",
  camera: "Camera (gUM)",
};

// 音声の入力元の表示名。Canvas で描く映像と対になるのは、Web Audio で作る音
const AUDIO_SOURCE_LABELS: Record<AudioSourceType, string> = {
  none: "None",
  dummy: "Dummy (WebAudio)",
  microphone: "Microphone (gUM)",
};

/**
 * catalog に載せる予定を Tracks カードの表示にする
 *
 * 配信を始めるまで確定しない要素 (カメラとマイクの許可、AudioEncoder の対応) は
 * 「予定」に含めない。実際に音声を用意できなかった場合は、配信時のログと status message に
 * 理由を出す (utils/publishTracks.ts の resolveAudioAdvertisement)
 */
function formatTrackAdvertisement(advertisement: TrackAdvertisement): string {
  if (advertisement.advertised) {
    return "Yes";
  }
  return advertisement.reason === "source-none"
    ? "No (source is None)"
    : "No (not available in this browser)";
}

// トラック名の問題の表示。draft-ietf-moq-msf-01 §5.2.3: name は Required で、
// catalog の中で namespace ごとに一意でなければならない MUST
const TRACK_NAME_PROBLEM_LABELS: Record<TrackNameProblem, string> = {
  empty: "Track name must not be empty (draft-ietf-moq-msf-01 §5.2.3)",
  duplicate: "Audio and video track names must differ (draft-ietf-moq-msf-01 §5.2.3)",
};

/** 閉じている接続設定の欄に出す要約の 1 項目 */
interface ConnectionSummaryItem {
  label: string;
  value: string;
}

/**
 * 接続設定の要約を作る (欄を閉じている間に 1 行で出す)
 *
 * 接続先と、配信で送る映像と音声の要点を並べる。映像や音声の入力が None のときは形式を出さない。
 * subscriber モードは Publisher だけが使う設定を隠すため、Relay URI と Namespace だけにする
 */
function buildConnectionSummary(currentMode: DevtoolsMode): ConnectionSummaryItem[] {
  const summary: ConnectionSummaryItem[] = [
    { label: "Relay URI", value: settings.url.value || "-" },
    { label: "Namespace", value: settings.namespace.value || "-" },
  ];
  if (currentMode === "subscriber") {
    return summary;
  }
  const videoSource = settings.videoSource.value;
  const audioSource = settings.audioSource.value;
  const audioCodecLabel = settings.audioCodec.value === "opus" ? "Opus" : "AAC";
  // 広告するトラックの名前を並べる (Tracks カードと同じく Audio → Video の順)。
  // 入力が None のトラックは catalog に載らないため出さない
  const advertisedTrackNames: string[] = [];
  if (audioSource !== "none") {
    advertisedTrackNames.push(settings.audioTrackName.value || "-");
  }
  if (videoSource !== "none") {
    advertisedTrackNames.push(settings.videoTrackName.value || "-");
  }
  summary.push(
    {
      label: "Tracks",
      value: advertisedTrackNames.length > 0 ? advertisedTrackNames.join(", ") : "-",
    },
    {
      label: "Audio",
      value:
        audioSource === "none"
          ? AUDIO_SOURCE_LABELS.none
          : `${AUDIO_SOURCE_LABELS[audioSource]} ${audioCodecLabel}${
              settings.audioDelivery.value === "datagram" ? " Datagram" : ""
            }`,
    },
    {
      label: "Video",
      value:
        videoSource === "none"
          ? VIDEO_SOURCE_LABELS.none
          : `${VIDEO_SOURCE_LABELS[videoSource]} ${settings.codec.value.toUpperCase()} ${settings.resolution.value} @ ${settings.framerate.value}fps`,
    },
  );
  return summary;
}

/**
 * Catalog Timeout の表示名を作る
 *
 * 選択肢 (CATALOG_SUBSCRIPTION_TIMEOUTS) はミリ秒で持つため、1 分以上は分で出す
 */
function formatCatalogSubscriptionTimeout(milliseconds: number): string {
  if (milliseconds >= 60000) {
    return `${milliseconds / 60000} min`;
  }
  return `${milliseconds / 1000} sec`;
}

// マイクの音にかけるブラウザの音声処理の切り替え (getUserMedia の制約の名前で出す)
const AUDIO_PROCESSING_OPTIONS = [
  {
    id: "audio-echo-cancellation",
    label: "echoCancellation",
    signal: settings.audioEchoCancellation,
  },
  {
    id: "audio-noise-suppression",
    label: "noiseSuppression",
    signal: settings.audioNoiseSuppression,
  },
  {
    id: "audio-auto-gain-control",
    label: "autoGainControl",
    signal: settings.audioAutoGainControl,
  },
] as const;

/**
 * Publisher または Subscriber の設定を、パネルと同じ色のまとまりにする
 *
 * Video / Audio は Publisher の中、映像の再生と音声の再生先は Subscriber の中に置く。
 * 役割と無関係な「Video Settings」だけの節にはしない。
 */
function RoleSettings({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "publisher" | "subscriber";
  children: ComponentChildren;
}) {
  const frame =
    tone === "publisher" ? "border-green-200 bg-green-50/70" : "border-blue-200 bg-blue-50/70";
  const heading = tone === "publisher" ? "text-green-800" : "text-blue-800";
  return (
    <section class={`mt-6 rounded-xl border px-4 py-4 ${frame}`} data-testid={`${tone}-settings`}>
      <h3 class={`text-sm font-semibold ${heading} mb-4`}>{title}</h3>
      <div class="space-y-5">{children}</div>
    </section>
  );
}

/** 役割のまとまりの中の小見出し */
function SettingsSubsection({ title }: { title: string }) {
  return <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">{title}</h4>;
}

/** 役割のまとまりの中の 1 節。背景と余白で隣の節と分ける */
function SettingsCard({ children }: { children: ComponentChildren }) {
  return <div class="rounded-lg bg-white px-4 py-4">{children}</div>;
}

export function ConnectionSettings() {
  // 設定の欄の開け閉め (見出しの行と、閉じている間の要約の行で切り替える)
  const open = isConnectionSettingsOpen.value;
  const contentId = useId();
  // 表示モード。隠す設定の節と要約の項目をこれで決める
  const currentMode = settings.mode.value;
  const summaryItems = buildConnectionSummary(currentMode);
  const summaryText = summaryItems.map((item) => `${item.label}: ${item.value}`).join(" | ");
  // 映像の入力がカメラのときだけ、カメラデバイスの選択を操作できる
  const cameraSelected = settings.videoSource.value === "camera";
  // 音声の入力がマイクのときだけ、デバイスの選択と音声処理を操作できる
  const microphoneSelected = settings.audioSource.value === "microphone";
  // Tracks カードに出す、catalog に載せる予定。配信を始めるまで確定しない要素
  // (カメラとマイクの許可、AudioEncoder の対応) は含めない
  const videoAdvertisement = resolveVideoAdvertisement(settings.videoSource.value);
  const audioAdvertisement = resolveAudioAdvertisement(
    settings.audioSource.value,
    isMediaStreamTrackProcessorAvailable(),
  );
  const videoAdvertisementText = formatTrackAdvertisement(videoAdvertisement);
  const audioAdvertisementText = formatTrackAdvertisement(audioAdvertisement);
  // 広告するトラックの名前だけを検証する。配信しないトラックの名前は catalog に出ないため、
  // 空でも同名でも配信の内容は変わらない (配信前の検証と同じ規則。utils/publishTracks.ts)
  const trackNameProblem = resolveTrackNameProblem([
    ...(audioAdvertisement.advertised ? [settings.audioTrackName.value] : []),
    ...(videoAdvertisement.advertised ? [settings.videoTrackName.value] : []),
  ]);
  // c4m から読み込んだトークンを解除し、Token Type を既定の 0 に戻す。
  // c4m の取り込みで Token Type は CAT (0x01) になっているため、手入力の UTF-8
  // トークンを CAT として送らないようにする
  // (draft-ietf-moq-c4m-01 §7.1.1: 0x01 の Payload は CBOR エンコードされた CWT)。
  // c4m を取り込んでいない場合は呼ばない (手入力した Token Type を保持する)
  const clearImportedC4mToken = (): void => {
    settings.authorizationTokenBase64.value = "";
    settings.authorizationTokenType.value = "0";
  };
  const relayUriMemory = relayUriMemoryButtons(settings.savedServerUrl.value, settings.url.value);
  const saveRelayUri = (): void => {
    if (!relayUriMemory.saveEnabled) {
      return;
    }
    const next = settings.url.value.trim();
    settings.savedServerUrl.value = next;
    void persistServerUrl(next, true);
  };
  const forgetRelayUri = (): void => {
    if (!relayUriMemory.forgetEnabled) {
      return;
    }
    settings.savedServerUrl.value = null;
    void persistServerUrl(settings.url.value, false);
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <MoqtHelpModal />
      <LocHelpModal />
      <MsfHelpModal />
      <C4mHelpModal />
      <h2
        class={`text-lg font-semibold text-slate-700 flex items-center gap-2 ${open ? "mb-4" : ""}`}
      >
        {/* 見出しの行を押すと設定の欄を開け閉めする。ヘルプのボタンを除く行いっぱいを押せる */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggleConnectionSettings}
          data-testid="connection-settings-toggle"
          title={open ? "Hide connection settings" : "Show connection settings"}
          class="flex-1 min-w-0 flex items-center gap-2 text-left hover:text-slate-900"
        >
          {/* 開け閉めの印。開いている間は下を向く */}
          <svg
            aria-hidden="true"
            class={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 5l7 7-7 7"
            />
          </svg>
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
        </button>
        <div class="flex items-center gap-2">
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
            onClick={() => (showC4mHelp.value = true)}
            class="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full hover:bg-amber-200 transition-colors flex items-center gap-1"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            C4M
          </button>
        </div>
      </h2>
      {/* 閉じている間は、接続先と配信の設定の要約を 1 行で出す。押すと開く */}
      {!open && (
        <button
          type="button"
          aria-expanded={false}
          aria-controls={contentId}
          onClick={toggleConnectionSettings}
          data-testid="connection-settings-summary"
          title={summaryText}
          class="mt-3 w-full px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-left text-sm text-slate-600 truncate"
        >
          {summaryItems.map((item, index) => (
            <span key={item.label}>
              {index > 0 && <span class="mx-2 text-slate-300">|</span>}
              <span class="text-slate-500">{item.label}:</span>{" "}
              <span class="font-mono text-slate-800">{item.value}</span>
            </span>
          ))}
        </button>
      )}
      {/* 設定の節。閉じている間は隠す (入力は signal に結び付いているため、値は変わらない) */}
      <div id={contentId} hidden={!open} data-testid="connection-settings-content">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div class="lg:col-span-2">
            <label for="url" class="block text-sm font-medium text-slate-600 mb-1">
              Relay URI
            </label>
            <input
              type="text"
              id="url"
              data-testid="relay-uri"
              value={settings.url.value}
              onInput={(e) => {
                settings.url.value = e.currentTarget.value;
                // URL に msf fragment が含まれる場合は c4m を Authorization Token に反映する
                settings.applyC4mFromUrl(e.currentTarget.value);
              }}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                data-testid="relay-uri-save"
                disabled={settings.settingsDisabled.value || !relayUriMemory.saveEnabled}
                onClick={saveRelayUri}
                class="px-2 py-0.5 text-xs border border-blue-200 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed"
              >
                Save
              </button>
              <button
                type="button"
                data-testid="relay-uri-forget"
                disabled={settings.settingsDisabled.value || !relayUriMemory.forgetEnabled}
                onClick={forgetRelayUri}
                class="px-2 py-0.5 text-xs border border-rose-200 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed"
              >
                Forget
              </button>
            </div>
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
              <span class="ml-1 text-xs text-slate-400">type:value (draft-21 §6.1.1)</span>
            </label>
            <input
              type="text"
              id="fragment"
              value={settings.fragment.value}
              onInput={(e) => {
                settings.fragment.value = e.currentTarget.value;
                // fragment に msf fragment を貼り付けた場合は c4m を Authorization Token に反映する
                settings.applyC4mFromUrl(e.currentTarget.value);
              }}
              disabled={settings.settingsDisabled.value}
              placeholder="e.g. track:video"
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed text-sm"
            />
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mt-4">
          <div>
            <label for="namespace" class="block text-sm font-medium text-slate-600 mb-1">
              Namespace
              <span class="text-xs text-slate-400 ml-1">(split into a tuple by /)</span>
            </label>
            <input
              type="text"
              id="namespace"
              placeholder="e.g. room/123 → [room, 123]"
              value={settings.namespace.value}
              onInput={(e) => (settings.namespace.value = e.currentTarget.value)}
              disabled={settings.settingsDisabled.value}
              class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        {/* 映像と音声の Encoder / Decoder を Dedicated Worker で動かす。
            Publisher の符号化と Subscriber の復号の両方 */}
        <div class="mt-4">
          <label for="useDedicatedWorker" class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              id="useDedicatedWorker"
              checked={settings.useDedicatedWorker.value}
              onChange={(e) => (settings.useDedicatedWorker.value = e.currentTarget.checked)}
              disabled={settings.settingsDisabled.value}
              class="rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
            />
            <span class="text-sm text-slate-600">Use Dedicated Worker</span>
          </label>
          <p class="mt-1 ml-6 text-xs text-slate-500">
            Video and audio, for both the encoder and the decoder
          </p>
        </div>

        {/* Publisher。subscriber モードでは配信しないので出さない */}
        {currentMode !== "subscriber" && (
          <RoleSettings title="Publisher" tone="publisher">
            <div class="space-y-4">
              <SettingsCard>
                <SettingsSubsection title="Tracks" />
                {/* 配信するトラックの一覧。トラック名とコーデックは catalog のトラックの宣言で
                    あり、符号化の設定 (Video / Audio カード) とは分ける。Advertised は catalog に
                    載せる予定を出し、配信を始めるまで確定しない要素は含めない */}
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* 音声トラック。画面の並びは Audio → Video で揃える */}
                  <div class="rounded border border-slate-200 px-3 py-3">
                    <h5 class="text-xs font-semibold text-slate-600 mb-2">Audio</h5>
                    <div class="flex gap-2 text-xs mb-1">
                      <span class="w-24 shrink-0 text-slate-500">Advertised</span>
                      <span class="font-medium text-slate-700" data-testid="audio-track-advertised">
                        {audioAdvertisementText}
                      </span>
                    </div>
                    <div class="flex gap-2 text-xs mb-3">
                      <span class="w-24 shrink-0 text-slate-500">Role</span>
                      <span class="font-mono text-slate-700">audio</span>
                    </div>
                    <label for="audioTrackName" class="block text-xs text-slate-500 mb-1">
                      Track Name
                    </label>
                    <input
                      type="text"
                      id="audioTrackName"
                      data-testid="audio-track-name"
                      value={settings.audioTrackName.value}
                      onInput={(e) => (settings.audioTrackName.value = e.currentTarget.value)}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 mb-3 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed bg-white"
                    />
                    <label for="audioCodec" class="block text-xs text-slate-500 mb-1">
                      Codec
                    </label>
                    <select
                      id="audioCodec"
                      data-testid="audio-codec"
                      value={settings.audioCodec.value}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (settings.isAudioCodecType(value)) {
                          settings.audioCodec.value = value;
                        }
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_CODECS.map((value) => (
                        <option key={value} value={value}>
                          {value === "opus" ? "Opus" : "AAC"}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* 映像トラック */}
                  <div class="rounded border border-slate-200 px-3 py-3">
                    <h5 class="text-xs font-semibold text-slate-600 mb-2">Video</h5>
                    <div class="flex gap-2 text-xs mb-1">
                      <span class="w-24 shrink-0 text-slate-500">Advertised</span>
                      <span class="font-medium text-slate-700" data-testid="video-track-advertised">
                        {videoAdvertisementText}
                      </span>
                    </div>
                    <div class="flex gap-2 text-xs mb-3">
                      <span class="w-24 shrink-0 text-slate-500">Role</span>
                      <span class="font-mono text-slate-700">video</span>
                    </div>
                    <label for="videoTrackName" class="block text-xs text-slate-500 mb-1">
                      Track Name
                    </label>
                    <input
                      type="text"
                      id="videoTrackName"
                      data-testid="video-track-name"
                      value={settings.videoTrackName.value}
                      onInput={(e) => (settings.videoTrackName.value = e.currentTarget.value)}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 mb-3 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:bg-slate-100 disabled:cursor-not-allowed bg-white"
                    />
                    <label for="videoCodec" class="block text-xs text-slate-500 mb-1">
                      Codec
                    </label>
                    <select
                      id="videoCodec"
                      data-testid="video-codec"
                      value={settings.codec.value}
                      onChange={(e) => (settings.codec.value = e.currentTarget.value as CodecType)}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      <option value="vp8">VP8</option>
                      <option value="vp9">VP9</option>
                      <option value="av1">AV1</option>
                      <option value="h264">H.264</option>
                      <option value="h265">H.265</option>
                    </select>
                  </div>
                </div>
                {/* 空名と同名は MSF §5.2.3 に反し、配信の開始時に拒否される。
                    入力の途中で出さず、問題がある間だけ出す */}
                {trackNameProblem !== null && (
                  <p class="mt-3 text-xs text-red-600" data-testid="tracks-name-warning">
                    {TRACK_NAME_PROBLEM_LABELS[trackNameProblem]}
                  </p>
                )}
              </SettingsCard>
              <SettingsCard>
                <SettingsSubsection title="Audio" />
                <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div>
                    <label for="audioSource" class="block text-xs text-slate-500 mb-1">
                      Audio Source
                    </label>
                    <select
                      id="audioSource"
                      data-testid="audio-source"
                      value={settings.audioSource.value}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (settings.isAudioSourceType(value)) {
                          settings.audioSource.value = value;
                          if (value === "microphone") {
                            void settings.fetchMicrophoneDevices();
                          }
                        }
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_SOURCES.map((value) => (
                        <option key={value} value={value}>
                          {AUDIO_SOURCE_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="audioDelivery" class="block text-xs text-slate-500 mb-1">
                      Audio Delivery
                    </label>
                    <select
                      id="audioDelivery"
                      data-testid="audio-delivery"
                      value={settings.audioDelivery.value}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (settings.isAudioDelivery(value)) {
                          settings.audioDelivery.value = value;
                        }
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_DELIVERIES.map((value) => (
                        <option key={value} value={value}>
                          {AUDIO_DELIVERY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* 音声入力デバイス。音声の入力が microphone でない間も描き、操作できなくする
              (設定で項目が出たり消えたりしないようにする)。高さはカメラデバイスと同じ扱い */}
                  <div class="flex flex-col">
                    <label for="microphoneDevice" class="block text-xs text-slate-500 mb-1">
                      Audio Input
                    </label>
                    {settings.microphoneDevices.value.length === 0 ? (
                      <button
                        type="button"
                        data-testid="microphone-fetch-devices"
                        onClick={() => void settings.fetchMicrophoneDevices()}
                        disabled={settings.settingsDisabled.value || !microphoneSelected}
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400`}
                      >
                        Fetch Devices
                      </button>
                    ) : (
                      <select
                        id="microphoneDevice"
                        data-testid="microphone-device"
                        value={settings.selectedMicrophoneDeviceId.value}
                        onChange={(e) =>
                          (settings.selectedMicrophoneDeviceId.value = e.currentTarget.value)
                        }
                        disabled={settings.settingsDisabled.value || !microphoneSelected}
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed`}
                      >
                        {settings.microphoneDevices.value.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label for="audioBitrate" class="block text-xs text-slate-500 mb-1">
                      Audio Bitrate
                    </label>
                    <select
                      id="audioBitrate"
                      data-testid="audio-bitrate"
                      value={settings.audioBitrate.value}
                      onChange={(e) =>
                        (settings.audioBitrate.value = Number(e.currentTarget.value))
                      }
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_BITRATES.map((value) => (
                        <option key={value} value={value}>
                          {value / 1000} Kbps
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="audioSampleRate" class="block text-xs text-slate-500 mb-1">
                      Sample Rate
                    </label>
                    <select
                      id="audioSampleRate"
                      data-testid="audio-sample-rate"
                      value={settings.audioSampleRate.value}
                      onChange={(e) =>
                        (settings.audioSampleRate.value = Number(e.currentTarget.value))
                      }
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_SAMPLE_RATES.map((value) => (
                        <option key={value} value={value}>
                          {value} Hz
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="audioChannels" class="block text-xs text-slate-500 mb-1">
                      Channels
                    </label>
                    <select
                      id="audioChannels"
                      data-testid="audio-channels"
                      value={settings.audioChannels.value}
                      onChange={(e) =>
                        (settings.audioChannels.value = Number(e.currentTarget.value))
                      }
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.AUDIO_CHANNELS.map((value) => (
                        <option key={value} value={value}>
                          {AUDIO_CHANNEL_LABELS[value] ?? String(value)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {/* マイクの音にかけるブラウザの音声処理。音声の入力が microphone でない間も描き、
            操作できなくする */}
                <div class="mt-3 flex flex-wrap items-center gap-6">
                  {AUDIO_PROCESSING_OPTIONS.map((option) => (
                    <label key={option.id} class="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid={option.id}
                        checked={option.signal.value}
                        onChange={(e) => (option.signal.value = e.currentTarget.checked)}
                        disabled={settings.settingsDisabled.value || !microphoneSelected}
                        class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 disabled:cursor-not-allowed"
                      />
                      <span class="text-sm text-slate-600">{option.label}</span>
                    </label>
                  ))}
                </div>
              </SettingsCard>
              <SettingsCard>
                <SettingsSubsection title="Video" />
                <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div>
                    <label for="videoSource" class="block text-xs text-slate-500 mb-1">
                      Video Source
                    </label>
                    <select
                      id="videoSource"
                      data-testid="video-source"
                      value={settings.videoSource.value}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (settings.isVideoSourceType(value)) {
                          settings.videoSource.value = value;
                          if (value === "camera") {
                            void settings.fetchCameraDevices();
                          }
                        }
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      {settings.VIDEO_SOURCES.map((value) => (
                        <option key={value} value={value}>
                          {VIDEO_SOURCE_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* カメラデバイス。映像の入力が camera でない間も描き、操作できなくする
              (設定で項目が出たり消えたりしないようにする)。ボタンと select は高さが違うため、
              行の高さいっぱいに伸ばし、自身の高さを行の高さに加えない (DEVICE_CONTROL_SIZE_CLASS) */}
                  <div class="flex flex-col">
                    <label for="cameraDevice" class="block text-xs text-slate-500 mb-1">
                      Camera Device
                    </label>
                    {settings.cameraDevices.value.length === 0 ? (
                      <button
                        type="button"
                        data-testid="camera-fetch-devices"
                        onClick={() => void settings.fetchCameraDevices()}
                        disabled={settings.settingsDisabled.value || !cameraSelected}
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400`}
                      >
                        Fetch Devices
                      </button>
                    ) : (
                      <select
                        id="cameraDevice"
                        data-testid="camera-device"
                        value={settings.selectedCameraDeviceId.value}
                        onChange={(e) =>
                          (settings.selectedCameraDeviceId.value = e.currentTarget.value)
                        }
                        disabled={settings.settingsDisabled.value || !cameraSelected}
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed`}
                      >
                        {settings.cameraDevices.value.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
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
                      onChange={(e) =>
                        (settings.keyframeInterval.value = Number(e.currentTarget.value))
                      }
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
              </SettingsCard>
              {/* 音声と映像の両方の track に同じ値を載せる catalog の宣言。トラックごとの
                  設定ではないため、Video / Audio カードとは分ける */}
              <SettingsCard>
                <SettingsSubsection title="Catalog" />
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* draft-ietf-moq-msf-01 §5.2.8 (targetLatency) / §5.2.11 (renderGroup):
                      音声と映像の両方の track に同じ値を載せる catalog の宣言。
                      未指定 (Unset) のときは catalog に載せず、購読側が遅延を選ぶ */}
                  <div>
                    <label for="targetLatency" class="block text-xs text-slate-500 mb-1">
                      Target Latency
                    </label>
                    <select
                      id="targetLatency"
                      data-testid="target-latency"
                      value={settings.targetLatency.value ?? ""}
                      onChange={(e) => {
                        // 空値は「未指定」(null)。Number("") は 0 になるため 0 ms と区別する。
                        // 変換の規則は URL から復元するときと同じ関数に任せる
                        settings.targetLatency.value = settings.resolveOptionNumber(
                          e.currentTarget.value,
                          settings.TARGET_LATENCY_OPTIONS,
                          settings.targetLatency.value,
                        );
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      <option value="">Unset</option>
                      {settings.TARGET_LATENCY_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value} ms
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="renderGroup" class="block text-xs text-slate-500 mb-1">
                      Render Group
                    </label>
                    <select
                      id="renderGroup"
                      data-testid="render-group"
                      value={settings.renderGroup.value ?? ""}
                      onChange={(e) => {
                        // 空値は「未指定」(null)。0 は有効なグループである。
                        // 変換の規則は URL から復元するときと同じ関数に任せる
                        settings.renderGroup.value = settings.resolveOptionNumber(
                          e.currentTarget.value,
                          settings.RENDER_GROUP_OPTIONS,
                          settings.renderGroup.value,
                        );
                      }}
                      disabled={settings.settingsDisabled.value}
                      class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      <option value="">Unset</option>
                      {settings.RENDER_GROUP_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </SettingsCard>
              {/* MAX_CACHE_DURATION は catalog の宣言ではなく、relay に要求するキャッシュの
                  時間 (session.publish のオプション)。catalog の宣言と混ぜない */}
              <SettingsCard>
                <SettingsSubsection title="Relay Cache" />
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label for="maxCacheDuration" class="block text-xs text-slate-500 mb-1">
                      MAX_CACHE_DURATION
                    </label>
                    <select
                      id="maxCacheDuration"
                      value={settings.maxCacheDuration.value}
                      onChange={(e) =>
                        (settings.maxCacheDuration.value = Number(e.currentTarget.value))
                      }
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
              </SettingsCard>
            </div>
          </RoleSettings>
        )}

        {/* Subscriber。publisher モードでは購読しないので出さない */}
        {currentMode !== "publisher" && (
          <RoleSettings title="Subscriber" tone="subscriber">
            <div class="space-y-4">
              <SettingsCard>
                <SettingsSubsection title="Catalog" />
                <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div>
                    <label
                      for="catalogSubscriptionTimeout"
                      class="block text-xs text-slate-500 mb-1"
                    >
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
                      {settings.CATALOG_SUBSCRIPTION_TIMEOUTS.map((value) => (
                        <option key={value} value={value}>
                          {formatCatalogSubscriptionTimeout(value)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </SettingsCard>
              <SettingsCard>
                <SettingsSubsection title="Audio" />
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  {/* 再生先。購読中でも切り替えられるように、接続中でも操作できる */}
                  <div class="flex flex-col">
                    <label for="audioOutputDevice" class="block text-xs text-slate-500 mb-1">
                      Audio Output
                    </label>
                    {settings.audioOutputDevices.value.length === 0 ? (
                      <button
                        type="button"
                        data-testid="audio-output-fetch-devices"
                        onClick={() => void settings.fetchAudioOutputDevices()}
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100`}
                      >
                        Fetch Devices
                      </button>
                    ) : (
                      <select
                        id="audioOutputDevice"
                        data-testid="audio-output-device"
                        value={settings.selectedAudioOutputDeviceId.value}
                        onChange={(e) =>
                          (settings.selectedAudioOutputDeviceId.value = e.currentTarget.value)
                        }
                        class={`${DEVICE_CONTROL_SIZE_CLASS} w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white`}
                      >
                        <option value="">Default</option>
                        {settings.audioOutputDevices.value.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </SettingsCard>
              <SettingsCard>
                <SettingsSubsection title="Video" />
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  {/* 映像の表示時刻。音声の再生先とは別の節にする */}
                  <div class="flex flex-col lg:col-span-2">
                    <span class="block text-xs text-slate-500 mb-2">Jitter Buffer</span>
                    <label
                      for="jitterBufferEnabled"
                      class="flex items-center gap-2 min-h-9 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        id="jitterBufferEnabled"
                        data-testid="settings-jitter-buffer"
                        checked={settings.jitterBufferEnabled.value}
                        onChange={(e) =>
                          (settings.jitterBufferEnabled.value = e.currentTarget.checked)
                        }
                        disabled={settings.settingsDisabled.value}
                        class="rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
                      />
                      <span class="text-sm text-slate-600">Play video at LOC TIMESTAMP</span>
                    </label>
                  </div>
                </div>
              </SettingsCard>
            </div>
          </RoleSettings>
        )}

        {/* Authorization Token Settings */}
        {/* draft-ietf-moq-transport-21 §9.1.4 (AUTHORIZATION TOKEN Setup Option) */}
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
                <span class="ml-1 text-slate-400">(0 = out-of-band / 1 = CAT)</span>
              </label>
              <input
                type="text"
                id="authorizationTokenType"
                value={settings.authorizationTokenType.value}
                data-testid="authorization-token-type"
                onInput={(e) => {
                  settings.authorizationTokenType.value = e.currentTarget.value;
                  // 手入力した場合は c4m から読み込んだ Base64 トークンを解除する
                  // (解除しないと送信内容と UI の表示が食い違う)。
                  // 入力した Token Type はそのまま使う
                  settings.authorizationTokenBase64.value = "";
                }}
                disabled={settings.settingsDisabled.value}
                placeholder="0"
                class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
            </div>
            <div class="lg:col-span-2">
              <label for="authorizationTokenValue" class="block text-xs text-slate-500 mb-1">
                Token Value
                <span class="ml-1 text-slate-400">(not sent when empty)</span>
              </label>
              <input
                type="text"
                id="authorizationTokenValue"
                data-testid="authorization-token-value"
                autocomplete="off"
                value={settings.authorizationTokenValue.value}
                onInput={(e) => {
                  settings.authorizationTokenValue.value = e.currentTarget.value;
                  // c4m から読み込んだトークンがある場合だけ解除する
                  // (取り込んでいないときに手入力した Token Type を壊さない)
                  if (settings.authorizationTokenBase64.value) {
                    clearImportedC4mToken();
                  }
                }}
                disabled={settings.settingsDisabled.value}
                placeholder="Any token string (UTF-8)"
                class="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
            </div>
          </div>
          {settings.authorizationTokenBase64.value && (
            <div class="mt-2 flex items-center gap-2 text-xs" data-testid="authorization-token-c4m">
              <span class="px-2 py-0.5 font-medium bg-amber-100 text-amber-700 rounded-full">
                c4m
              </span>
              <span class="text-slate-500">
                Sends the token loaded from the c4m parameter in the URL with SETUP (Base64)
              </span>
              <button
                type="button"
                onClick={() => clearImportedC4mToken()}
                class="text-slate-400 hover:text-slate-600 underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
