// EncoderWrapper: Worker と直接実行を抽象化するラッパー

// コーデックのライフサイクル (state 判定、閉じる前の確認、状態のラベル) と、Worker の
// 後始末・世代管理・初期化の待機のガード・送信中のフレーム数のカウンタ・失敗理由の
// 文言化は、ライブラリ側と同じ規則で動かす必要があるため共有モジュールを import する
// (devtools 用に別実装を作らない)
import {
  closeCodecQuiet,
  codecStateLabel,
  isCodecConfigured,
  replaceCodec,
  warnCodecNotConfigured,
} from "../../../src/codec/codecLifecycle.ts";
import {
  ConfigureGenerationTracker,
  SentFrameCounter,
  WorkerConfigureGate,
  disposeWorker,
  toFailureMessage,
  type WorkerInitResult,
} from "../../../src/codec/workerConfigure.ts";

export interface EncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}

export interface EncoderWrapperCallbacks {
  output: (chunk: EncodedChunkData) => void;
  error: (error: Error) => void;
}

export class EncoderWrapper {
  private useWorker: boolean;
  private encoder: VideoEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: EncoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理。Worker の初期化の応答を待つ間に close() や後発の
  // configure() が始まったかを判定する (追い越された configure() は Worker を公開しない)
  private readonly generationTracker = new ConfigureGenerationTracker();
  // 待機中の configure() を中断する口 (世代ごと)。close() と再 configure は Worker の配送口を
  // 外して terminate するため、この口から待機を終わらせないと configure() の Promise が
  // 永久に未解決のまま残り、呼び出し側が待ち続ける。世代ごとに持つのは、破棄のときに
  // 待機している全世代を中断しつつ、解決した世代が自分の口だけを外して他の世代の
  // 待機を壊さないためである
  private readonly pendingConfigureAborts = new Map<number, () => void>();
  // Worker モードで Worker へ送信してまだ encoded 応答が返っていないフレーム数
  // (Worker 内の encodeQueueSize は取得できないため、上限側の近似として数える)
  private readonly sentFrames = new SentFrameCounter();

