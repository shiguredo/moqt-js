/**
 * ビデオデコーダー用 DedicatedWorker
 */

// モジュールとして扱うための export
export {};

declare const self: DedicatedWorkerGlobalScope;

interface InitMessage {
  type: "init";
  config: VideoDecoderConfig;
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

interface ResetKeyframeWaitMessage {
  type: "resetKeyframeWait";
}

type WorkerMessage = InitMessage | DecodeMessage | CloseMessage | ResetKeyframeWaitMessage;

let videoDecoder: VideoDecoder | null = null;
// configure() 後、最初のキーフレームを受信するまでデルタフレームをスキップ
let needsKeyframe = true;

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      if (videoDecoder) {
        if (videoDecoder.state !== "closed") {
          videoDecoder.close();
        }
        videoDecoder = null;
      }

      // 新しいデコーダーはキーフレームを必要とする
      needsKeyframe = true;

      videoDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          // VideoFrame は transferable
          self.postMessage(
            {
              type: "decoded",
              frame,
            },
            [frame] as unknown as StructuredSerializeOptions,
          );
        },
        error: (error: DOMException) => {
          self.postMessage({
            type: "error",
            message: error.message,
          });
        },
      });

      videoDecoder.configure(message.config);

      self.postMessage({
        type: "configured",
      });
      break;
    }

    case "decode": {
      if (videoDecoder && videoDecoder.state === "configured") {
        // キーフレームが必要な状態でデルタフレームを受信した場合はスキップ
        if (needsKeyframe && message.chunkType !== "key") {
          self.postMessage({
            type: "skipped",
            reason: "waiting_for_keyframe",
          });
          break;
        }

        // キーフレームを受信したらフラグをリセット
        if (message.chunkType === "key") {
          needsKeyframe = false;
        }

        const chunk = new EncodedVideoChunk({
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
          data: message.data,
        });
        try {
          videoDecoder.decode(chunk);
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
      if (videoDecoder) {
        if (videoDecoder.state !== "closed") {
          videoDecoder.close();
        }
        videoDecoder = null;
      }
      break;
    }

    case "resetKeyframeWait": {
      needsKeyframe = true;
      break;
    }
  }
};
