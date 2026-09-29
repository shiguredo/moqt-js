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
 * decode() の戻り値 (void のため常に "undefined") と output / error コールバックの
 * 呼び出し回数で判定する。state はこの型に含めず、呼び出し側が Wrapper から別途読む。
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
  // (直接モードは実キュー長、Worker モードは未応答の送信数。両モードとも投入数になる)
  queueSizeAfterEncode: number;
  // 出力待機後の encodeQueueSize (Worker モードでも 0 に戻る)
  queueSizeAfterOutputWait: number;
  // close 直前 (未応答のフレームを残した状態) の encodeQueueSize
  queueSizeBeforeClose: number;
  // close 後の encodeQueueSize (0 に戻る)
  queueSizeAfterClose: number;
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
 * 非対応 codec で configure() と reset() が失敗したときの観測結果
 *
 * ライブラリ側の VideoDecoderWrapper と devtools の DecoderWrapper の e2e テストで共有する。
 * どちらも「Worker も VideoDecoder も作らずに configure() が失敗し、失敗した設定は
 * reset() で再試行されない」ことを同じ形で観測する。
 */
export interface DecoderConfigureFailureObservation {
  // configure の失敗理由 (失敗しなかった場合は null)
  configureErrorMessage: string | null;
  // configure の失敗後の state (unconfigured のまま)
  stateAfterFailedConfigure: string;
  // 同じ config の reset() の結果 (再試行せず false)
  resetReturned: boolean;
  // reset() の後の state (unconfigured のまま)
  stateAfterReset: string;
  // output コールバックの呼び出し回数 (1 枚も復号しないため 0 件)
  outputCount: number;
  // error コールバックに届いたメッセージ (configure の失敗も reset() の打ち切りも
  // 通知しないため 0 件)
  errorMessages: string[];
}

/**
 * VideoDecoderWrapper の非対応 codec のテスト結果
 *
 * 実ブラウザが復号に対応していないコーデックを実測で選び、configure() と reset() が
 * 失敗する経路を観測する。
 */
export interface VideoDecoderUnsupportedCodecTestResult extends DecoderConfigureFailureObservation {
  test: string;
  useWorker: boolean;
  // 実測で選んだ非対応コーデックの名前
  codec: string;
  // configure に載る codec 文字列 (非対応と判定された実物)
  codecString: string;
  // 対応と判定されて除外した候補 (試した順のコーデック名。選んだ非対応 codec は含まない)
  supportedCodecs: string[];
  // configure 前の state (unconfigured)
  stateBeforeConfigure: string;
}

/**
 * 同じ config の reset() で復帰の予算を使い切ったときの観測結果
 *
 * ライブラリ側の VideoDecoderWrapper と devtools の DecoderWrapper の e2e テストで共有する。
 */
export interface DecoderResetBudgetExhaustionObservation {
  // lastConfig が無いときの reset() の結果 (false)
  resetWithoutConfig: boolean;
  // 対応 codec の configure 直後の state (configured)
  stateAfterConfigure: string;
  // 復号フレームを出さずに reset() を繰り返した結果 (上限の 3 回が true、4 回目が false)
  resetResults: boolean[];
  // 打ち切り直後の state (unconfigured)
  stateAfterBudgetExhausted: string;
  // 打ち切り後に実 chunk を投入して復号したフレーム数 (configured = false のため 0 件)
  framesDecodedAfterBudgetExhausted: number;
  // error コールバックに届いたメッセージ (reset() の失敗も通知しないため 0 件)
  errorMessages: string[];
}

/**
 * 予算を使い切った状態から復帰の条件で予算が戻ったときの観測結果
 *
 * ライブラリ側の VideoDecoderWrapper と devtools の DecoderWrapper の e2e テストで共有する。
 * 予算を使い切るまでに呼ぶ reset() の回数はテストごとに異なるため、結果の並びは
 * テスト側の assert で固定する。
 */
export interface DecoderResetRestoreObservation {
  // 復号フレームを出す前に reset() を繰り返した結果
  resetResultsBeforeDecodedFrame: boolean[];
  // 復号フレームを 1 枚出力した後の reset() の結果 (予算が戻るため true)
  resetAfterDecodedFrame: boolean;
  // 予算を使い切ってから参照の異なる config で configure するまでの reset() の結果
  resetResultsBeforeDifferentConfig: boolean[];
  // 参照の異なる config の configure 後の reset() の結果 (予算が戻るため true)
  resetAfterDifferentConfig: boolean;
  // 参照の異なる config の configure と reset() の後の state (configured)
  stateAfterDifferentConfigReset: string;
  // error コールバックに届いたメッセージ (0 件)
  errorMessages: string[];
}

