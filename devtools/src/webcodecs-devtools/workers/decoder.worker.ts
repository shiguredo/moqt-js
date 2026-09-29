// デコーダー用 DedicatedWorker

// コーデックのライフサイクル (state 判定と閉じる前の確認) と初期化応答の契約は、
// ライブラリ側の Worker と同じ規則で動かす必要があるため共有モジュールを import する
import {
  closeCodecQuiet,
  isCodecConfigured,
  replaceCodec,
} from "../../../../src/codec/codecLifecycle.ts";
import { runWorkerInit, workerErrorResponse } from "../../../../src/codec/workerConfigure.ts";
// Wrapper とのメッセージの型はプロトコルの正本 (src/codec/workerMessages.ts) を使う
import {
  ignoreUnknownWorkerRequest,
  type VideoDecoderWorkerResetKeyframeWaitRequest,
  type WorkerCloseRequest,
  type WorkerDecodeRequest,
  type WorkerInitRequest,
} from "../../../../src/codec/workerMessages.ts";

type DecoderWorkerMessage =
  | WorkerInitRequest<VideoDecoderConfig>
  | WorkerDecodeRequest
  | WorkerCloseRequest
  | VideoDecoderWorkerResetKeyframeWaitRequest;

let decoder: VideoDecoder | null = null;
// configure() 後、最初のキーフレームを受信するまでデルタフレームをスキップ
let needsKeyframe = true;

self.onmessage = (e: MessageEvent<DecoderWorkerMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init": {
      // 初期化は runWorkerInit() に委ねる。configure() の同期 throw は "error" 応答になり、
      // "configured" は送られない (Wrapper の configure() が reject してハングしない)。
      // message が空文字にならないよう、失敗理由の文言化も共有モジュールに任せる
      const result = runWorkerInit(() => {
        decoder = replaceCodec(
          decoder,
          new VideoDecoder({
            output: (frame: VideoFrame) => {
              // VideoFrame は transferable
              self.postMessage(
                {
                  type: "decoded",
                  frame,
                },
                { transfer: [frame] },
              );
            },
            error: (error: DOMException) => {
              self.postMessage(workerErrorResponse(error));
            },
          }),
        );

        // 新しいデコーダーはキーフレームを必要とする
        needsKeyframe = true;

        decoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "decode": {
      if (isCodecConfigured(decoder)) {
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
          decoder.decode(chunk);
        } catch (error) {
          // decode() は同期的にエラーをスローすることがある
          self.postMessage(workerErrorResponse(error));
        }
      }
      break;
    }

    case "close": {
      closeCodecQuiet(decoder);
      decoder = null;
      break;
    }

    case "resetKeyframeWait": {
      // キーフレーム待ち状態にリセット
      needsKeyframe = true;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
