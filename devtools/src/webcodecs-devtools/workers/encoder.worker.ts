// エンコーダー用 DedicatedWorker

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
  type VideoEncoderWorkerEncodeRequest,
  type WorkerCloseRequest,
  type WorkerInitRequest,
} from "../../../../src/codec/workerMessages.ts";

type EncoderWorkerMessage =
  | WorkerInitRequest<VideoEncoderConfig>
  | VideoEncoderWorkerEncodeRequest
  | WorkerCloseRequest;

let encoder: VideoEncoder | null = null;

self.onmessage = (e: MessageEvent<EncoderWorkerMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init": {
      // 初期化は runWorkerInit() に委ねる。configure() の同期 throw は "error" 応答になり、
      // "configured" は送られない (Wrapper の configure() が reject してハングしない)。
      // message が空文字にならないよう、失敗理由の文言化も共有モジュールに任せる
      const result = runWorkerInit(() => {
        // 再 init では旧エンコーダーを閉じてから差し替える (閉じないと解放されない)
        encoder = replaceCodec(
          encoder,
          new VideoEncoder({
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
                { transfer: transferList },
              );
            },
            error: (error: DOMException) => {
              self.postMessage(workerErrorResponse(error));
            },
          }),
        );

        encoder.configure(message.config);
      });
      self.postMessage(result);
      break;
    }

    case "encode": {
      // encode() は同期的に throw することがある (throw は Worker の未処理の例外になり、
      // main 側は error イベントで知る)。throw しても VideoFrame の所有権はこの Worker に
      // あるため、try/finally で必ず閉じる (閉じないとフレームが解放されない)
      try {
        if (isCodecConfigured(encoder)) {
          encoder.encode(message.frame, { keyFrame: message.keyFrame });
        }
      } finally {
        message.frame.close();
      }
      break;
    }

    case "close": {
      closeCodecQuiet(encoder);
      encoder = null;
      break;
    }

    default:
      ignoreUnknownWorkerRequest(message);
  }
};
