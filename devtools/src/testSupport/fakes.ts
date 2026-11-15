/**
 * devtools のテストで共有する Fake
 *
 * devtools の後始末フロー (decoder.close → catalog 購読の unsubscribe → session.close)
 * と、その再入・失敗時の扱いを検証するには「呼び出しの順序」と「どこで失敗したか」を
 * 観測できる実体が必要になる。
 *
 * `Session` (WebTransport) と `DecoderWrapper` (WebCodecs) の実物は Node の vitest では
 * 生成できないため、公開インターフェースを実装した明示的な Fake を用意する。
 * モックライブラリや型アサーション (`as never` 等) によるすり替えは行わず、
 * 実装クラスで置き換えられない `DecoderWrapper` だけは実クラスを継承して
 * 観測 (close の記録) を追加する。
 *
 * テスト本文を持たないため、vitest の include (`devtools/src/**\/*.test.ts`) に
 * 一致しない名前にして、テストファイルとして収集されるのを避ける。
 */

import type {
  NamespacePublication,
  NamespacePublicationCallbacks,
  Publisher,
  Session,
  Subscriber,
  TracksSubscription,
  TracksSubscriptionCallbacks,
} from "moqt-js";
import { DecoderWrapper } from "../utils/DecoderWrapper";
import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder.ts";

/** Fake が観測した操作を共有するログ */
export type FakeCallLog = string[];

/**
 * Fake の対応範囲外の操作が呼ばれたことを明示する
 *
 * devtools の後始末フローが呼ぶのは close / unsubscribe だけであり、
 * それ以外は Fake の対応範囲外である。黙って成功させず、呼ばれた時点で
 * 失敗させることで「Fake が実装していない経路をテストが通ってしまった」
 * 状態に気付けるようにする。
 */
function unsupportedInFake(name: string): never {
  throw new Error(`${name} is not supported by the test fake`);
}

/** 呼び出しをラベル付きで記録するための共通オプション */
interface FakeCallOptions {
  /** ログへ記録するラベル。省略時はクラスごとの既定ラベルを使う */
  label?: string;
  /** 記録先の共有ログ。省略時は記録しない */
  calls?: FakeCallLog;
}

/**
 * テストから解決のタイミングを制御する Promise の deferred
 *
 * Fake のメソッドが返す Promise を、REQUEST_OK の受信などテストが決めた時点で
 * 解決するために使う。モックライブラリは使わない。
 */
