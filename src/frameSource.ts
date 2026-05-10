/**
 * VideoFrame ソースの抽象化
 *
 * MediaStreamTrackProcessor が利用可能な場合はそれを使い、
 * 利用できない場合は requestVideoFrameCallback でフォールバックする。
 *
 * Safari は MediaStreamTrackProcessor をメインスレッドで公開していないため、
 * requestVideoFrameCallback + VideoFrame コンストラクタで代替する。
 *
 * https://www.w3.org/TR/mediacapture-transform/#mediastreamtrackprocessor
 * https://wicg.github.io/video-rvfc/#dom-htmlvideoelement-requestvideoframecallback
 */

/**
 * VideoFrame の ReadableStream を生成するためのリソースをまとめた型
 */
export interface VideoFrameSource {
  readonly readable: ReadableStream<VideoFrame>;
  /**
   * リソースを解放する
   *
   * requestVideoFrameCallback フォールバック時に作成した HTMLVideoElement を破棄する
   */
  close(): void;
}

/**
 * MediaStreamTrackProcessor がメインスレッドで利用可能かどうかを判定する
 */
export function isMediaStreamTrackProcessorAvailable(): boolean {
  return typeof MediaStreamTrackProcessor !== "undefined";
}

/**
 * MediaStream のビデオトラックから VideoFrame を読み取る ReadableStream を作成する
 *
 * MediaStreamTrackProcessor が利用可能な場合はそれを使い、
 * 利用できない場合は requestVideoFrameCallback でフォールバックする。
 */
export function createVideoFrameSource(videoTrack: MediaStreamTrack): VideoFrameSource {
  if (isMediaStreamTrackProcessorAvailable()) {
    return createVideoFrameSourceWithProcessor(videoTrack);
  }
  return createVideoFrameSourceWithCallback(videoTrack);
}

/**
 * MediaStreamTrackProcessor を使った VideoFrameSource
 */
function createVideoFrameSourceWithProcessor(videoTrack: MediaStreamTrack): VideoFrameSource {
  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
  return {
    readable: processor.readable,
    close(): void {
      // MediaStreamTrackProcessor はトラック終了時に自動で閉じるため、明示的な破棄は不要
    },
  };
}

/**
 * requestVideoFrameCallback を使った VideoFrameSource フォールバック
 *
 * HTMLVideoElement に MediaStream を接続し、
 * requestVideoFrameCallback で VideoFrame を取得して ReadableStream に変換する。
 */
function createVideoFrameSourceWithCallback(videoTrack: MediaStreamTrack): VideoFrameSource {
  const video = document.createElement("video");
  // Safari で autoplay するために必要
  video.playsInline = true;
  video.muted = true;

  const stream = new MediaStream([videoTrack]);
  video.srcObject = stream;

  let stopped = false;
  let callbackId: number | null = null;

  const readable = new ReadableStream<VideoFrame>({
    start(controller): void {
      video.play().catch((error: unknown) => {
        controller.error(error);
      });

      function onFrame(): void {
        if (stopped) {
          controller.close();
          return;
        }

        try {
          // VideoFrame コンストラクタに HTMLVideoElement を渡して VideoFrame を取得する
          // https://www.w3.org/TR/webcodecs/#dom-videoframe-videoframe
          const frame = new VideoFrame(video, { timestamp: performance.now() * 1000 });
          controller.enqueue(frame);
        } catch {
          // video がまだ再生準備できていない場合などは無視して次のフレームを待つ
        }

        callbackId = video.requestVideoFrameCallback(onFrame);
      }

      callbackId = video.requestVideoFrameCallback(onFrame);
    },

    cancel(): void {
      stopped = true;
      if (callbackId !== null) {
        video.cancelVideoFrameCallback(callbackId);
        callbackId = null;
      }
      video.srcObject = null;
    },
  });

  return {
    readable,
    close(): void {
      stopped = true;
      if (callbackId !== null) {
        video.cancelVideoFrameCallback(callbackId);
        callbackId = null;
      }
      video.srcObject = null;
    },
  };
}
