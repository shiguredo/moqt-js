/**
 * moqt-js 高レベル API サンプル
 *
 * Publisher と Subscriber を 1 ページで体験できる
 */

import {
  createMediaPublisher,
  createMediaSubscriber,
  type MediaPublisher,
  type MediaSubscriber,
  type AudioCodecType,
  type VideoCodecType,
  type Catalog,
} from "moqt-js";

// DOM 要素
const urlInput = document.getElementById("url") as HTMLInputElement;
const certHashInput = document.getElementById("certHash") as HTMLInputElement;
const audioInputSelect = document.getElementById("audioInput") as HTMLSelectElement;
const audioOutputSelect = document.getElementById("audioOutput") as HTMLSelectElement;
const videoInputSelect = document.getElementById("videoInput") as HTMLSelectElement;
const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const startPublishBtn = document.getElementById("startPublish") as HTMLButtonElement;
const stopPublishBtn = document.getElementById("stopPublish") as HTMLButtonElement;
const startSubscribeBtn = document.getElementById("startSubscribe") as HTMLButtonElement;
const stopSubscribeBtn = document.getElementById("stopSubscribe") as HTMLButtonElement;
const pubStatusDiv = document.getElementById("pubStatus") as HTMLDivElement;
const subStatusDiv = document.getElementById("subStatus") as HTMLDivElement;
const pubLogDiv = document.getElementById("pubLog") as HTMLDivElement;
const subLogDiv = document.getElementById("subLog") as HTMLDivElement;

// Publisher 設定要素
const pubAudioCodecSelect = document.getElementById("pubAudioCodec") as HTMLSelectElement;
const pubAudioBitrateInput = document.getElementById("pubAudioBitrate") as HTMLInputElement;
const pubVideoCodecSelect = document.getElementById("pubVideoCodec") as HTMLSelectElement;
const pubVideoBitrateInput = document.getElementById("pubVideoBitrate") as HTMLInputElement;
const pubVideoFramerateInput = document.getElementById("pubVideoFramerate") as HTMLInputElement;
const pubVideoWidthInput = document.getElementById("pubVideoWidth") as HTMLInputElement;
const pubVideoHeightInput = document.getElementById("pubVideoHeight") as HTMLInputElement;
const pubKeyframeIntervalInput = document.getElementById("pubKeyframeInterval") as HTMLInputElement;

// 統計情報要素
const pubAudioFrames = document.getElementById("pubAudioFrames") as HTMLSpanElement;
const pubAudioBytes = document.getElementById("pubAudioBytes") as HTMLSpanElement;
const pubVideoFrames = document.getElementById("pubVideoFrames") as HTMLSpanElement;
const pubVideoBytes = document.getElementById("pubVideoBytes") as HTMLSpanElement;
const subAudioFrames = document.getElementById("subAudioFrames") as HTMLSpanElement;
const subAudioBytes = document.getElementById("subAudioBytes") as HTMLSpanElement;
const subVideoFrames = document.getElementById("subVideoFrames") as HTMLSpanElement;
const subVideoBytes = document.getElementById("subVideoBytes") as HTMLSpanElement;

// Catalog 表示エリア
const pubCatalogDiv = document.getElementById("pubCatalog") as HTMLDivElement;
const pubCatalogContent = document.getElementById("pubCatalogContent") as HTMLPreElement;
const subCatalogDiv = document.getElementById("subCatalog") as HTMLDivElement;
const subCatalogContent = document.getElementById("subCatalogContent") as HTMLPreElement;

// コピーボタン
const copyUrlBtn = document.getElementById("copyUrl") as HTMLButtonElement;
const copyAllInfoBtn = document.getElementById("copyAllInfo") as HTMLButtonElement;

// 状態
let publisher: MediaPublisher | null = null;
let subscriber: MediaSubscriber | null = null;
let localStream: MediaStream | null = null;
let statsIntervalId: number | null = null;

