import {
  catalogFetchFilter,
  connect,
  LOC,
  decodeCatalogMessage,
  getAudioTracks,
  getVideoTracks,
  resolveInitData,
  CATALOG_TRACK_NAME,
  supportsDynamicGroups,
  type Catalog,
  type MoqtObject,
  type DebugMessage,
  type CatalogTrack,
  type Session,
  type Subscriber,
} from "moqt-js";
import { addLog } from "../components/DebugPanel";
import { logDebugMessage } from "./debugMessageLog";
import { DecoderWrapper } from "../utils/DecoderWrapper";
import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder.ts";
import { isVideoKeyFrameObject } from "../../../src/createMediaSubscriber.ts";
import {
  DEFAULT_AUDIO_SAMPLE_RATE,
  requiresAudioSpecificConfig,
  resolveAudioChannelCount,
} from "../../../src/codec/config.ts";
import { isSameCodecDescription, parseAudioCodec } from "../utils/codec";
import {
  appendWaveform,
  readAudioSamples,
  summarizeAudioLevel,
  waveformSampleCount,
} from "../utils/audioLevel";
import { base64ToArrayBuffer } from "../utils/base64";
import * as settings from "../signals/connectionSettings";
import * as sub from "../signals/subscriber";
import * as pub from "../signals/publisher";
import { useRef, useEffect } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * Catalog から購読する音声トラックを取り出す
 *
 * 音声トラックを持たない catalog (映像だけを広告する publisher) では `undefined` を
 * 返す。呼び出し側はこれを見て音声の購読を開始せず、映像だけを継続する。
 * ブラウザ API に依存しないため、この分岐はここで検証できる。
 */
export function resolveAudioTrack(catalog: Catalog): CatalogTrack | undefined {
  return getAudioTracks(catalog)[0];
}

/** 受信した音声を再生するための audio graph */
interface AudioPlayback {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
}

/**
 * canvas の幅の上限 (px)
 *
 * 4K のような大きなフレームで canvas の実寸をそのまま使うと、1 枚あたりの描画
 * コストが大きくなり、60 / 120 fps の表示がかくつく。表示は CSS で拡縮されるため、
 * canvas はこの幅に抑えて描く。
 */
const MAX_CANVAS_WIDTH = 1280;

/**
 * 表示待ちフレームのキューの上限 (枚)
 *
 * 到着と復号のゆらぎを吸収するために保持する。実回線では受信チャンクに複数の
 * Object がまとまって入り、復号もまとめて完了することがあるため、数枚では
 * あふれてフレームが落ちる。表示周期 (60 Hz で約 16 ms) より配信周期が長ければ
 * キューは自然に減るため、通常の遅延は小さいままである。上限を超えた分は古い方から
 * 捨てる (配信 fps が表示 fps を超える場合と cache replay の追い上げ中は、常に
 * 最新側へ追いつく)。
 */
const MAX_PENDING_FRAMES = 6;

/**
 * Catalog の `videoTrack` から `VideoDecoderConfig` を組み立てる。
 * canonical 形式 (avc1 / hvc1) で必要な description は MSF Catalog の Initialization Data
 * (Base64) から復元する。
 * draft-ietf-moq-msf-01 では `initData` (旧 §5.1.20) が `Catalog.initDataList` (§5.1.7) +
 * `CatalogTrack.initRef` (§5.2.13) の参照に分離されたため、`resolveInitData` 経由で取得する。
 * draft-ietf-moq-loc-04 §2.1.2 の用途は変わらない。
 *
 * ブラウザ API に依存しないため、Catalog からの codec 解決の契約はここで検証できる。
 */
export function buildVideoDecoderConfig(
  videoTrack: CatalogTrack,
  catalog: Catalog,
): VideoDecoderConfig {
  if (!videoTrack.codec) {
    throw new Error("video track codec is not specified in catalog");
  }
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    // width / height は Catalog の任意フィールドのため、値がある場合だけ載せる
    // (exactOptionalPropertyTypes では optional な codedWidth / codedHeight に
    //  undefined を代入できない)
    ...(videoTrack.width !== undefined ? { codedWidth: videoTrack.width } : {}),
    ...(videoTrack.height !== undefined ? { codedHeight: videoTrack.height } : {}),
  };
  const initData = resolveInitData(catalog, videoTrack);
  if (initData !== undefined) {
    decoderConfig.description = base64ToArrayBuffer(initData);
  }
  return decoderConfig;
}

/**
 * Subscriber インスタンスの統計フィールドを初期値へリセットする。
 * `startSubscribing` 開始時に decode カウンタや位置情報をクリアする。
 */
