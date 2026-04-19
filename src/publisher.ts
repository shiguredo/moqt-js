/**
 * MOQT Publisher
 * draft-ietf-moq-transport-17 Section 5.2 (Fetch State Management)
 *
 * #0081 で Publisher は SessionMachine の publicationView を源泉とする facade に変更した。
 * state / forwardState は SessionMachine 側の SubscriptionEntry から都度 derive され、
 * Publisher 自身は change detection 用のキャッシュ以外の状態を持たない。
 */

import type { PublicationView } from "./session/types";

/**
 * Publisher state
 */
export type PublisherState = "active" | "closed";

/**
 * Parameters for sending an object
 */
export interface SendObjectParams {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  priority?: number;
}

/**
 * Parameters for sending a datagram
 * draft-ietf-moq-transport-17 Section 10.3 (Datagrams)
 */
export interface SendDatagramParams {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  priority?: number;
  /**
   * このオブジェクトがグループの最後かどうか
   */
  endOfGroup?: boolean;
}

/**
 * Publisher interface
 */
export interface Publisher {
  readonly state: PublisherState;
  /**
   * Forward State
   * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
   *
   * PUBLISH_OK で受信した forwardState を返す。
   * - true (1): オブジェクトを転送する（Subscriber がいる）
   * - false (0): オブジェクトを転送しない（Subscriber がいない）
   *
   * REQUEST_UPDATE で状態が変更された場合、onForwardStateChange が呼ばれる。
   */
  readonly forwardState: boolean;
  sendObject(params: SendObjectParams): void;
  /**
   * Datagram でオブジェクトを送信する
   * draft-ietf-moq-transport-17 Section 10.3 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   *
   * draft-ietf-moq-transport-17:
   * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
   * Publisher は sendObject() と sendDatagram() を同じトラックで併用できる。
   * https://github.com/moq-wg/moq-transport/pull/1350
   */
  sendDatagram(params: SendDatagramParams): void;
  done(): Promise<void>;
}

/**
 * SessionMachine から publisher role の view を取り出すアクセサ
 *
 * Publisher は自身の requestId に紐付く PublicationView を都度取り出して状態を確認する。
 * view が存在しない（forgetSubscription 済み、session closed 等）場合は undefined を返す。
 */
export type PublicationViewAccessor = () => PublicationView | undefined;

/**
 * Internal Publisher implementation
 */
export class PublisherImpl implements Publisher {
  private readonly viewAccessor: PublicationViewAccessor;
  private readonly publisherNamespace: string[];
  private readonly publisherTrackName: string;
  private readonly errorCallback?: (error: Error) => void;
  private readonly forwardStateChangeCallback?: (forward: boolean) => void;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // session close 時に外側から強制 close するためのオーバーライド。
  // #0081 Phase 3 で SessionMachine 側の entry terminate に寄せる予定。
  private closedOverride = false;

  // FORWARD 変化通知用キャッシュ。SessionMachine の SubscriptionEntry が
  // 単一の source of truth で、このフィールドは「前回 callback を起動した値」を覚える
  // ためだけに保持する。初期値は MOQT spec 上の FORWARD デフォルト (true) に合わせる。
  private lastNotifiedForwardState = true;

  // draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
  // PUBLISH_DONE の Stream Count 用カウンター
  private dataStreamCount = 0n;

  // Internal callbacks for session to use
  onSendObject?: (params: SendObjectParams) => void;
  onSendDatagram?: (params: SendDatagramParams) => void;
  onDoneInternal?: () => Promise<void>;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    viewAccessor: PublicationViewAccessor,
    onError?: (error: Error) => void,
    onForwardStateChange?: (forward: boolean) => void,
  ) {
    this.publisherNamespace = namespace;
    this.publisherTrackName = trackName;
    this.requestId = requestId;
    this.trackAlias = trackAlias;
    this.viewAccessor = viewAccessor;
    this.errorCallback = onError;
    this.forwardStateChangeCallback = onForwardStateChange;
    const initial = viewAccessor();
    if (initial !== undefined) {
      this.lastNotifiedForwardState = initial.forwardState;
    }
  }

  get state(): PublisherState {
    if (this.closedOverride) {
      return "closed";
    }
    const view = this.viewAccessor();
    return view === undefined ? "closed" : view.state;
  }

  get forwardState(): boolean {
    const view = this.viewAccessor();
    return view === undefined ? false : view.forwardState;
  }

  get namespace(): string[] {
    return this.publisherNamespace;
  }

  get trackName(): string {
    return this.publisherTrackName;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  incrementDataStreamCount(): void {
    this.dataStreamCount++;
  }

  getDataStreamCount(): bigint {
    return this.dataStreamCount;
  }

  /**
   * Send an object on this track
   */
  sendObject(params: SendObjectParams): void {
    if (this.state === "closed") {
      throw new Error("Publisher is closed");
    }

    if (this.onSendObject) {
      this.onSendObject(params);
    }
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-17 Section 10.3 (Datagrams)
   */
  sendDatagram(params: SendDatagramParams): void {
    if (this.state === "closed") {
      throw new Error("Publisher is closed");
    }

    if (this.onSendDatagram) {
      this.onSendDatagram(params);
    }
  }

  /**
   * Handle error
   */
  handleError(error: Error): void {
    this.errorCallback?.(error);
  }

  /**
   * Internal: Set forward state (called by session)
   * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
   *
   * #0081 以降は SessionMachine の SubscriptionEntry が authoritative な forwardState を持つ。
   * このメソッドは session が PUBLISH_OK / REQUEST_UPDATE を処理し SubscriptionEntry を
   * 更新した後に呼び出され、callback の change detection を実施する役割のみを担う。
   * 引数 forward は現在の SubscriptionEntry の forwardState と一致する前提。
   */
  setForwardState(forward: boolean): void {
    if (this.lastNotifiedForwardState !== forward) {
      this.lastNotifiedForwardState = forward;
      this.forwardStateChangeCallback?.(forward);
    }
  }

  /**
   * Signal that publishing is done
   */
  async done(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    if (this.onDoneInternal) {
      await this.onDoneInternal();
    }

    // onDoneInternal 内で sendPublishDone が呼ばれ SubscriptionEntry が terminated
    // になるため、view 経由で state が "closed" に遷移する想定。
    // 念のためオーバーライドも立てる (既存コード互換、#0081 Phase 3 で整理予定)。
    this.closedOverride = true;
  }

  /**
   * Internal: mark as closed (called by session)
   *
   * session 全体の close / GOAWAY タイムアウト時に外側から呼ばれる。
   * SessionMachine の entry は terminate しないケースでも Publisher を closed として扱う。
   */
  markClosed(): void {
    this.closedOverride = true;
  }
}
