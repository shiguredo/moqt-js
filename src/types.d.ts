/**
 * Worker 用型宣言
 */
/**
 * DedicatedWorkerGlobalScope
 *
 * lib.dom には Worker の global scope が含まれない (lib.webworker 側) ため、
 * Worker 実装が使う最小限のメンバーだけを宣言する。
 * lib.webworker を lib に加えると DOM の宣言と衝突するため採用しない。
 * `self` の型は各 Worker ファイルが `declare const self: DedicatedWorkerGlobalScope;`
 * で宣言する (グローバルに宣言すると lib.dom の self と衝突する)。
 */
interface DedicatedWorkerGlobalScope {
  onmessage: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
  onmessageerror: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  close(): void;
}

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

/**
 * WebTransport の datagram 送信 API (現行仕様) の型定義
 *
 * TypeScript 7.0.2 の lib.dom は旧 API の `datagrams.writable` だけを宣言しており、
 * 現行仕様の `createWritable()` が無い。WebKit (Safari) は `writable` を廃止して
 * `createWritable()` だけを実装しており、Chrome はその逆である。ライブラリは
 * どちらでも datagram を送れるようにするため、宣言を補う。
 *
 * `createWritable()` を持たない実装では undefined になるため optional にする。
 * TypeScript の lib.dom が `createWritable()` を宣言したら、この宣言は削除すること。
 *
 * https://w3c.github.io/webtransport/#webtransportdatagramduplexstream
 */
interface WebTransportDatagramDuplexStream {
  /**
   * datagram 送信用の WritableStream を作る (現行仕様 §5.2)
   *
   * 旧 API の `writable` を持たない実装 (WebKit) はこれを提供する。
   * 両方を持つ実装ではどちらを使っても同じ送信キューに入る。
   */
  createWritable?(): WritableStream<Uint8Array>;
}

/**
 * HTMLVideoElement.requestVideoFrameCallback の型定義
 *
 * MediaStreamTrackProcessor が利用できないブラウザ (Safari) で
 * VideoFrame を取得するためのフォールバックとして使用する。
 *
 * https://wicg.github.io/video-rvfc/#dom-htmlvideoelement-requestvideoframecallback
 */
interface HTMLVideoElement {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}

interface VideoFrameCallbackMetadata {
  presentationTime: DOMHighResTimeStamp;
  expectedDisplayTime: DOMHighResTimeStamp;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
  captureTime?: DOMHighResTimeStamp;
  receiveTime?: DOMHighResTimeStamp;
  rtpTimestamp?: number;
}
declare module "*?worker&url" {
  const url: string;
  export default url;
}
