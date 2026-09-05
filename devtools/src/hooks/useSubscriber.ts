import {
  connect,
  LOC,
  decodeCatalogMessage,
  getVideoTracks,
  resolveInitData,
  CATALOG_TRACK_NAME,
  supportsDynamicGroups,
  type Catalog,
  type MoqtObject,
  type DebugMessage,
  type CatalogTrack,
} from "moqt-js";
import { addLog } from "../components/DebugPanel";
import { DecoderWrapper } from "../utils/DecoderWrapper";
import * as settings from "../signals/connectionSettings";
import * as sub from "../signals/subscriber";
import * as pub from "../signals/publisher";
import { useRef, useEffect } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * Catalog の `videoTrack` から `VideoDecoderConfig` を組み立てる。
 * canonical 形式 (avc1 / hvc1) で必要な description は MSF Catalog の Initialization Data
 * (Base64) から復元する。
 * draft-ietf-moq-msf-01 では `initData` (旧 §5.1.20) が `Catalog.initDataList` (§5.1.7) +
 * `CatalogTrack.initRef` (§5.2.13) の参照に分離されたため、`resolveInitData` 経由で取得する。
 * draft-ietf-moq-loc-04 §2.1.2 の用途は変わらない。
 */
function buildVideoDecoderConfig(videoTrack: CatalogTrack, catalog: Catalog): VideoDecoderConfig {
  if (!videoTrack.codec) {
    throw new Error("video track codec is not specified in catalog");
  }
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth: videoTrack.width,
    codedHeight: videoTrack.height,
  };
  const initData = resolveInitData(catalog, videoTrack);
  if (initData !== undefined) {
    decoderConfig.description = settings.base64ToArrayBuffer(initData);
  }
  return decoderConfig;
}

/**
 * Subscriber インスタンスの統計フィールドを初期値へリセットする。
 * `startSubscribing` 開始時に decode カウンタや位置情報をクリアする。
 */
