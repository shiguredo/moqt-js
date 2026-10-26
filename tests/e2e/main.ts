/**
 * 実リレーへ接続する E2E テスト用のテストページ
 *
 * `window.__moqtE2E` に実リレーへ接続する操作を露出する。Playwright の spec は
 * `page.evaluate` 経由でこれを呼び、戻り値をそのまま検証する。モックやスタブは使わず、
 * 実ブラウザの WebTransport と実リレーだけを使う。
 *
 * 接続先 (`moqt://...`) は spec が環境変数 `TEST_MOQT_URI` から読んでここへ渡す。
 * ブラウザには `process.env` が無いため、テストページ自身は環境変数を読まない。
 *
 * Publisher と Subscriber は開始と観測を分けている。開始した時点でハンドルの ID を返し、
 * spec は `expect.poll` で状態を待ってから次の段階へ進む。固定の sleep で待つと、
 * 遅い runner でだけ落ちる flaky なテストになる。
 */

import {
  connect,
  createMediaPublisher,
  createMediaSubscriber,
  type AudioDelivery,
  type Fetcher,
  type FetchOptions,
  type LocationFilter,
  type MediaPublisher,
  type MediaSubscriber,
  type Session,
} from "moqt-js";

/**
 * close の通知を待つ上限 (ミリ秒)
 *
 * 下位 WebTransport の closed はローカルでも次のタスクで解決するため、数十ミリ秒で
 * 通知される。届かない場合は接続そのものが異常であるため、待ち続けずに結果を返して
 * spec 側の assert に委ねる。
 */
const CLOSE_NOTIFICATION_TIMEOUT_MS = 10_000;

/**
 * FETCH の応答 (FETCH_OK) を待つ上限 (ミリ秒)
 *
 * relay が取得範囲の欠損 Object の fill を待つと、FETCH_OK がいつまでも返らない。
 * 待ち続けるとテストのタイムアウト (90 秒) まで原因が分からないため、上限で打ち切って
 * 何を待っていたかをメッセージに残す。
 */
const FETCH_RESPONSE_TIMEOUT_MS = 30_000;

/** 実リレーへ接続して切断する操作の入力 */
export interface ConnectRelayOptions {
  /** 接続先の MOQT URI (`moqt://...`) */
  url: string;
}

/** 実リレーへ接続して切断した結果 */
export interface ConnectRelayResult {
  /** SETUP の交換まで完了していれば "connected" */
  state: string;
  /** 閉じたことを通知されたか */
  closeNotified: boolean;
  /** 通知された close code (未通知は null) */
  closeCode: number | null;
  /** 通知された close reason (未通知は空文字列) */
  closeReason: string;
  /** セッションが通知したエラー (日本語のテストログに出るため、接続先は伏せる) */
  errors: string[];
}

/** Publisher を開始する操作の入力 */
export interface StartPublisherOptions {
  url: string;
  /** Track Namespace。spec がテストごとに一意な値を渡す */
  namespace: string[];
  /**
   * 音声も配信する。省略すると映像だけを配信する。
   *
   * 音声のソースは偽のマイク (Chromium の fake device) である。spec は
   * `--use-fake-device-for-media-stream` を付けて動かす (CI の runner は入力デバイスを
   * 持たないため。tests/e2e/relay/audio-timestamp.spec.ts と同じ条件)
   */
  audio?: {
    /**
     * 音声のコーデック。偽のマイクの音声をこのコーデックで符号化する。
     *
     * aac は「取り出した形式 (偽のマイクは 16 kHz モノラル) を AAC で符号化できるかを
     * 配信開始前に確かめる」経路のテストに使う。Chromium の AAC エンコーダーは
     * 44100 / 48000 Hz だけに対応するため、この条件では start() が明確なエラーで
     * 失敗することを確かめられる
     */
    codec: "opus" | "aac";
    bitrate: number;
    /** 音声 Object の送り方 (未指定ならライブラリの既定 "datagram")。draft-ietf-moq-transport-22 §11 */
    delivery?: AudioDelivery;
    /**
     * 取り出し経路へ要求するサンプルレート。省略時は既定の 48000 Hz
     *
     * 要求は Catalog と AudioEncoder の設定にはならず、経路が返した形式が使われる。
     * 指定値の扱いを検証する spec が、マイクと違う値を渡すために使う
     */
    sampleRate?: number;
    /** 取り出し経路へ要求するチャンネル数。省略時は既定の 2。使い道は `sampleRate` と同じ */
    channels?: number;
  };
}

