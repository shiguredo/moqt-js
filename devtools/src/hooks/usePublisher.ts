import {
  connect,
  LOC,
  CATALOG_TRACK_NAME,
  createCatalog,
  encodeCatalog,
  createCompleteCatalog,
  type DebugMessage,
  type CertificateHash,
} from "moqt-js";
import { getEncoderConfig, parseResolution } from "../utils/codec";
import { createDummyVideoStream } from "../webcodecs-devtools/utils/dummyVideo";
import { addLog } from "../components/DebugPanel";
import { EncoderWrapper, type EncodedChunkData } from "../utils/EncoderWrapper";
import * as settings from "../signals/connectionSettings";
import * as pub from "../signals/publisher";
import * as sub from "../signals/subscriber";

function handleDebugMessage(message: DebugMessage): void {
  const direction = message.direction === "send" ? "SEND" : "RECV";
  const logMessage = `[publisher] [${direction}] ${message.typeName}`;

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

  // Camera (getUserMedia)
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

      const sourceLabel = source === "dummy" ? "Dummy" : "Camera";
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = `Preview: ${sourceLabel} ${width}x${height} @ ${framerate}fps`;

      const videoStreamResult = await getVideoStream(source, width, height, framerate, deviceId);
      pub.mediaStream.value = videoStreamResult.stream;
      pub.videoStreamCleanup.value = videoStreamResult.cleanup;
      pub.isPreviewActive.value = true;
    } catch (error) {
      console.error("Preview error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `Preview failed: ${(error as Error).message}`;
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
    pub.pubStatusMessage.value = "Ready to publish";
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

    console.log("processFrames: starting frame processing loop");
    console.log("Encoder state:", encoderInstance.state);

    try {
      while (encoderInstance.state === "configured") {
        const { value: frame, done } = await reader.read();
        if (done) {
          console.log("processFrames: reader done");
          break;
        }

        if (encoderInstance.encodeQueueSize <= 2) {
          encoderInstance.encode(frame, {
            keyFrame: pub.framesEncoded.value % pub.keyframeInterval.value === 0,
          });
          pub.framesEncoded.value++;
        }
        frame.close();
      }
      console.log("processFrames: loop exited. Encoder state:", encoderInstance.state);
    } catch (error) {
      console.error("Frame processing error:", error);
      console.error("Encoder state at error:", encoderInstance.state);
    }
  }

  function handleEncodedChunk(chunk: EncodedChunkData): void {
    const publisherInstance = pub.publisher.value;
    if (!publisherInstance || publisherInstance.state !== "active") return;

    pub.chunksEncoded.value++;

    // New group on keyframe
    if (chunk.type === "key") {
      pub.pubCurrentGroup.value++;
      pub.pubCurrentObjectId.value = 0;
      pub.keyFramesEncoded.value++;
    }

    // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
    // H.264/H.265 は Annex B 形式で出力されるため、description は不要
    const payload = chunk.data;

    // LOC Properties をエンコード
    const extensions = LOC.encodeVideoProperties({
      timestamp: BigInt(chunk.timestamp),
      frameMarking: {
        isIndependent: chunk.type === "key",
        isDiscardable: chunk.type !== "key",
        isBaseLayerSync: chunk.type === "key",
        temporalLayerId: 0,
        spatialLayerId: 0,
      },
    });

    pub.objectsWithExtensions.value++;

    pub.bytesSent.value += payload.length + extensions.length;

    // Send object
    publisherInstance.sendObject({
      groupId: pub.pubCurrentGroup.value,
      objectId: pub.pubCurrentObjectId.value++,
      payload,
      extensions,
      priority: chunk.type === "key" ? 255 : 128,
    });

    pub.objectsSent.value++;
  }

  const startPublishing = async (): Promise<void> => {
    try {
      console.log("startPublishing: begin");
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = "Connecting...";
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
      console.log("startPublishing: settings loaded", {
        namespace: namespaceArray,
        trackName: trackNameValue,
        codec: codecValue,
        resolution: `${width}x${height}`,
      });

      // Build connect options
      const connectOptions: { serverCertificateHashes?: CertificateHash[] } = {};
      if (settings.certificateHash.value) {
        connectOptions.serverCertificateHashes = [
          {
            algorithm: "sha-256",
            value: settings.base64ToArrayBuffer(settings.certificateHash.value),
          },
        ];
      }

      // Connect to MOQT server
      console.log("startPublishing: connecting to", settings.url.value);
      const session = await connect(
        settings.url.value,
        {
          close: () => {
            pub.pubStatus.value = "disconnected";
            pub.pubStatusMessage.value = "Disconnected";
            cleanupPublisher();
          },
          error: (error) => {
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `Error: ${error.message}`;
            cleanupPublisher();
          },
          debug: handleDebugMessage,
        },
        connectOptions,
      );
      console.log("startPublishing: connected");
      pub.pubSession.value = session;

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = "Connected, publishing catalog...";

      // Catalog を publish
      const catalogPublisherInstance = await session.publish(
        namespaceArray,
        CATALOG_TRACK_NAME,
        {
          error: (error) => {
            console.error("Catalog publisher error:", error);
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
        },
      );
      pub.catalogPublisher.value = catalogPublisherInstance;

      // Catalog を作成して送信
      const createdCatalog = createCatalog([
        {
          name: trackNameValue,
          packaging: "loc",
          isLive: true,
          role: "video",
          codec:
            codecValue === "vp8" ? "vp8" : codecValue === "vp9" ? "vp09.00.10.08" : "av01.0.04M.08",
          width,
          height,
          framerate: framerateValue,
          bitrate: bitrateValue,
        },
      ]);
      const catalogPayload = encodeCatalog(createdCatalog);
      catalogPublisherInstance.sendObject({
        groupId: 0n,
        objectId: 0n,
        payload: catalogPayload,
      });
      pub.catalog.value = createdCatalog;
      addLog("info", `[publisher] [SEND] OBJECT (${CATALOG_TRACK_NAME})`, {
        source: "publish",
        catalog: createdCatalog,
      });

      pub.pubStatusMessage.value = "Connected, setting up encoder...";

      // Use existing preview stream or create new one
      let actualWidth: number;
      let actualHeight: number;

      console.log(
        "startPublishing: getting video stream, isPreviewActive:",
        pub.isPreviewActive.value,
      );
      if (pub.isPreviewActive.value && pub.mediaStream.value) {
        actualWidth = width;
        actualHeight = height;
        console.log("startPublishing: using existing preview stream");
      } else {
        console.log("startPublishing: creating new video stream");
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
        console.log("startPublishing: video stream created", { actualWidth, actualHeight });
      }

      // Get video track
      const videoTrack = pub.mediaStream.value?.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error("Failed to get video track");
      }
      console.log("startPublishing: video track obtained", videoTrack.label);

      pub.isPreviewActive.value = false;

      // Create publisher
      console.log("startPublishing: sending PUBLISH, waiting for PUBLISH_OK...");
      const publisherInstance = await session.publish(
        namespaceArray,
        trackNameValue,
        {
          error: (error) => {
            console.error("Publisher error:", error);
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `Publish error: ${error.message}`;
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
        },
      );
      console.log("startPublishing: PUBLISH_OK received");
      pub.publisher.value = publisherInstance;

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = `Publishing to ${namespaceArray.join("/")}/${trackNameValue}`;

      // Check MediaStreamTrackProcessor availability
      if (typeof MediaStreamTrackProcessor === "undefined") {
        throw new Error("MediaStreamTrackProcessor is not supported in this browser");
      }

      // Create encoder config and check support
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
      console.log("Encoder config supported:", support.config);

      // Create encoder wrapper
      const useWorker = settings.useDedicatedWorker.value;
      console.log("Creating encoder with Worker mode:", useWorker);

      const encoderInstance = new EncoderWrapper(useWorker, {
        output: (chunk) => {
          handleEncodedChunk(chunk);
        },
        error: (error) => {
          console.error("Encoder error:", error);
          pub.encodeErrors.value++;
          pub.encoderState.value = encoderInstance.state;
          pub.pubStatus.value = "error";
          pub.pubStatusMessage.value = `Encoder error: ${error.message}`;
        },
      });
      pub.encoder.value = encoderInstance;

      // Configure encoder
      await encoderInstance.configure(encoderConfig);
      pub.encoderState.value = encoderInstance.state;

      // Verify encoder state after configure
      if (encoderInstance.state !== "configured") {
        throw new Error(`Encoder failed to configure. State: ${encoderInstance.state}`);
      }
      console.log("Encoder configured successfully. State:", encoderInstance.state);

      // Show codec badge
      pub.pubCodec.value = `${codecValue.toUpperCase()} ${actualWidth}x${actualHeight}`;

      // Process video frames using MediaStreamTrackProcessor
      const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
      pub.frameReader.value = trackProcessor.readable.getReader();
      console.log("Frame reader created");

      // Reset stats
      pub.framesEncoded.value = 0;
      pub.keyFramesEncoded.value = 0;
      pub.objectsSent.value = 0;
      pub.pubCurrentGroup.value = Date.now();
      pub.pubCurrentObjectId.value = 0;
      pub.bytesSent.value = 0;
      pub.chunksEncoded.value = 0;
      pub.encodeErrors.value = 0;
      pub.objectsWithExtensions.value = 0;

      // Read and encode frames
      void processFrames();
    } catch (error) {
      console.error("Connection error:", error);
      pub.pubStatus.value = "error";
      pub.pubStatusMessage.value = `Failed: ${(error as Error).message}`;
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
    pub.pubStatusMessage.value = "Disconnecting...";

    try {
      // Complete catalog を送信
      if (pub.catalogPublisher.value && pub.catalogPublisher.value.state === "active") {
        const completeCatalog = createCompleteCatalog();
        const completeCatalogPayload = encodeCatalog(completeCatalog);
        pub.catalogPublisher.value.sendObject({
          groupId: 1n,
          objectId: 0n,
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
      pub.pubStatusMessage.value = "Ready to publish";
    }
  };

  const cleanupPublisher = (): void => {
    // Cancel frame reader
    if (pub.frameReader.value) {
      void pub.frameReader.value.cancel();
      pub.frameReader.value = null;
    }

    // Close encoder
    if (pub.encoder.value) {
      try {
        pub.encoder.value.close();
      } catch {
        // Ignore
      }
      pub.encoder.value = null;
    }
    pub.encoderState.value = "unconfigured";

    // Cleanup video stream
    if (pub.videoStreamCleanup.value) {
      pub.videoStreamCleanup.value();
      pub.videoStreamCleanup.value = null;
    }
    pub.mediaStream.value = null;

    // Close session
    if (pub.pubSession.value) {
      pub.pubSession.value.close().catch(() => {
        // 既にクローズされている場合は無視
      });
      pub.pubSession.value = null;
    }

    pub.publisher.value = null;
    pub.catalogPublisher.value = null;
    pub.catalog.value = null;
    pub.pubCodec.value = "";

    // Enable settings if no subscriber is active
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