export function resetSubscriberStats(instance: sub.SubscriberInstance): void {
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
  instance.audioObjectsReceived.value = 0;
  instance.audioChunksDecoded.value = 0;
  instance.audioLastLevel.value = null;
  instance.audioPeakDbfs.value = null;
  instance.audioRmsDbfs.value = null;
  instance.audioWaveform.value = null;
}

/**
 * 受信 Object から `EncodedVideoChunk` に渡す内容を決める
 *
 * publisher 側の Object 送信 (`usePublisher` の `buildObjectSendPlan`) が付与した
 * TIMESTAMP と VIDEO_FRAME_MARKING を読み、chunk の type と timestamp に変換する。
 * キーフレーム判定は `isVideoKeyFrameObject` に委譲する (同じ規則を二重実装しない)。
 * VIDEO_FRAME_MARKING は任意の Property であり、無い場合は Group 先頭の
 * Object ID 0 をキーフレームとして扱う。Properties が無い / 空の Object も
 * Object ID だけで判定し、timestamp は 0 にする。
 *
 * ブラウザ API に依存しないため、LOC 復号の契約はここで検証できる。
 */
export function buildVideoChunkPlan(obj: MoqtObject): {
  type: "key" | "delta";
  timestamp: number;
} {
  let timestamp = 0;
  let frameMarking: LOC.VideoFrameMarking | undefined;

  if (obj.properties !== undefined && obj.properties.length > 0) {
    const locProperties = LOC.decodeVideoProperties(obj.properties);

    // TIMESTAMP から timestamp を取得
    if (locProperties.timestamp !== undefined) {
      timestamp = Number(locProperties.timestamp);
    }

    frameMarking = locProperties.frameMarking;
  }

  return {
    type: isVideoKeyFrameObject(obj.objectId, frameMarking) ? "key" : "delta",
    timestamp,
  };
}

/**
 * REQUEST_UPDATE に載せる NEW_GROUP_REQUEST の値を解決する
 *
 * draft-ietf-moq-transport-21 §9.20.20: 送信時点で知る最大 Group ID + 1 を送る。
 * 最大 Location が未知 (SUBSCRIBE_OK 未受信) のときは 0 を送り、Group 情報なしで
 * 新規 Group の開始を要求する。SUBSCRIBE 直後の snapshot ではなく
 * `Subscriber.largestLocation` の現在値を渡す。
 */
export function resolveNewGroupRequestValue(
  largestLocation: { group: bigint; object: bigint } | null,
): bigint {
  return largestLocation === null ? 0n : largestLocation.group + 1n;
}

/**
 * `SubscriberInstance` が保持する外部リソース (映像と音声の `decoder` / `catalog` 購読 /
 * 音声トラックの購読 / `session`) を fire-and-forget で解除し、canvas を初期色で塗り潰す。
 *
 * WebTransport が close コールバックを同期 dispatch する実装で teardownSubscriber が
 * 再入する可能性があるため、`session.value = null` を `sessionInstance.close()` より
 * 先に立てる順序を維持する (session.value が残ったまま再入すると teardown が二重に走る)。
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

  // 音声デコーダも同じく停止する。復号途中の AudioData は decoder 側が捨てる
  const audioDecoderInstance = instance.audioDecoder.value;
  instance.audioDecoder.value = null;
  instance.audioDecoderConfigured.value = false;
  if (audioDecoderInstance) {
    try {
      audioDecoderInstance.close();
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

  // catalog 購読を graceful に解除する。 session.close 任せにしない。
  // 制御メッセージのため session.close より先に行う。
  // 二重解除は解除前の null チェックと解除後の null 化で抑止し、
  // 逐次二重は unsubscribe 自体の冪等に委ねる。失敗は握り潰す。
  const catalogSubscriberInstance = instance.catalogSubscriber.value;
  instance.catalogSubscriber.value = null;
  if (catalogSubscriberInstance) {
    void catalogSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // 音声トラックの購読も catalog 購読と同じ順序で解除する
  const audioSubscriberInstance = instance.audioSubscriber.value;
  instance.audioSubscriber.value = null;
  if (audioSubscriberInstance) {
    void audioSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
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
 * (映像 / 音声の Promise チェーン) を巻き戻す。
 *
 * `status` / `statusMessage` / `isStopping` は触らない (停止操作の表示は呼び出し側の責務)。
 * `settingsDisabled` は `subscriber.value = null` の反映後に `hasActiveSubscriber`
 * computed で再計算されるため、本関数の末尾で再有効化判定を行う。
 */