// バイト数をフォーマット
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ビットレートをフォーマット
function formatBitrate(bps: number): string {
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1000000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1000000).toFixed(1)} Mbps`;
}

// Catalog を見やすくフォーマット
function formatCatalog(catalog: Catalog): string {
  const lines: string[] = [];
  lines.push(`version: ${catalog.version}`);
  if (catalog.generatedAt) {
    lines.push(`generated: ${new Date(catalog.generatedAt).toLocaleTimeString()}`);
  }
  lines.push(`tracks: ${catalog.tracks.length}`);
  for (const track of catalog.tracks) {
    lines.push(`  - ${track.name} (${track.role ?? "unknown"})`);
    lines.push(`    codec: ${track.codec ?? "N/A"}`);
    if (track.bitrate) {
      lines.push(`    bitrate: ${formatBitrate(track.bitrate)}`);
    }
    if (track.width && track.height) {
      lines.push(`    resolution: ${track.width}x${track.height}`);
    }
    if (track.framerate) {
      lines.push(`    framerate: ${track.framerate} fps`);
    }
    if (track.samplerate) {
      lines.push(`    samplerate: ${track.samplerate} Hz`);
    }
  }
  return lines.join("\n");
}

// 統計情報を更新
function updateStats(): void {
  if (publisher) {
    const stats = publisher.getStats();
    if (stats.audio) {
      pubAudioFrames.textContent = String(stats.audio.framesSent);
      pubAudioBytes.textContent = formatBytes(stats.audio.bytesSent);
    }
    if (stats.video) {
      pubVideoFrames.textContent = String(stats.video.framesSent);
      pubVideoBytes.textContent = formatBytes(stats.video.bytesSent);
    }
  }

  if (subscriber) {
    const stats = subscriber.getStats();
    if (stats.audio) {
      subAudioFrames.textContent = String(stats.audio.framesReceived);
      subAudioBytes.textContent = formatBytes(stats.audio.bytesReceived);
    }
    if (stats.video) {
      subVideoFrames.textContent = String(stats.video.framesReceived);
      subVideoBytes.textContent = formatBytes(stats.video.bytesReceived);
    }
  }
}

// 統計情報の定期更新を開始
function startStatsUpdate(): void {
  if (statsIntervalId === null) {
    statsIntervalId = window.setInterval(updateStats, 500);
  }
}

// 統計情報の定期更新を停止
function stopStatsUpdate(): void {
  if (statsIntervalId !== null) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
}

// デバイス列挙
async function enumerateDevices(): Promise<void> {
  try {
    // 権限を取得するため一時的にメディアを取得
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tempStream.getTracks().forEach((track) => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();

    // セレクトボックスをクリア
    audioInputSelect.innerHTML = "";
    audioOutputSelect.innerHTML = "";
    videoInputSelect.innerHTML = "";

    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.text = device.label || `${device.kind} (${device.deviceId.slice(0, 8)}...)`;

      if (device.kind === "audioinput") {
        audioInputSelect.appendChild(option);
      } else if (device.kind === "audiooutput") {
        audioOutputSelect.appendChild(option);
      } else if (device.kind === "videoinput") {
        videoInputSelect.appendChild(option);
      }
    }
  } catch (error) {
    console.error("failed to enumerate devices:", error);
  }
}

// 音声出力デバイスを設定
async function setAudioOutput(videoElement: HTMLVideoElement, deviceId: string): Promise<void> {
  if (typeof videoElement.setSinkId === "function") {
    try {
      await videoElement.setSinkId(deviceId);
    } catch (error) {
      console.error("failed to set audio output:", error);
    }
  }
}

// ログ関数
function log(target: "pub" | "sub", message: string, isError = false): void {
  const logDiv = target === "pub" ? pubLogDiv : subLogDiv;
  const time = new Date().toLocaleTimeString();
  const className = isError ? "log-error" : target === "pub" ? "log-pub" : "log-sub";

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="log-time">${time}</span><span class="${className}">${message}</span>`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

// ステータス更新
function updateStatus(target: "pub" | "sub", status: string): void {
  const statusDiv = target === "pub" ? pubStatusDiv : subStatusDiv;
  statusDiv.textContent = status;
  statusDiv.className = `status ${status}`;
}

