export interface DummyVideoGenerator {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  stop: () => void;
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
  let animationId: number | null = null;

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

  // 初回描画
  drawFrame();

  // 指定フレームレートで更新
  const interval = Math.floor(1000 / framerate);
  animationId = window.setInterval(drawFrame, interval);

  // captureStream でストリーム取得
  const stream = canvas.captureStream(framerate);

  return {
    stream,
    canvas,
    stop: (): void => {
      if (animationId !== null) {
        clearInterval(animationId);
        animationId = null;
      }
    },
  };
}