/** Publisher の音声の観測結果 (音声を配信していなければ null) */
export interface PublisherAudioStatus {
  /** 送信した音声 Object の数 */
  framesSent: number;
  /** 停止時に encoder の flush で送れた末尾の Object の数 */
  tailFlushedFrames: number;
  /** 停止時に encoder の flush で送れた末尾の長さ (ミリ秒) */
  tailFlushedMs: number;
  /** 停止時に読んだが送れなかった末尾の Object の数 */
  tailDroppedFrames: number;
  /** 停止時に読んだが送れなかった末尾の長さ (ミリ秒) */
  tailDroppedMs: number;
  /** 停止時の flush か送信の待ちが上限で打ち切られた回数 */
  tailFlushTimeoutCount: number;
}

/**
 * 配信に使った音声トラックが報告した形式
 *
 * トラックの `getSettings()` の値である。`MediaStreamTrackProcessor` 経路はこの値を実際に
 * 流れる形式として読む (無い項目は要求値) ため、Catalog の宣言と突き合わせられる。Web Audio
 * 経路では符号化に使う形式 (AudioContext のサンプルレートと要求したチャンネル数) とは限らない
 */
export interface PublisherTrackAudioFormat {
  /** トラックが報告したサンプルレート (報告が無ければ null) */
  sampleRate: number | null;
  /** トラックが報告したチャンネル数 (報告が無ければ null) */
  channelCount: number | null;
}

/** Publisher の観測結果 */
export interface PublisherStatus {
  state: string;
  /** 送信した映像フレーム数 */
  framesSent: number;
  keyFramesSent: number;
  droppedFrames: number;
  /** 配信中の Group ID。FETCH の Location Filter の絶対指定に使う */
  currentGroupId: number;
  /** 音声の送信統計 (音声を配信していなければ null) */
  audio: PublisherAudioStatus | null;
  /** 配信に使った音声トラックが報告した形式 (音声を配信していなければ null) */
  trackAudioFormat: PublisherTrackAudioFormat | null;
  errors: string[];
}

/** Subscriber を開始する操作の入力 */
export interface StartSubscriberOptions {
  url: string;
  namespace: string[];
  /** 音声も購読する (省略すると映像だけを購読する) */
  audio?: boolean;
  /**
   * 購読する音声のコーデック (省略時は opus)
   *
   * 映像と同じく、テストページは catalog から自動取得せず明示する。AAC の配信を
   * 購読する経路を確かめるときに "aac" を渡す
   */
  audioCodec?: "opus" | "aac";
  /**
   * 映像も購読する (既定は true)。
   *
   * 配信側が映像トラックを catalog に載せていない場合 (音声だけの配信) は false にする。
   * catalog に無いトラックを購読すると "video track 'video' not found in catalog" で
   * 失敗し、音声だけを見たいテストがそのエラーに巻き込まれる
   */
  video?: boolean;
}

/**
 * Subscriber の音声の観測結果
 *
 * 「途切れの少なさ」を数値で見るための値である。分母は鳴らすと決めた音の長さ
 * (`playedMs`) であり、補間率は `concealedMs` / `playedMs`、捨て率は `droppedMs` /
 * `playedMs` になる。経路別の受信数は、Subgroup が再送されるのに対して Datagram は
 * 再送されない (draft-ietf-moq-transport-22 §11.2) ため、欠落率と合わせて経路ごとに比べる
 */
