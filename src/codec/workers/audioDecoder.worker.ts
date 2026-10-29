/**
 * オーディオデコーダー用 DedicatedWorker
 */

import { runWorkerInit, workerErrorResponse } from "../workerConfigure";
import { closeCodecQuiet, isCodecConfigured, replaceCodec } from "../codecLifecycle";
import { OpusDecoderTimestamps } from "../opusDecoderTimestamps";
import {
  ignoreUnknownWorkerRequest,
  type WorkerCloseRequest,
  type AudioDecoderWorkerDecodeRequest,
  type WorkerInitRequest,
} from "../workerMessages";

declare const self: DedicatedWorkerGlobalScope;

type AudioDecoderWorkerRequest =
  | WorkerInitRequest<AudioDecoderConfig>
  | AudioDecoderWorkerDecodeRequest
  | WorkerCloseRequest;

let audioDecoder: AudioDecoder | null = null;
let timestamps = new OpusDecoderTimestamps(false);

self.onmessage = (event: MessageEvent<AudioDecoderWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        const generationTimestamps = new OpusDecoderTimestamps(
          message.config.codec === "opus" && message.config.description === undefined,
        );
        timestamps = generationTimestamps;
        // 再 init では旧コーデックを閉じてから差し替える (解放漏れを防ぐ)
        audioDecoder = replaceCodec(
          audioDecoder,
          new AudioDecoder({
            output: (audioData: AudioData) => {
              const restored = generationTimestamps.restore(audioData);
              // AudioData は transferable
              self.postMessage(
                {
                  type: "decoded",
                  data: restored,
                },
                [restored] as unknown as StructuredSerializeOptions,
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
          timestamp: message.timestamp ?? 0,
          duration: message.duration,
          data: message.data,
        });
        try {
          timestamps.submit(message.timestamp);
          audioDecoder.decode(chunk);
        } catch (error) {
          timestamps.rejectLast();
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