// 証明書ハッシュの取得
function getCertificateHashes(): Uint8Array[] | undefined {
  const hash = certHashInput.value.trim();
  if (!hash) return undefined;

  try {
    const binary = atob(hash);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return [bytes];
  } catch {
    log("pub", "invalid certificate hash format", true);
    return undefined;
  }
}

// Publisher 開始
async function startPublishing(): Promise<void> {
  try {
    log("pub", "getting user media...");

    const audioDeviceId = audioInputSelect.value;
    const videoDeviceId = videoInputSelect.value;

    // UI から設定を取得
    const videoWidth = Number(pubVideoWidthInput.value);
    const videoHeight = Number(pubVideoHeightInput.value);
    const videoFramerate = Number(pubVideoFramerateInput.value);

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: videoWidth },
        height: { ideal: videoHeight },
        frameRate: { ideal: videoFramerate },
      },
    });

    localVideo.srcObject = localStream;
    log("pub", "user media acquired");

    const url = urlInput.value;
    const certHashes = getCertificateHashes();

    // UI から設定を取得
    const audioCodec = pubAudioCodecSelect.value as AudioCodecType;
    const audioBitrate = Number(pubAudioBitrateInput.value) * 1000;
    const videoCodec = pubVideoCodecSelect.value as VideoCodecType;
    const videoBitrate = Number(pubVideoBitrateInput.value) * 1000;
    const keyframeInterval = Number(pubKeyframeIntervalInput.value);

    log("pub", `connecting to ${url}...`);
    log("pub", `audio: ${audioCodec} ${audioBitrate / 1000}kbps`);
    log(
      "pub",
      `video: ${videoCodec} ${videoBitrate / 1000}kbps ${videoWidth}x${videoHeight}@${videoFramerate}fps`,
    );

    publisher = await createMediaPublisher(url, {
      namespace: ["example"],
      audio: {
        trackName: "audio",
        codec: audioCodec,
        bitrate: audioBitrate,
      },
      video: {
        trackName: "video",
        codec: videoCodec,
        width: videoWidth,
        height: videoHeight,
        bitrate: videoBitrate,
        framerate: videoFramerate,
        keyframeInterval: keyframeInterval,
      },
      serverCertificateHashes: certHashes,
      onStateChange: (state) => {
        log("pub", `state: ${state}`);
        updateStatus("pub", state);
      },
      onError: (error) => {
        log("pub", `error: ${error.message}`, true);
      },
    });

    log("pub", "starting publisher...");
    await publisher.start(localStream);
    log("pub", "publisher started");

    // Catalog を表示
    const catalog = publisher.getCatalog();
    if (catalog) {
      log("pub", `catalog created: ${catalog.tracks.length} tracks`);
      pubCatalogDiv.style.display = "block";
      pubCatalogContent.textContent = formatCatalog(catalog);
    }

    startStatsUpdate();

    startPublishBtn.disabled = true;
    stopPublishBtn.disabled = false;
  } catch (error) {
    log("pub", `failed: ${error instanceof Error ? error.message : String(error)}`, true);
    await stopPublishing();
  }
}

