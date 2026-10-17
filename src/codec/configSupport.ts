/**
 * WebCodecs の設定対応確認
 *
 * コーデックを構成する前に「実ブラウザがその設定を復号 / 符号化できるか」を確かめる。
 * 映像デコーダーの判定規則は Wrapper (./VideoDecoder) と devtools のテストページが同じ
 * 関数を使う。音声エンコーダーの判定規則は高レベル API (createMediaPublisher) と devtools の
 * Publisher が使う。
 *
 * 判定規則を 1 箇所に絞るのは、ブラウザ API の境界であり Node の単体テストで
 * 実物を駆動できないためである (置き換えた境界で規則だけを固定し、実ブラウザの
 * 経路は e2e で確認する)。
 */

import { closeCodecQuiet } from "./codecLifecycle";

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

/**
 * 音声エンコーダーの設定が実ブラウザで符号化に対応しているかを確かめる
 *
 * WebCodecs では `AudioEncoder.isConfigSupported()` が不正な設定に対して同期 throw
 * せず reject した Promise を返すため、false と reject の両方を非対応として扱う。
 * `supported` は省略され得るため、明示的に true のときだけ対応とみなす。
 *
 * `AudioEncoder.configure()` は未対応の設定でも同期の例外を投げず、非同期のエラー
 * コールバックで知らせる。Catalog を送る前に確かめないと、音声の object が届かない
 * トラックを宣言した catalog が購読側へ渡る。
 *
 * WebCodecs 非搭載の環境は「非対応 codec」と区別できる文言で失敗させる。codec の
 * 非対応として報告すると、原因 (環境に WebCodecs が無い) を取り違えるためである。
 *
 * @param config - 確認する音声エンコーダー設定
 * @returns 符号化に対応している場合は true
 * @throws AudioEncoder が無い環境では Error (非対応 codec と区別する)
 */
export async function isAudioEncoderConfigSupported(config: AudioEncoderConfig): Promise<boolean> {
  // WebCodecs 非搭載の環境を先に判定する (非対応 codec と同じ扱いにしない)
  if (typeof AudioEncoder === "undefined") {
    throw new Error("AudioEncoder is not available in this environment");
  }
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    // reject は非対応として扱う (対応を確かめられない設定ではエンコーダーを構成しない)
    return false;
  }
}

/**
 * 音声エンコーダー設定の実符号化確認の結果
 */
export interface AudioEncoderProbeResult {
  /** 実際に 1 チャンク以上を符号化できたか */
  readonly supported: boolean;
  /** 符号化できなかった理由 (supported が false のときだけ設定する) */
  readonly reason?: string;
}

/**
 * 実符号化確認の待ち上限 (ミリ秒)
 *
 * `isConfigSupported` が true を返しても、実際の符号化は非同期のエラー
 * コールバックで失敗し得る (Chrome 155 の AAC は 48 kHz ステレオ 64000 bps を
 * 「対応」と報告するが、実際の符号化は EncodingError になる。実測)。そのため
 * 実際に 1 フレーム符号化して出力が得られるまで待つ。健全なエンコーダーは
 * flush まで数ミリ秒で解決するため、2 秒は失敗の確定を待つ余裕である
 */
export const AUDIO_ENCODER_PROBE_TIMEOUT_MS = 2_000;

/**
 * 実符号化確認で投入する音声の長さ (秒)
 *
 * AAC は 1024 サンプル単位で符号化するため、1 フレーム分 (48 kHz で約 21 ms)
 * より長くないと flush するまで出力が得られない実装がある。Opus の 20 ms
 * フレームの整数倍でもある 100 ms にする (devtools の codec テストが使う長さと
 * 同じ)
 */
const AUDIO_ENCODER_PROBE_SECONDS = 0.1;

/**
 * 例外から表示用の理由を取り出す
 *
 * WebCodecs の DOMException には message が空のものがあるため、その場合は
 * name へ落として理由が空にならないようにする。
 */
function describeProbeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { message, name } = error as { message?: unknown; name?: unknown };
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  }
  return String(error);
}

/**
 * 待ち上限まで待つ
 */
function waitForProbeTimeout(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

/**
 * 確認用の無音の AudioData を作る
 */
function createProbeAudioData(
  sampleRate: number,
  numberOfChannels: number,
  timestamp: number,
): AudioData {
  const numberOfFrames = Math.max(1, Math.round(sampleRate * AUDIO_ENCODER_PROBE_SECONDS));
  // f32-planar はチャンネルごとに numberOfFrames 個の Float32 を並べる。
  // ゼロ埋めのままなので符号化対象としては無音になる (符号化の成否だけを見る)
  const samples = new Float32Array(numberOfFrames * numberOfChannels);
  return new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames,
    numberOfChannels,
    timestamp,
    data: samples,
  });
}

