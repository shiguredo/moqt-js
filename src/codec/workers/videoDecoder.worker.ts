/**
 * ビデオデコーダー用 DedicatedWorker
 */

import { runWorkerInit, workerErrorResponse } from "../workerConfigure";
import { closeCodecQuiet, isCodecConfigured, replaceCodec } from "../codecLifecycle";
import {
  ignoreUnknownWorkerRequest,
  type VideoDecoderWorkerResetKeyframeWaitRequest,
  type WorkerCloseRequest,
  type WorkerDecodeRequest,
  type WorkerInitRequest,
} from "../workerMessages";

declare const self: DedicatedWorkerGlobalScope;

type VideoDecoderWorkerRequest =
  | WorkerInitRequest<VideoDecoderConfig>
  | WorkerDecodeRequest
  | WorkerCloseRequest
  | VideoDecoderWorkerResetKeyframeWaitRequest;

let videoDecoder: VideoDecoder | null = null;
// configure() 後、最初のキーフレームを受信するまでデルタフレームをスキップ
let needsKeyframe = true;

self.onmessage = (event: MessageEvent<VideoDecoderWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      // 初期化失敗時は "error" で応答し "configured" を送らない
      // (Wrapper の configure() が reject してハングしない前提)
      const result = runWorkerInit(() => {
        // 再 init では旧コーデックを閉じてから差し替える (解放漏れを防ぐ)
        videoDecoder = replaceCodec(
          videoDecoder,
          new VideoDecoder({
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
              self.postMessage(workerErrorResponse(error));
            },
          }),
        );

        // 新しいデコーダーはキーフレームを必要とする
        needsKeyframe = true;

        videoDecoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "decode": {
      if (isCodecConfigured(videoDecoder)) {
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
          self.postMessage(workerErrorResponse(error));
        }
      }
      break;
    }

    case "close": {
      closeCodecQuiet(videoDecoder);
      videoDecoder = null;
      break;
    }

    case "resetKeyframeWait": {
      needsKeyframe = true;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
