/**
 * ビデオエンコーダー用 DedicatedWorker
 */

import { runWorkerInit, workerErrorResponse } from "../workerConfigure";
import { closeCodecQuiet, isCodecConfigured, replaceCodec } from "../codecLifecycle";
import {
  ignoreUnknownWorkerRequest,
  type VideoEncoderWorkerEncodeRequest,
  type WorkerCloseRequest,
  type WorkerInitRequest,
} from "../workerMessages";

declare const self: DedicatedWorkerGlobalScope;

type VideoEncoderWorkerRequest =
  | WorkerInitRequest<VideoEncoderConfig>
  | VideoEncoderWorkerEncodeRequest
  | WorkerCloseRequest;

let videoEncoder: VideoEncoder | null = null;

self.onmessage = (event: MessageEvent<VideoEncoderWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        // 再 init では旧コーデックを閉じてから差し替える (解放漏れを防ぐ)
        videoEncoder = replaceCodec(
          videoEncoder,
          new VideoEncoder({
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
              self.postMessage(workerErrorResponse(error));
            },
          }),
        );

        videoEncoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "encode": {
      if (isCodecConfigured(videoEncoder)) {
        videoEncoder.encode(message.frame, { keyFrame: message.keyFrame });
      }
      message.frame.close();
      break;
    }

    case "close": {
      closeCodecQuiet(videoEncoder);
      videoEncoder = null;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