export interface SubscriberAudioStatus {
  /** 復号へ渡した音声 Object の数 (`subgroupFramesReceived` と `datagramFramesReceived` の和) */
  framesReceived: number;
  subgroupFramesReceived: number;
  datagramFramesReceived: number;
  /** 鳴らすと決めた音の長さ (ミリ秒)。補間率と捨て率の分母 */
  playedMs: number;
  /** 補間した合計 (ミリ秒) */
  concealedMs: number;
  /** 並べすぎとして捨てた長さ (ミリ秒) */
  droppedMs: number;
  /** 鳴らさなかった音の数 */
  missedFrames: number;
}

/**
 * Catalog が宣言した音声トラックの形式
 *
 * 配信側が取り出し経路から写した値である。宣言と実際に流れる形式が食い違うと復号が
 * 壊れるため、spec が宣言そのものを確かめられるようにする
 */
export interface CatalogAudioFormat {
  /** Catalog の samplerate (宣言が無ければ null) */
  samplerate: number | null;
  /** Catalog の channelConfig (宣言が無ければ null) */
  channelConfig: string | null;
}

/** Subscriber の観測結果 */
export interface SubscriberStatus {
  state: string;
  /** Catalog を受信して解決できたか */
  hasCatalog: boolean;
  /** 受信した MediaStream に映像トラックがあるか */
  hasVideoTrack: boolean;
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
  /** 音声の受信と再生の観測結果 (音声を購読していなければ null) */
  audio: SubscriberAudioStatus | null;
  /** Catalog が宣言した音声トラックの形式 (音声トラックが無ければ null) */
  catalogAudioFormat: CatalogAudioFormat | null;
  errors: string[];
}

/**
 * FETCH の取得範囲 (相対指定)
 *
 * draft-ietf-moq-transport-22 Section 9.20.9:
 * `{ startGroup }` の 1 フィールド (Location Filter Type 0x01) は相対指定であり、
 * Start Group = Largest Object の Group + 1 - startGroup になる。
 */
export interface FetchRelativeFilterOptions {
  startGroup: number;
}

/**
 * FETCH の取得範囲 (絶対開始)
 *
 * draft-ietf-moq-transport-22 Section 9.20.9:
 * `{ startGroup, startObject }` の 2 フィールド (Location Filter Type 0x02) は絶対開始として解釈される。
 */
export interface FetchAbsoluteFilterOptions {
  startGroup: number;
  startObject: number;
}

/**
 * FETCH の取得範囲
 *
 * bigint は page.evaluate の引数として運べないため number で受け取り、テストページ側で
 * bigint へ変換する。指定しない場合は {0, 0} から Largest Object までを要求する。
 */
export type FetchFilterOptions = FetchRelativeFilterOptions | FetchAbsoluteFilterOptions;

/** FETCH を開始する操作の入力 */
export interface StartFetchOptions {
  url: string;
  namespace: string[];
  /** 対象の Track Name */
  trackName: string;
  /**
   * 取得する範囲。省略すると全オブジェクト ({0, 0} から Largest Object まで) を要求する。
   * draft-ietf-moq-transport-22 Section 9.20.9 (LOCATION FILTER Parameter)
   */
  filter?: FetchFilterOptions;
  /**
   * FILL TIMEOUT (ミリ秒)
   * draft-ietf-moq-transport-22 §9.20.5 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 Object の fill を待つ最大時間。0 は即座に利用可能な Object だけを要求する。
   * 省略するとパラメータを送らず、fill を待つ時間は relay の既定に委ねられる。
   */
  fillTimeout?: number;
}

/** FETCH の観測結果 */
export interface FetchStatus {
  state: string;
  /** end が通知されたか (取得範囲の終端まで到達したか) */
  endNotified: boolean;
  /** FETCH_OK が End of Track を表明したか */
  endOfTrack: boolean;
  objectCount: number;
  bytesReceived: number;
  /** 取得した Group ID の一覧 (要求した範囲の検証に使う) */
  groupIds: string[];
  errors: string[];
}

