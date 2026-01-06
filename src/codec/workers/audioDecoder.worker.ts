/**
 * オーディオデコーダー用 DedicatedWorker
 */

// モジュールとして扱うための export
export {};

declare const self: DedicatedWorkerGlobalScope;

interface InitMessage {
  type: "init";
  config: AudioDecoderConfig;
}

interface DecodeMessage {
  type: "decode";
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number;
}

interface CloseMessage {
  type: "close";
}

type AudioDecoderWorkerMessage = InitMessage | DecodeMessage | CloseMessage;

let audioDecoder: AudioDecoder | null = null;

self.onmessage = (event: MessageEvent<AudioDecoderWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      if (audioDecoder) {
        if (audioDecoder.state !== "closed") {
          audioDecoder.close();
        }
        audioDecoder = null;
      }

      audioDecoder = new AudioDecoder({
        output: (audioData: AudioData) => {
          // AudioData は transferable
          self.postMessage(
            {
              type: "decoded",
              data: audioData,
            },
            [audioData] as unknown as StructuredSerializeOptions,
          );
        },
        error: (error: DOMException) => {
          self.postMessage({
            type: "error",
            message: error.message,
          });
        },
      });

      audioDecoder.configure(message.config);

      self.postMessage({
        type: "configured",
      });
      break;
    }

    case "decode": {
      if (audioDecoder && audioDecoder.state === "configured") {
        const chunk = new EncodedAudioChunk({
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
          data: message.data,
        });
        try {
          audioDecoder.decode(chunk);
        } catch (error) {
          self.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      break;
    }

    case "close": {
      if (audioDecoder) {
        if (audioDecoder.state !== "closed") {
          audioDecoder.close();
        }
        audioDecoder = null;
      }
      break;
    }
  }
};
