import {
  connect,
  LOC,
  CATALOG_TRACK_NAME,
  createCatalog,
  encodeCatalog,
  createCompleteCatalog,
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type Catalog,
  type CatalogTrack,
  type DebugMessage,
  type Session,
} from "moqt-js";
import {
  getCatalogCodec,
  getEncoderConfig,
  isSameCodecDescription,
  parseResolution,
} from "../utils/codec";
import type { AudioCodecType, AudioSourceType, CodecType } from "../types";
import { createDummyVideoStream } from "../webcodecs-devtools/utils/dummyVideo";
import {
  createDummyAudioStream,
  createToneSamples,
  summarizeToneLevel,
  type ToneAudioLevel,
} from "../webcodecs-devtools/utils/dummyAudio";
import { AudioEncoderWrapper } from "../../../src/codec/AudioEncoder.ts";
import type { AudioEncodedChunkData } from "../../../src/codec/types.ts";
import { getAudioEncoderConfig } from "../../../src/codec/config.ts";
import {
  allocateAudioObject,
  allocateInitialGroupId,
  PRIORITY_AUDIO,
  PRIORITY_VIDEO_DELTA,
  PRIORITY_VIDEO_KEY,
} from "../../../src/createMediaPublisher.ts";
import { addLog } from "../components/DebugPanel";
import { logDebugMessage } from "./debugMessageLog";
import { EncoderWrapper, type EncodedChunkData } from "../utils/EncoderWrapper";
import { WallClockMapper } from "../../../src/mediaClock.ts";
import { EMPTY_PUBLISH_TIMING, PublishTimingStats } from "../utils/publishTimingStats";
import * as settings from "../signals/connectionSettings";
import * as pub from "../signals/publisher";
import * as sub from "../signals/subscriber";

export function handleDebugMessage(message: DebugMessage): void {
  logDebugMessage("[publisher]", message);
}

/**
 * 音声トラック名
 *
 * `src/createMedia/settings.ts` の `DEFAULT_AUDIO_TRACK_NAME` と同じ値にする。
 * 映像トラック名 (`settings.trackName`) は利用者が変えられるため、音声は固定名にする。
 */
const AUDIO_TRACK_NAME = "audio";

/**
 * Audio Level を求める窓の長さ (ミリ秒)
 *
 * Opus の 1 フレーム相当。RFC 6464 §3 は audio level を「ペイロードが符号化する
 * サンプルの RMS」で測ると定めるため、chunk 1 つ分に相当する長さで測る。
 */
const AUDIO_LEVEL_WINDOW_MS = 20;

/**
 * 符号化と送信の時間の統計を画面へ反映する間隔 (ミリ秒)
 *
 * encoder の出力ごとに統計を求めると、分布を求める並べ替えが配信 fps の回数だけ走る。
 * 画面の更新には 0.5 秒ごとで足りる
 */
const PUBLISH_TIMING_UPDATE_INTERVAL_MS = 500;

/**
 * 配信を始めるときに、映像の配信の状態を作り直す (前の配信の対応や記録を持ち越さない)
 *
 * TIMESTAMP の壁時計への換算、符号化と送信の時間の記録、キーフレームの間隔の数え方と
 * 新しい Group の要求を初期化する。
 */
function resetVideoPublishState(): void {
  pub.videoWallClock.value = new WallClockMapper();
  pub.publishTimingStats.value = new PublishTimingStats();
  pub.publishTiming.value = EMPTY_PUBLISH_TIMING;
  pub.publishTimingUpdatedAtMs.value = 0;
  pub.framesSinceKeyFrame.value = 0;
  pub.newGroupRequested.value = false;
  pub.newGroupRequestsReceived.value = 0;
}

/** 配信する映像トラックの Catalog を組み立てるための入力 */
export interface PublisherCatalogOptions {
  trackName: string;
  codec: CodecType;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  /** 音声トラックを配信するときの設定。省略時は映像トラックだけを載せる */
  audio?: PublisherAudioCatalogOptions;
}

