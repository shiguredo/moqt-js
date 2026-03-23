/// <reference types="vite/client" />

// CSS import の型宣言
declare module "*.css" {}

// Vite Worker import の型宣言
declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

// MediaStreamTrackProcessor の型宣言
// https://w3c.github.io/mediacapture-transform/#mediastreamtrackprocessor
interface MediaStreamTrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}

declare const MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (init: { track: MediaStreamTrack }): MediaStreamTrackProcessor;
};

// WebTransportSendStream の型宣言
type WebTransportSendStream = WritableStream<Uint8Array>;