/**
 * VideoDecoderWrapper の復帰予算のテスト結果
 *
 * 復号フレームを 1 枚も出さないまま同じ config で reset() を繰り返し、
 * 上限で打ち切られることを観測する。
 */
export interface VideoDecoderResetBudgetTestResult extends DecoderResetBudgetExhaustionObservation {
  test: string;
  useWorker: boolean;
  // lastConfig が無いときの reset() の直後の state (unconfigured)
  stateAfterResetWithoutConfig: string;
  // 打ち切り後に実 chunk を投入して decode() を呼んだ回数
  decodeAttemptsAfterBudgetExhausted: number;
}

/**
 * VideoDecoderWrapper の並行する reset() / configure() の交錯のテスト結果
 *
 * `Promise.all([reset(), reset()])` と、reset() の対応確認の await 中に参照の異なる
 * config で configure() する交錯を駆動する。後発の構成操作がデコーダーの所有権を持つ
 * とき、先発の reset() が後発世代を壊さずに false を返すことを観測する。
 */
export interface VideoDecoderConcurrentResetTestResult {
  test: string;
  useWorker: boolean;
  // Promise.all([reset(), reset()]) の結果 (後発に追い越された reset() は false)
  concurrentResetResults: boolean[];
  // 2 つの reset() の直後の state (configured)
  stateAfterConcurrentReset: string;
  // 2 つの reset() の後に実 chunk を復号したフレーム数 (構成が残るため 1 件以上)
  framesDecodedAfterConcurrentReset: number;
  // reset() の対応確認中に configure() したときの configure() の失敗理由 (成功するため null)
  configureErrorMessage: string | null;
  // 同じ交錯で reset() が返した結果 (configure() に追い越されるため false)
  resetReturnedDuringConfigure: boolean;
  // 交錯の直後の state (configured)
  stateAfterConcurrentConfigure: string;
  // 交錯の後に実 chunk を復号したフレーム数 (configure() の構成が残るため 1 件以上)
  framesDecodedAfterConcurrentConfigure: number;
  // error コールバックに届いたメッセージ (configure も reset() も通知しないため 0 件)
  errorMessages: string[];
}

/**
 * VideoDecoderWrapper の予算の復帰条件のテスト結果
 *
 * 予算を使い切った状態から、復号フレームの出力と参照の異なる config の configure で
 * 予算が戻ることを観測する。
 */
export interface VideoDecoderRestoreTestResult extends DecoderResetRestoreObservation {
  test: string;
  useWorker: boolean;
  // 復号したフレーム数 (復帰条件の確認用)
  frameCount: number;
}

/**
 * AudioEncoderWrapper のテスト結果
 */
