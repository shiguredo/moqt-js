/**
 * codec テストページの結果型
 *
 * Playwright スペックが page.evaluate 経由で受け取る JSON 構造を定義する。
 * VideoFrame / AudioData / Uint8Array はそのままではシリアライズできないため、
 * テストページ側で数値・文字列へ要約して返す。
 */

/**
 * state 遷移の 1 ステップ
 */
export interface StateTransition {
  // 操作名 (initial / afterConfigure など)
  step: string;
  // 操作直後の state
  state: string;
}

/**
 * 未設定時 (configure 前・close 後) の encode() / decode() の観測結果
 */
export interface UnconfiguredOperationResult {
  // 戻り値の型 (void のため常に "undefined")
  returnValueType: string;
  // 呼び出し直後の state
  state: string;
  // output コールバックの呼び出し回数 (0 件であること)
  outputCount: number;
  // error コールバックの呼び出し回数 (0 件であること)
  errorCount: number;
}

/**
 * 未設定時の decode() の観測結果
 *
 * デコーダー Wrapper は state ゲッターを持たない (エンコーダー Wrapper との
 * 非対称) ため、戻り値と出力件数のみで判定する。
 */
export interface DecoderOperationResult {
  // 戻り値の型 (void のため常に "undefined")
  returnValueType: string;
  // output コールバックの呼び出し回数 (増えないこと)
  outputCount: number;
  // error コールバックの呼び出し回数 (0 件であること)
  errorCount: number;
}

/**
 * エンコーダーが出力した chunk の要約
 */
export interface ObservedEncodedChunk {
  // "key" または "delta"
  type: string;
  // chunk のバイト長
  byteLength: number;
  // 実データが入っていることの確認用の先頭バイト
  firstByte: number;
  // タイムスタンプ (マイクロ秒)
  timestamp: number;
  // duration (マイクロ秒)。未指定は null
  duration: number | null;
  // description (コーデック初期化データ) のバイト長。未指定は null
  descriptionByteLength: number | null;
}

/**
 * デコードされた VideoFrame の要約
 */
export interface ObservedVideoFrame {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  format: string | null;
  timestamp: number;
  duration: number | null;
  // copyTo で読み出した RGBA のバイト長
  rgbaByteLength: number;
  // 読み出した RGBA の非ゼロバイト数 (実際に絵が入っていることの確認)
  rgbaNonZeroByteCount: number;
  // 左上 1 ピクセルの RGBA (投入した単色が復号されていることの確認)
  firstPixel: number[];
}

/**
 * デコードされた AudioData の要約
 */
export interface ObservedAudioData {
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
  format: string | null;
  timestamp: number;
  duration: number | null;
  // copyTo で読み出した f32-planar のバイト長
  sampleByteLength: number;
  // 読み出したサンプルの非ゼロ数 (実データが入っていることの確認)
  nonZeroSampleCount: number;
}

/**
 * VideoEncoderWrapper のテスト結果
 */
export interface VideoEncoderTestResult {
  test: string;
  useWorker: boolean;
  // 状態遷移の記録
  stateHistory: StateTransition[];
  // 未設定時の encode()
  unconfiguredEncode: UnconfiguredOperationResult;
  // 未設定時の encodeQueueSize
  unconfiguredEncodeQueueSize: number;
  // configure 直後の encodeQueueSize
  queueSizeAfterConfigure: number;
  // encode ループ直後 (出力待機前) の encodeQueueSize
  queueSizeAfterEncode: number;
  // encodeQueueSize が 0 以上の整数であること
  queueSizeIsNonNegativeInteger: boolean;
  // 到着した chunk 数
  chunkCount: number;
  // うち key chunk の数
  keyChunkCount: number;
  // chunk の要約 (到着順)
  chunks: ObservedEncodedChunk[];
  // keyFrame: true を明示した 2 番目のフレームの chunk type
  forcedKeyFrameChunkType: string | null;
  // 出力の timestamp (到着順)
  outputTimestamps: number[];
  // close() 後の encode()
  encodeAfterClose: UnconfiguredOperationResult;
  // error コールバックに届いたメッセージ
  errorMessages: string[];
}

/**
 * VideoDecoderWrapper のテスト結果
 */
export interface VideoDecoderTestResult {
  test: string;
  useWorker: boolean;
  // 未設定時の decode()
  unconfiguredDecode: DecoderOperationResult;
  // configure に渡した description のバイト長。なしは null
  descriptionByteLength: number | null;
  // decode() に投入した chunk 数
  inputChunkCount: number;
  // キーフレーム投入前に delta chunk を投入してから観測したフレーム数 (0 件であること)
  framesAfterDeltaBeforeKey: number;
  // デコードされたフレーム数
  frameCount: number;
  // フレームの要約 (到着順)
  frames: ObservedVideoFrame[];
  // 出力フレームの timestamp (到着順)
  frameTimestamps: number[];
  // resetKeyframeWait() 後に delta chunk を投入してから観測したフレーム数 (0 件増であること)
  framesAfterResetKeyframeWaitDelta: number;
  // resetKeyframeWait() 後の key chunk で復号が再開したか
  resumedAfterResetKeyframeWait: boolean;
  // close() 後の decode()
  decodeAfterClose: DecoderOperationResult;
  // error コールバックに届いたメッセージ
  errorMessages: string[];
}