export function resetSubscriberState(
  instance: sub.SubscriberInstance,
  chains: { video: { current: Promise<void> }; audio: { current: Promise<void> } },
  isOtherPublisherActive: () => boolean,
): void {
  instance.subscriber.value = null;
  instance.catalogSubscriber.value = null;
  instance.catalog.value = null;
  instance.decoder.value = null;
  instance.decoderConfigured.value = false;
  instance.codec.value = "";
  instance.dynamicGroupsSupported.value = false;

  instance.audioSubscriber.value = null;
  instance.audioDecoder.value = null;
  instance.audioDecoderConfigured.value = false;
  instance.audioLastLevel.value = null;
  instance.audioPeakDbfs.value = null;
  instance.audioRmsDbfs.value = null;
  instance.audioWaveform.value = null;
  // 再生トグルは既定 (無効) に戻す。audio graph は呼び出し側が停止する
  instance.audioPlaybackEnabled.value = false;

  instance.largestLocation.value = null;

  chains.video.current = Promise.resolve();
  // 音声のチェーンも巻き戻す。停止後に残った処理が新しいセッションの signal を
  // 汚さないよう、世代の同一性は各ハンドラ側でも確認する
  chains.audio.current = Promise.resolve();

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
  logDebugMessage(`[${subscriberId}]`, message);
}