export interface AudioEncoderTestResult {
  test: string;
  useWorker: boolean;
  // 実際に符号化できることを確認して採用したコーデック
  codec: string;
  // 符号化できないなどの理由で候補から外したコーデック (除外理由つき、試した順)
  rejectedCodecs: string[];
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
  // 実際に符号化できることを確認して採用したコーデック
  codec: string;
  // 符号化できないなどの理由で候補から外したコーデック (除外理由つき、試した順)
  rejectedCodecs: string[];
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

/**
 * VideoDecoderWrapper の configure() の対応確認中に close() が先行したときのテスト結果
 *
 * configure() は対応確認を await するため、その解決までの間に close() を呼ぶと、解放の
 * あとに Worker や VideoDecoder を作ってはならない (作ると誰も破棄せず、close() の後に
 * state も configured へ戻る)。イベント順と state で観測する。
 */
export interface VideoDecoderCloseDuringConfigureTestResult {
  test: string;
  useWorker: boolean;
  // 観測したイベントの順序 (configure started / close called / configure rejected)
  events: string[];
  // configure() の失敗理由 (失敗しなかった場合は null)
  configureErrorMessage: string | null;
  // 解放が先行した configure() の直後の state (unconfigured のまま)
  stateAfterAbortedConfigure: string;
  // 解放が先行した configure() で復号したフレーム数 (1 枚も復号しないため 0 件)
  framesDecodedAfterAbortedConfigure: number;
  // やり直した configure() の直後の state (configured)
  stateAfterReconfigure: string;
  // やり直しの後に実 chunk を復号したフレーム数 (1 件以上)
  framesDecodedAfterReconfigure: number;
  // error コールバックに届いたメッセージ (configure の失敗も通知しないため 0 件)
  errorMessages: string[];
}

/**
 * 対応確認 (VideoDecoder.isConfigSupported) の実測結果
 *
 * 対応確認には false を返す経路と reject する経路があるため、テスト内で直接呼んで
 * どちらの分岐に入る設定かを確かめた結果を持つ。
 */
export interface ConfigSupportObservation {
  // supported の値 (reject した場合は null)
  supported: boolean | null;
  // reject したか
  rejected: boolean;
}

/**
 * devtools の DecoderWrapper の非対応 codec のテスト結果
 *
 * devtools の購読側が使う Wrapper (devtools/src/utils/DecoderWrapper.ts) が、非対応 codec の
 * configure で Worker も VideoDecoder も作らずに失敗することと、失敗した設定が残らずに
 * 同じ config の reset() が false を返すことを観測する。isConfigSupported が false を返す
 * 経路と reject する経路を分けて固定する。
 */
export interface DevtoolsDecoderUnsupportedCodecTestResult extends DecoderConfigureFailureObservation {
  test: string;
  useWorker: boolean;
  // 対応確認が false を返す codec 文字列 (vp09.99.99.99)
  unsupportedCodecString: string;
  // false を返す codec の対応確認の実測結果
  unsupportedCodecSupport: ConfigSupportObservation;
  // 対応確認が reject する codec 文字列 (空文字)
  invalidCodecString: string;
  // reject する codec の対応確認の実測結果
  invalidCodecSupport: ConfigSupportObservation;
  // reject する codec の configure の失敗理由 (失敗しなかった場合は null)
  invalidCodecConfigureErrorMessage: string | null;
  // reject する codec の configure 後の state (unconfigured のまま)
  stateAfterInvalidCodecConfigure: string;
  // reject する codec の reset() の結果 (false)
  invalidCodecResetReturned: boolean;
}

/**
 * devtools の DecoderWrapper の復帰予算のテスト結果
 *
 * 同じ config で復号フレームを出さないまま reset() を繰り返すと上限の 3 回で打ち切られる
 * ことと、予算が戻る 2 条件 (復号フレームの出力 / 参照の異なる config の configure) を、
 * それぞれ予算を使い切った状態から観測する。あわせて、追い越されて失敗した configure() が
 * 予算を戻さないこと (戻すと呼び出し側が毎回新しい設定を渡すだけで上限が無効になる) を
 * 観測する。
 */
export interface DevtoolsDecoderResetBudgetTestResult
  extends DecoderResetBudgetExhaustionObservation, DecoderResetRestoreObservation {
  test: string;
  useWorker: boolean;
  // configure に使う対応 codec の codec 文字列 (vp8)
  supportedCodecString: string;
  // 予算を使い切った状態で出力した復号フレーム数 (1 件以上)
  framesDecodedBeforeRestore: number;
  // 予算を使い切ってから追い越される configure() を始めるまでの reset() の結果 (上限の 3 回が true)
  resetResultsBeforeSupersededConfigure: boolean[];
  // 追い越されて失敗した configure() の直後に呼んだ reset() の結果 (予算が戻っていないため false)
  resetAfterSupersededConfigure: boolean;
  // 追い越された configure() の失敗理由
  supersededConfigureErrorMessage: string | null;
  // その reset() の後の state (打ち切ったため unconfigured)
  stateAfterSupersededConfigure: string;
}

/**
 * devtools の DecoderWrapper の configure() の対応確認中に close() が先行したときのテスト結果
 *
 * VideoDecoderCloseDuringConfigureTestResult と同じ観測に加えて、close() が終端として
 * 働くこと (close() の後の reset() が作り直さず false を返すこと) を観測する。
 */
export interface DevtoolsDecoderCloseDuringConfigureTestResult extends VideoDecoderCloseDuringConfigureTestResult {
  // 解放 (close) が先行した configure() の後の reset() の結果 (close() 済みのため false。
  // lastConfig は configure が失敗したため残っておらず、closed の判定が先に効く)
  resetAfterAbortedConfigure: boolean;
  // やり直した configure() と close() の後の reset() の結果 (close は終端のため false)
  resetAfterClose: boolean;
  // close() の後の reset() の後の state (unconfigured のまま)
  stateAfterCloseReset: string;
}

/**
 * devtools の DecoderWrapper の並行する configure() のテスト結果
 *
 * configure() は対応確認を await するため、先発の await 中に後発の configure() が始まると
 * 先発は世代の判定で失敗し、後発がデコーダーの所有権を持つ。先発が Worker も VideoDecoder も
 * 作らないことと、後発の構成が残って実 chunk を復号できることを観測する。
 */
export interface DevtoolsDecoderConcurrentConfigureTestResult {
  test: string;
  useWorker: boolean;
  // 先発の configure の失敗理由 (後発に追い越されて失敗する)
  firstConfigureErrorMessage: string | null;
  // 後発の configure の失敗理由 (成功するため null)
  secondConfigureErrorMessage: string | null;
  // 交錯の直後の state (configured)
  stateAfterConcurrentConfigure: string;
  // 後発の configure の後に実 chunk を復号したフレーム数 (1 件以上)
  framesDecodedAfterConcurrentConfigure: number;
  // error コールバックに届いたメッセージ (configure の失敗も通知しないため 0 件)
  errorMessages: string[];
}

/**
 * devtools の EncoderWrapper の Worker モードのテスト結果
 *
 * devtools の配信が使う Wrapper (devtools/src/utils/EncoderWrapper.ts) の encodeQueueSize が、
 * Worker モードで Worker へ送信してまだ encoded 応答が返っていないフレーム数を返すことを
 * 観測する。configure / close と再 configure での 0 への復帰、output が例外を投げたときの
 * 減算、Worker が error 応答を返した後の投入の停止も同じ経路で確認する。
 */
export interface DevtoolsEncoderWorkerTestResult {
  test: string;
  useWorker: boolean;
  // 1 回の configure で投入するフレーム数 (e2e が期待値に使う)
  encodeFrameCount: number;
  // 状態遷移の記録
  stateHistory: StateTransition[];
  // configure 前の encodeQueueSize (未設定のため 0)
  queueSizeBeforeConfigure: number;
  // configure 直後の encodeQueueSize (送信中 0 件のため 0)
  queueSizeAfterConfigure: number;
  // フレームを投入した直後 (出力待機前) の encodeQueueSize (投入したフレーム数)
  queueSizeAfterEncode: number;
  // 出力を待った後の encodeQueueSize (encoded 応答ごとに減って 0)
  queueSizeAfterOutputWait: number;
  // 応答を待たずに投入したフレームを残したまま再 configure する直前の encodeQueueSize
  queueSizeBeforeReconfigure: number;
  // 再 configure 直後の encodeQueueSize (旧 Worker の破棄で 0)
  queueSizeAfterReconfigure: number;
  // 2 回目の configure の後に投入して出力された chunk 数
  secondConfigChunkCount: number;
  // 応答を待たずに投入したフレームを残したまま close する直前の encodeQueueSize
  queueSizeBeforeClose: number;
  // close 直後の encodeQueueSize (0)
  queueSizeAfterClose: number;
  // close の前に到着した chunk 数 (1 回目と 2 回目の configure の分)
  chunkCount: number;
  // うち key chunk の数 (各 configure の先頭の 1 件ずつ)
  keyChunkCount: number;
  // 出力の timestamp (到着順)
  outputTimestamps: number[];
  // 1 件目の output が例外を投げたときの、投入直後の encodeQueueSize
  outputThrowsQueueSizeAfterEncode: number;
  // 1 件目の output が例外を投げたときの、出力を待った後の encodeQueueSize (0)
  outputThrowsQueueSizeAfterWait: number;
  // output が呼ばれた回数 (例外になった 1 件目を含む)
  outputThrowsChunkCount: number;
  // output の例外をブラウザが未処理のエラーとして報告したメッセージ
  outputThrowsUncaughtMessages: string[];
  // Worker が error 応答を返す前に投入したフレームを残したままの encodeQueueSize
  queueSizeBeforeWorkerError: number;
  // Worker が error 応答を返した後の encodeQueueSize (0)
  queueSizeAfterWorkerError: number;
  // Worker が error 応答を返した後に encode した後の encodeQueueSize (送らないため 0)
  queueSizeAfterEncodePostError: number;
  // Worker が error 応答を返した後の state (configured でない)
  stateAfterWorkerError: string;
  // error コールバックに届いたメッセージ (初期化の失敗は reject で伝えるため 1 件)
  workerErrorNotifyMessages: string[];
  // 初期化に失敗する configure の前に、未応答のフレームを残したままの encodeQueueSize
  queueSizeBeforeFailedConfigure: number;
  // 初期化に失敗した configure の後の encodeQueueSize (0)
  queueSizeAfterFailedConfigure: number;
  // 初期化に失敗した configure の後の state (configured でない)
  stateAfterFailedConfigure: string;
  // 初期化に失敗した configure の reject メッセージ
  failedConfigureMessage: string | null;
  // error コールバックに届いたメッセージ (初期化の失敗は reject で伝えるため空)
  failedConfigureNotifyMessages: string[];
  // 再 configure の応答を待つ前に、未応答のフレームを残したままの encodeQueueSize
  queueSizeBeforeReconfigureWait: number;
  // 再 configure の応答を待つ間に投入した後の encodeQueueSize
  queueSizeDuringReconfigureWait: number;
  // 再 configure が解決した直後の encodeQueueSize (待機中の投入が消えていないこと)
  queueSizeAfterReconfigureWait: number;
  // 再 configure の待機を観測した Wrapper の error コールバックに届いたメッセージ (空)
  reconfigureWaitErrorMessages: string[];
}

/**
 * devtools の EncoderWrapper の Worker モードで、初期化に失敗した Worker の後の configure のテスト結果
 *
 * 初期化に失敗した configure は reject し、失敗した Worker を破棄して configured を false に
 * 戻す。この後始末が今の Worker や後発の configure の待機を巻き込まないことを、後発の
 * configure が解決するかと、やり直した configure が実フレームを符号化できるかで観測する。
 */
export interface DevtoolsEncoderFailedWorkerConfigureTestResult {
  test: string;
  useWorker: boolean;
  // 1 回の configure で投入するフレーム数 (e2e が期待値に使う)
  encodeFrameCount: number;
  // 旧世代 (初期化に失敗する設定) を待たずに後発の configure を呼んだ場合
  // 旧世代の configure の失敗理由 (追い越されて失敗する)
  firstConfigureErrorMessage: string | null;
  // 後発の configure の失敗理由 (解決するため null)
  secondConfigureErrorMessage: string | null;
  // 後発の configure が解決した直後の state (configured)
  stateAfterSecondConfigure: string;
  // 後発の Worker で投入したフレームのうち出力された chunk 数 (投入数と一致する)
  secondChunkCount: number;
  // 後発の Worker へ投入した直後 / 出力を待った後の encodeQueueSize (投入数 / 0)
  queueSizeAfterSecondEncode: number;
  queueSizeAfterSecondWait: number;
  // 後発の観測で error コールバックに届いたメッセージ (空)
  secondErrorMessages: string[];
  // 初期化に失敗した configure を待ってからやり直した場合
  // 初期化に失敗した configure の reject メッセージ (ブラウザが返す失敗理由)
  failedConfigureMessage: string | null;
  // 失敗した configure の直後の state (unconfigured) と encodeQueueSize (0)
  stateAfterFailedConfigure: string;
  queueSizeAfterFailedConfigure: number;
  // やり直した configure の失敗理由 (解決するため null)
  retryConfigureErrorMessage: string | null;
  // やり直しの configure が解決した直後の state (configured)
  stateAfterRetry: string;
  // やり直しの後に投入したフレームのうち出力された chunk 数 (投入数と一致する)
  retryChunkCount: number;
  // やり直しの後に投入した直後 / 出力を待った後の encodeQueueSize (投入数 / 0)
  queueSizeAfterRetryEncode: number;
  queueSizeAfterRetryWait: number;
  // 初期化の失敗とやり直しで error コールバックに届いたメッセージ
  // (初期化の失敗は reject で伝えるため空)
  errorMessages: string[];
}

/**
 * devtools の EncoderWrapper の Worker モードの configure() の待機中に close() が先行したときのテスト結果
 *
 * Worker モードの configure() は Worker を生成し、初期化の応答を待つ。その間に close() が
 * 始まると、close() は Worker の配送口を外して terminate する。中断を届けないと待機中の
 * configure() の Promise は未解決のまま残り、呼び出し側が待ち続ける。イベント順・失敗理由・
 * state で観測し、あわせて close() のあとにやり直した configure() が成功することを確認する。
 */
export interface DevtoolsEncoderCloseDuringConfigureTestResult {
  test: string;
  useWorker: boolean;
  // 1 回の configure で投入するフレーム数 (e2e が期待値に使う)
  encodeFrameCount: number;
  // 観測したイベントの順序 (configure started / close called / configure rejected)。
  // 中断が届かない実装では configure() が settle しないため "configure not settled" になる
  events: string[];
  // configure() の失敗理由 (失敗しなかった場合は null)
  configureErrorMessage: string | null;
  // 解放が先行した configure() の直後の state (unconfigured のまま)
  stateAfterAbortedConfigure: string;
  // 解放が先行した configure() の直後の encodeQueueSize (0)
  queueSizeAfterAbortedConfigure: number;
  // 解放のあとに encode した後の encodeQueueSize (Worker へ送らないため 0)
  queueSizeAfterEncodePostAbort: number;
  // やり直した configure() の直後の state (configured)
  stateAfterReconfigure: string;
  // やり直しの後に投入したフレームのうち、出力された chunk 数 (投入数と一致する)
  chunkCountAfterReconfigure: number;
  // やり直しの後に投入した直後の encodeQueueSize (投入数)
  queueSizeAfterReconfigureEncode: number;
  // やり直しの後に出力を待った後の encodeQueueSize (0)
  queueSizeAfterReconfigureWait: number;
  // error コールバックに届いたメッセージ (configure の失敗も通知しないため空)
  errorMessages: string[];
}

export interface CodecTestResultMap {
  videoEncoderDirect: VideoEncoderTestResult;
  videoEncoderWorker: VideoEncoderTestResult;
  videoDecoderDirect: VideoDecoderTestResult;
  videoDecoderWorker: VideoDecoderTestResult;
  videoDecoderUnsupportedCodecDirect: VideoDecoderUnsupportedCodecTestResult;
  videoDecoderUnsupportedCodecWorker: VideoDecoderUnsupportedCodecTestResult;
  videoDecoderResetBudgetDirect: VideoDecoderResetBudgetTestResult;
  videoDecoderResetBudgetWorker: VideoDecoderResetBudgetTestResult;
  videoDecoderResetRestoreDirect: VideoDecoderRestoreTestResult;
  videoDecoderResetRestoreWorker: VideoDecoderRestoreTestResult;
  videoDecoderConcurrentResetDirect: VideoDecoderConcurrentResetTestResult;
  videoDecoderConcurrentResetWorker: VideoDecoderConcurrentResetTestResult;
  videoDecoderCloseDuringConfigureDirect: VideoDecoderCloseDuringConfigureTestResult;
  videoDecoderCloseDuringConfigureWorker: VideoDecoderCloseDuringConfigureTestResult;
  devtoolsDecoderUnsupportedCodecDirect: DevtoolsDecoderUnsupportedCodecTestResult;
  devtoolsDecoderUnsupportedCodecWorker: DevtoolsDecoderUnsupportedCodecTestResult;
  devtoolsDecoderResetBudgetDirect: DevtoolsDecoderResetBudgetTestResult;
  devtoolsDecoderResetBudgetWorker: DevtoolsDecoderResetBudgetTestResult;
  devtoolsDecoderCloseDuringConfigureDirect: DevtoolsDecoderCloseDuringConfigureTestResult;
  devtoolsDecoderCloseDuringConfigureWorker: DevtoolsDecoderCloseDuringConfigureTestResult;
  devtoolsDecoderConcurrentConfigureDirect: DevtoolsDecoderConcurrentConfigureTestResult;
  devtoolsDecoderConcurrentConfigureWorker: DevtoolsDecoderConcurrentConfigureTestResult;
  audioEncoderDirect: AudioEncoderTestResult;
  audioEncoderWorker: AudioEncoderTestResult;
  audioDecoderDirect: AudioDecoderTestResult;
  audioDecoderWorker: AudioDecoderTestResult;
  audioSamples: AudioSamplesTestResult;
  videoEncoderReconfigureDirect: VideoEncoderReconfigureTestResult;
  videoEncoderReconfigureWorker: VideoEncoderReconfigureTestResult;
  devtoolsEncoderWorker: DevtoolsEncoderWorkerTestResult;
  devtoolsEncoderCloseDuringConfigure: DevtoolsEncoderCloseDuringConfigureTestResult;
  devtoolsEncoderFailedWorkerConfigure: DevtoolsEncoderFailedWorkerConfigureTestResult;
}

/**
 * 実行できるテスト名
 */
export type CodecTestName = keyof CodecTestResultMap;

/**
 * テスト結果の共用型
 */
export type CodecTestResult = CodecTestResultMap[CodecTestName];