/**
 * テストページが保持するハンドルの ID
 *
 * `page.evaluate` は戻り値を構造化複製で運ぶため、Publisher / Subscriber / Fetcher の
 * 実体を spec へ返せない。ページ側で ID と実体の対応を保持し、spec は ID だけを運ぶ。
 */
type HandleId = string;

interface PublisherHandle {
  publisher: MediaPublisher;
  /** Canvas の描画タイマーとトラックの解放 */
  dispose: () => void;
  errors: string[];
  /** 配信に使った音声トラックが報告した形式 (音声を配信していなければ null) */
  trackAudioFormat: PublisherTrackAudioFormat | null;
}

interface SubscriberHandle {
  subscriber: MediaSubscriber;
  errors: string[];
}

/**
 * FETCH の観測値
 *
 * コールバックが呼ばれる時点では Fetcher がまだ確定していないため、観測値はハンドルと
 * 独立した可変オブジェクトに集める。
 */
interface FetchObservation {
  errors: string[];
  objectCount: number;
  bytesReceived: number;
  groupIds: string[];
  endNotified: boolean;
}

interface FetchHandle {
  session: Session;
  fetcher: Fetcher;
  observation: FetchObservation;
}

const publishers = new Map<HandleId, PublisherHandle>();
const subscribers = new Map<HandleId, SubscriberHandle>();
const fetchers = new Map<HandleId, FetchHandle>();

let nextHandleId = 0;

function createHandleId(prefix: string): HandleId {
  nextHandleId += 1;
  return `${prefix}-${nextHandleId}`;
}

// テストページが接続した接続先。テストの失敗は CI の公開ログに出るため、
// エラーメッセージからは接続先を伏せてから返す
let relayUri = "";
let relayHost = "";

/**
 * 接続先を伏せ字の対象として登録する
 *
 * `connect()` を呼ぶ前に呼ぶ。fragment にトークンが載っている場合に備え、URI 全体と
 * ホストの両方を対象にする。URL として解釈できない場合は何もしない
 * (接続そのものは `connect()` がエラーにする)。
 */
function rememberRelayUri(url: string): void {
  relayUri = url;
  try {
    const host = new URL(url).host;
    if (host.length > 0) {
      relayHost = host;
    }
  } catch {
    relayHost = "";
  }
}

/**
 * 文字列中の接続先を伏せ字にする
 *
 * Playwright のレポートには評価結果とアサーションの差分がそのまま載るため、
 * 伏せ字にしないとリレーのホストやトークンが公開ログへ出る。
 */
function redactRelayUri(text: string): string {
  let redacted = text;
  if (relayUri.length > 0) {
    redacted = redacted.replaceAll(relayUri, "<redacted-relay-uri>");
  }
  if (relayHost.length > 0) {
    redacted = redacted.replaceAll(relayHost, "<redacted-relay-host>");
  }
  return redacted;
}

/** エラーをメッセージへ変換する (接続先は伏せる) */
function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactRelayUri(message);
}

/**
 * 320x240 の Canvas を時刻に応じた色で塗り続け、`captureStream(30)` で MediaStream を返す
 *
 * カメラを使わないため、CI のヘッドレス Chromium でも映像入力を用意できる。
 * 返り値の `dispose` で描画タイマーとトラックを解放する。
 */
