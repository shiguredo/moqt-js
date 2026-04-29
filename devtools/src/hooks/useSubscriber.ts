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
import type { RefObject } from "preact";

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
  let liveObjectProcessingChain = Promise.resolve();

  const renderFrame = (frame: VideoFrame): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      frame.close();
      return;
    }

    // Joining Fetch の最後のフレームに達するまで描画しない
    if (instance.joiningFetchLastTimestamp > 0) {
      if (frame.timestamp < instance.joiningFetchLastTimestamp) {
        frame.close();
        return;
      }
      // 最後のフレームに達した → 描画開始、フラグをリセット
      sub.updateSubscriber(subscriberId, {
        joiningFetchLastTimestamp: 0,
      });
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

    // Resize canvas if needed
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }

    // Draw frame to canvas
    ctx.drawImage(frame, 0, 0);
    frame.close();

    if (instance) {
      sub.updateSubscriber(subscriberId, {
        framesDecoded: instance.framesDecoded + 1,
      });
    }
  };

  const handleObject = async (obj: MoqtObject): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    const decoderInstance = instance.decoder;
    if (!decoderInstance) {
      console.warn(`[${subscriberId}] handleObject: decoder is null`);
      return;
    }

    sub.updateSubscriber(subscriberId, {
      objectsReceived: instance.objectsReceived + 1,
      bytesReceived: instance.bytesReceived + obj.payload.length + (obj.properties?.length ?? 0),
      currentGroup: Number(obj.groupId),
      currentSubGroup: Number(obj.subgroupId ?? 0n),
      decoderState: decoderInstance.state,
    });

    try {
      // LOC spec 準拠: extensions からメタデータを取得
      let isKeyFrame = false;
      let timestamp = 0;
      let currentInstance = sub.getSubscriber(subscriberId);
      if (!currentInstance) return;

      if (obj.properties && obj.properties.length > 0) {
        sub.updateSubscriber(subscriberId, {
          objectsWithExtensions: currentInstance.objectsWithExtensions + 1,
        });

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

      currentInstance = sub.getSubscriber(subscriberId);
      if (!currentInstance) return;
      sub.updateSubscriber(subscriberId, {
        chunksCreated: currentInstance.chunksCreated + 1,
      });

      // デコーダが設定されていない場合はスキップ
      if (!currentInstance.decoderConfigured) {
        sub.updateSubscriber(subscriberId, {
          chunksSkipped: currentInstance.chunksSkipped + 1,
        });
        return;
      }

      // Count keyframes
      if (isKeyFrame) {
        sub.updateSubscriber(subscriberId, {
          keyFramesDecoded: currentInstance.keyFramesDecoded + 1,
        });
      }

      // Check decoder state before decoding
      if (decoderInstance.state !== "configured") {
        console.warn(
          `[${subscriberId}] handleObject: decoder not in configured state:`,
          decoderInstance.state,
        );
        sub.updateSubscriber(subscriberId, {
          decoderState: decoderInstance.state,
          chunksSkipped: currentInstance.chunksSkipped + 1,
        });
        return;
      }

      decoderInstance.decode(chunk);
      currentInstance = sub.getSubscriber(subscriberId);
      if (currentInstance) {
        sub.updateSubscriber(subscriberId, {
          chunksDecoded: currentInstance.chunksDecoded + 1,
        });
      }
    } catch (error) {
      console.error(`[${subscriberId}] handleObject: failed to decode object:`, error);
      const currentInstance = sub.getSubscriber(subscriberId);
      if (currentInstance) {
        sub.updateSubscriber(subscriberId, {
          decodeErrors: currentInstance.decodeErrors + 1,
        });
      }
    }
  };

  const startSubscribing = async (): Promise<void> => {
    try {
      sub.updateSubscriber(subscriberId, {
        status: "disconnected",
        statusMessage: "Connecting...",
      });
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
            sub.updateSubscriber(subscriberId, {
              status: "disconnected",
              statusMessage: `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
            });
            cleanupSubscriber();
          },
          error: (error) => {
            sub.updateSubscriber(subscriberId, {
              status: "error",
              statusMessage: `Error: ${error.message}`,
            });
            cleanupSubscriber();
          },
          debug: (msg) => handleDebugMessage(subscriberId, msg),
        },
        connectOptions,
      );
      sub.updateSubscriber(subscriberId, { session });
      settings.reliability.value = session.reliability;

      sub.updateSubscriber(subscriberId, {
        status: "connected",
        statusMessage: "Connected, subscribing to catalog...",
      });

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
              sub.updateSubscriber(subscriberId, { catalog });

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
              sub.updateSubscriber(subscriberId, {
                catalogSubscriber: catalogSubscriberInstance,
              });
            })
            .catch(reject);
        });

        // Catalog 取得をタイムアウト付きで待機
        const catalogTimeout = settings.catalogSubscriptionTimeout.value;
        const timeoutPromise = new Promise<CatalogTrack>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`catalog subscription timeout (${catalogTimeout}ms)`));
          }, catalogTimeout);
        });

        videoTrackFromCatalog = await Promise.race([catalogPromise, timeoutPromise]);

        if (!videoTrackFromCatalog) {
          throw new Error("no video track in catalog");
        }

        console.log(`[${subscriberId}] Using codec from catalog:`, videoTrackFromCatalog.codec);
        actualTrackName = videoTrackFromCatalog.name;
      } catch (error) {
        throw new Error(`failed to get catalog: ${(error as Error).message}`);
      }

      sub.updateSubscriber(subscriberId, {
        status: "connected",
        statusMessage: "Setting up decoder...",
      });

      // Create decoder wrapper
      const useWorker = settings.useDedicatedWorker.value;

      const decoderInstance = new DecoderWrapper(useWorker, {
        output: ({ frame }) => {
          renderFrame(frame);
        },
        error: (error) => {
          console.error(`[${subscriberId}] Decoder error:`, error);
          const instance = sub.getSubscriber(subscriberId);
          if (instance) {
            sub.updateSubscriber(subscriberId, {
              decodeErrors: instance.decodeErrors + 1,
            });
          }
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
      const codecDisplay = `${videoTrackFromCatalog.codec} ${videoTrackFromCatalog.width}x${videoTrackFromCatalog.height}`;
      console.log(`[${subscriberId}] Decoder configured from catalog:`, decoderConfig);

      await decoderInstance.configure(decoderConfig);

      sub.updateSubscriber(subscriberId, {
        decoder: decoderInstance,
        decoderConfigured: true,
        decoderState: decoderInstance.state,
        codec: codecDisplay,
      });

      // Subscriber オプションを構築
      const currentInstance = sub.getSubscriber(subscriberId);
      const joiningFetchEnabled = currentInstance?.joiningFetchEnabled ?? false;
      const newGroupRequestEnabled = currentInstance?.newGroupRequestEnabled ?? false;

      sub.updateSubscriber(subscriberId, {
        status: "connected",
        statusMessage: "Subscribing...",
        // Reset stats
        framesDecoded: 0,
        keyFramesDecoded: 0,
        objectsReceived: 0,
        currentGroup: 0,
        currentSubGroup: 0,
        bytesReceived: 0,
        objectsWithExtensions: 0,
        chunksCreated: 0,
        chunksDecoded: 0,
        chunksSkipped: 0,
        decodeErrors: 0,
        joiningFetchStats: null,
        largestLocation: null,
        joiningFetchInProgress: joiningFetchEnabled,
        liveObjectBuffer: [],
      });

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
            const instance = sub.getSubscriber(subscriberId);
            if (!instance) return;

            const currentStats = instance.joiningFetchStats ?? {
              objectsReceived: 0,
              bytesReceived: 0,
              completed: false,
              bufferedLiveObjects: 0,
            };

            // LOC から timestamp と keyframe 情報を取得
            let timestamp = 0;
            let isKeyFrame = false;
            if (obj.properties && obj.properties.length > 0) {
              const ext = LOC.decodeVideoProperties(obj.properties);
              if (ext.timestamp !== undefined) {
                timestamp = Number(ext.timestamp);
              }
              if (ext.frameMarking) {
                isKeyFrame = ext.frameMarking.isIndependent;
              }
            }

            // 最初のオブジェクトをログ出力（keyframe で始まるべき）
            if (currentStats.objectsReceived === 0) {
              console.log(
                `[${subscriberId}] Joining Fetch: started - group=${obj.groupId}, object=${obj.objectId}, isKeyFrame=${isKeyFrame}`,
              );
            }

            sub.updateSubscriber(subscriberId, {
              joiningFetchLastTimestamp: timestamp,
              joiningFetchLastLocation: { group: obj.groupId, object: obj.objectId },
              joiningFetchStats: {
                ...currentStats,
                objectsReceived: currentStats.objectsReceived + 1,
                bytesReceived:
                  currentStats.bytesReceived + obj.payload.length + (obj.properties?.length ?? 0),
              },
            });

            // Joining Fetch から受信したオブジェクトは即座にデコード
            void handleObject(obj);
          },
          onEnd: () => {
            const instance = sub.getSubscriber(subscriberId);
            if (!instance) return;

            const currentStats = instance.joiningFetchStats ?? {
              objectsReceived: 0,
              bytesReceived: 0,
              completed: false,
              bufferedLiveObjects: 0,
            };

            // ライブバッファをコピーしてクリア
            // stream 内では順番が保証されるのでソート不要
            const bufferedObjects = [...instance.liveObjectBuffer];
            sub.updateSubscriber(subscriberId, {
              liveObjectBuffer: [],
            });

            // Joining Fetch で既に配信済みのオブジェクトをスキップ（重複除去）
            const lastFetch = instance.joiningFetchLastLocation;
            let objectsToProcess = bufferedObjects;
            if (lastFetch && bufferedObjects.length > 0) {
              const originalLength = bufferedObjects.length;
              objectsToProcess = bufferedObjects.filter((obj) => {
                // 同じグループで lastFetch 以下のオブジェクトはスキップ
                if (obj.groupId === lastFetch.group && obj.objectId <= lastFetch.object) {
                  return false;
                }
                // 古いグループのオブジェクトもスキップ
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

            // バッファ内の最後の timestamp を取得
            let lastTimestamp = instance.joiningFetchLastTimestamp;
            for (const obj of objectsToProcess) {
              if (obj.properties && obj.properties.length > 0) {
                const ext = LOC.decodeVideoProperties(obj.properties);
                if (ext.timestamp !== undefined) {
                  lastTimestamp = Number(ext.timestamp);
                }
              }
            }

            // 統計を更新
            sub.updateSubscriber(subscriberId, {
              joiningFetchLastTimestamp: lastTimestamp,
              joiningFetchLastLocation: null,
              joiningFetchStats: {
                ...currentStats,
                completed: true,
                bufferedLiveObjects: objectsToProcess.length,
              },
            });

            // バッファを順次デコード
            void (async () => {
              for (const bufferedObj of objectsToProcess) {
                await handleObject(bufferedObj);
              }

              // 処理中に追加されたオブジェクトがあれば処理
              let inst = sub.getSubscriber(subscriberId);
              while (inst && inst.liveObjectBuffer.length > 0) {
                const remainingObjects = [...inst.liveObjectBuffer];
                sub.updateSubscriber(subscriberId, {
                  liveObjectBuffer: [],
                });
                for (const obj of remainingObjects) {
                  await handleObject(obj);
                }
                inst = sub.getSubscriber(subscriberId);
              }

              // 全てのバッファ処理が完了してから joiningFetchInProgress を false に
              sub.updateSubscriber(subscriberId, {
                joiningFetchInProgress: false,
              });
            })();
          },
          onError: (error: Error) => {
            console.error(`[${subscriberId}] joiningFetch: error`, error);
            // エラー時もバッファをクリアしてフラグをリセット
            const instance = sub.getSubscriber(subscriberId);
            if (instance) {
              // デコーダーをキーフレーム待ち状態にリセット
              if (instance.decoder) {
                instance.decoder.resetKeyframeWait();
              }
              sub.updateSubscriber(subscriberId, {
                joiningFetchInProgress: false,
                liveObjectBuffer: [],
                joiningFetchLastLocation: null,
                joiningFetchLastTimestamp: 0,
              });
            }
          },
        };
      }

      const subscriberInstance = await session.subscribe(
        namespaceArray,
        actualTrackName,
        {
          object: (obj: MoqtObject) => {
            const instance = sub.getSubscriber(subscriberId);
            if (!instance) return;

            // Joining Fetch 中はライブオブジェクトをバッファ
            if (instance.joiningFetchInProgress) {
              const newBuffer = [...instance.liveObjectBuffer, obj];
              sub.updateSubscriber(subscriberId, {
                liveObjectBuffer: newBuffer,
              });
              return;
            }

            // 順次処理: Promise チェーンでオブジェクトを順番にデコード
            liveObjectProcessingChain = liveObjectProcessingChain.then(() => handleObject(obj));
          },
          end: () => {
            sub.updateSubscriber(subscriberId, {
              status: "disconnected",
              statusMessage: "Stream ended",
            });
            cleanupSubscriber();
          },
          error: (error) => {
            console.error(`[${subscriberId}] Subscriber error:`, error);
            sub.updateSubscriber(subscriberId, {
              status: "error",
              statusMessage: `Subscribe error: ${error.message}`,
            });
          },
        },
        subscribeOptions,
      );
      // SUBSCRIBE_OK から largestLocation を取得
      const largestLocation = subscriberInstance.largestLocation;

      // SUBSCRIBE_OK に LARGEST_OBJECT がない場合は Joining FETCH が送信されない
      // この場合はバッファリングモードを解除してライブオブジェクトを直接処理する
      if (joiningFetchEnabled && largestLocation === null) {
        sub.updateSubscriber(subscriberId, {
          joiningFetchInProgress: false,
        });
      }

      sub.updateSubscriber(subscriberId, {
        subscriber: subscriberInstance,
        status: "connected",
        statusMessage: `Subscribed to ${namespaceArray.join("/")}/${actualTrackName}`,
        largestLocation: largestLocation ?? null,
      });
    } catch (error) {
      console.error(`[${subscriberId}] Connection error:`, error);
      sub.updateSubscriber(subscriberId, {
        status: "error",
        statusMessage: `Failed: ${(error as Error).message}`,
      });
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
    if (!instance || instance.isStopping) {
      return;
    }
    sub.updateSubscriber(subscriberId, {
      isStopping: true,
      status: "disconnected",
      statusMessage: "Disconnecting...",
    });

    try {
      if (instance.subscriber && instance.subscriber.state === "active") {
        await instance.subscriber.unsubscribe();
      }
    } finally {
      cleanupSubscriber();
      sub.updateSubscriber(subscriberId, {
        isStopping: false,
        status: "disconnected",
        statusMessage: "Ready to subscribe",
      });
    }
  };

  const cleanupSubscriber = (): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    // Close decoder
    if (instance.decoder) {
      try {
        instance.decoder.close();
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
    if (instance.session) {
      instance.session.close().catch(() => {
        // 既にクローズされている場合は無視
      });
    }

    sub.updateSubscriber(subscriberId, {
      session: null,
      subscriber: null,
      catalogSubscriber: null,
      catalog: null,
      decoder: null,
      decoderConfigured: false,
      codec: "",
    });

    // Enable settings if no other subscriber/publisher is active
    if (!sub.hasActiveSubscriber.value && !pub.pubSession.value) {
      settings.settingsDisabled.value = false;
    }
  };

  const requestKeyframe = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance?.subscriber || instance.subscriber.state !== "active") {
      console.warn(`[${subscriberId}] requestKeyframe: subscriber not active`);
      return;
    }

    try {
      // NEW_GROUP_REQUEST パラメータを含む REQUEST_UPDATE を送信
      // draft-ietf-moq-transport-17 Section 9.3.11
      // NEW_GROUP_REQUEST = 0x32
      await instance.subscriber.update({
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

  return {
    startSubscribing,
    stopSubscribing,
    requestKeyframe,
  };
}
