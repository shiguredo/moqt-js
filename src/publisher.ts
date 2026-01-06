/**
 * MOQT Publisher
 * draft-ietf-moq-transport-15 Section 5.2
 */

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
  extensions?: Uint8Array;
  priority?: number;
}

/**
 * Parameters for sending a datagram
 * draft-ietf-moq-transport-15 Section 10.3
 */
export interface SendDatagramParams {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
  extensions?: Uint8Array;
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
   * draft-ietf-moq-transport-15 Section 9.2.1.10
   *
   * PUBLISH_OK で受信した forwardState を返す。
   * - true (1): オブジェクトを転送する（Subscriber がいる）
   * - false (0): オブジェクトを転送しない（Subscriber がいない）
   *
   * SUBSCRIBE_UPDATE で状態が変更された場合、onForwardStateChange が呼ばれる。
   */
  readonly forwardState: boolean;
  sendObject(params: SendObjectParams): void;
  /**
   * Datagram でオブジェクトを送信する
   * draft-ietf-moq-transport-15 Section 10.3
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  sendDatagram(params: SendDatagramParams): void;
  done(): Promise<void>;
}

/**
 * Internal Publisher implementation
 */
export class PublisherImpl implements Publisher {
  private publisherState: PublisherState = "active";
  private publisherForwardState = true;
  private readonly publisherNamespace: string[];
  private readonly publisherTrackName: string;
  private readonly errorCallback?: (error: Error) => void;
  private readonly forwardStateChangeCallback?: (forward: boolean) => void;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // Internal callbacks for session to use
  onSendObject?: (params: SendObjectParams) => void;
  onSendDatagram?: (params: SendDatagramParams) => void;
  onDoneInternal?: () => Promise<void>;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onError?: (error: Error) => void,
    onForwardStateChange?: (forward: boolean) => void,
  ) {
    this.publisherNamespace = namespace;
    this.publisherTrackName = trackName;
    this.requestId = requestId;
    this.trackAlias = trackAlias;
    this.errorCallback = onError;
    this.forwardStateChangeCallback = onForwardStateChange;
  }

  get state(): PublisherState {
    return this.publisherState;
  }

  get forwardState(): boolean {
    return this.publisherForwardState;
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

  /**
   * Send an object on this track
   */
  sendObject(params: SendObjectParams): void {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }

    if (this.onSendObject) {
      this.onSendObject(params);
    }
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-15 Section 10.3
   */
  sendDatagram(params: SendDatagramParams): void {
    if (this.publisherState === "closed") {
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
   * draft-ietf-moq-transport-15 Section 9.2.1.10
   *
   * PUBLISH_OK または SUBSCRIBE_UPDATE で受信した FORWARD パラメータを反映する。
   * 状態が変化した場合、onForwardStateChange コールバックを呼ぶ。
   */
  setForwardState(forward: boolean): void {
    const previousState = this.publisherForwardState;
    this.publisherForwardState = forward;
    if (previousState !== forward) {
      this.forwardStateChangeCallback?.(forward);
    }
  }

  /**
   * Signal that publishing is done
   */
  async done(): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }

    if (this.onDoneInternal) {
      await this.onDoneInternal();
    }

    this.publisherState = "closed";
  }

  /**
   * Internal: mark as closed (called by session)
   */
  markClosed(): void {
    this.publisherState = "closed";
  }
}
