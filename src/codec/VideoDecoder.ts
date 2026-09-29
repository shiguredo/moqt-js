/**
 * ビデオデコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoDecoderWrapperCallbacks } from "./types";
import { getVideoDecoderConfig } from "./config";
import { isVideoDecoderConfigSupported } from "./configSupport";
import { DecoderResetBudget } from "./decoderResetBudget";
import {
  ConfigureGenerationTracker,
  configureWrapperWorker,
  disposeWorker,
  toFailureMessage,
  wrapperWorkerSlot,
} from "./workerConfigure";
import {
  closeCodecQuiet,
  codecStateLabel,
  isCodecConfigured,
  replaceCodec,
  warnCodecNotConfigured,
} from "./codecLifecycle";
import { ignoreUnknownWorkerResponse, type VideoDecoderWorkerData } from "./workerMessages";

/**
 * ビデオデコーダーラッパークラス
 */
export class VideoDecoderWrapper {
  private useWorker: boolean;
  private decoder: VideoDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: VideoDecoderWrapperCallbacks;
  private configured = false;
  // 未構成のまま decode() が呼ばれたことを警告したか (警告を 1 回に絞るためのフラグ。
  // 構成に成功すると戻す)
  private warnedNotConfigured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();
  // 直接モード用: キーフレーム待ちフラグ
  private needsKeyframe = true;
  private lastConfig: VideoDecoderConfig | null = null;
  // 復帰の予算 (同じ config で復号フレームを得ないまま再初期化できる回数)。
  // 消費は reset()、復帰は configure() と復号フレームの出力
  private readonly resetBudget = new DecoderResetBudget();