function createCanvasStream(): { stream: MediaStream; dispose: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("failed to get 2d context");
  }

  const timer = window.setInterval(() => {
    const seconds = Date.now() / 1000;
    const red = Math.floor((Math.sin(seconds) + 1) * 127);
    const green = Math.floor((Math.sin(seconds + 2) + 1) * 127);
    const blue = Math.floor((Math.sin(seconds + 4) + 1) * 127);
    context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 1000 / 30);

  // captureStream は HTMLCanvasElement の標準 API (lib.dom のバージョン差を吸収する)
  const stream = (
    canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
  ).captureStream(30);

  const dispose = (): void => {
    window.clearInterval(timer);
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return { stream, dispose };
}

/**
 * 偽のマイクから音声トラックを取る
 *
 * CI の runner は音声の入力デバイスを持たないため、spec は
 * `--use-fake-device-for-media-stream` を付けて動かす
 * (tests/e2e/relay/audio-timestamp.spec.ts と同じ条件)。偽デバイスも 20 ms ごとに音を
 * 渡すため、配信と購読の経路はそのまま検証できる。偽デバイスはモノラル (channelCount が 1)
 * であり、既定の要求 (2 ch) とは違う形式が流れる。ライブラリは取り出した形式で符号化する
 */
async function createAudioTrack(): Promise<MediaStreamTrack> {
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = audioStream.getAudioTracks()[0];
  if (track === undefined) {
    throw new Error("failed to get a fake microphone track");
  }
  return track;
}

function readPublisherStatus(handle: PublisherHandle): PublisherStatus {
  const stats = handle.publisher.getStats();
  const video = stats.video;
  const audio = stats.audio;
  return {
    state: handle.publisher.state,
    framesSent: video?.framesSent ?? 0,
    keyFramesSent: video?.keyFramesSent ?? 0,
    droppedFrames: video?.droppedFrames ?? 0,
    currentGroupId: video?.currentGroupId ?? 0,
    audio:
      audio === null
        ? null
        : {
            framesSent: audio.framesSent,
            tailFlushedFrames: audio.tailFlushedFrames,
            tailFlushedMs: audio.tailFlushedMs,
            tailDroppedFrames: audio.tailDroppedFrames,
            tailDroppedMs: audio.tailDroppedMs,
            tailFlushTimeoutCount: audio.tailFlushTimeoutCount,
          },
    trackAudioFormat: handle.trackAudioFormat,
    errors: [...handle.errors],
  };
}

function readSubscriberStatus(handle: SubscriberHandle): SubscriberStatus {
  const stats = handle.subscriber.getStats();
  const video = stats.video;
  const audio = stats.audio;
  const catalogAudioTrack = handle.subscriber.catalog?.tracks.find(
    (track) => track.role === "audio",
  );
  return {
    state: handle.subscriber.state,
    hasCatalog: handle.subscriber.catalog !== null,
    hasVideoTrack: (handle.subscriber.mediaStream?.getVideoTracks().length ?? 0) > 0,
    framesReceived: video?.framesReceived ?? 0,
    keyFramesReceived: video?.keyFramesReceived ?? 0,
    bytesReceived: video?.bytesReceived ?? 0,
    catalogAudioFormat:
      catalogAudioTrack === undefined
        ? null
        : {
            samplerate: catalogAudioTrack.samplerate ?? null,
            channelConfig: catalogAudioTrack.channelConfig ?? null,
          },
    audio:
      audio === null
        ? null
        : {
            framesReceived: audio.framesReceived,
            subgroupFramesReceived: audio.subgroupFramesReceived,
            datagramFramesReceived: audio.datagramFramesReceived,
            playedMs: audio.playoutTiming.playedMs,
            concealedMs: audio.playoutConcealedMs,
            // 並べすぎとして捨てた長さ (捨て率の分子)
            droppedMs: audio.playoutTiming.missedByReason.backlog.ms,
            missedFrames: audio.playoutTiming.missedFrames,
          },
    errors: [...handle.errors],
  };
}

function readFetchStatus(handle: FetchHandle): FetchStatus {
  return {
    state: handle.fetcher.state,
    endNotified: handle.observation.endNotified,
    endOfTrack: handle.fetcher.endOfTrack,
    objectCount: handle.observation.objectCount,
    bytesReceived: handle.observation.bytesReceived,
    groupIds: [...handle.observation.groupIds],
    errors: [...handle.observation.errors],
  };
}

/**
 * 実リレーへ接続し、SETUP の交換が完了したことを確認してから閉じる
 *
 * draft-ietf-moq-transport-22 §6.2 (Session establishment)
 */
async function connectRelay(options: ConnectRelayOptions): Promise<ConnectRelayResult> {
  rememberRelayUri(options.url);
  const errors: string[] = [];
  let closeNotified = false;
  let closeCode: number | null = null;
  let closeReason = "";

  // close コールバックは下位 WebTransport の closed を監視する側から呼ばれるため、
  // close() の完了とは別タイミングになる。通知を待つための deferred を用意する
  let notifyClose: () => void = () => {};
  const closeObserved = new Promise<void>((resolve) => {
    notifyClose = resolve;
  });

  const session = await connect(
    options.url,
    {
      close: (info) => {
        closeNotified = true;
        closeCode = info.closeCode ?? null;
        closeReason = info.reason ?? "";
        notifyClose();
      },
      error: (error) => {
        errors.push(toErrorMessage(error));
      },
    },
    {},
  );

  const state = session.state;
  await session.close();

  // 通知が届くまで待つ。届かない場合は接続が異常であるため、上限で打ち切って結果を返し、
  // spec 側の assert に委ねる
  await Promise.race([
    closeObserved,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, CLOSE_NOTIFICATION_TIMEOUT_MS);
    }),
  ]);

  return { state, closeNotified, closeCode, closeReason, errors };
}

