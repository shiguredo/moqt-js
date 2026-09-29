// DecoderWrapper: Worker と直接実行を抽象化するラッパー

// 対応確認・復帰の予算・コーデックのライフサイクル・Worker の初期化契約は、ライブラリ側と
// 同じ規則で動かす必要があるため共有モジュールを import する (devtools 用に別実装を作らない)
import { isVideoDecoderConfigSupported } from "../../../src/codec/configSupport.ts";
import { DecoderResetBudget } from "../../../src/codec/decoderResetBudget.ts";
import {
  closeCodecQuiet,
  codecStateLabel,
  isCodecConfigured,
  replaceCodec,
  warnCodecNotConfigured,
} from "../../../src/codec/codecLifecycle.ts";
import {
  ConfigureGenerationTracker,
  configureWrapperWorker,
  disposeWorker,
  wrapperWorkerSlot,
} from "../../../src/codec/workerConfigure.ts";
// Worker の応答の型はライブラリ側と共有する (devtools の Worker も同じプロトコルで応答する)
import {
  ignoreUnknownWorkerResponse,
  type VideoDecoderWorkerData,
} from "../../../src/codec/workerMessages.ts";

export interface DecodedFrameData {
  frame: VideoFrame;
}

export interface DecoderWrapperCallbacks {
  output: (data: DecodedFrameData) => void;
  error: (error: Error) => void;
}

export class DecoderWrapper {
  private useWorker: boolean;
  private decoder: VideoDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: DecoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理。対応確認を await している間に後発の構成操作
  // (別の configure() / reset() / close()) が始まったかを判定する
  private readonly generationTracker = new ConfigureGenerationTracker();
  // close() 済みか。close() は終端であり、以降の reset() は作り直さずに false を返す
  private closed = false;
  // 未構成のまま decode() が呼ばれたことを警告したか (打ち切り後の受信で警告が
  // 毎フレーム出るのを防ぐため 1 回に絞る。構成に成功すると戻す)
  private warnedNotConfigured = false;
  // 直接モード用: キーフレーム待ちフラグ
  private needsKeyframe = true;
  // 最後に使用した設定（リセット用）
  private lastConfig: VideoDecoderConfig | null = null;
  // 復帰の予算 (ライブラリ側と共有する純粋クラス)。devtools が戻すのは configure に
  // 渡された設定が直前と参照の異なる場合だけで、reset() の再入では戻さない
  private readonly resetBudget = new DecoderResetBudget();

  constructor(useWorker: boolean, callbacks: DecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * デコーダーを設定する
   *
   * 非対応 codec では Worker も VideoDecoder も作らず、`Decoder codec not supported: <codec>`
   * で reject する。対応確認は Worker の生成 / VideoDecoder の configure より前に行い、
   * 非対応と判定した設定は lastConfig に残さない (reset() が同じ設定を再試行しないようにする)。
   *
   * 対応確認の await 中に close() / 別の configure() / 別の reset() が始まった場合は、
   * その操作がデコーダーの所有権を持つため作らずに失敗する。close() のあとに作った
   * Worker と VideoDecoder は誰も破棄せず、configured も true に戻ってしまう。
   */
  async configure(config: VideoDecoderConfig): Promise<void> {
    // 対応確認より前の世代を控える。世代は別の configure() の採番と、close() / reset() の
    // 破棄 (teardown) の無効化で進む
    const entryGeneration = this.generationTracker.begin();

    // 対応確認の判定規則は src/codec/configSupport.ts を正本とする (false と reject の
    // 両方を非対応として扱い、WebCodecs 非搭載の環境は codec の非対応と区別できる文言で
    // 失敗させる)
    if (!(await isVideoDecoderConfigSupported(config))) {
      throw new Error(`Decoder codec not supported: ${config.codec}`);
    }

    // 対応確認の await 中に後発の構成操作が始まっていれば、その操作がデコーダーの
    // 所有権を持つ (ここで作ると誰も破棄しない)
    if (!this.generationTracker.isLatest(entryGeneration)) {
      throw new Error("decoder configure superseded by newer generation");
    }

    // 直前と参照の異なる設定での configure は復帰の予算を戻す。戻す位置を世代の判定より
    // 後にするのは、追い越されて失敗した configure でも戻すと、呼び出し側が毎回新しい
    // 設定を渡すだけで上限が無効になり、恒久エラーで再生成が止まらなくなるためである。
    // reset() は同じ参照の lastConfig を渡して再入するため、ここへ来ても戻らない
    // (戻すと上限が無効になる)
    const previousConfig = this.lastConfig;
    this.lastConfig = config;
    if (previousConfig !== config) {
      this.resetBudget.restore();
    }

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      this.configureDirect(config);
    }
    this.configured = true;
    // 未構成で decode() を呼ばれたときの警告の状態も戻す (再び構成されたら、次に未構成で
    // 呼ばれたときに 1 回だけ警告する)
    this.warnedNotConfigured = false;
    // 明示的な configure は close() の終端を解く (以降の reset() で再初期化できる)
    this.closed = false;
  }