// preact 11 では useRef<T>(null) の戻り値が RefObject<T | null> になるため、
// null を許容するシグネチャにしている。実装側は canvasRef.current を
// null チェックしてから利用する。
export function useSubscriber(
  subscriberId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  audioRef: RefObject<HTMLAudioElement | null>,
) {
  // ライブオブジェクトの順次処理用 Promise チェーン (レンダリング間で安定参照)
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // 音声 object の順次処理用 Promise チェーン (映像とは独立させる)
  const audioChainRef = useRef<Promise<void>>(Promise.resolve());
  // 受信した音声を再生するための audio graph (トグル有効時のみ非 null)
  const audioPlaybackRef = useRef<AudioPlayback | null>(null);
  // 再生開始の進行中フラグ。連打で AudioContext を二重に作らないための再入ガード
  const audioPlaybackPendingRef = useRef(false);
  // startSubscribing の中断検知用 AbortController (レンダリング間で安定参照)
  const abortControllerRef = useRef<AbortController | null>(null);
  // 表示待ちのフレームと予約した描画 (presentFrame / clearPendingFrame が使う)
  const pendingFramesRef = useRef<VideoFrame[]>([]);
  const frameAnimationRef = useRef<number | null>(null);

  /**
   * 受信した音声を音声出力デバイスへ流す graph を作る
   *
   * `audioContext.destination` には繋がず、`MediaStreamAudioDestinationNode` の
   * トラックを `<audio>` の `srcObject` に設定する (ライブラリの
   * createMediaSubscriber と同じ構成)。トグルのクリックがユーザー操作になるため、
   * 自動再生ポリシー下でも `resume()` と `play()` が通る。
   */
  async function startAudioPlayback(): Promise<void> {
    let playback = audioPlaybackRef.current;
    if (playback === null) {
      const context = new AudioContext();
      playback = { context, destination: context.createMediaStreamDestination() };
      audioPlaybackRef.current = playback;
    }
    if (playback.context.state === "suspended") {
      await playback.context.resume();
    }
    const audioElement = audioRef.current;
    if (audioElement) {
      audioElement.srcObject = playback.destination.stream;
      await audioElement.play();
    }
  }

  /** 音声出力を止め、`<audio>` からストリームを外す */
  function stopAudioPlayback(): void {
    // 停止したら進行中の再生開始も無効として扱う
    audioPlaybackPendingRef.current = false;
    const audioElement = audioRef.current;
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
    }
    const playback = audioPlaybackRef.current;
    audioPlaybackRef.current = null;
    if (playback) {
      void playback.context.close().catch(() => {
        // 既に閉じている場合は無視する
      });
    }
  }

  /**
   * 受信した音声を再生するかどうかを切り替える
   *
   * 既定は無効。有効にしたときだけ音声出力デバイスへ繋ぐ。
   */
  const toggleAudioPlayback = async (): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    if (instance.audioPlaybackEnabled.value) {
      stopAudioPlayback();
      instance.audioPlaybackEnabled.value = false;
      return;
    }

    // play() の解決前に再度クリックされると AudioContext が二重に作られ、
    // 先に作った方が参照を失って解放されない
    if (audioPlaybackPendingRef.current) {
      return;
    }
    audioPlaybackPendingRef.current = true;

    try {
      await startAudioPlayback();
      instance.audioPlaybackEnabled.value = true;
    } catch (error) {
      console.error(`[${subscriberId}] failed to start audio playback:`, error);
      stopAudioPlayback();
      instance.audioPlaybackEnabled.value = false;
    } finally {
      audioPlaybackPendingRef.current = false;
    }
  };

  /**
   * 音声トラックを購読して復号する
   *
   * catalog の `samplerate` / `channelConfig` から decoder を構成する。受信 object の
   * LOC properties は Track Property と Object Property の両方から解決し、
   * AUDIO_LEVEL を signal へ、AUDIO_CONFIG (AAC) を decoder の description へ渡す。
   */
  async function startAudioSubscription(
    session: Session,
    namespaceArray: string[],
    audioTrack: CatalogTrack,
    instance: sub.SubscriberInstance,
    signal: AbortSignal,
  ): Promise<void> {
    if (!audioTrack.codec) {
      throw new Error("audio track codec is not specified in catalog");
    }
    const audioCodec = parseAudioCodec(audioTrack.codec);
    const sampleRate = audioTrack.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
    // channelConfig は名前付き値 (mono / stereo) と整数文字列を受け付ける。
    // 解決不能な明示値はここで throw し、NaN をデコーダに渡さない
    const channels = resolveAudioChannelCount(audioTrack.channelConfig);
    const useWorker = settings.useDedicatedWorker.value;

    // output はコンストラクタから同期で呼ばれないため、自身を参照しても TDZ にならない
    const audioDecoderInstance: AudioDecoderWrapper = new AudioDecoderWrapper(useWorker, {
      output: (data) => {
        handleAudioDecoded(data.data, audioDecoderInstance);
      },
      error: (error) => {
        console.error(`[${subscriberId}] Audio decoder error:`, error);
        instance.decodeErrors.value += 1;
      },
    });
    try {
      await audioDecoderInstance.configure(audioCodec, sampleRate, channels);
    } catch (error) {
      // configure に失敗した場合は Worker を作った後でも残さない
      audioDecoderInstance.close();
      throw error;
    }

    // configure await 中に中断された場合、ローカル参照は instance に未代入のため
    // 中断元から見えない。ここで閉じないと停止済み instance に代入されてリークする
    if (
      checkAborted(signal, () => {
        audioDecoderInstance.close();
      })
    ) {
      return;
    }

    instance.audioDecoder.value = audioDecoderInstance;
    instance.audioDecoderConfigured.value = true;

    // 直前に decoder へ渡した Audio Config。AAC のときだけ使う
    let appliedAudioConfig: Uint8Array | undefined;

    const handleAudioObject = async (obj: MoqtObject): Promise<void> => {
      const current = getCurrentAudioSubscriber(audioDecoderInstance);
      if (current === null) {
        return;
      }

      current.audioObjectsReceived.value += 1;

      try {
        // draft-ietf-moq-loc-04 §2.3 は LOC Public Properties を Object Properties として
        // 運ぶと定めるため、AUDIO_LEVEL は object 単位でしか届かない。載っていない
        // object では null に戻す (前の object の値を持ち越さない)
        const locProperties = LOC.resolveAudioProperties(
          current.audioSubscriber.value?.trackProperties,
          obj.properties,
        );
        current.audioLastLevel.value = locProperties.audioLevel ?? null;

        // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) が定める Audio Config は
        // AudioDecoderConfig の description に対応する。値が変わったときだけ
        // WebCodecs の configure をやり直す (同じ値を渡し続けない)
        if (
          requiresAudioSpecificConfig(audioCodec) &&
          locProperties.config !== undefined &&
          !isSameCodecDescription(appliedAudioConfig, locProperties.config)
        ) {
          const description = new Uint8Array(locProperties.config);
          try {
            await audioDecoderInstance.configure(audioCodec, sampleRate, channels, description);
            appliedAudioConfig = description;
          } catch (error) {
            // 適用できなかった config は「適用済み」にしない。同じ config を持つ
            // 後続 object で再試行できるようにする
            console.error(`[${subscriberId}] failed to reconfigure audio decoder:`, error);
            current.decodeErrors.value += 1;
            return;
          }
        }

        if (!current.audioDecoderConfigured.value) {
          return;
        }

        // TIMESTAMP は TIMESCALE の有無に応じてマイクロ秒へ換算する
        // (draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2)
        const timestamp =
          locProperties.timestamp === undefined
            ? 0
            : Number(LOC.toDecoderMicroseconds(locProperties.timestamp, locProperties.timescale));

        audioDecoderInstance.decode(obj.payload, "key", timestamp, 0);
        current.audioChunksDecoded.value += 1;
      } catch (error) {
        // LOC properties の復号失敗など、この object だけの問題は次で回復し得るため
        // decoder は構成済みのままにする
        console.error(`[${subscriberId}] failed to decode audio object:`, error);
        current.decodeErrors.value += 1;
      }
    };

    const audioSubscriberInstance = await session.subscribe(
      namespaceArray,
      audioTrack.name,
      {
        object: (obj: MoqtObject) => {
          // 到着順にデコードする。映像とは独立したチェーンにすることで、
          // 映像のデコード待ちが音声の到着を遅らせないようにする
          audioChainRef.current = audioChainRef.current
            .then(() => handleAudioObject(obj))
            .catch((error: unknown) => {
              // handleAudioObject は内部で握るため、ここへ来るのは想定外の失敗だけ
              console.error(`[${subscriberId}] audio object chain failed:`, error);
            });
        },
        end: () => {
          addLog("info", `[${subscriberId}] audio stream ended`);
        },
        error: (error) => {
          addLog("error", `[${subscriberId}] audio subscribe error`, {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      },
      {
        // draft-ietf-moq-transport-21 §9.20.7 (RENDEZVOUS TIMEOUT):
        // 映像と同じく、publisher が現れるまで relay に購読を保持させる
        rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
      },
    );

    // subscribe の await 中に停止された場合、ローカル参照は instance に未代入のため
    // 中断元から見えない。ここで unsubscribe して購読を残さない
    if (
      checkAborted(signal, () => {
        void audioSubscriberInstance.unsubscribe().catch(() => {});
      })
    ) {
      return;
    }

    instance.audioSubscriber.value = audioSubscriberInstance;
    addLog("info", `[${subscriberId}] subscribed audio track`, {
      trackName: audioTrack.name,
      codec: audioTrack.codec,
      sampleRate,
      channels,
    });
  }

  /**
   * 対象の音声 decoder が現在の購読のものかを確認し、現在のインスタンスを返す
   *
   * 停止・削除・再購読のあとに残ったハンドラが、古いインスタンスの signal を
   * 書き換えたり閉じた decoder を触ったりしないようにするための世代判定。
   */
  function getCurrentAudioSubscriber(
    audioDecoderInstance: AudioDecoderWrapper,
  ): sub.SubscriberInstance | null {
    const current = sub.getSubscriber(subscriberId);
    if (!current || current.audioDecoder.value !== audioDecoderInstance) {
      return null;
    }
    return current;
  }

  /**
   * 復号した AudioData を可視化し、必要なら再生する
   *
   * 所有者はこの decode ハンドラであり、読み出しを終えた後に 1 回だけ `close()` する。
   * 可視化の読み出しも `close()` の前に済ませる。
   */
  function handleAudioDecoded(
    audioData: AudioData,
    audioDecoderInstance: AudioDecoderWrapper,
  ): void {
    const instance = getCurrentAudioSubscriber(audioDecoderInstance);
    if (instance === null) {
      audioData.close();
      return;
    }

    try {
      // 可視化用の読み出しは close() の前に済ませる (所有者はこのハンドラ)。
      // 再生の有無に関わらずレベルと波形を更新する
      const samples = readAudioSamples(audioData);
      const level = summarizeAudioLevel(samples);
      instance.audioPeakDbfs.value = level.peakDbfs;
      instance.audioRmsDbfs.value = level.rmsDbfs;
      instance.audioWaveform.value = appendWaveform(
        instance.audioWaveform.value,
        samples,
        waveformSampleCount(audioData.sampleRate),
      );
    } catch (error) {
      // 計測に失敗しても再生は試みる (原因の切り分けができるよう別のメッセージにする)
      console.error(`[${subscriberId}] failed to measure decoded audio data:`, error);
    }

    try {
      const playback = audioPlaybackRef.current;
      if (!instance.audioPlaybackEnabled.value || playback === null) {
        return;
      }

      const numberOfChannels = audioData.numberOfChannels;
      const numberOfFrames = audioData.numberOfFrames;
      const audioBuffer = playback.context.createBuffer(
        numberOfChannels,
        numberOfFrames,
        audioData.sampleRate,
      );
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames);
        audioData.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
        audioBuffer.copyToChannel(channelData, channel);
      }

      const source = playback.context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playback.destination);
      source.start();
    } catch (error) {
      console.error(`[${subscriberId}] failed to play audio data:`, error);
    } finally {
      audioData.close();
    }
  }

  /**
   * 復号済みフレームを小さなキューへ積み、次の描画周期で 1 枚ずつ表示する
   *
   * 表示は requestAnimationFrame で 1 周期に 1 枚に絞る。これをしないと 2 つの
   * 問題が起きる。
   * - 120 fps の映像では 1 周期に複数枚の復号が完了し、すべて描画すると表示周期
   *   より多く描くことになってかくつく
   * - cache replay の追い上げ中は復号が表示より速いため、すべて描画すると早送りに
   *   見える
   *
   * キューは `MAX_PENDING_FRAMES` 枚まで保持し、あふれた分は古い方から捨てる。到着が
   * 少しゆらいでも (実回線では 20 ms に 2 から 3 Object がまとまって届くことがある)
   * 表示周期ごとに 1 枚ずつ出せるため、フレームが落ちない。配信 fps が表示 fps を
   * 超える場合と追い上げ中はキューがあふれ続け、常に古いフレームを捨てて最新側へ
   * 追いつく。
   */
  const presentFrame = (frame: VideoFrame): void => {
    const pending = pendingFramesRef.current;
    pending.push(frame);
    while (pending.length > MAX_PENDING_FRAMES) {
      pending.shift()?.close();
    }
    if (frameAnimationRef.current !== null) {
      return;
    }
    frameAnimationRef.current = requestAnimationFrame(() => {
      frameAnimationRef.current = null;
      const next = pendingFramesRef.current.shift();
      if (next) {
        drawFrame(next);
      }
    });
  };

  /** 表示待ちのフレームを破棄し、予約した描画を取り消す */
  const clearPendingFrame = (): void => {
    if (frameAnimationRef.current !== null) {
      cancelAnimationFrame(frameAnimationRef.current);
      frameAnimationRef.current = null;
    }
    for (const frame of pendingFramesRef.current) {
      frame.close();
    }
    pendingFramesRef.current = [];
  };

  const drawFrame = (frame: VideoFrame): void => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) {
      frame.close();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn(`[${subscriberId}] drawFrame: canvas is null`);
      frame.close();
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn(`[${subscriberId}] drawFrame: failed to get 2d context`);
      frame.close();
      return;
    }

    // 大きなフレームは上限幅まで縮めて描く (表示は CSS で拡縮される)
    const scale = Math.min(1, MAX_CANVAS_WIDTH / frame.displayWidth);
    const width = Math.max(1, Math.round(frame.displayWidth * scale));
    const height = Math.max(1, Math.round(frame.displayHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.drawImage(frame, 0, 0, width, height);
    frame.close();

    instance.framesDecoded.value += 1;
  };

  const handleObject = async (obj: MoqtObject): Promise<void> => {
    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    const decoderInstance = instance.decoder.value;
    if (!decoderInstance) {
      console.warn(`[${subscriberId}] handleObject: decoder is null`);
      return;
    }

    instance.objectsReceived.value += 1;
    instance.bytesReceived.value += obj.payload.length + (obj.properties?.length ?? 0);
    instance.currentGroup.value = Number(obj.groupId);
    instance.currentSubGroup.value = Number(obj.subgroupId ?? 0n);
    instance.decoderState.value = decoderInstance.state;

    try {
      // LOC Properties からメタデータを取得
      if (obj.properties && obj.properties.length > 0) {
        instance.objectsWithExtensions.value += 1;
      }
      const plan = buildVideoChunkPlan(obj);

      // LOC spec 準拠: payload は WebCodecs の internal data をそのまま使用
      const chunk = new EncodedVideoChunk({
        type: plan.type,
        timestamp: plan.timestamp,
        data: obj.payload,
      });

      instance.chunksCreated.value += 1;

      if (!instance.decoderConfigured.value) {
        instance.chunksSkipped.value += 1;
        return;
      }

      if (plan.type === "key") {
        instance.keyFramesDecoded.value += 1;
      }

      if (decoderInstance.state !== "configured") {
        console.warn(
          `[${subscriberId}] handleObject: decoder not in configured state:`,
          decoderInstance.state,
        );
        instance.decoderState.value = decoderInstance.state;
        instance.chunksSkipped.value += 1;
        return;
      }

      decoderInstance.decode(chunk);
      instance.chunksDecoded.value += 1;
    } catch (error) {
      console.error(`[${subscriberId}] handleObject: failed to decode object:`, error);
      instance.decodeErrors.value += 1;
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
      instance.statusMessage.value = "接続中...";
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
              // WebTransportCloseInfo.reason は optional のため未指定時は空文字にする
              reason: (closeInfo.reason ?? "").slice(0, 1024),
            });
            // stop 主導中・cleanup 後の遅延発火では status / statusMessage を上書きしない。
            // teardownSubscriber は abort 経路を維持するため常に呼ぶ。
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "disconnected";
              instance.statusMessage.value = `切断: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
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
              instance.statusMessage.value = `エラー: ${error.message}`;
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
      instance.statusMessage.value = "接続完了、Catalog を購読中...";

      // Catalog を購読してコーデック情報を取得
      let videoTrackFromCatalog: CatalogTrack | undefined;
      let actualTrackName = settings.trackName.value;

      try {
        // draft-ietf-moq-transport-21 に準拠した Catalog 購読:
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

          // SUBSCRIBE 確立後の処理。
          // startSubscribing 側で signal.aborted を見て return した後に
          // マイクロタスクで .then が回り catalogSubscriber.value が再代入される
          // レースをここで潰す。
          // promise を .then のコールバック内で生成すると promise/no-nesting に
          // 抵触するため、チェーンからは参照渡しで分離する。
          const handleCatalogSubscribed = async (
            catalogSubscriberInstance: Subscriber,
          ): Promise<void> => {
            if (signal.aborted) {
              await catalogSubscriberInstance.unsubscribe().catch(() => {});
              return;
            }
            instance.catalogSubscriber.value = catalogSubscriberInstance;

            // 過去の Catalog を FETCH で取得する。要求範囲は SUBSCRIBE_OK の
            // LARGEST_OBJECT が示す Group の先頭 Object から Largest Object まで
            // とする (catalogFetchFilter を参照)。SUBSCRIBE_OK 受信後に FETCH を
            // 送ることで、Next Object の Largest (L1) が FETCH 処理時の
            // Largest (L2) 以下になることを保証し、(L2, L1] の取りこぼしを防ぐ
            // (createMediaSubscriber と同じ順序)。
            //
            // フィルタ無し ({0, 0} 起点) で要求すると、catalog の Group ID が
            // Unix epoch ミリ秒から始まる publisher では relay の object cache が
            // 覆えず、上流へ転送される。上流の publisher が FETCH に応答しない
            // 場合、後から参加した購読者は catalog を得られない。
            const fetchFilter = catalogFetchFilter(catalogSubscriberInstance.largestLocation);
            await session
              .fetch(
                namespaceArray,
                CATALOG_TRACK_NAME,
                fetchFilter === undefined ? {} : { filter: fetchFilter },
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
                // draft-ietf-moq-transport-21 §9.20.7 (RENDEZVOUS TIMEOUT):
                // publisher がまだ居ない場合は relay がこの時間だけ購読を保持し、
                // publisher が現れたら SUBSCRIBE_OK を返す。配信開始前に視聴を
                // 始められるようにするため、Catalog Timeout と同じ値を使う
                rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
              },
            )
            .then(handleCatalogSubscribed)
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
        // 元のエラーを cause に保持し、スタックトレースを失わないようにする
        throw new Error(`failed to get catalog: ${(error as Error).message}`, { cause: error });
      }

      // Catalog 取得経路は finally で clearTimeout 済みのため追加 cleanup は不要。
      // .then 内側で catalogSubscriber の遅延代入レースは解消済み。
      if (checkAborted(signal, () => {})) return;

      instance.statusMessage.value = "Decoder を準備中...";

      // デコーダラッパーを生成する
      const useWorker = settings.useDedicatedWorker.value;

      const decoderInstance = new DecoderWrapper(useWorker, {
        output: ({ frame }) => {
          presentFrame(frame);
        },
        error: (error) => {
          console.error(`[${subscriberId}] Decoder error:`, error);
          instance.decodeErrors.value += 1;
          // デコーダーをリセットして次のキーフレームを待つ
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
      instance.statusMessage.value = "購読中...";
      resetSubscriberStats(instance);

      // Subscriber オプションを構築する
      const subscribeOptions: {
        newGroupRequest?: bigint;
        rendezvousTimeout?: bigint;
      } = {
        // draft-ietf-moq-transport-21 §9.20.7 (RENDEZVOUS TIMEOUT):
        // Catalog が広告する映像トラックは Catalog の到着直後にはまだ publish
        // されていないことがある。relay に購読を保持させる
        rendezvousTimeout: BigInt(settings.catalogSubscriptionTimeout.value),
      };

      // NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
      // draft-ietf-moq-transport-21 §9.20.20: SUBSCRIBE では MAY (foreknowledge 不要、
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
              instance.statusMessage.value = "ストリーム終了";
            }
            teardownSubscriber();
          },
          error: (error) => {
            console.error(`[${subscriberId}] Subscriber error:`, error);
            if (shouldApplyStatusUpdate()) {
              instance.status.value = "error";
              instance.statusMessage.value = `購読エラー: ${error.message}`;
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
      instance.statusMessage.value = `購読中: ${namespaceArray.join("/")}/${actualTrackName}`;
      instance.largestLocation.value = largestLocation ?? null;

      // 音声トラックを購読する
      //
      // catalog に音声トラックが無い publisher (映像だけを広告する実装) では
      // 音声の購読を開始せず、警告を出して映像だけを継続する。音声側の準備に
      // 失敗した場合も映像の視聴は妨げない (相互運用の実測では映像だけでも意味がある)
      const audioTrackFromCatalog = resolveAudioTrack(catalogValue);
      if (audioTrackFromCatalog === undefined) {
        addLog("warn", `[${subscriberId}] no audio track in catalog, continuing with video only`);
        return;
      }

      try {
        instance.statusMessage.value = "音声 Decoder を準備中...";
        await startAudioSubscription(
          session,
          namespaceArray,
          audioTrackFromCatalog,
          instance,
          signal,
        );
        // startAudioSubscription 内の checkAborted は関数内で return するだけなので、
        // 中断後もここへ来る。teardownSubscriber が確定させた表示を上書きしない
        if (signal.aborted) return;
        instance.statusMessage.value = `購読中: ${namespaceArray.join("/")}/${actualTrackName}`;
      } catch (error) {
        // 中断時は teardownSubscriber が status / statusMessage を確定済み。
        // 映像経路と同じく上書きしない
        if (signal.aborted) return;
        addLog("error", `[${subscriberId}] failed to start audio subscription`, {
          message: error instanceof Error ? error.message : String(error),
        });
        // 中間メッセージを残さず、映像の購読状態の表示に戻す
        instance.statusMessage.value = `購読中: ${namespaceArray.join("/")}/${actualTrackName}`;
      }
    } catch (error) {
      // 中断時は teardownSubscriber が status / statusMessage / settingsDisabled を確定済み。
      // 通常エラーの上書きを避けるため、catch 句先頭で abort を判定して早期 return する。
      if (signal.aborted) return;
      console.error(`[${subscriberId}] Connection error:`, error);
      instance.status.value = "error";
      instance.statusMessage.value = `失敗: ${(error as Error).message}`;
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
    instance.statusMessage.value = "切断中...";

    try {
      const subscriberInstance = instance.subscriber.value;
      if (subscriberInstance && subscriberInstance.state === "active") {
        await subscriberInstance.unsubscribe();
      }
    } finally {
      teardownSubscriber();
      instance.isStopping.value = false;
      instance.status.value = "disconnected";
      instance.statusMessage.value = "購読開始待ち";
    }
  };

  // 外部接続を含むランタイム状態を全て巻き戻し、再 startSubscribing 可能な初期状態に戻す。
  // close 系 (closeSubscriberResources) と signal リセット系 (resetSubscriberState) を
  // 順に呼ぶ orchestrator。SubscriberInstance を Map から削除しない (= 同じ id で再 setup 可能)。
  const teardownSubscriber = (): void => {
    // 表示待ちのフレームを破棄する。teardown 後に古いフレームを描画しない
    clearPendingFrame();
    // 再生の停止は instance の有無に関わらず行う。パネルの削除では Map から先に
    // 消えるため、この後の instance 取得が失敗しても AudioContext を残さない
    stopAudioPlayback();

    const instance = sub.getSubscriber(subscriberId);
    if (!instance) return;

    // 進行中の startSubscribing を中断する。AbortController.abort は冪等で例外を投げない。
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    closeSubscriberResources(instance, canvasRef.current);
    resetSubscriberState(
      instance,
      { video: chainRef, audio: audioChainRef },
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

    // draft-ietf-moq-transport-21 §9.20.20:
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
      // draft-ietf-moq-transport-21 §9.20.20
      // NEW_GROUP_REQUEST = 0x32。値は送信時点の最新 Group ID + 1
      // (情報なし時は 0) とし、SUBSCRIBE 直後の snapshot は使わない。
      const largestLocation = subscriberInstance.largestLocation;
      await subscriberInstance.update({
        newGroupRequest: resolveNewGroupRequestValue(largestLocation),
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
    toggleAudioPlayback,
  };
}