/**
 * Canvas の映像を publish する Publisher を開始する
 *
 * `start()` が解決した時点で namespace とカタログはリレーへ送信済みである。呼び出し側は
 * 返り値の ID で `getPublisher` を polling し、実際にフレームが送られてから次へ進む。
 */
async function startPublisher(options: StartPublisherOptions): Promise<HandleId> {
  rememberRelayUri(options.url);
  const errors: string[] = [];
  const { stream, dispose } = createCanvasStream();

  let publisher: MediaPublisher;
  let trackAudioFormat: PublisherTrackAudioFormat | null = null;
  try {
    // 音声の形式はライブラリが取り出し経路から決める (要求した値と違っても、実際に流れる
    // 形式で Catalog と AudioEncoder を構成する)。要求を渡さない場合は既定の 48000 Hz /
    // 2 ch が要求になり、偽のマイクの形式 (モノラル) と違う状態で配信が成立することを見る。
    // 渡した場合はその値が要求になる (指定値の扱いを見る spec が使う)
    const audioTrack = options.audio === undefined ? null : await createAudioTrack();
    if (audioTrack !== null) {
      stream.addTrack(audioTrack);
    }
    // 取り出し経路 (MediaStreamTrackProcessor) が実際の形式として読む値と同じものを、
    // spec が Catalog の宣言と突き合わせられるよう観測値に残す
    const audioSettings = audioTrack?.getSettings();
    trackAudioFormat =
      audioTrack === null
        ? null
        : {
            sampleRate: audioSettings?.sampleRate ?? null,
            channelCount: audioSettings?.channelCount ?? null,
          };
    publisher = await createMediaPublisher(
      options.url,
      {
        namespace: options.namespace,
        video: { codec: "vp8", bitrate: 500_000 },
        // exactOptionalPropertyTypes では optional な値に undefined を渡せないため、
        // 値がある場合だけ載せる
        ...(options.audio === undefined
          ? {}
          : {
              audio: {
                codec: options.audio.codec,
                bitrate: options.audio.bitrate,
                ...(options.audio.delivery === undefined
                  ? {}
                  : { delivery: options.audio.delivery }),
                // 要求は取り出し経路へ渡すだけで、Catalog と AudioEncoder には経路が
                // 返した形式が使われる (ライブラリ側で写す)
                ...(options.audio.sampleRate === undefined
                  ? {}
                  : { sampleRate: options.audio.sampleRate }),
                ...(options.audio.channels === undefined
                  ? {}
                  : { channels: options.audio.channels }),
              },
            }),
      },
      {
        onError: (error) => {
          errors.push(toErrorMessage(error));
        },
      },
    );
    await publisher.start(stream);
  } catch (error) {
    dispose();
    throw new Error(toErrorMessage(error), { cause: error });
  }

  const id = createHandleId("publisher");
  publishers.set(id, { publisher, dispose, errors, trackAudioFormat });
  return id;
}

