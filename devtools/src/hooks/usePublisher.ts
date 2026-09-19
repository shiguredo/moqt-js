import {
  connect,
  LOC,
  CATALOG_TRACK_NAME,
  createCatalog,
  encodeCatalog,
  createCompleteCatalog,
  createVideoFrameSource,
  type AuthorizationToken,
  type Catalog,
  type DebugMessage,
  type CertificateHash,
} from "moqt-js";
import { getCatalogCodec, getEncoderConfig, parseResolution } from "../utils/codec";
import type { CodecType } from "../types";
import { base64ToArrayBuffer } from "../utils/base64";
import { createDummyVideoStream } from "../webcodecs-devtools/utils/dummyVideo";
import { addLog } from "../components/DebugPanel";
import { logDebugMessage } from "./debugMessageLog";
import { EncoderWrapper, type EncodedChunkData } from "../utils/EncoderWrapper";
import * as settings from "../signals/connectionSettings";
import * as pub from "../signals/publisher";
import * as sub from "../signals/subscriber";

export function handleDebugMessage(message: DebugMessage): void {
  logDebugMessage("[publisher]", message);
}

/** 配信する映像トラックの Catalog を組み立てるための入力 */
export interface PublisherCatalogOptions {
  trackName: string;
  codec: CodecType;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
}

/**
 * 配信する映像トラックの Catalog を組み立てる
 *
 * draft-ietf-moq-msf-01 §5.1 の full catalog を 1 トラック分だけ生成する。
 * codec 文字列は `getCatalogCodec` を通し、Encoder に渡す `getEncoderConfig` と
 * 同一の対応表を使う (Catalog の codec 誤記は購読側の Decoder 設定を壊すため、
 * 対応表の二重管理を避ける)。
 *
 * ブラウザ API に依存しないため、送信した Catalog の内容はここで検証できる。
 */
export function buildPublisherCatalog(options: PublisherCatalogOptions): Catalog {
  return createCatalog([
    {
      name: options.trackName,
      packaging: "loc",
      isLive: true,
      role: "video",
      codec: getCatalogCodec(options.codec),
      width: options.width,
      height: options.height,
      framerate: options.framerate,
      bitrate: options.bitrate,
    },
  ]);
}

/** 送信する 1 Object の内容 */
export interface ObjectSendPlan {
  /** この Object を載せる Group ID */
  groupId: number;
  /** この Object の Object ID */
  objectId: number;
  /** 次の Object が載る Group ID */
  nextGroupId: number;
  /** 次の Object の Object ID */
  nextObjectId: number;
  /** 送信する payload (WebCodecs の internal data をそのまま使う) */
  payload: Uint8Array;
  /** LOC Properties をエンコードしたバイト列 */
  properties: Uint8Array;
  /** Publisher Priority */
  priority: number;
  /** キーフレーム (新しい Group を開始した Object) かどうか */
  isKeyFrame: boolean;
}

/**
 * エンコード済み chunk から送信する 1 Object の内容を組み立てる
 *
 * `handleEncodedChunk` から送信処理 (`Publisher.sendObject`) と signal 更新を
 * 除いた純粋部分。Group / Object ID の採番、LOC Properties のエンコード、
 * Priority の決定をここに集約し、ブラウザ API 無しで契約を検証できるようにする。
 *
 * Group / Object ID (draft-ietf-moq-msf-01 §6.1):
 * キーフレームで新しい Group を開始し (Group ID は単調増加)、Object ID を 0 に戻す。
 * デルタフレームは同じ Group の続きとして Object ID を進める。
 *
 * LOC Properties (draft-ietf-moq-loc-04 §2.3.2):
 * TIMESTAMP と VIDEO_FRAME_MARKING を載せる。isDiscardable は WebCodecs が
 * 破棄可能性情報を提供しないため false 固定 (RFC 9626 §3.1 D の「the sender knows」を
 * 守るため)。isBaseLayerSync はソース上のキーフレーム意図マーカとして残すが、
 * temporalLayerId=0 固定のためワイヤ上 B=0 に抑圧される。
 * canonical 形式 (avc1 / hvc1) のときだけ WebCodecs の description を
 * Video Config (ID: 0x0D) として載せる (annexB 形式では description が無い)。
 */
