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