function getPublisher(id: HandleId): PublisherStatus {
  const handle = publishers.get(id);
  if (!handle) {
    throw new Error(`unknown publisher handle: ${id}`);
  }
  return readPublisherStatus(handle);
}

/**
 * Publisher を停止する
 *
 * 解放の前に観測値を読み、`close()` が失敗した場合だけエラーを足して読み直す。
 * Canvas の資源は `dispose()` で必ず解放する。
 */
async function stopPublisher(id: HandleId): Promise<PublisherStatus> {
  const handle = publishers.get(id);
  if (!handle) {
    throw new Error(`unknown publisher handle: ${id}`);
  }
  publishers.delete(id);

  handle.dispose();

  try {
    await handle.publisher.close();
  } catch (error) {
    handle.errors.push(toErrorMessage(error));
  }
  // 末尾 flush の計器 (tailFlushed* / tailDropped*) は close の完了後に確定するため、
  // 停止の後に読む。state は "closed" になる
  return readPublisherStatus(handle);
}

/**
 * 同一 namespace を subscribe する Subscriber を開始する
 *
 * `start()` はカタログの受信まで待つ。Publisher が先に動いていないとカタログが
 * 見つからず失敗するため、spec は Publisher のフレーム送信を確認してから呼ぶ。
 */
async function startSubscriber(options: StartSubscriberOptions): Promise<HandleId> {
  rememberRelayUri(options.url);
  const errors: string[] = [];

  let subscriber: MediaSubscriber;
  try {
    subscriber = await createMediaSubscriber(
      options.url,
      {
        namespace: options.namespace,
        // exactOptionalPropertyTypes では optional な値に undefined を渡せないため、
        // 購読するトラックだけを載せる
        ...(options.video === false ? {} : { video: { codec: "vp8" } }),
        ...(options.audio === true
          ? { audio: { codec: options.audioCodec === "aac" ? "aac" : "opus" } }
          : {}),
      },
      {
        onError: (error) => {
          errors.push(toErrorMessage(error));
        },
      },
    );
    await subscriber.start();
  } catch (error) {
    throw new Error(toErrorMessage(error), { cause: error });
  }

  const id = createHandleId("subscriber");
  subscribers.set(id, { subscriber, errors });
  return id;
}

function getSubscriber(id: HandleId): SubscriberStatus {
  const handle = subscribers.get(id);
  if (!handle) {
    throw new Error(`unknown subscriber handle: ${id}`);
  }
  return readSubscriberStatus(handle);
}

/**
 * Subscriber を停止する
 *
 * `mediaStream` と `catalog` は close で解放されるため、観測値は close の前に読む。
 */
async function stopSubscriber(id: HandleId): Promise<SubscriberStatus> {
  const handle = subscribers.get(id);
  if (!handle) {
    throw new Error(`unknown subscriber handle: ${id}`);
  }
  subscribers.delete(id);

  const status = readSubscriberStatus(handle);
  try {
    await handle.subscriber.close();
  } catch (error) {
    handle.errors.push(toErrorMessage(error));
    return readSubscriberStatus(handle);
  }
  return status;
}

/**
 * テストページが受け取った範囲の指定を moqt-js の Location Filter へ変換する
 *
 * draft-ietf-moq-transport-22 Section 9.20.9: Location Filter Type で意味が変わるため、
 * `startObject` の有無で 0x01 (相対指定) と 0x02 (絶対開始) を切り替える。
 */
function toLocationFilter(options: FetchFilterOptions): LocationFilter {
  if ("startObject" in options) {
    return {
      startGroup: BigInt(options.startGroup),
      startObject: BigInt(options.startObject),
    };
  }
  return { startGroup: BigInt(options.startGroup) };
}

/**
 * 低レベル API の FETCH を開始する
 *
 * draft-ietf-moq-transport-22 §9.11 (FETCH) — §9.12 (FETCH_OK)
 */
