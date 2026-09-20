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

import type { Session, Subscriber } from "moqt-js";
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

/** FakeSubscriber のオプション */
export interface FakeSubscriberOptions extends FakeCallOptions {
  /** unsubscribe を失敗させるエラー。省略時は成功する */
  unsubscribeError?: Error;
}

/**
 * `Subscriber` の Fake
 *
 * devtools が購読に対して行う操作は unsubscribe (後始末) と update
 * (REQUEST_UPDATE) だけであり、trackProperties / largestLocation / forwardState は
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

  readonly trackProperties: Subscriber["trackProperties"] = [];

  readonly forwardState: boolean = true;

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

/** FakeSession のオプション */
export interface FakeSessionOptions extends FakeCallOptions {
  /** close を失敗させるエラー。省略時は成功する */
  closeError?: Error;
}

/**
 * `Session` の Fake
 *
 * devtools の後始末フローが Session に要求するのは close だけである。
 * 接続確立を伴う操作 (publish / subscribe / fetch 等) は Fake の対応範囲外なので、
 * 呼ばれた場合は未対応として失敗させる。
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
  }

  get state(): Session["state"] {
    return this.sessionState;
  }

  // 後始末の検証では参照されないが、Session の契約として固定値を返す
  readonly reliability: string = "supports-unreliable";

  readonly goawayReceived: boolean = false;

  readonly fragment: Session["fragment"] = null;

  publish: Session["publish"] = async () => unsupportedInFake("FakeSession.publish");

  subscribe: Session["subscribe"] = async () => unsupportedInFake("FakeSession.subscribe");

  fetch: Session["fetch"] = async () => unsupportedInFake("FakeSession.fetch");

  trackStatus: Session["trackStatus"] = async () => unsupportedInFake("FakeSession.trackStatus");

  subscribeNamespace: Session["subscribeNamespace"] = async () =>
    unsupportedInFake("FakeSession.subscribeNamespace");

  subscribeTracks: Session["subscribeTracks"] = async () =>
    unsupportedInFake("FakeSession.subscribeTracks");

  publishNamespace: Session["publishNamespace"] = async () =>
    unsupportedInFake("FakeSession.publishNamespace");

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
