/**
 * オーディオデコーダー用 DedicatedWorker
 */

import { runWorkerInit, workerErrorResponse } from "../workerConfigure";
import { closeCodecQuiet, isCodecConfigured, replaceCodec } from "../codecLifecycle";
import {
  ignoreUnknownWorkerRequest,
  type WorkerCloseRequest,
  type WorkerDecodeRequest,
  type WorkerInitRequest,
} from "../workerMessages";

declare const self: DedicatedWorkerGlobalScope;

type AudioDecoderWorkerRequest =
  | WorkerInitRequest<AudioDecoderConfig>
  | WorkerDecodeRequest
  | WorkerCloseRequest;

let audioDecoder: AudioDecoder | null = null;

self.onmessage = (event: MessageEvent<AudioDecoderWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        // 再 init では旧コーデックを閉じてから差し替える (解放漏れを防ぐ)
        audioDecoder = replaceCodec(
          audioDecoder,
          new AudioDecoder({
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
              self.postMessage(workerErrorResponse(error));
            },
          }),
        );

        audioDecoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "decode": {
      if (isCodecConfigured(audioDecoder)) {
        const chunk = new EncodedAudioChunk({
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
          data: message.data,
        });
        try {
          audioDecoder.decode(chunk);
        } catch (error) {
          self.postMessage(workerErrorResponse(error));
        }
      }
      break;
    }

    case "close": {
      closeCodecQuiet(audioDecoder);
      audioDecoder = null;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