export function buildObjectSendPlan(
  location: { groupId: number; objectId: number },
  chunk: EncodedChunkData,
): ObjectSendPlan {
  const isKeyFrame = chunk.type === "key";
  const groupId = isKeyFrame ? location.groupId + 1 : location.groupId;
  const objectId = isKeyFrame ? 0 : location.objectId;

  // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
  const payload = chunk.data;

  const properties = LOC.encodeVideoProperties({
    timestamp: BigInt(chunk.timestamp),
    frameMarking: {
      isIndependent: isKeyFrame,
      isDiscardable: false,
      isBaseLayerSync: isKeyFrame,
      temporalLayerId: 0,
      spatialLayerId: 0,
    },
    config: chunk.description,
  });

  return {
    groupId,
    objectId,
    nextGroupId: groupId,
    nextObjectId: objectId + 1,
    payload,
    properties,
    // キーフレームは即時配送を優先し、デルタフレームは既定優先度にする
    priority: isKeyFrame ? 255 : 128,
    isKeyFrame,
  };
}

/**
 * フレームにキーフレームを要求するかを判定する
 *
 * 先頭フレーム (framesEncoded = 0) と keyframeInterval フレームごとに要求する。
 * 要求しないフレームはエンコーダがデルタフレームとして符号化する。
 * 間隔を無視して全フレームをキーフレームにすると帯域を浪費し、
 * 逆に要求が一度も出ないと購読を開始できないため、境界を検証できる形にする。
 */
export function shouldRequestKeyFrame(framesEncoded: number, keyframeInterval: number): boolean {
  return framesEncoded % keyframeInterval === 0;
}

interface VideoStreamResult {
  stream: MediaStream;
  width: number;
  height: number;
  cleanup: () => void;
}