  constructor(useWorker: boolean, callbacks: VideoDecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * デコーダーを設定する
   *
   * 非対応 codec では Worker も VideoDecoder も作らずに失敗する
   * (対応確認は Worker の生成 / VideoDecoder の configure の直前で行う)。
   * 対応確認の await 中に close() や reset() などの後発の構成操作が始まった場合も
   * 作らずに失敗する (解放のあとに作った Worker と VideoDecoder は誰も破棄しない)。
   */
  async configure(
    codec: VideoCodecType,
    width: number,
    height: number,
    description?: Uint8Array,
  ): Promise<void> {
    const config = getVideoDecoderConfig(codec, width, height, description);

    // configure() は呼び出し側が要求した新しい設定であるため、復帰の予算を戻す。
    // getVideoDecoderConfig() が毎回新しいオブジェクトを作るため参照の比較は常に真で
    // あり、configure() が呼ばれたら戻すという規則そのものになる。
    // reset() は configure() を通らず同じ設定で再入するため、この経路では戻らない
    // (戻すと上限が無効になり、恒久エラーで再生成が止まらない)
    this.resetBudget.restore();
    this.lastConfig = config;

    await this.applyConfig(config);
    this.markConfigured();
  }

  /**
   * 対応確認の後に Worker または VideoDecoder を構成する
   *
   * configure() が通る経路である。reset() は対応確認を破棄より先に済ませる必要がある
   * ため、こちらを通らず configureCodec() を直接呼ぶ。
   *
   * 対応確認の await 中に後発の構成操作 (別の configure() / reset() / close()) が
   * 始まっていれば、その操作がデコーダーの所有権を持つため、ここでは何も作らずに
   * 失敗する。作ると、解放のあとに生成した Worker と VideoDecoder を誰も破棄せず
   * (createMediaSubscriber は解放時に参照を切ってから閉じる)、configured も true に
   * 戻って close() の終端契約に反する。
   */
  private async applyConfig(config: VideoDecoderConfig): Promise<void> {
    // 対応確認の await 中に破棄 (teardown() の invalidateAll()) が起きたかを判定する
    // ため、対応確認より前の世代を控える
    const entryGeneration = this.generationTracker.currentGeneration;

    await this.assertConfigSupported(config);

    // 後発の構成操作が始まっていれば、その操作がデコーダーの所有権を持つ。別の
    // configure() は新しい設定を lastConfig へ代入してから待つため設定の比較で分かり、
    // close() と reset() の破棄、Worker モードの configure() の世代採番は世代番号で分かる
    if (this.lastConfig !== config || !this.generationTracker.isLatest(entryGeneration)) {
      throw new Error("video decoder configure superseded by newer generation");
    }

    await this.configureCodec(config);
  }

  /**
   * Worker または VideoDecoder を構成する (対応確認は呼び出し元が済ませている)
   *
   * 呼び出しは同期で行う。直接モードの configureDirect() は同期で構成するため完了を
   * 待つものが無く、Worker モードの configureWorker() は世代の採番を同期で行ってから
   * Worker モジュールの読み込みを待つ。戻り値の Promise で完了を待つ。
   */
  private configureCodec(config: VideoDecoderConfig): Promise<void> {
    if (this.useWorker) {
      return this.configureWorker(config);
    }
    this.configureDirect(config);
    return Promise.resolve();
  }

  /**
   * 設定が実ブラウザで復号に対応しているかを確かめる
   *
   * 判定規則は ./configSupport を正本とする (devtools のテストページと同じ規則)。
   * 非対応なら Worker も VideoDecoder も作らず、codec 文字列を含むエラーで失敗する。
   * WebCodecs 非搭載の環境は configSupport が別の文言のエラーで失敗させる。
   */
  private async assertConfigSupported(config: VideoDecoderConfig): Promise<void> {
    if (!(await isVideoDecoderConfigSupported(config))) {
      throw new Error(`Decoder codec not supported: ${config.codec}`);
    }
  }

  private async configureWorker(config: VideoDecoderConfig): Promise<void> {
    await configureWrapperWorker({
      config,
      tracker: this.generationTracker,
      slot: wrapperWorkerSlot(
        () => this.worker,
        (worker) => {
          this.worker = worker;
        },
      ),
      dataTypes: ["decoded", "skipped"],
      loadWorkerModule: () => import("./workers/videoDecoder.worker?worker"),
      handleWorkerData: (response) => {
        const message = response as VideoDecoderWorkerData;
        switch (message.type) {
          case "decoded":
            // 復号フレームを出力したので復帰の予算を戻す
            this.resetBudget.restore();
            this.callbacks.output({
              frame: message.frame,
            });
            break;
          case "skipped":
            // キーフレーム待ちでスキップされたフレームは無視
            break;
          default:
            ignoreUnknownWorkerResponse(message);
        }
      },
      notifyError: (error) => this.callbacks.error(error),
    });
  }

  private configureDirect(config: VideoDecoderConfig): void {
    // 新しいデコーダーはキーフレームを必要とする
    this.needsKeyframe = true;

    this.decoder = replaceCodec(
      this.decoder,
      new VideoDecoder({
        output: (frame: VideoFrame) => {
          // 復号フレームを出力したので復帰の予算を戻す
          this.resetBudget.restore();
          this.callbacks.output({
            frame,
          });
        },
        error: (error: DOMException) => {
          this.callbacks.error(new Error(error.message));
        },
      }),
    );

    this.decoder.configure(config);
  }

  /**
   * デコーダーの状態を取得する
   */
  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.decoder);
  }

  /**
   * エンコードされたビデオチャンクをデコードする
   */
  decode(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void {
    if (!this.configured) {
      this.warnNotConfiguredOnce();
      return;
    }

    // 公開中の最新世代に送る (待機中の未公開世代には送らない)。
    // 再 configure() 待機中は旧公開が受け、公開切り替え後に新世代へ切り替わる。
    if (this.useWorker && this.worker) {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.worker.postMessage(
        {
          type: "decode",
          data: buffer,
          chunkType: type,
          timestamp,
          duration,
        },
        [buffer],
      );
    } else if (isCodecConfigured(this.decoder)) {
      // キーフレームが必要な状態でデルタフレームを受信した場合はスキップ
      if (this.needsKeyframe && type !== "key") {
        return;
      }

      // キーフレームを受信したらフラグをリセット
      if (type === "key") {
        this.needsKeyframe = false;
      }

      const chunk = new EncodedVideoChunk({
        type,
        timestamp,
        duration,
        data,
      });
      try {
        this.decoder.decode(chunk);
      } catch (error) {
        this.callbacks.error(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * 未構成で decode() が呼ばれたことを 1 回だけ警告する
   *
   * reset() の打ち切り後も呼び出し側は decode() を呼び続ける (受信のたびに呼ばれる)。
   * 呼び出しのたびに警告すると 30 fps の受信で毎秒 30 件の警告になり、ログが埋まって
   * 他の異常が見えなくなる。未構成になった最初の 1 回だけ警告し、configure() /
   * reset() で再び構成されたら次に未構成で呼ばれたときにまた 1 回警告する。
   */
  private warnNotConfiguredOnce(): void {
    if (this.warnedNotConfigured) {
      return;
    }
    this.warnedNotConfigured = true;
    warnCodecNotConfigured("VideoDecoderWrapper");
  }

  /**
   * キーフレーム待ち状態にリセットする
   */
  resetKeyframeWait(): void {
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "resetKeyframeWait" });
    } else {
      this.needsKeyframe = true;
    }
  }

  /**
   * エラー後にデコーダーを再初期化する
   *
   * 同じ config で再初期化できる回数には上限がある (DecoderResetBudget)。
   * 再初期化できた場合は true、次のいずれかなら false を返す。
   *
   * - 復帰の予算を使い切った
   * - lastConfig が無い (configure 前)
   * - 対応確認で非対応と判定された (WebCodecs 非搭載を含む)
   * - 自世代の configure が失敗した
   * - 呼び出し後に対応確認より先へ進んだ後発の構成操作 (configure() / reset() /
   *   close()) に追い越された
   *
   * 例外は投げない (打ち切りの破棄が失敗した場合も警告に残すだけで reject しない)。
   * false の場合は次の 2 通りがある。
   *
   * - 打ち切った: Worker も VideoDecoder も破棄して configured を false にする
   *   (close() と同じ後始末)。以降の decode() は configured が false のため
   *   警告して何もしない
   * - 追い越された: デコーダーの所有権は後発の構成操作にあるため、この reset() は
   *   何もせず false を返す (後発の構成結果はそのまま残る)
   *
   * いずれの場合も callbacks.error は呼ばない (呼ぶと error コールバックが reset() を
   * 再入させ、恒久エラーで通知と再生成が止まらない)。
   *
   * @returns 再初期化した場合は true、再初期化しなかった場合は false
   */
  async reset(): Promise<boolean> {
    const config = this.lastConfig;
    if (config === null) {
      console.warn("VideoDecoderWrapper: cannot reset without config");
      this.teardownQuietly();
      return false;
    }

    // 予算は再初期化の試行で消費する (成功の数ではない)。
    // 使い切っていたら再初期化せずに打ち切る
    if (!this.resetBudget.tryConsume()) {
      console.warn("VideoDecoderWrapper: reset budget exhausted");
      this.teardownQuietly();
      return false;
    }

    // 対応確認の await 中に後発の構成操作が始まったかを判定するため、対応確認より
    // 前の世代を控える
    const entryGeneration = this.generationTracker.currentGeneration;

    // 対応確認は破棄より先に行う。非対応と分かった時点で作り直しの手順に入らずに
    // 打ち切れる (破棄は abortReset が行う)。失敗理由はそのまま警告に載せる
    let supportError: Error | null = null;
    try {
      await this.assertConfigSupported(config);
    } catch (error) {
      supportError = error instanceof Error ? error : new Error(String(error));
    }

    // 対応確認の await 中に後発の構成操作が始まっていれば、その操作がデコーダーの
    // 所有権を持つ。configure() は新しい設定を lastConfig へ代入してから待つため
    // 設定の比較で分かり、close() と別の reset() の破棄、Worker モードの configure() の
    // 世代採番は世代番号で分かる (直接モードの configure() は世代を採番しないため、
    // 設定の比較も必要になる)
    const superseded =
      this.lastConfig !== config || !this.generationTracker.isLatest(entryGeneration);

    if (supportError !== null) {
      if (superseded) {
        return false;
      }
      return this.abortReset(supportError.message);
    }
    if (superseded) {
      // 後発の構成操作が新しい設定で構成する。ここで作り直すと呼び出し側が最後に
      // 要求した設定ではなく古い設定へ戻り、破棄すると後発のデコーダーまで壊れる
      return false;
    }

    let restarted: { pending: Promise<void>; generation: number };
    try {
      // 破棄と構成の間に await を挟まない (restartCodec が同期で行う)
      restarted = this.restartCodec(config);
    } catch (error) {
      // 直接モードの構成は同期で失敗しうる (restartCodec 内の破棄の失敗もここへ来る)。
      // 破棄から連続しているため後発世代に追い越されておらず、自世代の失敗として破棄する
      return this.abortReset(toFailureMessage(error));
    }

    try {
      await restarted.pending;
    } catch (error) {
      // 自世代の configure が失敗した。既に後発世代に追い越されていれば公開中の
      // デコーダーは後発世代のものであり、teardown() は全世代を無効化するため触らない
      if (!this.generationTracker.isLatest(restarted.generation)) {
        return false;
      }
      return this.abortReset(toFailureMessage(error));
    }

    this.markConfigured();
    return true;
  }

  /**
   * reset() を打ち切る (Worker と VideoDecoder を破棄して false を返す)
   *
   * @param message - 失敗理由 (警告に載せる)
   */
  private abortReset(message: string): false {
    console.warn(`VideoDecoderWrapper: reset failed: ${message}`);
    this.teardownQuietly();
    return false;
  }

  /**
   * 打ち切りのために破棄する (破棄の失敗を reset() の reject にしない)
   *
   * reset() は例外を投げない契約であり、呼び出し側 (createMediaSubscriber) は reject が
   * 起きない前提で catch を置かない。破棄 (VideoDecoder の close() / Worker の terminate())
   * が throw しても reject させず、失敗は警告に残すだけにする。
   */
  private teardownQuietly(): void {
    try {
      this.teardown();
    } catch (error) {
      console.warn(`VideoDecoderWrapper: teardown failed: ${toFailureMessage(error)}`);
    }
  }

  /**
   * デコーダーを破棄して同じ設定で作り直す
   *
   * 破棄 (世代の無効化と Worker / VideoDecoder の破棄) と構成 (世代の採番と Worker の
   * 生成 / VideoDecoder の configure) の間に await を挟まない。挟むと、その間に別の
   * configure() の begin() が割り込んで世代の所有権が移る。
   *
   * 戻り値の generation は構成が採番した自世代である (Worker モードは
   * configureWrapperWorker() が同期で採番し、直接モードは破棄の無効化が進めた世代に
   * なる)。後発世代に追い越されたかの判定に使う。
   *
   * @param config - 作り直す設定
   * @returns pending は構成の完了を待つ Promise、generation は自世代
   */
  private restartCodec(config: VideoDecoderConfig): {
    pending: Promise<void>;
    generation: number;
  } {
    this.teardown();
    const pending = this.configureCodec(config);
    return { pending, generation: this.generationTracker.currentGeneration };
  }

  /**
   * デコーダーを閉じる
   *
   * 待機中の configure() は世代の無効化で中断する (解放のあとに Worker や
   * VideoDecoder を作ることはなく、失敗する)。終端であり、close() 後の reset() は
   * 保証しない (lastConfig は残るため、呼ぶと作り直して true を返し得る。ライブラリ内に
   * その経路は無い)。
   */
  close(): void {
    this.teardown();
  }

  /**
   * 構成済みにする
   *
   * 未構成で decode() を呼んだときの警告を出す条件もここで戻す (再び構成されたら、
   * 次に未構成で呼ばれたときに 1 回だけ警告する)。
   */
  private markConfigured(): void {
    this.configured = true;
    this.warnedNotConfigured = false;
  }

  /**
   * Worker または VideoDecoder を破棄する (close() と同じ後始末)
   *
   * 待機中の configure 世代を無効化し (遅延成功した旧世代は破棄・reject される)、
   * 公開中の Worker または VideoDecoder を破棄して configured を false にする。
   * 破棄は同期で行う (await を挟むと、その間に他 configure() の begin() が割り込んで
   * 世代の所有権が移る)。
   */
  private teardown(): void {
    // 待機中の configure 世代を無効化する。
    // 遅延成功した旧世代は破棄・reject される (中断扱い)。
    this.generationTracker.invalidateAll();

    // 破棄する対象を控え、保持している参照と configured を破棄より先に落とす。
    // 破棄 (close() / terminate()) が throw しても、打ち切り後の decode() が復号を
    // 続けない (configured が false で参照も null) ようにするためである
    const closingWorker = this.worker;
    const closingDecoder = this.decoder;
    this.worker = null;
    this.decoder = null;
    this.configured = false;

    if (this.useWorker && closingWorker) {
      disposeWorker(closingWorker);
    } else if (closingDecoder) {
      closeCodecQuiet(closingDecoder);
    }
  }
}
