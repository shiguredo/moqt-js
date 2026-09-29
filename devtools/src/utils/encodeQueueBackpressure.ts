/**
 * 映像エンコードキューの上限と、上限を超えたフレームの破棄判定
 *
 * devtools の配信 (hooks/usePublisher.ts) は encodeQueueSize が上限以下のときだけフレームを
 * 投入し、超えたフレームは待たずに破棄する。上限と判定をここに 1 箇所だけ置き、破棄の数を
 * 数える経路 (utils/publishTimingStats.ts の recordEncodeQueueDrop) と分けて検証できるようにする。
 *
 * Worker モードの encodeQueueSize は Worker へ送信してまだ encoded 応答が返っていない
 * フレーム数を返すため (devtools/src/utils/EncoderWrapper.ts)、実際のキュー長より多く見える
 * 安全側の近似になる。
 */

/**
 * 映像エンコードキューの上限 (この値を超えたフレームを破棄する)
 *
 * ライブラリの配信側 (src/createMediaPublisher.ts の processVideoFrames) と同じ値を使う。
 * 値を変えるときは両方を合わせる。ライブラリ側が上限を公開する定数を持てば、この値は
 * 削除してその定数を使う (それまでは同じ値の二重管理であり、ずれは
 * utils/encodeQueueBackpressure.test.ts が固定した 2 との比較で検出する)。
 */
export const MAX_VIDEO_ENCODE_QUEUE_SIZE = 2;

/**
 * キューが上限を超えたフレームを破棄すべきかを判定する
 *
 * 上限ちょうどまでは投入する (超過分だけを破棄する)。
 */
export function shouldDropFrame(encodeQueueSize: number): boolean {
  return encodeQueueSize > MAX_VIDEO_ENCODE_QUEUE_SIZE;
}