async function getVideoStream(
  source: "dummy" | "camera",
  width: number,
  height: number,
  framerate: number,
  deviceId?: string,
): Promise<VideoStreamResult> {
  if (source === "dummy") {
    const generator = createDummyVideoStream(width, height, framerate);
    return {
      stream: generator.stream,
      width,
      height,
      cleanup: (): void => {
        generator.stop();
        for (const track of generator.stream.getTracks()) {
          track.stop();
        }
      },
    };
  }

  // カメラ (getUserMedia)
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: framerate },
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("Failed to get video track from camera");
  }

  const videoSettings = videoTrack.getSettings();
  return {
    stream,
    width: videoSettings.width ?? width,
    height: videoSettings.height ?? height,
    cleanup: (): void => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

export function usePublisher() {
  const startPreview = async (): Promise<void> => {
    try {
      const { width, height } = parseResolution(settings.resolution.value);
      const framerate = settings.framerate.value;
      const source = settings.videoSource.value;
      const deviceId = source === "camera" ? settings.selectedCameraDeviceId.value : undefined;

      const sourceLabel = source === "dummy" ? "ダミー" : "カメラ";
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = `プレビュー: ${sourceLabel} ${width}x${height} @ ${framerate}fps`;

      const videoStreamResult = await getVideoStream(source, width, height, framerate, deviceId);
      pub.mediaStream.value = videoStreamResult.stream;
      pub.videoStreamCleanup.value = videoStreamResult.cleanup;
      pub.isPreviewActive.value = true;
    } catch (error) {
      console.error("Preview error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `プレビュー失敗: ${(error as Error).message}`;
    }
  };

  const stopPreview = (): void => {
    if (pub.videoStreamCleanup.value) {
      pub.videoStreamCleanup.value();
      pub.videoStreamCleanup.value = null;
    }
    pub.mediaStream.value = null;
    pub.isPreviewActive.value = false;
    pub.pubStatus.value = "disconnected";
    pub.pubStatusMessage.value = "配信開始待ち";
  };

  const togglePreview = (): void => {
    if (pub.isPreviewActive.value) {
      stopPreview();
    } else {
      void startPreview();
    }
  };

  async function processFrames(): Promise<void> {
    const reader = pub.frameReader.value;
    const encoderInstance = pub.encoder.value;
    if (!reader || !encoderInstance) {
      console.error("processFrames: reader or encoder is null", { reader, encoderInstance });
      return;
    }

    try {
      while (encoderInstance.state === "configured") {
        const { value: frame, done } = await reader.read();
        if (done) {
          break;
        }

        if (encoderInstance.encodeQueueSize <= 2) {
          encoderInstance.encode(frame, {
            keyFrame: shouldRequestKeyFrame(pub.framesEncoded.value, pub.keyframeInterval.value),
          });
          pub.framesEncoded.value++;
        }
        frame.close();
      }
    } catch (error) {
      console.error("Frame processing error:", error);
      console.error("Encoder state at error:", encoderInstance.state);
    }
  }

  function handleEncodedChunk(chunk: EncodedChunkData): void {
    const publisherInstance = pub.publisher.value;
    if (!publisherInstance || publisherInstance.state !== "active") return;

    pub.chunksEncoded.value++;

    // 送信する Object の内容 (Group / Object ID・payload・LOC Properties・優先度) を組み立てる
    const plan = buildObjectSendPlan(
      { groupId: pub.pubCurrentGroup.value, objectId: pub.pubCurrentObjectId.value },
      chunk,
    );

    if (plan.isKeyFrame) {
      pub.keyFramesEncoded.value++;
    }

    pub.pubCurrentGroup.value = plan.nextGroupId;
    pub.pubCurrentObjectId.value = plan.nextObjectId;

    pub.objectsWithExtensions.value++;

    pub.bytesSent.value += plan.payload.length + plan.properties.length;

    // Object を送信する (送信完了は待たない。完了待ちは stopPublishing の done() で行う)
    void publisherInstance.sendObject({
      groupId: plan.groupId,
      objectId: plan.objectId,
      payload: plan.payload,
      properties: plan.properties,
      priority: plan.priority,
    });

    pub.objectsSent.value++;
  }

  // Catalog を新しい Group で送り直す
  //
  // 同じ Location を 2 度送ると購読側で重複として扱われるため、送り直しは Group を
  // 進めて行う (draft-ietf-moq-msf-01 §6.1)。Object ID は Group の先頭 Object の
  // ため 0 にする (§6.2)。Catalog Publisher が active でなければ何もしない。
  const sendCatalogUpdate = async (): Promise<void> => {
    const catalogPublisherInstance = pub.catalogPublisher.value;
    const currentCatalog = pub.catalog.value;
    if (
      !catalogPublisherInstance ||
      catalogPublisherInstance.state !== "active" ||
      currentCatalog === null
    ) {
      return;
    }
    const groupId = pub.catalogGroup.value + 1;
    pub.catalogGroup.value = groupId;
    await catalogPublisherInstance.sendObject({
      groupId,
      objectId: 0,
      payload: encodeCatalog(currentCatalog),
    });
    addLog("info", `[publisher] [SEND] OBJECT (${CATALOG_TRACK_NAME}, updated)`, {
      source: "publish",
      catalogGroup: groupId,
    });
  };

  const startPublishing = async (): Promise<void> => {
    try {
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = "接続中...";
      settings.settingsDisabled.value = true;

      const namespaceArray = settings.namespace.value.split("/").filter((s) => s.length > 0);
      const trackNameValue = settings.trackName.value;
      const codecValue = settings.codec.value;
      const videoSourceValue = settings.videoSource.value;
      const { width, height } = parseResolution(settings.resolution.value);
      const framerateValue = settings.framerate.value;
      const bitrateValue = settings.bitrate.value;
      const maxCacheDurationValue = settings.maxCacheDuration.value;
      pub.keyframeInterval.value = settings.keyframeInterval.value;

      // 接続オプションを組み立てる
      const connectOptions: {
        serverCertificateHashes?: CertificateHash[];
        authorizationToken?: AuthorizationToken;
      } = {};
      if (settings.certificateHash.value) {
        connectOptions.serverCertificateHashes = [
          {
            algorithm: "sha-256",
            value: base64ToArrayBuffer(settings.certificateHash.value),
          },
        ];
      }
      const authToken = settings.buildAuthorizationToken();
      if (authToken) {
        connectOptions.authorizationToken = authToken;
      }

      // MOQT サーバーへ接続する
      const connectUrl = settings.buildConnectUrl();
      const session = await connect(
        connectUrl,
        {
          close: (closeInfo) => {
            addLog("warn", `[publisher] webtransport closed`, {
              closeCode: closeInfo.closeCode,
              // WebTransportCloseInfo.reason は optional のため未指定時は空文字にする
              reason: (closeInfo.reason ?? "").slice(0, 1024),
            });
            pub.pubStatus.value = "disconnected";
            pub.pubStatusMessage.value = `切断: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            cleanupPublisher();
          },
          error: (error) => {
            addLog("error", `[publisher] webtransport error`, {
              name: error.name ?? "Error",
              message: error.message ?? String(error),
            });
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `エラー: ${error.message}`;
            cleanupPublisher();
          },
          debug: handleDebugMessage,
        },
        connectOptions,
      );
      pub.pubSession.value = session;
      settings.reliability.value = session.reliability;

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = "接続完了、Catalog を配信中...";

      // Catalog を publish
      const catalogPublisherInstance = await session.publish(
        namespaceArray,
        CATALOG_TRACK_NAME,
        {
          error: (error) => {
            console.error("Catalog publisher error:", error);
          },
          // 購読者が付いて Catalog の Forward State が 1 になったら送り直す。
          //
          // draft-ietf-moq-transport-21 Section 3.1: publisher は Forward State が 0 の
          // 間 Object を送らない。relay は購読者が居ない間 FORWARD=0 を伝えるため、配信
          // 開始時に送った Catalog は送信が見送られるか、購読者へ届く前に捨てられる。
          // 後から視聴を始めた相手にもトラック構成を知らせるため、Catalog の Forward
          // State が 1 になった時点で新しい Group として送り直す
          onForwardStateChange: (forward) => {
            if (forward) {
              void sendCatalogUpdate();
            }
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
        },
      );
      pub.catalogPublisher.value = catalogPublisherInstance;

      // Catalog を作成して送信
      const createdCatalog = buildPublisherCatalog({
        trackName: trackNameValue,
        codec: codecValue,
        width,
        height,
        framerate: framerateValue,
        bitrate: bitrateValue,
      });
      const catalogPayload = encodeCatalog(createdCatalog);
      // draft-ietf-moq-msf-01 §6.1:
      // Group ID は Track ごとに単調増加が MUST であり、publisher が再起動した場合は
      // 以前に publish したどの Group ID よりも大きい値から始めなければならない。
      // 映像トラックと同じく Unix epoch ミリ秒を開始値にする。
      pub.catalogGroup.value = Date.now();
      // Forward State が 1 に変わった時点で送り直すため、送信前に保持値を確定させる
      pub.catalog.value = createdCatalog;
      // Catalog の送信完了は待たず、stopPublishing の done() で待ち合わせる
      void catalogPublisherInstance.sendObject({
        groupId: pub.catalogGroup.value,
        objectId: 0,
        payload: catalogPayload,
      });
      addLog("info", `[publisher] [SEND] OBJECT (${CATALOG_TRACK_NAME})`, {
        source: "publish",
        catalog: createdCatalog,
      });

      pub.pubStatusMessage.value = "接続完了、Encoder を準備中...";

      // 既存のプレビューストリームがあれば再利用し、無ければ新規作成する
      let actualWidth: number;
      let actualHeight: number;

      if (pub.isPreviewActive.value && pub.mediaStream.value) {
        actualWidth = width;
        actualHeight = height;
      } else {
        const cameraDeviceId =
          videoSourceValue === "camera" ? settings.selectedCameraDeviceId.value : undefined;
        const videoStreamResult = await getVideoStream(
          videoSourceValue,
          width,
          height,
          framerateValue,
          cameraDeviceId,
        );
        pub.mediaStream.value = videoStreamResult.stream;
        pub.videoStreamCleanup.value = videoStreamResult.cleanup;
        actualWidth = videoStreamResult.width;
        actualHeight = videoStreamResult.height;
      }

      // 映像トラックを取得する
      const videoTrack = pub.mediaStream.value?.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error("Failed to get video track");
      }

      pub.isPreviewActive.value = false;

      // Publisher を作成する
      const publisherInstance = await session.publish(
        namespaceArray,
        trackNameValue,
        {
          error: (error) => {
            console.error("Publisher error:", error);
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `配信エラー: ${error.message}`;
          },
          // draft-ietf-moq-transport-21 Section 3.1:
          // Forward State の変化を追跡する
          onForwardStateChange: (forward) => {
            pub.forwardState.value = forward;
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
        },
      );
      pub.forwardState.value = publisherInstance.forwardState;
      pub.publisher.value = publisherInstance;

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = `配信中: ${namespaceArray.join("/")}/${trackNameValue}`;

      // Encoder 設定を作成し、対応状況を確認する
      const encoderConfig = getEncoderConfig(
        codecValue,
        actualWidth,
        actualHeight,
        bitrateValue,
        framerateValue,
      );

      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) {
        throw new Error(`Codec not supported: ${encoderConfig.codec}`);
      }

      // EncoderWrapper を作成する
      const useWorker = settings.useDedicatedWorker.value;

      const encoderInstance = new EncoderWrapper(useWorker, {
        output: (chunk) => {
          handleEncodedChunk(chunk);
        },
        error: (error) => {
          console.error("Encoder error:", error);
          pub.encodeErrors.value++;
          pub.encoderState.value = encoderInstance.state;
          pub.pubStatus.value = "error";
          pub.pubStatusMessage.value = `Encoder エラー: ${error.message}`;
        },
      });
      pub.encoder.value = encoderInstance;

      // Encoder を設定する
      await encoderInstance.configure(encoderConfig);
      pub.encoderState.value = encoderInstance.state;

      // configure 後の Encoder 状態を検証する
      if (encoderInstance.state !== "configured") {
        throw new Error(`Encoder failed to configure. State: ${encoderInstance.state}`);
      }

      // codec バッジを表示する
      pub.pubCodec.value = `${codecValue.toUpperCase()} ${actualWidth}x${actualHeight}`;

      // VideoFrame ソースを作成する
      // MediaStreamTrackProcessor が利用可能な場合はそれを使い、
      // 利用できない場合は requestVideoFrameCallback でフォールバックする
      const videoFrameSource = createVideoFrameSource(videoTrack);
      pub.frameReader.value = videoFrameSource.readable.getReader();

      // 統計値をリセットする
      pub.framesEncoded.value = 0;
      pub.keyFramesEncoded.value = 0;
      pub.objectsSent.value = 0;
      pub.pubCurrentGroup.value = Date.now();
      pub.pubCurrentObjectId.value = 0;
      pub.bytesSent.value = 0;
      pub.chunksEncoded.value = 0;
      pub.encodeErrors.value = 0;
      pub.objectsWithExtensions.value = 0;

      // フレームを読み出してエンコードする
      void processFrames();
    } catch (error) {
      console.error("Connection error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `失敗: ${(error as Error).message}`;
      cleanupPublisher();
      settings.settingsDisabled.value = false;
    }
  };

  const stopPublishing = async (): Promise<void> => {
    // 二重実行防止
    if (pub.isStopping.value) {
      return;
    }
    pub.isStopping.value = true;

    pub.pubStatus.value = "disconnected";
    pub.pubStatusMessage.value = "切断中...";

    try {
      // Complete catalog を送信
      if (pub.catalogPublisher.value && pub.catalogPublisher.value.state === "active") {
        const completeCatalog = createCompleteCatalog();
        const completeCatalogPayload = encodeCatalog(completeCatalog);
        // 最後に Catalog を送った Group の次を使う。固定値にすると、購読者の到着に
        // よる Catalog の送り直しと Group ID が衝突し得る (draft-ietf-moq-msf-01 §6.1)。
        const completeCatalogGroup = pub.catalogGroup.value + 1;
        pub.catalogGroup.value = completeCatalogGroup;
        // Complete catalog の送信完了は直後の done() で待ち合わせる
        void pub.catalogPublisher.value.sendObject({
          groupId: completeCatalogGroup,
          objectId: 0,
          payload: completeCatalogPayload,
        });
        addLog("info", `[publisher] [SEND] OBJECT (${CATALOG_TRACK_NAME}, complete)`, {
          source: "publish",
          catalog: completeCatalog,
        });
        await pub.catalogPublisher.value.done();
      }

      if (pub.publisher.value && pub.publisher.value.state === "active") {
        await pub.publisher.value.done();
      }
    } finally {
      cleanupPublisher();
      pub.isStopping.value = false;
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = "配信開始待ち";
    }
  };

  const cleanupPublisher = (): void => {
    // フレームリーダーをキャンセルする
    if (pub.frameReader.value) {
      void pub.frameReader.value.cancel();
      pub.frameReader.value = null;
    }

    // Encoder を閉じる
    if (pub.encoder.value) {
      try {
        pub.encoder.value.close();
      } catch {
        // 無視する
      }
      pub.encoder.value = null;
    }
    pub.encoderState.value = "unconfigured";

    // 映像ストリームを解放する
    if (pub.videoStreamCleanup.value) {
      pub.videoStreamCleanup.value();
      pub.videoStreamCleanup.value = null;
    }
    pub.mediaStream.value = null;

    // セッションを閉じる
    if (pub.pubSession.value) {
      pub.pubSession.value.close().catch(() => {
        // 既にクローズされている場合は無視
      });
      pub.pubSession.value = null;
    }

    pub.publisher.value = null;
    pub.catalogPublisher.value = null;
    pub.catalog.value = null;
    // catalogGroup は次回の startPublishing が Date.now() で設定し直す。
    // 0 に戻すと、再起動後の Group ID が前回より小さくなり
    // draft-ietf-moq-msf-01 §6.1 の MUST に反するため触らない。
    pub.pubCodec.value = "";
    pub.forwardState.value = null;

    // アクティブな Subscriber が居なければ設定を有効化する
    if (!sub.hasActiveSubscriber.value) {
      settings.settingsDisabled.value = false;
    }
  };

  return {
    startPreview,
    stopPreview,
    togglePreview,
    startPublishing,
    stopPublishing,
  };
}
