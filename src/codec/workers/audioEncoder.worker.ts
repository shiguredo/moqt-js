/**
 * オーディオエンコーダー用 DedicatedWorker
 */

import { runWorkerInit, workerErrorResponse } from "../workerConfigure";
import { closeCodecQuiet, isCodecConfigured, replaceCodec } from "../codecLifecycle";
import {
  ignoreUnknownWorkerRequest,
  type AudioEncoderWorkerEncodeRequest,
  type WorkerCloseRequest,
  type WorkerInitRequest,
} from "../workerMessages";

declare const self: DedicatedWorkerGlobalScope;

type AudioEncoderWorkerRequest =
  | WorkerInitRequest<AudioEncoderConfig>
  | AudioEncoderWorkerEncodeRequest
  | WorkerCloseRequest;

let audioEncoder: AudioEncoder | null = null;

self.onmessage = (event: MessageEvent<AudioEncoderWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        // 再 init では旧コーデックを閉じてから差し替える (解放漏れを防ぐ)
        audioEncoder = replaceCodec(
          audioEncoder,
          new AudioEncoder({
            output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);

              // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
              // AAC は decoderConfig.description (AudioSpecificConfig) を必要とする。
              // 映像と同じく、metadata に現れたときだけ運ぶ。
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

        audioEncoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "encode": {
      if (isCodecConfigured(audioEncoder)) {
        audioEncoder.encode(message.data);
      }
      message.data.close();
      break;
    }

    case "close": {
      closeCodecQuiet(audioEncoder);
      audioEncoder = null;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
