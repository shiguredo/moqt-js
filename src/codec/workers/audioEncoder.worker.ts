/**
 * オーディオエンコーダー用 DedicatedWorker
 */

import { runWorkerInit } from "../workerConfigure";

declare const self: DedicatedWorkerGlobalScope;

interface InitMessage {
  type: "init";
  config: AudioEncoderConfig;
}

interface EncodeMessage {
  type: "encode";
  data: AudioData;
}

interface CloseMessage {
  type: "close";
}

type AudioEncoderWorkerMessage = InitMessage | EncodeMessage | CloseMessage;

let audioEncoder: AudioEncoder | null = null;

self.onmessage = (event: MessageEvent<AudioEncoderWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        if (audioEncoder) {
          audioEncoder.close();
        }

        audioEncoder = new AudioEncoder({
          output: (chunk: EncodedAudioChunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);

            self.postMessage(
              {
                type: "encoded",
                data: data.buffer,
                chunkType: chunk.type,
                timestamp: chunk.timestamp,
                duration: chunk.duration,
              },
              [data.buffer] as unknown as StructuredSerializeOptions,
            );
          },
          error: (error: DOMException) => {
            self.postMessage({
              type: "error",
              message: error.message,
            });
          },
        });

        audioEncoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "encode": {
      if (audioEncoder && audioEncoder.state === "configured") {
        audioEncoder.encode(message.data);
      }
      message.data.close();
      break;
    }

    case "close": {
      if (audioEncoder) {
        audioEncoder.close();
        audioEncoder = null;
      }
      break;
    }
  }
};