// Publisher 停止
async function stopPublishing(): Promise<void> {
  if (publisher) {
    log("pub", "closing publisher...");
    await publisher.close();
    publisher = null;
    pubCatalogDiv.style.display = "none";
    pubCatalogContent.textContent = "";
    log("pub", "publisher closed");
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  // 両方停止したら統計更新を停止
  if (!publisher && !subscriber) {
    stopStatsUpdate();
  }

  startPublishBtn.disabled = false;
  stopPublishBtn.disabled = true;
  updateStatus("pub", "closed");
}

// Subscriber 開始
async function startSubscribing(): Promise<void> {
  try {
    const url = urlInput.value;
    const certHashes = getCertificateHashes();

    log("sub", `connecting to ${url}...`);

    subscriber = await createMediaSubscriber(url, {
      namespace: ["example"],
      audio: {
        trackName: "audio",
      },
      video: {
        trackName: "video",
      },
      serverCertificateHashes: certHashes,
      onStateChange: (state) => {
        log("sub", `state: ${state}`);
        updateStatus("sub", state);
      },
      onCatalog: (catalog) => {
        log("sub", `catalog received: ${catalog.tracks.length} tracks`);
        subCatalogDiv.style.display = "block";
        subCatalogContent.textContent = formatCatalog(catalog);
      },
      onError: (error) => {
        log("sub", `error: ${error.message}`, true);
      },
    });

    log("sub", "starting subscriber...");
    await subscriber.start();

    remoteVideo.srcObject = subscriber.mediaStream;

    // 音声出力デバイスを設定
    const audioOutputId = audioOutputSelect.value;
    if (audioOutputId) {
      await setAudioOutput(remoteVideo, audioOutputId);
    }

    log("sub", "subscriber started");

    startStatsUpdate();

    startSubscribeBtn.disabled = true;
    stopSubscribeBtn.disabled = false;
  } catch (error) {
    log("sub", `failed: ${error instanceof Error ? error.message : String(error)}`, true);
    await stopSubscribing();
  }
}

// Subscriber 停止
async function stopSubscribing(): Promise<void> {
  if (subscriber) {
    log("sub", "closing subscriber...");
    await subscriber.close();
    subscriber = null;
    remoteVideo.srcObject = null;
    subCatalogDiv.style.display = "none";
    subCatalogContent.textContent = "";
    log("sub", "subscriber closed");
  }

  // 両方停止したら統計更新を停止
  if (!publisher && !subscriber) {
    stopStatsUpdate();
  }

  startSubscribeBtn.disabled = false;
  stopSubscribeBtn.disabled = true;
  updateStatus("sub", "closed");
}

// イベントリスナー
startPublishBtn.addEventListener("click", startPublishing);
stopPublishBtn.addEventListener("click", stopPublishing);
startSubscribeBtn.addEventListener("click", startSubscribing);
stopSubscribeBtn.addEventListener("click", stopSubscribing);

// 音声出力デバイス変更時
audioOutputSelect.addEventListener("change", async () => {
  if (remoteVideo.srcObject) {
    await setAudioOutput(remoteVideo, audioOutputSelect.value);
  }
});

// LLM 用に情報をコピー
copyAllInfoBtn.addEventListener("click", async () => {
  const lines: string[] = [];

  // Publisher 情報
  lines.push("## Publisher");
  lines.push(`Status: ${pubStatusDiv.textContent}`);
  if (publisher) {
    const stats = publisher.getStats();
    lines.push(`Audio Encoder: ${stats.audio ? "initialized" : "not initialized"}`);
    lines.push(`Video Encoder: ${stats.video ? "initialized" : "not initialized"}`);
  } else {
    lines.push("Audio Encoder: not started");
    lines.push("Video Encoder: not started");
  }
  lines.push(`Audio frames: ${pubAudioFrames.textContent}`);
  lines.push(`Audio bytes: ${pubAudioBytes.textContent}`);
  lines.push(`Video frames: ${pubVideoFrames.textContent}`);
  lines.push(`Video bytes: ${pubVideoBytes.textContent}`);

  // Publisher Catalog 情報
  if (pubCatalogContent.textContent) {
    lines.push("");
    lines.push("### Catalog");
    lines.push(pubCatalogContent.textContent);
  }

  lines.push("");
  lines.push("### Publisher Log");
  const pubEntries = pubLogDiv.querySelectorAll(".log-entry");
  for (const entry of pubEntries) {
    lines.push(entry.textContent ?? "");
  }

  // Subscriber 情報
  lines.push("");
  lines.push("## Subscriber");
  lines.push(`Status: ${subStatusDiv.textContent}`);
  if (subscriber) {
    const stats = subscriber.getStats();
    lines.push(`Audio Decoder: ${stats.audio ? "initialized" : "not initialized"}`);
    lines.push(`Video Decoder: ${stats.video ? "initialized" : "not initialized"}`);
  } else {
    lines.push("Audio Decoder: not started");
    lines.push("Video Decoder: not started");
  }
  lines.push(`Audio frames: ${subAudioFrames.textContent}`);
  lines.push(`Audio bytes: ${subAudioBytes.textContent}`);
  lines.push(`Video frames: ${subVideoFrames.textContent}`);
  lines.push(`Video bytes: ${subVideoBytes.textContent}`);

  // Catalog 情報
  if (subCatalogContent.textContent) {
    lines.push("");
    lines.push("### Catalog");
    lines.push(subCatalogContent.textContent);
  }

  lines.push("");
  lines.push("### Subscriber Log");
  const subEntries = subLogDiv.querySelectorAll(".log-entry");
  for (const entry of subEntries) {
    lines.push(entry.textContent ?? "");
  }

  const text = lines.join("\n");
  await navigator.clipboard.writeText(text);

  copyAllInfoBtn.textContent = "Copied!";
  copyAllInfoBtn.classList.add("copied");
  setTimeout(() => {
    copyAllInfoBtn.textContent = "Copy for LLM";
    copyAllInfoBtn.classList.remove("copied");
  }, 2000);
});

// query string から設定を復元
function loadSettingsFromUrl(): void {
  const params = new URLSearchParams(window.location.search);

  const url = params.get("url");
  if (url) {
    urlInput.value = url;
  }

  const certHash = params.get("certHash");
  if (certHash) {
    certHashInput.value = certHash;
  }

  const audioCodec = params.get("audioCodec");
  if (audioCodec) {
    pubAudioCodecSelect.value = audioCodec;
  }

  const audioBitrate = params.get("audioBitrate");
  if (audioBitrate) {
    pubAudioBitrateInput.value = audioBitrate;
  }

  const videoCodec = params.get("videoCodec");
  if (videoCodec) {
    pubVideoCodecSelect.value = videoCodec;
  }

  const videoBitrate = params.get("videoBitrate");
  if (videoBitrate) {
    pubVideoBitrateInput.value = videoBitrate;
  }

  const videoFramerate = params.get("videoFramerate");
  if (videoFramerate) {
    pubVideoFramerateInput.value = videoFramerate;
  }

  const videoWidth = params.get("videoWidth");
  if (videoWidth) {
    pubVideoWidthInput.value = videoWidth;
  }

  const videoHeight = params.get("videoHeight");
  if (videoHeight) {
    pubVideoHeightInput.value = videoHeight;
  }

  const keyframeInterval = params.get("keyframeInterval");
  if (keyframeInterval) {
    pubKeyframeIntervalInput.value = keyframeInterval;
  }
}

// 現在の設定を query string に変換して URL を生成
function buildUrlWithSettings(): string {
  const params = new URLSearchParams();

  params.set("url", urlInput.value);

  if (certHashInput.value) {
    params.set("certHash", certHashInput.value);
  }

  params.set("audioCodec", pubAudioCodecSelect.value);
  params.set("audioBitrate", pubAudioBitrateInput.value);
  params.set("videoCodec", pubVideoCodecSelect.value);
  params.set("videoBitrate", pubVideoBitrateInput.value);
  params.set("videoFramerate", pubVideoFramerateInput.value);
  params.set("videoWidth", pubVideoWidthInput.value);
  params.set("videoHeight", pubVideoHeightInput.value);
  params.set("keyframeInterval", pubKeyframeIntervalInput.value);

  const baseUrl = window.location.origin + window.location.pathname;
  return `${baseUrl}?${params.toString()}`;
}

// URL コピー
copyUrlBtn.addEventListener("click", async () => {
  const url = buildUrlWithSettings();

  // 現在の URL を置き換える
  history.replaceState(null, "", url);

  await navigator.clipboard.writeText(url);

  copyUrlBtn.textContent = "Copied!";
  copyUrlBtn.classList.add("copied");
  setTimeout(() => {
    copyUrlBtn.textContent = "Copy URL";
    copyUrlBtn.classList.remove("copied");
  }, 2000);
});

// 初期化
async function initialize(): Promise<void> {
  loadSettingsFromUrl();
  await enumerateDevices();
  log("pub", "ready");
  log("sub", "ready");
}

void initialize();
