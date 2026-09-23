/**
 * codec テストページの共通ヘルパー
 *
 * 実ブラウザの WebCodecs と Worker を使うため、モックやスタブは一切使わない。
 * テスト用の入力 (canvas 由来の VideoFrame、無音の AudioData) を実際に生成し、
 * 出力 (chunk / frame / AudioData) を実データから要約する。
 */

import type { AudioCodecType } from "../../../src/codec/types.ts";
import { getAudioDecoderConfig, getAudioEncoderConfig } from "../../../src/codec/config.ts";
import { closeCodecQuiet } from "../../../src/codec/codecLifecycle.ts";
import type { ObservedAudioData, ObservedEncodedChunk, ObservedVideoFrame } from "./types.ts";

// 映像テストの共通パラメータ
export const VIDEO_WIDTH = 320;
export const VIDEO_HEIGHT = 240;
export const VIDEO_FRAMERATE = 30;
export const VIDEO_BITRATE = 500_000;
// 30fps のフレーム間隔 (マイクロ秒)
export const VIDEO_FRAME_DURATION = Math.round(1_000_000 / VIDEO_FRAMERATE);

// オーディオテストの共通パラメータ
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 64_000;
// Opus の 1 パケットは 20ms のため、100ms 単位で投入する
export const AUDIO_CHUNK_FRAMES = 4_800;
export const AUDIO_CHUNK_COUNT = 10;
// 1 回に投入する AudioData の長さ (マイクロ秒)
export const AUDIO_CHUNK_DURATION = Math.round(
  (AUDIO_CHUNK_FRAMES / AUDIO_SAMPLE_RATE) * 1_000_000,
);

/**
 * 条件が満たされるまでポーリングで待機する
 *
 * WebCodecs の出力は非同期コールバックで届くため、到着をポーリングで待つ。
 * タイムアウト時は観測対象を含む Error を投げ、Playwright 側で失敗として
 * 見えるようにする (テストを skip させない)。
 */
export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await waitForDuration(10);
  }
}

/**
 * 出力が到着しないことを一定時間確認する
 *
 * skip されるべき入力 (キーフレーム待ちの delta chunk) のように
 * 「何も起きない」ことを検証する場合に使う。
 */
export async function waitWithoutOutput(durationMs = 200): Promise<void> {
  await waitForDuration(durationMs);
}

/**
 * 指定した時間だけ待つ
 */
