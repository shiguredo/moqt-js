import {
  connect,
  LOC,
  decodeCatalogMessage,
  getVideoTracks,
  CATALOG_TRACK_NAME,
  type AuthorizationToken,
  type MoqtObject,
  type DebugMessage,
  type CertificateHash,
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
function sortByGroupObject(objects: MoqtObject[]): MoqtObject[] {
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

function handleDebugMessage(subscriberId: string, message: DebugMessage): void {
  const direction = message.direction === "send" ? "SEND" : "RECV";
  const logMessage = `[${subscriberId}] [${direction}] ${message.typeName}`;

  const data: Record<string, unknown> = {
    type: message.type,
    payloadSize: message.payload.length,
  };

  if (message.decoded) {
    Object.assign(data, message.decoded);
  }

  // payload が存在する場合は渡す
  const payload = message.payload.length > 0 ? message.payload : undefined;
  addLog("info", logMessage, data, payload);
}

export function useSubscriber(subscriberId: string, canvasRef: RefObject<HTMLCanvasElement>) {
  // ライブオブジェクトの順次処理用 Promise チェーン
  // useRef でレンダリング間で安定した参照を保持する
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const renderFrame = (frame: VideoFrame): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      frame.close();
      return;
    }

    // draft-ietf-moq-transport-17 §9.14.2.1
    // Joining FETCH と SUBSCRIBE の範囲は publisher 側で contiguous かつ
    // non-overlapping に揃えられるため、subscriber 側は timestamp ベースで
    // 描画を抑制する必要がない。デコード結果は順次そのまま描画する。

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

    // Resize canvas if needed
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }

    // Draw frame to canvas
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

      // デコーダが設定されていない場合はスキップ
      if (!instance.decoderConfigured.value) {
        instance.chunksSkipped.value = instance.chunksSkipped.value + 1;
        return;
      }

      // Count keyframes
      if (isKeyFrame) {
        instance.keyFramesDecoded.value = instance.keyFramesDecoded.value + 1;
      }

      // Check decoder state before decoding
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

  const startSubscribing = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;
    // 停止処理中のときは新規開始しない (二重実行防止)
    if (instance.isStopping.value) return;

    try {
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Connecting...";
      settings.settingsDisabled.value = true;

      const namespaceArray = settings.namespace.value.split("/").filter((s) => s.length > 0);

      // Build connect options
      const connectOptions: {
        serverCertificateHashes?: CertificateHash[];
        authorizationToken?: AuthorizationToken;
      } = {};
      if (settings.certificateHash.value) {
        connectOptions.serverCertificateHashes = [
          {
            algorithm: "sha-256",
            value: settings.base64ToArrayBuffer(settings.certificateHash.value),
          },
        ];
      }
      const authToken = settings.buildAuthorizationToken();
      if (authToken) {
        connectOptions.authorizationToken = authToken;
      }

      // Connect to MOQT server
      const session = await connect(
        settings.url.value,
        {
          close: (closeInfo) => {
            console.log(
              `Subscriber: WebTransport closed: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
            );
            instance.status.value = "disconnected";
            instance.statusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            cleanupSubscriber();
          },
          error: (error) => {
            instance.status.value = "error";
            instance.statusMessage.value = `Error: ${error.message}`;
            cleanupSubscriber();
          },
          debug: (msg) => handleDebugMessage(subscriberId, msg),
        },
        connectOptions,
      );
      instance.session.value = session;
      settings.reliability.value = session.reliability;

      // connect の await 中に close コールバック → cleanupSubscriber が発火した
      // 痕跡をチェックする (現状この経路に至るには次の await 以降が必要だが、
      // 中断機構の入口として防御的に確認する)。
      if (instance.session.value === null) return;

      // status は subscribe 完了時 (576 行目相当) に "connected" へ遷移する。
      // ここで "connected" にしてしまうと、Catalog 購読中の最大 5 秒間に誤った
      // 状態が UI に表示される。
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
              addLog("info", `[${subscriberId}] [RECV] OBJECT (${CATALOG_TRACK_NAME})`, {
                source,
                catalog,
              });
              console.log(`[${subscriberId}] Catalog received (${source}):`, catalog);
              instance.catalog.value = catalog;

              const videoTracks = getVideoTracks(catalog);
              if (videoTracks.length > 0) {
                resolve(videoTracks[0]);
              } else {
                console.warn(`[${subscriberId}] No video tracks in catalog`);
                resolve(undefined);
              }
            } catch (error) {
              console.error(`[${subscriberId}] Failed to decode catalog:`, error);
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
                  console.log(`[${subscriberId}] Catalog stream ended`);
                },
                error: (error) => {
                  console.error(`[${subscriberId}] Catalog subscribe error:`, error);
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
              instance.catalogSubscriber.value = catalogSubscriberInstance;
            })
            .catch(reject);
        });

        // Catalog 取得をタイムアウト付きで待機
        const catalogTimeout = settings.catalogSubscriptionTimeout.value;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<CatalogTrack>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`catalog subscription timeout (${catalogTimeout}ms)`));
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

        console.log(`[${subscriberId}] Using codec from catalog:`, videoTrackFromCatalog.codec);
        actualTrackName = videoTrackFromCatalog.name;
      } catch (error) {
        throw new Error(`failed to get catalog: ${(error as Error).message}`);
      }

      // Catalog 取得の await 中に close コールバック → cleanupSubscriber で
      // session.value が null 化された場合は以降の処理をスキップする。
      if (instance.session.value === null) return;

      instance.statusMessage.value = "Setting up decoder...";

      // Create decoder wrapper
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

      // デコーダを設定: Catalog から取得
      if (!videoTrackFromCatalog.codec) {
        throw new Error("video track codec is not specified in catalog");
      }
      const decoderConfig: VideoDecoderConfig = {
        codec: videoTrackFromCatalog.codec,
        codedWidth: videoTrackFromCatalog.width,
        codedHeight: videoTrackFromCatalog.height,
      };
      // canonical 形式 (avc1 / hvc1) で必要な VideoDecoderConfig.description を
      // MSF Catalog の initData (Base64) から取得する
      // draft-ietf-moq-msf §5.1.20 / draft-ietf-moq-loc-02 §2.1.2
      if (videoTrackFromCatalog.initData) {
        decoderConfig.description = settings.base64ToArrayBuffer(videoTrackFromCatalog.initData);
      }
      const codecDisplay = `${videoTrackFromCatalog.codec} ${videoTrackFromCatalog.width}x${videoTrackFromCatalog.height}`;
      console.log(`[${subscriberId}] Decoder configured from catalog:`, decoderConfig);

      await decoderInstance.configure(decoderConfig);

      // decoder.configure の await 中に close コールバック → cleanupSubscriber で
      // session.value が null 化された場合は以降の処理をスキップする。
      if (instance.session.value === null) {
        try {
          decoderInstance.close();
        } catch {
          // 既にクローズされている場合は無視
        }
        return;
      }

      instance.decoder.value = decoderInstance;
      instance.decoderConfigured.value = true;
      instance.decoderState.value = decoderInstance.state;
      instance.codec.value = codecDisplay;

      // Subscriber オプションを構築
      const joiningFetchEnabled = instance.joiningFetchEnabled.value;
      const newGroupRequestEnabled = instance.newGroupRequestEnabled.value;

      instance.status.value = "connected";
      instance.statusMessage.value = "Subscribing...";
      // Reset stats
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
      instance.liveObjectBuffer.value = [];

      // Create subscriber
      const subscribeOptions: {
        newGroupRequest?: bigint;
        joiningFetch?: JoiningFetchOptions;
      } = {};

      // NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
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

            // ライブバッファを (groupId, objectId) 昇順へ並べ替える。
            // draft-ietf-moq-transport-17 §2.2 (Subgroups) では Subgroup ストリームと
            // OBJECT_DATAGRAM の配送順が保証されないため、到着順 ≠ (groupId, objectId) 順
            // となる可能性がある。
            const bufferedObjects = sortByGroupObject([...instance.liveObjectBuffer.value]);

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
              chainRef.current = chainRef.current.then(() => handleObject(bufferedObj));
            }

            batch(() => {
              instance.liveObjectBuffer.value = [];
              instance.joiningFetchInProgress.value = false;
              instance.joiningFetchLastLocation.value = null;
              instance.joiningFetchStats.value = {
                ...currentStats,
                completed: true,
                bufferedLiveObjects: objectsToProcess.length,
              };
            });
          },
          onError: (error: Error) => {
            console.error(`[${subscriberId}] joiningFetch: error`, error);
            // Joining Fetch (過去取得) が失敗しても SUBSCRIBE 経由のライブ配信は
            // 独立して継続する。ライブバッファに溜まったオブジェクトを破棄せず、
            // onEnd と同じ手順でドレインしてからフラグを下げる。バッファ内に
            // keyframe が含まれていれば自然にデコードが再開する。
            const bufferedObjects = sortByGroupObject([...instance.liveObjectBuffer.value]);
            for (const bufferedObj of bufferedObjects) {
              chainRef.current = chainRef.current.then(() => handleObject(bufferedObj));
            }
            batch(() => {
              instance.liveObjectBuffer.value = [];
              instance.joiningFetchInProgress.value = false;
              instance.joiningFetchLastLocation.value = null;
            });
          },
        };
      }

      const subscriberInstance = await session.subscribe(
        namespaceArray,
        actualTrackName,
        {
          object: (obj: MoqtObject) => {
            // Joining Fetch 中はライブオブジェクトをバッファ
            if (instance.joiningFetchInProgress.value) {
              instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj];
              return;
            }

            // 順次処理: Promise チェーンで到着順にデコードする
            // 制限事項: 複数 Subgroup ストリームを同一 Track で並行使用する Publisher と
            // 接続した場合、到着順 ≠ (groupId, objectId) 順となるが現状はリオーダー
            // バッファを持たない。devtools Publisher は単一 Subgroup のみ送出するため
            // 当面この経路で実害は出ない。複数 Subgroup 対応は別 issue で扱う。
            chainRef.current = chainRef.current.then(() => handleObject(obj));
          },
          end: () => {
            instance.status.value = "disconnected";
            instance.statusMessage.value = "Stream ended";
            cleanupSubscriber();
          },
          error: (error) => {
            console.error(`[${subscriberId}] Subscriber error:`, error);
            instance.status.value = "error";
            instance.statusMessage.value = `Subscribe error: ${error.message}`;
          },
        },
        subscribeOptions,
      );
      // SUBSCRIBE_OK から largestLocation を取得
      // joiningFetchInProgress の解除は Joining FETCH の onEnd / onError 内で
      // ドレインループ完了と同期して行う。ここで早期解除すると、ドレインループ
      // 実行中に到着したライブオブジェクトが直接 handleObject 経路へ流れて
      // 順序が破綻するため、解除箇所はドレイン側に一本化する。
      // LARGEST_OBJECT なしの場合も session.ts 側で onEnd が同期呼び出しされ、
      // ドレインループ末尾で joiningFetchInProgress: false に遷移する。
      const largestLocation = subscriberInstance.largestLocation;

      instance.subscriber.value = subscriberInstance;
      instance.status.value = "connected";
      instance.statusMessage.value = `Subscribed to ${namespaceArray.join("/")}/${actualTrackName}`;
      instance.largestLocation.value = largestLocation ?? null;
    } catch (error) {
      console.error(`[${subscriberId}] Connection error:`, error);
      instance.status.value = "error";
      instance.statusMessage.value = `Failed: ${(error as Error).message}`;
      cleanupSubscriber();
      // settingsDisabled は他の subscriber がアクティブかどうかで判断
      if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) {
        settings.settingsDisabled.value = false;
      }
    }
  };

  const stopSubscribing = async (): Promise<void> => {
    // 二重実行防止
    const instance = sub.getSubscriber(subscriberId);
    if (!instance || instance.isStopping.value) {
      return;
    }
    instance.isStopping.value = true;
    instance.status.value = "disconnected";
    instance.statusMessage.value = "Disconnecting...";

    try {
      const subscriberInstance = instance.subscriber.value;
      if (subscriberInstance && subscriberInstance.state === "active") {
        await subscriberInstance.unsubscribe();
      }
    } finally {
      cleanupSubscriber();
      instance.isStopping.value = false;
      instance.status.value = "disconnected";
      instance.statusMessage.value = "Ready to subscribe";
    }
  };

  const cleanupSubscriber = (): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    // Close decoder
    const decoderInstance = instance.decoder.value;
    if (decoderInstance) {
      try {
        decoderInstance.close();
      } catch {
        // Ignore
      }
    }

    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1e293b"; // slate-800
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    // Close session
    // WebTransport 実装が close イベントを同期的に dispatch すると、close
    // コールバック経由で cleanupSubscriber が再入する。再入時に sessionInstance
    // が null になっているよう、close() より先に session.value をリセットする。
    const sessionInstance = instance.session.value;
    instance.session.value = null;
    if (sessionInstance) {
      sessionInstance.close().catch(() => {
        // 既にクローズされている場合は無視
      });
    }

    instance.subscriber.value = null;
    instance.catalogSubscriber.value = null;
    instance.catalog.value = null;
    instance.decoder.value = null;
    instance.decoderConfigured.value = false;
    instance.codec.value = "";

    // joining fetch 関連の状態をリセットして stopSubscribing 単独呼び出し後の
    // 論理的な状態不整合を防ぐ。
    instance.joiningFetchInProgress.value = false;
    instance.joiningFetchLastLocation.value = null;
    instance.liveObjectBuffer.value = [];
    instance.joiningFetchStats.value = null;
    instance.largestLocation.value = null;

    // Subscriber 再起動時に古い Promise チェーンを引き継がないようリセットする
    chainRef.current = Promise.resolve();

    // Enable settings if no other subscriber/publisher is active
    if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) {
      settings.settingsDisabled.value = false;
    }
  };

  const requestKeyframe = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    const subscriberInstance = instance?.subscriber.value;
    if (!subscriberInstance || subscriberInstance.state !== "active") {
      console.warn(`[${subscriberId}] requestKeyframe: subscriber not active`);
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

  // コンポーネントアンマウント時の安全策。
  // handleRemoveSubscriber が removeSubscriber を先に呼ぶため通常は instance が
  // undefined になり no-op だが、将来の予期しないアンマウント経路 (ホットリロード
  // 等) に備えて補助的にリソースをクリーンアップする。
  useEffect(() => {
    return () => {
      cleanupSubscriber();
    };
  }, []);

  return {
    startSubscribing,
    stopSubscribing,
    requestKeyframe,
  };
}