  /**
   * Worker を生成して設定する
   *
   * Worker の生成・公開・破棄と、初期化応答 ("configured" / "error" / onerror) の処理は
   * src/codec/workerConfigure.ts の契約に委ねる。初期化が完了する前の "error" と onerror は
   * configure() の reject になり (Worker は破棄される)、完了後は error コールバックへ通知する。
   */
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
      // Worker モジュールは Worker を公開する時点で読み込む (生成しただけでは起動しない)
      loadWorkerModule: () => import("../webcodecs-devtools/workers/decoder.worker?worker"),
      handleWorkerData: (response) => {
        // dataTypes で "decoded" / "skipped" だけが届く。型 (VideoDecoderWorkerData) は
        // 初期化応答 ("configured" / "error") を除いた 2 種類だけであり、default は実行時に
        // 到達しない。union にデータ応答が増えたときに case の追加漏れを never の引数で
        // 型検査させるため残す (契約は src/codec/workerMessages.ts を正本とする)
        const message = response as VideoDecoderWorkerData;
        switch (message.type) {
          case "decoded":
            // Worker が復号フレームを 1 枚出力した (予算の復帰条件)
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
          // 復号フレームを 1 枚出力した (予算の復帰条件)
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

  decode(chunk: EncodedVideoChunk): void {
    if (!this.configured) {
      this.warnNotConfiguredOnce();
      return;
    }

    if (this.useWorker && this.worker) {
      // Worker にデータを転送
      // キーフレーム待ちの処理は Worker 側で行う
      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);

      this.worker.postMessage(
        {
          type: "decode",
          data,
          chunkType: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
        },
        [data],
      );
    } else if (isCodecConfigured(this.decoder)) {
      // 直接モード: キーフレーム待ちの処理
      if (this.needsKeyframe && chunk.type !== "key") {
        // キーフレームが必要な状態でデルタフレームを受信した場合はスキップ
        return;
      }

      // キーフレームを受信したらフラグをリセット
      if (chunk.type === "key") {
        this.needsKeyframe = false;
      }

      this.decoder.decode(chunk);
    }
  }

  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.decoder);
  }

  /**
   * 未構成で decode() が呼ばれたことを 1 回だけ警告する
   *
   * reset() の打ち切り後も呼び出し側は decode() を呼び続ける (受信のたびに呼ばれる)。
   * 呼び出しのたびに警告すると 30 fps の受信で毎秒 30 件の警告になり、ログが埋まって
   * 他の異常が見えなくなる。ライブラリ側の VideoDecoderWrapper と同じ扱いに揃え、
   * 未構成になった最初の 1 回だけ警告する。configure() で再び構成されたら、次に
   * 未構成で呼ばれたときにまた 1 回警告する。
   */
  private warnNotConfiguredOnce(): void {
    if (this.warnedNotConfigured) {
      return;
    }
    this.warnedNotConfigured = true;
    warnCodecNotConfigured("DecoderWrapper");
  }

  // キーフレーム待ち状態にリセット
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
   * 同じ設定で再初期化できる回数には上限がある (DecoderResetBudget)。再初期化できた場合は
   * true、次のいずれかなら false を返す。
   *
   * - close() の後である (close() は終端であり、暗黙の再初期化では作り直さない)
   * - 復帰の予算を使い切った (Worker も VideoDecoder も破棄して打ち切る)
   * - lastConfig が無い (configure 前、または非対応 codec で configure が失敗した)
   * - configure が reject した (対応確認で非対応と判定された場合を含む)
   * - 対応確認より先に後発の構成操作が進んだ (追い越された)
   *
   * 例外は投げない。error コールバックは同期のため、呼び出し側 (useSubscriber) は戻り値を
   * await して購読を止めるかどうかを決める。false のときに callbacks.error は呼ばない
   * (呼ぶと error コールバックが reset() を再入させ、再生成が止まらない)。
   *
   * @returns 再初期化した場合は true、再初期化しなかった場合は false
   */
  async reset(): Promise<boolean> {
    if (this.closed) {
      console.warn("DecoderWrapper: cannot reset after close");
      return false;
    }

    const config = this.lastConfig;
    if (config === null) {
      console.warn("DecoderWrapper: cannot reset without config");
      return false;
    }

    // 予算は再初期化の試行で消費する (成功の数ではない)。使い切っていたら Worker も
    // VideoDecoder も作り直さずに打ち切る
    if (!this.resetBudget.tryConsume()) {
      console.warn("DecoderWrapper: reset budget exhausted");
      this.teardownQuietly();
      return false;
    }

    // 作り直す。configure() の対応確認より先に後発の構成操作が進んでいれば、その
    // configure() が世代の判定で失敗する (この経路でも Worker と VideoDecoder は作られない)
    this.teardownQuietly();
    try {
      await this.configure(config);
    } catch (error) {
      // 再初期化の失敗は false として扱う (例外を投げない)。対応確認で非対応と判定した
      // 設定は lastConfig への代入より前に throw するため残らない (構成の失敗では残る)
      console.warn(
        `DecoderWrapper: reset failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  }

  /**
   * デコーダーを閉じる
   *
   * 終端であり、以降の reset() は作り直さずに false を返す。待機中の configure() は
   * 世代の無効化で中断する (解放のあとに Worker や VideoDecoder を作らない)。
   */
  close(): void {
    this.closed = true;
    this.teardown();
  }

  /**
   * Worker または VideoDecoder を破棄する
   *
   * 世代を無効化してから破棄する (待機中の configure() は遅延成功しても公開されず、
   * 失敗する)。破棄する対象を控えて参照と configured を先に落とすため、破棄が throw
   * しても打ち切り後の decode() は復号を続けない。
   *
   * Worker には close メッセージを送らずに terminate する。terminate は Worker の
   * スレッドを即座に破棄するため、送った close が処理される保証が無く、Worker 内の
   * VideoDecoder もスレッドごと解放される (ライブラリ側の VideoDecoderWrapper と同じ
   * 判断)。decoder.worker.ts の "close" は Worker を直接持つ webcodecs-devtools の
   * signals.ts が使う経路であり、この Wrapper からは到達しない。
   */
  private teardown(): void {
    this.generationTracker.invalidateAll();

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

  /**
   * 破棄の失敗で reset() を reject させない (失敗は警告に残す)
   */
  private teardownQuietly(): void {
    try {
      this.teardown();
    } catch (error) {
      console.warn(
        `DecoderWrapper: teardown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
