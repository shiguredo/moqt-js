/**
 * Wrapper と Worker の間でやり取りするメッセージ型
 *
 * プロトコルの正本をここに置き、4 Wrapper と 4 Worker の双方が同じ型を参照する。
 * 送受信の対応が片側だけ変わった場合は `tsc --noEmit` で検出される。
 *
 * メッセージの流れ:
 * - Wrapper → Worker: `init` / `encode` / `decode` / `resetKeyframeWait` / `close`
 * - Worker → Wrapper: `configured` / `encoded` / `decoded` / `skipped` / `error`
 *
 * `configured` は初期化成功、`error` は初期化失敗または実行時エラーを表す。
 * 初期化失敗時は `configured` を送らない (Wrapper の configure() がハングしない前提)。
 */

/** Wrapper → Worker: コーデックの初期化 */
export interface WorkerInitRequest<TConfig> {
  type: "init";
  config: TConfig;
}

/** Wrapper → Worker: コーデックの破棄 */
export interface WorkerCloseRequest {
  type: "close";
}

/** Wrapper → Worker: ビデオフレームのエンコード */
export interface VideoEncoderWorkerEncodeRequest {
  type: "encode";
  frame: VideoFrame;
  keyFrame: boolean;
}

/** Wrapper → Worker: 音声データのエンコード */
export interface AudioEncoderWorkerEncodeRequest {
  type: "encode";
  data: AudioData;
}

/** Wrapper → Worker: エンコード済みチャンクのデコード (映像 / 音声で同形) */
export interface WorkerDecodeRequest {
  type: "decode";
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number;
}

/** Wrapper → Worker: キーフレーム待ちの再開 */
export interface VideoDecoderWorkerResetKeyframeWaitRequest {
  type: "resetKeyframeWait";
}

/** Worker → Wrapper: 初期化成功 */
export interface WorkerConfiguredResponse {
  type: "configured";
}

/** Worker → Wrapper: 初期化失敗 / 実行時エラー */
export interface WorkerErrorResponse {
  type: "error";
  message: string;
}

/** Worker → Wrapper: エンコード済み映像チャンク */
export interface VideoEncoderWorkerEncodedResponse {
  type: "encoded";
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: ArrayBuffer;
}

/** Worker → Wrapper: エンコード済み音声チャンク */
export interface AudioEncoderWorkerEncodedResponse {
  type: "encoded";
  data: ArrayBuffer;
  chunkType: "key" | "delta";
  timestamp: number;
  duration: number | null;
}

/** Worker → Wrapper: デコード済み映像フレーム */
export interface VideoDecoderWorkerDecodedResponse {
  type: "decoded";
  frame: VideoFrame;
}

/** Worker → Wrapper: デコード済み音声データ */
export interface AudioDecoderWorkerDecodedResponse {
  type: "decoded";
  data: AudioData;
}

/** Worker → Wrapper: キーフレーム待ちでスキップしたフレーム */
export interface VideoDecoderWorkerSkippedResponse {
  type: "skipped";
  reason: "waiting_for_keyframe";
}

/** 映像エンコーダー Worker の応答 */
export type VideoEncoderWorkerResponse =
  | WorkerConfiguredResponse
  | VideoEncoderWorkerEncodedResponse
  | WorkerErrorResponse;

/** 音声エンコーダー Worker の応答 */
export type AudioEncoderWorkerResponse =
  | WorkerConfiguredResponse
  | AudioEncoderWorkerEncodedResponse
  | WorkerErrorResponse;

/** 映像デコーダー Worker の応答 */
export type VideoDecoderWorkerResponse =
  | WorkerConfiguredResponse
  | VideoDecoderWorkerDecodedResponse
  | VideoDecoderWorkerSkippedResponse
  | WorkerErrorResponse;

/** 音声デコーダー Worker の応答 */
export type AudioDecoderWorkerResponse =
  | WorkerConfiguredResponse
  | AudioDecoderWorkerDecodedResponse
  | WorkerErrorResponse;

/** 初期化応答 (4 Worker 共通) */
export type WorkerInitResponse = WorkerConfiguredResponse | WorkerErrorResponse;

/** 映像エンコーダー Worker のデータ応答 (初期化応答を除く) */
export type VideoEncoderWorkerData = Exclude<VideoEncoderWorkerResponse, WorkerInitResponse>;

/** 音声エンコーダー Worker のデータ応答 (初期化応答を除く) */
export type AudioEncoderWorkerData = Exclude<AudioEncoderWorkerResponse, WorkerInitResponse>;

/** 映像デコーダー Worker のデータ応答 (初期化応答を除く) */
export type VideoDecoderWorkerData = Exclude<VideoDecoderWorkerResponse, WorkerInitResponse>;

/** 音声デコーダー Worker のデータ応答 (初期化応答を除く) */
export type AudioDecoderWorkerData = Exclude<AudioDecoderWorkerResponse, WorkerInitResponse>;

/**
 * 契約外の要求を無視する
 *
 * Worker 側の `switch` の `default` から呼び、union の全メンバーを `case` で
 * 処理しているかを型レベルで検査する。
 */
export function ignoreUnknownWorkerRequest(message: never): void {
  void message;
}

/**
 * 契約外の応答を無視する
 *
 * `switch` の `default` から呼び、union の全メンバーを `case` で処理しているかを
 * 型レベルで検査する (引数が `never` になるため、`case` の追加漏れは
 * `tsc --noEmit` で検出される)。実行時に到達した場合は契約外の応答であり、
 * 初期化・データ経路のどちらにも影響させない。
 */
export function ignoreUnknownWorkerResponse(message: never): void {
  void message;
}