export interface FakeDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** FakeDeferred を作る */
export function createFakeDeferred<T>(): FakeDeferred<T> {
  const callbacks: {
    resolve?: (value: T) => void;
    reject?: (error: Error) => void;
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    // Promise の executor は同期的に呼ばれるため、返す時点で両方とも設定済みである
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return {
    promise,
    resolve: (value: T): void => {
      callbacks.resolve?.(value);
    },
    reject: (error: Error): void => {
      callbacks.reject?.(error);
    },
  };
}

/** FakeSubscriber のオプション */
export interface FakeSubscriberOptions extends FakeCallOptions {
  /** unsubscribe を失敗させるエラー。省略時は成功する */
  unsubscribeError?: Error;
}

/**
 * `Subscriber` の Fake
 *
 * devtools が購読に対して行う操作は unsubscribe (後始末) と update
 * (REQUEST_UPDATE) だけであり、trackProperties / largestLocation / paused は
 * 判定に使うだけなので既定値で足りる。unsubscribe は呼ばれた回数だけログに残し、
 * 成功時は state を "closed" にする (実装と同じ状態遷移)。
 */
export class FakeSubscriber implements Subscriber {
  private subscriberState: Subscriber["state"] = "active";
  private readonly label: string;
  private readonly calls: FakeCallLog | null;
  private readonly unsubscribeError: Error | null;

  constructor(options: FakeSubscriberOptions = {}) {
    this.label = options.label ?? "subscriber.unsubscribe";
    this.calls = options.calls ?? null;
    this.unsubscribeError = options.unsubscribeError ?? null;
  }

  get state(): Subscriber["state"] {
    return this.subscriberState;
  }

  // devtools はこれらを要求フローの判定に使うだけであり、後始末フローの検証では
  // 既定値のままで足りる (mutable な state だけ getter にして状態遷移を持たせる)
  readonly largestLocation: Subscriber["largestLocation"] = null;

  // NEW_GROUP_REQUEST の値の解決にも使うが、後始末フローの検証では受信が無い
  // (null) 状態で足りる
  readonly largestReceivedLocation: Subscriber["largestReceivedLocation"] = null;

  readonly trackProperties: Subscriber["trackProperties"] = [];

  // draft-ietf-moq-transport-23 §9.19.18: 既定値は unpaused (false)
  readonly paused: boolean = false;

  // 引数は実装で使わないため受け取らない (関数の引数が少ない実装は代入可能)
  async update(): Promise<void> {
    this.record("subscriber.update");
  }

  async unsubscribe(): Promise<void> {
    this.record(this.label);
    if (this.unsubscribeError !== null) {
      throw this.unsubscribeError;
    }
    this.subscriberState = "closed";
  }

  private record(name: string): void {
    this.calls?.push(name);
  }
}

/**
 * `Publisher` の Fake
 *
 * PUBLISH の確立 (session.publish が返る) だけを検証するテスト向けに、Object の送信は
 * 何もせず成功させる。`done()` が呼ばれた回数を記録する。
 */
export class FakePublisher implements Publisher {
  private publisherState: Publisher["state"] = "active";
  private readonly label: string;
  private readonly calls: FakeCallLog | null;
  private doneCallCount = 0;

  // PUBLISH の PAUSED は既定の unpaused (実装の既定値と同じ)
  readonly paused = false;

  constructor(options: FakeCallOptions = {}) {
    this.label = options.label ?? "publisher.done";
    this.calls = options.calls ?? null;
  }

  get state(): Publisher["state"] {
    return this.publisherState;
  }

  /** done() が呼ばれた回数 (二重の PUBLISH_DONE の検出に使う) */
  get doneCalls(): number {
    return this.doneCallCount;
  }

  sendObject: Publisher["sendObject"] = async () => {
    // Object の送信は検証対象にしない (この Fake は PUBLISH の確立だけを扱う)
  };

  sendDatagram: Publisher["sendDatagram"] = async () => {
    // Datagram の送信は検証対象にしない
  };

  closeSubgroup: Publisher["closeSubgroup"] = async () => {
    // 開いている Subgroup は無い
  };

  notifyStateChange: Publisher["notifyStateChange"] = async () => {
    // 状態通知は検証対象にしない
  };

  async done(): Promise<void> {
    this.doneCallCount++;
    this.publisherState = "closed";
    this.calls?.push(this.label);
  }
}

/** FakeSession のオプション */
export interface FakeSessionOptions extends FakeCallOptions {
  /** close を失敗させるエラー。省略時は成功する */
  closeError?: Error;
  /** subscribeTracks を失敗させるエラー。省略時は成功する */
  subscribeTracksError?: Error;
  /** subscribeTracks の先頭で呼ぶフック (await 中の停止などを再現する) */
  onSubscribeTracks?: () => void;
  /** subscribeTracks に渡す SETUP のトークン。省略時は undefined */
  setupAuthorizationToken?: Session["setupAuthorizationToken"];
  /**
   * publishNamespace を失敗させるエラー
   *
   * 実装と同じく、error コールバックを呼んでから Promise を reject する
   * (REQUEST_ERROR の届き方を再現する)。
   */
  publishNamespaceError?: Error;
  /** publishNamespace の Promise をテストから解決する。省略時は即座に確立する */
  publishNamespaceDeferred?: FakeDeferred<NamespacePublication>;
  /** publishNamespace の先頭で呼ぶフック (await 中の停止などを再現する) */
  onPublishNamespace?: () => void;
}

/**
 * `TracksSubscription` の Fake
 *
 * SUBSCRIBE_TRACKS の解除が呼ばれたことを記録する。`onPublish` などは
 * `subscribeTracks` の引数で渡されるコールバックであり、この型のメンバーではない。
 */
export class FakeTracksSubscription implements TracksSubscription {
  private subscriptionState: TracksSubscription["state"] = "active";
  private readonly label: string;
  private readonly calls: FakeCallLog | null;

  constructor(options: FakeCallOptions = {}) {
    this.label = options.label ?? "tracksSubscription.unsubscribe";
    this.calls = options.calls ?? null;
  }

  get state(): TracksSubscription["state"] {
    return this.subscriptionState;
  }

  async update(): Promise<void> {
    this.record("tracksSubscription.update");
  }

  async unsubscribe(): Promise<void> {
    this.record(this.label);
    this.subscriptionState = "closed";
  }

  private record(name: string): void {
    this.calls?.push(name);
  }
}

/** FakeNamespacePublication のオプション */
export interface FakeNamespacePublicationOptions extends FakeCallOptions {
  /** 公開している namespace */
  namespace: readonly string[];
}

/**
 * `NamespacePublication` の Fake
 *
 * PUBLISH_NAMESPACE の撤回 (`done()`) が呼ばれた回数と、その後の state を記録する。
 * 実装と同じく、done() は state を同期的に "closed" にしてから完了する。
 */
export class FakeNamespacePublication implements NamespacePublication {
  private publicationState: NamespacePublication["state"] = "active";
  private readonly label: string;
  private readonly calls: FakeCallLog | null;
  private doneCallCount = 0;

  readonly namespace: string[];

  constructor(options: FakeNamespacePublicationOptions) {
    this.namespace = [...options.namespace];
    this.label = options.label ?? "namespacePublication.done";
    this.calls = options.calls ?? null;
  }

  get state(): NamespacePublication["state"] {
    return this.publicationState;
  }

  /** done() が呼ばれた回数 (二重撤回の検出に使う) */
  get doneCalls(): number {
    return this.doneCallCount;
  }

  async done(): Promise<void> {
    this.doneCallCount++;
    this.publicationState = "closed";
    this.calls?.push(this.label);
  }
}

/**
 * `Session` の Fake
 *
 * devtools が Session に要求するのは close / publish / subscribeTracks / publishNamespace
 * である。publish / subscribeTracks / publishNamespace は送信経路 (引数・認可トークン・
 * 失敗時の扱い・停止との競合) を検証できるよう実装し、呼び出しを記録する。それ以外の
 * 接続確立を伴う操作 (subscribe / fetch 等) は Fake の対応範囲外なので、呼ばれた場合は
 * 未対応として失敗させる。
 */
export class FakeSession implements Session {
  private sessionState: Session["state"] = "connected";
  private readonly label: string;
  private readonly calls: FakeCallLog | null;
  private readonly closeError: Error | null;

  constructor(options: FakeSessionOptions = {}) {
    this.label = options.label ?? "session.close";
    this.calls = options.calls ?? null;
    this.closeError = options.closeError ?? null;
    this.subscribeTracksError = options.subscribeTracksError ?? null;
    this.onSubscribeTracks = options.onSubscribeTracks;
    this.setupAuthorizationToken = options.setupAuthorizationToken;
    this.publishNamespaceError = options.publishNamespaceError ?? null;
    this.publishNamespaceDeferred = options.publishNamespaceDeferred ?? null;
    this.onPublishNamespace = options.onPublishNamespace;
  }

  get state(): Session["state"] {
    return this.sessionState;
  }

  // 後始末の検証では参照されないが、Session の契約として固定値を返す
  readonly reliability: string = "supports-unreliable";

  readonly goawayReceived: boolean = false;

  readonly fragment: Session["fragment"] = null;

  // 後始末の検証では参照されないが、Session の契約として SETUP にトークンを送っていない
  // 状態 (undefined) を返す。subscribeTracks のトークン検証用に差し替えられる
  readonly setupAuthorizationToken: Session["setupAuthorizationToken"];

  /** publish に渡された引数 (呼ばれた順) */
  readonly publishCalls: {
    namespace: string[];
    trackName: string;
    callbacks: Parameters<Session["publish"]>[2];
    options: Parameters<Session["publish"]>[3];
  }[] = [];

  publish: Session["publish"] = async (namespace, trackName, callbacks, options) => {
    this.publishCalls.push({ namespace: [...namespace], trackName, callbacks, options });
    this.record("session.publish");
    return this.calls === null ? new FakePublisher() : new FakePublisher({ calls: this.calls });
  };

  subscribe: Session["subscribe"] = async () => unsupportedInFake("FakeSession.subscribe");

  fetch: Session["fetch"] = async () => unsupportedInFake("FakeSession.fetch");

  trackStatus: Session["trackStatus"] = async () => unsupportedInFake("FakeSession.trackStatus");

  subscribeNamespace: Session["subscribeNamespace"] = async () =>
    unsupportedInFake("FakeSession.subscribeNamespace");

  /** subscribeTracks に渡された引数 (呼ばれた順) */
  readonly subscribeTracksCalls: {
    namespacePrefix: string[];
    callbacks: TracksSubscriptionCallbacks;
    options: Parameters<Session["subscribeTracks"]>[2];
  }[] = [];

  private readonly subscribeTracksError: Error | null;
  private readonly onSubscribeTracks: (() => void) | undefined;

  subscribeTracks: Session["subscribeTracks"] = async (namespacePrefix, callbacks, options) => {
    this.onSubscribeTracks?.();
    this.subscribeTracksCalls.push({ namespacePrefix, callbacks, options });
    if (this.subscribeTracksError !== null) {
      throw this.subscribeTracksError;
    }
    return this.calls === null
      ? new FakeTracksSubscription()
      : new FakeTracksSubscription({ calls: this.calls });
  };

  /** publishNamespace に渡された引数 (呼ばれた順) */
  readonly publishNamespaceCalls: {
    namespace: string[];
    callbacks: NamespacePublicationCallbacks | undefined;
    options: Parameters<Session["publishNamespace"]>[2];
  }[] = [];

  /** publishNamespace が返した FakeNamespacePublication (即座に確立したものだけ) */
  readonly namespacePublications: FakeNamespacePublication[] = [];

  private readonly publishNamespaceError: Error | null;
  private readonly publishNamespaceDeferred: FakeDeferred<NamespacePublication> | null;
  private readonly onPublishNamespace: (() => void) | undefined;

  publishNamespace: Session["publishNamespace"] = (namespace, callbacks, options) => {
    this.onPublishNamespace?.();
    this.publishNamespaceCalls.push({ namespace: [...namespace], callbacks, options });
    this.record("session.publishNamespace");
    if (this.publishNamespaceDeferred !== null) {
      return this.publishNamespaceDeferred.promise;
    }
    if (this.publishNamespaceError !== null) {
      // 実装と同じく、REQUEST_ERROR では error コールバックを呼んでから Promise を reject する
      callbacks?.error?.(this.publishNamespaceError);
      return Promise.reject(this.publishNamespaceError);
    }
    const publication = new FakeNamespacePublication({
      namespace: [...namespace],
      ...(this.calls !== null ? { calls: this.calls } : {}),
    });
    this.namespacePublications.push(publication);
    return Promise.resolve(publication);
  };

  goaway: Session["goaway"] = async () => unsupportedInFake("FakeSession.goaway");

  // 実装の Session.close は冪等だが、Fake は後始末フローの順序と回数を観測するため
  // 呼ばれた回数だけログに残す
  async close(): Promise<void> {
    this.record(this.label);
    if (this.closeError !== null) {
      throw this.closeError;
    }
    this.sessionState = "closed";
  }

  getStatistics(): ReturnType<Session["getStatistics"]> {
    return unsupportedInFake("FakeSession.getStatistics");
  }

  private record(name: string): void {
    this.calls?.push(name);
  }
}

/** RecordingDecoderWrapper のオプション */
export type RecordingDecoderWrapperOptions = FakeCallOptions;

/**
 * close() の呼び出しを記録する `DecoderWrapper`
 *
 * `DecoderWrapper` は private フィールドを持つクラスのため、インターフェース実装の
 * Fake では置き換えられない (TypeScript の構造的部分型にならない)。実クラスを継承し、
 * close() だけを記録して破棄処理は実装 (super.close()) をそのまま通す。
 * 後始末フローの順序検証で、実物と同じ破棄経路を通すためにこの形にしている。
 *
 * configure を呼ばない限り WebCodecs を生成しないため Node でも生成できる。
 */
export class RecordingDecoderWrapper extends DecoderWrapper {
  private readonly closeLabel: string;
  private readonly calls: FakeCallLog | null;

  constructor(options: RecordingDecoderWrapperOptions = {}) {
    // コールバックは close の観測では呼ばれない。ここで実データを扱わないことで
    // WebCodecs 非依存のまま生成できる。
    super(false, {
      output: () => {
        // close の観測だけを行うため出力は発生しない
      },
      error: () => {
        // close の観測だけを行うためエラーは発生しない
      },
    });
    this.closeLabel = options.label ?? "decoder.close";
    this.calls = options.calls ?? null;
  }

  override close(): void {
    this.calls?.push(this.closeLabel);
    super.close();
  }
}

/**
 * close() の呼び出しを記録する `AudioDecoderWrapper`
 *
 * 音声側の後始末フロー (映像 decoder → 音声 decoder → catalog 購読 → 音声トラックの
 * 購読 → session) の順序を検証するために使う。configure を呼ばない限り WebCodecs を
 * 生成しないため Node でも生成できる。
 */
export class RecordingAudioDecoderWrapper extends AudioDecoderWrapper {
  private readonly closeLabel: string;
  private readonly calls: FakeCallLog | null;

  constructor(options: RecordingDecoderWrapperOptions = {}) {
    // コールバックは close の観測では呼ばれない。ここで実データを扱わないことで
    // WebCodecs 非依存のまま生成できる。
    super(false, {
      output: () => {
        // close の観測だけを行うため出力は発生しない
      },
      error: () => {
        // close の観測だけを行うためエラーは発生しない
      },
    });
    this.closeLabel = options.label ?? "audioDecoder.close";
    this.calls = options.calls ?? null;
  }

  override close(): void {
    this.calls?.push(this.closeLabel);
    super.close();
  }
}
