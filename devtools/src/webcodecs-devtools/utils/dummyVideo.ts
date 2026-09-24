export interface DummyVideoGenerator {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  stop: () => void;
}

/** 次に描くフレーム */
export interface NextDummyFrame {
  /** 次に描くフレームの番号 (最初に描いたフレームを 0 とする) */
  readonly frameIndex: number;
  /** 次に描くまで待つ時間 (ミリ秒) */
  readonly delayMs: number;
}

/**
 * 次に描くフレームの番号と、描くまで待つ時間を決める
 *
 * フレーム n を描く時刻は「最初のフレームを描いた時刻 + n × フレーム間隔」とする。
 * 描いた時刻からフレーム間隔だけ待つと、タイマーの遅れと、フレーム間隔を整数の
 * ミリ秒に丸めた誤差が積み上がり、平均の周期が設定からずれる。周期が取り出す側
 * (canvas の captureStream や encoder) の周期とずれると、ずれが 1 フレーム分に
 * 積み上がるたびにフレームが抜ける。
 *
 * 次のフレームの時刻を 1 周期以上過ぎていたら (タブが裏に回った、main thread が
 * 止まったなど)、過ぎたフレームをまとめて描かずに飛ばし、まだ来ていない最初の
 * フレームを次に描く。1 周期未満の遅れは待たずに描いて追いつく。
 *
 * @param startMs - 最初のフレーム (番号 0) を描いた時刻 (`performance.now()`)
 * @param frameIntervalMs - フレーム間隔 (1000 / framerate ミリ秒)
 * @param drawnFrameIndex - 描いたフレームの番号
 * @param nowMs - 現在の時刻 (`performance.now()`)
 */
export function nextDummyFrame(
  startMs: number,
  frameIntervalMs: number,
  drawnFrameIndex: number,
  nowMs: number,
): NextDummyFrame {
  let frameIndex = drawnFrameIndex + 1;
  if (nowMs - (startMs + frameIndex * frameIntervalMs) >= frameIntervalMs) {
    frameIndex = Math.floor((nowMs - startMs) / frameIntervalMs) + 1;
  }
  return {
    frameIndex,
    delayMs: Math.max(0, startMs + frameIndex * frameIntervalMs - nowMs),
  };
}

/** canvas の captureStream のトラックが requestFrame で 1 枚ずつ取り出せるか */
function isCanvasCaptureTrack(
  track: MediaStreamTrack | undefined,
): track is CanvasCaptureMediaStreamTrack {
  return track !== undefined && "requestFrame" in track;
}

export function createDummyVideoStream(
  width: number,
  height: number,
  framerate: number,
): DummyVideoGenerator {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }

  let counter = 0;
  const startTime = Date.now();
  const baseHue = Math.floor(Math.random() * 360);
  let animationPhase = 0;
  let timerId: number | null = null;
  let stopped = false;

  function drawFrame(): void {
    if (!ctx) {
      return;
    }

    // 背景をグラデーションで描画
    const saturation = 70 + Math.sin(animationPhase * 0.7) * 5;
    const lightness1 = 50 + Math.sin(animationPhase * 0.5) * 5;
    const lightness2 = 40 + Math.sin(animationPhase * 0.5) * 5;
    const hue = baseHue + Math.sin(animationPhase) * 10;

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${String(hue)}, ${String(saturation)}%, ${String(lightness1)}%)`);
    gradient.addColorStop(
      1,
      `hsl(${String(hue + 15)}, ${String(saturation)}%, ${String(lightness2)}%)`,
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // タイトル
    ctx.fillStyle = "white";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("WebCodecs DevTools", canvas.width / 2, 20);

    // カウンターを中央に大きく表示
    ctx.font = "bold 64px monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(counter.toString(), canvas.width / 2, canvas.height / 2);

    // 経過時間を下部に表示
    const elapsed = Date.now() - startTime;
    ctx.font = "bold 48px monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${String(elapsed)} ms`, canvas.width / 2, canvas.height - 50);

    // 解像度表示
    ctx.font = "18px Arial";
    ctx.fillText(
      `${String(width)}x${String(height)} @ ${String(framerate)}fps`,
      canvas.width / 2,
      canvas.height - 20,
    );

    // アニメーションフェーズを進める
    animationPhase += 0.02;
    counter++;
  }

  // 描いたフレームを 1 枚ずつ取り出す。captureStream(framerate) の自動の取り出しに
  // 任せると、描く周期と取り出す周期のずれが 1 フレーム分に積み上がるたびに、描いた
  // フレームが取り出されずに抜ける。0 を渡して自動の取り出しを止め、描くたびに
  // requestFrame で取り出す
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  if (!isCanvasCaptureTrack(track)) {
    throw new Error("canvas capture track does not support requestFrame");
  }
  const drawAndCapture = (): void => {
    drawFrame();
    track.requestFrame();
  };

  // 描く時刻は最初のフレームからの経過で決め、平均の周期を framerate に合わせる
  // (nextDummyFrame)
  const frameIntervalMs = 1000 / framerate;
  const startMs = performance.now();
  let frameIndex = 0;
  const scheduleNextFrame = (): void => {
    const next = nextDummyFrame(startMs, frameIntervalMs, frameIndex, performance.now());
    frameIndex = next.frameIndex;
    timerId = window.setTimeout(() => {
      timerId = null;
      if (stopped) {
        return;
      }
      drawAndCapture();
      scheduleNextFrame();
    }, next.delayMs);
  };
  drawAndCapture();
  scheduleNextFrame();

  return {
    stream,
    canvas,
    stop: (): void => {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}
