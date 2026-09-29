/**
 * WebCodecs の設定対応確認
 *
 * デコーダーを構成する前に「実ブラウザがその設定を復号できるか」を確かめる。
 * 判定規則は Wrapper (./VideoDecoder) と devtools のテストページで同一であるため、
 * ここを正本として 1 箇所に置く。
 *
 * 判定規則を 1 箇所に絞るのは、ブラウザ API の境界であり Node の単体テストで
 * 実物を駆動できないためである (置き換えた境界で規則だけを固定し、実ブラウザの
 * 経路は e2e で確認する)。
 */

/**
 * 映像デコーダーの設定が実ブラウザで復号に対応しているかを確かめる
 *
 * WebCodecs では `VideoDecoder.isConfigSupported()` が不正な設定に対して同期 throw
 * せず reject した Promise を返すため、false と reject の両方を非対応として扱う。
 * `supported` は省略され得るため、明示的に true のときだけ対応とみなす。
 *
 * WebCodecs 非搭載の環境は「非対応 codec」と区別できる文言で失敗させる。codec の
 * 非対応として報告すると、原因 (環境に WebCodecs が無い) を取り違えるためである。
 *
 * @param config - 確認する映像デコーダー設定
 * @returns 復号に対応している場合は true
 * @throws VideoDecoder が無い環境では Error (非対応 codec と区別する)
 */
export async function isVideoDecoderConfigSupported(config: VideoDecoderConfig): Promise<boolean> {
  // WebCodecs 非搭載の環境を先に判定する (非対応 codec と同じ扱いにしない)
  if (typeof VideoDecoder === "undefined") {
    throw new Error("VideoDecoder is not available in this environment");
  }
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    // reject は非対応として扱う (対応を確かめられない設定ではデコーダーを作らない)
    return false;
  }
}