/**
 * 音声エンコーダー設定が実ブラウザで本当に符号化できるかを確かめる
 *
 * `isAudioEncoderConfigSupported` は対応の申告だけを見るため、実際には
 * 符号化できない設定を通し得る。とくに AAC は、プラットフォームのエンコーダーが
 * 対応するサンプルレート (44100 / 48000 Hz) とビットレートの下限を持ち、
 * 範囲外では configure が成功したうえで最初の encode が非同期のエラーになる
 * (Chrome 155 の macOS で実測。48 kHz ステレオの 64000 bps は
 * isConfigSupported が true を返すが EncodingError になる)。
 *
 * そこで、確認用の無音を 1 チャンク符号化し、エラーが確定せず出力チャンクが
 * 得られたときだけ対応とみなす。待ち上限まで出力が無い場合も非対応として扱う
 * (出力が得られない設定を catalog に載せると、購読側は Object が来ないまま待つ)。
 *
 * 確認用のエンコーダーは必ず閉じる。AAC の符号化失敗を短時間に繰り返すと
 * Chromium の GPU プロセスが落ちることを実測している (エンコーダーを握り続けると
 * 悪化する)。probe は reject しない (失敗は supported: false と reason で返す)。
 *
 * @param config - 確認する音声エンコーダー設定
 * @param timeoutMs - 出力を待つ上限 (ミリ秒)
 * @returns 実際に符号化できたか。できなかった場合は理由
 * @throws AudioEncoder が無い環境では Error (非対応 codec と区別する)
 */
export async function probeAudioEncoderConfig(
  config: AudioEncoderConfig,
  timeoutMs: number = AUDIO_ENCODER_PROBE_TIMEOUT_MS,
): Promise<AudioEncoderProbeResult> {
  // 対応の申告で確実に落ちる設定を先に弾く (エンコーダーを作らない)
  if (!(await isAudioEncoderConfigSupported(config))) {
    return { supported: false, reason: "isConfigSupported returned unsupported" };
  }

  let outputChunkCount = 0;
  // エラーコールバックは同じ原因で連鎖し得るため、最初の理由だけを残す
  let failureReason: string | null = null;
  let encoder: AudioEncoder;
  try {
    encoder = new AudioEncoder({
      output: () => {
        outputChunkCount += 1;
      },
      error: (error: DOMException) => {
        failureReason ??= describeProbeError(error);
      },
    });
  } catch (error) {
    // コンストラクタの失敗も「この設定では符号化できない」として扱う
    return { supported: false, reason: describeProbeError(error) };
  }

  try {
    try {
      encoder.configure(config);
    } catch (error) {
      return { supported: false, reason: describeProbeError(error) };
    }

    const sampleRate = config.sampleRate ?? 48000;
    const numberOfChannels = config.numberOfChannels ?? 1;
    const audioData = createProbeAudioData(sampleRate, numberOfChannels, 0);
    try {
      encoder.encode(audioData);
    } catch (error) {
      return { supported: false, reason: describeProbeError(error) };
    } finally {
      // encode() は AudioData を消費しないため、呼び出し側で閉じる
      audioData.close();
    }

    // flush の完了か待ち上限のどちらか早い方まで待つ。flush はエラー時に
    // reject するため、必ず受けて未処理の rejection を残さない
    const outcome = await Promise.race([
      encoder.flush().then(
        () => "flushed",
        (error: unknown) => `flush failed: ${describeProbeError(error)}`,
      ),
      waitForProbeTimeout(timeoutMs).then(() => "timeout"),
    ]);

    // エラーコールバックが確定していれば、出力の有無によらず非対応とする
    // (出力が得られた後でも、その設定が健全だとは限らない)
    if (failureReason !== null) {
      return { supported: false, reason: failureReason };
    }
    // 出力が 1 チャンクでも届いていれば、実際に符号化できている
    if (outputChunkCount > 0) {
      return { supported: true };
    }
    if (outcome === "timeout") {
      return { supported: false, reason: `no output chunk within ${timeoutMs}ms` };
    }
    // flush() 自体が失敗した場合はその理由をそのまま返す
    if (outcome !== "flushed") {
      return { supported: false, reason: outcome };
    }
    return { supported: false, reason: "flush completed without output chunk" };
  } finally {
    // 確認用のエンコーダーを残さない。失敗した設定では UA が既に閉じている
    // ことがあるため、閉じ済みを避けて呼ぶ
    closeCodecQuiet(encoder);
  }
}
