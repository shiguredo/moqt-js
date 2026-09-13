/**
 * WebCodecs コーデックインスタンスの共通ライフサイクル
 *
 * 4 ラッパー (`VideoEncoderWrapper` / `VideoDecoderWrapper` /
 * `AudioEncoderWrapper` / `AudioDecoderWrapper`) とその Worker は、いずれも
 * 次の同じ後始末を必要とする。
 *
 * - `state` が `"configured"` のときだけ encode / decode する
 * - `close()` は `state` が `"closed"` でないときだけ呼ぶ
 *   (WebCodecs の `close()` は closed に対して呼ぶと InvalidStateError を投げる)
 * - 再 configure では旧インスタンスを閉じてから差し替える
 *   (閉じないとデコーダー / エンコーダーのリソースが解放されない)
 *
 * 判定と破棄を 1 箇所に集約し、ラッパー側と Worker 側の双方から使う。
 */

/**
 * WebCodecs のコーデックインスタンスが満たす最小の構造
 *
 * `VideoEncoder` / `VideoDecoder` / `AudioEncoder` / `AudioDecoder` はいずれも
 * `state` と `close()` を持つため、この構造で共通に扱える。
 */
export interface CodecLike {
  readonly state: string;
  close(): void;
}

/**
 * 未設定 (未 configure / close 済み) のときに encode / decode が呼ばれたことを警告する
 *
 * 呼び出しは無視する (例外にしない)。文言は 4 ラッパーで統一する。
 * error コールバックは呼ばない (アプリの設定漏れであり、コーデックの異常ではない)。
 */
export function warnCodecNotConfigured(name: string): void {
  console.warn(`${name}: not configured`);
}

/**
 * コーデックが encode / decode を受け付けられる状態かを判定する
 */
export function isCodecConfigured<TCodec extends CodecLike>(codec: TCodec | null): codec is TCodec {
  return codec !== null && codec.state === "configured";
}

/**
 * コーデックを閉じる (既に closed なら何もしない)
 *
 * @param codec - 閉じるコーデック (null なら何もしない)
 */
export function closeCodecQuiet(codec: CodecLike | null): void {
  if (codec === null) {
    return;
  }
  if (codec.state !== "closed") {
    codec.close();
  }
}

/**
 * 旧コーデックを閉じてから新しいコーデックへ差し替える
 *
 * 直接実行モードの再 configure で旧インスタンスが開いたままになるのを防ぐ。
 *
 * @param previous - 現在保持しているコーデック (null なら閉じる対象なし)
 * @param next - 新しいコーデック
 * @returns next (そのままフィールドへ代入する)
 */
export function replaceCodec<TCodec extends CodecLike>(
  previous: TCodec | null,
  next: TCodec,
): TCodec {
  closeCodecQuiet(previous);
  return next;
}

/**
 * ラッパーの `state` ゲッターの値を組み立てる
 *
 * Worker モードでは Worker 内部のコーデック状態を取得できないため、
 * configure() の完了フラグを状態として扱う (未完了は "unconfigured")。
 * 直接実行モードではコーデック自身の状態を返す。
 */
export function codecStateLabel(
  useWorker: boolean,
  configured: boolean,
  codec: CodecLike | null,
): string {
  if (useWorker) {
    return configured ? "configured" : "unconfigured";
  }
  return codec?.state ?? "unconfigured";
}