/** 配信する音声トラックの Catalog を組み立てるための入力 */
export interface PublisherAudioCatalogOptions {
  codec: AudioCodecType;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

/**
 * 配信する映像トラックと音声トラックの Catalog を組み立てる
 *
 * draft-ietf-moq-msf-01 §5.1 の full catalog を生成する。
 * codec 文字列は映像が `getCatalogCodec`、音声が `getAudioEncoderConfig` を通し、
 * Encoder に渡す設定と同一の対応表を使う (Catalog の codec 誤記は購読側の Decoder
 * 設定を壊すため、対応表の二重管理を避ける)。
 *
 * 音声トラックに `samplerate` / `channelConfig` / `bitrate` を載せるのは、
 * MSF §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) /
 * §5.2.29 (channelConfig) がいずれも audio codec を指定する track に MUST で
 * 要求するため。
 *
 * ブラウザ API に依存しないため、送信した Catalog の内容はここで検証できる。
 */
export function buildPublisherCatalog(options: PublisherCatalogOptions): Catalog {
  const tracks: CatalogTrack[] = [
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
  ];

  if (options.audio) {
    const audio = options.audio;
    tracks.push({
      name: AUDIO_TRACK_NAME,
      packaging: "loc",
      isLive: true,
      role: "audio",
      codec: getAudioEncoderConfig(audio.codec, audio.bitrate, audio.sampleRate, audio.channels)
        .codec,
      bitrate: audio.bitrate,
      samplerate: audio.sampleRate,
      channelConfig: String(audio.channels),
    });
  }

  return createCatalog(tracks);
}

/**
 * 音声を配信できるかどうかを判定する
 *
 * MediaStreamTrackProcessor は音声の取り出しに必須で、未実装のブラウザ
 * (Firefox / Safari) では音声だけを諦める。配信開始後に throw すると、既に
 * 確立した映像の配信まで巻き込んで止まるため、Catalog を作る前に判定する。
 */
export function resolveAudioPublishable(audioSource: AudioSourceType): boolean {
  return audioSource === "dummy" && isMediaStreamTrackProcessorAvailable();
}

/**
 * 送る Audio Config を決める純関数
 *
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) の Audio Config は、WebCodecs の
 * `EncodedAudioChunkMetadata.decoderConfig.description` として現れたときにだけ
 * 載せる。同じ値を毎 Object 送ると無駄になるため、直前と異なるときだけ載せる。
 *
 * ただし WebCodecs は description を configure 後の最初の出力にしか付けないため、
 * 後から接続した購読者は Audio Config を受け取れない (音声には keyframe が無い)。
 * 送り直しを要求されたら、保持している値をそのまま載せ直す。
 * ブラウザ API に依存しないため、この判断はここで検証できる。
 *
 * @param previous - 直前に送った Audio Config (未送信なら null)
 * @param description - 今回の chunk が持つ Audio Config (opus では undefined)
 * @param resendRequested - 保持している Audio Config の送り直しを要求されているか
 * @returns 今回載せる config、次回のために保持する値、送り直し要求を残すか
 */
export function resolveAudioConfigToSend(
  previous: Uint8Array | null,
  description: Uint8Array | undefined,
  resendRequested: boolean,
): { config: Uint8Array | undefined; next: Uint8Array | null; resendNext: boolean } {
  if (description !== undefined && !isSameCodecDescription(previous, description)) {
    return { config: description, next: new Uint8Array(description), resendNext: false };
  }
  if (resendRequested && previous !== null) {
    return { config: previous, next: previous, resendNext: false };
  }
  // 保持する値が無いまま要求された場合は、次に description が現れたときに備えて残す
  return { config: undefined, next: previous, resendNext: resendRequested };
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
 * TIMESTAMP と VIDEO_FRAME_MARKING を載せる。TIMESTAMP は Timescale を載せないため
 * Unix epoch のマイクロ秒 (壁時計) である (§2.3.1.1)。VideoFrame の timestamp は
 * 取得元ごとに基準が異なるため、呼び出し側が読んだフレームとの対応から壁時計に
 * 換算した値 (`wallClockMicros`、ライブラリの src/mediaClock.ts の WallClockMapper) を
 * そのまま載せる。isDiscardable は WebCodecs が
 * 破棄可能性情報を提供しないため false 固定 (RFC 9626 §3.1 D の「the sender knows」を
 * 守るため)。isBaseLayerSync はソース上のキーフレーム意図マーカとして残すが、
 * temporalLayerId=0 固定のためワイヤ上 B=0 に抑圧される。
 * canonical 形式 (avc1 / hvc1) のときだけ WebCodecs の description を
 * Video Config (ID: 0x0D) として載せる (annexB 形式では description が無い)。
 *
 * @param location - 直前の Object の次の位置 (Group ID と Object ID)
 * @param chunk - エンコード済み chunk
 * @param wallClockMicros - chunk の timestamp を壁時計 (Unix epoch マイクロ秒) に換算した値
 */
export function buildObjectSendPlan(
  location: { groupId: number; objectId: number },
  chunk: EncodedChunkData,
  wallClockMicros: bigint,
): ObjectSendPlan {
  const isKeyFrame = chunk.type === "key";
  const groupId = isKeyFrame ? location.groupId + 1 : location.groupId;
  const objectId = isKeyFrame ? 0 : location.objectId;

  // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
  const payload = chunk.data;

  const properties = LOC.encodeVideoProperties({
    timestamp: wallClockMicros,
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
    // キーフレームは即時配送を優先し、デルタフレームは既定優先度にする。
    // キーフレームは常に新しい Group (= Subgroup) の先頭 Object になるため、
    // この値がその Subgroup の実効優先度になる
    priority: isKeyFrame ? PRIORITY_VIDEO_KEY : PRIORITY_VIDEO_DELTA,
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

/**
 * 次に符号化するフレームをキーフレームにするかを決める
 *
 * keyframeInterval ごとのキーフレームに加えて、新しい Group の要求 (NEW_GROUP_REQUEST) を
 * 受けていれば次のフレームをキーフレームにして新しい Group を始める
 * (draft-ietf-moq-transport-21 Section 9.20.20: dynamic Groups に対応する publisher は、現在の
 * Group を終えて新しい Group をできるだけ早く始める SHOULD)。キーフレームにしたフレームから
 * 間隔を数え直す。次のフレームまでに届いた複数の要求は 1 枚のキーフレームにまとまる
 *
 * @param framesSinceKeyFrame - 直前のキーフレームから符号化したフレーム数 (最初は 0)
 * @param newGroupRequested - 新しい Group の要求を受けて、まだキーフレームにしていないか
 * @returns キーフレームにするかと、このフレームを符号化した後のフレーム数
 */
export function decideKeyFrame(
  framesSinceKeyFrame: number,
  keyframeInterval: number,
  newGroupRequested: boolean,
): { keyFrame: boolean; nextFramesSinceKeyFrame: number } {
  const keyFrame =
    newGroupRequested || shouldRequestKeyFrame(framesSinceKeyFrame, keyframeInterval);
  return { keyFrame, nextFramesSinceKeyFrame: (keyFrame ? 0 : framesSinceKeyFrame) + 1 };
}

interface VideoStreamResult {
  stream: MediaStream;
  width: number;
  height: number;
  cleanup: () => void;
}

/**
 * 送信する音声 chunk の Audio Level を求める
 *
 * RFC 6464 §3 は audio level を「ペイロードが符号化するサンプルの RMS」で -dBov と
 * して測ると定める。ダミー音声のサンプル列は `createToneSamples` が作るため、
 * chunk の timestamp に対応する絶対フレーム位置から同じ純関数で切り出して求める。
 *
 * ブラウザ API に依存しないため、Audio Level の算出はここで検証できる。
 *
 * @param sampleRate - 配信する音声のサンプルレート (Hz)
 * @param channels - 配信する音声のチャンネル数
 * @param timestampMicros - chunk の timestamp (マイクロ秒)
 */
export function resolveAudioLevelForTimestamp(
  sampleRate: number,
  channels: number,
  timestampMicros: number,
): ToneAudioLevel {
  const windowFrames = Math.max(1, Math.round((sampleRate * AUDIO_LEVEL_WINDOW_MS) / 1000));
  const startFrame = Math.round((timestampMicros / 1_000_000) * sampleRate);
  return summarizeToneLevel(createToneSamples(sampleRate, channels, windowFrames, startFrame));
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
  /**
   * 音声設定に従ってダミー音声のストリームを用意する
   *
   * `audioSource` が "none" のときは何も作らない (既定)。
   */
  function startAudioStream(sampleRate: number, channels: number): void {
    stopAudioStream();
    if (settings.audioSource.value !== "dummy") {
      return;
    }
    const generator = createDummyAudioStream(sampleRate, channels);
    pub.audioStream.value = generator.stream;
    pub.audioStreamCleanup.value = (): void => {
      generator.stop();
      for (const track of generator.stream.getTracks()) {
        track.stop();
      }
    };
  }

  /**
   * 音声の Encoder 設定がこのブラウザで対応しているかを確認する
   *
   * `AudioEncoder.configure` は未対応の設定でも例外を投げず、非同期のエラー
   * コールバックで知らせる。Catalog を送る前に確認しないと、購読側は音声 object が
   * 届かないまま待つことになる。
   */
  async function isAudioEncoderConfigSupported(
    codec: AudioCodecType,
    bitrate: number,
    sampleRate: number,
    channels: number,
  ): Promise<boolean> {
    const config = getAudioEncoderConfig(codec, bitrate, sampleRate, channels);
    const support = await AudioEncoder.isConfigSupported(config);
    // supported は optional のため、true のときだけ対応とみなす
    return support.supported === true;
  }

  /**
   * 配信に使う音声トラックを取り出す
   *
   * 音声のダミーストリームはここで作る (プレビューでは作らない)。配信に使う
   * サンプルレートとチャンネル数は Catalog と Encoder と同じ捕捉値を使い、
   * 実際の信号と設定が食い違わないようにする。音声を使わない場合は作成済みの
   * ストリームをここで止める。
   */
  function takeAudioTrackForPublishing(
    audioPublishable: boolean,
    sampleRate: number,
    channels: number,
  ): MediaStreamTrack | undefined {
    if (!audioPublishable) {
      stopAudioStream();
      return undefined;
    }
    startAudioStream(sampleRate, channels);
    const audioTrack = pub.audioStream.value?.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error("Failed to get audio track");
    }
    return audioTrack;
  }

  /** ダミー音声のストリームを止める */
  function stopAudioStream(): void {
    if (pub.audioStreamCleanup.value) {
      pub.audioStreamCleanup.value();
      pub.audioStreamCleanup.value = null;
    }
    pub.audioStream.value = null;
  }

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
    // 音声のダミーストリームはプレビューでは作らず、配信開始時に作る
    // (takeAudioTrackForPublishing)。ここで止めるものは無い
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

        // 読んだフレームの timestamp とそのときの壁時計を記録する。撮ってから読むまでの
        // 遅れが最も小さいフレームに合わせて換算する (WallClockMapper)
        pub.videoWallClock.value.observe(
          frame.timestamp,
          performance.timeOrigin + performance.now(),
        );
        // 符号化と送信の時間は読んだ時刻から測る (publishTimingStats.ts)
        pub.publishTimingStats.value.recordRead(frame.timestamp, performance.now());

        if (encoderInstance.encodeQueueSize <= 2) {
          // 新しい Group の要求は、符号化するフレームで消費する (捨てたフレームでは消費しない)
          const decision = decideKeyFrame(
            pub.framesSinceKeyFrame.value,
            pub.keyframeInterval.value,
            pub.newGroupRequested.value,
          );
          encoderInstance.encode(frame, { keyFrame: decision.keyFrame });
          pub.framesSinceKeyFrame.value = decision.nextFramesSinceKeyFrame;
          if (decision.keyFrame) {
            pub.newGroupRequested.value = false;
          }
          pub.framesEncoded.value++;
        } else {
          pub.publishTimingStats.value.recordEncodeQueueDrop(frame.timestamp);
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
    const publishTimingStats = pub.publishTimingStats.value;
    const encodedAtMs = performance.now();
    publishTimingStats.recordEncoded(chunk.timestamp, encodedAtMs);
    if (encodedAtMs - pub.publishTimingUpdatedAtMs.value >= PUBLISH_TIMING_UPDATE_INTERVAL_MS) {
      pub.publishTimingUpdatedAtMs.value = encodedAtMs;
      pub.publishTiming.value = publishTimingStats.snapshot(encodedAtMs);
    }

    // フレームを読んだ時点で記録するため、ここで記録が無いことは無い。念のため、無ければ
    // この chunk を読んだ時点とみなす
    const wallClockMicros = pub.videoWallClock.value.toWallClockMicroseconds(
      chunk.timestamp,
      performance.timeOrigin + performance.now(),
    );

    // 送信する Object の内容 (Group / Object ID・payload・LOC Properties・優先度) を組み立てる
    const plan = buildObjectSendPlan(
      { groupId: pub.pubCurrentGroup.value, objectId: pub.pubCurrentObjectId.value },
      chunk,
      wallClockMicros,
    );

    if (plan.isKeyFrame) {
      pub.keyFramesEncoded.value++;
    }

    pub.pubCurrentGroup.value = plan.nextGroupId;
    pub.pubCurrentObjectId.value = plan.nextObjectId;

    pub.objectsWithExtensions.value++;

    pub.bytesSent.value += plan.payload.length + plan.properties.length;

    // Object を送信する (送信完了は待たない。完了待ちは stopPublishing の done() で行う)。
    // 完了した時刻を送信の時間として記録する
    void publisherInstance
      .sendObject({
        groupId: plan.groupId,
        objectId: plan.objectId,
        payload: plan.payload,
        properties: plan.properties,
        priority: plan.priority,
      })
      .then(() => {
        publishTimingStats.recordSent(chunk.timestamp, performance.now());
      });

    pub.objectsSent.value++;
  }

  async function processAudioFrames(): Promise<void> {
    const reader = pub.audioFrameReader.value;
    const encoder = pub.audioEncoder.value;
    if (!reader || !encoder) {
      console.error("processAudioFrames: reader or encoder is null", { reader, encoder });
      return;
    }

    try {
      while (encoder.state === "configured") {
        const { value: audioData, done } = await reader.read();
        if (done) {
          break;
        }

        // 音声フレームは落としても後続の Object で上書きされるため、映像のような
        // encodeQueueSize による抑制はしない (src/createMediaPublisher.ts と同じ)
        encoder.encode(audioData);
        audioData.close();
      }
    } catch (error) {
      console.error("Audio frame processing error:", error);
    }
  }

  /**
   * 音声トラックの publish とエンコーダを用意する
   *
   * 映像とは別の `session.publish` を作り、Group 採番も優先度も独立させる
   * (src/createMediaPublisher.ts の audioPublisher / videoPublisher と同じ構成)。
   * 音声は chunk 1 つが Group 1 つになるため (draft-ietf-moq-loc-04 §4.1)、
   * 映像の Group とは共有できない。
   */
  async function startAudioPublishing(
    session: Session,
    namespaceArray: string[],
    audioTrack: MediaStreamTrack,
    options: {
      useWorker: boolean;
      codec: AudioCodecType;
      bitrate: number;
      sampleRate: number;
      channels: number;
      maxCacheDuration: number;
    },
  ): Promise<void> {
    const audioPublisherInstance = await session.publish(
      namespaceArray,
      AUDIO_TRACK_NAME,
      {
        error: (error) => {
          console.error("Audio publisher error:", error);
          pub.pubStatus.value = "error";
          pub.pubStatusMessage.value = `Audio publish error: ${error.message}`;
        },
        // 音声には keyframe が無く Audio Config は最初の chunk にしか現れないため、
        // 同じ値を再送しない方針のままだと後から接続した購読者が AAC を復号できない。
        // Catalog の送り直しと同じく、Forward State が 1 になった時点で
        // 保持している Audio Config を次の Object に載せ直す
        onForwardStateChange: (forward) => {
          if (forward) {
            pub.audioConfigResendRequested.value = true;
          }
        },
      },
      {
        maxCacheDuration: BigInt(options.maxCacheDuration),
      },
    );
    pub.audioPublisher.value = audioPublisherInstance;

    const audioEncoderInstance = new AudioEncoderWrapper(options.useWorker, {
      output: (chunk) => {
        handleAudioEncodedChunk(chunk, {
          sampleRate: options.sampleRate,
          channels: options.channels,
        });
      },
      error: (error) => {
        console.error("Audio encoder error:", error);
        pub.encodeErrors.value++;
        pub.pubStatus.value = "error";
        pub.pubStatusMessage.value = `Audio encoder error: ${error.message}`;
      },
    });
    pub.audioEncoder.value = audioEncoderInstance;
    await audioEncoderInstance.configure(
      options.codec,
      options.bitrate,
      options.sampleRate,
      options.channels,
    );

    const audioTrackProcessor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
    pub.audioFrameReader.value = audioTrackProcessor.readable.getReader();
  }

  function handleAudioEncodedChunk(
    chunk: AudioEncodedChunkData,
    audioFormat: { sampleRate: number; channels: number },
  ): void {
    const audioPublisherInstance = pub.audioPublisher.value;
    if (!audioPublisherInstance || audioPublisherInstance.state !== "active") return;

    // LOC draft-ietf-moq-loc-04 §4.1 (Application with one audio track):
    // 音声 chunk 1 つ = Object 1 つ = Group 1 つ。2 つ目以降は Group を進め、
    // Object ID は常に 0 にする (ライブラリの allocateAudioObject と同じ規則)
    const allocation = allocateAudioObject({
      groupId: pub.pubCurrentAudioGroup.value,
      started: pub.pubAudioGroupStarted.value,
    });
    pub.pubAudioGroupStarted.value = allocation.state.started;
    pub.pubCurrentAudioGroup.value = allocation.state.groupId;

    // LOC Audio Level (draft-ietf-moq-loc-04 §2.3.3.2) は RFC 6464 §3 に従い、
    // chunk が符号化するサンプル列の RMS から -dBov を求める。
    // 配信開始時に確定したサンプルレートとチャンネル数を使う (設定が後から変わっても
    // 実際に流れている信号と食い違わせない)
    const audioLevel = resolveAudioLevelForTimestamp(
      audioFormat.sampleRate,
      audioFormat.channels,
      chunk.timestamp,
    );

    // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config): AAC の AudioSpecificConfig は
    // 同じ値を毎 Object 送らない
    const {
      config: audioConfig,
      next: nextAudioConfig,
      resendNext,
    } = resolveAudioConfigToSend(
      pub.lastSentAudioConfig.value,
      chunk.description,
      pub.audioConfigResendRequested.value,
    );
    pub.lastSentAudioConfig.value = nextAudioConfig;
    pub.audioConfigResendRequested.value = resendNext;

    const properties = LOC.encodeAudioProperties({
      // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る (draft-ietf-moq-loc-04 §2.3.1.1)
      timestamp: LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin),
      audioLevel,
      config: audioConfig,
    });

    // Object を送信する (送信完了は待たない。完了待ちは stopPublishing の done() で行う)
    void audioPublisherInstance.sendObject({
      groupId: allocation.groupId,
      objectId: allocation.objectId,
      payload: chunk.data,
      properties,
      priority: PRIORITY_AUDIO,
    });
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
      const audioSourceValue = settings.audioSource.value;
      const audioCodecValue = settings.audioCodec.value;
      const audioBitrateValue = settings.audioBitrate.value;
      const audioSampleRateValue = settings.audioSampleRate.value;
      const audioChannelsValue = settings.audioChannels.value;
      pub.keyframeInterval.value = settings.keyframeInterval.value;

      // 接続オプションを組み立てる
      const connectOptions = settings.buildConnectOptions();

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
            pub.pubStatusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
            cleanupPublisher();
          },
          error: (error) => {
            addLog("error", `[publisher] webtransport error`, {
              name: error.name ?? "Error",
              message: error.message ?? String(error),
            });
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `Error: ${error.message}`;
            cleanupPublisher();
          },
          debug: handleDebugMessage,
        },
        connectOptions,
      );
      pub.pubSession.value = session;
      settings.reliability.value = session.reliability;

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

      // 音声を配信するかどうかを決める。
      //
      // 対応していない組み合わせ (AAC + 48kHz 以外など) で Catalog だけ音声トラックを
      // 広告すると、購読側は object が来ないまま待ち続ける。映像と同じく事前に確認する
      let audioPublishable = resolveAudioPublishable(audioSourceValue);
      if (audioPublishable) {
        audioPublishable = await isAudioEncoderConfigSupported(
          audioCodecValue,
          audioBitrateValue,
          audioSampleRateValue,
          audioChannelsValue,
        );
        if (!audioPublishable) {
          addLog("warn", "[publisher] audio codec is not supported in this browser", {
            codec: audioCodecValue,
            sampleRate: audioSampleRateValue,
            channels: audioChannelsValue,
          });
        }
      }

      // Catalog を作成して送信
      const createdCatalog = buildPublisherCatalog({
        trackName: trackNameValue,
        codec: codecValue,
        width,
        height,
        framerate: framerateValue,
        bitrate: bitrateValue,
        // 音声は "dummy" かつ配信可能なときだけトラックを載せる
        ...(audioPublishable
          ? {
              audio: {
                codec: audioCodecValue,
                bitrate: audioBitrateValue,
                sampleRate: audioSampleRateValue,
                channels: audioChannelsValue,
              },
            }
          : {}),
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

      pub.pubStatusMessage.value = "Connected, preparing encoder...";

      // 既存のプレビューストリームがあれば再利用し、無ければ新規作成する
      let actualWidth: number;
      let actualHeight: number;
      const hadPreview = pub.isPreviewActive.value && pub.mediaStream.value !== null;

      if (hadPreview) {
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

      const audioTrack = takeAudioTrackForPublishing(
        audioPublishable,
        audioSampleRateValue,
        audioChannelsValue,
      );

      pub.isPreviewActive.value = false;

      // Publisher を作成する
      const publisherInstance = await session.publish(
        namespaceArray,
        trackNameValue,
        {
          error: (error) => {
            console.error("Publisher error:", error);
            pub.pubStatus.value = "error";
            pub.pubStatusMessage.value = `Publish error: ${error.message}`;
          },
          // draft-ietf-moq-transport-21 Section 3.1:
          // Forward State の変化を追跡する
          onForwardStateChange: (forward) => {
            pub.forwardState.value = forward;
          },
          // draft-ietf-moq-transport-21 Section 9.20.20:
          // 新しい Group の要求を受けたら、次に符号化するフレームをキーフレームにする
          onNewGroupRequest: (newGroupRequest) => {
            pub.newGroupRequestsReceived.value++;
            pub.newGroupRequested.value = true;
            addLog("info", "NEW_GROUP_REQUEST received", {
              newGroupRequest: newGroupRequest.toString(),
            });
          },
        },
        {
          maxCacheDuration: BigInt(maxCacheDurationValue),
          // draft-ietf-moq-transport-21 Section 10.6: DYNAMIC_GROUPS=1 を広告し、後から視聴を
          // 始めた購読者が NEW_GROUP_REQUEST でキーフレームを要求できるようにする
          dynamicGroups: true,
        },
      );
      pub.forwardState.value = publisherInstance.forwardState;
      pub.publisher.value = publisherInstance;

      pub.pubStatus.value = "connected";
      pub.pubStatusMessage.value = `Publishing: ${namespaceArray.join("/")}/${trackNameValue}`;

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
          pub.pubStatusMessage.value = `Encoder error: ${error.message}`;
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
      // 対応は読んだフレームからとる (processFrames)
      resetVideoPublishState();

      // 音声トラックを配信する
      if (audioTrack) {
        await startAudioPublishing(session, namespaceArray, audioTrack, {
          useWorker,
          codec: audioCodecValue,
          bitrate: audioBitrateValue,
          sampleRate: audioSampleRateValue,
          channels: audioChannelsValue,
          maxCacheDuration: maxCacheDurationValue,
        });
      }

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
      pub.pubAudioGroupStarted.value = false;
      // draft-ietf-moq-msf-01 §6.1: 配信を再開したときの開始 Group ID は、前回
      // publish したどの Group ID よりも大きいことを MUST とする。音声は chunk
      // ごとに Group を進めるため Date.now() だけでは単調性を保証できない。
      // ライブラリの allocateInitialGroupId (同一プロセス内で前回割り当てた開始値を
      // 必ず上回る単調ガード付きの割当て) を使う
      pub.pubCurrentAudioGroup.value = allocateInitialGroupId();
      // 直前に送った Audio Config と送り直し要求は配信ごとに忘れる
      pub.lastSentAudioConfig.value = null;
      pub.audioConfigResendRequested.value = false;

      // フレームを読み出してエンコードする
      void processFrames();
      if (audioTrack) {
        void processAudioFrames();
      }
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

      if (pub.audioPublisher.value && pub.audioPublisher.value.state === "active") {
        await pub.audioPublisher.value.done();
      }
    } finally {
      cleanupPublisher();
      pub.isStopping.value = false;
      pub.pubStatus.value = "disconnected";
      pub.pubStatusMessage.value = "Ready to publish";
    }
  };

  const cleanupPublisher = (): void => {
    // フレームリーダーをキャンセルする
    if (pub.frameReader.value) {
      void pub.frameReader.value.cancel();
      pub.frameReader.value = null;
    }
    // 次の配信では新しいフレームで対応をとり直す
    pub.videoWallClock.value = new WallClockMapper();

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

    // 音声のフレームリーダーをキャンセルする
    if (pub.audioFrameReader.value) {
      void pub.audioFrameReader.value.cancel();
      pub.audioFrameReader.value = null;
    }

    // 音声 Encoder を閉じる
    if (pub.audioEncoder.value) {
      try {
        pub.audioEncoder.value.close();
      } catch {
        // 無視する
      }
      pub.audioEncoder.value = null;
    }

    // 映像ストリームを解放する
    if (pub.videoStreamCleanup.value) {
      pub.videoStreamCleanup.value();
      pub.videoStreamCleanup.value = null;
    }
    pub.mediaStream.value = null;

    // 音声ストリームを解放する
    stopAudioStream();

    // セッションを閉じる
    if (pub.pubSession.value) {
      pub.pubSession.value.close().catch(() => {
        // 既にクローズされている場合は無視
      });
      pub.pubSession.value = null;
    }

    pub.publisher.value = null;
    pub.audioPublisher.value = null;
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
