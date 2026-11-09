/** video 要素へ渡す映像トラックを作る。ブラウザー差はこの内部境界で吸収する。 */
export function createVideoTrackOutput(): {
  track: MediaStreamTrack;
  writer: WritableStreamDefaultWriter<VideoFrame>;
} {
  if (typeof MediaStreamTrackGenerator !== "undefined") {
    const track = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
    return { track, writer: track.writable.getWriter() };
  }

  // Safari の VideoTrackGenerator は DedicatedWorker 専用であり、メインスレッドの
  // MediaStreamTrackGenerator は存在しない。公開 API を変えず Canvas から track を作る。
  // Media Capture from DOM Elements §4 / §4.1 の captureStream(0) と requestFrame() を
  // 使い、表示待ちで選んだフレームだけを取り込む。仕様は草案であり将来変更され得る。
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const drawing = canvas.getContext("2d", { alpha: false });
  if (drawing === null) throw new Error("Canvas 2D context is unavailable for video output");
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  if (
    track === undefined ||
    !("requestFrame" in track) ||
    typeof track.requestFrame !== "function"
  ) {
    for (const candidate of stream.getTracks()) candidate.stop();
    throw new Error("Canvas video output requires a track with requestFrame()");
  }
  const requestFrame = (track as CanvasCaptureMediaStreamTrack).requestFrame.bind(track);
  const writer = new WritableStream<VideoFrame>({
    write(frame) {
      try {
        if (track.readyState !== "live") throw new Error("Video output track has ended");
        // 解像度変更時だけ backing store を更新する。毎フレームの再確保を避ける。
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        drawing.drawImage(frame, 0, 0, canvas.width, canvas.height);
        requestFrame();
      } finally {
        // Generator と同じく、受け取ったフレームの所有権は出力側へ移る。
        frame.close();
      }
    },
    close() {
      track.stop();
      canvas.width = 1;
      canvas.height = 1;
    },
    abort() {
      track.stop();
      canvas.width = 1;
      canvas.height = 1;
    },
  }).getWriter();
  return { track, writer };
}
