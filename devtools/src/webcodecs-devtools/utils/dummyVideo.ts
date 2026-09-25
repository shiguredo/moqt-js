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

/**
 * 中央に出す経過時間
 *
 * Sora-DevTools のフェイク映像と同じ `mmmm:ss.SSS` (分は 4 桁)。
 */
export function formatDummyElapsed(elapsedMs: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedMs));
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const milliseconds = elapsed % 1000;
  return `${minutes.toString().padStart(4, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}

/**
 * 上部に出す開始日時
 *
 * Sora-DevTools のフェイク映像と同じ、ローカルの `YYYY-MM-DD HH:mm:ss`。
 */
export function formatDummyStartDateTime(date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 中央の経過時間のフォントサイズ
 *
 * 短い辺の 15%。`0000:00.000` (11 文字) より長いときは、幅に収まるよう縮める。
 */
export function dummyCenterFontSize(width: number, height: number, textLength: number): number {
  const baseSize = Math.min(width, height) * 0.15;
  const maxChars = 11;
  if (textLength > maxChars) {
    return baseSize * (maxChars / textLength);
  }
  return baseSize;
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

  let timerId: number | null = null;
  let stopped = false;
  const startedAtMs = Date.now();
  const startDateTime = formatDummyStartDateTime(new Date(startedAtMs));
  const baseHue = Math.floor(Math.random() * 360);
  let hue = baseHue;
  let animationPhase = 0;

  function drawFrame(): void {
    if (!ctx) {
      return;
    }

    // Sora-DevTools のフェイク映像と同じグラデーション。彩度と明度を少し振動させ、
    // 色相は選んだ基準から ±10 度の範囲で動かす
    const saturation = 70 + Math.sin(animationPhase * 0.7) * 5;
    const lightness1 = 50 + Math.sin(animationPhase * 0.5) * 5;
    const lightness2 = 40 + Math.sin(animationPhase * 0.5) * 5;

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${String(hue)}, ${String(saturation)}%, ${String(lightness1)}%)`);
    gradient.addColorStop(
      1,
      `hsl(${String(hue + 15)}, ${String(saturation)}%, ${String(lightness2)}%)`,
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const dateSize = Math.min(canvas.width, canvas.height) * 0.05;
    ctx.fillStyle = "white";
    ctx.font = `${String(dateSize)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(startDateTime, canvas.width / 2, canvas.height * 0.05);

    const elapsedText = formatDummyElapsed(Date.now() - startedAtMs);
    const fontSize = dummyCenterFontSize(canvas.width, canvas.height, elapsedText.length);
    ctx.font = `bold ${String(fontSize)}px monospace`;
    ctx.textBaseline = "middle";
    ctx.fillText(elapsedText, canvas.width / 2, canvas.height / 2);

    const infoSize = Math.min(canvas.width, canvas.height) * 0.04;
    ctx.font = `${String(infoSize)}px monospace`;
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `${String(width)}x${String(height)} @ ${String(framerate)}fps`,
      canvas.width / 2,
      canvas.height * 0.95,
    );

    animationPhase += 0.02;
    hue = baseHue + Math.sin(animationPhase) * 10;
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
