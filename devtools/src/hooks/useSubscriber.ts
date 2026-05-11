import {
  connect,
  LOC,
  decodeCatalogMessage,
  getVideoTracks,
  CATALOG_TRACK_NAME,
  supportsDynamicGroups,
  type MoqtObject,
  type DebugMessage,
  type JoiningFetchOptions,
  type CatalogTrack,
} from "moqt-js";
import { addLog } from "../components/DebugPanel";
import { DecoderWrapper } from "../utils/DecoderWrapper";
import * as settings from "../signals/connectionSettings";
import * as sub from "../signals/subscriber";
import * as pub from "../signals/publisher";
import { useRef, useEffect } from "preact/hooks";
import { batch } from "@preact/signals";
import type { RefObject } from "preact";

// 複数 Subgroup ストリーム / OBJECT_DATAGRAM の到着順を (groupId, objectId) 昇順へ揃える。
// draft-ietf-moq-transport-17 §2.2 (Subgroups) では Subgroup ストリーム間の配送順は
// 保証されない (個々のストリームは in-order だがストリーム間は publisher 側で
// out of order に送出されうる) ため、バッファドレイン時に明示的にソートする必要がある。
// テストで参照するため export している。
export function toSortedByGroupObject(objects: MoqtObject[]): MoqtObject[] {
  // 引数配列を破壊しないようコピーしてからソートする。
  // signal の .value 配列が直接渡された場合に Preact の変更検知を壊さないため。
  return [...objects].sort((a, b) => {
    if (a.groupId !== b.groupId) {
      return a.groupId < b.groupId ? -1 : 1;
    }
    if (a.objectId !== b.objectId) {
      return a.objectId < b.objectId ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Catalog の `videoTrack` から `VideoDecoderConfig` を組み立てる。
 * canonical 形式 (avc1 / hvc1) で必要な description は MSF Catalog の initData (Base64)
 * から復元する。
 * draft-ietf-moq-msf §5.1.20 / draft-ietf-moq-loc-02 §2.1.2
 */
function buildVideoDecoderConfig(videoTrack: CatalogTrack): VideoDecoderConfig {
  if (!videoTrack.codec) {
    throw new Error("video track codec is not specified in catalog");
  }
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth: videoTrack.width,
    codedHeight: videoTrack.height,
  };
  if (videoTrack.initData) {
    decoderConfig.description = settings.base64ToArrayBuffer(videoTrack.initData);
  }
  return decoderConfig;
}

/**
 * Subscriber インスタンスの統計フィールドを初期値へリセットする。
 * `startSubscribing` 開始時に Joining Fetch / decode カウンタや位置情報をクリアする。
 */
function resetSubscriberStats(
  instance: sub.SubscriberInstance,
  joiningFetchEnabled: boolean,
): void {
  instance.framesDecoded.value = 0;
  instance.keyFramesDecoded.value = 0;
  instance.objectsReceived.value = 0;
  instance.currentGroup.value = 0;
  instance.currentSubGroup.value = 0;
  instance.bytesReceived.value = 0;
  instance.objectsWithExtensions.value = 0;
  instance.chunksCreated.value = 0;
  instance.chunksDecoded.value = 0;
  instance.chunksSkipped.value = 0;
  instance.decodeErrors.value = 0;
  instance.joiningFetchStats.value = null;
  instance.largestLocation.value = null;
  instance.joiningFetchInProgress.value = joiningFetchEnabled;
}

/**
 * `SubscriberInstance` が保持する外部リソース (`decoder` / `session`) を fire-and-forget で
 * close し、canvas を初期色で塗り潰す。
 *
 * WebTransport が close コールバックを同期 dispatch する実装で teardownSubscriber が
 * 再入する可能性があるため、`session.value = null` を `sessionInstance.close()` より
 * 先に立てる順序を維持する (#0150)。
 *
 * canvas 塗り潰しは decoder の停止と一体で行うことで「停止した decoder の最終フレームが
 * 残る」表示不整合を避けるため本関数内に置く。
 */
export function closeSubscriberResources(
  instance: sub.SubscriberInstance,
  canvas: HTMLCanvasElement | null,
): void {
  const decoderInstance = instance.decoder.value;
  if (decoderInstance) {
    try {
      decoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // 再入時に sessionInstance が null になっているよう close() より先に立てる。
  const sessionInstance = instance.session.value;
  instance.session.value = null;
  if (sessionInstance) {
    sessionInstance.close().catch(() => {
      // 既にクローズされている場合は無視
    });
  }
}

/**
 * `SubscriberInstance` の状態 signal 群を初期値にリセットし、フックローカル参照
 * (`chainRef` / 必要に応じて ref 群) を巻き戻す。
 *
 * `status` / `statusMessage` / `isStopping` は触らない (#0163 の責務境界に従う)。
 * `settingsDisabled` は `subscriber.value = null` の反映後に `hasActiveSubscriber`
 * computed で再計算されるため、本関数の末尾で再有効化判定を行う。
 *
 * 将来の ref 化に備えて引数を受け取り、未適用フィールドは `null` を渡す
 * (0164 適用後に joiningFetch 系 ref が埋まる)。
 */
export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chainRef: { current: Promise<void> },
  liveObjectBufferRef: { current: MoqtObject[] } | null,
  joiningFetchInProgressRef: { current: boolean } | null,
  joiningFetchLastLocationRef: { current: { group: bigint; object: bigint } | null } | null,
  isOtherPublisherActive: () => boolean,
): void {
  instance.subscriber.value = null;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";
  instance.dynamicGroupsSupported.value = false;

  instance.joiningFetchStats.value = null;
  instance.largestLocation.value = null;

  // 0164 適用前は signal、適用後は ref 化される 2 フィールド。
  if (joiningFetchInProgressRef) {
    joiningFetchInProgressRef.current = false;
  } else {
    instance.joiningFetchInProgress.value = false;
  }
  if (joiningFetchLastLocationRef) {
    joiningFetchLastLocationRef.current = null;
  } else {
    instance.joiningFetchLastLocation.value = null;
  }

  // 0166 で ref 化済みのフィールド。
  if (liveObjectBufferRef) {
    liveObjectBufferRef.current = [];
  }

  chainRef.current = Promise.resolve();

  if (!sub.hasActiveSubscriber.value && !isOtherPublisherActive()) {
    settings.settingsDisabled.value = false;
  }
}

// AbortController ベースの中断検知ヘルパー。
// signal.aborted が立っていれば cleanup を呼んでから true を返す。
// cleanup が例外を投げても判定結果は失われないよう握り潰す
// (中断時の後始末は fire-and-forget)。
export function checkAborted(signal: AbortSignal, cleanup: () => void): boolean {
  if (signal.aborted) {
    try {
      cleanup();
    } catch {
      // 中断時の後始末で発生した例外は無視する
    }
    return true;
  }
  return false;
}

export function handleDebugMessage(subscriberId: string, message: DebugMessage): void {
  const direction = message.direction === "send" ? "SEND" : "RECV";
  const logMessage = `[${subscriberId}] [${direction}] ${message.typeName}`;

  const data: Record<string, unknown> = {
    type: message.type,
    payloadSize: message.payload.length,
  };

  if (message.decoded) {
    Object.assign(data, message.decoded);
  }

  // moqt-js の DebugMessage.payload はライフタイム契約が JSDoc 上明文化されて
  // いないため、ログ保持 (最大 MAX_LOGS 件) に備えて独立 Uint8Array へコピーする。
  // new Uint8Array(typedArray) は新規 ArrayBuffer を確保した独立コピーを返す
  // (TC39 ECMA-262 %TypedArray%(typedArray) 抽象操作)。
  const payload = message.payload.length > 0 ? new Uint8Array(message.payload) : undefined;
  addLog("info", logMessage, data, payload);
}

export function useSubscriber(subscriberId: string, canvasRef: RefObject<HTMLCanvasElement>) {
  // ライブオブジェクトの順次処理用 Promise チェーン (レンダリング間で安定参照)
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // startSubscribing の中断検知用 AbortController (レンダリング間で安定参照)
  const abortControllerRef = useRef<AbortController | null>(null);
  // Joining Fetch 中のライブオブジェクトバッファ (UI 描画不要なため Signal ではなく ref で持つ)
  const liveObjectBufferRef = useRef<MoqtObject[]>([]);

  const renderFrame = (frame: VideoFrame): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      frame.close();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn(`[${subscriberId}] renderFrame: canvas is null`);
      frame.close();
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn(`[${subscriberId}] renderFrame: failed to get 2d context`);
      frame.close();
      return;
    }

    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }

    ctx.drawImage(frame, 0, 0);
    frame.close();

    instance.framesDecoded.value = instance.framesDecoded.value + 1;
  };

  const handleObject = async (obj: MoqtObject): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    const decoderInstance = instance.decoder.value;
    if (!decoderInstance) {
      console.warn(`[${subscriberId}] handleObject: decoder is null`);
      return;
    }

    instance.objectsReceived.value = instance.objectsReceived.value + 1;
    instance.bytesReceived.value =
      instance.bytesReceived.value + obj.payload.length + (obj.properties?.length ?? 0);
    instance.currentGroup.value = Number(obj.groupId);
    instance.currentSubGroup.value = Number(obj.subgroupId ?? 0n);
    instance.decoderState.value = decoderInstance.state;

    try {
      // LOC spec 準拠: extensions からメタデータを取得
      let isKeyFrame = false;
      let timestamp = 0;

      if (obj.properties && obj.properties.length > 0) {
        instance.objectsWithExtensions.value = instance.objectsWithExtensions.value + 1;

        const locProperties = LOC.decodeVideoProperties(obj.properties);

        // Capture Timestamp から timestamp を取得
        if (locProperties.timestamp !== undefined) {
          timestamp = Number(locProperties.timestamp);
        }

        // Frame Marking から keyframe 判定
        if (locProperties.frameMarking) {
          isKeyFrame = locProperties.frameMarking.isIndependent;
        }
      }

      // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
      const chunk = new EncodedVideoChunk({
        type: isKeyFrame ? "key" : "delta",
        timestamp,
        data: obj.payload,
      });

      instance.chunksCreated.value = instance.chunksCreated.value + 1;

      if (!instance.decoderConfigured.value) {
        instance.chunksSkipped.value = instance.chunksSkipped.value + 1;
        return;
      }

      if (isKeyFrame) {
        instance.keyFramesDecoded.value = instance.keyFramesDecoded.value + 1;
      }

      if (decoderInstance.state !== "configured") {
        console.warn(
          `[${subscriberId}] handleObject: decoder not in configured state:`,
          decoderInstance.state,
        );
        instance.decoderState.value = decoderInstance.state;
        instance.chunksSkipped.value = instance.chunksSkipped.value + 1;
        return;
      }

      decoderInstance.decode(chunk);
      instance.chunksDecoded.value = instance.chunksDecoded.value + 1;
    } catch (error) {
      console.error(`[${subscriberId}] handleObject: failed to decode object:`, error);
      instance.decodeErrors.value = instance.decodeErrors.value + 1;
    }
  };

  // stopSubscribing 進行中 (isStopping=true) または teardownSubscriber 通過後
  // (session.value === null) の close / end / error コールバック発火では、
  // status / statusMessage を上書きしないと判定する。
  // 非 stop 主導 (通常のサーバ切断 / Stream ended / Subscribe error) では
  // ガード成立せず詳細メッセージが表示される。
  const shouldApplyStatusUpdate = (): boolean => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return false;
    return !instance.isStopping.value && instance.session.value !== null;
  };

  const startSubscribing = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;
    // 停止処理中のときは新規開始しない (二重実行防止)
    if (instance.isStopping.value) return;

    // 古い controller が残っていれば abort してから新規生成する。
    // isStopping は二重実行防止、AbortController は中断シグナルで責務が異なるため両方残す。
    // ローカル signal 経由で参照し、teardownSubscriber が abortControllerRef.current = null
    // した後も abort 状態を判定できるようにする。
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Connecting...";
      settings.settingsDisabled.value = true;

      const namespaceArray = settings.namespace.value.split("/").filter((s) => s.length > 0);
      const connectOptions = settings.buildConnectOptions();

      // MOQT サーバへ接続する
      const session = await connect(
        settings.url.value,
        {
          close: (closeInfo) => {
            // shouldApplyStatusUpdate のガード外で addLog を呼び、stop 主導時にも
            // DebugPanel にイベントを残す。reason は 1024 文字に切って UI 描画負荷を抑える。
            addLog("warn", `[${subscriberId}] webtransport closed`, {
              closeCode: closeInfo.closeCode,
              reason: closeInfo.reason.slice(0, 1024),
            });
            // stop 主導中・cleanup 後の遅延発火では status / statusMessage を上書きしない。
            // teardownSubscriber は abort 経路を維持するため常に呼ぶ。
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "disconnected";
              instance.statusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            }
            teardownSubscriber();
          },
          error: (error) => {
            addLog("error", `[${subscriberId}] webtransport error`, {
              name: error.name ?? "Error",
              message: error.message ?? String(error),
            });
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "error";
              instance.statusMessage.value = `Error: ${error.message}`;
            }
            teardownSubscriber();
          },
          debug: (msg) => handleDebugMessage(subscriberId, msg),
        },
        connectOptions,
      );
      // connect 解決前の close 発火は session 自体が未存在のため、ここでの cleanup は
      // await 中に他経路 (stopSubscribing / アンマウント) で teardownSubscriber が呼ばれた場合に限る。
      // 中断元から見えない (instance.session.value 未代入) ので、ローカル session の close は
      // startSubscribing 側の責務。
      if (
        checkAborted(signal, () => {
          session.close().catch(() => {});
        })
      ) {
        return;
      }
      instance.session.value = session;
      settings.reliability.value = session.reliability;

      // status は subscribe 完了時にのみ "connected" へ遷移する。
      // Catalog 購読中 (最大 5 秒) の途中で "connected" にしないこと。
      instance.statusMessage.value = "Connected, subscribing to catalog...";

      // Catalog を購読してコーデック情報を取得
      let videoTrackFromCatalog: CatalogTrack | undefined;
      let actualTrackName = settings.trackName.value;

      try {
        // draft-ietf-moq-transport-17 に準拠した Catalog 購読:
        // 1. SUBSCRIBE_OK に LARGEST_OBJECT がある場合 → Joining FETCH で過去の Catalog を取得
        // 2. SUBSCRIBE_OK に LARGEST_OBJECT がない場合 → リアルタイムで Catalog が配信されるのを待つ
        //
        // joiningFetch を使用すると:
        // - LARGEST_OBJECT がある場合は自動的に Joining FETCH が送信される
        // - LARGEST_OBJECT がない場合は onError が呼ばれ、リアルタイム配信を待つ
        const catalogPromise = new Promise<CatalogTrack | undefined>((resolve, reject) => {
          // Catalog オブジェクトを処理する共通関数
          const processCatalogObject = (obj: MoqtObject, source: string) => {
            try {
              const catalog = decodeCatalogMessage(obj.payload);
              // RECV OBJECT 自体は addLog 経由で残るのでここで重複ログは出さない。
              addLog("info", `[${subscriberId}] [RECV] OBJECT (${CATALOG_TRACK_NAME})`, {
                source,
                catalog,
              });
              instance.catalog.value = catalog;

              const videoTracks = getVideoTracks(catalog);
              if (videoTracks.length > 0) {
                resolve(videoTracks[0]);
              } else {
                addLog("warn", `[${subscriberId}] no video tracks in catalog`);
                resolve(undefined);
              }
            } catch (error) {
              addLog("error", `[${subscriberId}] failed to decode catalog`, {
                message: error instanceof Error ? error.message : String(error),
              });
              reject(error);
            }
          };

          void session
            .subscribe(
              namespaceArray,
              CATALOG_TRACK_NAME,
              {
                object: (obj: MoqtObject) => {
                  // SUBSCRIBE のデータストリームから受信した Catalog オブジェクト
                  processCatalogObject(obj, "subscribe");
                },
                end: () => {
                  addLog("info", `[${subscriberId}] catalog stream ended`);
                },
                error: (error) => {
                  addLog("error", `[${subscriberId}] catalog subscribe error`, {
                    message: error instanceof Error ? error.message : String(error),
                  });
                  reject(error);
                },
              },
              {
                // draft-ietf-moq-transport-17: LargestObject フィルターで SUBSCRIBE
                // joiningFetch を使用して、LARGEST_OBJECT がある場合は FETCH で取得
                // LARGEST_OBJECT がない場合は Joining FETCH は送信されず、リアルタイム配信を待つ
                joiningFetch: {
                  type: "absolute",
                  start: 0n,
                  onObject: (obj: MoqtObject) => {
                    // Joining FETCH から受信した Catalog オブジェクト
                    processCatalogObject(obj, "fetch");
                  },
                  onEnd: () => {
                    addLog("info", `[${subscriberId}] Catalog Joining FETCH completed`, {
                      trackName: CATALOG_TRACK_NAME,
                    });
                  },
                } as JoiningFetchOptions,
              },
            )
            .then((catalogSubscriberInstance) => {
              // startSubscribing 側で signal.aborted を見て return した後に
              // マイクロタスクで .then が回り catalogSubscriber.value が再代入される
              // レースを .then 側で潰す。
              if (signal.aborted) {
                void catalogSubscriberInstance.unsubscribe().catch(() => {});
                return;
              }
              instance.catalogSubscriber.value = catalogSubscriberInstance;
            })
            .catch(reject);
        });

        // Catalog 取得をタイムアウト付きで待機
        const catalogTimeout = settings.catalogSubscriptionTimeout.value;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<CatalogTrack>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`catalog subscription did not complete within ${catalogTimeout}ms`));
          }, catalogTimeout);
        });

        try {
          videoTrackFromCatalog = await Promise.race([catalogPromise, timeoutPromise]);
        } finally {
          // catalog 取得成功時もタイマーを解放する。タイムアウト発火後の
          // clearTimeout は無害。
          clearTimeout(timeoutId);
        }

        if (!videoTrackFromCatalog) {
          throw new Error("no video track in catalog");
        }

        addLog("info", `[${subscriberId}] using codec from catalog`, {
          codec: videoTrackFromCatalog.codec,
        });
        actualTrackName = videoTrackFromCatalog.name;
      } catch (error) {
        throw new Error(`failed to get catalog: ${(error as Error).message}`);
      }

      // Catalog 取得経路は finally で clearTimeout 済みのため追加 cleanup は不要。
      // .then 内側で catalogSubscriber の遅延代入レースは解消済み。
      if (checkAborted(signal, () => {})) return;

      instance.statusMessage.value = "Setting up decoder...";

      // デコーダラッパーを生成する
      const useWorker = settings.useDedicatedWorker.value;

      const decoderInstance = new DecoderWrapper(useWorker, {
        output: ({ frame }) => {
          renderFrame(frame);
        },
        error: (error) => {
          console.error(`[${subscriberId}] Decoder error:`, error);
          instance.decodeErrors.value = instance.decodeErrors.value + 1;
          // デコーダーをリセットして次のキーフレームを待つ
          console.log(`[${subscriberId}] Resetting decoder, waiting for next keyframe...`);
          void decoderInstance.reset();
        },
      });

      // デコーダを Catalog から取得した videoTrack で設定する
      const decoderConfig = buildVideoDecoderConfig(videoTrackFromCatalog);
      const codecDisplay = `${videoTrackFromCatalog.codec} ${videoTrackFromCatalog.width}x${videoTrackFromCatalog.height}`;
      console.log(`[${subscriberId}] Decoder configured from catalog:`, decoderConfig);

      await decoderInstance.configure(decoderConfig);

      // configure await 中に中断された場合、ローカル decoderInstance は instance に未代入のため
      // 中断元から見えない。startSubscribing 側で close する。
      // DecoderWrapper.close は同期メソッドで state !== "closed" ガード付き、例外を投げない。
      if (
        checkAborted(signal, () => {
          decoderInstance.close();
        })
      ) {
        return;
      }

      instance.decoder.value = decoderInstance;
      instance.decoderConfigured.value = true;
      instance.decoderState.value = decoderInstance.state;
      instance.codec.value = codecDisplay;

      const joiningFetchEnabled = instance.joiningFetchEnabled.value;
      const newGroupRequestEnabled = instance.newGroupRequestEnabled.value;

      instance.status.value = "connected";
      instance.statusMessage.value = "Subscribing...";
      resetSubscriberStats(instance, joiningFetchEnabled);
      // ref のクリアは Signal カウンタリセットとは責務が異なるためフック側で実行する。
      liveObjectBufferRef.current = [];

      // Subscriber オプションを構築する
      const subscribeOptions: {
        newGroupRequest?: bigint;
        joiningFetch?: JoiningFetchOptions;
      } = {};

      // NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
      // draft-ietf-moq-transport-17 §9.3.11: SUBSCRIBE では MAY (foreknowledge 不要、
      // サポート外なら publisher が無視する) ため、DYNAMIC_GROUPS 確認は不要。
      // REQUEST_UPDATE 経路の requestKeyframe では DYNAMIC_GROUPS=1 を確認する。
      if (newGroupRequestEnabled) {
        subscribeOptions.newGroupRequest = 0n;
      }

      // Joining Fetch 設定
      if (joiningFetchEnabled) {
        subscribeOptions.joiningFetch = {
          type: "relative",
          start: 0n,
          onObject: (obj: MoqtObject) => {
            const currentStats = instance.joiningFetchStats.value ?? {
              objectsReceived: 0,
              bytesReceived: 0,
              completed: false,
              bufferedLiveObjects: 0,
            };

            // LOC から keyframe 情報を取得（ログ用）
            let isKeyFrame = false;
            if (obj.properties && obj.properties.length > 0) {
              const locProperties = LOC.decodeVideoProperties(obj.properties);
              if (locProperties.frameMarking) {
                isKeyFrame = locProperties.frameMarking.isIndependent;
              }
            }

            // 最初のオブジェクトをログ出力（keyframe で始まるべき）
            if (currentStats.objectsReceived === 0) {
              console.log(
                `[${subscriberId}] Joining Fetch: started - group=${obj.groupId}, object=${obj.objectId}, isKeyFrame=${isKeyFrame}`,
              );
            }

            instance.joiningFetchLastLocation.value = { group: obj.groupId, object: obj.objectId };
            instance.joiningFetchStats.value = {
              ...currentStats,
              objectsReceived: currentStats.objectsReceived + 1,
              bytesReceived:
                currentStats.bytesReceived + obj.payload.length + (obj.properties?.length ?? 0),
            };

            // Joining Fetch から受信したオブジェクトは即座にデコード
            void handleObject(obj);
          },
          onEnd: () => {
            const currentStats = instance.joiningFetchStats.value ?? {
              objectsReceived: 0,
              bytesReceived: 0,
              completed: false,
              bufferedLiveObjects: 0,
            };

            // toSortedByGroupObject 内部で [...objects].sort(...) するため、ここでのスプレッドは省略する。
            const bufferedObjects = toSortedByGroupObject(liveObjectBufferRef.current);

            // Joining Fetch で既に配信済みのオブジェクトをスキップ (重複除去)。
            const lastFetch = instance.joiningFetchLastLocation.value;
            let objectsToProcess = bufferedObjects;
            if (lastFetch && bufferedObjects.length > 0) {
              const originalLength = bufferedObjects.length;
              objectsToProcess = bufferedObjects.filter((obj) => {
                if (obj.groupId === lastFetch.group && obj.objectId <= lastFetch.object) {
                  return false;
                }
                if (obj.groupId < lastFetch.group) {
                  return false;
                }
                return true;
              });
              const skippedCount = originalLength - objectsToProcess.length;
              if (skippedCount > 0) {
                console.log(
                  `[${subscriberId}] Joining Fetch: skipped ${skippedCount} duplicate objects from live buffer`,
                );
              }
            }

            console.log(
              `[${subscriberId}] Joining Fetch: completed, processing ${objectsToProcess.length} buffered live objects`,
            );

            // chainRef にバッファ済みオブジェクトのデコードを順次予約してから、
            // joiningFetchInProgress / liveObjectBuffer / stats を同一 batch で更新する。
            // ドレイン投入とフラグ立て下げを同期セクションでまとめることで、
            // 「ドレイン中に object: コールバックが割り込んでバッファに積まれたまま
            // 永久に放置される」race window を解消する。立て下げ後の object: は
            // chainRef 経路へ直接流れるため、Promise チェーンで順序保証される。
            for (const bufferedObj of objectsToProcess) {
              chainRef.current = chainRef.current
                .then(() => handleObject(bufferedObj))
                .catch(() => {});
            }

            batch(() => {
              instance.joiningFetchInProgress.value = false;
              instance.joiningFetchLastLocation.value = null;
              instance.joiningFetchStats.value = {
                ...currentStats,
                completed: true,
                bufferedLiveObjects: objectsToProcess.length,
              };
            });
            // ref クリアは batch の外で実行する。batch 完了後に行うことでフラグ立て下げ後の
            // object: コールバック (chainRef 経路) と buffer リセットの順序を維持する。
            liveObjectBufferRef.current = [];
          },
          onError: (error: Error) => {
            console.error(`[${subscriberId}] joiningFetch: error`, error);
            // Joining Fetch (過去取得) が失敗しても SUBSCRIBE 経由のライブ配信は
            // 独立して継続する。ライブバッファに溜まったオブジェクトを破棄せず、
            // onEnd と同じ手順でドレインしてからフラグを下げる。バッファ内に
            // keyframe が含まれていれば自然にデコードが再開する。
            const bufferedObjects = toSortedByGroupObject(liveObjectBufferRef.current);
            for (const bufferedObj of bufferedObjects) {
              chainRef.current = chainRef.current
                .then(() => handleObject(bufferedObj))
                .catch(() => {});
            }
            batch(() => {
              instance.joiningFetchInProgress.value = false;
              instance.joiningFetchLastLocation.value = null;
            });
            liveObjectBufferRef.current = [];
          },
        };
      }

      const subscriberInstance = await session.subscribe(
        namespaceArray,
        actualTrackName,
        {
          object: (obj: MoqtObject) => {
            // Joining Fetch 中はライブオブジェクトをバッファ。push で O(1) 追記する。
            if (instance.joiningFetchInProgress.value) {
              liveObjectBufferRef.current.push(obj);
              return;
            }

            // Promise チェーンで到着順にデコードする。
            // 複数 Subgroup ストリームを並行使用する Publisher との接続では
            // (groupId, objectId) 順の保証がないが、現状はリオーダーバッファを持たない。
            // TODO: 複数 Subgroup 対応は別 issue で扱う。
            chainRef.current = chainRef.current.then(() => handleObject(obj)).catch(() => {});
          },
          end: () => {
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "disconnected";
              instance.statusMessage.value = "Stream ended";
            }
            teardownSubscriber();
          },
          error: (error) => {
            console.error(`[${subscriberId}] Subscriber error:`, error);
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "error";
              instance.statusMessage.value = `Subscribe error: ${error.message}`;
            }
          },
        },
        subscribeOptions,
      );

      // subscribe await 中に中断された場合、ローカル subscriberInstance は instance に未代入のため
      // 中断元から見えない。fire-and-forget で unsubscribe する。
      // unsubscribe は state === "closed" でも例外を投げず early return する。
      if (
        checkAborted(signal, () => {
          void subscriberInstance.unsubscribe().catch(() => {});
        })
      ) {
        return;
      }

      const largestLocation = subscriberInstance.largestLocation;

      instance.subscriber.value = subscriberInstance;
      // SUBSCRIBE_OK の Track Properties に DYNAMIC_GROUPS=1 が含まれているかを
      // 1 回だけ確定させる。trackProperties は signal ではないため computed では
      // 追跡できず、ここで書き込んで UI ボタンの disable と連動させる。
      instance.dynamicGroupsSupported.value = supportsDynamicGroups(
        subscriberInstance.trackProperties,
      );
      instance.status.value = "connected";
      instance.statusMessage.value = `Subscribed to ${namespaceArray.join("/")}/${actualTrackName}`;
      instance.largestLocation.value = largestLocation ?? null;
    } catch (error) {
      // 中断時は teardownSubscriber が status / statusMessage / settingsDisabled を確定済み。
      // 通常エラーの上書きを避けるため、catch 句先頭で abort を判定して早期 return する。
      if (signal.aborted) return;
      console.error(`[${subscriberId}] Connection error:`, error);
      instance.status.value = "error";
      instance.statusMessage.value = `Failed: ${(error as Error).message}`;
      // teardownSubscriber 内の resetSubscriberState が settingsDisabled 再有効化判定を含むため
      // 重複した再有効化処理は不要。
      teardownSubscriber();
    }
  };

  const stopSubscribing = async (): Promise<void> => {
    // 二重実行防止
    const instance = sub.getSubscriber(subscriberId);
    if (!instance || instance.isStopping.value) {
      return;
    }
    instance.isStopping.value = true;
    // 進行中の startSubscribing を unsubscribe() 完了を待たずに中断する。
    // controller の null 化は teardownSubscriber 側で行う。
    abortControllerRef.current?.abort();
    instance.status.value = "disconnected";
    instance.statusMessage.value = "Disconnecting...";

    try {
      const subscriberInstance = instance.subscriber.value;
      if (subscriberInstance && subscriberInstance.state === "active") {
        await subscriberInstance.unsubscribe();
      }
    } finally {
      teardownSubscriber();
      instance.isStopping.value = false;
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Ready to subscribe";
    }
  };

  // 外部接続を含むランタイム状態を全て巻き戻し、再 startSubscribing 可能な初期状態に戻す。
  // close 系 (closeSubscriberResources) と signal リセット系 (resetSubscriberState) を
  // 順に呼ぶ orchestrator。SubscriberInstance を Map から削除しない (= 同じ id で再 setup 可能)。
  const teardownSubscriber = (): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    // 進行中の startSubscribing を中断する。AbortController.abort は冪等で例外を投げない。
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    closeSubscriberResources(instance, canvasRef.current);
    resetSubscriberState(
      instance,
      chainRef,
      liveObjectBufferRef,
      // 0164 で ref 化されるまでは null を渡し、signal 経由でリセットする。
      null,
      null,
      () => pub.pubSession.value !== null,
    );
  };

  const requestKeyframe = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    const subscriberInstance = instance?.subscriber.value;
    if (!subscriberInstance || subscriberInstance.state !== "active") {
      console.warn(`[${subscriberId}] requestKeyframe: subscriber not active`);
      return;
    }

    // draft-ietf-moq-transport-17 §9.3.11:
    // "A subscriber MUST NOT send this parameter in PUBLISH_OK or
    //  REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS
    //  Property with value 1."
    // UI ボタンは disable 済みのため通常は通らないが、状態の古いボタン押下に
    // 対する保険として早期 return する。
    if (!supportsDynamicGroups(subscriberInstance.trackProperties)) {
      console.warn(
        `[${subscriberId}] requestKeyframe: track did not include DYNAMIC_GROUPS=1, skipped`,
      );
      return;
    }

    try {
      // NEW_GROUP_REQUEST パラメータを含む REQUEST_UPDATE を送信
      // draft-ietf-moq-transport-17 §9.3.11
      // NEW_GROUP_REQUEST = 0x32
      await subscriberInstance.update({
        parameters: [
          {
            type: 0x32,
            value: new Uint8Array([0x01]),
          },
        ],
      });
    } catch (error) {
      console.error(`[${subscriberId}] requestKeyframe: failed`, error);
    }
  };

  // アンマウント時のリソース解放 (HMR 等の想定外経路向けの補助)
  useEffect(() => {
    return () => {
      teardownSubscriber();
    };
  }, []);

  return {
    startSubscribing,
    stopSubscribing,
    requestKeyframe,
  };
}