  constructor(useWorker: boolean, callbacks: EncoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  async configure(config: VideoEncoderConfig): Promise<void> {
    if (this.useWorker) {
      try {
        await this.configureWorker(config);
      } catch (error) {
        // 失敗した configure では投入を止める。Worker は破棄済みか設定できておらず
        // encoded 応答が返らないため、configured を立てたまま残すと閾値に張り付く
        this.configured = false;
        throw error;
      }
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  /**
   * Worker を生成して設定する
   *
   * 再 configure では旧 Worker を先に破棄する (close() と同じ後始末)。破棄しないと
   * 旧 Worker の onmessage が残り、旧世代の encoded 応答が新しい Worker へ送った
   * フレームの数まで減らす。
   *
   * Worker の生成は同期で行う。待つ間に encode() されたフレームは新しい Worker へ
   * 送られて数えられるため、生成を待機の後ろへ遅らせてはならない (遅らせると、
   * 差し替えの直後に投入されたフレームがどの Worker へも送られず、数からも漏れる)。
   *
   * 初期化の応答を待つ間に close() が呼ばれる経路は到達し得る (配信の停止操作と、
   * WebTransport の close / error から cleanupPublisher が close() を呼ぶ)。待機中の
   * configure() は世代の無効化で中断し、追い越しとして失敗する (初期化の応答が
   * 返らなくなった Worker を公開しない)。
   */
  private async configureWorker(config: VideoEncoderConfig): Promise<void> {
    // 再 configure では旧 Worker を先に破棄する (close() と同じ後始末)。破棄は待機中の
    // configure() を中断する (追い越された configure() は失敗する)
    this.teardownWorker();
    // 世代は破棄の後に採番する (中断した世代を最新のまま残さない)
    const generation = this.generationTracker.begin();
    // 旧 Worker は破棄済みで encoded 応答が返らないため、ここで送信中の数を 0 に戻す。
    // 差し替えの直後 (同期) に戻すのは、configure の応答を待つ間に新しい Worker へ送った
    // フレームの数まで消さないため (待った後に戻すと実際より少なく見える)。
    // 戻さないと、応答が返らないフレームの数が閾値を超えたまま残って張り付く
    this.sentFrames.reset();

    // Vite の ?worker は仮想モジュールであり、型は src/types.d.ts の `declare module "*?worker"`
    // が正本である。静的 import すると oxlint の import/default / import/namespace がクエリを
    // 外して実ファイル (encoder.worker.ts) を解決し、default export が無いと誤検知する。
    // webcodecs-devtools/signals.ts と同じ形 (new Worker + new URL) で作る
    const worker = new Worker(
      new URL("../webcodecs-devtools/workers/encoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker = worker;

    // 初期化の応答 ("configured" / "error" / onerror) か、待機の中断を待つ。中断は null で
    // 届き、追い越しの判定は待機の後に 1 箇所で行う
    const initResult = await new Promise<WorkerInitResult | null>((resolve) => {
      // 待機を終わらせるのは最初の 1 回だけにする (中断と初期化の応答が競合しても
      // 二重に settle させない)
      const gate = new WorkerConfigureGate();
      // 初期化が終わる前の失敗は configure() の reject、終わった後の失敗は通知にする
      // (ライブラリの configureWrapperWorker と同じ扱い)
      let configuredResolved = false;

      /**
       * 待機を終える
       *
       * 中断の口は自分の世代の分だけ外す。他の世代の口を外すと、その世代の待機を
       * 中断できなくなり、configure() の Promise が未解決のまま残る。
       *
       * @param result - 初期化の応答。中断の場合は null
       */
      const settle = (result: WorkerInitResult | null): void => {
        if (!gate.trySettle()) {
          return;
        }
        this.pendingConfigureAborts.delete(generation);
        resolve(result);
      };

      // 中断の口を控える。中断する側は Worker の配送口を外すため、控えないと待機を
      // 終わらせられず、configure() の Promise が未解決のまま残る
      this.pendingConfigureAborts.set(generation, () => {
        settle(null);
      });

      /**
       * Worker の失敗 ("error" 応答 / error イベント) を処理する
       *
       * 破棄するのは自世代の Worker だけである。今の Worker と送信中の数、configured に
       * 触るのは、失敗した Worker が今の Worker のときだけにする。破棄は disposeWorker が
       * 配送口を外してから terminate するため、追い越された世代の配送口からこの処理が
       * 呼ばれることは通常ないが、呼ばれても後始末が自世代の中で完結し、別世代の Worker と
       * 待機を巻き込まないようにしておく (巻き込むと、後発の configure() が解決しなくなる)。
       *
       * @param error - 失敗の理由
       */
      const handleWorkerFailure = (error: Error): void => {
        // 初期化が終わる前の失敗は configure() の reject として伝える。待機を破棄より
        // 先に終わらせるのは、破棄の中断で待機が終わると失敗の理由が追い越しのエラーに
        // 化けるためである
        const initFailed = !configuredResolved;
        if (initFailed) {
          settle({ type: "error", message: error.message });
        }
        // 自世代の Worker は自世代で破棄する (後始末を今の Worker に委ねない)
        disposeWorker(worker);
        if (this.worker !== worker) {
          return;
        }
        // 失敗した Worker は encoded 応答を返さないため、送信中の数を 0 に戻して投入を
        // 止める。戻さないと閾値を超えたまま張り付き、以後すべてのフレームが破棄される
        this.worker = null;
        this.sentFrames.reset();
        this.configured = false;
        if (!initFailed) {
          // 初期化の後に届いた error は通知する (復帰は再 configure か close による)
          this.callbacks.error(error);
        }
      };

      worker.onmessage = (e: MessageEvent) => {
        const message = e.data;

        switch (message.type) {
          case "configured":
            configuredResolved = true;
            settle({ type: "configured" });
            break;
          case "encoded":
            // 応答が返ったフレームを数から外す。output が例外を投げても数が戻るよう先に減算する
            this.sentFrames.decrement();
            this.callbacks.output({
              data: new Uint8Array(message.data),
              type: message.chunkType,
              timestamp: message.timestamp,
              duration: message.duration,
              // exactOptionalPropertyTypes では optional な description に undefined を
              // 渡せないため、description がある場合だけ載せる
              ...(message.description ? { description: new Uint8Array(message.description) } : {}),
            });
            break;
          case "error":
            // 契約では "error" 応答の message は非空である。空の応答が届いても理由が
            // 消えないよう、受信側でも文言化を通す (共有モジュールの toFailureMessage)
            handleWorkerFailure(new Error(toFailureMessage(message.message)));
            break;
        }
      };

      worker.onerror = (e) => {
        // ErrorEvent.message は空になり得るため、文言化を通してから通知する
        handleWorkerFailure(new Error(toFailureMessage(e.message)));
      };

      worker.postMessage({
        type: "init",
        config,
      });
    });

    // 待機中に close() / 後発の configure() が世代を無効化していれば、その操作が Worker の
    // 所有権を持つ。ここで成功として扱うと、破棄済みの Worker を公開したまま configured を
    // 立ててしまう (停止した配信のフレームを投入し続ける)。
    // 無効化する側は Worker の配送口を外すため、中断は null として待機を終わらせる。
    // 世代の判定はライブラリの configureWrapperWorker と同じ所有権の規則であり、
    // 破棄を伴わない無効化が加わっても公開を止められるように残す
    if (initResult === null || !this.generationTracker.isLatest(generation)) {
      throw new Error("encoder configure superseded by newer generation");
    }
    if (initResult.type === "error") {
      // 初期化の失敗は configure() の reject として伝える (Worker は破棄済み)
      throw new Error(initResult.message);
    }
  }

  private async configureDirect(config: VideoEncoderConfig): Promise<void> {
    this.encoder = replaceCodec(
      this.encoder,
      new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);

          let description: Uint8Array | undefined;
          if (metadata?.decoderConfig?.description) {
            const desc = metadata.decoderConfig.description;
            if (desc instanceof ArrayBuffer) {
              description = new Uint8Array(desc);
            } else if (ArrayBuffer.isView(desc)) {
              description = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
            }
          }

          this.callbacks.output({
            data,
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            // exactOptionalPropertyTypes では optional な description に undefined を
            // 渡せないため、description がある場合だけ載せる
            ...(description !== undefined ? { description } : {}),
          });
        },
        error: (error: DOMException) => {
          this.callbacks.error(new Error(error.message));
        },
      }),
    );

    this.encoder.configure(config);
  }

  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    if (!this.configured) {
      warnCodecNotConfigured("EncoderWrapper");
      return;
    }

    if (this.useWorker && this.worker) {
      // Worker モードでは frame を transfer する
      // transfer 後は呼び出し元で frame.close() を呼んでも安全（no-op）
      this.worker.postMessage(
        {
          type: "encode",
          frame,
          keyFrame: options?.keyFrame ?? false,
        },
        [frame],
      );
      // postMessage が成功した後に数える (throw した場合に減らない数を残さない)
      this.sentFrames.increment();
    } else if (isCodecConfigured(this.encoder)) {
      // 直接モードではエンコードのみ実行
      // frame.close() は呼び出し元が責任を持つ
      this.encoder.encode(frame, options);
    }
  }

  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.encoder);
  }

  /**
   * エンコードキューのサイズを取得する
   *
   * 直接モードでは VideoEncoder.encodeQueueSize (実キュー長) を返す。
   * Worker モードでは Worker 内のキュー長を取得できないため、Worker へ送信してまだ
   * encoded 応答が返っていないフレーム数を返す (Worker のメッセージ待ち行列と
   * encoder のキューを合わせた上限側の近似。実際より多く見える安全側に倒れる)。
   * configure による Worker の差し替えと close、Worker が error を返したときにも 0 に戻る。
   */
  get encodeQueueSize(): number {
    if (this.useWorker) {
      return this.sentFrames.size;
    }
    return this.encoder?.encodeQueueSize ?? 0;
  }

  /**
   * Worker を破棄する
   *
   * close() と再 configure の前で共有する。破棄の前に配送口を外すため、破棄の後に
   * 届く旧世代の応答がコールバックを呼んだりカウンタを減らしたりしない。
   * close メッセージは送らない。terminate は Worker をただちに止めるため、close を
   * 送っても処理される保証が無い (ライブラリの disposeWorker と同じ判断。Worker 内の
   * VideoEncoder は明示的に閉じず、Worker ごと捨てる扱いにする)。
   *
   * 配送口を外す前に待機中の configure() を中断する。外した後では初期化の応答が
   * 届かず、待機中の Promise を誰も settle させられない。
   */
  private teardownWorker(): void {
    const closingWorker = this.worker;
    this.worker = null;
    // 中断は破棄より先に行う (配送口を外した後では初期化の応答が届かない)
    this.abortPendingConfigures();
    disposeWorker(closingWorker);
  }

  /**
   * 待機中の configure() をすべて中断する
   *
   * 中断の口は世代ごとにあるため、1 つずつすべて呼ぶ (1 つでも残ると、その世代の
   * configure() の Promise が未解決のまま残る)。呼ぶ前に控えを外すのは、中断の口が
   * 自分の世代の分だけを外す作りのため、控えを取らずに呼ぶと同じ口を二度呼び得るためである。
   */
  private abortPendingConfigures(): void {
    const aborts = [...this.pendingConfigureAborts.values()];
    this.pendingConfigureAborts.clear();
    for (const abort of aborts) {
      abort();
    }
  }

  close(): void {
    // 待機中の configure 世代を無効化する。待機中の configure() は破棄の中断と世代の
    // 判定で追い越しとして失敗し、遅延成功した旧世代の構成は公開されない
    this.generationTracker.invalidateAll();
    // Worker の差し替え / close では送信中の数を 0 に戻す。残すと再 configure の後に
    // 閾値を超えたまま張り付き、以後すべてのフレームが破棄される
    this.sentFrames.reset();
    if (this.useWorker) {
      this.teardownWorker();
    } else {
      // 既に closed の encoder へ close() を呼ぶと例外になる。状態を見る判定は
      // 共有モジュール (closeCodecQuiet) に任せる
      closeCodecQuiet(this.encoder);
      this.encoder = null;
    }
    this.configured = false;
  }
}