function waitForDuration(durationMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

/**
 * 出力が打ち止めになるまで待つ
 *
 * エンコーダーは入力を投入した後に非同期で複数の chunk を出力するため、
 * 「一定時間カウントが増えないこと」を出力完了の条件にする。
 * 1 件も出力されないままの場合はタイムアウトさせる。
 */
export async function waitForQuiet(
  getCount: () => number,
  description: string,
  quietMs = 300,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastCount = getCount();
  let lastChangeAt = performance.now();
  while (performance.now() < deadline) {
    await waitWithoutOutput(50);
    const count = getCount();
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = performance.now();
      continue;
    }
    if (lastCount > 0 && performance.now() - lastChangeAt >= quietMs) {
      return;
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} to settle`);
}

/**
 * テスト用の VideoFrame を生成する
 *
 * 実際にラスタライズされた絵を符号化させるため、単色で塗りつぶした canvas から
 * VideoFrame を作る。timestamp はマイクロ秒で指定する。
 */
export function createTestVideoFrame(
  width: number,
  height: number,
  color: string,
  timestamp: number,
): VideoFrame {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("failed to obtain 2d context for codec test frame");
  }
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  const videoFrame = new VideoFrame(canvas, { timestamp });
  // VideoFrame 生成時にピクセルは取り込まれるため、canvas は使い回さない
  canvas.width = 0;
  canvas.height = 0;
  return videoFrame;
}

/**
 * テスト用の無音 AudioData を生成する
 *
 * opus は可逆圧縮ではないため無音でも非ゼロのサンプルが復号され得る。
 * ここでは実データを持つ入力を作ることだけを目的とする。
 */
export function createSilentAudioData(
  sampleRate: number,
  channels: number,
  numberOfFrames: number,
  timestamp: number,
): AudioData {
  const samples = new Float32Array(numberOfFrames * channels);
  return new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames,
    numberOfChannels: channels,
    timestamp,
    data: samples,
  });
}

/**
 * エンコーダーの出力 chunk を要約する
 */
export function summarizeEncodedChunk(chunk: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}): ObservedEncodedChunk {
  // 先頭バイトは index access を避けて分割代入で取り出す。
  // byteLength が 0 の chunk には先頭バイトが無いため -1 にする
  const [firstByte = -1] = chunk.data;
  return {
    type: chunk.type,
    byteLength: chunk.data.byteLength,
    firstByte,
    timestamp: chunk.timestamp,
    duration: chunk.duration,
    descriptionByteLength: chunk.description ? chunk.description.byteLength : null,
  };
}

/**
 * デコードされた VideoFrame を要約する
 *
 * 読み出し後に frame を閉じるのは呼び出し側の責務とする。
 */
export async function summarizeVideoFrame(frame: VideoFrame): Promise<ObservedVideoFrame> {
  // RGBA へ変換して読み出し、実際に絵が入っていることまで確認する
  const rgba = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
  await frame.copyTo(rgba, { format: "RGBA" });
  let rgbaNonZeroByteCount = 0;
  for (const value of rgba) {
    if (value !== 0) {
      rgbaNonZeroByteCount += 1;
    }
  }
  // 左上 1 ピクセルは RGBA の 4 バイト。index access を避けて subarray から取り出す
  const firstPixel = Array.from(rgba.subarray(0, 4));
  return {
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    format: frame.format,
    timestamp: frame.timestamp,
    duration: frame.duration,
    rgbaByteLength: rgba.byteLength,
    rgbaNonZeroByteCount,
    firstPixel,
  };
}

/**
 * デコードされた AudioData を要約する
 *
 * 読み出し後に audioData を閉じるのは呼び出し側の責務とする。
 */
export function summarizeAudioData(audioData: AudioData): ObservedAudioData {
  // 第 1 チャンネルを f32-planar で読み出し、実データの有無を確認する
  const sampleByteLength = audioData.allocationSize({ planeIndex: 0, format: "f32-planar" });
  const samples = new Float32Array(sampleByteLength / Float32Array.BYTES_PER_ELEMENT);
  audioData.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
  let nonZeroSampleCount = 0;
  for (const value of samples) {
    if (value !== 0) {
      nonZeroSampleCount += 1;
    }
  }
  return {
    sampleRate: audioData.sampleRate,
    numberOfChannels: audioData.numberOfChannels,
    numberOfFrames: audioData.numberOfFrames,
    format: audioData.format,
    timestamp: audioData.timestamp,
    duration: audioData.duration,
    sampleByteLength,
    nonZeroSampleCount,
  };
}

// 候補はブラウザのビルド依存を避けるため、対応状況を実行時に判定する。
// この一覧は AudioCodecType の値を手で並べたもので、クエリパラメータで指定できる
// 名前の一覧も兼ねる (型に値を足しても自動では候補にならない)。
const AUDIO_CODEC_CANDIDATES: readonly AudioCodecType[] = ["opus", "aac"];

/**
 * 候補順を差し替えるときのクエリパラメータ名
 *
 * devtools 本体の `audioCodec` (単一値の設定) とは別の、テストページ専用の
 * パラメータである。
 */
const AUDIO_CODEC_PARAMETER = "audioCodecs";

/**
 * クエリパラメータからオーディオコーデックの候補順を解決する
 *
 * 符号化できないコーデックが候補に残る状況を e2e から再現できるよう、
 * `?audioCodecs=aac,opus` のように候補順を差し替えられるようにする。
 * 名前は大文字小文字を区別し、未知の名前と空要素は無視する。区切りはカンマだけで
 * あり、`+` は URLSearchParams が空白へ復号するため候補にならない。
 * 同じ名前の重複は最初の 1 つだけを残す。同名のパラメータが複数ある場合は
 * 最初の値だけを使う (URLSearchParams.get の挙動)。
 * パラメータが無い場合は既定の候補順を返し、有効な候補が 1 つも無い場合は
 * 空配列を返す (呼び出し側が「候補が無い」ことを明示的な Error にする)。
 *
 * @param search - ページのクエリ文字列 (`window.location.search`)
 * @returns 試す順に並んだ候補
 */
export function resolveAudioCodecCandidates(search: string): AudioCodecType[] {
  const raw = new URLSearchParams(search).get(AUDIO_CODEC_PARAMETER);
  if (raw === null) {
    return [...AUDIO_CODEC_CANDIDATES];
  }
  const candidates: AudioCodecType[] = [];
  for (const entry of raw.split(",")) {
    const name = entry.trim();
    const codec = AUDIO_CODEC_CANDIDATES.find((known) => known === name);
    if (codec !== undefined && !candidates.includes(codec)) {
      candidates.push(codec);
    }
  }
  return candidates;
}

/** オーディオコーデックの選定結果 */
export interface AudioCodecSelection {
  /** 採用したコーデック */
  codec: AudioCodecType;
  /** 除外した候補とその理由 (試した順) */
  rejectedCodecs: string[];
}

/**
 * 符号化プローブの待ち上限 (ミリ秒)
 *
 * 符号化できないコーデックは error が速く確定するため短く区切る
 * (waitForQuiet の既定 10 秒は使わない)。実測では opus の flush が 1 ms 前後で
 * 解決し、AAC の失敗は 10〜40 ms で確定したため、健全なエンコーダーを
 * 誤って除外しない余裕を残す。
 */
const AUDIO_ENCODE_PROBE_TIMEOUT_MS = 2_000;

/**
 * 例外から表示用のメッセージを取り出す
 *
 * WebCodecs の DOMException には message が空のものがあるため、その場合は
 * name へ落として理由が空にならないようにする。
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.message === "" ? error.name : error.message;
}

/**
 * 候補のコーデックが実際に符号化できるかを確かめる
 *
 * `AudioEncoder.isConfigSupported` は対応可否しか返さず、実際の符号化の成否を
 * 保証しない (Chromium は AAC を対応と報告するが符号化は EncodingError になる)。
 * 無音の AudioData を 1 件符号化して flush() し、error が確定せずに出力 chunk が
 * 得られた候補だけを符号化可能とみなす (error が確定した候補は、出力の有無に
 * かかわらず除外する)。出力は非同期に届くため、flush() の完了か待ち上限の
 * どちらか早い方まで待ち、その時点の error と出力件数で判断する。
 * プローブの AudioEncoder は必ず閉じる
 * (符号化失敗を短時間に繰り返すと Chromium の GPU プロセスが落ちるため)。
 *
 * @param codec - プローブするコーデック
 * @returns 符号化できた場合は null、その候補を除外すべき場合はその理由。
 *   候補に帰属しない失敗 (入力の生成失敗など) は throw する
 */
async function probeAudioEncoding(codec: AudioCodecType): Promise<string | null> {
  let outputChunkCount = 0;
  let errorMessage: string | null = null;
  const encoder = new AudioEncoder({
    output: () => {
      outputChunkCount += 1;
    },
    error: (error) => {
      // 最初の失敗だけを残す (以降の error は同じ原因で連鎖する)。
      // message が空の DOMException もあるため name へ落とす
      errorMessage ??= error.message === "" ? error.name : error.message;
    },
  });

  try {
    try {
      encoder.configure(
        getAudioEncoderConfig(codec, AUDIO_BITRATE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
      );
    } catch (error) {
      return `configure failed: ${describeError(error)}`;
    }

    // 入力は候補に依存しない固定の有効なパラメータで作るため、ここでの失敗は
    // 候補の欠格ではなくテスト側の誤りとして扱う (除外理由に混ぜない)
    const audioData = createSilentAudioData(
      AUDIO_SAMPLE_RATE,
      AUDIO_CHANNELS,
      AUDIO_CHUNK_FRAMES,
      0,
    );
    try {
      // encode() の同期 throw も符号化の失敗として候補の除外理由にする
      encoder.encode(audioData);
    } catch (error) {
      return `encode failed: ${describeError(error)}`;
    } finally {
      // encode() は AudioData を消費しないためテスト側で閉じる
      audioData.close();
    }

    // flush() の完了・待ち上限のどちらか早い方を待つ。flush() はエラー時に
    // reject するため、必ず受けて未処理の rejection を残さない
    const outcome = await Promise.race([
      encoder.flush().then(
        () => "flushed",
        (error: unknown) => `flush failed: ${describeError(error)}`,
      ),
      waitForDuration(AUDIO_ENCODE_PROBE_TIMEOUT_MS).then(() => "timeout"),
    ]);

    // error コールバックが先に確定していればそれを理由にする
    if (errorMessage !== null) {
      return errorMessage;
    }
    // 出力が 1 件でも届いていれば、flush() の失敗や待ち上限より採用を優先する
    // (出力が届いている時点で符号化は成立している)
    if (outputChunkCount > 0) {
      return null;
    }
    if (outcome === "timeout") {
      return `no output chunk within ${AUDIO_ENCODE_PROBE_TIMEOUT_MS}ms`;
    }
    if (outcome !== "flushed") {
      // flush() 自体が失敗した場合はその理由をそのまま返す
      return outcome;
    }
    return "flush completed without output chunk";
  } finally {
    // 失敗したプローブを残さない。符号化に失敗した場合は UA が既に閉じているため
    // close() が InvalidStateError になる。閉じ済みを避けて呼び、失敗理由を隠さない
    // (符号化の失敗そのものは GPU プロセスを落とすが、Encoder を握り続けると
    //  短時間の連続でブラウザごと使えなくなる)
    closeCodecQuiet(encoder);
  }
}

/**
 * 実ブラウザが実際に符号化でき、かつ decode にも対応するオーディオコーデックを選ぶ
 *
 * Chromium のビルドによっては opus / aac の対応状況が異なるため、
 * `AudioEncoder.isConfigSupported` と `AudioDecoder.isConfigSupported` の両方で
 * 確認する。ただし対応の申告だけでは実際に符号化できるかを保証しないため、
 * 候補ごとに無音の符号化を 1 件試し、error が確定せず出力が得られた候補だけを
 * 採用する。除外した候補は理由付きで返し、テスト結果から読めるようにする。
 * 符号化できる候補が 1 つも無い場合はテストを skip せず Error を投げる。
 */
export async function selectSupportedAudioCodec(): Promise<AudioCodecSelection> {
  const candidates = resolveAudioCodecCandidates(window.location.search);
  const rejectedCodecs: string[] = [];
  for (const codec of candidates) {
    const encoderSupport = await AudioEncoder.isConfigSupported(
      getAudioEncoderConfig(codec, AUDIO_BITRATE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
    );
    if (!encoderSupport.supported) {
      rejectedCodecs.push(`${codec} (encoder unsupported)`);
      continue;
    }
    const decoderSupport = await AudioDecoder.isConfigSupported(
      getAudioDecoderConfig(codec, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
    );
    if (!decoderSupport.supported) {
      rejectedCodecs.push(`${codec} (decoder unsupported)`);
      continue;
    }
    const probeFailure = await probeAudioEncoding(codec);
    if (probeFailure !== null) {
      rejectedCodecs.push(`${codec} (encode probe failed: ${probeFailure})`);
      continue;
    }
    return { codec, rejectedCodecs };
  }
  // 候補が 1 件も試されていない場合はその旨を出す (除外理由の列挙が空になるため)
  const candidatesLabel = candidates.length === 0 ? "none" : candidates.join(", ");
  const rejections = rejectedCodecs.length === 0 ? "" : `: ${rejectedCodecs.join(", ")}`;
  throw new Error(
    `no encodable audio codec in this browser (candidates: ${candidatesLabel})${rejections}`,
  );
}
