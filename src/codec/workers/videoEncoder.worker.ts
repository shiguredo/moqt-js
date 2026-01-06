/**
 * ビデオエンコーダー用 DedicatedWorker
 */

// モジュールとして扱うための export
export {};

declare const self: DedicatedWorkerGlobalScope;

interface InitMessage {
  type: "init";
  config: VideoEncoderConfig;
}

interface EncodeMessage {
  type: "encode";
  frame: VideoFrame;
  keyFrame: boolean;
}

interface CloseMessage {
  type: "close";
}

type VideoEncoderWorkerMessage = InitMessage | EncodeMessage | CloseMessage;

let videoEncoder: VideoEncoder | null = null;

self.onmessage = (event: MessageEvent<VideoEncoderWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      if (videoEncoder) {
        videoEncoder.close();
      }

      videoEncoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);

          // metadata から description を取得
          let description: ArrayBuffer | undefined;
          if (metadata?.decoderConfig?.description) {
            const desc = metadata.decoderConfig.description;
            if (desc instanceof ArrayBuffer) {
              description = desc.slice(0);
            } else if (ArrayBuffer.isView(desc)) {
              description = desc.buffer.slice(
                desc.byteOffset,
                desc.byteOffset + desc.byteLength,
              ) as ArrayBuffer;
            }
          }

          const transferList: Transferable[] = [data.buffer];
          if (description) {
            transferList.push(description);
          }

          self.postMessage(
            {
              type: "encoded",
              data: data.buffer,
              chunkType: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration,
              description,
            },
            transferList as unknown as StructuredSerializeOptions,
          );
        },
        error: (error: DOMException) => {
          self.postMessage({
            type: "error",
            message: error.message,
          });
        },
      });

      videoEncoder.configure(message.config);

      self.postMessage({
        type: "configured",
      });
      break;
    }

    case "encode": {
      if (videoEncoder && videoEncoder.state === "configured") {
        videoEncoder.encode(message.frame, { keyFrame: message.keyFrame });
      }
      message.frame.close();
      break;
    }

    case "close": {
      if (videoEncoder) {
        videoEncoder.close();
        videoEncoder = null;
      }
      break;
    }
  }
};
