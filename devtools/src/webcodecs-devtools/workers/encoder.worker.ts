// エンコーダー用 DedicatedWorker

interface EncoderInitMessage {
  type: "init";
  config: VideoEncoderConfig;
}

interface EncoderEncodeMessage {
  type: "encode";
  frame: VideoFrame;
  keyFrame: boolean;
}

interface EncoderCloseMessage {
  type: "close";
}

type EncoderWorkerMessage = EncoderInitMessage | EncoderEncodeMessage | EncoderCloseMessage;

let encoder: VideoEncoder | null = null;

self.onmessage = (e: MessageEvent<EncoderWorkerMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init": {
      if (encoder) {
        encoder.close();
      }

      encoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          // EncodedVideoChunk のデータをコピーして転送
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

          const transferList: Transferable[] = [data.buffer as ArrayBuffer];
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
            { transfer: transferList },
          );
        },
        error: (error: DOMException) => {
          self.postMessage({
            type: "error",
            message: error.message,
          });
        },
      });

      encoder.configure(message.config);

      self.postMessage({
        type: "configured",
      });
      break;
    }

    case "encode": {
      if (encoder && encoder.state === "configured") {
        encoder.encode(message.frame, { keyFrame: message.keyFrame });
      }
      message.frame.close();
      break;
    }

    case "close": {
      if (encoder) {
        encoder.close();
        encoder = null;
      }
      break;
    }
  }
};
