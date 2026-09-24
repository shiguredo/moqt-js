import type { WorkerErrorResponse, WorkerInitResponse } from "./workerMessages";

/**
 * Worker 初期化の応答契約と完了管理
 *
 * Wrapper と Worker は初期化結果を 2 種のメッセージで受け渡す。
 * 成功時は {type: "configured"}、失敗時は {type: "error", message} であり、
 * 失敗時に "configured" を送らないことが契約である。
 * 初期化完了前の "error" は configure() の reject とし、
 * 完了後の "error" は従来どおり callbacks.error へ通知する。
 *
 * 併せて Worker モードのエンコーダが Worker へ送信中のフレーム数を数える
 * SentFrameCounter を置く (VideoEncoderWrapper.encodeQueueSize の Worker モードの値。
 * Worker 内のキュー長は取得できないため、送信してまだ encoded 応答が返っていない
 * フレーム数を上限側の近似として数える)。
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
 *
 * 送受信の対応は ./workerMessages を正本とする。
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
 * Worker 側の実行時エラーを応答メッセージへ変換する
 *
 * `"error"` 応答の message は常に非空 string である (WorkerInitResult と同じ契約)。
 */
export function workerErrorResponse(error: unknown): WorkerErrorResponse {
  return { type: "error", message: toFailureMessage(error) };
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
 * Worker へ送信中のフレーム数を数える純粋カウンタ
 *
 * Worker モードのエンコーダは Worker 内の VideoEncoder.encodeQueueSize を取得できないため、
 * 「encode メッセージを送ってまだ encoded 応答が返っていないフレーム数」を数える。
 * Worker のメッセージ待ち行列と encoder のキューを合わせた上限側の近似であり、
 * 実際より多く見える安全側に倒れる。
 *
 * 増加は postMessage の成功後、減算は応答の処理前に行う。0 未満にはならない。
 * configure による Worker の差し替え (旧 Worker は terminate されて応答が返らない) と
 * close では reset する。
 */
export class SentFrameCounter {
  private sentFrames = 0;

  /** 送信したフレームを数える (postMessage の成功後) */
  increment(): void {
    this.sentFrames++;
  }

  /** 応答を受け取ったフレームを減らす (0 未満にはならない) */
  decrement(): void {
    if (this.sentFrames > 0) {
      this.sentFrames--;
    }
  }

  /** Worker の差し替え / close で 0 に戻す */
  reset(): void {
    this.sentFrames = 0;
  }

  /** 送信中のフレーム数 */
  get size(): number {
    return this.sentFrames;
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

/**
 * Wrapper 側の Worker 公開スロット
 *
 * `configureWrapperWorker` が「現在公開中の Worker」を読み書きするために使う。
 * ラッパーは自分の `worker` フィールドを閉じ込めた実装を渡す。
 */
export interface WrapperWorkerSlot {
  /** 現在公開中の Worker を返す (未公開なら null) */
  get(): Worker | null;
  /** 公開中の Worker を差し替え、旧 Worker を返す (呼び出し側が破棄する) */
  swap(worker: Worker | null): Worker | null;
}

/**
 * ラッパーの `worker` フィールドを読み書きするスロットを作る
 *
 * @param get - 現在のフィールド値を返す関数
 * @param set - フィールドへ代入する関数
 */
export function wrapperWorkerSlot(
  get: () => Worker | null,
  set: (worker: Worker | null) => void,
): WrapperWorkerSlot {
  return {
    get,
    swap(worker: Worker | null): Worker | null {
      const previous = get();
      set(worker);
      return previous;
    },
  };
}

/**
 * Wrapper 側の Worker 初期化フロー
 *
 * 4 ラッパーで同一だった次を 1 箇所に集約する。
 *
 * 1. configure() 発行ごとに世代を採番する
 * 2. Worker モジュールを読み込み、待機中に旧世代化したら生成せず離脱する
 * 3. Worker を生成し、`{type: "init", config}` を送る
 * 4. `"configured"` で resolve、`"error"` / onerror で reject (初期化完了後は通知)
 * 5. 最新世代なら旧公開を破棄して公開 (後勝ち)、旧世代の遅延成功は自世代を破棄して reject
 *
 * データ応答 (`"encoded"` / `"decoded"` / `"skipped"` など) はラッパーごとに
 * 異なるため `handleWorkerData` へ委譲する。
 *
 * @param options - 設定。`slot` は呼び出し元の Worker フィールドを読み書きする
 */
export async function configureWrapperWorker(options: {
  /** Worker へ送る configure 設定 */
  config: unknown;
  /** 世代管理 (ラッパーが保持する) */
  tracker: ConfigureGenerationTracker;
  /** 公開中 Worker の読み書き */
  slot: WrapperWorkerSlot;
  /** Vite の `?worker` import で Worker モジュールを読み込む */
  loadWorkerModule(): Promise<{ default: new () => Worker }>;
  /** 委譲するデータ応答の `type` 一覧 (契約外の応答は無視する) */
  dataTypes: readonly string[];
  /**
   * `"configured"` / `"error"` 以外の応答を処理する
   *
   * 応答の型は ./workerMessages を正本とし、`dataTypes` で絞った type だけが届く。
   * 呼び出し側で具体的な応答型へ絞り込む。
   */
  handleWorkerData?(message: { type: string }): void;
  /** 初期化完了後に届いた `"error"` / onerror の通知先 */
  notifyError(error: Error): void;
}): Promise<void> {
  // 世代採番は待機より前 (動的 import の解決順に依存させない)。
  // 生成した worker と世代を対応付ける。
  // import 失敗時は世代のみ消費する空番になるが、isLatest() は公開時のみ
  // 参照するため無害である。
  const generation = options.tracker.begin();
  const WorkerModule = await options.loadWorkerModule();
  // 待機中に旧世代化した場合は Worker を生成せず離脱する (生成の無駄を省く)
  if (!options.tracker.isLatest(generation)) {
    throw new Error("worker configure superseded by newer generation");
  }
  // 生成直後に局所変数へ捕捉する (共有フィールドに置かない)。
  // 並行 configure() の世代分離のため、以降は局所参照のみ使う。
  const worker = new WorkerModule.default();

  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error("worker not initialized"));
      return;
    }

    // 初期化完了前の "error" は configure() の reject とし、
    // 完了後の "error" は従来どおり通知する (二重解決ガード付き)
    const gate = new WorkerConfigureGate();
    const failConfigure = (error: Error) => {
      if (gate.trySettle()) {
        // 失敗した自世代のみ破棄する (他世代の Worker には触らない)
        disposeWorker(worker);
        reject(error);
      } else {
        options.notifyError(error);
      }
    };

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerInitResponse | { type: string };

      switch (message.type) {
        case "configured":
          if (gate.trySettle()) {
            if (options.tracker.isLatest(generation)) {
              // 最新世代: 旧公開を破棄して公開する (後勝ち)
              const previous = options.slot.swap(worker);
              disposeWorker(previous);
              resolve();
            } else {
              // 旧世代の遅延成功: 自世代を破棄する (先発破棄)
              disposeWorker(worker);
              reject(new Error("worker configure superseded by newer generation"));
            }
          }
          break;
        case "error":
          failConfigure(new Error(toFailureMessage((message as { message?: unknown }).message)));
          break;
        default:
          // 契約で定めたデータ応答のみ委譲する。未知の type は無視する
          // (Worker 側の実装変更や別プロトコルの混入で誤動作させない)。
          if (options.dataTypes.includes(message.type)) {
            options.handleWorkerData?.(message);
          }
          break;
      }
    };

    worker.onerror = (event) => {
      failConfigure(new Error(toFailureMessage(event.message)));
    };

    worker.postMessage({
      type: "init",
      config: options.config,
    });
  });
}
