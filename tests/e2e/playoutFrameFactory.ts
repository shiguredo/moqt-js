/**
 * 実ブラウザの VideoFrame を作る共通ヘルパー
 *
 * moqt-js の E2E は、復号の出力と同じ形の I420 のフレームを実ブラウザで作って渡す。
 * 同じ組み立てを複数のスペックへ書き写さないよう、このモジュールに置く。スペックは
 * `page.evaluate` の中でこのモジュールを動的 import する (dev サーバーが配信する)。
 */

/** I420 のフレームの既定の幅 (px) */
const DEFAULT_WIDTH = 64;

/** I420 のフレームの既定の高さ (px) */
const DEFAULT_HEIGHT = 64;

/**
 * 復号の出力と同じ形の I420 のフレームを作る
 *
 * @param timestamp - フレームの TIMESTAMP (マイクロ秒)
 * @param width - 幅 (px)。偶数
 * @param height - 高さ (px)。偶数
 * @returns 実ブラウザの VideoFrame
 */
export function createI420Frame(
  timestamp: number,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
): VideoFrame {
  const luma = new Uint8Array(width * height).fill(128);
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);
  const data = new Uint8Array(luma.length + chroma.length + chroma.length);
  data.set(luma, 0);
  data.set(chroma, luma.length);
  data.set(chroma, luma.length + chroma.length);
  return new VideoFrame(data, {
    format: "I420",
    codedWidth: width,
    codedHeight: height,
    timestamp,
  });
}

/**
 * フレームが閉じているかを返す
 *
 * 閉じた VideoFrame の clone は実ブラウザで InvalidStateError になる。この失敗で
 * 「入口がフレームを閉じた」ことを確かめる (閉じていないときは clone を閉じて捨てる)。
 *
 * @param frame - 調べるフレーム
 * @returns 閉じていれば true
 */
export function isFrameClosed(frame: VideoFrame): boolean {
  try {
    const clone = frame.clone();
    clone.close();
    return false;
  } catch {
    return true;
  }
}