/**
 * AudioEncoderWrapper のテスト結果
 */
export interface AudioEncoderTestResult {
  test: string;
  useWorker: boolean;
  // 実ブラウザが対応していたコーデック
  codec: string;
  sampleRate: number;
  channels: number;
  // 状態遷移の記録
  stateHistory: StateTransition[];
  // 未設定時の encode()
  unconfiguredEncode: UnconfiguredOperationResult;
  // 到着した chunk 数
  chunkCount: number;
  // うち key chunk の数
  keyChunkCount: number;
  // chunk の要約 (到着順)
  chunks: ObservedEncodedChunk[];
  // chunk のバイト長の合計
  totalByteLength: number;
  // 出力の timestamp (到着順)
  outputTimestamps: number[];
  // close() 後の encode()
  encodeAfterClose: UnconfiguredOperationResult;
  // error コールバックに届いたメッセージ
  errorMessages: string[];
}

/**
 * AudioDecoderWrapper のテスト結果
 */
export interface AudioDecoderTestResult {
  test: string;
  useWorker: boolean;
  // 実ブラウザが対応していたコーデック
  codec: string;
  sampleRate: number;
  channels: number;
  // 未設定時の decode()
  unconfiguredDecode: DecoderOperationResult;
  // decode() に投入した chunk 数
  inputChunkCount: number;
  // デコードされた AudioData の数
  decodedCount: number;
  // AudioData の要約 (到着順)
  decoded: ObservedAudioData[];
  // 投入した chunk の timestamp (到着順)
  inputTimestamps: number[];
  // 出力の timestamp (到着順)
  outputTimestamps: number[];
  // close() 後の decode()
  decodeAfterClose: DecoderOperationResult;
  // error コールバックに届いたメッセージ
  errorMessages: string[];
}

/**
 * テスト名と結果型の対応
 */
/**
 * VideoEncoderWrapper の再 configure テスト結果
 *
 * 同じ Wrapper に対して解像度を変えて configure() を繰り返し、
 * 旧コーデックの破棄と新しい設定での encode 継続を検証する。
 */
export interface VideoEncoderReconfigureTestResult {
  test: string;
  useWorker: boolean;
  // 状態遷移の記録
  stateHistory: StateTransition[];
  // 1 回目の configure で出力された chunk 数
  firstConfigChunkCount: number;
  // 2 回目の configure 後に出力された chunk 数
  secondConfigChunkCount: number;
  // chunk の timestamp (到着順)
  outputTimestamps: number[];
  // 2 回目の configure 後の encodeQueueSize が 0 以上の整数であること
  queueSizeIsNonNegativeInteger: boolean;
  // error コールバックへ届いたメッセージ
  errorMessages: string[];
}

/**
 * 復号済み AudioData からのサンプル読み出し結果
 *
 * devtools の可視化は復号済み AudioData を直接読むため、実ブラウザで
 * サンプル列が読み出せることを確認する (AudioData は Node では生成できない)。
 */
export interface AudioSamplesTestResult {
  test: string;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
  // readAudioSamples が読み出したサンプル数
  sampleCount: number;
  // peak / RMS を dBFS にしたもの (振幅 1.0 が 0 dBFS)
  peakDbfs: number;
  rmsDbfs: number;
  // 読み出したサンプルの最小値と最大値
  minSample: number;
  maxSample: number;
  // 第 2 チャンネル (無音) の最大絶対値。第 1 チャンネルだけを読んでいることの確認用
  secondChannelPeak: number;
}

export interface CodecTestResultMap {
  videoEncoderDirect: VideoEncoderTestResult;
  videoEncoderWorker: VideoEncoderTestResult;
  videoDecoderDirect: VideoDecoderTestResult;
  videoDecoderWorker: VideoDecoderTestResult;
  audioEncoderDirect: AudioEncoderTestResult;
  audioEncoderWorker: AudioEncoderTestResult;
  audioDecoderDirect: AudioDecoderTestResult;
  audioDecoderWorker: AudioDecoderTestResult;
  audioSamples: AudioSamplesTestResult;
  videoEncoderReconfigureDirect: VideoEncoderReconfigureTestResult;
  videoEncoderReconfigureWorker: VideoEncoderReconfigureTestResult;
}

/**
 * 実行できるテスト名
 */
export type CodecTestName = keyof CodecTestResultMap;

/**
 * テスト結果の共用型
 */
export type CodecTestResult = CodecTestResultMap[CodecTestName];