function resetSubscriberStats(instance: sub.SubscriberInstance): void {
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
  instance.largestLocation.value = null;
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
 * (`chainRef`) を巻き戻す。
 *
 * `status` / `statusMessage` / `isStopping` は触らない (#0163 の責務境界に従う)。
 * `settingsDisabled` は `subscriber.value = null` の反映後に `hasActiveSubscriber`
 * computed で再計算されるため、本関数の末尾で再有効化判定を行う。
 */
export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chainRef: { current: Promise<void> },
  isOtherPublisherActive: () => boolean,
): void {
  instance.subscriber.value = null;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";
  instance.dynamicGroupsSupported.value = false;

  instance.largestLocation.value = null;

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

// preact 11 では useRef<T>(null) の戻り値が RefObject<T | null> になるため、
// null を許容するシグネチャにしている。実装側は canvasRef.current を
// null チェックしてから利用する。
export function useSubscriber(
  subscriberId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
) {
  // ライブオブジェクトの順次処理用 Promise チェーン (レンダリング間で安定参照)
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // startSubscribing の中断検知用 AbortController (レンダリング間で安定参照)
  const abortControllerRef = useRef<AbortController | null>(null);

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
      // LOC Properties からメタデータを取得
      let isKeyFrame = false;
      let timestamp = 0;

      if (obj.properties && obj.properties.length > 0) {
        instance.objectsWithExtensions.value = instance.objectsWithExtensions.value + 1;

        const locProperties = LOC.decodeVideoProperties(obj.properties);

        // TIMESTAMP から timestamp を取得
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
        settings.buildConnectUrl(),
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
        // draft-ietf-moq-transport-20 に準拠した Catalog 購読:
        // 1. Next Object 形式の Location Filter で SUBSCRIBE し、live の Catalog 更新を受信
        // 2. 独立した FETCH (フィルタなし) で過去の Catalog を取得
        // FETCH が INVALID_RANGE で失敗する場合 (Catalog 未 publish) は
        // live の SUBSCRIBE 経由で Catalog が届くのを待つ
        const catalogPromise = new Promise<CatalogTrack | undefined>((resolve, reject) => {
          // SUBSCRIBE と FETCH は独立したリクエストであり、古いフルカタログが
          // live の新しいフルカタログより後に届く可能性がある。instance.catalog を
          // 巻き戻さないよう、適用済みの最大 Location を保持して単調性を保証する。
          // (createMediaSubscriber の filterPendingCatalogObjects と異なり、ここでは
          // 複数リクエスト間の「適用順序の単調性」だけを保証する。full catalog の
          // 置換は冪等のため、重複オブジェクトの除去は不要)
          let lastCatalogLocation: { group: bigint; object: bigint } | null = null;
          // Catalog オブジェクトを処理する共通関数
          const processCatalogObject = (obj: MoqtObject, source: string) => {
            try {
              const message = decodeCatalogMessage(obj.payload);
              // draft-ietf-moq-msf-01 §5.1.6 wire format で deltaUpdate が array 形式の場合は
              // CatalogDelta を返す。devtools subscriber は現在 full catalog のみ処理する
              // (delta apply は createMediaSubscriber 同様、別 issue 対応)。
              if (!("version" in message)) {
                addLog(
                  "info",
                  `[${subscriberId}] [RECV] CatalogDelta (skipped, delta apply not supported)`,
                  {
                    source,
                  },
                );
                return;
              }
              const catalog = message;
              const location: { group: bigint; object: bigint } = {
                group: obj.groupId,
                object: obj.objectId,
              };
              if (
                lastCatalogLocation !== null &&
                (location.group < lastCatalogLocation.group ||
                  (location.group === lastCatalogLocation.group &&
                    location.object <= lastCatalogLocation.object))
              ) {
                addLog("info", `[${subscriberId}] stale or duplicate catalog object skipped`, {
                  source,
                });
                return;
              }
              lastCatalogLocation = location;
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

          // Catalog 未 publish 等の FETCH 失敗は live 待ちへフォールバックする
          const onCatalogFetchFailed = (error: unknown): void => {
            addLog("warn", `[${subscriberId}] catalog fetch failed`, {
              message: error instanceof Error ? error.message : String(error),
            });
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
                // Next Object 形式 ({ startGroup: 0n, startObject: 0n }) の
                // Location Filter で SUBSCRIBE する。live の Catalog 更新は
                // この SUBSCRIBE で受信し、過去の Catalog は FETCH で取得する
                filter: { startGroup: 0n, startObject: 0n },
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

              // 過去の Catalog を FETCH (フィルタなし = {0, 0} から Largest Object まで)
              // で取得する。SUBSCRIBE_OK 受信後に FETCH を送ることで、Next Object の
              // Largest (L1) が FETCH 処理時の Largest (L2) 以下になることを保証し、
              // (L2, L1] の取りこぼしを防ぐ (createMediaSubscriber と同じ順序)。
              void session
                .fetch(
                  namespaceArray,
                  CATALOG_TRACK_NAME,
                  {},
                  {
                    object: (obj: MoqtObject) => {
                      // FETCH から受信した Catalog オブジェクト
                      processCatalogObject(obj, "fetch");
                    },
                    end: () => {
                      addLog("info", `[${subscriberId}] catalog fetch completed`, {
                        trackName: CATALOG_TRACK_NAME,
                      });
                    },
                    error: (error) => {
                      onCatalogFetchFailed(error);
                    },
                  },
                )
                .catch(onCatalogFetchFailed);
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

      // デコーダを Catalog から取得した videoTrack で設定する。
      // draft-ietf-moq-msf-01 §5.2.13 (initRef) → §5.1.7 (initDataList) 経路で initData
      // を解決するため、現在保持している catalog signal を渡す。
      const catalogValue = instance.catalog.value;
      if (!catalogValue) {
        throw new Error("catalog is not available when building VideoDecoderConfig");
      }
      const decoderConfig = buildVideoDecoderConfig(videoTrackFromCatalog, catalogValue);
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

      const newGroupRequestEnabled = instance.newGroupRequestEnabled.value;

      instance.status.value = "connected";
      instance.statusMessage.value = "Subscribing...";
      resetSubscriberStats(instance);

      // Subscriber オプションを構築する
      const subscribeOptions: {
        newGroupRequest?: bigint;
      } = {};

      // NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
      // draft-ietf-moq-transport-20 §10.2.19: SUBSCRIBE では MAY (foreknowledge 不要、
      // サポート外なら publisher が無視する) ため、DYNAMIC_GROUPS 確認は不要。
      // REQUEST_UPDATE 経路の requestKeyframe では DYNAMIC_GROUPS=1 を確認する。
      if (newGroupRequestEnabled) {
        subscribeOptions.newGroupRequest = 0n;
      }

      const subscriberInstance = await session.subscribe(
        namespaceArray,
        actualTrackName,
        {
          object: (obj: MoqtObject) => {
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
    resetSubscriberState(instance, chainRef, () => pub.pubSession.value !== null);
  };

  const requestKeyframe = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    const subscriberInstance = instance?.subscriber.value;
    if (!subscriberInstance || subscriberInstance.state !== "active") {
      console.warn(`[${subscriberId}] requestKeyframe: subscriber not active`);
      return;
    }

    // draft-ietf-moq-transport-20 §10.2.19:
    // "A subscriber MUST NOT send this parameter in
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
      // draft-ietf-moq-transport-20 §10.2.19
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
