/**
 * Worker 用型宣言
 */
interface DedicatedWorkerGlobalScope extends WorkerGlobalScope {
  onmessage: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
  onmessageerror: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  close(): void;
}

declare const self: DedicatedWorkerGlobalScope;

/**
 * Vite Worker インポート用型宣言
 */
declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

/**
 * VideoEncoderConfig の拡張（H.265/HEVC サポート）
 * TypeScript の組み込み型には hevc プロパティが含まれていない
 */
interface VideoEncoderConfig {
  hevc?: {
    format?: "annexb" | "hevc";
  };
}

/**
 * WebCodecs Insertable Streams API
 * MediaStreamTrackProcessor と MediaStreamTrackGenerator の型定義
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}

interface MediaStreamTrackGeneratorInit {
  kind: "video" | "audio";
}

declare class MediaStreamTrackGenerator<T extends VideoFrame | AudioData> extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<T>;
}
