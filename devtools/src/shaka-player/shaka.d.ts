/**
 * shaka-player のコンパイル済み experimental build が公開する最小限の型。
 *
 * 上流は TypeScript の型定義を配布していないため、このアプリが使う API だけを
 * 明示する。ここに無い API を使うときは、上流の externs と実装を確認して追加する。
 */

export interface ShakaError {
  severity?: number;
  category?: number;
  code?: number;
  data?: unknown;
  message?: string;
}

export interface ShakaErrorEvent extends Event {
  detail: ShakaError;
}

export interface ShakaStats {
  width?: number;
  height?: number;
  currentCodecs?: string;
  streamBandwidth?: number;
  decodedFrames?: number;
  droppedFrames?: number;
  corruptedFrames?: number;
  stallsDetected?: number;
  estimatedBandwidth?: number;
  loadLatency?: number;
  timeToFirstFrame?: number;
  playTime?: number;
  bufferingTime?: number;
  liveLatency?: number;
}

export interface ShakaVariantTrack {
  active?: boolean;
  bandwidth?: number;
  codecs?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  language?: string;
  label?: string;
}

export interface ShakaMsfTrack {
  name?: string;
  role?: string;
  packaging?: string;
  codec?: string;
  [key: string]: unknown;
}

export interface ShakaMsfCatalog {
  tracks?: ShakaMsfTrack[];
  [key: string]: unknown;
}

export interface ShakaMsfConfig {
  fingerprintUri?: string;
  namespaces?: string[];
  authorizationToken?: string;
  version?: string;
  catalogPreprocessor?: (catalog: ShakaMsfCatalog) => void;
}

export interface ShakaPlayerConfig {
  manifest?: {
    msf?: ShakaMsfConfig;
  };
  mediaSource?: {
    transmuxWorkerUrl?: string;
  };
}

export interface ShakaPlayer {
  attach(video: HTMLVideoElement): Promise<void>;
  configure(config: ShakaPlayerConfig): void;
  load(uri: string, startTime: number | null, mimeType: string): Promise<void>;
  destroy(): Promise<void>;
  getStats(): ShakaStats;
  getVariantTracks(): ShakaVariantTrack[];
  addEventListener(type: "error", listener: (event: ShakaErrorEvent) => void): void;
}

export interface ShakaPlayerClass {
  new (): ShakaPlayer;
  version?: string;
}

export interface ShakaNamespace {
  Player: ShakaPlayerClass;
  polyfill: {
    installAll(): void;
  };
  config: {
    MsfVersion: Record<string, string>;
  };
}

declare global {
  interface Window {
    shaka?: ShakaNamespace;
  }
}