async function startFetch(options: StartFetchOptions): Promise<HandleId> {
  rememberRelayUri(options.url);
  const session = await connect(options.url, {}, {});
  const observation: FetchObservation = {
    errors: [],
    objectCount: 0,
    bytesReceived: 0,
    groupIds: [],
    endNotified: false,
  };

  const filterOptions = options.filter;
  // フィルタ無しは「{0, 0} から Largest Object まで」を意味するため、filter は載せない
  const fetchOptions: FetchOptions = {
    ...(filterOptions === undefined ? {} : { filter: toLocationFilter(filterOptions) }),
    ...(options.fillTimeout === undefined ? {} : { fillTimeout: BigInt(options.fillTimeout) }),
  };

  let fetcher: Fetcher;
  try {
    const fetchPromise = session.fetch(options.namespace, options.trackName, fetchOptions, {
      object: (object) => {
        observation.objectCount += 1;
        observation.bytesReceived += object.payload.byteLength;
        const groupId = object.groupId.toString();
        if (!observation.groupIds.includes(groupId)) {
          observation.groupIds.push(groupId);
        }
      },
      end: () => {
        observation.endNotified = true;
      },
      error: (error) => {
        observation.errors.push(toErrorMessage(error));
      },
    });
    // 応答待ちで打ち切ったときに未処理の rejection を残さないための受け皿。
    // 元の Promise は reject したままなので Promise.race には影響しない
    fetchPromise.catch(() => {});
    fetcher = await Promise.race([
      fetchPromise,
      new Promise<never>((_resolve, reject) => {
        window.setTimeout(() => {
          reject(
            new Error(
              `FETCH did not respond within ${FETCH_RESPONSE_TIMEOUT_MS} ms (relay may be waiting for fill)`,
            ),
          );
        }, FETCH_RESPONSE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    await session.close();
    throw new Error(toErrorMessage(error), { cause: error });
  }

  const id = createHandleId("fetch");
  fetchers.set(id, { session, fetcher, observation });
  return id;
}

function getFetch(id: HandleId): FetchStatus {
  const handle = fetchers.get(id);
  if (!handle) {
    throw new Error(`unknown fetch handle: ${id}`);
  }
  return readFetchStatus(handle);
}

/** FETCH をキャンセルし、セッションも閉じる */
async function stopFetch(id: HandleId): Promise<FetchStatus> {
  const handle = fetchers.get(id);
  if (!handle) {
    throw new Error(`unknown fetch handle: ${id}`);
  }
  fetchers.delete(id);

  try {
    await handle.fetcher.cancel();
  } catch (error) {
    handle.observation.errors.push(toErrorMessage(error));
  }
  try {
    await handle.session.close();
  } catch (error) {
    handle.observation.errors.push(toErrorMessage(error));
  }
  return readFetchStatus(handle);
}

/** テストページが露出する API */
export interface MoqtE2EApi {
  connectRelay(options: ConnectRelayOptions): Promise<ConnectRelayResult>;
  startPublisher(options: StartPublisherOptions): Promise<HandleId>;
  getPublisher(id: HandleId): PublisherStatus;
  stopPublisher(id: HandleId): Promise<PublisherStatus>;
  startSubscriber(options: StartSubscriberOptions): Promise<HandleId>;
  getSubscriber(id: HandleId): SubscriberStatus;
  stopSubscriber(id: HandleId): Promise<SubscriberStatus>;
  startFetch(options: StartFetchOptions): Promise<HandleId>;
  getFetch(id: HandleId): FetchStatus;
  stopFetch(id: HandleId): Promise<FetchStatus>;
}

window.__moqtE2E = {
  connectRelay,
  startPublisher,
  getPublisher,
  stopPublisher,
  startSubscriber,
  getSubscriber,
  stopSubscriber,
  startFetch,
  getFetch,
  stopFetch,
};

declare global {
  interface Window {
    __moqtE2E: MoqtE2EApi;
  }
}

const statusElement = document.getElementById("status");
if (statusElement) {
  statusElement.textContent = "ready";
}
