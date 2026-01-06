// デコーダー用 DedicatedWorker

interface InitMessage {
  type: "init";
  config: VideoDecoderConfig;
}

interface DecodeMessage {
  type: "decode";
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number;
}

interface CloseMessage {
  type: "close";
}

interface ResetKeyframeWaitMessage {
  type: "resetKeyframeWait";
}

type WorkerMessage = InitMessage | DecodeMessage | CloseMessage | ResetKeyframeWaitMessage;

let decoder: VideoDecoder | null = null;
// configure() 後、最初のキーフレームを受信するまでデルタフレームをスキップ
let needsKeyframe = true;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init": {
      if (decoder) {
        // エラー状態では既に closed になっているのでチェック
        if (decoder.state !== "closed") {
          decoder.close();
        }
        decoder = null;
      }

      // 新しいデコーダーはキーフレームを必要とする
      needsKeyframe = true;

      decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          // VideoFrame は transferable
          self.postMessage(
            {
              type: "decoded",
              frame,
            },
            [frame],
          );
        },
        error: (error: DOMException) => {
          self.postMessage({
            type: "error",
            message: error.message,
          });
        },
      });

      decoder.configure(message.config);

      self.postMessage({
        type: "configured",
      });
      break;
    }

    case "decode": {
      if (decoder && decoder.state === "configured") {
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
          self.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      break;
    }

    case "close": {
      if (decoder) {
        // エラー状態では既に closed になっているのでチェック
        if (decoder.state !== "closed") {
          decoder.close();
        }
        decoder = null;
      }
      break;
    }

    case "resetKeyframeWait": {
      // キーフレーム待ち状態にリセット
      needsKeyframe = true;
      break;
    }
  }
};
