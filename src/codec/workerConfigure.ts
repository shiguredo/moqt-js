/**
 * Worker 初期化の応答契約と完了管理
 *
 * Wrapper と Worker は初期化結果を 2 種のメッセージで受け渡す。
 * 成功時は {type: "configured"}、失敗時は {type: "error", message} であり、
 * 失敗時に "configured" を送らないことが契約である。
 * 初期化完了前の "error" は configure() の reject とし、
 * 完了後の "error" は従来どおり callbacks.error へ通知する。
 *
 * ブラウザ非依存の契約 (純粋ロジック) と失敗時破棄手順を置く。
 * 純粋部分は契約テストで pin し、破棄手順の実行はブラウザ依存のため
 * レビューで確認する (モックは使わない)。
 *
 * 対象外: タイムアウトは設けない。未知 type の到達、onmessage / onerror の
 * どちらも発火しない Worker 死は本モジュールの対象外である
 * (初期化失敗の error 応答 → reject のみ扱う)。
 * configure 待機中の close / reset は世代の無効化で中断する
 * (待機世代の遅延成功は破棄・reject される)。
 */

/**
 * Worker 初期化の応答メッセージ
 */
export type WorkerInitResult = { type: "configured" } | { type: "error"; message: string };

/**
 * 失敗理由を文言化する
 *
 * WebCodecs の初期化失敗は DOMException (Error 継承を持たない処理系がある)
 * で送出されるため、instanceof ではなく message プロパティの有無で判定する。
 * message の読み出しは 1 回にまとめ、読み出し自体の送出や String 化の失敗時は
 * 固定文言に落とす (変換器自体の throw で応答が欠落しないようにする)。
 * 返却値は常に非空 string である (WorkerInitResult の message 契約)。
 * Worker 側の応答生成と Wrapper 側の受信正規化で共有する。
 */
export function toFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  let probed: unknown;
  try {
    probed =
      typeof error === "object" && error !== null && "message" in error ? error.message : undefined;
  } catch {
    probed = undefined;
  }
  if (typeof probed === "string" && probed !== "") {
    return probed;
  }
  try {
    const text = String(error);
    if (text !== "") {
      return text;
    }
  } catch {
    // String 化自体が失敗する場合は固定文言に落とす
  }
  return "unknown worker init failure";
}

/**
 * Worker 側の init 処理を実行し、応答メッセージを返す
 *
 * 成功時は "configured"、throw 時は "error" を返す。
 * 失敗時は "configured" を返さない (Wrapper がハングしない前提)。
 */
export function runWorkerInit(init: () => void): WorkerInitResult {
  try {
    init();
  } catch (error) {
    return { type: "error", message: toFailureMessage(error) };
  }
  return { type: "configured" };
}

/**
 * Wrapper 側の初期化完了管理
 *
 * 初期化応答 ("configured" / "error" / onerror) の最初の 1 回だけ
 * true を返し、呼び出し側が Promise を settle させる。
 * 二重解決を防ぐためのガードである。
 */
export class WorkerConfigureGate {
  private settled = false;

  /**
   * 初期化応答の settle 権を 1 回だけ取得する
   *
   * @returns 最初の応答なら true (Promise を settle させる)
   */
  trySettle(): boolean {
    if (this.settled) {
      return false;
    }
    this.settled = true;
    return true;
  }
}

/**
 * configure() 発行ごとの世代管理
 *
 * 同一 Wrapper への並行 configure() の所有権分離に使う。
 * 生成直後に世代を採番し、成功公開時に最新世代かを判定する。
 * 最新世代なら旧公開を破棄して公開し (後勝ち)、旧世代の遅延成功なら
 * 自世代を破棄する (先発破棄)。旧世代の遅延成功は reject する (中断扱い)。
 * 失敗時は世代の新旧によらず自世代を破棄して個別エラーで reject する。
 * close() / reset() 時は無効化して待機中の世代を旧世代化する (中断扱い)。
 */
export class ConfigureGenerationTracker {
  private current = 0;

  /**
   * 新規 configure 世代を採番する
   *
   * @returns 採番した世代 (単調増加する)
   */
  begin(): number {
    this.current += 1;
    return this.current;
  }

  /**
   * 指定世代が最新の公開対象かを判定する
   */
  isLatest(generation: number): boolean {
    return generation === this.current;
  }

  /**
   * 待機中の全世代を旧世代化する (close / reset 時の中断用)
   */
  invalidateAll(): void {
    this.current += 1;
  }
}

/**
 * Worker を破棄する
 *
 * 初期化失敗時の後始末、後勝ち公開時の旧公開の破棄、旧世代の遅延成功時の
 * 自世代の破棄で共有する。
 * 運用中の onmessage 配送に影響しないよう、破棄前に配送口を外す。
 */
export function disposeWorker(worker: Worker | null): void {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
}
